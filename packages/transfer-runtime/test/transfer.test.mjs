import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_HOST_RESOURCE_LIMITS } from "../../contracts/src/limits.ts";
import { RealClock } from "../../core/src/clock.ts";
import {
  executeDeviceToHostTransfer,
  executeHostToDeviceTransferOutcome,
  TransferRuntimeError,
} from "../src/transfer.ts";

const FIXTURE_DIRECTORY = new URL(
  "./fixtures/non-hardware-conformance-bulk-read/",
  import.meta.url,
);
const TARGET_BYTES = 2_097_152;
const CAPTURED_CHUNK_BYTES = 1_024;
const REPORTED_TARGET_DIGEST =
  "85ac0b86cdb4134b3787f7bc86272034a19a6fe7f5e7b97518890b59fa758a51";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)) >>> 0;
}

function parseHexOctets(text) {
  return Uint8Array.from(text.trim().split(/ +/u), (value) => Number.parseInt(value, 16));
}

async function loadNonHardwareConformanceBulkReadFixture() {
  const envelope = JSON.parse(await readFile(new URL("fixture.json", FIXTURE_DIRECTORY), "utf8"));
  assert.equal(envelope.formatVersion, 1, "fixture envelope format version");
  const source = await readFile(new URL(envelope.excerpt.file, FIXTURE_DIRECTORY));
  assert.equal(source.byteLength, envelope.excerpt.lengthBytes, "fixture excerpt byte length");
  assert.equal(sha256(source), envelope.excerpt.sha256, "fixture excerpt SHA-256");

  const lines = source.toString("utf8").split("\n");
  assert.ok(lines[0].startsWith(envelope.source.range.firstRecord));
  assert.ok(lines.at(-2).startsWith(envelope.source.range.lastRecord));

  const finalize = lines.find((line) => line.includes(" FINALIZE_DIGESTS_CONFIRMED "));
  const readback = lines.find((line) => line.includes(" BULK_READ_TARGET_CONFIRMED "));
  assert.notEqual(finalize, undefined, "source excerpt carries the device-reported target digest");
  assert.notEqual(readback, undefined, "source excerpt carries the independently checked read-back digest");
  const finalizeDigest = /target_sha256=([0-9a-f]{64})/u.exec(finalize)?.[1];
  const readbackDigest = /sha256=([0-9a-f]{64})/u.exec(readback)?.[1];
  assert.equal(finalizeDigest, REPORTED_TARGET_DIGEST);
  assert.equal(readbackDigest, REPORTED_TARGET_DIGEST);

  const responses = new Map();
  let pending = null;
  for (const line of lines) {
    const request = / BULK_READ offset=(\d+) length=(\d+)$/u.exec(line);
    if (request !== null) {
      assert.equal(pending, null, "one captured read request settles before the next");
      pending = {
        offset: Number(request[1]),
        length: Number(request[2]),
        frameOctets: [],
      };
      continue;
    }
    if (pending === null) continue;
    const receive = / RX81 ([0-9a-f ]+)$/u.exec(line);
    if (receive !== null) {
      pending.frameOctets.push(...parseHexOctets(receive[1]));
      continue;
    }
    if (!line.includes(" DECODE opcode=0x35 ")) continue;

    const frame = Uint8Array.from(pending.frameOctets);
    assert.deepEqual([...frame.subarray(0, 4)], [0xa5, 0x5a, 0xd3, 0x01]);
    assert.equal(frame.byteLength, 10 + readU16(frame, 4));
    assert.equal(frame[6], 0x02, "captured unit is a response");
    assert.equal(frame[7], 0x35, "captured unit is a bulk read");
    assert.equal(frame[10], 0x00, "captured bulk read succeeded");
    assert.equal(readU32(frame, 11), pending.offset);
    assert.equal(readU16(frame, 15), pending.length);
    const data = frame.slice(17, frame.byteLength - 4);
    assert.equal(data.byteLength, pending.length);
    assert.equal(responses.has(pending.offset), false, "captured offset is unique");
    responses.set(pending.offset, Object.freeze({ frame, data }));
    pending = null;
  }
  assert.equal(pending, null, "the source excerpt ends on a complete response");
  assert.equal(responses.size, TARGET_BYTES / CAPTURED_CHUNK_BYTES);

  return Object.freeze({
    envelope,
    responses,
    reportedTargetDigest: finalizeDigest,
    independentlyCheckedTargetDigest: readbackDigest,
  });
}

