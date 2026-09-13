import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RETAINED_LUA_BUILD_RECIPE as recipe } from "../src/index.ts";
import { checkRetainedLuaArtifact } from "../tools/check-retained-artifact.mjs";
import { luaSourceAnchor } from "../tools/verify-lua-source.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const inputs = [
  "bridge/pdrv_retained.c",
  "bridge/pdrv_retained_account.h",
  "bridge/pdrv_lua_vm.c",
  "tools/verify-lua-source.mjs",
];

test("committed retained VM and every recorded local source agree", async () => {
  assert.deepEqual(await checkRetainedLuaArtifact(), {
    sha256: "f0646d258acf98a02eabf678aea7ae90f118fca6e1014515ffbdb95987c54e37",
    bytes: 380227,
  });
});

test("source verifier uses the recipe's sole member count and refuses a missing member", async t => {
  const source = await mkdtemp(join(tmpdir(), "lua-source-count-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: recipe.lua.sourceMemberCount }, (_, index) =>
    writeFile(join(source, `member-${index}.c`), "")));
  assert.equal((await luaSourceAnchor(source)).memberCount, recipe.lua.sourceMemberCount);
  await rm(join(source, "member-0.c"));
  await assert.rejects(luaSourceAnchor(source),
    new RegExp(`lua-vm\\.source\\.member-count: expected ${recipe.lua.sourceMemberCount} \\.c/\\.h members, observed ${recipe.lua.sourceMemberCount - 1}`));
});

for (const [field, altered, diagnostic] of [
  ["integerBits", 32, "integer-bits"],
  ["numberBits", 32, "number-bits"],
  ["deterministicSeedHex", "50445257", "seed"],
]) {
  test(`retained VM refuses a wrong recipe ${field}`, async () => {
    await assert.rejects(
      checkRetainedLuaArtifact(packageRoot, { ...recipe, lua: { ...recipe.lua, [field]: altered } }),
      new RegExp(`lua-vm\\.retained\\.${diagnostic}-mismatch`),
    );
  });
}

for (const [field, altered, diagnostic] of [
  ["artifactContract", 12, "artifact-contract"],
  ["smokeResult", 41, "smoke"],
]) {
  test(`retained VM refuses a wrong recipe ${field}`, async () => {
    await assert.rejects(
      checkRetainedLuaArtifact(packageRoot, { ...recipe, expectedVm: { ...recipe.expectedVm, [field]: altered } }),
      new RegExp(`lua-vm\\.retained\\.${diagnostic}-mismatch`),
    );
  });
}

for (const changed of inputs) {
  test(`retained input guard rejects drift in ${changed}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "retained-input-guard-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const path of [...inputs, "artifacts/protodriver-retained-v2.wasm", "artifacts/protodriver-retained-v2.wasm.json"]) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), await readFile(resolve(packageRoot, path)));
    }
    await writeFile(resolve(root, changed), Buffer.concat([await readFile(resolve(root, changed)), Buffer.from("\n") ]));
    await assert.rejects(checkRetainedLuaArtifact(root), new RegExp(`lua-vm\\.retained\\.input-mismatch: ${changed.replaceAll(".", "\\.")}`));
  });
}
