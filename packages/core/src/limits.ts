import type {
  HostResourceLimits,
  PdrError,
  PlatformCauseSnapshot,
  PublicValue,
  SizeAccounting,
} from "@protodriver/contracts";
const encoder = new TextEncoder();
const SIZE_NODE_OVERHEAD = 8;

/** Runtime defaults mirror the normative type-only contracts package. */
export const DEFAULT_PHASE_ONE_LIMITS = Object.freeze({
  maximumBufferedBytesPerChannel: 4 * 1024 * 1024,
  maximumDiagnosticBufferBytes: 2 * 1024 * 1024,
  maximumRpcMessageBytes: 8 * 1024 * 1024,
  maximumPendingRpcCalls: 256,
  maximumSubscriptionsPerClient: 16,
  maximumConcurrentOperations: 32,
  maximumOpenResources: 64,
  maximumOutstandingBrokerCalls: 64,
  maximumResourceChunkBytes: 1024 * 1024,
  maximumCaptureParts: 4096,
} satisfies Pick<HostResourceLimits,
  | "maximumRpcMessageBytes"
  | "maximumBufferedBytesPerChannel"
  | "maximumDiagnosticBufferBytes"
  | "maximumPendingRpcCalls"
  | "maximumSubscriptionsPerClient"
  | "maximumConcurrentOperations"
  | "maximumOpenResources"
  | "maximumOutstandingBrokerCalls"
  | "maximumResourceChunkBytes"
  | "maximumCaptureParts"
>);

export class HostResourceLimitError extends Error {
  readonly error: PdrError;

  constructor(
    code: string,
    limit: keyof HostResourceLimits,
    maximum: number,
    observed: number,
    scope: "transport" | "rpc" | "resource" | "diagnostic" | "operation" | "capture",
  ) {
    const error: PdrError = {
      code,
      message: `${scope} exceeds ${limit}: observed ${observed}, maximum ${maximum}`,
      retryability: "no",
      details: { limit, maximum, observed, scope },
    };
    super(error.message);
    this.name = "HostResourceLimitError";
    this.error = error;
  }
}

