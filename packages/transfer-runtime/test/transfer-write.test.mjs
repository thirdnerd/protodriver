import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DEFAULT_HOST_RESOURCE_LIMITS } from "../../contracts/src/limits.ts";
import { RealClock } from "../../core/src/clock.ts";
import {
  DirectResourceRpcAdapter,
  PostMessageResourceRpcAdapter,
  ResourceBrokerHost,
  ResourceBrokerRpcClient,
  serveResourceRpc,
} from "../../core/src/resources.ts";
import { executeHostToDeviceTransferOutcome } from "../src/transfer.ts";

const CHUNK_BYTES = 64 * 1024;
const WINDOW_CHUNKS = 4;

function patternByte(offset) {
  return (offset * 29 + 17) & 0xff;
}

class PatternSource {
  #offset = 0;
  constructor(byteLength, options = {}) {
    this.byteLength = byteLength;
    this.mutateAfterSeek = options.mutateAfterSeek ?? Number.POSITIVE_INFINITY;
    this.mutateOffset = options.mutateOffset ?? CHUNK_BYTES;
    this.seeks = 0;
    this.maximumRead = 0;
  }
  async read(into) {
    const bytesRead = Math.min(into.byteLength, this.byteLength - this.#offset);
    this.maximumRead = Math.max(this.maximumRead, into.byteLength);
    for (let index = 0; index < bytesRead; index += 1) {
      const absolute = this.#offset + index;
      into[index] = patternByte(absolute) ^ (this.seeks >= this.mutateAfterSeek && absolute === this.mutateOffset ? 1 : 0);
    }
    this.#offset += bytesRead;
    return { bytesRead, eof: this.#offset === this.byteLength };
  }
  async seek(offset) {
    this.seeks += 1;
    this.#offset = offset;
  }
  async close() {}
}

class BrokerByteSource {
  #nextCall = 1;
  constructor(client, id, byteLength) { this.client = client; this.id = id; this.byteLength = byteLength; }
  async read(into) {
    const result = await this.client.read(this.id, into.byteLength, { callId: `transfer-source-${this.#nextCall++}` });
    const bytes = new Uint8Array(result.data);
    into.set(bytes);
    return { bytesRead: bytes.byteLength, eof: result.eof };
  }
  async seek(offset) {
    await this.client.seek(this.id, offset, { callId: `transfer-source-${this.#nextCall++}` });
  }
  async close() { await this.client.close(this.id); }
}

async function brokeredPatternSource(kind, byteLength) {
  const physical = new PatternSource(byteLength);
  const host = new ResourceBrokerHost();
  const id = await host.registerSource(physical, { kind: "host" });
  if (kind === "direct") {
    const adapter = new DirectResourceRpcAdapter(host);
    return {
      source: new BrokerByteSource(new ResourceBrokerRpcClient(adapter), id, byteLength),
      physical,
      close: () => adapter.close(),
    };
  }
  const { port1, port2 } = new MessageChannel();
  const service = serveResourceRpc(port2, host);
  const adapter = new PostMessageResourceRpcAdapter(port1);
  return {
    source: new BrokerByteSource(new ResourceBrokerRpcClient(adapter), id, byteLength),
    physical,
    close: async () => { await adapter.close(); service.dispose(); },
  };
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

function patternDigest(byteLength) {
  const hash = createHash("sha256");
  for (let offset = 0; offset < byteLength; offset += CHUNK_BYTES) {
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, byteLength - offset));
    for (let index = 0; index < chunk.byteLength; index += 1) chunk[index] = patternByte(offset + index);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function nonHardwareConformanceWriteDefinition(byteLength) {
  return {
    id: "non-hardware-conformance-windowed-write",
    directions: {
      deviceToHost: null,
      hostToDevice: {
        preparation: [{ action: "prepare-target", maximumWaitMs: 1_000, destructive: true }],
        data: {
          action: "write-range",
          maximumWaitMs: 1_000,
          sourceOffset: 0,
          targetOffset: 0,
          length: byteLength,
          maximumChunkBytes: CHUNK_BYTES,
          alignmentBytes: 1,
          maximumInFlight: WINDOW_CHUNKS,
        },
        settlement: {
          kind: "range-window-report",
          selection: "committed-window",
          maximumWaitMs: 1_000,
          maximumObservations: Math.ceil(byteLength / (CHUNK_BYTES * WINDOW_CHUNKS)) + 2,
        },
        completion: [{ action: "finalize-target", maximumWaitMs: 1_000, destructive: true }],
        verification: [{
          authority: "host-computed-device-confirmed",
          id: "source-sha256",
          algorithm: "sha256",
          domain: "source",
          coverage: { kind: "complete-effective-range" },
          maximumWaitMs: 1_000,
          reportedBinding: "source-sha256",
        }],
        retry: { kind: "none" },
        resume: null,
      },
    },
  };
}

class NonHardwareConformanceWindowAdapter {
  pending = [];
  actions = [];
  admittedOffsets = [];
  settlementWidths = [];
  transmittedAttempts = [];
  maximumPendingBytes = 0;
  finalized = false;
  lifecycle = [];
  failFirstOffset;
  partialOffset;
  reportedTargetDigest;

  constructor(options = {}) {
    this.failFirstOffset = options.failFirstOffset;
    this.partialOffset = options.partialOffset;
  }

  async executeRecipeAction(action, phase) {
    this.actions.push(`${phase}:${action.action}`);
    this.lifecycle.push(phase);
    if (phase === "completion") this.finalized = true;
  }

  async readTarget() {
    throw new Error("the non-hardware conformance write does not declare an optimistic guard");
  }

  transmittedBytes(sourceBytes) { return new Uint8Array(sourceBytes.byteLength + 8); }

  async admit(action, sourceBytes, _signal, observeTransmitted) {
    if (!this.lifecycle.includes("transfer")) this.lifecycle.push("transfer");
    this.admittedOffsets.push(action.range.targetOffset);
    const transmitted = this.transmittedBytes(sourceBytes);
    this.transmittedAttempts.push(Uint8Array.from(transmitted));
    observeTransmitted(transmitted);
    if (action.range.targetOffset === this.failFirstOffset
        && this.admittedOffsets.filter((offset) => offset === this.failFirstOffset).length === 1) {
      throw new Error("non-hardware conformance first attempt lost after possible transmission");
    }
    this.pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
    this.maximumPendingBytes = Math.max(
      this.maximumPendingBytes,
      this.pending.reduce((total, pending) => total + pending.sourceBytes.byteLength, 0),
    );
  }

  async nextSettlement(settlement) {
    assert.equal(settlement.kind, "range-window-report");
    const window = this.pending.splice(0, WINDOW_CHUNKS);
    assert.ok(window.length > 0);
    this.settlementWidths.push(window.length);
    return {
      kind: settlement.kind,
      selection: settlement.selection,
      ranges: window.map(({ action, sourceBytes }) => ({
        actionId: action.id,
        range: action.range,
        sourceBytes,
        status: action.range.targetOffset === this.partialOffset ? "may-be-partial" : "confirmed",
      })),
    };
  }

  binding(name) {
    this.lifecycle.push("verification");
    if (name === "transmitted-sha256") {
      const hash = createHash("sha256");
      for (const bytes of this.transmittedAttempts) hash.update(bytes);
      return Uint8Array.from(hash.digest());
    }
    assert.ok(name === "source-sha256" || name === "target-sha256");
    return Uint8Array.from(Buffer.from(this.reportedTargetDigest, "hex"));
  }
}

function options(byteLength, adapter, source = new PatternSource(byteLength), extra = {}) {
  adapter.reportedTargetDigest ??= patternDigest(byteLength);
  return {
    definition: nonHardwareConformanceWriteDefinition(byteLength),
    adapter,
    source,
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
    expectedSourceDigest: { algorithm: "sha256", value: patternDigest(byteLength) },
    ...extra,
  };
}

for (const [hostPath, brokerKind] of [
  ["node-direct-resource", "direct"],
  ["browser-worker-postMessage-resource", "postMessage"],
] ) {
  test(`the ${hostPath} non-hardware conformance path writes end to end through prepare, window transfer, verification, and finalization`, async () => {
    const byteLength = 8 * CHUNK_BYTES;
    const adapter = new NonHardwareConformanceWindowAdapter();
    const broker = await brokeredPatternSource(brokerKind, byteLength);
    const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, broker.source));
    await broker.close();
    assert.equal(outcome.outcome, "completed");
    assert.deepEqual(adapter.actions, ["preparation:prepare-target", "completion:finalize-target"]);
    assert.deepEqual(
      adapter.lifecycle,
      ["preparation", "transfer", "completion", "verification"],
      "one execution crosses every declared phase in order",
    );
    assert.deepEqual(adapter.settlementWidths, [WINDOW_CHUNKS, WINDOW_CHUNKS]);
    assert.equal(outcome.settledActions, 8);
    assert.equal(outcome.counts.source, byteLength);
    assert.equal(outcome.counts.target, byteLength);
    assert.equal(outcome.counts.transmitted, byteLength + 8 * 8);
    assert.equal(
      broker.physical.maximumRead,
      Math.min(byteLength, DEFAULT_HOST_RESOURCE_LIMITS.maximumResourceChunkBytes),
    );
  });
}

test("a 16 MiB non-hardware conformance image remains bounded by one resource chunk and one transfer window", async () => {
  const byteLength = 16 * 1024 * 1024;
  const adapter = new NonHardwareConformanceWindowAdapter();
  const source = new PatternSource(byteLength);
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, source));
  assert.equal(outcome.outcome, "completed");
  assert.equal(source.maximumRead, DEFAULT_HOST_RESOURCE_LIMITS.maximumResourceChunkBytes);
  assert.ok(Math.max(...adapter.settlementWidths) <= WINDOW_CHUNKS);
  assert.ok(adapter.maximumPendingBytes <= CHUNK_BYTES * WINDOW_CHUNKS);
  assert.equal(outcome.counts.source, byteLength);
});

