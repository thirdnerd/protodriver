import { nativeKeys, nativeEntries, nativeValues, nativeRecord, nativeArray, nativeSort } from "./native-account.ts";
import type { LuaValueAbiV1ValueKind } from "@protodriver/contracts";
import { activeNativeScratch } from "./native-account.ts";
import { luaResourceError } from "./resource-policy.ts";

export type LuaValueAbiEnvelopeKind = "value" | "admission-result" | "invoke" | "program-failure" | "source-member-failure";
export type LuaValueAbiHostEnvelopeKind = Exclude<LuaValueAbiEnvelopeKind, "source-member-failure">;

export interface LuaValueAbiDecodedFrame {
  readonly envelopeKind: LuaValueAbiEnvelopeKind;
  readonly semantic: unknown;
}

export interface LuaAdmissionResult {
  readonly graph: unknown;
  readonly exportsInCanonicalOrder: readonly string[];
}

export function sourceMemberAdmissionError(member: string, reason: "missing" | "initialization-failed"): Error {
  const error = new Error(`lua-vm.admission.source-member: ${member} ${reason}`);
  Object.defineProperties(error, {
    code: { value: "lua-vm.admission.source-member", enumerable: true },
    sourceMember: { value: member, enumerable: true },
    sourceMemberFailure: { value: reason, enumerable: true },
    phase: { value: "admission", enumerable: true },
  });
  return error;
}

export function requireLuaAdmissionResult(frame: unknown): LuaAdmissionResult {
  if (frame !== null && typeof frame === "object") {
    const decoded = frame as { readonly envelopeKind?: unknown; readonly semantic?: unknown };
    if (decoded.envelopeKind === "program-failure") throw programFailureError(decoded.semantic, "admission");
    if (decoded.envelopeKind === "source-member-failure") {
      const semantic = decoded.semantic as { readonly member?: unknown; readonly reason?: unknown };
      throw sourceMemberAdmissionError(String(semantic.member), semantic.reason as "missing" | "initialization-failed");
    }
  }
  if (frame === null
      || typeof frame !== "object"
      || (frame as { readonly envelopeKind?: unknown }).envelopeKind !== "admission-result") {
    fail("admission-envelope", "admission worker did not return an admission-result envelope");
  }
  const decoded = frame as { readonly semantic?: unknown };
  if (decoded.semantic === null
      || typeof decoded.semantic !== "object"
      || (decoded.semantic as { readonly kind?: unknown }).kind !== "admission-result") {
    fail("admission-envelope", "admission worker did not return an admission-result envelope");
  }
  const semantic = decoded.semantic as {
    readonly graph?: unknown;
    readonly exportsInCanonicalOrder?: unknown;
  };
  if (!Array.isArray(semantic.exportsInCanonicalOrder)
      || nativeArray(semantic.exportsInCanonicalOrder).some((name) => typeof name !== "string")) {
    fail("admission-envelope", "admission worker returned malformed export names");
  }
  return Object.freeze({
    graph: semantic.graph,
    exportsInCanonicalOrder: Object.freeze([...semantic.exportsInCanonicalOrder] as string[]),
  });
}

export function encodeLuaBytesInvocation(exportName: string, input: Uint8Array): Uint8Array {
  return encodeLuaProgramInvocation(exportName, {
    kind: "bytes", hex: nativeArray([...input]).map(hexOctet).join(""),
  });
}

export function encodeLuaProgramInvocation(exportName: string, input: unknown, iteration = activeNativeScratch()?.iteration): Uint8Array {
  return encodeLuaValueAbiFrame("invoke", { kind: "invoke", exportName, input }, iteration);
}

/** Selected source entry: write once into the reserved VM input region. Length
 * fields are backpatched; neither nested containers nor finish copy payloads.
 * bytes-base64 is a host encoder input, not a new wire/author value kind. */
export function encodeLuaProgramInvocationInto(exportName: string, input: unknown, target: Uint8Array, iteration: () => void): number {
  const writer = new ByteWriter(iteration, target);
  writer.bytes(Uint8Array.of(0x50, 0x44, 0x52, 0x56, 0x01, envelopeKinds.get("invoke")!));
  writer.region(content => {
    const name = encodeName(exportName, "invoke.exportName");
    content.u32(name.length).bytes(name);
    encodeValue(input, content, "invoke.input");
  });
  return writer.finish().length;
}

