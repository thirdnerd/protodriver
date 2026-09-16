import type { AuthoredOperation, AuthoredSourceArgument, AuthoredValueType, PublicValue } from "@protodriver/contracts";

export interface EffectiveSourceRange { readonly offset: number; readonly length: number }
type Selector = number | { readonly argument: string };
/** Description admission has already checked these scalar bounds. */
export function maximumTransferSourceLength(op: AuthoredOperation): number {
  const t = op.transfer!, source = op.arguments[t.sourceArgument] as AuthoredSourceArgument;
  if (!t.sourceRange) return source.maximumBytes;
  const bound = (s: Selector, key: "minimum" | "maximum") => typeof s === "number" ? s : (op.arguments[s.argument] as AuthoredValueType)[key]!;
  const { offset, length } = t.sourceRange;
  if (typeof offset !== "number" && typeof length !== "number" && offset.argument === length.argument)
    return Math.min(bound(length, "maximum"), Math.floor(source.maximumBytes / 2));
  return Math.min(bound(t.sourceRange.length, "maximum"), source.maximumBytes - bound(t.sourceRange.offset, "minimum"));
}
export function resolveTransferSourceRange(op: AuthoredOperation, values: Readonly<Record<string, PublicValue>>,
  descriptorLength?: number): EffectiveSourceRange | undefined {
  const selected = op.transfer?.sourceRange;
  if (!selected) return undefined;
  const value = (s: Selector): number => {
    if (typeof s === "number") return s;
    const v = values[s.argument];
    return typeof v === "number" ? v : Number((v as { value?: string } | undefined)?.value);
  };
  const range = { offset: value(selected.offset), length: value(selected.length) };
  validateEffectiveSourceRange(range, descriptorLength);
  return range;
}
export function validateEffectiveSourceRange(range: EffectiveSourceRange, descriptorLength?: number): void {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 1
    || !Number.isSafeInteger(range.offset + range.length) || (descriptorLength !== undefined && range.offset + range.length > descriptorLength))
    throw Object.assign(new Error("effective source range is outside the admitted descriptor"),
      { error: { code: "authored.transfer.source-range", message: "effective source range is outside the admitted descriptor", responsibility: "invocation", retryability: "no" } });
}
