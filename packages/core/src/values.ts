import type {
  InternalValue,
  PublicValue,
  RpcValue,
  TypeDescriptor,
  ValueCodec,
} from "@protodriver/contracts";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class ValueCodecError extends TypeError {
  readonly code = "value.not-representable";

  constructor(message: string) {
    super(message);
    this.name = "ValueCodecError";
  }
}

export class DefaultValueCodec implements ValueCodec {
  toPublic(value: InternalValue, type: TypeDescriptor): PublicValue {
    return convertToPublic(value, type, "value");
  }

  fromPublic(value: PublicValue, type: TypeDescriptor): InternalValue {
    return convertFromPublic(value, type, "value");
  }

  toRpc(value: InternalValue, type: TypeDescriptor): RpcValue {
    return convertToRpc(value, type, "value");
  }

  fromRpc(value: RpcValue, type: TypeDescriptor): InternalValue {
    return convertFromRpc(value, type, "value");
  }
}

function fail(path: string, message: string): never {
  throw new ValueCodecError(`${path}: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || value instanceof Uint8Array || value instanceof Set) {
    fail(path, "expected a record");
  }
  return value as Record<string, unknown>;
}

function fields(type: TypeDescriptor, path: string): Readonly<Record<string, TypeDescriptor>> {
  if (type.fields === undefined) fail(path, "record descriptor has no fields");
  return type.fields;
}

function item(type: TypeDescriptor, path: string): TypeDescriptor {
  if (type.item === undefined) fail(path, "array descriptor has no item type");
  return type.item;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  declared: Readonly<Record<string, TypeDescriptor>>,
  path: string,
): void {
  for (const name of Object.keys(value)) {
    if (!(name in declared)) fail(`${path}.${name}`, "field is not declared");
  }
  for (const name of Object.keys(declared)) {
    if (!(name in value)) fail(`${path}.${name}`, "field is missing");
  }
}

function requireTagKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length
      || keys.some((key, index) => key !== canonical[index])) {
    fail(path, `expected exactly the tag fields ${canonical.join(", ")}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a string");
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function requireFinite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    fail(path, "expected a finite number other than negative zero");
  }
  return value;
}

function integerBounds(type: TypeDescriptor, path: string): {
  readonly bits: 8 | 16 | 32 | 64;
  readonly signed: boolean;
  readonly minimum: bigint;
  readonly maximum: bigint;
} {
  const bits = type.widthBits;
  if (bits === undefined) fail(path, "integer descriptor has no widthBits");
  const signed = type.signed ?? false;
  const width = BigInt(bits);
  return signed
    ? { bits, signed, minimum: -(1n << (width - 1n)), maximum: (1n << (width - 1n)) - 1n }
    : { bits, signed, minimum: 0n, maximum: (1n << width) - 1n };
}

function requireInteger(value: unknown, type: TypeDescriptor, path: string): bigint {
  let integer: bigint;
  if (typeof value === "bigint") {
    integer = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    integer = BigInt(value);
  } else {
    fail(path, "expected an exact integer represented as bigint or a safe number");
  }
  const bounds = integerBounds(type, path);
  if (integer < bounds.minimum || integer > bounds.maximum) {
    fail(path, `integer is outside ${bounds.signed ? "i" : "u"}${bounds.bits}`);
  }
  return integer;
}

function internalInteger(integer: bigint, type: TypeDescriptor, path: string): bigint | number {
  const { bits } = integerBounds(type, path);
  return bits === 64 ? integer : Number(integer);
}

function canonicalInteger(value: string, signed: boolean, path: string): bigint {
  const pattern = signed ? /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/;
  if (!pattern.test(value)) fail(path, "integer tag is not canonical decimal");
  return BigInt(value);
}

function requireMembers(type: TypeDescriptor, path: string): ReadonlySet<string> {
  if (type.members === undefined) fail(path, `${type.kind} descriptor has no members`);
  return new Set(type.members);
}

function requireMember(value: string, type: TypeDescriptor, path: string): string {
  if (!requireMembers(type, path).has(value)) fail(path, `unknown ${type.kind} member ${JSON.stringify(value)}`);
  return value;
}