export function requireLuaBytesInvocationOutcome(frame: unknown): Uint8Array {
  const outcome = requireLuaProgramInvocationOutcome(frame);
  requireLuaProgramOutputKind(outcome, "bytes");
  return Uint8Array.from(outcome.value as Uint8Array);
}

export interface LuaProgramInvocationOutcome {
  readonly kind: LuaValueAbiV1ValueKind;
  readonly value: unknown;
}

export function requireLuaProgramInvocationOutcome(frame: unknown): LuaProgramInvocationOutcome {
  if (frame === null || typeof frame !== "object") fail("invocation-envelope", "invocation returned no value envelope");
  const decoded = frame as { readonly envelopeKind?: unknown; readonly semantic?: unknown };
  if (decoded.envelopeKind === "program-failure") throw programFailureError(decoded.semantic, "invocation");
  if (decoded.envelopeKind !== "value") {
    fail("invocation-envelope", "invocation did not return a value envelope");
  }
  const kind = decodedRootKind(decoded.semantic);
  return Object.freeze({ kind, value: materializeInvocationValue(decoded.semantic, "invocation.output") });
}

function programFailureError(semanticValue: unknown, phase: "admission" | "invocation"): Error {
  const semantic = semanticValue as { readonly name?: unknown; readonly details?: unknown };
  const error = new Error(`lua-vm.${phase}.program-failure: ${String(semantic.name)}`);
  Object.defineProperties(error, {
    code: { value: `lua-vm.${phase}.program-failure`, enumerable: true },
    programFailureName: { value: semantic.name, enumerable: true },
    programFailureDetails: { value: semantic.details, enumerable: true },
    ...(phase === "admission" ? { phase: { value: phase, enumerable: true } } : {}),
  });
  return error;
}

export function requireLuaProgramOutputKind(
  outcome: LuaProgramInvocationOutcome,
  expectedKind: LuaValueAbiV1ValueKind,
): unknown {
  if (outcome.kind !== expectedKind) {
    fail("invocation-output-kind", `invocation returned ${outcome.kind}; declaration requires ${expectedKind}`);
  }
  return cloneInvocationValue(outcome.value);
}

export function createLuaProgramInvocationAdapter(session: Readonly<{
  invoke(encodedInput: Uint8Array): Promise<Readonly<{ value: unknown; fuelConsumed: number }>>;
  terminate(): Promise<void>;
}>) {
  return async (exportName: string, input: unknown) => {
    let encoded: Uint8Array;
    try {
      encoded = input instanceof Uint8Array
        ? encodeLuaBytesInvocation(exportName, input)
        : encodeLuaProgramInvocation(exportName, input);
    } catch (cause) {
      await session.terminate();
      throw cause;
    }
    const observed = await session.invoke(encoded);
    return Object.freeze({
      outcome: requireLuaProgramInvocationOutcome(observed.value),
      fuelConsumed: observed.fuelConsumed,
    });
  };
}

export function createLuaBytesInvocationAdapter(session: Readonly<{
  invoke(encodedInput: Uint8Array): Promise<Readonly<{ value: unknown; fuelConsumed: number }>>;
  terminate(): Promise<void>;
}>) {
  const invokeProgram = createLuaProgramInvocationAdapter(session);
  return async (exportName: string, input: Uint8Array) => {
    const observed = await invokeProgram(exportName, input);
    return Object.freeze({
      value: requireLuaProgramOutputKind(observed.outcome, "bytes") as Uint8Array,
      fuelConsumed: observed.fuelConsumed,
    });
  };
}

function decodedRootKind(value: unknown): LuaValueAbiV1ValueKind {
  if (value === false) return "false";
  if (value === true) return "true";
  if (value === null) return "null";
  if (!isValueNode(value)) fail("invocation-envelope", "invocation value has no ABI root kind");
  switch (value.kind) {
    case "boolean": return value.value === false ? "false" : "true";
    case "i64": return "signed-bounded-integer";
    case "u64": return "unsigned-bounded-integer";
    case "integer": return "arbitrary-integer";
    case "float64": return "finite-float";
    case "text": return "text";
    case "bytes": return "bytes";
    case "array": return "array";
    case "record": return "record";
    case "variant": return "tagged-variant";
    case "null": return "null";
    default: fail("invocation-envelope", `invocation value has unknown ABI root kind ${value.kind}`);
  }
}

