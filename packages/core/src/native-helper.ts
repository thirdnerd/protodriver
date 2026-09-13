import { CanonicalSizeAccounting } from "./limits.ts";
import { RealClock } from "./clock.ts";
import type { Clock, Disposable } from "@protodriver/contracts";

// All three fields are validated safe integers: their canonical size is
// value-independent. Derive once; do not re-encode the same keys per ABI octet.
const bufferMetadataBytes = new CanonicalSizeAccounting().rpcMessageBytes({ id: 0, capacity: 0, usedLength: 0 });

export function nativeFault(code: string, message: string): Error {
  return Object.assign(new Error(message), { error: { code, message, retryability: "no" } });
}
export interface NativeHelperContext {
  /** Must precede each adapted native loop body, including nested loops. */
  iteration(): void;
  reserveBuffer(capacity: number, usedLength?: number): { release(): void };
  call(name: string): Promise<string | Uint8Array>;
  onRevoke(cancel: () => void): () => void;
}

/** A session aggregate, NOT one allowance per helper, task or allocation. */
export class NativeHelperData {
  readonly maximum: number;
  readonly #sizes = new CanonicalSizeAccounting();
  #resident = 8; // the shared reservation map's container
  #serial = 0;
  constructor(maximum = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximum) || maximum < 8) throw new RangeError("invalid native helper data policy");
    this.maximum = maximum;
  }
  reserve(capacity: number, usedLength = capacity): { release(): void } {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || !Number.isSafeInteger(usedLength)
      || usedLength < 0 || usedLength > capacity) throw nativeFault("retained.helper-buffer-invalid", "invalid bounded buffer capacity/length");
    const id = ++this.#serial;
    if (!Number.isSafeInteger(id)) throw nativeFault("retained.helper-data-exhausted", "helper allocation identity exhausted");
    // Allocated capacity, plus buffer/container and reservation bookkeeping.
    // No backing store is allocated merely to calculate its charge.
    const bytes = capacity + 8 + bufferMetadataBytes;
    return this.#hold(bytes);
  }
  /** Trusted adapter's bounded structural template (not arbitrary authored
   * input). Reserve a frame before starting its task, including peak scratch. */
  frame(record: object): { release(): void } {
    return this.#hold(this.#sizes.rpcMessageBytes(record));
  }
  #hold(bytes: number): { release(): void } {
    if (bytes > this.maximum - this.#resident) throw nativeFault("retained.helper-data-exhausted", "session native-helper data account exhausted before allocation");
    this.#resident += bytes;
    let live = true;
    return { release: () => { if (live) { live = false; this.#resident -= bytes; } } };
  }
}

export interface NativeHelperWorkerPort {
  post(value: unknown): void;
  subscribe(receive: (value: unknown) => void, failed: (cause: unknown) => void): () => void;
  terminate(): void | Promise<unknown>;
}
