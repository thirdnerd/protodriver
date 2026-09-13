import type { AuthoredOperationArgument, AuthoredSourceArgument, AuthoredValueType, PublicValue } from "@protodriver/contracts";

/**
 * What kind of control an authored argument gets, and how its raw input
 * becomes a public value. Both halves live here rather than in the DOM
 * builder so the mapping can be tested without a browser.
 */
export type AuthoredArgumentField =
  | { readonly kind: "file"; readonly minimumBytes: number; readonly maximumBytes: number }
  | { readonly kind: "checkbox" }
  | { readonly kind: "select"; readonly members: readonly string[] }
  | { readonly kind: "flags"; readonly members: readonly string[] }
  | { readonly kind: "number"; readonly step: "1" | "any"; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: "text"; readonly placeholder?: string; readonly minimumLength?: number; readonly maximumLength?: number };

export type AuthoredArgumentInput = string | boolean | readonly string[];

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export interface AuthoredArgumentControl {
  readonly kind: "file" | "value";
  readonly type?: AuthoredValueType;
  readonly minimumBytes?: number;
  readonly maximumBytes?: number;
  readonly label?: string;
  readonly description?: string;
}

const SOURCE_KINDS: ReadonlySet<string> = new Set(["byte-source", "stream-source"]);

/** The declaration already carries the label and prose; the only thing
 * needing a decision is whether it names a file or a value. */
export function authoredArgumentControl(declaration: AuthoredOperationArgument): AuthoredArgumentControl {
  const shared = {
    ...(declaration.label === undefined ? {} : { label: declaration.label }),
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
  };
  if (SOURCE_KINDS.has(declaration.kind)) {
    const source = declaration as AuthoredSourceArgument;
    return { kind: "file", minimumBytes: source.minimumBytes, maximumBytes: source.maximumBytes, ...shared };
  }
  return { kind: "value", type: declaration as AuthoredValueType, ...shared };
}

export function authoredArgumentField(control: AuthoredArgumentControl): AuthoredArgumentField {
  if (control.kind === "file") {
    return {
      kind: "file",
      minimumBytes: control.minimumBytes ?? 0,
      maximumBytes: control.maximumBytes ?? Number.MAX_SAFE_INTEGER,
    };
  }
  const type = control.type;
  if (type === undefined) throw new Error("a value argument declared no type");
  switch (type.kind) {
    case "boolean":
      return { kind: "checkbox" };
    case "enum":
      return { kind: "select", members: type.members ?? [] };
    case "flags":
      return { kind: "flags", members: [...(type.members ?? [])].sort() };
    case "integer":
      // A 64-bit field can carry more than a number input can hold exactly,
      // so it is typed as digits and sent as a tagged integer.
      if (type.widthBits === 64) return { kind: "text", placeholder: "whole number" };
      return {
        kind: "number",
        step: "1",
        ...(type.minimum === undefined ? {} : { minimum: type.minimum }),
        ...(type.maximum === undefined ? {} : { maximum: type.maximum }),
      };
    case "float":
      return {
        kind: "number",
        step: "any",
        ...(type.minimum === undefined ? {} : { minimum: type.minimum }),
        ...(type.maximum === undefined ? {} : { maximum: type.maximum }),
      };
    case "decimal":
      return { kind: "text", placeholder: "21.50" };
    case "bytes":
      return { kind: "text", placeholder: "41 54 0d 0a" };
    case "string":
      return {
        kind: "text",
        ...(type.minimumLength === undefined ? {} : { minimumLength: type.minimumLength }),
        ...(type.maximumLength === undefined ? {} : { maximumLength: type.maximumLength }),
      };
    default:
      return { kind: "text", placeholder: `JSON ${type.kind}` };
  }
}