function materializeInvocationValue(value: unknown, at: string): unknown {
  activeNativeScratch()?.node();
  if (value === null || typeof value === "boolean") return value;
  if (!isValueNode(value)) fail("invocation-envelope", `${at} is not a decoded ABI value`);
  if (value.kind === "boolean") {
    if (typeof value.value !== "boolean") fail("invocation-envelope", `${at}.value is not Boolean`);
    return value.value;
  }
  if (value.kind === "i64" || value.kind === "u64" || value.kind === "integer") {
    return Object.freeze({ kind: value.kind, decimal: requireString(value.decimal, `${at}.decimal`) });
  }
  if (value.kind === "float64") return Number(requireString(value.decimal, `${at}.decimal`));
  if (value.kind === "text") return requireString(value.value, `${at}.value`);
  if (value.kind === "bytes") return decodeHex(requireString(value.hex, `${at}.hex`), at);
  if (value.kind === "null") return null;
  if (value.kind === "array") {
    return Object.freeze(nativeArray(requireArray(value.items, `${at}.items`)).map(
      (item, index) => materializeInvocationValue(item, `${at}[${index}]`),
    ));
  }
  if (value.kind === "record") {
    const entries = requireArray(value.entriesInCanonicalOrder, `${at}.entriesInCanonicalOrder`);
    return Object.freeze(nativeRecord(nativeArray(entries).map((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) fail("invocation-envelope", `${at}.entries[${index}] is not a pair`);
      return [requireString(entry[0], `${at}.entries[${index}].name`), materializeInvocationValue(entry[1], `${at}.${String(entry[0])}`)];
    })));
  }
  if (value.kind === "variant") {
    return Object.freeze({
      kind: "variant",
      tag: requireString(value.tag, `${at}.tag`),
      value: materializeInvocationValue(value.value, `${at}.value`),
    });
  }
  fail("invocation-envelope", `${at} has unknown decoded ABI kind ${value.kind}`);
}

function cloneInvocationValue(value: unknown): unknown {
  activeNativeScratch()?.node(value instanceof Uint8Array ? 8 + value.length : 8);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return Object.freeze(nativeArray(value).map(cloneInvocationValue));
  if (value !== null && typeof value === "object") {
    return Object.freeze(nativeRecord(nativeArray(nativeEntries(value)).map(([name, member]) => [name, cloneInvocationValue(member)])));
  }
  return value;
}

