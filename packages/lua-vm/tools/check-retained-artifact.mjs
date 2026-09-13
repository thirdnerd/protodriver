#!/usr/bin/env node
// A committed binary is trustworthy only while its recorded local inputs and
// rebuild recipe still describe the bytes in this tree.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RETAINED_LUA_BUILD_RECIPE as recipe } from "../src/index.ts";
import { RETAINED_VM_SHA256 } from "../src/retained.ts";
import { isMainModule } from "../../generated-cli/src/node-entry-point.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function checkRetainedLuaArtifact(root = packageRoot, expectedRecipe = recipe) {
  const artifact = await readFile(resolve(root, "artifacts/protodriver-retained-v2.wasm"));
  const record = JSON.parse(await readFile(resolve(root, "artifacts/protodriver-retained-v2.wasm.json"), "utf8"));
  const expectedCompiler = `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${expectedRecipe.emscripten.version} (${expectedRecipe.emscripten.commit})`;
  const expectedFlags = [...expectedRecipe.inputs.flags, '-sEXPORTED_FUNCTIONS=["_malloc","_free"]'];
  for (const [field, observed, expected] of [
    ["sha256", digest(artifact), RETAINED_VM_SHA256],
    ["record.sha256", record.sha256, RETAINED_VM_SHA256],
    ["bytes", artifact.length, record.bytes],
    ["compiler", record.compiler, expectedCompiler],
    ["flags", JSON.stringify(record.flags), JSON.stringify(expectedFlags)],
    ["luaSourceSetSha256", record.luaSourceSetSha256, expectedRecipe.lua.sourceSetSha256],
    ["baseBridgeSha256", record.baseBridgeSha256, expectedRecipe.inputs.bridgeSha256],
  ]) {
    if (observed !== expected) throw new Error(`lua-vm.retained.${field}-mismatch: expected ${expected}, observed ${observed}`);
  }
  for (const [path, field] of [
    ["bridge/pdrv_retained.c", "bridgeSha256"],
    ["bridge/pdrv_retained_account.h", "accountHeaderSha256"],
    ["bridge/pdrv_lua_vm.c", "baseBridgeSha256"],
  ]) {
    const observed = digest(await readFile(resolve(root, path)));
    if (observed !== record[field]) {
      throw new Error(`lua-vm.retained.input-mismatch: ${path} expected ${record[field]}, observed ${observed}`);
    }
  }
  const verifier = digest(await readFile(resolve(root, "tools/verify-lua-source.mjs")));
  if (verifier !== expectedRecipe.inputs.sourceVerifierSha256) {
    throw new Error(`lua-vm.retained.input-mismatch: tools/verify-lua-source.mjs expected ${expectedRecipe.inputs.sourceVerifierSha256}, observed ${verifier}`);
  }
  // These diagnostic exports need no host authority. Forbid every import
  // except Emscripten's memory-growth notice, so the probe runs inside the VM.
  const forbidden = () => { throw new Error("lua-vm.retained.unexpected-host-call"); };
  const { instance } = await WebAssembly.instantiate(artifact, {
    env: {
      pdrv_retained_release: forbidden,
      pdrv_retained_work: forbidden,
      pdrv_lua_require_source: forbidden,
      pdrv_retained_reserve: forbidden,
      pdrv_retained_charge_work: forbidden,
      emscripten_notify_memory_growth() {},
      __syscall_dup3: forbidden,
    },
    wasi_snapshot_preview1: {
      fd_read: forbidden, fd_write: forbidden, fd_close: forbidden, fd_seek: forbidden,
    },
  });
  const exports = instance.exports;
  if (typeof exports._initialize !== "function") throw new Error("lua-vm.retained.export-missing: _initialize");
  exports._initialize();
  const seedHex = expectedRecipe.lua.deterministicSeedHex;
  if (!/^[0-9a-fA-F]{8}$/u.test(seedHex)) throw new Error(`lua-vm.retained.seed-invalid: ${seedHex}`);
  for (const [field, name, expected] of [
    ["artifact-contract", "pdrv_lua_vm_artifact_contract", expectedRecipe.expectedVm.artifactContract],
    ["integer-bits", "pdrv_lua_integer_bits", expectedRecipe.lua.integerBits],
    ["number-bits", "pdrv_lua_number_bits", expectedRecipe.lua.numberBits],
    ["seed", "pdrv_lua_seed", Number.parseInt(seedHex, 16)],
    ["smoke", "pdrv_lua_vm_smoke", expectedRecipe.expectedVm.smokeResult],
  ]) {
    const probe = exports[name];
    if (typeof probe !== "function") throw new Error(`lua-vm.retained.export-missing: ${name}`);
    const observed = probe();
    if (observed !== expected) throw new Error(`lua-vm.retained.${field}-mismatch: expected ${expected}, observed ${observed}`);
  }
  return Object.freeze({ sha256: RETAINED_VM_SHA256, bytes: artifact.length });
}

if (await isMainModule(import.meta.url)) {
  checkRetainedLuaArtifact().then(result => {
    process.stdout.write(`lua-vm-retained: ${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
