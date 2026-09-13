import { createHash } from "node:crypto";

import { DEFAULT_HOST_RESOURCE_LIMITS } from "../../contracts/src/limits.ts";
import { RealClock } from "../../core/src/clock.ts";

import {
  executeResumedHostToDeviceTransfer,
  InMemoryTransferCheckpointStore,
} from "../src/transfer-checkpoint.ts";

const SOURCE_BYTES = Uint8Array.of(0x10, 0x20, 0x30, 0x40);
const SOURCE_DIGEST = createHash("sha256").update(SOURCE_BYTES).digest("hex");
const CHECKPOINT_ID = "reconnect-resume-control";
const IDENTITY = Object.freeze({ assurance: "unverified", stableKey: null, generation: null });

const DEFINITION = Object.freeze({
  id: "reconnect-resume-write",
  directions: Object.freeze({
    deviceToHost: null,
    hostToDevice: Object.freeze({
      preparation: Object.freeze([]),
      data: Object.freeze({
        action: "write",
        maximumWaitMs: 100,
        sourceOffset: 0,
        targetOffset: 0,
        length: SOURCE_BYTES.byteLength,
        maximumChunkBytes: 2,
        alignmentBytes: 1,
        maximumInFlight: 1,
      }),
      settlement: Object.freeze({
        kind: "per-action-response",
        selection: "write",
        maximumWaitMs: 100,
        maximumObservations: 2,
      }),
      completion: Object.freeze([]),
      verification: Object.freeze([]),
      retry: Object.freeze({ kind: "none" }),
      resume: Object.freeze({
        kind: "durable-reported-offset",
        reportedOffsetSelection: "committed-offset",
        maximumWaitMs: 100,
        sourceDigestAlgorithm: "sha256",
        finalization: "repeatable",
      }),
    }),
  }),
});

class MemorySource {
  #offset = 0;
  byteLength = SOURCE_BYTES.byteLength;

  async read(into) {
    const count = Math.min(into.byteLength, SOURCE_BYTES.byteLength - this.#offset);
    into.set(SOURCE_BYTES.subarray(this.#offset, this.#offset + count));
    this.#offset += count;
    return { bytesRead: count, eof: this.#offset === SOURCE_BYTES.byteLength };
  }

  async seek(offset) { this.#offset = offset; }
  async close() {}
}

class DigestProvider {
  create(algorithm) {
    const hash = createHash(algorithm);
    return {
      update: (bytes) => hash.update(bytes),
      digestHex: async () => hash.digest("hex"),
    };
  }
}

class RecordingAdapter {
  #pending = [];
  #recordingTransport;

  constructor(recordingTransport) { this.#recordingTransport = recordingTransport; }

  async readTarget() { throw new Error("resume control has no optimistic guard"); }

  async admit(action, sourceBytes, _signal, observeTransmitted) {
    await this.#recordingTransport.write(sourceBytes);
    observeTransmitted(sourceBytes);
    this.#pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
  }

  async nextSettlement(settlement) {
    const pending = this.#pending.shift();
    if (pending === undefined) throw new Error("resume control has no pending write to settle");
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

/** A half-committed durable write whose only remaining device action is one recorded suffix write. */
export async function createOutstandingResumeControl() {
  const writes = [];
  const recordingTransport = {
    async write(bytes) { writes.push(Uint8Array.from(bytes)); },
  };
  const store = new InMemoryTransferCheckpointStore();
  await store.create({
    formatVersion: 1,
    id: CHECKPOINT_ID,
    revision: 0,
    manifestHash: "11".repeat(32),
    definitionHash: "22".repeat(32),
    modeId: "fixture",
    direction: "hostToDevice",
    phase: "transferring",
    finalization: "repeatable",
    source: {
      algorithm: "sha256",
      digest: SOURCE_DIGEST,
      byteLength: SOURCE_BYTES.byteLength,
    },
    identity: IDENTITY,
    confirmedRanges: [{ targetOffset: 0, length: 2 }],
  });
  const claim = await store.claim(CHECKPOINT_ID, "reconnect-resume-control");
  return Object.freeze({
    checkpointId: CHECKPOINT_ID,
    writes,
    async resume() {
      return executeResumedHostToDeviceTransfer({
        store,
        claim,
        manifestHash: claim.checkpoint.manifestHash,
        definitionHash: claim.checkpoint.definitionHash,
        modeId: claim.checkpoint.modeId,
        identity: IDENTITY,
        async observeReportedTargetOffset() { return 2; },
        definition: DEFINITION,
        adapter: new RecordingAdapter(recordingTransport),
        source: new MemorySource(),
        digestProvider: new DigestProvider(),
        clock: new RealClock(),
        limits: DEFAULT_HOST_RESOURCE_LIMITS,
      });
    },
  });
}