interface ValueNode {
  readonly kind: string;
  readonly [name: string]: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const envelopeKinds = new Map<LuaValueAbiHostEnvelopeKind, number>([
  ["value", 0x01],
  ["admission-result", 0x02],
  ["invoke", 0x03],
  ["program-failure", 0x04],
]);
const envelopeNames = new Map<number, LuaValueAbiEnvelopeKind>([
  ...nativeArray([...envelopeKinds]).map(([name, tag]) => [tag, name] as const),
  [0x05, "source-member-failure"],
]);

// The ABI also carries admission graphs and internal envelopes, not only
// values described by authored types (whose nesting is capped at 16). Keep
// generous headroom for those wrappers while refusing before any recursive
// encoder, decoder, or post-decode materializer approaches the JS stack.
const MAXIMUM_LUA_VALUE_ABI_DEPTH = 128;

function assertValueDepth(depth: number): void {
  if (depth > MAXIMUM_LUA_VALUE_ABI_DEPTH) {
    throw luaResourceError(
      "lua-vm.resource.depth-limit",
      `ABI value exceeds ${MAXIMUM_LUA_VALUE_ABI_DEPTH} nested levels`,
    );
  }
}

export function encodeLuaValueAbiFrame(
  envelopeKind: LuaValueAbiHostEnvelopeKind,
  semanticValue: unknown,
  iteration?: () => void,
): Uint8Array {
  const kind = envelopeKinds.get(envelopeKind);
  if (kind === undefined) throw new Error(`lua-vm.value-abi.envelope-kind: ${String(envelopeKind)}`);
  const payload = new ByteWriter(iteration);
  if (envelopeKind === "value") {
    encodeValue(semanticValue, payload, "value");
  } else if (envelopeKind === "admission-result") {
    const semantic = requireRecord(semanticValue, `envelope.${envelopeKind}`);
    if (semantic.kind !== "admission-result") fail("shape", "admission result has the wrong semantic kind");
    encodeValue(semantic.graph, payload, "admission.graph");
    const exports = requireArray(semantic.exportsInCanonicalOrder, "admission.exportsInCanonicalOrder");
    payload.u32(exports.length);
    let prior: Uint8Array | undefined;
    for (const [index, nameValue] of exports.entries()) {
      const name = encodeName(nameValue, `admission.exports[${index}]`);
      if (prior !== undefined && compareBytes(prior, name) >= 0) fail("canonical-order", "export names are not strictly ordered");
      payload.u32(name.byteLength).bytes(name);
      prior = name;
    }
  } else if (envelopeKind === "invoke") {
    const semantic = requireRecord(semanticValue, `envelope.${envelopeKind}`);
    if (semantic.kind !== "invoke") fail("shape", "invocation has the wrong semantic kind");
    const name = encodeName(semantic.exportName, "invoke.exportName");
    payload.u32(name.byteLength).bytes(name);
    encodeValue(semantic.input, payload, "invoke.input");
  } else {
    const semantic = requireRecord(semanticValue, `envelope.${envelopeKind}`);
    if (semantic.kind !== "program-failure") fail("shape", "program failure has the wrong semantic kind");
    const name = encodeName(semantic.name, "program-failure.name");
    payload.u32(name.byteLength).bytes(name);
    encodeValue(semantic.details, payload, "program-failure.details");
  }
  const body = payload.finish();
  return new ByteWriter(iteration).bytes(Uint8Array.of(0x50, 0x44, 0x52, 0x56, 0x01, kind))
    .u32(body.byteLength).bytes(body).finish();
}

export function decodeLuaValueAbiFrame(frame: Uint8Array): LuaValueAbiDecodedFrame {
  const reader = new ByteReader(frame);
  if (!equalBytes(reader.bytes(4), Uint8Array.of(0x50, 0x44, 0x52, 0x56)) || reader.u8() !== 1) {
    fail("frame-malformed", "wrong magic or version");
  }
  const kind = reader.u8();
  const envelopeKind = envelopeNames.get(kind);
  if (envelopeKind === undefined) fail("frame-malformed", `unknown envelope kind ${kind}`);
  const length = reader.u32();
  if (length !== reader.remaining) fail("frame-malformed", `payload declares ${length}, observed ${reader.remaining}`);
  let semantic: unknown;
  if (envelopeKind === "value") {
    const value = decodeValue(reader, "value");
    semantic = value.kind === "null" ? null : value;
  } else if (envelopeKind === "admission-result") {
    const graph = materialize(decodeValue(reader, "admission.graph"));
    if (graph === null || typeof graph !== "object" || Array.isArray(graph)) fail("frame-malformed", "admission graph is not a record");
    const count = reader.u32();
    const exportsInCanonicalOrder: string[] = [];
    let prior: Uint8Array | undefined;
    for (let index = 0; index < count; index += 1) {
      const raw = reader.bytes(reader.u32());
      const name = decodeName(raw, `admission.exports[${index}]`);
      if (prior !== undefined && compareBytes(prior, raw) >= 0) fail("frame-malformed", "export names are not canonical");
      exportsInCanonicalOrder.push(name);
      prior = raw;
    }
    semantic = { kind: "admission-result", graph, exportsInCanonicalOrder };
  } else if (envelopeKind === "invoke") {
    const exportName = decodeName(reader.bytes(reader.u32()), "invoke.exportName");
    semantic = { kind: "invoke", exportName, input: materialize(decodeValue(reader, "invoke.input")) };
  } else if (envelopeKind === "program-failure") {
    const name = decodeName(reader.bytes(reader.u32()), "program-failure.name");
    semantic = { kind: "program-failure", name, details: materialize(decodeValue(reader, "program-failure.details")) };
  } else {
    const member = decodeName(reader.bytes(reader.u32()), "source-member-failure.member");
    const reasonTag = reader.u8();
    const reason = reasonTag === 1 ? "missing" : reasonTag === 2 ? "initialization-failed" : undefined;
    if (reason === undefined) fail("frame-malformed", `unknown source-member failure class ${reasonTag}`);
    semantic = { kind: "source-member-failure", member, reason };
  }
  if (reader.remaining !== 0) fail("frame-malformed", `${reader.remaining} trailing octets`);
  return Object.freeze({ envelopeKind, semantic });
}

function encodeValue(value: unknown, writer: ByteWriter, at: string, depth = 0): void {
  assertValueDepth(depth);
  writer.iteration?.();
  if (value === null) {
    writer.u8(0x0c).u32(0);
    return;
  }
  if (typeof value === "boolean") {
    writer.u8(value ? 0x02 : 0x01).u32(0);
    return;
  }
  const node = requireRecord(value, at);
  if (node.kind === "boolean") {
    if (typeof node.value !== "boolean") fail("shape", `${at}.value must be boolean`);
    writer.u8(node.value ? 0x02 : 0x01).u32(0);
    return;
  }
  if (node.kind === "i64" || node.kind === "u64") {
    const signed = node.kind === "i64";
    const integer = parseDecimal(node.decimal, at);
    const minimum = signed ? -(1n << 63n) : 0n;
    const maximum = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
    if (integer < minimum || integer > maximum) fail("integer-range", `${at} is outside ${node.kind}`);
    const unsigned = integer < 0 ? integer + (1n << 64n) : integer;
    const content = bigEndian(unsigned, 8);
    writer.u8(signed ? 0x03 : 0x04).u32(8).bytes(content);
    return;
  }
  if (node.kind === "integer") {
    const integer = parseDecimal(node.decimal, at);
    const negative = integer < 0;
    let magnitude = negative ? -integer : integer;
    const octets: number[] = [];
    while (magnitude !== 0n) {
      activeNativeScratch()?.work(1 + octets.length); // existing unshift moves its prefix
      activeNativeScratch()?.reserve(16);
      octets.unshift(Number(magnitude & 0xffn)); magnitude >>= 8n;
    }
    activeNativeScratch()?.reserve(8 + octets.length);
    writer.u8(0x05).u32(1 + octets.length).u8(negative ? 1 : 0).bytes(Uint8Array.from(octets));
    return;
  }
  if (node.kind === "float64") {
    const number = Number(requireString(node.decimal, `${at}.decimal`));
    if (!Number.isFinite(number)) fail("non-finite", `${at} is not finite`);
    if (Object.is(number, -0)) fail("negative-zero", `${at} is negative zero`);
    const content = new Uint8Array(8);
    new DataView(content.buffer).setFloat64(0, number, false);
    writer.u8(0x06).u32(8).bytes(content);
    return;
  }
  if (node.kind === "text") {
    const text = requireString(node.value, `${at}.value`);
    assertUnicodeScalars(text, at);
    const content = encoder.encode(text);
    writer.u8(0x07).u32(content.byteLength).bytes(content);
    return;
  }
  if (node.kind === "bytes") {
    const content = decodeHex(requireString(node.hex, `${at}.hex`), at, writer.iteration);
    writer.u8(0x08).u32(content.byteLength).bytes(content);
    return;
  }
  if (node.kind === "bytes-base64") {
    writer.base64(requireString(node.value, `${at}.value`));
    return;
  }
  if (node.kind === "bytes-buffer") {
    if (!(node.value instanceof Uint8Array)) fail("frame-malformed", `${at}.value is not an owned byte buffer`);
    writer.u8(0x08).u32(node.value.length).bytes(node.value);
    return;
  }
  if (node.kind === "array") {
    const items = requireArray(node.items, `${at}.items`);
    writer.u8(0x09).region(content => {
      content.u32(items.length);
      nativeArray(items).forEach((item, index) => encodeValue(item, content, `${at}[${index}]`, depth + 1));
    });
    return;
  }
  if (node.kind === "record" || node.kind === undefined) {
    const entries = node.kind === "record"
      ? requireArray(node.entriesInCanonicalOrder, `${at}.entriesInCanonicalOrder`)
      : nativeSort(nativeEntries(node), ([left], [right]) => compareBytes(encodeText(left, at), encodeText(right, at)));
    writer.u8(0x0a).region(content => {
      content.u32(entries.length);
      let prior: Uint8Array | undefined;
      for (const [index, entryValue] of entries.entries()) {
        if (!Array.isArray(entryValue) || entryValue.length !== 2) fail("shape", `${at}.entries[${index}] must be a pair`);
        const key = encodeText(requireString(entryValue[0], `${at}.key`), `${at}.key`);
        if (prior !== undefined && compareBytes(prior, key) >= 0) fail("canonical-order", `${at} keys are not strictly ordered`);
        content.u32(key.byteLength).bytes(key);
        encodeValue(entryValue[1], content, `${at}.${String(entryValue[0])}`, depth + 1);
        prior = key;
      }
    });
    return;
  }
  if (node.kind === "variant") {
    const tag = encodeName(node.tag, `${at}.tag`);
    writer.u8(0x0b).region(content => {
      content.u32(tag.byteLength).bytes(tag);
      encodeValue(node.value, content, `${at}.value`, depth + 1);
    });
    return;
  }
  if (node.kind === "forbidden-crossing") fail("forbidden-crossing", `${at} cannot cross the ABI`);
  fail("value-kind", `${at} has unknown kind ${String(node.kind)}`);
}

function decodeValue(reader: ByteReader, at: string, depth = 0): ValueNode {
  assertValueDepth(depth);
  activeNativeScratch()?.node();
  const tag = reader.u8();
  const content = reader.region(reader.u32());
  let node: ValueNode;
  if (tag === 0x01 || tag === 0x02) {
    if (content.remaining !== 0) fail("frame-malformed", `${at} boolean has content`);
    node = { kind: "boolean", value: tag === 0x02 };
  } else if (tag === 0x03 || tag === 0x04) {
    if (content.remaining !== 8) fail("frame-malformed", `${at} fixed integer is not eight octets`);
    let integer = unsignedBigInt(content.bytes(8));
    if (tag === 0x03 && (integer & (1n << 63n)) !== 0n) integer -= 1n << 64n;
    node = { kind: tag === 0x03 ? "i64" : "u64", decimal: integer.toString() };
  } else if (tag === 0x05) {
    const sign = content.u8();
    const magnitudeBytes = content.bytes(content.remaining);
    if (sign > 1 || (magnitudeBytes.byteLength === 0 && sign !== 0) || magnitudeBytes[0] === 0) {
      fail("frame-malformed", `${at} arbitrary integer is not minimal`);
    }
    const magnitude = unsignedBigInt(magnitudeBytes);
    node = { kind: "integer", decimal: (sign === 1 ? -magnitude : magnitude).toString() };
  } else if (tag === 0x06) {
    if (content.remaining !== 8) fail("frame-malformed", `${at} float is not eight octets`);
    const bytes = content.bytes(8);
    const number = new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false);
    if (!Number.isFinite(number)) fail("non-finite", `${at} is not finite`);
    if (Object.is(number, -0)) fail("negative-zero", `${at} is negative zero`);
    node = { kind: "float64", decimal: String(number) };
  } else if (tag === 0x07) {
    node = { kind: "text", value: decodeName(content.bytes(content.remaining), at, true) };
  } else if (tag === 0x08) {
    activeNativeScratch()?.reserve(8 + content.remaining * 24);
    activeNativeScratch()?.work(content.remaining * 3); // spread, map, join; preserve the copies
    node = { kind: "bytes", hex: nativeArray([...content.bytes(content.remaining)]).map(hexOctet).join("") };
  } else if (tag === 0x09) {
    const count = content.u32();
    const items: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = decodeValue(content, `${at}[${index}]`, depth + 1);
      items.push(item.kind === "boolean" ? item.value : item);
    }
    node = { kind: "array", items };
  } else if (tag === 0x0a) {
    const count = content.u32();
    const entriesInCanonicalOrder: Array<[string, unknown]> = [];
    let prior: Uint8Array | undefined;
    for (let index = 0; index < count; index += 1) {
      const raw = content.bytes(content.u32());
      if (prior !== undefined && compareBytes(prior, raw) >= 0) fail("frame-malformed", `${at} keys are not canonical`);
      const key = decodeName(raw, `${at}.key[${index}]`);
      const value = decodeValue(content, `${at}.${key}`, depth + 1);
      entriesInCanonicalOrder.push([key, value.kind === "boolean" ? value.value : value]);
      prior = raw;
    }
    node = { kind: "record", entriesInCanonicalOrder };
  } else if (tag === 0x0b) {
    const variant = decodeName(content.bytes(content.u32()), `${at}.tag`);
    const value = decodeValue(content, `${at}.value`, depth + 1);
    node = { kind: "variant", tag: variant, value: value.kind === "boolean" ? value.value : value };
  } else if (tag === 0x0c) {
    if (content.remaining !== 0) fail("frame-malformed", `${at} null has content`);
    node = { kind: "null" };
  } else {
    fail("frame-malformed", `${at} has unknown tag ${tag}`);
  }
  if (content.remaining !== 0) fail("frame-malformed", `${at} leaves ${content.remaining} content octets`);
  return node;
}

