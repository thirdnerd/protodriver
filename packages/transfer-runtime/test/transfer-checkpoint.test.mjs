import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { DEFAULT_HOST_RESOURCE_LIMITS } from "../../contracts/src/limits.ts";
import { verifyLuaSourceSet } from "../../contracts/src/lua-source-set.ts";
import { RealClock } from "../../core/src/clock.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import {
  executeResumedHostToDeviceTransfer,
  InMemoryTransferCheckpointStore,
  TransferCheckpointError,
  validateTransferResume,
} from "../src/transfer-checkpoint.ts";
import { executeHostToDeviceTransferOutcome } from "../src/transfer.ts";

function checkpoint(overrides = {}) {
  return {
    formatVersion: 2,
    id: "non-hardware-conformance-resume",
    revision: 0,
    manifestHash: "11".repeat(32),
    definitionHash: "22".repeat(32),
    modeId: "bootloader",
    direction: "hostToDevice",
    source: { algorithm: "sha256", digest: "33".repeat(32), byteLength: 1024 },
    identity: { stableKeyAssurance: "serial-number", stableKey: "serial:conformance", generation: "generation-7" },
    phase: "transferring",
    confirmedRanges: [{ targetOffset: 0, length: 512 }],
    finalization: "repeatable",
    ...overrides,
  };
}

function expectCode(code, operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof TransferCheckpointError);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

test("exactly one claimant owns a checkpoint and commits by revision", async () => {
  const store = new InMemoryTransferCheckpointStore();
  await store.create(checkpoint());
  const first = await store.claim("non-hardware-conformance-resume", "host-a");
  await assert.rejects(
    store.claim("non-hardware-conformance-resume", "host-b"),
    (error) => error instanceof TransferCheckpointError
      && error.diagnostic.code === "transfer.checkpoint-held",
  );
  const committed = await store.commit(first, checkpoint({
    revision: 1,
    confirmedRanges: [{ targetOffset: 0, length: 768 }],
  }));
  assert.equal(committed.checkpoint.revision, 1);
  await store.release(committed);
  const second = await store.claim("non-hardware-conformance-resume", "host-b");
  assert.equal(second.checkpoint.confirmedRanges[0].length, 768);
});

test("checkpoint validation rejects an unknown persisted lifecycle phase", async () => {
  const store = new InMemoryTransferCheckpointStore();
  await assert.rejects(
    store.create(checkpoint({ phase: "between-things" })),
    (error) => error instanceof TransferCheckpointError
      && error.diagnostic.code === "transfer.checkpoint-invalid"
      && error.diagnostic.declarationPath.endsWith(".phase"),
  );
});

test("checkpoint validation refuses provenance-free format-1 records", () => {
  const old = { ...checkpoint(), formatVersion: 1 };
  expectCode("transfer.checkpoint-invalid", () => validateTransferResume({
    checkpoint: old,
    manifestHash: old.manifestHash,
    definitionHash: old.definitionHash,
    modeId: old.modeId,
    direction: old.direction,
    sourceDigest: old.source.digest,
    identity: old.identity,
  }));
});

test("resume refuses source, definition, generation, and non-repeatable-finalization changes before admission", () => {
  const base = checkpoint();
  const input = {
    checkpoint: base,
    manifestHash: base.manifestHash,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: base.identity,
    reportedTargetOffset: 512,
  };
  assert.deepEqual(validateTransferResume(input), { assurance: "verified", confirmedTargetOffset: 512 });
  expectCode("transfer.resume.manifest-mismatch", () => validateTransferResume({ ...input, manifestHash: "44".repeat(32) }));
  expectCode("transfer.resume.definition-mismatch", () => validateTransferResume({ ...input, definitionHash: "44".repeat(32) }));
  expectCode("transfer.resume.mode-mismatch", () => validateTransferResume({ ...input, modeId: "application" }));
  expectCode("transfer.resume.direction-mismatch", () => validateTransferResume({ ...input, direction: "deviceToHost" }));
  expectCode("transfer.resume.preparation-incomplete", () => validateTransferResume({
    ...input,
    checkpoint: checkpoint({ phase: "preparing", confirmedRanges: [] }),
    reportedTargetOffset: 0,
  }));
  expectCode("transfer.resume.source-mismatch", () => validateTransferResume({ ...input, sourceDigest: "44".repeat(32) }));
  expectCode("transfer.resume.identity-mismatch", () => validateTransferResume({
    ...input,
    identity: { ...base.identity, generation: "generation-8" },
  }));
  expectCode("transfer.resume.finalization-not-repeatable", () => validateTransferResume({
    ...input,
    checkpoint: checkpoint({ phase: "finalizing", finalization: "not-repeatable" }),
  }));
});