test("runtime admits device-reported explicit coverage wider than the host write range", async () => {
  const byteLength = CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter();
  const definition = nonHardwareConformanceWriteDefinition(byteLength);
  definition.directions.hostToDevice.data.targetOffset = 64;
  definition.directions.hostToDevice.verification.push({
    authority: "device-reported",
    id: "target-sha256",
    algorithm: "sha256",
    domain: "target",
    coverage: { kind: "explicit-range", offset: 0, length: byteLength + 64 },
    maximumWaitMs: 1_000,
    reportedBinding: "target-sha256",
  });
  const outcome = await executeHostToDeviceTransferOutcome({
    ...options(byteLength, adapter),
    definition,
  });
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.verification.at(-1), {
    id: "target-sha256",
    authority: "device-reported",
    algorithm: "sha256",
    domain: "target",
    coverage: { kind: "explicit-range", offset: 0, length: byteLength + 64 },
    value: patternDigest(byteLength),
  });
});

test("runtime still rejects host-computed explicit coverage wider than the host write range", async () => {
  const byteLength = CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter();
  const definition = nonHardwareConformanceWriteDefinition(byteLength);
  definition.directions.hostToDevice.verification[0].coverage = {
    kind: "explicit-range",
    offset: 0,
    length: byteLength + 1,
  };
  const outcome = await executeHostToDeviceTransferOutcome({
    ...options(byteLength, adapter),
    definition,
  });
  assert.equal(outcome.outcome, "failed-before-destructive-work");
  assert.equal(outcome.cause.code, "transfer.verification.coverage-invalid");
  assert.deepEqual(adapter.actions, []);
  assert.deepEqual(adapter.admittedOffsets, []);
});

