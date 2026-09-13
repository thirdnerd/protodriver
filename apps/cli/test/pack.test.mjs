import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPdpkg, verifyLuaSourceSet } from "@protodriver/contracts";

const pdr = new URL("../src/pdr.ts", import.meta.url).pathname;
const fixtureDevice = new URL(
  "../../../examples/start/device.lua",
  import.meta.url,
).pathname;

function run(cwd, args) {
  const child = spawn(process.execPath, [pdr, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("pdr pack is deterministic across runs and working directories and admits by content", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pdr-pack-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const roots = [join(scratch, "left"), join(scratch, "right")];
  for (const [index, root] of roots.entries()) {
    await mkdir(join(root, "source"), { recursive: true });
    const devicePath = join(root, "source", "device.lua");
    await copyFile(fixtureDevice, devicePath);
    const time = new Date(index === 0 ? "2001-01-01T00:00:00Z" : "2031-01-01T00:00:00Z");
    await utimes(devicePath, time, time);
  }

  const builds = [];
  builds.push(await run(roots[0], ["pack", "source", "first.package-data"]));
  builds.push(await run(roots[0], ["pack", "source", "second.package-data"]));
  builds.push(await run(roots[1], ["pack", "source", "third.package-data"]));
  builds.push(await run(roots[1], ["pack", "source", "fourth.package-data"]));
  for (const result of builds) {
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /source-set sha256:[0-9a-f]{64}/u);
  }

  const archives = await Promise.all([
    readFile(join(roots[0], "first.package-data")),
    readFile(join(roots[0], "second.package-data")),
    readFile(join(roots[1], "third.package-data")),
    readFile(join(roots[1], "fourth.package-data")),
  ]);
  for (const archive of archives.slice(1)) assert.deepEqual(archive, archives[0]);

  const read = await readPdpkg(new Uint8Array(archives[0]));
  assert.deepEqual(read.claimLevels, { integrity: "reached" });
  assert.match((await verifyLuaSourceSet(read)).identity.hex, /^[0-9a-f]{64}$/u);

  const admitted = await run(roots[0], ["inspect", "first.package-data"]);
  assert.equal(admitted.exitCode, 0);
  assert.equal(admitted.signal, null);
  assert.equal(admitted.stderr, "");
  assert.match(admitted.stdout, /^Blank device starting point /mu);
});

test("pdr pack emits the sole authored contract", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pdr-pack-authored-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const source = new URL("../../../corpus/ti84-plus-ce/", import.meta.url).pathname;
  const archive = join(scratch, "ti84-plus-ce.pdpkg");
  const packed = await run(scratch, ["pack", source, archive]);
  assert.equal(packed.exitCode, 0);
  assert.equal(packed.stderr, "");
  const read = await readPdpkg(new Uint8Array(await readFile(archive)));
  assert.equal(read.bootstrap.generatorContract, "supported");

  const admitted = await run(scratch, ["run", archive, "--help"]);
  assert.equal(admitted.exitCode, 0);
  assert.equal(admitted.stderr, "");
  assert.match(admitted.stdout, /^ti84-plus-ce \(ti84-plus-ce, device\/v2\)$/mu);
});