test("authored-Lua resume refuses a changed source set independently of graph and transfer definition", () => {
  const sourceSetIdentity = { algorithm: "sha256", hex: "55".repeat(32) };
  const base = checkpoint({ sourceSetIdentity });
  const input = {
    checkpoint: base,
    manifestHash: base.manifestHash,
    sourceSetIdentity,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: base.identity,
    reportedTargetOffset: 512,
  };
  assert.deepEqual(validateTransferResume(input), { assurance: "verified", confirmedTargetOffset: 512 });
  expectCode("transfer.resume.source-set-mismatch", () => validateTransferResume({
    ...input,
    sourceSetIdentity: { algorithm: "sha256", hex: "66".repeat(32) },
  }));
  expectCode("transfer.resume.manifest-mismatch", () => validateTransferResume({
    ...input,
    manifestHash: "77".repeat(32),
  }));
  expectCode("transfer.resume.definition-mismatch", () => validateTransferResume({
    ...input,
    definitionHash: "88".repeat(32),
  }));
});

test("repacking identical logical Lua sources preserves durable resume identity", async () => {
  const bootstrap = { packageFormat: "supported", generatorContract: "supported" };
  const device = { logicalName: "device.lua", sourceBytes: new TextEncoder().encode("return {}\n") };
  const helper = { logicalName: "helper.lua", sourceBytes: new TextEncoder().encode("return 1\n") };
  const first = await verifyLuaSourceSet({ bootstrap, members: [device, helper] });
  const repacked = await verifyLuaSourceSet({ bootstrap, members: [helper, device] });
  assert.deepEqual(repacked.identity, first.identity);
  const base = checkpoint({ sourceSetIdentity: first.identity });
  assert.deepEqual(validateTransferResume({
    checkpoint: base,
    manifestHash: base.manifestHash,
    sourceSetIdentity: repacked.identity,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: base.identity,
    reportedTargetOffset: 512,
  }), { assurance: "verified", confirmedTargetOffset: 512 });
});

test("resume rejects a device-reported offset that regresses behind the durable checkpoint", () => {
  const base = checkpoint();
  expectCode("transfer.resume.offset-mismatch", () => validateTransferResume({
    checkpoint: base,
    manifestHash: base.manifestHash,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: base.identity,
    reportedTargetOffset: 256,
  }));
});

test("resume rejects a device-reported offset beyond the checkpoint transfer extent", () => {
  const base = checkpoint();
  assert.throws(() => validateTransferResume({
    checkpoint: base,
    manifestHash: base.manifestHash,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: base.identity,
    reportedTargetOffset: 1_025,
  }), (error) => {
    assert.ok(error instanceof TransferCheckpointError);
    assert.equal(error.diagnostic.code, "transfer.resume.offset-mismatch");
    assert.deepEqual(error.diagnostic.details, {
      checkpointOffset: 512,
      reportedOffset: 1_025,
      maximumOffset: 1_024,
    });
    return true;
  });
});

