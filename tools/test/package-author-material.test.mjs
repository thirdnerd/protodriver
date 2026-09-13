import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  checkPackagedMarkdownLinks,
  stagePackageAuthorMaterial,
  WORKED_SOURCE_FILES,
} from "../package/author-material.mjs";
import { CLI_PACKAGE_TARGETS, packageTarget } from "../package/targets.mjs";

const execute = promisify(execFile);
const pdr = new URL("../../apps/cli/src/pdr.ts", import.meta.url).pathname;

test("package author material is self-contained, unified, and target-specific", async (t) => {
  assert.equal(WORKED_SOURCE_FILES.length, 13);
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-author-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packageRoot = join(scratch, "protodriver-linux-x64");
  const links = await stagePackageAuthorMaterial({
    packageRoot,
    sourceDirectory: new URL("../../", import.meta.url).pathname,
    target: packageTarget("linux-x64"),
  });
  assert.ok(links.checked > 17);
  assert.deepEqual((await readdir(join(packageRoot, "docs"))).sort(), [
    "author-tutorial.md",
    "declaration-reference.md",
    "linux-x64-package.md",
  ]);
  assert.deepEqual((await readdir(join(packageRoot, "examples"))).sort(), [
    "README.md",
    "demo-thermostat",
    "device-1",
    "device-2",
    "device-3",
    "start",
    "ti-84-evo",
    "ti-nspire-handheld",
    "ti84-plus-ce",
  ]);

  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  const tutorial = await readFile(join(packageRoot, "docs/author-tutorial.md"), "utf8");
  const reference = await readFile(join(packageRoot, "docs/declaration-reference.md"), "utf8");
  const targetGuide = await readFile(join(packageRoot, "docs/linux-x64-package.md"), "utf8");
  const thermostat = await readFile(join(packageRoot, "examples/demo-thermostat/README.md"), "utf8");
  const ceGuide = await readFile(join(packageRoot, "examples/ti84-plus-ce/README.md"), "utf8");
  const prose = [readme, tutorial, reference, targetGuide, thermostat, ceGuide].join("\n");
  assert.match(readme, /\.\/bin\/pdr pack examples\/start blank-device\.pdpkg/u);
  assert.match(tutorial, /\.\.\/examples\/start\/device\.lua/u);
  assert.match(targetGuide, /glibc 2\.28/u);
  assert.match(targetGuide, /LIBUSB_ERROR_ACCESS/u);
  assert.match(thermostat, /runner\s+is repository test infrastructure, not a release dependency/u);
  assert.match(thermostat, /\.\/bin\/pdr pack examples\/demo-thermostat\/step-3/u);
  assert.match(ceGuide, /\[`device\.lua`\]\(device\.lua\)/u);
  assert.match(ceGuide, /\[checked transcript\]\(transcript\.txt\)/u);
  assert.doesNotMatch(prose, /docs\/examples|corpus\/|tools\/test|test-support\//u);
  assert.doesNotMatch(prose, /product\/protodriver|\bbundle\b/u);
  for (const path of [
    "examples/start/device.lua",
    "examples/demo-thermostat/PROTOCOL.md",
    "examples/demo-thermostat/step-1/device.lua",
    "examples/demo-thermostat/step-2/device.lua",
    "examples/demo-thermostat/step-3/device.lua",
    "examples/demo-thermostat/transcript.txt",
    "examples/device-1/channel-layout.lua",
    "examples/device-1/channel-wire.lua",
    "examples/device-1/device.lua",
    "examples/device-3/README.md",
    "examples/ti84-plus-ce/bmp.lua",
    "examples/ti84-plus-ce/directlink.lua",
    "examples/ti84-plus-ce/transcript.txt",
  ]) await assert.doesNotReject(readFile(join(packageRoot, path)));
  await assert.rejects(readFile(join(packageRoot, "product")), { code: "ENOENT" });

  const blankPackage = join(scratch, "blank-device.pdpkg");
  await execute(process.execPath, [pdr, "pack", join(packageRoot, "examples/start"), blankPackage]);
  const help = await execute(process.execPath, [pdr, "run", blankPackage, "--help"]);
  assert.match(help.stdout, /Blank device starting point/u);
  const deviceOnePackage = join(scratch, "device-1.pdpkg");
  await execute(process.execPath, [
    pdr,
    "pack",
    join(packageRoot, "examples/device-1"),
    deviceOnePackage,
  ]);
  const inspection = await execute(process.execPath, [pdr, "inspect", deviceOnePackage]);
  assert.match(inspection.stdout, /channel-layout\.lua, channel-wire\.lua, device\.lua/u);

  await writeFile(join(packageRoot, "examples", "BROKEN.md"), "[missing](not-present.txt)\n");
  await assert.rejects(checkPackagedMarkdownLinks(packageRoot), /package-author\.link-missing/u);
});

test("Windows package author material uses only its launcher and guide", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-author-windows-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const packageRoot = join(scratch, "protodriver-win32-x64");
  await stagePackageAuthorMaterial({
    packageRoot,
    sourceDirectory: new URL("../../", import.meta.url).pathname,
    target: packageTarget("win32-x64"),
  });
  assert.deepEqual((await readdir(join(packageRoot, "docs"))).sort(), [
    "author-tutorial.md",
    "declaration-reference.md",
    "win32-x64-package.md",
  ]);
  const prose = await Promise.all([
    readFile(join(packageRoot, "README.md"), "utf8"),
    readFile(join(packageRoot, "docs/author-tutorial.md"), "utf8"),
    readFile(join(packageRoot, "docs/win32-x64-package.md"), "utf8"),
    readFile(join(packageRoot, "examples/demo-thermostat/README.md"), "utf8"),
  ]);
  assert.match(prose.join("\n"), /\.\\bin\\pdr\.cmd pack examples\/start/u);
  assert.match(prose.at(-1), /Copy-Item examples\/demo-thermostat\/step-1\/device\.lua/u);
  assert.doesNotMatch(prose.join("\n"), /tar -xzf|linux-x64-package|macos-package/u);
});

test("each release stages exactly its own target guide", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-guides-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const id of Object.keys(CLI_PACKAGE_TARGETS)) {
    const packageRoot = join(scratch, id);
    await stagePackageAuthorMaterial({
      packageRoot,
      sourceDirectory: new URL("../../", import.meta.url).pathname,
      target: packageTarget(id),
    });
    assert.deepEqual(
      (await readdir(join(packageRoot, "docs"))).filter((name) => name.endsWith("-package.md")),
      [`${id}-package.md`],
    );
  }
});
