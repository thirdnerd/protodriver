import assert from "node:assert/strict";
import test from "node:test";

import { NativeScratch, StandaloneNativeData, withNativeScratch } from "../src/native-account.ts";
import { decodeLuaValueAbiFrame, encodeLuaValueAbiFrame } from "../src/value-abi.ts";

// Build the wire iteratively so the probe itself has no recursive JS frame.
function nestedArrayFrame(depth) {
  const payloadLength = 9 * depth + 5;
  const frame = new Uint8Array(10 + payloadLength);
  frame.set([0x50, 0x44, 0x52, 0x56, 0x01, 0x01]);
  const view = new DataView(frame.buffer);
  view.setUint32(6, payloadLength);
  for (let index = 0; index < depth; index += 1) {
    const offset = 10 + 9 * index;
    frame[offset] = 0x09;
    view.setUint32(offset + 1, 9 * (depth - index));
    view.setUint32(offset + 5, 1);
  }
  frame[10 + 9 * depth] = 0x0c;
  return frame;
}

function nestedArrayValue(depth) {
  let value = null;
  for (let index = 0; index < depth; index += 1) value = { kind: "array", items: [value] };
  return value;
}

function depthRefusal(error) {
  assert.equal(error.code, "lua-vm.resource.depth-limit");
  assert.match(error.message, /ABI value exceeds 128 nested levels/u);
  return true;
}

test("ABI encoder and decoder admit 128 nested arrays and refuse the 129th", () => {
  const admitted = encodeLuaValueAbiFrame("value", nestedArrayValue(128));
  assert.deepEqual(admitted, nestedArrayFrame(128));
  assert.equal(decodeLuaValueAbiFrame(admitted).envelopeKind, "value");
  assert.throws(() => encodeLuaValueAbiFrame("value", nestedArrayValue(129)), depthRefusal);
  assert.throws(() => decodeLuaValueAbiFrame(nestedArrayFrame(129)), depthRefusal);
});

test("a deeply nested frame refuses by depth before the native work or data budget", () => {
  let work = 0;
  const scratch = new NativeScratch(new StandaloneNativeData(), units => {
    work += units;
    if (work > 100_000) throw new Error("retained.work-exhausted");
  });
  try {
    assert.throws(() => withNativeScratch(scratch, () => decodeLuaValueAbiFrame(nestedArrayFrame(8192))), depthRefusal);
    assert.ok(work < 100_000);
  } finally {
    scratch.close();
  }
});