test("an active non-hardware transfer suspended at half refuses automatic continuation when the reported offset disagrees", async () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const chunkBytes = 128;
  const windowChunks = 4;
  const halfOffset = bytes.byteLength / 2;
  const reportedOffsetAfterSuspend = halfOffset - chunkBytes;
  const initial = checkpoint({
    source: { algorithm: "sha256", digest, byteLength: bytes.byteLength },
    phase: "preparing",
    confirmedRanges: [],
  });
  const definition = {
    id: initial.id,
    directions: {
      deviceToHost: null,
      hostToDevice: {
        preparation: [{ action: "prepare", maximumWaitMs: 100, destructive: true }],
        data: {
          action: "write",
          maximumWaitMs: 100,
          sourceOffset: 0,
          targetOffset: 0,
          length: bytes.byteLength,
          maximumChunkBytes: chunkBytes,
          alignmentBytes: 1,
          maximumInFlight: windowChunks,
        },
        settlement: {
          kind: "range-window-report",
          selection: "window",
          maximumWaitMs: 100,
          maximumObservations: bytes.byteLength / chunkBytes,
        },
        completion: [],
        verification: [],
        retry: { kind: "none" },
        resume: {
          kind: "durable-reported-offset",
          reportedOffsetSelection: "committed-offset",
          maximumWaitMs: 100,
          sourceDigestAlgorithm: "sha256",
          finalization: "repeatable",
        },
      },
    },
  };
  const store = new InMemoryTransferCheckpointStore();
  await store.create(initial);
  let claim = await store.claim(initial.id, "suspended-host");
  const confirmedRanges = [];
  const pending = [];
  const controller = new AbortController();
  const suspendEvent = Object.freeze({
    observedGapMs: 1_250,
    heartbeatIntervalMs: 250,
    heartbeatLateByMs: 1_000,
    wallDeltaMs: 1_250,
    monotonicDeltaMs: 1_250,
    detectedAtSequence: 17,
    source: "heartbeat-overdue",
  });
  const outcome = await executeHostToDeviceTransferOutcome({
    definition,
    adapter: {
      async executeRecipeAction() {},
      async readTarget() { throw new Error("non-hardware suspend fixture has no optimistic guard"); },
      async admit(action, sourceBytes, _signal, observeTransmitted) {
        observeTransmitted(sourceBytes);
        pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
        if (pending.length === windowChunks) controller.abort(suspendEvent);
      },
      async nextSettlement(settlement) {
        return {
          kind: settlement.kind,
          selection: settlement.selection,
          ranges: pending.splice(0).map(({ action, sourceBytes }) => ({
            actionId: action.id,
            range: action.range,
            sourceBytes,
            status: "confirmed",
          })),
        };
      },
    },
    source: new MemorySource(bytes),
    digestProvider: new DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
    expectedSourceDigest: { algorithm: "sha256", value: digest },
    signal: controller.signal,
    checkpoint: {
      async phase(phase) {
        claim = await store.commit(claim, {
          ...claim.checkpoint,
          revision: claim.checkpoint.revision + 1,
          phase,
        });
      },
      async confirmed(range) {
        confirmedRanges.push({ targetOffset: range.targetOffset, length: range.length });
        claim = await store.commit(claim, {
          ...claim.checkpoint,
          revision: claim.checkpoint.revision + 1,
          confirmedRanges: [...confirmedRanges],
        });
        return range;
      },
    },
  });
  assert.equal(controller.signal.reason, suspendEvent, "the active transfer was interrupted by the typed suspend event");
  assert.equal(outcome.outcome, "cancelled");
  assert.equal(outcome.confirmedActions, windowChunks);
  assert.equal(
    claim.checkpoint.confirmedRanges.reduce((total, range) => total + range.length, 0),
    halfOffset,
  );
  await store.release(claim);

  const replacementClaim = await store.claim(initial.id, "resumed-host");
  let offsetQueries = 0;
  let resumedAdmissions = 0;
  await assert.rejects(
    executeResumedHostToDeviceTransfer({
      store,
      claim: replacementClaim,
      manifestHash: initial.manifestHash,
      definitionHash: initial.definitionHash,
      modeId: initial.modeId,
      identity: initial.identity,
      async observeReportedTargetOffset(selection) {
        offsetQueries += 1;
        assert.equal(selection, "committed-offset");
        return reportedOffsetAfterSuspend;
      },
      definition,
      adapter: {
        async executeRecipeAction() { throw new Error("offset mismatch must precede lifecycle work"); },
        async readTarget() { throw new Error("offset mismatch must precede target reads"); },
        async admit() { resumedAdmissions += 1; },
        async nextSettlement() { throw new Error("offset mismatch must precede settlement"); },
      },
      source: new MemorySource(bytes),
      digestProvider: new DigestProvider(),
      clock: new RealClock(),
      limits: DEFAULT_HOST_RESOURCE_LIMITS,
    }),
    (error) => error instanceof TransferCheckpointError
      && error.diagnostic.code === "transfer.resume.offset-mismatch"
      && error.diagnostic.details?.checkpointOffset === halfOffset
      && error.diagnostic.details?.reportedOffset === reportedOffsetAfterSuspend,
  );
  assert.equal(offsetQueries, 1, "resume re-queries the declaration-selected device offset");
  assert.equal(resumedAdmissions, 0, "offset mismatch never auto-continues from the checkpoint");
});

