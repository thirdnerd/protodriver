import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  darwinTarArguments,
  inspectMachOArchitectures,
  verifyTargetNativeArchitectures,
} from "../package-cli.mjs";
import { darwinIoctlCompileArguments } from "../package/build-darwin-ioctl.mjs";
import { darwinPackageTarget } from "../package/darwin-targets.mjs";
import {
  macosSmokeInvocation,
  stageMacosPackageSmokePayload,
} from "../smoke-package-macos.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Darwin targets pin both runtimes, universal prebuilds, and architecture-specific ioctl builds", async () => {
  const arm64 = darwinPackageTarget("darwin-arm64");
  const x64 = darwinPackageTarget("darwin-x64");
  assert.equal(arm64.archiveFormat, "tar.gz");
  assert.equal(x64.archiveFormat, "tar.gz");
  assert.deepEqual(
    [arm64.manifestTarget.minimumMacos, x64.manifestTarget.minimumMacos],
    ["13.5", "13.5"],
  );
  assert.equal(arm64.node.binarySha256, "ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a");
  assert.equal(x64.node.binarySha256, "c5afe80c9fd47c0e1ba3a7221173d061dae04577acc67e21e945d16e34c696c8");

  for (const input of [arm64.nativeInputs.serialport, arm64.nativeInputs.usb]) {
    assert.deepEqual(
      await inspectMachOArchitectures(join(repositoryRoot, input.source)),
      ["x86_64", "arm64"],
    );
  }
  const armCompile = darwinIoctlCompileArguments({
    target: arm64,
    nodeRuntimeRoot: "/runtime/arm64",
    sourceDirectory: "/source",
  });
  const x64Compile = darwinIoctlCompileArguments({
    target: x64,
    nodeRuntimeRoot: "/runtime/x64",
    sourceDirectory: "/source",
  });
  assert.deepEqual(armCompile.arguments.slice(3, 5), ["-arch", "arm64"]);
  assert.deepEqual(x64Compile.arguments.slice(3, 5), ["-arch", "x86_64"]);
  assert.ok(armCompile.arguments.includes("-mmacosx-version-min=13.5"));
  assert.ok(x64Compile.arguments.includes("-mmacosx-version-min=13.5"));
  assert.notEqual(armCompile.output, x64Compile.output);
  const tarArguments = darwinTarArguments({
    outputPath: "/output/package.tar",
    scratch: "/scratch",
    listPath: "/output/files.txt",
  });
  assert.ok(tarArguments.includes("--no-recursion"));
  assert.ok(tarArguments.includes("--uid"));
  assert.ok(!tarArguments.includes("--sort=name"));
});

test("a Darwin package refuses an ioctl addon built for the other architecture", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-darwin-native-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const target = darwinPackageTarget("darwin-x64");
  for (const input of [target.nativeInputs.serialport, target.nativeInputs.usb]) {
    const destination = join(scratch, input.source);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(repositoryRoot, input.source), destination);
  }
  const ioctlPath = join(scratch, target.nativeInputs.ioctl.source);
  await mkdir(dirname(ioctlPath), { recursive: true });
  await writeFile(ioctlPath, thinMachO(0x0100000c));
  await assert.rejects(
    verifyTargetNativeArchitectures(scratch, target),
    /ioctl has arm64, expected only x86_64/u,
  );
  await writeFile(ioctlPath, thinMachO(0x01000007));
  const accepted = await verifyTargetNativeArchitectures(scratch, target);
  assert.deepEqual(accepted.ioctl, ["x86_64"]);
});

test("the macOS smoke payload runs under an empty environment and scratch-only command path", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-darwin-smoke-stage-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archive = join(scratch, "input.tar.gz");
  await writeFile(archive, "staging does not execute this archive\n");
  const payload = await stageMacosPackageSmokePayload({
    target: "darwin-arm64",
    archivePath: archive,
    outputDirectory: join(scratch, "payload"),
  });
  const script = await readFile(payload.scriptPath, "utf8");
  assert.match(script, /protodriver-darwin-arm64/u);
  assert.match(script, /command -v node/u);
  assert.match(script, /command -v npm/u);
  assert.match(script, /command -v cc/u);
  assert.match(script, /bin\/pdr-web/u);
  assert.match(script, /web-smoke-client\.mjs/u);
  assert.match(script, /web assets served/u);

  const invocation = macosSmokeInvocation({
    commandPath: "/scratch/bin",
    home: "/scratch/home",
    temporary: "/scratch/tmp",
    payload: "/scratch/payload",
  });
  assert.equal(invocation.command, "/usr/bin/env");
  assert.deepEqual(invocation.arguments.slice(0, 5), [
    "-i",
    "HOME=/scratch/home",
    "PATH=/scratch/bin",
    "TMPDIR=/scratch/tmp",
    "PDR_SMOKE_ROOT=/scratch/payload",
  ]);
});

function thinMachO(cpuType) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpuType, true);
  return bytes;
}