function canonicalPublic(value: PublicValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPublic).join(",")}]`;
  const record = value as { readonly [key: string]: PublicValue };
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalPublic(record[key]!)}`).join(",")}}`;
}

interface SizeWalkAccount {
  iteration(): void;
  reserve(capacity: number): void;
  text(value: string): void;
}
function rpcBytes(value: object | string | number | bigint | boolean | null, meter?: SizeWalkAccount,
  replacement?: { map: Map<unknown, unknown>; key: unknown; value: unknown;
    entry?: (key: unknown, value: unknown, bytes: number) => void }): number {
  meter?.reserve(8);
  const active = new Set<object>();
  const visit = (item: object | string | number | bigint | boolean | null): number => {
    meter?.iteration();
    if (item === null || typeof item === "boolean") return SIZE_NODE_OVERHEAD;
    if (typeof item === "number" || typeof item === "bigint") {
      return SIZE_NODE_OVERHEAD + 8;
    }
    if (typeof item === "string") { meter?.text(item); return SIZE_NODE_OVERHEAD + encoder.encode(item).byteLength; }
    if (item instanceof ArrayBuffer) return SIZE_NODE_OVERHEAD + item.byteLength;
    if (ArrayBuffer.isView(item)) return SIZE_NODE_OVERHEAD + item.byteLength;
    if (active.has(item)) throw new TypeError("RPC size accounting does not accept cycles");
    meter?.reserve(16);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        return SIZE_NODE_OVERHEAD + item.reduce<number>((sum, member) =>
          sum + visit(member as object | string | number | bigint | boolean | null), 0);
      }
      if (item instanceof Set) {
        let total = SIZE_NODE_OVERHEAD;
        for (const member of item) {
          total += visit(member as object | string | number | bigint | boolean | null);
        }
        return total;
      }
      if (item instanceof Map) {
        let total = SIZE_NODE_OVERHEAD;
        let replaced = false;
        for (const [key, member] of item) {
          const keyBytes = visit(key as object | string | number | bigint | boolean | null);
          const selected = replacement?.map === item && replacement.key === key;
          if (selected) replaced = true;
          const value = selected ? replacement.value : member;
          const bytes = keyBytes + visit(value as object | string | number | bigint | boolean | null);
          total += bytes;
          if (replacement?.map === item) replacement.entry?.(key, value, bytes);
        }
        if (replacement?.map === item && !replaced) {
          const bytes = visit(replacement.key as object | string | number | bigint | boolean | null)
            + visit(replacement.value as object | string | number | bigint | boolean | null);
          total += bytes;
          replacement.entry?.(replacement.key, replacement.value, bytes);
        }
        return total;
      }
      let total = SIZE_NODE_OVERHEAD;
      // Reserve enumeration before Object.entries creates its pair population.
      if (meter) {
        let count = 0;
        for (const key in item) { meter.iteration(); if (Object.hasOwn(item, key)) count++; }
        meter.reserve(8 + count * 56);
      }
      for (const [key, member] of Object.entries(item)) {
        if (member === undefined) continue;
        if (typeof member === "function" || typeof member === "symbol") {
          throw new TypeError(`RPC size accounting cannot measure ${typeof member}`);
        }
        meter?.text(key); total += encoder.encode(key).byteLength;
        total += visit(member as object | string | number | bigint | boolean | null);
      }
      return total;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
}

/** One deterministic metric used before either direct calls or postMessage. */
export class CanonicalSizeAccounting implements SizeAccounting {
  publicValueBytes(value: PublicValue): number {
    return encoder.encode(canonicalPublic(value)).byteLength;
  }

  rpcMessageBytes<T>(message: T, meter?: SizeWalkAccount): number {
    if (message === undefined || typeof message === "function" || typeof message === "symbol") {
      throw new TypeError(`RPC size accounting cannot measure ${typeof message}`);
    }
    return rpcBytes(message as object | string | number | bigint | boolean | null, meter);
  }
  rpcMapEntryBytes<K, V>(map: Map<K, V>, key: K, value: V, meter?: SizeWalkAccount,
    entry?: (key: unknown, value: unknown, bytes: number) => void): number {
    return rpcBytes(map, meter, { map, key, value, ...(entry ? { entry } : {}) });
  }
}

const DEFAULT_CAUSE_DETAIL_KEYS = ["errno", "syscall", "address", "port", "path"] as const;

function publicDetail(value: object | string | number | boolean | null): PublicValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return undefined;
}

/**
 * Copies only named diagnostic fields. It never walks a native error, whose
 * graph may contain handles, cycles, functions, or host-private state.
 */
export function snapshotPlatformCause(
  cause: object | string,
  detailKeys: readonly string[] = DEFAULT_CAUSE_DETAIL_KEYS,
): PlatformCauseSnapshot {
  if (typeof cause === "string") return { typeName: "String", message: cause };
  const source = cause as {
    readonly constructor?: { readonly name?: string };
    readonly name?: string;
    readonly message?: string;
    readonly code?: string | number;
    readonly stack?: string;
    readonly [key: string]: object | string | number | boolean | null | undefined;
  };
  const serializableDetails: Record<string, PublicValue> = {};
  for (const key of detailKeys) {
    const detail = source[key];
    if (detail === undefined) continue;
    const value = publicDetail(detail);
    if (value !== undefined) serializableDetails[key] = value;
  }
  return {
    typeName: source.constructor?.name ?? "Object",
    ...(source.name === undefined ? {} : { name: source.name }),
    ...(source.message === undefined ? {} : { message: source.message }),
    ...(source.code === undefined ? {} : { code: source.code }),
    ...(source.stack === undefined ? {} : { stack: source.stack }),
    ...(Object.keys(serializableDetails).length === 0 ? {} : { serializableDetails }),
  };
}