test("absence of physical continuity evidence is reported as unverified, never inferred from probing", () => {
  const base = checkpoint({
    identity: { stableKeyAssurance: "none", stableKey: null, generation: null },
  });
  assert.deepEqual(validateTransferResume({
    checkpoint: base,
    manifestHash: base.manifestHash,
    definitionHash: base.definitionHash,
    modeId: base.modeId,
    direction: base.direction,
    sourceDigest: base.source.digest,
    identity: { stableKeyAssurance: "none", stableKey: null, generation: null },
  }), { assurance: "unverified", confirmedTargetOffset: 512 });
});

test("device generation does not upgrade path-derived or absent acquisition provenance", () => {
  for (const identity of [
    { stableKeyAssurance: "path-derived", stableKey: "/dev/ttyUSB0", generation: "7" },
    { stableKeyAssurance: "none", stableKey: null, generation: "7" },
  ]) {
    const base = checkpoint({ identity });
    assert.deepEqual(validateTransferResume({
      checkpoint: base,
      manifestHash: base.manifestHash,
      definitionHash: base.definitionHash,
      modeId: base.modeId,
      direction: base.direction,
      sourceDigest: base.source.digest,
      identity,
      reportedTargetOffset: 512,
    }), { assurance: "unverified", confirmedTargetOffset: 512 });
  }
});

