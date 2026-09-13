import assert from "node:assert/strict";
import test from "node:test";
import { encodeLuaProgramInvocation, encodeLuaProgramInvocationInto } from "../src/value-abi.ts";

const leaf = (bytes, direct) => direct ? { kind: "bytes-base64", value: Buffer.from(bytes).toString("base64") }
  : { kind: "bytes", hex: Buffer.from(bytes).toString("hex") };
const nested = value => ({ kind: "record", entriesInCanonicalOrder: [["arguments", { kind: "array", items: [
  { kind: "variant", tag: "selected", value }, { kind: "i64", decimal: "-7" }, { kind: "text", value: "é" }] }], ["tail", true]] });

test("direct source framing is byte-identical, including nested lengths and all final quartet shapes", () => {
  for (const length of [0, 1, 2, 3, 255, 256, 257, 4096]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    const expected = encodeLuaProgramInvocation("dispatch", nested(leaf(bytes, false)));
    const target = new Uint8Array(expected.length + 8).fill(0xa5);
    const size = encodeLuaProgramInvocationInto("dispatch", nested(leaf(bytes, true)), target, () => {});
    assert.deepEqual(target.subarray(0, size), expected);
    assert.deepEqual([...target.subarray(size)], Array(8).fill(0xa5));
    assert.throws(() => encodeLuaProgramInvocationInto("dispatch", nested(leaf(bytes, true)), new Uint8Array(size - 1), () => {}), /capacity/);
  }
});

test("one payload pass stays charged; insufficient work cannot publish the final source octet", () => {
  const bytes = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
  const expected = encodeLuaProgramInvocation("dispatch", leaf(bytes, false));
  let overhead = 0;
  encodeLuaProgramInvocationInto("dispatch", leaf([], true), new Uint8Array(100), () => overhead++);
  let work = 0;
  const target = new Uint8Array(expected.length);
  assert.equal(encodeLuaProgramInvocationInto("dispatch", leaf(bytes, true), target, () => work++), expected.length);
  assert.deepEqual(target, expected);
  let consumed = 0, published;
  const limited = new Uint8Array(expected.length).fill(0xa5);
  try { published = encodeLuaProgramInvocationInto("dispatch", leaf(bytes, true), limited, () => {
    if (++consumed > overhead + bytes.length - 1) throw new Error("work exhausted");
  }); } catch (cause) { assert.match(cause.message, /work exhausted/); }
  assert.equal(limited.at(-1), 0xa5, "underfunded writer emitted the forbidden final octet");
  assert.equal(published, undefined);
  assert.equal(work - overhead, bytes.length, "each added source octet takes exactly one writer iteration");
});

test("direct base64 leaf rejects noncanonical and misplaced padding, not silent prefix decoding", () => {
  for (const value of ["A", "AA=", "AB==", "AAB=", "AA==AAAA", "AA_A", "===="])
    assert.throws(() => encodeLuaProgramInvocationInto("dispatch", { kind: "bytes-base64", value }, new Uint8Array(100), () => {}), /base64/);
  assert.throws(() => encodeLuaProgramInvocation("dispatch", leaf([1], true)), /restricted/);
});