function requireFlags(value: unknown, type: TypeDescriptor, path: string): ReadonlySet<string> {
  if (!(value instanceof Set)) fail(path, "expected a Set of flag names");
  const allowed = requireMembers(type, path);
  const result = new Set<string>();
  for (const member of value) {
    if (typeof member !== "string") fail(path, "flag names must be strings");
    if (!allowed.has(member)) fail(path, `unknown flag ${JSON.stringify(member)}`);
    result.add(member);
  }
  return result;
}

function requirePublicFlags(value: PublicValue, type: TypeDescriptor, path: string): ReadonlySet<string> {
  if (!Array.isArray(value)) fail(path, "expected an array of flag names");
  const allowed = requireMembers(type, path);
  const result = new Set<string>();
  let previous: string | undefined;
  for (const member of value) {
    if (typeof member !== "string") fail(path, "flag names must be strings");
    if (!allowed.has(member)) fail(path, `unknown flag ${JSON.stringify(member)}`);
    if (previous !== undefined && member <= previous) {
      fail(path, "flag names must be unique and lexically sorted");
    }
    result.add(member);
    previous = member;
  }
  return result;
}

function requireBytes(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(path, "expected a Uint8Array");
  return value;
}

function encodeBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    encoded += BASE64[(value >>> 18) & 0x3f];
    encoded += BASE64[(value >>> 12) & 0x3f];
    encoded += hasSecond ? BASE64[(value >>> 6) & 0x3f] : "=";
    encoded += hasThird ? BASE64[value & 0x3f] : "=";
  }
  return encoded;
}

function decodeBase64(value: string, path: string): Uint8Array {
  if (value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(path, "bytes tag is not canonical base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(value.length / 4 * 3 - padding);
  let output = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value[index] ?? "");
    const b = BASE64.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === "=" ? 0 : BASE64.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === "=" ? 0 : BASE64.indexOf(value[index + 3] ?? "");
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < bytes.length) bytes[output++] = (packed >>> 16) & 0xff;
    if (output < bytes.length) bytes[output++] = (packed >>> 8) & 0xff;
    if (output < bytes.length) bytes[output++] = packed & 0xff;
  }
  if (encodeBase64(bytes) !== value) fail(path, "bytes tag is not canonical base64");
  return bytes;
}

function convertToPublic(value: unknown, type: TypeDescriptor, path: string): PublicValue {
  switch (type.kind) {
    case "boolean": return requireBoolean(value, path);
    case "integer": {
      const integer = requireInteger(value, type, path);
      if (integer >= -MAX_SAFE_BIGINT && integer <= MAX_SAFE_BIGINT) return Number(integer);
      return {
        type: integerBounds(type, path).signed ? "i64" : "u64",
        value: integer.toString(10),
      };
    }
    case "float": return requireFinite(value, path);
    case "decimal": return { type: "decimal", value: requireString(value, path) };
    case "string": return requireString(value, path);
    case "enum": return requireMember(requireString(value, path), type, path);
    case "flags": return [...requireFlags(value, type, path)].sort();
    case "bytes": return { type: "bytes", encoding: "base64", value: encodeBase64(requireBytes(value, path)) };
    case "array": {
      if (!Array.isArray(value)) fail(path, "expected an array");
      const itemType = item(type, path);
      return value.map((entry, index) => convertToPublic(entry, itemType, `${path}[${index}]`));
    }
    case "record": {
      const record = asRecord(value, path);
      const declared = fields(type, path);
      requireExactKeys(record, declared, path);
      const converted: Record<string, PublicValue> = {};
      for (const name of Object.keys(declared)) {
        converted[name] = convertToPublic(record[name], declared[name]!, `${path}.${name}`);
      }
      return converted;
    }
  }
}

