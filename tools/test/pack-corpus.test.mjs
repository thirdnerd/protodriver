import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { readPdpkg } from "../../packages/contracts/src/pdpkg.ts";
import { verifyLuaSourceSet } from "../../packages/contracts/src/lua-source-set.ts";
import { discoverLuaDeviceModules, loadDiscoveredLuaSourceSet } from "./lua-device-discovery.mjs";
import { packCorpusDirectory, packCorpusModule } from "../pack-corpus.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("pack-corpus writes one admitted identity-preserving package per module", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "protodriver-pack-corpus-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const modules = await discoverLuaDeviceModules(repositoryRoot);
  const packed = await packCorpusDirectory(resolve(repositoryRoot, "corpus"), outputDirectory);

  assert.deepEqual(packed.map(({ name }) => name), modules.map(({ name }) => name));
  assert.deepEqual(
    (await readdir(outputDirectory)).sort(),
    modules.map(({ name }) => `${name}.pdpkg`).sort(),
  );
  for (const module of modules) {
    const archive = new Uint8Array(await readFile(resolve(outputDirectory, `${module.name}.pdpkg`)));
    assert.deepEqual([...archive.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    const [directory, packageSourceSet] = await Promise.all([
      verifyLuaSourceSet(await loadDiscoveredLuaSourceSet(module)),
      readPdpkg(archive).then(verifyLuaSourceSet),
    ]);
    assert.deepEqual(packageSourceSet.identity, directory.identity);
    assert.equal((await readPdpkg(archive)).bootstrap.generatorContract, "supported");
    assert.deepEqual((await readPdpkg(archive)).claimLevels, { integrity: "reached" });
    assert.deepEqual(
      (await packCorpusModule(module.sourceDirectory)).archive,
      archive,
      "packing the same source set twice must remain byte-identical",
    );
  }
});