function materialize(node: ValueNode): unknown {
  activeNativeScratch()?.node();
  if (node.kind === "null") return null;
  if (node.kind === "boolean" || node.kind === "text") return node.value;
  if (node.kind === "array") return nativeArray((node.items as unknown[])).map((item) => isValueNode(item) ? materialize(item) : item);
  if (node.kind === "record") return nativeRecord(
    nativeArray((node.entriesInCanonicalOrder as Array<[string, unknown]>)).map(([key, value]) => [key, isValueNode(value) ? materialize(value) : value]),
  );
  if (node.kind === "variant") return {
    kind: "variant",
    tag: node.tag,
    value: isValueNode(node.value) ? materialize(node.value) : node.value,
  };
  return node;
}

function isValueNode(value: unknown): value is ValueNode {
  return value !== null && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string";
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("shape", `${at} must be a record`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) fail("shape", `${at} must be an array`);
  return value;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== "string") fail("shape", `${at} must be a string`);
  return value;
}

function parseDecimal(value: unknown, at: string): bigint {
  const decimal = requireString(value, `${at}.decimal`);
  activeNativeScratch()?.text(decimal);
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(decimal) || decimal === "-0") fail("integer-spelling", `${at} is not canonical decimal`);
  return BigInt(decimal);
}

