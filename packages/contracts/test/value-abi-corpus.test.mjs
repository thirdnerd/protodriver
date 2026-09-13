import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LUA_VALUE_ABI_V1_VALUE_KIND_TAGS } from "../src/lua-value-abi.ts";

const FIXTURE_PATH = process.env.PROTODRIVER_VALUE_ABI_CORPUS
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lua-value-abi-v1.json");

const REQUIRED_MEMBERS = [
  "arbitrary-width-integer",
  "array",
  "binary-safe-bytes",
  "boolean",
  "canonical-record",
  "export-binding",
  "fatal-utf8-text",
  "finite-float",
  "graph-function-separation",
  "host-object-rejection",
  "lone-surrogate-rejection",
  "named-program-failure",
  "negative-zero-rejection",
  "null",
  "non-finite-rejection",
  "pointer-rejection",
  "signed-64-boundaries",
  "tagged-variant",
  "unsigned-64-boundary",
];

const ENVELOPE_KINDS = new Map([
  ["value", 0x01],
  ["admission-result", 0x02],
  ["invoke", 0x03],
  ["program-failure", 0x04],
]);

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function requireObject(value, at) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("value-abi.corpus.shape", `${at} must be an object`);
  }
  return value;
}

function requireArray(value, at) {
  if (!Array.isArray(value)) {
    fail("value-abi.corpus.shape", `${at} must be an array`);
  }
  return value;
}

function requireNonemptyString(value, at) {
  if (typeof value !== "string" || value.length === 0) {
    fail("value-abi.corpus.shape", `${at} must be a nonempty string`);
  }
  return value;
}

function decodeHex(hex, at) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    fail("value-abi.corpus.frame-malformed", `${at} must be nonempty lowercase whole-octet hex`);
  }
  return Uint8Array.from(hex.match(/../g).map((octet) => Number.parseInt(octet, 16)));
}

function readU32(bytes, offset, end, at) {
  if (offset + 4 > end) {
    fail("value-abi.corpus.frame-malformed", `${at} has no complete u32`);
  }
  return ((bytes[offset] * 0x1_000000)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3]) >>> 0;
}

function readText(bytes, offset, end, at) {
  const length = readU32(bytes, offset, end, `${at}.length`);
  const start = offset + 4;
  const next = start + length;
  if (next > end) {
    fail("value-abi.corpus.frame-malformed", `${at} overruns its container`);
  }
  try {
    const value = fatalUtf8.decode(bytes.subarray(start, next));
    if (value.length === 0) {
      fail("value-abi.corpus.frame-malformed", `${at} is empty`);
    }
    return { value, raw: bytes.subarray(start, next), next };
  } catch (error) {
    if (String(error).includes("value-abi.corpus")) throw error;
    fail("value-abi.corpus.frame-malformed", `${at} is not fatal UTF-8`);
  }
}

function bigEndianUnsigned(bytes) {
  let value = 0n;
  for (const octet of bytes) value = (value << 8n) | BigInt(octet);
  return value;
}