class MemorySource {
  #offset = 0;
  constructor(bytes) { this.bytes = Uint8Array.from(bytes); this.byteLength = this.bytes.byteLength; }
  async read(into) {
    const bytesRead = Math.min(into.byteLength, this.bytes.byteLength - this.#offset);
    into.set(this.bytes.subarray(this.#offset, this.#offset + bytesRead));
    this.#offset += bytesRead;
    return { bytesRead, eof: this.#offset === this.bytes.byteLength };
  }
  async seek(offset) { this.#offset = offset; }
  async close() {}
}

class DigestProvider {
  create(algorithm) {
    const hash = createHash(algorithm);
    return { update: (bytes) => hash.update(bytes), digestHex: async () => hash.digest("hex") };
  }
}

function quiescenceReport({ committed = 640, volatile = committed, count = 0, generation = 7 } = {}) {
  return Object.freeze({
    identity: Object.freeze({ kind: "event", opcode: "rollback" }),
    fields: Object.freeze({ committed, volatile, count, generation }),
    sourcePayload: new Uint8Array(),
  });
}

async function quiescenceResumeHarness({
  probe = { committed: 512, volatile: 640, count: 1, generation: 7 },
  nextResumeReport = async () => quiescenceReport(),
  clock = new RealClock(),
  replacementIdentity,
  initiationGeneration = 7,
} = {}) {
  const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const initial = checkpoint({
    source: { algorithm: "sha256", digest, byteLength: bytes.byteLength },
    identity: { stableKeyAssurance: "serial-number", stableKey: "serial:conformance", generation: "7" },
  });
  const store = new InMemoryTransferCheckpointStore();
  await store.create(initial);
  const claim = await store.claim(initial.id, "replacement-host");
  const bindings = new Map();
  const calls = [];
  const admitted = [];
  const pending = [];
  const definition = {
    id: initial.id,
    directions: {
      deviceToHost: null,
      hostToDevice: {
        writeProtection: { kind: "device-journaled-source", initiationAction: "begin", sourceDigestBinding: "source-digest", generationBinding: "generation" },
        preparation: [],
        data: {
          action: "write", maximumWaitMs: 100, sourceOffset: 0, targetOffset: 0,
          length: bytes.byteLength, maximumChunkBytes: 128, alignmentBytes: 1, maximumInFlight: 4,
        },
        settlement: { kind: "range-window-report", selection: "window", maximumWaitMs: 100, maximumObservations: 8 },
        completion: [], verification: [], retry: { kind: "none" },
        resume: {
          kind: "durable-reported-offset", reportedOffsetSelection: "unused", maximumWaitMs: 100,
          sourceDigestAlgorithm: "sha256", finalization: "repeatable",
          recipe: {
            quiescence: {
              kind: "reported-volatile-empty",
              probe: { action: "probe", maximumWaitMs: 100, destructive: false },
              probedGenerationBinding: "probed-generation",
              volatileOffsetBinding: "volatile",
              bufferedRangeCountBinding: "count",
              report: {
                selection: { kind: "event", opcode: "rollback" }, maximumWaitMs: 2_001,
                reportedOffsetPath: ["fields", "committed"],
                volatileOffsetPath: ["fields", "volatile"],
                bufferedRangeCountPath: ["fields", "count"],
                generationPath: ["fields", "generation"],
              },
            },
            actions: [{ action: "begin", maximumWaitMs: 100, destructive: true }],
            reportedOffsetBinding: "committed",
            generationBinding: "generation",
          },
        },
      },
    },
  };
  const adapter = {
    initializeBindings(values) { for (const [name, value] of Object.entries(values)) bindings.set(name, value); },
    async executeResumeProbe(action, selection) {
      calls.push(`probe:${action.action}:${selection.opcode}`);
      bindings.set("committed", probe.committed);
      bindings.set("probed-generation", probe.generation ?? 7);
      bindings.set("volatile", probe.volatile);
      bindings.set("count", probe.count);
    },
    async nextResumeReport(selection, signal) {
      calls.push(`report:${selection.opcode}`);
      return nextResumeReport({ signal, calls, clock });
    },
    async executeRecipeAction(action, phase) {
      calls.push(`${phase}:${action.action}`);
      bindings.set("generation", initiationGeneration);
    },
    binding(name) { return bindings.get(name); },
    async readTarget() { throw new Error("journaled resume has no optimistic target guard"); },
    async admit(action, sourceBytes, _signal, observeTransmitted) {
      calls.push(`data:${action.range.targetOffset}`);
      observeTransmitted(sourceBytes);
      admitted.push(action.range.targetOffset);
      pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
    },
    async nextSettlement(settlement) {
      return {
        kind: settlement.kind,
        selection: settlement.selection,
        ranges: pending.splice(0).map(({ action, sourceBytes }) => ({ actionId: action.id, range: action.range, sourceBytes, status: "confirmed" })),
      };
    },
  };
  return {
    calls,
    admitted,
    clock,
    execute: () => executeResumedHostToDeviceTransfer({
      store, claim, manifestHash: initial.manifestHash, definitionHash: initial.definitionHash,
      modeId: initial.modeId,
      identity: replacementIdentity ?? { stableKeyAssurance: "serial-number", stableKey: initial.identity.stableKey, generation: null },
      async observeReportedTargetOffset() { throw new Error("declared recipe owns resume observation"); },
      definition, adapter, source: new MemorySource(bytes), digestProvider: new DigestProvider(),
      clock, limits: DEFAULT_HOST_RESOURCE_LIMITS,
    }),
  };
}

test("resume quiescence executes its declared probe exactly once", async () => {
  let reports = 0;
  const harness = await quiescenceResumeHarness({
    nextResumeReport: async () => ++reports < 3
      ? quiescenceReport({ committed: 512, volatile: 640, count: 1 })
      : quiescenceReport({ committed: 640 }),
  });
  await harness.execute();
  assert.equal(harness.calls.filter((call) => call.startsWith("probe:")).length, 1);
  assert.equal(reports, 3);
});

test("resume admits an unknown physical generation after a matching read-only probe", async () => {
  const harness = await quiescenceResumeHarness({
    probe: { committed: 512, volatile: 512, count: 0, generation: 7 },
  });
  const result = await harness.execute();
  assert.equal(result.outcome.outcome, "completed");
  assert.equal(harness.calls[0], "probe:probe:rollback");
  assert.ok(harness.calls.includes("preparation:begin"));
});

test("resume rejects a generation reported differently from its checkpoint", async () => {
  const harness = await quiescenceResumeHarness({
    probe: { committed: 512, volatile: 512, count: 0, generation: 8 },
  });
  await assert.rejects(harness.execute(), (error) => error instanceof TransferCheckpointError
    && error.diagnostic.code === "transfer.resume.identity-mismatch"
    && error.diagnostic.declarationPath.endsWith("probed-generation"));
});

test("resume compares the probed generation before every destructive recipe action", async () => {
  const harness = await quiescenceResumeHarness({
    probe: { committed: 512, volatile: 512, count: 0, generation: 8 },
  });
  await assert.rejects(harness.execute(), (error) => error instanceof TransferCheckpointError
    && error.diagnostic.code === "transfer.resume.identity-mismatch");
  assert.deepEqual(harness.calls, ["probe:probe:rollback"]);
});

test("resume quiescence silent wait transmits no request or data", { timeout: 5_000 }, async () => {
  let release;
  let waitingResolve;
  const waiting = new Promise((resolve) => { waitingResolve = resolve; });
  const report = new Promise((resolve) => { release = resolve; });
  const harness = await quiescenceResumeHarness({
    nextResumeReport: async () => { waitingResolve(); return report; },
  });
  const execution = harness.execute();
  const reached = await Promise.race([
    waiting.then(() => "waiting"),
    execution.then(() => "completed"),
  ]);
  assert.equal(reached, "waiting", "skipping the declared report wait must fail instead of hanging this control");
  assert.deepEqual(harness.calls, ["probe:probe:rollback", "report:rollback"], "no recipe action or DATA is transmitted while volatile ranges remain");
  release(quiescenceReport({ committed: 640 }));
  await execution;
});

test("resume quiescence reports do not renew the one absolute wait bound", { timeout: 5_000 }, async () => {
  const clock = new VirtualClock();
  let reports = 0;
  const harness = await quiescenceResumeHarness({
    clock,
    nextResumeReport: async ({ signal }) => {
      reports += 1;
      if (reports === 1) {
        await clock.sleep(1_500, signal);
        return quiescenceReport({ committed: 512, volatile: 640, count: 1 });
      }
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const execution = harness.execute();
  let stopPolling = false;
  const timerReady = new Promise((resolve) => {
    const poll = () => {
      if (stopPolling) return;
      if (clock.pending.length > 0) resolve("timer-ready");
      else setImmediate(poll);
    };
    poll();
  });
  let reached;
  try {
    reached = await Promise.race([
      timerReady,
      execution.then(() => "completed"),
    ]);
  } finally {
    stopPolling = true;
  }
  assert.equal(reached, "timer-ready", "skipping the bounded report wait must fail instead of hanging this control");
  await clock.advance(1_500_000);
  await clock.advance(501_000);
  await assert.rejects(execution, (error) => error instanceof TransferCheckpointError
    && error.diagnostic.declarationPath.endsWith("quiescence.report"));
  assert.equal(reports, 2);
});

test("resume quiescence already-empty probe proceeds without waiting for an event", async () => {
  const harness = await quiescenceResumeHarness({
    probe: { committed: 512, volatile: 512, count: 0 },
    nextResumeReport: async () => { throw new Error("already-empty probe must not wait for a report"); },
  });
  await harness.execute();
  assert.equal(harness.calls.filter((call) => call.startsWith("report:")).length, 0);
  assert.equal(harness.calls.filter((call) => call === "preparation:begin").length, 1);
});

test("resume quiescence uses the empty report offset instead of the earlier probe offset", async () => {
  const harness = await quiescenceResumeHarness({
    probe: { committed: 512, volatile: 640, count: 1 },
    nextResumeReport: async () => quiescenceReport({ committed: 768 }),
  });
  await harness.execute();
  assert.deepEqual(harness.admitted, [768, 896]);
});

test("a bounded forward device offset is committed before resume admits only its remaining suffix", async () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const store = new InMemoryTransferCheckpointStore();
  await store.create(checkpoint({ source: { algorithm: "sha256", digest, byteLength: bytes.byteLength } }));
  const claim = await store.claim(checkpoint().id, "replacement-host");
  const pending = [];
  const admitted = [];
  const result = await executeResumedHostToDeviceTransfer({
    store,
    claim,
    manifestHash: checkpoint().manifestHash,
    definitionHash: checkpoint().definitionHash,
    modeId: checkpoint().modeId,
    identity: checkpoint().identity,
    async observeReportedTargetOffset(selection) {
      assert.equal(selection, "committed-offset");
      return 640;
    },
    definition: {
      id: checkpoint().id,
      directions: {
        deviceToHost: null,
        hostToDevice: {
          preparation: [{ action: "prepare", maximumWaitMs: 100, destructive: true }],
          data: {
            action: "write", maximumWaitMs: 100, sourceOffset: 0, targetOffset: 0,
            length: 1024, maximumChunkBytes: 128, alignmentBytes: 1, maximumInFlight: 4,
          },
          settlement: { kind: "range-window-report", selection: "window", maximumWaitMs: 100, maximumObservations: 4 },
          completion: [], verification: [], retry: { kind: "none" },
          resume: {
            kind: "durable-reported-offset", reportedOffsetSelection: "committed-offset",
            maximumWaitMs: 100, sourceDigestAlgorithm: "sha256", finalization: "repeatable",
          },
        },
      },
    },
    adapter: {
      async executeRecipeAction() { throw new Error("completed preparation must not repeat during resume"); },
      async readTarget() { throw new Error("no guard"); },
      async admit(action, sourceBytes, _signal, observeTransmitted) {
        const persisted = await store.read(checkpoint().id);
        assert.deepEqual(
          persisted?.confirmedRanges,
          [{ targetOffset: 0, length: 640 }],
          "forward reconciliation is durable before the first suffix action is admitted",
        );
        observeTransmitted(sourceBytes);
        admitted.push(action.range.targetOffset);
        pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
      },
      async nextSettlement(settlement) {
        const ranges = pending.splice(0, 4).map(({ action, sourceBytes }) => ({
          actionId: action.id, range: action.range, sourceBytes, status: "confirmed",
        }));
        return { kind: settlement.kind, selection: settlement.selection, ranges };
      },
    },
    source: new MemorySource(bytes),
    digestProvider: new DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(result.outcome.outcome, "completed");
  assert.equal(result.claim, null);
  assert.deepEqual(admitted, [640, 768, 896]);
  assert.equal(await store.read(checkpoint().id), null);
});

test("a crash after the final range dispatches source confirmation and a non-identity device target report", async () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const targetDigest = "ab".repeat(32);
  const complete = checkpoint({
    source: { algorithm: "sha256", digest, byteLength: bytes.byteLength },
    confirmedRanges: [{ targetOffset: 0, length: bytes.byteLength }],
  });
  const store = new InMemoryTransferCheckpointStore();
  await store.create(complete);
  const claim = await store.claim(complete.id, "replacement-host");
  const actions = [];
  const result = await executeResumedHostToDeviceTransfer({
    store,
    claim,
    manifestHash: complete.manifestHash,
    definitionHash: complete.definitionHash,
    modeId: complete.modeId,
    identity: complete.identity,
    async observeReportedTargetOffset() { return bytes.byteLength; },
    definition: {
      id: complete.id,
      directions: {
        deviceToHost: null,
        hostToDevice: {
          preparation: [{ action: "prepare", maximumWaitMs: 100, destructive: true }],
          data: {
            action: "write", maximumWaitMs: 100, sourceOffset: 0, targetOffset: 0,
            length: bytes.byteLength, maximumChunkBytes: 128, alignmentBytes: 1, maximumInFlight: 4,
          },
          settlement: { kind: "range-window-report", selection: "window", maximumWaitMs: 100, maximumObservations: 4 },
          completion: [{ action: "finalize", maximumWaitMs: 100, destructive: true }],
          verification: [
            {
              authority: "host-computed-device-confirmed", id: "source", algorithm: "sha256", domain: "source",
              coverage: { kind: "complete-effective-range" }, maximumWaitMs: 100, reportedBinding: "source",
            },
            {
              authority: "device-reported", id: "target", algorithm: "sha256", domain: "target",
              coverage: { kind: "complete-effective-range" }, maximumWaitMs: 100, reportedBinding: "target",
            },
          ],
          retry: { kind: "none" },
          resume: {
            kind: "durable-reported-offset", reportedOffsetSelection: "committed-offset",
            maximumWaitMs: 100, sourceDigestAlgorithm: "sha256", finalization: "repeatable",
          },
        },
      },
    },
    adapter: {
      async executeRecipeAction(action, phase) { actions.push(`${phase}:${action.action}`); },
      async readTarget() { throw new Error("no guard"); },
      async admit() { throw new Error("all data was already confirmed"); },
      async nextSettlement() { throw new Error("all data was already confirmed"); },
      binding(name) {
        assert.ok(name === "source" || name === "target");
        return Uint8Array.from(Buffer.from(name === "source" ? digest : targetDigest, "hex"));
      },
    },
    source: new MemorySource(bytes),
    digestProvider: new DigestProvider(),
    clock: new RealClock(),
    limits: DEFAULT_HOST_RESOURCE_LIMITS,
  });
  assert.equal(result.outcome.outcome, "completed");
  assert.deepEqual(actions, ["completion:finalize"]);
  assert.deepEqual(result.outcome.verification.map(({ id, authority, value }) => ({ id, authority, value })), [
    { id: "source", authority: "host-computed-device-confirmed", value: digest },
    { id: "target", authority: "device-reported", value: targetDigest },
  ]);
  assert.equal(await store.read(complete.id), null);
});