function encodeName(value: unknown, at: string): Uint8Array {
  const text = requireString(value, at);
  if (text.length === 0) fail("name-empty", `${at} must not be empty`);
  return encodeText(text, at);
}

function encodeText(text: string, at: string): Uint8Array {
  assertUnicodeScalars(text, at);
  return encoder.encode(text);
}

function decodeName(bytes: Uint8Array, at: string, allowEmpty = false): string {
  activeNativeScratch()?.reserve(8 + bytes.length * 3);
  activeNativeScratch()?.work(bytes.length);
  let text: string;
  try { text = decoder.decode(bytes); } catch { fail("invalid-utf8", `${at} is not fatal UTF-8`); }
  if (!allowEmpty && text.length === 0) fail("name-empty", `${at} must not be empty`);
  return text;
}

function assertUnicodeScalars(value: string, at: string): void {
  activeNativeScratch()?.reserve(8 + value.length * 3);
  for (let index = 0; index < value.length; index += 1) {
    activeNativeScratch()?.iteration();
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        fail("lone-surrogate", `${at} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("lone-surrogate", `${at} contains an unpaired low surrogate`);
    }
  }
}

function decodeHex(value: string, at: string, iteration?: () => void): Uint8Array {
  activeNativeScratch()?.work(value.length);
  activeNativeScratch()?.reserve(8 + Math.ceil(value.length / 2));
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) fail("hex", `${at} is not lowercase whole-octet hex`);
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) { (iteration ?? activeNativeScratch()?.iteration)?.(); bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16); }
  return bytes;
}

function bigEndian(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) { bytes[index] = Number(value & 0xffn); value >>= 8n; }
  return bytes;
}

function unsignedBigInt(bytes: Uint8Array): bigint {
  activeNativeScratch()?.reserve(8 + bytes.length * 6); // growing operands and decimal conversion peak
  let value = 0n;
  for (const octet of bytes) { activeNativeScratch()?.iteration(); value = (value << 8n) | BigInt(octet); }
  return value;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < shared; index += 1) {
    activeNativeScratch()?.iteration();
    if (left[index] !== right[index]) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return left.byteLength - right.byteLength;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && nativeArray(left).every((octet, index) => octet === right[index]);
}

function hexOctet(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function fail(code: string, detail: string): never {
  throw new Error(`lua-vm.value-abi.${code}: ${detail}`);
}

class ByteWriter {
  readonly #bytes: number[] = [];
  readonly #target: Uint8Array | undefined;
  #offset = 0;
  readonly iteration: (() => void) | undefined;
  readonly #storage = activeNativeScratch()?.child();
  #finished = false;
  constructor(iteration = activeNativeScratch()?.iteration, target?: Uint8Array) {
    this.#storage?.reserve(8);
    this.iteration = iteration; this.#target = target;
  }
  u8(value: number): this {
    if (this.#finished) throw new Error("finished ABI writer");
    if (this.#target) {
      if (this.#offset >= this.#target.length) fail("capacity", "direct invocation exceeds reserved input");
      this.#target[this.#offset++] = value & 0xff;
    } else { this.#storage?.reserve(16); this.#bytes.push(value & 0xff); }
    return this;
  }
  u32(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) fail("length", `invalid u32 ${value}`);
    this.u8(value >>> 24).u8(value >>> 16).u8(value >>> 8).u8(value);
    return this;
  }
  bytes(value: Uint8Array): this {
    for (let index = 0; index < value.byteLength; index += 1) { this.iteration?.(); this.u8(value[index] ?? 0); }
    return this;
  }
  region(fill: (content: ByteWriter) => void): this {
    if (!this.#target) {
      const append = () => {
        const content = new ByteWriter(this.iteration); fill(content);
        const bytes = content.finish(); return this.u32(bytes.length).bytes(bytes);
      };
      // Parent append storage belongs to this writer, not the child's scope.
      // The completed child buffer is dead once bytes() has copied it.
      return activeNativeScratch()?.transient(append) ?? append();
    }
    const start = this.#offset; this.u32(0); fill(this);
    new DataView(this.#target.buffer, this.#target.byteOffset + start, 4).setUint32(0, this.#offset - start - 4, false);
    return this;
  }
  base64(value: string): void {
    if (!this.#target) fail("value-kind", "base64 leaf is restricted to the direct host encoder");
    if (value.length % 4) fail("base64", "incomplete quartet");
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const length = value.length / 4 * 3 - padding;
    this.u8(0x08).u32(length);
    // Decode each quartet directly into its final framed region. Charging
    // precedes EACH emitted octet, including the final partial quartet.
    const digit = (index: number) => {
      const c = value.charCodeAt(index);
      if (c >= 65 && c <= 90) return c - 65;
      if (c >= 97 && c <= 122) return c - 71;
      if (c >= 48 && c <= 57) return c + 4;
      if (c === 43) return 62;
      if (c === 47) return 63;
      return fail("base64", "invalid alphabet or misplaced padding");
    };
    const emit = (byte: number) => { this.iteration?.(); this.u8(byte); };
    for (let i = 0; i < value.length; i += 4) {
      const a = digit(i), b = digit(i + 1), remaining = length - i / 4 * 3;
      if (remaining === 1) {
        if (value.slice(i + 2) !== "==" || (b & 15)) fail("base64", "noncanonical final octet");
        emit(a << 2 | b >> 4);
      } else {
        const c = digit(i + 2);
        if (remaining === 2) {
          if (value[i + 3] !== "=" || (c & 3)) fail("base64", "noncanonical final pair");
          emit(a << 2 | b >> 4); emit(b << 4 | c >> 2);
        } else {
          const d = digit(i + 3);
          emit(a << 2 | b >> 4); emit(b << 4 | c >> 2); emit(c << 6 | d);
        }
      }
    }
  }
  finish(): Uint8Array {
    if (this.#finished) throw new Error("finished ABI writer");
    if (this.#target) { this.#finished = true; this.#storage?.close(); return this.#target.subarray(0, this.#offset); }
    activeNativeScratch()?.reserve(8 + this.#bytes.length);
    const bytes = new Uint8Array(this.#bytes.length);
    for (let i = 0; i < bytes.length; i++) { this.iteration?.(); bytes[i] = this.#bytes[i]!; }
    this.#finished = true; this.#bytes.length = 0; this.#storage?.close();
    return bytes;
  }
}

class ByteReader {
  #offset = 0;
  private readonly source: Uint8Array;
  constructor(source: Uint8Array) { this.source = source; }
  get remaining(): number { return this.source.byteLength - this.#offset; }
  u8(): number { return this.bytes(1)[0] ?? fail("frame-malformed", "missing octet"); }
  u32(): number {
    const bytes = this.bytes(4);
    return ((bytes[0] ?? 0) * 0x1_000000 + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0)) >>> 0;
  }
  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) fail("frame-malformed", `need ${length}, have ${this.remaining}`);
    const bytes = this.source.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return bytes;
  }
  region(length: number): ByteReader { return new ByteReader(this.bytes(length)); }
}
