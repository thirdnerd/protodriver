import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";

export const CHECKPOINT_BYTES = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
export const CHECKPOINT_DIGEST = createHash("sha256").update(CHECKPOINT_BYTES).digest("hex");
export const CHECKPOINT_CHUNK_BYTES = 128;
export const CHECKPOINT_WINDOW_CHUNKS = 4;
export const CHECKPOINT_HALF_OFFSET = CHECKPOINT_BYTES.byteLength / 2;
export const MANIFEST_HASH = "11".repeat(32);
export const MANIFEST_MODE_ID = "bootloader";
export const MANIFEST_TRANSFER_ID = "memory-range";

export const manifestCarrierActions = Object.freeze({
  query: {
    command: { command: "query", arguments: {}, expectedMessage: { kind: "response", opcode: "query" } },
    followUp: [], responseAssertions: [], settledBytes: { kind: "request-source" },
    resultBindings: [
      { binding: "committed", path: ["fields", "committed"] },
      { binding: "generation", path: ["fields", "generation"] },
    ],
  },
  begin: {
    command: {
      command: "begin",
      arguments: {
        length: { kind: "binding", binding: "length" },
        digest: { kind: "binding", binding: "digest" },
      },
      expectedMessage: { kind: "response", opcode: "begin" },
    },
    followUp: [], responseAssertions: [], settledBytes: { kind: "request-source" },
    resultBindings: [{ binding: "generation", path: ["fields", "generation"] }],
  },
  write: {
    command: {
      command: "write",
      arguments: {
        offset: { kind: "target-offset" },
        length: { kind: "length" },
        data: { kind: "source-bytes" },
      },
      expectedMessage: { kind: "response", opcode: "write" },
    },
    followUp: [], responseAssertions: [], settledBytes: { kind: "request-source" },
  },
  finalize: {
    command: { command: "finalize", arguments: {}, expectedMessage: { kind: "response", opcode: "finalize" } },
    followUp: [], responseAssertions: [], settledBytes: { kind: "request-source" },
    resultBindings: [{ binding: "source-sha256", path: ["fields", "sourceDigest"] }],
  },
});

export const manifestTransfers = Object.freeze({
  [MANIFEST_TRANSFER_ID]: {
    parameters: [{ name: "length", minimum: CHECKPOINT_BYTES.byteLength, maximum: CHECKPOINT_BYTES.byteLength }],
    bindings: [
      { name: "length", valueKind: "integer", initialize: { kind: "source-length" } },
      { name: "digest", valueKind: "bytes", initialize: { kind: "source-digest", algorithm: "sha256" } },
      { name: "committed", valueKind: "integer" },
      { name: "generation", valueKind: "integer" },
      { name: "source-sha256", valueKind: "bytes" },
    ],
    directions: {
      hostToDevice: {
        writeProtection: {
          kind: "device-journaled-source",
          initiationAction: "begin",
          sourceDigestBinding: "digest",
          generationBinding: "generation",
        },
        preparation: [
          { action: "query", maximumWaitMs: 1_000, destructive: false },
          { action: "begin", maximumWaitMs: 1_000, destructive: true },
        ],
        data: {
          action: "write", maximumWaitMs: 1_000, sourceOffset: { kind: "constant", value: 0 },
          targetOffset: { kind: "constant", value: 0 }, length: { kind: "parameter", parameter: "length" },
          maximumChunkBytes: CHECKPOINT_CHUNK_BYTES, alignmentBytes: 1, maximumInFlight: 1,
        },
        settlement: {
          kind: "per-action-response", selection: "write", maximumWaitMs: 1_000,
          maximumObservations: CHECKPOINT_BYTES.byteLength / CHECKPOINT_CHUNK_BYTES,
        },
        completion: [{ action: "finalize", maximumWaitMs: 1_000, destructive: true }],
        verification: [{
          authority: "host-computed-device-confirmed", id: "source-sha256", algorithm: "sha256",
          domain: "source", coverage: { kind: "complete-effective-range" }, maximumWaitMs: 1_000,
          reportedBinding: "source-sha256",
        }],
        retry: { kind: "none" },
        resume: {
          kind: "durable-reported-offset", reportedOffsetSelection: "committed-offset",
          maximumWaitMs: 1_000, sourceDigestAlgorithm: "sha256", finalization: "repeatable",
          recipe: {
            actions: [
              { action: "query", maximumWaitMs: 1_000, destructive: false },
              { action: "begin", maximumWaitMs: 1_000, destructive: true },
            ],
            reportedOffsetBinding: "committed",
            generationBinding: "generation",
          },
        },
      },
    },
  },
});

function response(opcode, fields) {
  return { message: { identity: { kind: "response", opcode }, fields, sourcePayload: new Uint8Array() }, responses: [] };
}

async function replaceDeviceState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The fake device state is shared by independent host processes. Publish
    // only a complete record so a replacement host observes the old or new
    // durable offset, never writeFile's truncated intermediate state.
    await rename(temporary, path);
  } finally {
    await handle?.close();
    try {
      await unlink(temporary);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
  }
}