test("a direction without declared rewrite safety never retries a possibly transmitted range", async () => {
  const byteLength = CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter({ failFirstOffset: 0 });
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, undefined, {
    retry: { kind: "none" },
  }));
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.deepEqual(adapter.admittedOffsets, [0]);
});

test("a synthetically padded final carrier chunk keeps source, transmitted, and target counts distinct", async () => {
  const byteLength = CHUNK_BYTES + 3;
  const adapter = new NonHardwareConformanceWindowAdapter();
  adapter.transmittedBytes = (sourceBytes) => new Uint8Array(
    sourceBytes.byteLength === 3 ? CHUNK_BYTES : sourceBytes.byteLength,
  );
  adapter.nextSettlement = async function nextPaddedSettlement(settlement) {
    const window = this.pending.splice(0, WINDOW_CHUNKS);
    this.settlementWidths.push(window.length);
    return {
      kind: settlement.kind,
      selection: settlement.selection,
      ranges: window.map(({ action, sourceBytes }) => ({
        actionId: action.id,
        range: action.range,
        sourceBytes,
        status: "confirmed",
      })),
    };
  };
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter));
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.counts, {
    source: byteLength,
    transmitted: 2 * CHUNK_BYTES,
    target: byteLength,
  });
});

test("a source changed after prehash is rejected before finalization", async () => {
  const byteLength = 2 * CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter();
  // seek 1 starts the prehash; seek 2 starts the actual admitted stream.
  const source = new PatternSource(byteLength, { mutateAfterSeek: 2 });
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, source));
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.verification.source-changed");
  assert.equal(adapter.finalized, false);
});