function direction(settlementKind = "per-action-response") {
  return Object.freeze({
    preparation: Object.freeze([
      Object.freeze({ action: "query-target", maximumWaitMs: 5_000, destructive: false }),
    ]),
    data: Object.freeze({
      action: "read-target-range",
      maximumWaitMs: 5_000,
      sourceOffset: 0,
      targetOffset: 0,
      length: TARGET_BYTES,
      maximumChunkBytes: CAPTURED_CHUNK_BYTES,
      alignmentBytes: 1,
      maximumInFlight: 1,
    }),
    settlement: Object.freeze({
      kind: settlementKind,
      selection: settlementKind === "per-action-response"
        ? "read-target-response"
        : "write-window-report",
      maximumWaitMs: 5_000,
      maximumObservations: TARGET_BYTES / CAPTURED_CHUNK_BYTES,
    }),
    completion: Object.freeze([]),
    verification: Object.freeze([
      Object.freeze({
        authority: "host-computed-device-confirmed",
        id: "reported-target-sha256",
        algorithm: "sha256",
        domain: "target",
        coverage: { kind: "complete-effective-range" },
        maximumWaitMs: 5_000,
        reportedBinding: "reported-target-sha256",
      }),
    ]),
    retry: Object.freeze({ kind: "none" }),
    resume: null,
  });
}

function declaration() {
  return Object.freeze({
    id: "non-hardware-conformance-bulk-read",
    directions: Object.freeze({
      hostToDevice: null,
      deviceToHost: direction(),
    }),
  });
}

class NonHardwareConformanceBulkReadAdapter {
  constructor(fixture, options = {}) {
    this.fixture = fixture;
    this.mutateTargetOffset = options.mutateTargetOffset;
    this.useRequestedPrefix = options.useRequestedPrefix ?? false;
    this.pending = [];
    this.preparation = [];
  }

  async executeRecipeAction(action, phase) {
    assert.equal(phase, "preparation");
    assert.equal(action.action, "query-target");
    this.preparation.push(action.action);
  }

  async admit(action, _signal, observeTransmitted) {
    assert.equal(action.action, "read-target-range");
    const captured = this.fixture.responses.get(action.range.sourceOffset);
    assert.notEqual(captured, undefined, `captured range starts at ${action.range.sourceOffset}`);
    if (!this.useRequestedPrefix) assert.equal(captured.data.byteLength, action.range.length);
    else assert.ok(captured.data.byteLength >= action.range.length);
    const data = captured.data.slice(0, action.range.length);
    if (action.range.targetOffset === this.mutateTargetOffset) data[0] ^= 0x01;
    observeTransmitted(captured.frame);
    this.pending.push(Object.freeze({
      kind: "per-action-response",
      selection: "read-target-response",
      ranges: Object.freeze([Object.freeze({
        actionId: action.id,
        range: action.range,
        sourceBytes: data,
        status: "confirmed",
      })]),
    }));
  }

  async nextSettlement(settlement) {
    assert.equal(settlement.kind, "per-action-response");
    assert.equal(settlement.selection, "read-target-response");
    const observation = this.pending.shift();
    assert.notEqual(observation, undefined, "settlement follows an admitted action");
    return observation;
  }

  binding(name) {
    assert.equal(name, "reported-target-sha256");
    return Uint8Array.from(Buffer.from(this.fixture.reportedTargetDigest, "hex"));
  }
}

class NodeSha256DigestProvider {
  create(algorithm) {
    assert.equal(algorithm, "sha256");
    const hash = createHash("sha256");
    return {
      update(bytes) { hash.update(bytes); },
      async digestHex() { return hash.digest("hex"); },
    };
  }
}

class CapturingSink {
  chunks = [];
  async write(bytes) { this.chunks.push(Buffer.from(bytes)); }
  bytes() { return Buffer.concat(this.chunks); }
}

