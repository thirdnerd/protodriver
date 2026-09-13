import assert from "node:assert/strict";
import test from "node:test";

import { DefaultValueCodec } from "../src/values.ts";

const descriptor = {
  kind: "record",
  fields: {
    flags: {
      kind: "flags",
      members: ["read", "verify", "write"],
    },
    counter: {
      kind: "integer",
      widthBits: 64,
      signed: false,
    },
    bytes: {
      kind: "bytes",
    },
  },
};

const internal = {
  flags: new Set(["write", "read"]),
  counter: 0xfedcba9876543210n,
  bytes: new Uint8Array([0x00, 0xff, 0x55, 0xaa, 0x10]),
};

const expectedPublic = {
  flags: ["read", "write"],
  counter: { type: "u64", value: "18364758544493064720" },
  bytes: { type: "bytes", encoding: "base64", value: "AP9VqhA=" },
};

function assertInternal(actual) {
  assert.deepStrictEqual(actual.flags, internal.flags);
  assert.equal(actual.counter, internal.counter);
  assert.deepStrictEqual(actual.bytes, internal.bytes);
}

test("flags, u64, and bytes preserve identity through RPC and public JSON", () => {
  const codec = new DefaultValueCodec();

  const rpc = codec.toRpc(internal, descriptor);
  const clonedRpc = structuredClone(rpc);
  assertInternal(codec.fromRpc(clonedRpc, descriptor));
  assert.deepStrictEqual(codec.toRpc(codec.fromRpc(clonedRpc, descriptor), descriptor), rpc);

  const publicValue = codec.toPublic(internal, descriptor);
  assert.deepStrictEqual(publicValue, expectedPublic);
  const parsedPublic = JSON.parse(JSON.stringify(publicValue));
  assertInternal(codec.fromPublic(parsedPublic, descriptor));
  assert.deepStrictEqual(
    codec.toPublic(codec.fromPublic(parsedPublic, descriptor), descriptor),
    expectedPublic,
  );
});