test("a source digest mismatch refuses before preparation or byte admission", async () => {
  const byteLength = 2 * CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter();
  const source = new PatternSource(byteLength, { mutateAfterSeek: 1 });
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, source));
  assert.equal(outcome.outcome, "failed-before-destructive-work");
  assert.equal(outcome.cause.code, "transfer.verification.source-changed");
  assert.deepEqual(adapter.actions, []);
  assert.deepEqual(adapter.admittedOffsets, []);
});

test("a finalizer-produced source confirmation mismatch refuses after finalization", async () => {
  const byteLength = 2 * CHUNK_BYTES;
  const adapter = new NonHardwareConformanceWindowAdapter();
  adapter.reportedTargetDigest = "00".repeat(32);
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter));
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.verification.digest-mismatch");
  assert.equal(adapter.finalized, true);
});

test("a direct engine adapter must provide the declared digest binding", async () => {
  const adapter = new NonHardwareConformanceWindowAdapter();
  adapter.binding = () => undefined;
  const outcome = await executeHostToDeviceTransferOutcome(options(CHUNK_BYTES, adapter));
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.binding.unavailable");
});

test("cancellation settles the admitted four-range window and never finalizes", async () => {
  const byteLength = 8 * CHUNK_BYTES;
  const controller = new AbortController();
  const adapter = new NonHardwareConformanceWindowAdapter();
  const originalAdmit = adapter.admit.bind(adapter);
  adapter.admit = async (action, bytes, signal, observeTransmitted) => {
    await originalAdmit(action, bytes, signal, observeTransmitted);
    if (adapter.pending.length === WINDOW_CHUNKS) controller.abort(new Error("operator cancelled"));
  };
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, undefined, {
    signal: controller.signal,
  }));
  assert.equal(outcome.outcome, "cancelled");
  assert.equal(outcome.confirmedActions, WINDOW_CHUNKS);
  assert.equal(adapter.finalized, false);
  assert.deepEqual(adapter.settlementWidths, [WINDOW_CHUNKS]);
});

test("a may-be-partial range in a cancelled window reports failed-mid-write", async () => {
  const byteLength = 8 * CHUNK_BYTES;
  const controller = new AbortController();
  const adapter = new NonHardwareConformanceWindowAdapter({ partialOffset: CHUNK_BYTES });
  const confirmedRanges = [];
  const originalAdmit = adapter.admit.bind(adapter);
  adapter.admit = async (action, bytes, signal, observeTransmitted) => {
    await originalAdmit(action, bytes, signal, observeTransmitted);
    if (adapter.pending.length === WINDOW_CHUNKS) controller.abort(new Error("operator cancelled"));
  };
  const outcome = await executeHostToDeviceTransferOutcome(options(byteLength, adapter, undefined, {
    signal: controller.signal,
    checkpoint: {
      async phase() {},
      async confirmed(range) { confirmedRanges.push(range); return range; },
    },
  }));
  assert.equal(outcome.outcome, "failed-mid-write");
  assert.equal(outcome.confirmedActions, WINDOW_CHUNKS - 1);
  assert.equal(outcome.unresolvedActions, 1);
  assert.deepEqual(adapter.settlementWidths, [WINDOW_CHUNKS], "cancellation settles the complete admitted window");
  assert.deepEqual(
    confirmedRanges.map(({ targetOffset }) => targetOffset),
    [0, 2 * CHUNK_BYTES, 3 * CHUNK_BYTES],
    "durable progress advances only from confirmed ranges in the window report",
  );
});