class ImmediateReadAdapter {
  admitted = [];
  pending = [];
  async executeRecipeAction() {}
  async admit(action, _signal, observeTransmitted) {
    this.admitted.push(action);
    observeTransmitted(Uint8Array.of(action.id));
    this.pending.push({
      kind: "per-action-response",
      selection: "read",
      ranges: [{
        actionId: action.id,
        range: action.range,
        sourceBytes: Uint8Array.of(action.range.sourceOffset),
        status: "confirmed",
      }],
    });
  }
  async nextSettlement() {
    const settlement = this.pending.shift();
    assert.notEqual(settlement, undefined);
    return settlement;
  }
}

class FirstWriteGateSink extends CapturingSink {
  constructor() {
    super();
    this.firstWriteStarted = new Promise((resolve) => { this.resolveFirstWriteStarted = resolve; });
    this.firstWriteRelease = new Promise((resolve) => { this.resolveFirstWriteRelease = resolve; });
  }
  async write(bytes) {
    if (this.chunks.length === 0) {
      this.resolveFirstWriteStarted();
      await this.firstWriteRelease;
    }
    await super.write(bytes);
  }
  releaseFirstWrite() { this.resolveFirstWriteRelease(); }
}

function refillBeforeSinkDefinition() {
  return {
    id: "refill-before-sink-control",
    directions: {
      hostToDevice: null,
      deviceToHost: {
        preparation: [],
        data: {
          action: "read", maximumWaitMs: 1_000,
          sourceOffset: 0, targetOffset: 0, length: 3,
          maximumChunkBytes: 1, alignmentBytes: 1, maximumInFlight: 2,
        },
        settlement: {
          kind: "per-action-response", selection: "read",
          maximumWaitMs: 1_000, maximumObservations: 3,
        },
        completion: [], verification: [], retry: { kind: "none" }, resume: null,
      },
    },
  };
}

function executionOptions(definition, adapter, sink) {
  return {
    definition,
    adapter,
    sink,
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  };
}

test("device-to-host transfer refuses host chunk-count and window envelopes before device I/O", async () => {
  const definition = refillBeforeSinkDefinition();
  const adapter = { initializeBindings() { assert.fail("device I/O began before envelope admission"); } };
  const sink = new CapturingSink();
  for (const [field, maximum, code] of [
    ["maximumChunksInFlight", 1, "transfer.limit.chunks-in-flight"],
    ["maximumTransferWindowBytes", 1, "transfer.limit.window-bytes"],
  ]) {
    await assert.rejects(
      executeDeviceToHostTransfer({
        ...executionOptions(definition, adapter, sink),
        limits: { ...DEFAULT_HOST_RESOURCE_LIMITS, [field]: maximum },
      }),
      (error) => error instanceof TransferRuntimeError && error.diagnostic.code === code,
    );
  }
});

test("the non-hardware conformance declaration downloads the captured target and verifies its reported digest", async () => {
  const fixture = await loadNonHardwareConformanceBulkReadFixture();
  const adapter = new NonHardwareConformanceBulkReadAdapter(fixture);
  const sink = new CapturingSink();
  const result = await executeDeviceToHostTransfer(
    executionOptions(declaration(), adapter, sink),
  );

  const downloaded = sink.bytes();
  assert.equal(downloaded.byteLength, TARGET_BYTES);
  assert.equal(sha256(downloaded), fixture.independentlyCheckedTargetDigest);
  assert.deepEqual(adapter.preparation, ["query-target"]);
  assert.deepEqual(result.counts, {
    source: TARGET_BYTES,
    transmitted: [...fixture.responses.values()]
      .reduce((total, response) => total + response.frame.byteLength, 0),
    target: TARGET_BYTES,
  });
  assert.deepEqual(result.verification, [{
    id: "reported-target-sha256",
    authority: "host-computed-device-confirmed",
    algorithm: "sha256",
    domain: "target",
    coverage: { kind: "complete-effective-range" },
    value: REPORTED_TARGET_DIGEST,
  }]);
});

test("device-to-host settlement refills the declared window before downstream sink work", async () => {
  const adapter = new ImmediateReadAdapter();
  const sink = new FirstWriteGateSink();
  const execution = executeDeviceToHostTransfer(
    executionOptions(refillBeforeSinkDefinition(), adapter, sink),
  );

  await sink.firstWriteStarted;
  try {
    assert.deepEqual(
      adapter.admitted.map(({ range }) => range.sourceOffset),
      [0, 1, 2],
      "the replacement action is admitted while the first sink write remains blocked",
    );
  } finally {
    sink.releaseFirstWrite();
    await execution;
  }
  assert.deepEqual([...sink.bytes()], [0, 1, 2]);
});