function convertFromPublic(value: PublicValue, type: TypeDescriptor, path: string): unknown {
  switch (type.kind) {
    case "boolean": return requireBoolean(value, path);
    case "integer": {
      let integer: bigint;
      if (typeof value === "number") {
        integer = requireInteger(value, type, path);
      } else {
        const tagged = asRecord(value, path);
        const bounds = integerBounds(type, path);
        const expected = bounds.signed ? "i64" : "u64";
        requireTagKeys(tagged, ["type", "value"], path);
        if (tagged.type !== expected || typeof tagged.value !== "string") {
          fail(path, `expected a ${expected} tagged integer`);
        }
        integer = canonicalInteger(tagged.value, bounds.signed, `${path}.value`);
        requireInteger(integer, type, path);
      }
      return internalInteger(integer, type, path);
    }
    case "float": return requireFinite(value, path);
    case "decimal": {
      const tagged = asRecord(value, path);
      requireTagKeys(tagged, ["type", "value"], path);
      if (tagged.type !== "decimal") fail(path, "expected a decimal tag");
      return requireString(tagged.value, `${path}.value`);
    }
    case "string": return requireString(value, path);
    case "enum": return requireMember(requireString(value, path), type, path);
    case "flags": return requirePublicFlags(value, type, path);
    case "bytes": {
      const tagged = asRecord(value, path);
      requireTagKeys(tagged, ["type", "encoding", "value"], path);
      if (tagged.type !== "bytes" || tagged.encoding !== "base64") fail(path, "expected a base64 bytes tag");
      return decodeBase64(requireString(tagged.value, `${path}.value`), `${path}.value`);
    }
    case "array": {
      if (!Array.isArray(value)) fail(path, "expected an array");
      const itemType = item(type, path);
      return value.map((entry, index) => convertFromPublic(entry, itemType, `${path}[${index}]`));
    }
    case "record": {
      const record = asRecord(value, path);
      const declared = fields(type, path);
      requireExactKeys(record, declared, path);
      const converted: Record<string, unknown> = {};
      for (const name of Object.keys(declared)) {
        converted[name] = convertFromPublic(record[name] as PublicValue, declared[name]!, `${path}.${name}`);
      }
      return converted;
    }
  }
}

function convertToRpc(value: unknown, type: TypeDescriptor, path: string): RpcValue {
  switch (type.kind) {
    case "boolean": return requireBoolean(value, path);
    case "integer": return internalInteger(requireInteger(value, type, path), type, path);
    case "float": return requireFinite(value, path);
    case "decimal": return requireString(value, path);
    case "string": return requireString(value, path);
    case "enum": return requireMember(requireString(value, path), type, path);
    case "flags": return new Set(requireFlags(value, type, path));
    case "bytes": return requireBytes(value, path).slice();
    case "array": {
      if (!Array.isArray(value)) fail(path, "expected an array");
      const itemType = item(type, path);
      return value.map((entry, index) => convertToRpc(entry, itemType, `${path}[${index}]`));
    }
    case "record": {
      const record = asRecord(value, path);
      const declared = fields(type, path);
      requireExactKeys(record, declared, path);
      const converted: Record<string, RpcValue> = {};
      for (const name of Object.keys(declared)) {
        converted[name] = convertToRpc(record[name], declared[name]!, `${path}.${name}`);
      }
      return converted;
    }
  }
}

function convertFromRpc(value: RpcValue, type: TypeDescriptor, path: string): unknown {
  switch (type.kind) {
    case "boolean": return requireBoolean(value, path);
    case "integer": return internalInteger(requireInteger(value, type, path), type, path);
    case "float": return requireFinite(value, path);
    case "decimal": return requireString(value, path);
    case "string": return requireString(value, path);
    case "enum": return requireMember(requireString(value, path), type, path);
    case "flags": return new Set(requireFlags(value, type, path));
    case "bytes": return requireBytes(value, path).slice();
    case "array": {
      if (!Array.isArray(value)) fail(path, "expected an array");
      const itemType = item(type, path);
      return value.map((entry, index) => convertFromRpc(entry, itemType, `${path}[${index}]`));
    }
    case "record": {
      const record = asRecord(value, path);
      const declared = fields(type, path);
      requireExactKeys(record, declared, path);
      const converted: Record<string, unknown> = {};
      for (const name of Object.keys(declared)) {
        converted[name] = convertFromRpc(record[name] as RpcValue, declared[name]!, `${path}.${name}`);
      }
      return converted;
    }
  }
}
