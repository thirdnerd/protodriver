export { generateAuthoredControlModel, generateAuthoredResultControl, requireAuthoredOutput, authoredStateLabel, type AuthoredResultControl } from "./authored.ts";
import type { FixedSemanticUnitContract } from "@protodriver/contracts";
import {
  divideExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from "./exact-decimal.ts";

export interface GeneratedNamedChoice {
  readonly name: string;
  readonly label?: string;
}

export interface GeneratedResultScalarValueModel {
  readonly kind: "scalar";
  /** The decoder has already applied the field's declared affine scale. */
  readonly unit: FixedSemanticUnitContract | null;
}

export interface GeneratedResultBytesValueModel {
  readonly kind: "bytes";
}

export interface GeneratedResultMemberValueModel {
  readonly kind: "member";
  readonly members: readonly GeneratedNamedChoice[];
}

export interface GeneratedResultFlagsValueModel {
  readonly kind: "flags";
  readonly members: readonly GeneratedNamedChoice[];
}

export interface GeneratedResultPackedBcdValueModel {
  readonly kind: "packed-bcd";
  readonly unit: FixedSemanticUnitContract | null;
  readonly specialValues: readonly GeneratedNamedChoice[];
}

export interface GeneratedResultVariantFieldModel {
  readonly name: string;
  readonly label?: string;
  readonly value: GeneratedResultValueModel;
}

export interface GeneratedResultVariantModel {
  readonly name: string;
  readonly label?: string;
  readonly fields: readonly GeneratedResultVariantFieldModel[];
}

export interface GeneratedResultVariantValueModel {
  readonly kind: "variant";
  readonly variants: readonly GeneratedResultVariantModel[];
}

/** Declaration-derived semantics for one projected runtime value. */
export type GeneratedResultValueModel =
  | GeneratedResultScalarValueModel
  | GeneratedResultBytesValueModel
  | GeneratedResultMemberValueModel
  | GeneratedResultFlagsValueModel
  | GeneratedResultPackedBcdValueModel
  | GeneratedResultVariantValueModel;

export function stringifyGeneratedPublicJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown): unknown => {
    if (member instanceof Uint8Array) {
      return { type: "bytes", encoding: "base64", value: base64(member) };
    }
    if (typeof member === "bigint") {
      return { type: member < 0n ? "i64" : "u64", value: member.toString(10) };
    }
    if (member instanceof Set) return [...member].sort();
    return member;
  });
}

interface HumanUnitScale {
  readonly divisor: bigint;
  readonly unit: string;
}

/** Exact human rendering for the closed fixed-unit vocabulary. */
export function formatGeneratedHumanUnitValue(
  decimalValue: string,
  unit: FixedSemanticUnitContract,
): string {
  const parsed = parseExactDecimal(decimalValue);
  if (parsed === null) return `${decimalValue} ${unit.id}`;
  const scale = humanUnitScale(parsed, unit.id);
  const scaled = divideExactDecimal(parsed, scale.divisor);
  return `${scaled} ${scale.unit}`;
}

const MAXIMUM_INLINE_RESULT_BYTES = 8;

/** Short opaque results expose their octets; longer values expose exact extent. */
export function formatGeneratedHumanBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_INLINE_RESULT_BYTES) {
    return formatGeneratedHumanUnitValue(String(bytes.byteLength), { kind: "fixed", id: "byte" });
  }
  return `hex ${[...bytes].map((octet) => octet.toString(16).padStart(2, "0")).join(" ")}`;
}

/** The tagged public-value form follows the same presentation rule. */
export function formatGeneratedHumanBase64Bytes(value: string): string {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = value.length === 0 ? 0 : value.length / 4 * 3 - padding;
  if (byteLength === 0 || byteLength > MAXIMUM_INLINE_RESULT_BYTES) {
    return formatGeneratedHumanUnitValue(String(byteLength), { kind: "fixed", id: "byte" });
  }
  const decoded = atob(value);
  return formatGeneratedHumanBytes(Uint8Array.from(decoded, (member) => member.charCodeAt(0)));
}

function humanUnitScale(
  value: ExactDecimal,
  unit: FixedSemanticUnitContract["id"],
): HumanUnitScale {
  switch (unit) {
    case "centidegree-celsius": return { divisor: 100n, unit: "°C" };
    case "millivolt": return { divisor: 1_000n, unit: "V" };
    case "tenth-hertz": return { divisor: 10n, unit: "Hz" };
    case "microsecond": return { divisor: 1_000_000n, unit: "s" };
    case "millisecond": return { divisor: 1_000n, unit: "s" };
    case "hertz": return largestMagnitudeScale(value, [
      { divisor: 1_000_000_000_000_000_000n, unit: "EHz" },
      { divisor: 1_000_000_000_000_000n, unit: "PHz" },
      { divisor: 1_000_000_000_000n, unit: "THz" },
      { divisor: 1_000_000_000n, unit: "GHz" },
      { divisor: 1_000_000n, unit: "MHz" },
      { divisor: 1_000n, unit: "kHz" },
      { divisor: 1n, unit: "Hz" },
    ]);
    case "byte": return largestMagnitudeScale(value, [
      { divisor: 1_152_921_504_606_846_976n, unit: "EiB" },
      { divisor: 1_125_899_906_842_624n, unit: "PiB" },
      { divisor: 1_099_511_627_776n, unit: "TiB" },
      { divisor: 1_073_741_824n, unit: "GiB" },
      { divisor: 1_048_576n, unit: "MiB" },
      { divisor: 1_024n, unit: "KiB" },
      { divisor: 1n, unit: "B" },
    ]);
  }
}

function largestMagnitudeScale(
  value: ExactDecimal,
  scales: readonly HumanUnitScale[],
): HumanUnitScale {
  const magnitude = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const denominator = 10n ** BigInt(value.decimalPlaces);
  return scales.find(({ divisor }) => magnitude >= divisor * denominator) ?? scales[scales.length - 1]!;
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    encoded += alphabet[first >> 2]!;
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!;
    encoded += second === undefined ? "=" : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!;
    encoded += third === undefined ? "=" : alphabet[third & 0x3f]!;
  }
  return encoded;
}