test("the device-to-host primitive reads settlement from its direction when the sibling direction differs", async () => {
  const fixture = await loadNonHardwareConformanceBulkReadFixture();
  const adapter = new NonHardwareConformanceBulkReadAdapter(fixture);
  const sink = new CapturingSink();
  const definition = {
    ...declaration(),
    directions: {
      hostToDevice: direction("range-window-report"),
      deviceToHost: direction("per-action-response"),
    },
  };
  await executeDeviceToHostTransfer(executionOptions(definition, adapter, sink));
  assert.equal(sha256(sink.bytes()), REPORTED_TARGET_DIGEST);
});

test("a synthetic mutation of the captured target fails device-confirmed verification by name", async () => {
  const fixture = await loadNonHardwareConformanceBulkReadFixture();
  const adapter = new NonHardwareConformanceBulkReadAdapter(fixture, {
    mutateTargetOffset: CAPTURED_CHUNK_BYTES,
  });
  const sink = new CapturingSink();
  await assert.rejects(
    executeDeviceToHostTransfer(executionOptions(declaration(), adapter, sink)),
    (error) => {
      assert.ok(error instanceof TransferRuntimeError);
      assert.equal(error.diagnostic.code, "transfer.verification.digest-mismatch");
      assert.equal(
        error.diagnostic.declarationPath,
        "transfers.non-hardware-conformance-bulk-read.directions.deviceToHost.verification.0",
      );
      return true;
    },
  );
});

test("a captured-prefix truncation leaves a short final read range instead of assuming even division", async () => {
  const fixture = await loadNonHardwareConformanceBulkReadFixture();
  const adapter = new NonHardwareConformanceBulkReadAdapter(fixture, {
    useRequestedPrefix: true,
  });
  const sink = new CapturingSink();
  const shortened = {
    ...declaration(),
    directions: {
      hostToDevice: null,
      deviceToHost: {
        ...direction(),
        data: {
          ...direction().data,
          length: TARGET_BYTES - 1,
        },
        verification: [],
      },
    },
  };
  const result = await executeDeviceToHostTransfer(
    executionOptions(shortened, adapter, sink),
  );
  assert.equal(sink.bytes().byteLength, TARGET_BYTES - 1);
  assert.equal(result.counts.source, TARGET_BYTES - 1);
  assert.equal(result.counts.target, TARGET_BYTES - 1);
  assert.ok(result.counts.transmitted > result.counts.target);
});

