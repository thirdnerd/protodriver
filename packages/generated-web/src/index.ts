import type { FixedSemanticUnitContract } from "@protodriver/contracts";
import {
  formatGeneratedHumanBase64Bytes,
  formatGeneratedHumanBytes,
  formatGeneratedHumanUnitValue,
  type AuthoredResultControl,
  type GeneratedResultValueModel,
} from "@protodriver/control-model";

export { collectAuthoredOutput } from "./authored-output.ts";
export { registerAuthoredFileArgument } from "./authored-input.ts";

export function renderAuthoredResult(model: AuthoredResultControl | null, value: unknown, path = "$.result"): string {
  if (model === null) return "";
  if (model.kind === "leaf") return escapeHtml(formatResultValue(model.value, value, path));
  if (model.kind === "array") {
    if (!Array.isArray(value)) throw new Error("authored result array required at " + path);
    return '<ol class="authored-result-array">' + value.map((item, i) => '<li>' + renderAuthoredResult(model.item, item, path + '[' + i + ']') + '</li>').join('') + '</ol>';
  }
  if (!isObjectRecord(value)) throw new Error("authored result record required at " + path);
  if (model.kind === "variant") {
    if (value.kind !== "variant" || typeof value.tag !== "string" || !Object.hasOwn(model.variants, value.tag)) throw new Error("undeclared authored variant");
    return '<section class="authored-result-variant"><h4>' + escapeHtml(label(value.tag)) + '</h4>' + renderAuthoredResult(model.variants[value.tag]!, value.value, path + '.' + value.tag) + '</section>';
  }
  return '<dl class="authored-result-record">' + Object.entries(model.fields).map(([key, child]) => '<dt>' + escapeHtml(label(key)) + '</dt><dd>' + renderAuthoredResult(child, value[key], path + '.' + key) + '</dd>').join('') + '</dl>';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function label(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}

function formatResultValue(model: GeneratedResultValueModel, value: unknown, path: string): string {
  if (value === undefined) return "Not observed";
  switch (model.kind) {
    case "scalar":
      return formatScalarWithUnit(value, model.unit, path);
    case "bytes":
      return formatBytes(value, path);
    case "member": {
      if (typeof value !== "string") return unrenderableValue(model.kind, path);
      const member = model.members.find(({ name }) => name === value);
      if (member === undefined) throw new Error(`browser renderer has no declared member ${JSON.stringify(value)} at ${path}`);
      return member.label ?? label(member.name);
    }
    case "flags": {
      const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : undefined;
      if (values === undefined || values.some((member) => typeof member !== "string")) return unrenderableValue(model.kind, path);
      if (values.length === 0) return "None";
      return values.map((name) => {
        const member = model.members.find((candidate) => candidate.name === name);
        if (member === undefined) throw new Error(`browser renderer has no declared flag ${JSON.stringify(name)} at ${path}`);
        return member.label ?? label(member.name);
      }).join(", ");
    }
    case "packed-bcd": {
      const tagged = taggedKind(value, path);
      if (tagged.kind === "value") return formatScalarWithUnit(tagged.value, model.unit, `${path}.value`);
      if (tagged.kind === "special" && typeof tagged.name === "string") {
        const special = model.specialValues.find(({ name }) => name === tagged.name);
        if (special === undefined) throw new Error(`browser renderer has no declared special value ${JSON.stringify(tagged.name)} at ${path}`);
        return special.label ?? label(special.name);
      }
      return unknownRendererKind("result value", path, tagged.kind);
    }
    case "variant": {
      const tagged = taggedKind(value, path);
      const variant = model.variants.find(({ name }) => name === tagged.kind);
      if (variant === undefined) return unknownRendererKind("result variant", path, tagged.kind);
      if (!("fields" in tagged) || !isObjectRecord(tagged.fields)) return unrenderableValue(model.kind, path);
      const fields = tagged.fields;
      const title = variant.label ?? label(variant.name);
      if (variant.fields.length === 0) return title;
      return `${title} — ${variant.fields.map((field) => (
        `${field.label ?? label(field.name)}: ${formatResultValue(field.value, fields[field.name], `${path}.fields.${field.name}`)}`
      )).join(", ")}`;
    }
  }
}

function formatScalar(value: unknown, path: string): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length === 0 ? "Empty text" : value;
  if (isObjectRecord(value) && "type" in value && "value" in value && typeof value.value === "string") {
    if (value.type === "u64" || value.type === "i64" || value.type === "decimal") return value.value;
    if (value.type === "bytes") {
      return formatGeneratedHumanUnitValue(String(base64ByteLength(value.value)), { kind: "fixed", id: "byte" });
    }
    return unknownRendererKind("public scalar", path, String(value.type));
  }
  if (isObjectRecord(value) && value.kind === "decimal" && typeof value.value === "number"
    && (value.suffix === null || typeof value.suffix === "string")) {
    return `${value.value}${value.suffix ?? ""}`;
  }
  if (isObjectRecord(value) && typeof value.kind === "string") {
    return unknownRendererKind("result value", path, value.kind);
  }
  return unrenderableValue("scalar", path);
}

function formatScalarWithUnit(
  value: unknown,
  unit: FixedSemanticUnitContract | null,
  path: string,
): string {
  if (unit === null) return formatScalar(value, path);
  const decimal = decimalValueText(value);
  if (decimal === null) return unrenderableValue("numeric scalar", path);
  return formatGeneratedHumanUnitValue(decimal, unit);
}

function decimalValueText(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return value.toString(10);
  if (isObjectRecord(value) && (value.type === "u64" || value.type === "i64" || value.type === "decimal")
    && typeof value.value === "string") return value.value;
  return null;
}

function formatBytes(value: unknown, path: string): string {
  if (value instanceof Uint8Array) {
    return formatGeneratedHumanBytes(value);
  }
  if (isObjectRecord(value) && value.type === "bytes" && value.encoding === "base64" && typeof value.value === "string") {
    return formatGeneratedHumanBase64Bytes(value.value);
  }
  return unrenderableValue("bytes", path);
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length === 0 ? 0 : value.length / 4 * 3 - padding;
}

function taggedKind(value: unknown, path: string): Readonly<Record<string, unknown>> & { readonly kind: string } {
  if (!isObjectRecord(value) || typeof value.kind !== "string") return unrenderableValue("tagged", path);
  return value as Readonly<Record<string, unknown>> & { readonly kind: string };
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function unrenderableValue(kind: string, path: string): never {
  throw new Error(`browser renderer cannot render ${kind} value at ${path}`);
}

function unknownRendererKind(subject: string, path: string, kind: string): never {
  throw new Error(`browser renderer has no ${subject} kind ${JSON.stringify(kind)} at ${path}`);
}