function decodeValue(bytes, offset, end, at, observedTags) {
  if (offset + 5 > end) {
    fail("value-abi.corpus.frame-malformed", `${at} has no complete TLV header`);
  }
  const tag = bytes[offset];
  observedTags?.add(tag);
  const length = readU32(bytes, offset + 1, end, `${at}.length`);
  const contentStart = offset + 5;
  const next = contentStart + length;
  if (next > end) {
    fail("value-abi.corpus.frame-malformed", `${at} content overruns its container`);
  }
  const content = bytes.subarray(contentStart, next);
  const exactLength = (wanted) => {
    if (length !== wanted) {
      fail("value-abi.corpus.frame-malformed", `${at} tag ${tag.toString(16)} has length ${length}, expected ${wanted}`);
    }
  };

  if (tag === 0x01 || tag === 0x02) {
    exactLength(0);
    return { node: { kind: "boolean", value: tag === 0x02 }, next };
  }
  if (tag === 0x03) {
    exactLength(8);
    const unsigned = bigEndianUnsigned(content);
    const signed = (unsigned & (1n << 63n)) === 0n ? unsigned : unsigned - (1n << 64n);
    return { node: { kind: "i64", decimal: signed.toString() }, next };
  }
  if (tag === 0x04) {
    exactLength(8);
    return { node: { kind: "u64", decimal: bigEndianUnsigned(content).toString() }, next };
  }
  if (tag === 0x05) {
    if (length < 1
        || (content[0] !== 0 && content[0] !== 1)
        || (length === 1 && content[0] !== 0)
        || (length > 1 && content[1] === 0)) {
      fail("value-abi.corpus.frame-malformed", `${at} arbitrary integer is not minimal sign-and-magnitude`);
    }
    const magnitude = bigEndianUnsigned(content.subarray(1));
    const value = content[0] === 1 ? -magnitude : magnitude;
    return { node: { kind: "integer", decimal: value.toString() }, next };
  }
  if (tag === 0x06) {
    exactLength(8);
    const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
    const value = view.getFloat64(0, false);
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("value-abi.corpus.frame-malformed", `${at} carries a forbidden floating-point value`);
    }
    return { node: { kind: "float64", decimal: String(value) }, next };
  }
  if (tag === 0x07) {
    try {
      return { node: { kind: "text", value: fatalUtf8.decode(content) }, next };
    } catch {
      fail("value-abi.corpus.frame-malformed", `${at} text is not fatal UTF-8`);
    }
  }
  if (tag === 0x08) {
    return { node: { kind: "bytes", hex: Buffer.from(content).toString("hex") }, next };
  }
  if (tag === 0x09) {
    if (length < 4) fail("value-abi.corpus.frame-malformed", `${at} array has no count`);
    const count = readU32(bytes, contentStart, next, `${at}.count`);
    const items = [];
    let cursor = contentStart + 4;
    for (let index = 0; index < count; index += 1) {
      const decoded = decodeValue(bytes, cursor, next, `${at}[${index}]`, observedTags);
      items.push(decoded.node.kind === "boolean" ? decoded.node.value : decoded.node);
      cursor = decoded.next;
    }
    if (cursor !== next) fail("value-abi.corpus.frame-malformed", `${at} array leaves trailing content`);
    return { node: { kind: "array", items }, next };
  }
  if (tag === 0x0a) {
    if (length < 4) fail("value-abi.corpus.frame-malformed", `${at} record has no count`);
    const count = readU32(bytes, contentStart, next, `${at}.count`);
    const entriesInCanonicalOrder = [];
    let priorKey;
    let cursor = contentStart + 4;
    for (let index = 0; index < count; index += 1) {
      const key = readText(bytes, cursor, next, `${at}.key[${index}]`);
      if (priorKey !== undefined && Buffer.compare(priorKey, key.raw) >= 0) {
        fail("value-abi.corpus.frame-malformed", `${at} record keys are not unique canonical UTF-8 byte order`);
      }
      const decoded = decodeValue(bytes, key.next, next, `${at}.${key.value}`, observedTags);
      entriesInCanonicalOrder.push([key.value, decoded.node.kind === "boolean" ? decoded.node.value : decoded.node]);
      priorKey = key.raw;
      cursor = decoded.next;
    }
    if (cursor !== next) fail("value-abi.corpus.frame-malformed", `${at} record leaves trailing content`);
    return { node: { kind: "record", entriesInCanonicalOrder }, next };
  }
  if (tag === 0x0b) {
    const variant = readText(bytes, contentStart, next, `${at}.variant`);
    const decoded = decodeValue(bytes, variant.next, next, `${at}.value`, observedTags);
    if (decoded.next !== next) fail("value-abi.corpus.frame-malformed", `${at} variant leaves trailing content`);
    return {
      node: {
        kind: "variant",
        tag: variant.value,
        value: decoded.node.kind === "boolean" ? decoded.node.value : decoded.node,
      },
      next,
    };
  }
  if (tag === 0x0c) {
    exactLength(0);
    return { node: { kind: "null" }, next };
  }
  fail("value-abi.corpus.frame-malformed", `${at} has unknown value tag 0x${tag.toString(16)}`);
}

function parseFrame(expectedHex, envelopeKind, at) {
  const bytes = decodeHex(expectedHex, `${at}.expectedHex`);
  if (bytes.byteLength < 10
      || Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "PDRV"
      || bytes[4] !== 0x01) {
    fail("value-abi.corpus.frame-malformed", `${at} has the wrong magic or ABI version`);
  }
  const expectedKind = ENVELOPE_KINDS.get(envelopeKind);
  if (expectedKind === undefined || bytes[5] !== expectedKind) {
    fail("value-abi.corpus.frame-malformed", `${at} has the wrong envelope kind`);
  }
  const payloadLength = readU32(bytes, 6, 10, `${at}.payloadLength`);
  if (bytes.byteLength !== 10 + payloadLength) {
    fail(
      "value-abi.corpus.frame-malformed",
      `${at} carries ${bytes.byteLength - 10} payload octets, header declares ${payloadLength}`,
    );
  }
  return { bytes, start: 10, end: bytes.byteLength };
}

