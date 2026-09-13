import { luaResourceError } from "./resource-policy.ts";

/** Structural port: the composition root supplies the SAME session aggregate
 * as its native helpers. Standalone VM callers receive the identical default. */
export interface NativeDataAccount {
  reserve(capacity: number, usedLength?: number): { release(): void };
}
export class StandaloneNativeData implements NativeDataAccount {
  #resident = 8;
  #serial = 0;
  reserve(capacity: number, usedLength = capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 0 || !Number.isSafeInteger(usedLength)
      || usedLength < 0 || usedLength > capacity) throw new RangeError("invalid native reservation");
    // CanonicalSizeAccounting({id,capacity,usedLength}) = 76, plus buffer = 8.
    // This port avoids a dependency from the VM back to the session adapter.
    const bytes = capacity + 84;
    if (!Number.isSafeInteger(++this.#serial) || bytes > 16 * 1024 * 1024 - this.#resident)
      throw luaResourceError("retained.helper-data-exhausted", "native data exhausted before allocation");
    this.#resident += bytes;
    let live = true;
    return { release: () => { if (live) { live = false; this.#resident -= bytes; } } };
  }
}

/** A synchronous boundary's scratch lifetime. Every caller uses the current
 * activation's charger; creating another scope cannot create another grant. */
export class NativeScratch {
  readonly #data: NativeDataAccount;
  readonly #charge: (units: number) => void;
  readonly #held: Array<{ release(): void }> = [];
  readonly owner: string | undefined;
  constructor(data: NativeDataAccount, charge: (units: number) => void, owner?: string) {
    this.#data = data; this.#charge = charge; this.owner = owner;
  }
  get dataAccount(): NativeDataAccount { return this.#data; }
  iteration = (): void => { this.#charge(1); };
  work(units: number): void {
    if (!Number.isSafeInteger(units) || units < 0) throw new RangeError("invalid native work charge");
    if (units === 0) return;
    this.#charge(units);
  }
  reserve(capacity: number): void { this.#held.push(this.#data.reserve(capacity)); }
  /** A component may release its own intermediates at last use. The parent
   * remains a refusal/unwind backstop if construction never reaches finish. */
  child(): NativeScratch {
    // The child object and unwind closure remain reachable from this parent
    // even if its payload reservations have already been released.
    this.reserve(128);
    const child = new NativeScratch(this.#data, this.#charge, this.owner);
    this.#held.push({ release: () => child.close() });
    return child;
  }
  /** Reserve append storage before its allocation, not after a size walk.
   * Canonical structural convention: container 8, scalar/entry 8+payload. */
  node(bytes = 8): void { this.iteration(); this.reserve(bytes); }
  text(value: string): void {
    // UTF-8 encoding is bounded by three octets per UTF-16 code unit. Reserve
    // before asking TextEncoder/regex/BigInt to allocate or scan its input.
    this.reserve(8 + value.length * 3);
    this.work(1 + Math.ceil(value.length / 256));
  }
  /** A size walk borrows engine temporaries; it does not transfer their
   * lifetime to the value being sized. Keep the same work/data accounts. */
  transient<T>(run: (scratch: NativeScratch) => T): T {
    const scratch = new NativeScratch(this.#data, this.#charge, this.owner);
    try { return withNativeScratch(scratch, () => run(scratch)); }
    finally { scratch.close(); }
  }
  close(): void { for (const held of this.#held) held.release(); this.#held.length = 0; }
}

// Only synchronous adapter functions run in this scope. Restoring it in a
// finally (also on refusal) prevents another activation from inheriting it.
// No async continuation is permitted to use an ambient accounting context.
let current: NativeScratch | undefined;
export function activeNativeScratch(): NativeScratch | undefined { return current; }
export function withNativeScratch<T>(scratch: NativeScratch, run: () => T): T {
  const previous = current; current = scratch;
  try {
    const result = run();
    if (result && typeof result === "object" && "then" in result)
      throw new Error("native accounting scope cannot cross an asynchronous boundary");
    return result;
  } finally { current = previous; }
}

function population(value: object): number {
  let count = 0;
  for (const key in value) {
    current?.iteration();
    if (Object.hasOwn(value, key)) count++;
  }
  return count;
}
export function nativeKeys(value: object): string[] {
  const count = current ? population(value) : 0;
  current?.work(count); current?.reserve(8 + count * 16);
  return Object.keys(value);
}
export function nativeEntries<T>(value: { [key: string]: T } | ArrayLike<T>): [string, T][];
export function nativeEntries(value: object): [string, any][];
export function nativeEntries(value: object): [string, any][] {
  const count = current ? population(value) : 0;
  current?.work(count); current?.reserve(8 + count * 56);
  return Object.entries(value);
}
export function nativeValues<T>(value: { [key: string]: T } | ArrayLike<T>): T[];
export function nativeValues(value: object): any[];
export function nativeValues(value: object): any[] {
  const count = current ? population(value) : 0;
  current?.work(count); current?.reserve(8 + count * 16);
  return Object.values(value);
}
export function nativeRecord<T>(entries: Iterable<readonly [PropertyKey, T]>): { [key: string]: T } {
  current?.reserve(8);
  function* accounted() {
    for (const entry of entries) {
      current?.iteration();
      current?.reserve(16 + (typeof entry[0] === "string" ? entry[0].length * 3 : 8));
      yield entry;
    }
  }
  return Object.fromEntries(accounted());
}
export function nativeArray<T extends { readonly length: number } | undefined>(value: T): T {
  if (!current || value === undefined) return value;
  const scope = current;
  // Instrument the existing native method, not a replacement traversal.
  // In particular some/every charge only visited elements, not the tail they
  // never examine, and do not pretend to allocate an output array.
  scope.reserve(88); // proxy/adapter frame with target, method and scope references
  return new Proxy(value, {
    get(target, key) {
      const method = Reflect.get(target, key, target);
      if (typeof method !== "function") return method;
      if (!["map", "filter", "flatMap", "reduce", "forEach", "some", "every", "find", "findIndex"].includes(String(key)))
        return method.bind(target);
      return (callback: (...args: unknown[]) => unknown, ...rest: unknown[]) => {
        if (key === "map" || key === "filter") scope.reserve(8 + target.length * 16);
        if (key === "flatMap") scope.reserve(8);
        return method.call(target, function(this: unknown, ...args: unknown[]) {
          scope.iteration();
          const result = callback.apply(this, args);
          if (key === "flatMap") {
            const length = Array.isArray(result) ? result.length : 1;
            scope.reserve(length * 16); scope.work(1 + Math.ceil(length / 256));
          }
          return result;
        }, ...rest);
      };
    },
  });
}
export function nativeSort<T>(value: T[], compare?: (a: T, b: T) => number): T[] {
  current?.reserve(8 + value.length * 16); // native sort's bounded scratch
  value.sort((a, b) => {
    current?.iteration();
    if (typeof a === "string") current?.work(1 + Math.ceil(a.length / 256));
    if (typeof b === "string") current?.work(1 + Math.ceil(b.length / 256));
    if (compare) return compare(a, b);
    const left = String(a), right = String(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  // Preserve an instrumented array's wrapper for a following map/filter.
  return value;
}

/** Reserve a bounded structural copy before a native engine primitive which
 * does not expose its iterations (JSON, structured clone, codecs). This walk
 * is itself metered. It does not replace or optimize the primitive. */
export function nativeValue<T>(value: T): T {
  if (!current) return value;
  const seen = new Set<object>(); current.reserve(8);
  const visit = (v: unknown): void => {
    current!.node(24);
    if (typeof v === "string") { current!.text(v); return; }
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      current!.reserve(8 + v.byteLength); current!.work(1 + Math.ceil(v.byteLength / 256)); return;
    }
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) throw new TypeError("native structural copy does not accept cycles");
    seen.add(v);
    try {
      if (v instanceof Map) {
        for (const [key, item] of v) { visit(key); visit(item); }
      } else if (v instanceof Set) {
        for (const item of v) visit(item);
      } else if (Array.isArray(v)) for (const item of nativeArray(v)) visit(item);
      else for (const [key, item] of nativeEntries(v)) { current!.text(key); visit(item); }
    } finally { seen.delete(v); }
  };
  visit(value); return value;
}
export function nativeJson(value: unknown): string | undefined {
  if (!current) return JSON.stringify(value);
  let capacity = 8;
  const seen = new Set<object>(); current.reserve(8);
  const visit = (v: unknown): void => {
    current!.iteration();
    if (typeof v === "string") { capacity += 2 + v.length * 6; return; }
    capacity += 32;
    if (!v || typeof v !== "object") return;
    if (seen.has(v)) throw new TypeError("native JSON does not accept cycles");
    seen.add(v);
    try {
      if (Array.isArray(v)) for (const item of nativeArray(v)) visit(item);
      else for (const [key, item] of nativeEntries(v)) { visit(key); visit(item); }
    } finally { seen.delete(v); }
  };
  visit(value); current.reserve(capacity); current.work(1 + Math.ceil(capacity / 256));
  return JSON.stringify(value);
}
export function nativeEncode(value: string | undefined): Uint8Array {
  if (value !== undefined) current?.text(value);
  return new TextEncoder().encode(value);
}
