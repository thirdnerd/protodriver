import { readFile, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { RETAINED_LUA_BUILD_RECIPE as recipe } from "../src/index.ts";
import { isMainModule } from "../../generated-cli/src/node-entry-point.ts";

export async function build(luaSource, emcc, output) {
  if (!luaSource || !emcc || !output) throw new Error("usage: build-retained.mjs LUA_SOURCE EMCC NEW_OUTPUT.wasm");
  for (const path of [output, output + ".json"]) {
    try { await access(path); throw new Error("output already exists: " + path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  execFileSync(process.execPath, [resolve(import.meta.dirname, "verify-lua-source.mjs"), "--source", luaSource, "--expect", recipe.lua.sourceSetSha256]);
  const compiler = execFileSync(emcc, ["--version"], { encoding: "utf8" }).split("\n")[0];
  if (compiler !== `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${recipe.emscripten.version} (${recipe.emscripten.commit})`) throw new Error("wrong compiler");
  const bridge = resolve(import.meta.dirname, "../bridge/pdrv_retained.c");
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const baseBridge = await readFile(resolve(import.meta.dirname, "../bridge/pdrv_lua_vm.c"));
  if (digest(baseBridge) !== recipe.inputs.bridgeSha256) throw new Error("base bridge differs from build recipe");
  const sourceVerifier = await readFile(resolve(import.meta.dirname, "verify-lua-source.mjs"));
  if (digest(sourceVerifier) !== recipe.inputs.sourceVerifierSha256) throw new Error("Lua source verifier differs from build recipe");
  const accountHeader = await readFile(resolve(import.meta.dirname, "../bridge/pdrv_retained_account.h"));
  const flags = [...recipe.inputs.flags, '-sEXPORTED_FUNCTIONS=["_malloc","_free"]'];
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC", SOURCE_DATE_EPOCH: "0" };
  for (const key of ["CFLAGS", "CPPFLAGS", "CXXFLAGS", "LDFLAGS", "EMCC_CFLAGS"]) delete env[key];
  execFileSync(emcc, [...flags, "-I", luaSource, bridge, ...recipe.inputs.compiledLuaSources.map(name => resolve(luaSource, name)), "-o", output], { env, stdio: "inherit", timeout: 120000 });
  const bytes = await readFile(output);
  await writeFile(output + ".json", JSON.stringify({ sha256: digest(bytes), bytes: bytes.length, compiler, flags,
    bridgeSha256: digest(await readFile(bridge)), accountHeaderSha256: digest(accountHeader),
    baseBridgeSha256: digest(baseBridge), luaSourceSetSha256: recipe.lua.sourceSetSha256 }, null, 2) + "\n", { flag: "wx" });
}
if (await isMainModule(import.meta.url)) await build(...process.argv.slice(2));