/** One line under the control saying what it will accept. */
export function authoredArgumentHint(control: AuthoredArgumentControl): string | undefined {
  if (control.kind === "file") {
    const maximum = control.maximumBytes;
    if (maximum === undefined || maximum >= Number.MAX_SAFE_INTEGER) return undefined;
    return `${(control.minimumBytes ?? 0).toLocaleString()} to ${maximum.toLocaleString()} bytes.`;
  }
  const type = control.type;
  if (type === undefined) return undefined;
  switch (type.kind) {
    case "integer":
      if (type.minimum !== undefined && type.maximum !== undefined) {
        return `Whole number, ${type.minimum.toLocaleString()} to ${type.maximum.toLocaleString()}.`;
      }
      return type.widthBits === 64 ? "Whole number, up to 64 bits." : "Whole number.";
    case "decimal":
      return "Exact decimal, written the way the device states it.";
    case "bytes":
      return "Hexadecimal bytes, spaces optional.";
    case "string":
      if (type.maximumLength !== undefined) return `Text, up to ${type.maximumLength} characters.`;
      return undefined;
    case "flags":
      return "Choose any combination.";
    case "boolean":
    case "enum":
    case "float":
      return undefined;
    default:
      return `A JSON ${type.kind}, exactly as the device declares it.`;
  }
}

export function authoredArgumentValue(
  control: AuthoredArgumentControl,
  raw: AuthoredArgumentInput,
): PublicValue {
  const type = control.type;
  if (control.kind === "file" || type === undefined) {
    throw new Error("a file argument carries no public value");
  }
  switch (type.kind) {
    case "boolean":
      if (typeof raw !== "boolean") throw new Error("expected a checked state");
      return raw;
    case "flags": {
      if (!Array.isArray(raw)) throw new Error("expected the chosen flag names");
      return Object.freeze([...(raw as readonly string[])].sort());
    }
    case "enum":
      return requireChosen(raw);
    case "string":
      return requireText(raw);
    case "integer":
      return publicInteger(requireText(raw).trim(), type);
    case "float": {
      // Number("") is 0, so an empty field would otherwise send a zero the
      // person never typed.
      const value = Number(requireChosen(raw));
      if (!Number.isFinite(value)) throw new Error("expected a finite number");
      return value;
    }
    case "decimal": {
      const text = requireText(raw).trim();
      if (!/^-?\d+(?:\.\d+)?$/u.test(text)) throw new Error("expected a decimal such as 21.50");
      return { type: "decimal", value: text };
    }
    case "bytes":
      return { type: "bytes", encoding: "base64", value: encodeBase64(parseHexBytes(requireText(raw))) };
    default: {
      const text = requireText(raw).trim();
      try {
        return JSON.parse(text) as PublicValue;
      } catch {
        throw new Error(`expected a JSON ${type.kind}`);
      }
    }
  }
}

function requireText(raw: AuthoredArgumentInput): string {
  if (typeof raw !== "string") throw new Error("expected typed text");
  return raw;
}

function requireChosen(raw: AuthoredArgumentInput): string {
  const text = requireText(raw).trim();
  if (text.length === 0) throw new Error("expected a value");
  return text;
}

function publicInteger(text: string, type: AuthoredValueType): PublicValue {
  if (!/^-?\d+$/u.test(text)) throw new Error("expected a whole number");
  const value = BigInt(text);
  if (value >= -MAX_SAFE && value <= MAX_SAFE) return Number(value);
  return { type: type.signed === true ? "i64" : "u64", value: value.toString(10) };
}

export function parseHexBytes(text: string): Uint8Array {
  const digits = text.replace(/[\s_:]+/gu, "");
  if (digits.length % 2 !== 0) throw new Error("expected an even number of hex digits");
  if (digits.length > 0 && !/^[0-9a-fA-F]+$/u.test(digits)) throw new Error("expected hexadecimal digits");
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Canonical padded base64, matching what the value codec will accept back. */
export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!, b = bytes[index + 1], c = bytes[index + 2];
    output += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    output += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    output += c === undefined ? "=" : BASE64[c & 63]!;
  }
  return output;
}