class CumulativePrefixAdapter {
  pending = [];
  admitted = [];
  #offsets;
  #sourceLength;
  #domain;
  constructor(offsets, sourceLength = 12_224, domain = "source") {
    this.#offsets = [...offsets];
    this.#sourceLength = sourceLength;
    this.#domain = domain;
  }
  async executeRecipeAction() {}
  async readTarget() { throw new Error("no guarded target in cumulative control"); }
  async admit(action, bytes, _signal, observeTransmitted) {
    observeTransmitted(bytes);
    assert.ok(action.range.length <= 768, "§13.4 DATA payload maximum");
    if (action.range.length < 512) {
      assert.equal(action.range.sourceOffset + action.range.length, this.#sourceLength, "§13.4 short DATA ends at source end");
    }
    this.pending.push(action);
    this.admitted.push({ ...action.range, bytes: Uint8Array.from(bytes) });
    assert.ok(this.pending.length <= 8, "§13.4 range-slot bound");
    assert.ok(this.pending.reduce((total, item) => total + item.range.length, 0) <= 6_144, "§13.4 byte-window bound");
  }
  async nextSettlement(settlement) {
    const offset = this.#offsets.shift();
    assert.notEqual(offset, undefined);
    this.pending = this.pending.filter(({ range }) => range.sourceOffset + range.length > offset);
    return { kind: "cumulative-prefix-report", selection: settlement.selection, domain: this.#domain, offset };
  }
}

function cumulativePrefixDefinition() {
  return {
    id: "protocol-section-13-4-cumulative-control",
    directions: {
      deviceToHost: null,
      hostToDevice: {
        preparation: [],
        data: {
          action: "bulk-data",
          maximumWaitMs: 1_000,
          sourceOffset: 0,
          targetOffset: 64,
          length: 12_224,
          maximumChunkBytes: 768,
          alignmentBytes: 1,
          maximumInFlight: 8,
        },
        settlement: {
          kind: "cumulative-prefix-report",
          selection: { kind: "event", opcode: "bulk-window-ack" },
          domain: "source",
          path: ["fields", "committedSourceOffset"],
          maximumWaitMs: 1_000,
          maximumObservations: 3,
        },
        completion: [], verification: [],
        retry: { kind: "none" },
        resume: null,
      },
    },
  };
}

test("§13.4 cumulative offsets cut admitted DATA ranges without rounding the checkpoint", async () => {
  const adapter = new CumulativePrefixAdapter([4_032, 8_128, 12_224]);
  const checkpoints = [];
  const outcome = await executeHostToDeviceTransferOutcome({
    definition: cumulativePrefixDefinition(),
    adapter,
    source: new PatternSource(12_224),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
    checkpoint: { async phase() {}, async confirmed(range) { checkpoints.push(range); return range; } },
  });
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(checkpoints, [
    { sourceOffset: 0, targetOffset: 64, length: 4_032 },
    { sourceOffset: 4_032, targetOffset: 4_096, length: 4_096 },
    { sourceOffset: 8_128, targetOffset: 8_192, length: 4_096 },
  ], "the durable prefix is recorded exactly, including the first 4032-octet cut through a 768-octet action");
  assert.ok(adapter.admitted.some(({ sourceOffset, length }) => sourceOffset < 4_032 && sourceOffset + length > 4_032));
});

test("a cumulative prefix in a byte domain other than the declared domain fails by name", async () => {
  const outcome = await executeHostToDeviceTransferOutcome({
    definition: cumulativePrefixDefinition(),
    adapter: new CumulativePrefixAdapter([4_096], 12_224, "target"),
    source: new PatternSource(12_224),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.settlement.prefix-domain-mismatch");
});

test("§13.4 admits a sub-512 DATA range only as the source-ending suffix", async () => {
  const sourceLength = 12_000;
  const definition = cumulativePrefixDefinition();
  definition.directions.hostToDevice.data.length = sourceLength;
  const adapter = new CumulativePrefixAdapter([4_032, 8_128, sourceLength], sourceLength);
  const outcome = await executeHostToDeviceTransferOutcome({
    definition,
    adapter,
    source: new PatternSource(sourceLength),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(outcome.outcome, "completed");
  const last = adapter.admitted.at(-1);
  assert.deepEqual(
    { sourceOffset: last.sourceOffset, targetOffset: last.targetOffset, length: last.length },
    { sourceOffset: 11_520, targetOffset: 11_584, length: 480 },
  );
});

test("a source-digest binding is rechecked against admitted bytes before finalization", async () => {
  const definition = cumulativePrefixDefinition();
  definition.bindings = [{ name: "source-digest", valueKind: "bytes", initialize: { kind: "source-digest", algorithm: "sha256" } }];
  const outcome = await executeHostToDeviceTransferOutcome({
    definition,
    adapter: new CumulativePrefixAdapter([4_032, 8_128, 12_224]),
    source: new PatternSource(12_224, { mutateAfterSeek: 2, mutateOffset: 768 }),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.verification.source-changed");
});

for (const [name, offsets, code] of [
  ["regressing", [4_032, 4_000], "transfer.settlement.prefix-regressed"],
  ["unadmitted", [8_128], "transfer.settlement.prefix-unadmitted"],
]) test(`a ${name} cumulative prefix fails by name`, async () => {
  const outcome = await executeHostToDeviceTransferOutcome({
    definition: cumulativePrefixDefinition(),
    adapter: new CumulativePrefixAdapter(offsets),
    source: new PatternSource(12_224),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, code);
});

test("a checkpoint which rounds a cumulative cut fails by name", async () => {
  const outcome = await executeHostToDeviceTransferOutcome({
    definition: cumulativePrefixDefinition(),
    adapter: new CumulativePrefixAdapter([4_032, 8_128, 12_224]),
    source: new PatternSource(12_224),
    digestProvider: new NodeSha256DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
    checkpoint: {
      async phase() {},
      async confirmed(range) { return { ...range, length: 4_608 }; },
    },
  });
  assert.equal(outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(outcome.cause.code, "transfer.settlement.checkpoint-rounded");
});

test("bounded device cancellation retires only after success and distinguishes failure from a dead-link skip", async () => {
  const run = async (connectionUsable, failure, loseConnection = false) => {
    const controller = new AbortController();
    const adapter = new NonHardwareConformanceWindowAdapter();
    adapter.connectionUsable = connectionUsable;
    adapter.executeCancellation = async () => { if (failure !== undefined) throw failure; };
    const originalAdmit = adapter.admit.bind(adapter);
    adapter.admit = async (action, bytes, signal, observeTransmitted) => {
      await originalAdmit(action, bytes, signal, observeTransmitted);
      if (loseConnection) adapter.connectionUsable = false;
      controller.abort(new Error("operator cancelled"));
    };
    let retired = false;
    const base = nonHardwareConformanceWriteDefinition(CHUNK_BYTES);
    base.directions.hostToDevice.cancellation = { action: "abort", maximumWaitMs: 50, destructive: true, retireCheckpointOnSuccess: true };
    const outcome = await executeHostToDeviceTransferOutcome({
      ...options(CHUNK_BYTES, adapter), definition: base, signal: controller.signal,
      checkpoint: { async phase() {}, async confirmed(range) { return range; }, async retire() { retired = true; } },
    });
    return { outcome, retired };
  };
  const success = await run(true);
  assert.equal(success.outcome.outcome, "cancelled");
  assert.equal(success.retired, true);
  const failed = await run(true, new Error("abort refused"));
  assert.equal(failed.outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(failed.outcome.cause.code, "transfer.cancellation.failed");
  assert.equal(failed.retired, false);
  const dead = await run(false);
  assert.equal(dead.outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(dead.outcome.cause.code, "transfer.cancellation.skipped-dead-link");
  assert.equal(dead.retired, false);
  const diedAfterAdmission = await run(true, undefined, true);
  assert.equal(diedAfterAdmission.outcome.outcome, "indeterminate-after-destructive-work");
  assert.equal(diedAfterAdmission.outcome.cause.code, "transfer.cancellation.skipped-dead-link");
});
