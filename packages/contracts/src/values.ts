/**
 * The public value model. Stable, documented, used by `--json`, generated
 * documentation, and every external API.
 *
 * Claim this must keep: PublicValue is a LOSSLESS encoding of every value
 * the runtime can produce at a boundary. Anything that cannot round-trip
 * through it is rejected at conversion rather than silently degraded.
 */
export type PublicValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicValue[]
  | { readonly [key: string]: PublicValue }
  | PublicTaggedScalar;

export type PublicTaggedScalar =
  | { readonly type: "u64"; readonly value: string }
  | { readonly type: "i64"; readonly value: string }
  | { readonly type: "decimal"; readonly value: string }
  | { readonly type: "bytes"; readonly encoding: "base64"; readonly value: string };

/**
 * Rejected at the public boundary rather than represented.
 *
 * NaN, ±Infinity and negative zero are not device values a caller can act
 * on, and JSON cannot carry them. A protocol field that decodes to one of
 * them produces a state cell with quality "invalid" or an operation failure
 * with `value.not-representable` — never a silent null, which would be
 * indistinguishable from a legitimately absent field.
 *
 * ENCODING IS TYPE-DIRECTED. The declared field type decides, never the
 * value's magnitude:
 *
 *   integer field   within +/-(2^53 - 1) -> number; larger -> u64/i64
 *   float field     ANY finite value -> number, including 1e100 and
 *                   1.7976931348623157e308. Number.MAX_SAFE_INTEGER bounds
 *                   exact INTEGER identity and says nothing about the
 *                   magnitude of a finite double.
 *   decimal field   always tagged
 *
 * An exact decimal that binary floating point cannot represent is carried
 * as {type:"decimal"}, because ranges, step sizes and scale factors are
 * declared exactly and rounding them at the boundary would make a declared
 * maximum of 30.00 fail its own comparison.
 */
export const NOT_REPRESENTABLE = "value.not-representable" as const;

/**
 * Structured-clone-safe. Internal values minus anything a clone cannot
 * carry. Resources never appear here; they cross as identifiers.
 */
export type RpcValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | ReadonlySet<string>
  | readonly RpcValue[]
  | { readonly [key: string]: RpcValue };

/**
 * Opaque to this package; each layer knows its own optimized form.
 *
 * This is the ONE sanctioned `unknown` in the package. ValueCodec is not an
 * RPC interface — it is the thing that converts into and out of the RPC
 * layer, so it is inherently generic over the runtime's representation. The
 * no-`unknown` rule exists to stop accidental `unknown` reaching a boundary;
 * this one never crosses one.
 */
export type InternalValue = unknown;

/** Enough type information to convert without guessing from shape. */
export interface TypeDescriptor {
  readonly kind:
    | "boolean"
    | "integer"
    | "float"
    | "decimal"
    | "string"
    | "bytes"
    | "enum"
    | "flags"
    | "array"
    | "record";
  readonly widthBits?: 8 | 16 | 32 | 64;
  readonly signed?: boolean;
  readonly members?: readonly string[];
  readonly item?: TypeDescriptor;
  readonly fields?: { readonly [key: string]: TypeDescriptor };
}

export interface ValueCodec {
  toPublic(value: InternalValue, type: TypeDescriptor): PublicValue;
  fromPublic(value: PublicValue, type: TypeDescriptor): InternalValue;
  toRpc(value: InternalValue, type: TypeDescriptor): RpcValue;
  fromRpc(value: RpcValue, type: TypeDescriptor): InternalValue;
}

/**
 * A platform error cannot cross a boundary verbatim: it may be a
 * DOMException, hold a live handle, or be cyclic. `serializableDetails` is
 * populated from a per-platform allowlist, never by walking the object.
 */
export interface PlatformCauseSnapshot {
  readonly typeName: string;
  readonly name?: string;
  readonly message?: string;
  readonly code?: string | number;
  readonly stack?: string;
  readonly serializableDetails?: { readonly [key: string]: PublicValue };
}

export type Retryability = "no" | "after-reconnect" | "after-recovery" | "unknown";

/**
 * One envelope for every error crossing a boundary.
 *
 * `retryability` is carried rather than derived from `code` because the
 * same code means different things under different session states, and a
 * caller deciding whether to retry should not be parsing strings.
 *
 * Captures, RPC, and CLI exit codes all depend on this shape.
 */
export interface PdrError {
  readonly code: string;
  readonly message: string;
  readonly details?: PublicValue;
  readonly retryability: Retryability;
  readonly platformCause?: PlatformCauseSnapshot;
}