function materializePublicValue(node) {
  if (node.kind === "null") return null;
  if (node.kind === "boolean" || node.kind === "text") return node.value;
  if (node.kind === "array") return node.items.map((item) => (
    item !== null && typeof item === "object" ? materializePublicValue(item) : item
  ));
  if (node.kind === "record") {
    return Object.fromEntries(node.entriesInCanonicalOrder.map(([key, value]) => [
      key,
      value !== null && typeof value === "object" ? materializePublicValue(value) : value,
    ]));
  }
  if (node.kind === "variant") {
    return {
      kind: "variant",
      tag: node.tag,
      value: node.value !== null && typeof node.value === "object"
        ? materializePublicValue(node.value)
        : node.value,
    };
  }
  return node;
}

function validateValueCase(entry, at, observedTags) {
  const semantic = entry.semantic;
  const plainObjectInput = semantic !== null
    && typeof semantic === "object"
    && !Array.isArray(semantic)
    && !Object.hasOwn(semantic, "kind");
  if (semantic !== null) requireObject(semantic, `${at}.semantic`);
  assert.deepEqual(
    entry.directions,
    plainObjectInput ? ["host-to-vm"] : ["host-to-vm", "vm-to-host"],
    plainObjectInput
      ? `${at} plain-object spelling is a host-to-VM input`
      : `${at} must cover both directions`,
  );
  assert.equal(entry.envelopeKind, "value", `${at} must use the value envelope`);
  const frame = parseFrame(entry.expectedHex, entry.envelopeKind, at);
  const decoded = decodeValue(frame.bytes, frame.start, frame.end, `${at}.value`, observedTags);
  if (decoded.next !== frame.end) fail("value-abi.corpus.frame-malformed", `${at} leaves trailing payload`);
  const observed = semantic !== null && Object.hasOwn(semantic, "kind")
    ? decoded.node
    : materializePublicValue(decoded.node);
  assert.deepEqual(observed, semantic, `${at} hand-authored octets do not encode their stated semantic value`);
}

function validateEnvelopeCase(entry, at, observedTags) {
  const frame = parseFrame(entry.expectedHex, entry.envelopeKind, at);
  let cursor = frame.start;
  if (entry.envelopeKind === "admission-result") {
    const graph = decodeValue(frame.bytes, cursor, frame.end, `${at}.graph`, observedTags);
    cursor = graph.next;
    const count = readU32(frame.bytes, cursor, frame.end, `${at}.exportCount`);
    cursor += 4;
    const exportsInCanonicalOrder = [];
    let prior;
    for (let index = 0; index < count; index += 1) {
      const item = readText(frame.bytes, cursor, frame.end, `${at}.exports[${index}]`);
      if (prior !== undefined && Buffer.compare(prior, item.raw) >= 0) {
        fail("value-abi.corpus.frame-malformed", `${at} exports are not unique canonical UTF-8 byte order`);
      }
      exportsInCanonicalOrder.push(item.value);
      prior = item.raw;
      cursor = item.next;
    }
    assert.deepEqual(
      { kind: "admission-result", graph: materializePublicValue(graph.node), exportsInCanonicalOrder },
      entry.semantic,
      `${at} hand-authored octets do not encode their stated admission result`,
    );
  } else if (entry.envelopeKind === "invoke") {
    const exportName = readText(frame.bytes, cursor, frame.end, `${at}.exportName`);
    const input = decodeValue(frame.bytes, exportName.next, frame.end, `${at}.input`, observedTags);
    cursor = input.next;
    assert.deepEqual(
      { kind: "invoke", exportName: exportName.value, input: materializePublicValue(input.node) },
      entry.semantic,
      `${at} hand-authored octets do not encode their stated invocation`,
    );
  } else if (entry.envelopeKind === "program-failure") {
    const name = readText(frame.bytes, cursor, frame.end, `${at}.name`);
    const details = decodeValue(frame.bytes, name.next, frame.end, `${at}.details`, observedTags);
    cursor = details.next;
    assert.deepEqual(
      { kind: "program-failure", name: name.value, details: details.node.value },
      entry.semantic,
      `${at} hand-authored octets do not encode their stated program failure`,
    );
  } else {
    fail("value-abi.corpus.shape", `${at} is not an envelope case`);
  }
  if (cursor !== frame.end) fail("value-abi.corpus.frame-malformed", `${at} leaves trailing payload`);
}

