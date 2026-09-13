import type { PublicValue } from "./values.js";

/**
 * How a byte limit is MEASURED.
 *
 * `maximumRpcMessageBytes` needs a shared measure: `postMessage` does not
 * expose its structured-clone size, while the Node direct adapter performs no
 * serialization. Without a canonical function the two adapters would enforce
 * different RPC limits over the same value.
 *
 * The accounting does not need to approximate real memory. It needs to be
 * deterministic and identical on both adapters.
 */
export interface SizeAccounting {
  /**
   * UTF-8 byte length of the value's CANONICAL JSON form.
   *
   * Canonical because `{"a":1,"b":2}` and `{"b":2,"a":1}` must measure the
   * same, and because the public model is defined in terms of JSON anyway.
   * Tagged scalars measure as the object they are, not as the
   * number they represent.
   */
  publicValueBytes(value: PublicValue): number;

  /**
   * Recursive deterministic cost model over an RPC message:
   *
   *   null / boolean            NODE_OVERHEAD
   *   number / bigint           NODE_OVERHEAD + 8
   *   string                    NODE_OVERHEAD + utf8ByteLength
   *   ArrayBuffer / TypedArray  NODE_OVERHEAD + byteLength
   *   array                     NODE_OVERHEAD + sum(elements)
   *   object                    NODE_OVERHEAD + sum(keyBytes + valueBytes)
   *   Set / Map                 NODE_OVERHEAD + sum(members)
   *
   * The overhead constant exists so that a message of ten thousand empty
   * objects has a size — without it, cardinality attacks measure as zero.
   *
   * Generic rather than `unknown`: the package forbids `unknown` in a
   * public signature, and every wire message is already proven clone-safe
   * by wire-guard.ts, so restating a value domain here would duplicate a
   * constraint that is enforced better elsewhere.
   */
  rpcMessageBytes<T>(message: T): number;
}

/**
 * Fixed per-node cost. A round number chosen to be defensible rather than
 * accurate: the goal is that both adapters agree, not that either predicts
 * heap usage.
 */
export const SIZE_NODE_OVERHEAD = 8;