class MemorySource {
  #offset = 0;
  constructor(bytes) { this.bytes = Uint8Array.from(bytes); this.byteLength = this.bytes.byteLength; this.readSizes = []; }
  async read(into) {
    this.readSizes.push(into.byteLength);
    const bytesRead = Math.min(into.byteLength, this.bytes.byteLength - this.#offset);
    into.set(this.bytes.subarray(this.#offset, this.#offset + bytesRead));
    this.#offset += bytesRead;
    return { bytesRead, eof: this.#offset === this.bytes.byteLength };
  }
  async seek(offset) { this.#offset = offset; }
  async close() {}
}

class GuardedWriteAdapter {
  admitted = [];
  pending = [];
  constructor(current, failAdmission = 0) { this.current = Uint8Array.from(current); this.failAdmission = failAdmission; }
  async executeRecipeAction() {}
  async readTarget() { return Uint8Array.from(this.current); }
  async admit(action, sourceBytes, _signal, observeTransmitted) {
    observeTransmitted(sourceBytes);
    this.admitted.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
    if (this.admitted.length === this.failAdmission) throw new Error("synthetic admitted write failure");
    this.pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
  }
  async nextSettlement(settlement) {
    const pending = this.pending.shift();
    assert.ok(pending);
    return {
      kind: settlement.kind,
      selection: settlement.selection,
      ranges: [{
        actionId: pending.action.id,
        range: pending.action.range,
        sourceBytes: pending.sourceBytes,
        status: "confirmed",
      }],
    };
  }
}

function guardedWriteDefinition() {
  return {
    id: "guarded-write-control",
    directions: {
      deviceToHost: null,
      hostToDevice: {
        preparation: [],
        data: {
          action: "write", maximumWaitMs: 1_000,
          sourceOffset: 0, targetOffset: 20, length: 5,
          maximumChunkBytes: 3, alignmentBytes: 1, maximumInFlight: 1,
        },
        settlement: { kind: "per-action-response", selection: "write", maximumWaitMs: 1_000, maximumObservations: 2 },
        completion: [], verification: [], retry: { kind: "none" }, resume: null,
      },
    },
  };
}

function guardedWriteOptions(adapter, source, expectedCurrent) {
  return {
    definition: guardedWriteDefinition(), adapter,
    source: new MemorySource(source), expectedCurrent: new MemorySource(expectedCurrent),
    digestProvider: new NodeSha256DigestProvider(), clock: new RealClock(), limits: DEFAULT_HOST_RESOURCE_LIMITS,
  };
}

test("guarded write compares the complete fresh target before admitting an uneven final chunk", async () => {
  const before = Uint8Array.of(1, 2, 3, 4, 5);
  const after = Uint8Array.of(6, 7, 8, 9, 10);
  const adapter = new GuardedWriteAdapter(before);
  const options = guardedWriteOptions(adapter, after, before);
  const outcome = await executeHostToDeviceTransferOutcome(options);
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(adapter.admitted.map(({ sourceBytes }) => [...sourceBytes]), [[6, 7, 8], [9, 10]]);
  assert.deepEqual(options.source.readSizes, [3, 2], "replacement source streams at the declared chunk bound");
});

test("guarded write reports stale input before admission and admitted failure as indeterminate", async () => {
  const before = Uint8Array.of(1, 2, 3, 4, 5);
  const after = Uint8Array.of(6, 7, 8, 9, 10);
  const stale = new GuardedWriteAdapter(Uint8Array.of(1, 2, 0, 4, 5));
  const rejected = await executeHostToDeviceTransferOutcome(guardedWriteOptions(stale, after, before));
  assert.equal(rejected.outcome, "failed-before-destructive-work");
  assert.equal(rejected.cause.code, "transfer.write.expected-current-mismatch");
  assert.equal(stale.admitted.length, 0);

  const failing = new GuardedWriteAdapter(before, 1);
  const indeterminate = await executeHostToDeviceTransferOutcome(guardedWriteOptions(failing, after, before));
  assert.equal(indeterminate.outcome, "indeterminate-after-destructive-work");
  assert.equal(indeterminate.destructiveActions, 1);
});

test("an expected-current mismatch runs no destructive preparation", async () => {
  const before = Uint8Array.of(1, 2, 3, 4, 5);
  const adapter = new GuardedWriteAdapter(Uint8Array.of(1, 2, 0, 4, 5));
  let preparationCalls = 0;
  adapter.executeRecipeAction = async () => { preparationCalls += 1; };
  const options = guardedWriteOptions(adapter, before, before);
  options.definition = {
    ...options.definition,
    directions: {
      ...options.definition.directions,
      hostToDevice: {
        ...options.definition.directions.hostToDevice,
        preparation: [{ action: "erase-target", maximumWaitMs: 1_000, destructive: true }],
      },
    },
  };
  const outcome = await executeHostToDeviceTransferOutcome(options);
  assert.equal(outcome.outcome, "failed-before-destructive-work");
  assert.equal(outcome.cause.code, "transfer.write.expected-current-mismatch");
  assert.equal(preparationCalls, 0);
  assert.equal(adapter.admitted.length, 0);
});

test("a destructive preparation action makes a failure indeterminate before data admission", async () => {
  const bytes = Uint8Array.of(1, 2, 3, 4, 5);
  const adapter = new GuardedWriteAdapter(bytes);
  adapter.executeRecipeAction = async (action) => {
    assert.equal(action.action, "erase-target");
    throw new Error("synthetic erase settlement failure");
  };
  const options = guardedWriteOptions(adapter, bytes, bytes);
  options.definition = {
    ...options.definition,
    directions: {
      ...options.definition.directions,
      hostToDevice: {
        ...options.definition.directions.hostToDevice,
        preparation: [{ action: "erase-target", maximumWaitMs: 1_000, destructive: true }],
      },
    },
  };
  const outcome = await executeHostToDeviceTransferOutcome(options);
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.destructiveActions, 1);
  assert.equal(adapter.admitted.length, 0);
});