function validateMalformedFrame(entry, at) {
  const expectedDiagnostic = requireNonemptyString(entry.expectedDiagnostic, `${at}.expectedDiagnostic`);
  let error;
  try {
    const frame = parseFrame(entry.expectedHex, entry.envelopeKind, at);
    const decoded = decodeValue(frame.bytes, frame.start, frame.end, `${at}.value`);
    if (decoded.next !== frame.end) fail("value-abi.corpus.frame-malformed", `${at} leaves trailing payload`);
  } catch (cause) {
    error = cause;
  }
  if (!(error instanceof Error) || !error.message.startsWith(`${expectedDiagnostic}:`)) {
    fail(
      "value-abi.corpus.rejection-missed",
      `${at} expected ${expectedDiagnostic}, observed ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateCorpus(corpus) {
  requireObject(corpus, "corpus");
  assert.equal(corpus.corpusId, "pdrv-value-abi-v1");
  assert.equal(corpus.claimLevel, "hand-authored-structural-and-two-host-bridge-conformance-corpus");
  const valueCases = requireArray(corpus.valueCases, "valueCases");
  const envelopeCases = requireArray(corpus.envelopeCases, "envelopeCases");
  const malformedFrames = requireArray(corpus.malformedFrames, "malformedFrames");
  const rejections = requireArray(corpus.rejections, "rejections");
  const entries = [...valueCases, ...envelopeCases, ...malformedFrames, ...rejections];
  if (entries.length === 0) fail("value-abi.corpus.empty", "the corpus has no cases");

  const ids = new Set();
  const encodings = new Set();
  const members = new Set();
  for (const [index, entryValue] of entries.entries()) {
    const entry = requireObject(entryValue, `entries[${index}]`);
    const id = requireNonemptyString(entry.id, `entries[${index}].id`);
    if (ids.has(id)) fail("value-abi.corpus.case-duplicate", `case ${id} appears more than once`);
    ids.add(id);
    const caseMembers = requireArray(entry.members, `${id}.members`);
    if (caseMembers.length === 0) fail("value-abi.corpus.shape", `${id}.members must not be empty`);
    for (const member of caseMembers) members.add(requireNonemptyString(member, `${id}.members[]`));
    if (Object.hasOwn(entry, "expectedHex")) {
      if (encodings.has(entry.expectedHex)) {
        fail("value-abi.corpus.case-duplicate", `encoding ${entry.expectedHex} appears more than once`);
      }
      encodings.add(entry.expectedHex);
    }
  }
  for (const member of REQUIRED_MEMBERS) {
    if (!members.has(member)) fail("value-abi.corpus.member-missing", `required member ${member} is absent`);
  }

  const observedValueTags = new Set();
  valueCases.forEach((entry, index) => validateValueCase(entry, `valueCases[${index}]`, observedValueTags));
  envelopeCases.forEach((entry, index) => {
    requireNonemptyString(entry.direction, `envelopeCases[${index}].direction`);
    validateEnvelopeCase(entry, `envelopeCases[${index}]`, observedValueTags);
  });
  const declaredValueTags = Object.values(LUA_VALUE_ABI_V1_VALUE_KIND_TAGS);
  if (declaredValueTags.length === 0 || new Set(declaredValueTags).size !== declaredValueTags.length) {
    fail("value-abi.corpus.kind-authority", "the value-kind authority is empty or duplicates a tag");
  }
  for (const tag of declaredValueTags) {
    if (!observedValueTags.has(tag)) {
      fail("value-abi.corpus.kind-missing", `declared value tag 0x${tag.toString(16)} has no positive corpus frame`);
    }
  }
  for (const tag of observedValueTags) {
    if (!declaredValueTags.includes(tag)) {
      fail("value-abi.corpus.kind-undeclared", `corpus observes undeclared value tag 0x${tag.toString(16)}`);
    }
  }
  malformedFrames.forEach((entry, index) => {
    requireNonemptyString(entry.direction, `malformedFrames[${index}].direction`);
    validateMalformedFrame(entry, `malformedFrames[${index}]`);
  });
  rejections.forEach((entry, index) => {
    requireNonemptyString(entry.direction, `rejections[${index}].direction`);
    requireNonemptyString(entry.reason, `rejections[${index}].reason`);
    requireObject(entry.semantic, `rejections[${index}].semantic`);
    if (Object.hasOwn(entry, "expectedHex")) {
      fail("value-abi.corpus.shape", `rejection ${entry.id} must not carry an expected encoding`);
    }
  });
}

test("hand-authored Lua value ABI v1 corpus stays structurally complete and fail-closed independently of its bridges", async () => {
  const corpus = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  validateCorpus(corpus);
});