/** File-backed fake device state survives the originating host process. */
export class ManifestWindowCommands {
  admitted = [];
  preparation = [];
  constructor(deviceStatePath, writeDelayMs = 0) {
    this.deviceStatePath = deviceStatePath;
    this.writeDelayMs = writeDelayMs;
  }
  async execute(command, argumentsByName) {
    const state = JSON.parse(await readFile(this.deviceStatePath, "utf8"));
    if (command === "query") {
      this.preparation.push("query");
      return response("query", { committed: state.committedOffset, generation: state.generation });
    }
    if (command === "begin") {
      this.preparation.push("begin");
      return response("begin", { generation: state.generation });
    }
    if (command === "write") {
      const offset = argumentsByName.offset;
      const length = argumentsByName.length;
      this.admitted.push(offset);
      if (this.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
      await replaceDeviceState(this.deviceStatePath, { ...state, committedOffset: offset + length });
      return response("write", {});
    }
    if (command === "finalize") {
      return response("finalize", { sourceDigest: Uint8Array.from(Buffer.from(CHECKPOINT_DIGEST, "hex")) });
    }
    throw new Error(`unexpected manifest carrier command ${command}`);
  }
}

export function checkpoint(revision = 0, confirmedRanges = []) {
  return {
    formatVersion: 2,
    id: "non-hardware-conformance-resume",
    revision,
    manifestHash: "11".repeat(32),
    definitionHash: "22".repeat(32),
    modeId: "bootloader",
    direction: "hostToDevice",
    source: { algorithm: "sha256", digest: CHECKPOINT_DIGEST, byteLength: CHECKPOINT_BYTES.byteLength },
    identity: { stableKeyAssurance: "serial-number", stableKey: "serial:conformance", generation: "generation-7" },
    phase: "preparing",
    confirmedRanges,
    finalization: "repeatable",
  };
}

export function definition() {
  return {
    id: checkpoint().id,
    directions: {
      deviceToHost: null,
      hostToDevice: {
        preparation: [{ action: "prepare", maximumWaitMs: 1_000, destructive: true }],
        data: {
          action: "write", maximumWaitMs: 1_000, sourceOffset: 0, targetOffset: 0,
          length: CHECKPOINT_BYTES.byteLength,
          maximumChunkBytes: CHECKPOINT_CHUNK_BYTES,
          alignmentBytes: 1,
          maximumInFlight: CHECKPOINT_WINDOW_CHUNKS,
        },
        settlement: {
          kind: "range-window-report",
          selection: "window",
          maximumWaitMs: 1_000,
          maximumObservations: CHECKPOINT_BYTES.byteLength / CHECKPOINT_CHUNK_BYTES,
        },
        completion: [{ action: "finalize", maximumWaitMs: 1_000, destructive: true }],
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
        resume: {
          kind: "durable-reported-offset", reportedOffsetSelection: "committed-offset",
          maximumWaitMs: 1_000, sourceDigestAlgorithm: "sha256", finalization: "repeatable",
        },
      },
    },
  };
}

export class MemorySource {
  #offset = 0;
  byteLength = CHECKPOINT_BYTES.byteLength;
  async read(into) {
    const count = Math.min(into.byteLength, CHECKPOINT_BYTES.byteLength - this.#offset);
    into.set(CHECKPOINT_BYTES.subarray(this.#offset, this.#offset + count));
    this.#offset += count;
    return { bytesRead: count, eof: this.#offset === CHECKPOINT_BYTES.byteLength };
  }
  async seek(offset) { this.#offset = offset; }
  async close() {}
}

export class DigestProvider {
  create(algorithm) {
    const hash = createHash(algorithm);
    return { update: (bytes) => hash.update(bytes), digestHex: async () => hash.digest("hex") };
  }
}

export class WindowAdapter {
  pending = [];
  admitted = [];
  preparationActions = 0;
  completionActions = 0;
  verificationActions = 0;
  lifecycle = [];
  constructor(reportedSourceDigest = CHECKPOINT_DIGEST) {
    this.reportedSourceDigest = reportedSourceDigest;
  }
  async executeRecipeAction(_action, phase) {
    if (phase === "preparation") {
      this.preparationActions += 1;
      this.lifecycle.push("preparation");
    }
    if (phase === "completion") {
      this.completionActions += 1;
      this.lifecycle.push("completion");
    }
  }
  async readTarget() { throw new Error("non-hardware resume has no optimistic guard"); }
  async admit(action, sourceBytes, _signal, observeTransmitted) {
    if (!this.lifecycle.includes("transfer")) this.lifecycle.push("transfer");
    this.admitted.push(action.range.targetOffset);
    observeTransmitted(sourceBytes);
    this.pending.push({ action, sourceBytes: Uint8Array.from(sourceBytes) });
  }
  async nextSettlement(settlement) {
    const ranges = this.pending.splice(0, CHECKPOINT_WINDOW_CHUNKS).map(({ action, sourceBytes }) => ({
      actionId: action.id,
      range: action.range,
      sourceBytes,
      status: "confirmed",
    }));
    return { kind: settlement.kind, selection: settlement.selection, ranges };
  }
  binding(name) {
    if (name !== "source-sha256") throw new Error("unknown non-hardware verification binding");
    this.verificationActions += 1;
    this.lifecycle.push("verification");
    return Uint8Array.from(Buffer.from(this.reportedSourceDigest, "hex"));
  }
}
