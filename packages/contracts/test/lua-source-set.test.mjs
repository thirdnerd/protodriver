import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  frameLuaSourceSetIdentityBytes,
  LuaSourceSetVerificationError,
  verifyLuaSourceSet,
} from "../src/lua-source-set.ts";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "lua-source-set-v1.json",
);
const SUPPORTED_BOOTSTRAP = Object.freeze({
  packageFormat: "supported",
  generatorContract: "supported",
});
const utf8 = new TextEncoder();

function member(logicalName, source) {
  return { logicalName, sourceBytes: typeof source === "string" ? utf8.encode(source) : source };
}

async function verify(members, bootstrap = SUPPORTED_BOOTSTRAP) {
  return verifyLuaSourceSet({ bootstrap, members });
}

async function rejectsWith(code, action) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof LuaSourceSetVerificationError);
    assert.equal(error.diagnostic.code, code);
    return true;
  });
}

test("hand-authored source-set frame and independently computed identity match", async () => {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const members = fixture.members.map((entry) => member(
    entry.logicalName,
    Uint8Array.from(entry.sourceHex.match(/../g).map((octet) => Number.parseInt(octet, 16))),
  ));

  const frame = frameLuaSourceSetIdentityBytes(members);
  assert.equal(Buffer.from(frame).toString("hex"), fixture.expectedCanonicalFrameHex);
  const verified = await verify(members);
  assert.deepEqual(verified.identity, { algorithm: "sha256", hex: fixture.expectedSha256 });
  assert.equal(verified.entryLogicalName, "device.lua");
  assert.equal(new TextDecoder().decode(verified.sourceBytes("device.lua")), "return 1\n");
  assert.equal(verified.sourceBytes("absent.lua"), undefined);

  const firstCopy = verified.sourceBytes("device.lua");
  firstCopy[0] ^= 0xff;
  assert.equal(new TextDecoder().decode(verified.sourceBytes("device.lua")), "return 1\n");
});

test("renaming one source with contents unchanged changes source-set identity", async () => {
  const original = await verify([
    member("device.lua", "return require('helper.lua')\n"),
    member("helper.lua", "return 7\n"),
  ]);
  const renamed = await verify([
    member("device.lua", "return require('helper.lua')\n"),
    member("renamed-helper.lua", "return 7\n"),
  ]);
  assert.notEqual(renamed.identity.hex, original.identity.hex);
});

test("swapping two named sources' contents changes source-set identity", async () => {
  const original = await verify([
    member("device.lua", "return 1\n"),
    member("helper.lua", "return 2\n"),
  ]);
  const swapped = await verify([
    member("device.lua", "return 2\n"),
    member("helper.lua", "return 1\n"),
  ]);
  assert.notEqual(swapped.identity.hex, original.identity.hex);
});

test("a source set without device.lua fails before a VM exists", async () => {
  await rejectsWith("lua-source-set.entry.missing", () => verify([
    member("helper.lua", "return 1\n"),
  ]));
});

test("a duplicate logical source name fails before a VM exists", async () => {
  await rejectsWith("lua-source-set.logical-name.duplicate", () => verify([
    member("device.lua", "return 1\n"),
    member("device.lua", "return 2\n"),
  ]));
});

test("an unsupported compatibility bootstrap fails before source validation", async () => {
  await rejectsWith("lua-source-set.bootstrap.package-format-unsupported", () => verify(
    [member("device.lua", Uint8Array.of(0xff))],
    { packageFormat: "unsupported", generatorContract: "supported" },
  ));
  await rejectsWith("lua-source-set.bootstrap.generator-contract-unsupported", () => verify(
    [member("device.lua", Uint8Array.of(0xff))],
    { packageFormat: "supported", generatorContract: "unsupported" },
  ));
});

test("an empty source set fails closed before a VM exists", async () => {
  await rejectsWith("lua-source-set.empty", () => verify([]));
});

test("source bytes which are not fatal UTF-8 fail before a VM exists", async () => {
  await rejectsWith("lua-source-set.source.invalid-utf8", () => verify([
    member("device.lua", Uint8Array.of(0x61, 0xff, 0x62)),
  ]));
});

test("a logical name which is not a Unicode scalar string fails before framing", async () => {
  await rejectsWith("lua-source-set.logical-name.invalid-utf8", () => verify([
    member("device.lua", "return 1\n"),
    member("bad\ud800.lua", "return 2\n"),
  ]));
});

test("archive order cannot affect identity or become a source-table enumeration surface", async () => {
  const forward = await verify([
    member("device.lua", "return 1\n"),
    member("helper.lua", "return 2\n"),
  ]);
  const reverse = await verify([
    member("helper.lua", "return 2\n"),
    member("device.lua", "return 1\n"),
  ]);
  assert.equal(reverse.identity.hex, forward.identity.hex);
  assert.deepEqual(Object.keys(forward).sort(), ["entryLogicalName", "identity"]);
  assert.equal(Symbol.iterator in forward, false);
  assert.equal("members" in forward, false);
  assert.equal("logicalNames" in forward, false);
});
