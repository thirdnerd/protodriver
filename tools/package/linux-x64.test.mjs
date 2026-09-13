// On-demand exit gate: see docs/linux-x64-package.md. Never part of tools/test/.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildLinuxPackage, discoverCliProjectPackages } from "../package-linux.mjs";
import { buildPackageWeb } from "../build-package-web.mjs";
import { linuxPackageTarget } from "./linux-targets.mjs";
import { smokeLinuxPackage, stageLinuxPackageSmokePayload } from "../smoke-package-linux.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Linux x64 package discovers runtime workspaces, reproduces, and smokes without Node", { timeout: 90_000 }, async (t) => {
  assert.equal(`${process.platform}-${process.arch}`, "linux-x64");
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-linux-x64-package-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const sourceRoot = join(scratch, "source");
  const firstOutput = join(scratch, "first");
  const secondOutput = join(scratch, "second");
  await stageScratchSource(sourceRoot);
  const webBuildDirectory = join(scratch, "web-build");
  const webBuild = await buildPackageWeb({
    outputDirectory: webBuildDirectory,
    sourceDirectory: sourceRoot,
  });
  // Target packaging consumes only the shared build. Removing the web
  // workspace install after that build pins the absence of a target esbuild.
  await rm(join(sourceRoot, "apps/web/node_modules"), { recursive: true, force: true });

  const first = await buildLinuxPackage({
    target: "linux-x64",
    outputDirectory: firstOutput,
    sourceCommit: "0".repeat(40),
    sourceDirectory: sourceRoot,
    webBuildDirectory,
  });
  const second = await buildLinuxPackage({
    target: "linux-x64",
    outputDirectory: secondOutput,
    sourceCommit: "0".repeat(40),
    sourceDirectory: sourceRoot,
    webBuildDirectory,
  });

  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.equal(first.unpackedBytes, second.unpackedBytes);
  assert.equal(first.fileCount, second.fileCount);
  assert.equal(first.manifest.node.version, linuxPackageTarget("linux-x64").node.version);
  assert.equal(first.manifest.sourceCommit, "0".repeat(40));
  assert.equal(first.manifest.projectPackages.length, 9);
  assert.ok(first.manifest.projectPackages.includes("@protodriver/package-discovery-probe"));
  assert.ok(!first.manifest.projectPackages.includes("@protodriver/transport-mock"));
  assert.equal(first.manifest.sourceRepresentation.execution, "bundled-node-type-stripping");
  assert.deepEqual(Object.keys(first.manifest.nativeAddons).sort(), ["ioctl", "serialport", "usb"]);
  assert.equal(first.manifest.luaVm, undefined);
  assert.equal(first.manifest.retainedLuaVm.sha256, "f0646d258acf98a02eabf678aea7ae90f118fca6e1014515ffbdb95987c54e37");
  assert.equal(first.manifest.web.launcher, "bin/pdr-web");
  assert.equal(first.manifest.web.assets.length, 4);
  assert.equal(first.manifest.web.offlineFilesChecked, 4);
  assert.equal(first.manifest.web.sourceSha256, webBuild.manifest.sourceSha256);
  const listing = (await execute("tar", ["-tzf", first.archivePath])).stdout.trim().split("\n");
  assert.deepEqual(listing.filter((path) => path.endsWith(".node")), [
    "protodriver-linux-x64/app/node_modules/@serialport/bindings-cpp/prebuilds/linux-x64/@serialport+bindings-cpp.glibc.node",
    "protodriver-linux-x64/app/node_modules/ioctl/build/Release/ioctl.node",
    "protodriver-linux-x64/app/node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node",
  ]);
  assert.ok(listing.includes("protodriver-linux-x64/bin/node"));
  assert.ok(listing.includes("protodriver-linux-x64/bin/pdr"));
  assert.ok(listing.includes("protodriver-linux-x64/bin/pdr-web"));
  for (const { path } of first.manifest.web.assets) {
    assert.ok(listing.includes(`protodriver-linux-x64/app/apps/web/dist/${path}`));
  }
  assert.deepEqual(listing.filter(path => path.includes("/app/packages/lua-vm/artifacts/") && path.endsWith(".wasm")), [
    "protodriver-linux-x64/app/packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  ]);
  assert.ok(listing.includes(
    "protodriver-linux-x64/app/packages/package-discovery-probe/src/index.ts",
  ));
  assert.ok(listing.includes(
    "protodriver-linux-x64/app/node_modules/@protodriver/package-discovery-probe",
  ));
  for (const path of [
    "README.md",
    "docs/author-tutorial.md",
    "docs/declaration-reference.md",
    "docs/linux-x64-package.md",
    "examples/README.md",
    "examples/start/device.lua",
    "examples/demo-thermostat/README.md",
    "examples/demo-thermostat/step-3/device.lua",
    "examples/ti84-plus-ce/README.md",
    "examples/ti84-plus-ce/transcript.txt",
  ]) assert.ok(listing.includes(`protodriver-linux-x64/${path}`));

  const smoke = await smokeLinuxPackage({ target: "linux-x64", archivePath: first.archivePath });
  assert.match(
    smoke.stdout,
    /archive unpacked; author material checked; web assets served; contract-2 pdpkg packed and admitted/u,
  );
  assert.match(smoke.stdout, /serialport, usb and ioctl initialized/u);
  assert.match(smoke.stdout, /web assets served/u);

  // Staging generates container-side data only; this x64 test deliberately
  // does not execute an arm64 archive or target binary.
  const armPayload = await stageLinuxPackageSmokePayload({
    target: "linux-arm64",
    archivePath: first.archivePath,
    outputDirectory: join(scratch, "arm-smoke-payload"),
  });
  const armSmokeScript = await readFile(armPayload.scriptPath, "utf8");
  assert.match(armSmokeScript, /protodriver-linux-arm64/u);
  assert.match(armSmokeScript, /PDR_SMOKE_ROOT/u);
});

async function stageScratchSource(destination) {
  const cliPackageNames = await discoverCliProjectPackages(repositoryRoot);
  const webPackage = JSON.parse(await readFile(join(repositoryRoot, "apps/web/package.json"), "utf8"));
  const webPackageNames = Object.keys(webPackage.dependencies)
    .filter((name) => name.startsWith("@protodriver/"))
    .map((name) => name.slice("@protodriver/".length));
  const packageNames = [...new Set([...cliPackageNames, ...webPackageNames])].sort();
  await Promise.all([
    mkdir(join(destination, "apps", "cli"), { recursive: true }),
    mkdir(join(destination, "apps", "web", "node_modules", "@protodriver"), { recursive: true }),
    mkdir(join(destination, "node_modules", "@protodriver"), { recursive: true }),
    mkdir(join(destination, "packages"), { recursive: true }),
    mkdir(join(destination, "tools", "package"), { recursive: true }),
  ]);

  const cliPackage = JSON.parse(await readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8"));
  cliPackage.dependencies["@protodriver/package-discovery-probe"] = "file:../../packages/package-discovery-probe";
  await Promise.all([
    writeFile(join(destination, "apps/cli/package.json"), `${JSON.stringify(cliPackage, null, 2)}\n`),
    cp(join(repositoryRoot, "LICENSE"), join(destination, "LICENSE")),
    cp(join(repositoryRoot, "NOTICE"), join(destination, "NOTICE")),
    cp(join(repositoryRoot, "corpus"), join(destination, "corpus"), { recursive: true }),
    cp(join(repositoryRoot, "docs"), join(destination, "docs"), { recursive: true }),
    cp(join(repositoryRoot, "examples"), join(destination, "examples"), { recursive: true }),
    cp(join(repositoryRoot, "apps/cli/src"), join(destination, "apps/cli/src"), { recursive: true }),
    cp(join(repositoryRoot, "apps/web/src"), join(destination, "apps/web/src"), { recursive: true }),
    cp(join(repositoryRoot, "apps/web/build.mjs"), join(destination, "apps/web/build.mjs")),
    cp(join(repositoryRoot, "apps/web/serve.mjs"), join(destination, "apps/web/serve.mjs")),
    cp(
      join(repositoryRoot, "tools/build-package-web.mjs"),
      join(destination, "tools/build-package-web.mjs"),
    ),
    cp(
      join(repositoryRoot, "tools/check-browser-offline.mjs"),
      join(destination, "tools/check-browser-offline.mjs"),
    ),
    cp(
      join(repositoryRoot, "tools/package/web-build.mjs"),
      join(destination, "tools/package/web-build.mjs"),
    ),
    cp(
      join(repositoryRoot, "tools/package/native-smoke.ts"),
      join(destination, "tools/package/native-smoke.ts"),
    ),
    symlink(
      join(repositoryRoot, "apps/cli/node_modules"),
      join(destination, "apps/cli/node_modules"),
      "dir",
    ),
  ]);

  for (const packageName of packageNames) {
    const source = join(repositoryRoot, "packages", packageName);
    const packaged = join(destination, "packages", packageName);
    await mkdir(packaged, { recursive: true });
    await Promise.all([
      cp(join(source, "package.json"), join(packaged, "package.json")),
      cp(join(source, "src"), join(packaged, "src"), { recursive: true }),
    ]);
    if (packageName === "lua-vm") {
      await mkdir(join(packaged, "artifacts"), { recursive: true });
      await Promise.all([
        cp(join(source, "LICENSE"), join(packaged, "LICENSE")),
        cp(
          join(source, "artifacts/protodriver-retained-v2.wasm"),
          join(packaged, "artifacts/protodriver-retained-v2.wasm"),
        ),
      ]);
    }
    await Promise.all([
      symlink(
        `../../../../packages/${packageName}`,
        join(destination, "apps", "web", "node_modules", "@protodriver", packageName),
      ),
      symlink(
        `../../packages/${packageName}`,
        join(destination, "node_modules", "@protodriver", packageName),
      ),
    ]);
  }
  await symlink(
    join(repositoryRoot, "packages/transport-node-serial/node_modules"),
    join(destination, "packages/transport-node-serial/node_modules"),
    "dir",
  );

  const probe = join(destination, "packages", "package-discovery-probe");
  await mkdir(join(probe, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(probe, "package.json"), `${JSON.stringify({
      name: "@protodriver/package-discovery-probe",
      version: "0.0.0",
      private: true,
      type: "module",
      exports: "./src/index.ts",
    }, null, 2)}\n`),
    writeFile(join(probe, "src/index.ts"), "export const discoveredByLinuxPackager = true;\n"),
  ]);
}
