import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PACKAGE_BUILD_WORKSPACES,
  bundledNpmCli,
  installPackageBuildDependencies,
  npmInvocation,
  packageBuildDependencyPlan,
} from "../install-package-build-dependencies.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Windows npm invokes its JavaScript CLI through Node without a batch shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "protodriver-npm-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "node.exe");
  const npmRoot = join(root, "node_modules", "npm");
  const cli = join(npmRoot, "bin", "npm-cli.js");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(join(npmRoot, "package.json"), '{"name":"npm","bin":{"npm":"bin/npm-cli.js"}}\n');
  await writeFile(cli, "// fixture\n");
  assert.equal(await bundledNpmCli(executable), cli);
  assert.deepEqual(npmInvocation({ platform: "win32", executable, npmCli: cli }), {
    command: executable,
    prefix: [cli],
  });
  assert.deepEqual(npmInvocation({ platform: "linux", executable }), { command: "npm", prefix: [] });
  assert.throws(() => npmInvocation({ platform: "win32", executable }), /npm-cli-required/u);
  await assert.rejects(bundledNpmCli(join(root, "nested", "node.exe")), /not beside/u);
  await rm(cli);
  await assert.rejects(bundledNpmCli(executable), /npm-cli-missing/u);
});

test("the package-build recipe covers the complete two-host workspace closure", async () => {
  assert.equal(packageBuildDependencyPlan().target, `${process.platform}-${process.arch}`);
  const required = await workspaceClosure(["apps/cli", "apps/web"]);
  assert.equal(required.length, 14);
  assert.deepEqual(PACKAGE_BUILD_WORKSPACES, required);

  for (const target of ["linux-x64", "linux-arm64"]) {
    const plan = packageBuildDependencyPlan(target);
    assert.deepEqual(plan.installArguments, ["ci"]);
    assert.deepEqual(plan.approvals, [
      {
        packages: ["serialport", "@serialport/bindings-cpp", "usb", "ioctl"],
        workspace: "apps/cli",
      },
      {
        packages: ["@serialport/bindings-cpp", "ioctl"],
        workspace: "packages/transport-node-serial",
      },
    ]);
  }
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
    const plan = packageBuildDependencyPlan(target);
    assert.deepEqual(plan.installArguments, ["ci", "--ignore-scripts"]);
    assert.deepEqual(plan.approvals, []);
  }
});

test("npm 11 Linux preparation approves, rebuilds, and restores authored manifests", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-dependencies-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const logPath = join(scratch, "npm-log.jsonl");
  const fakeNpm = join(scratch, "fake-npm.mjs");
  const originalManifests = new Map();
  for (const workspace of PACKAGE_BUILD_WORKSPACES) {
    const directory = join(scratch, workspace);
    const manifest = `${JSON.stringify({ name: workspace, private: true }, null, 2)}\n`;
    originalManifests.set(workspace, manifest);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "package.json"), manifest),
      writeFile(join(directory, "package-lock.json"), "{}\n"),
    ]);
  }
  await writeFile(fakeNpm, `
import { appendFile, readFile, writeFile } from "node:fs/promises";
const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--version") {
  process.stdout.write("11.16.0\\n");
  process.exit(0);
}
await appendFile(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), arguments_ }) + "\\n");
if (arguments_[0] === "approve-scripts") {
  const path = new URL("package.json", "file://" + process.cwd() + "/");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.allowScripts = { planted: true };
  await writeFile(path, JSON.stringify(manifest));
}
`);

  const result = await installPackageBuildDependencies({
    npmCli: fakeNpm,
    sourceDirectory: scratch,
    target: "linux-x64",
  });
  assert.equal(result.npmVersion, "11.16.0");
  const log = (await readFile(logPath, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(log.filter(({ arguments_ }) => arguments_[0] === "ci").length, 14);
  assert.deepEqual(
    log.filter(({ arguments_ }) => arguments_[0] !== "ci")
      .map(({ cwd, arguments_ }) => ({
        arguments_,
        workspace: relative(scratch, cwd),
      })),
    [
      {
        arguments_: [
          "approve-scripts",
          "serialport",
          "@serialport/bindings-cpp",
          "usb",
          "ioctl",
        ],
        workspace: "apps/cli",
      },
      {
        arguments_: ["rebuild", "serialport", "@serialport/bindings-cpp", "usb", "ioctl"],
        workspace: "apps/cli",
      },
      {
        arguments_: ["approve-scripts", "@serialport/bindings-cpp", "ioctl"],
        workspace: "packages/transport-node-serial",
      },
      {
        arguments_: ["rebuild", "@serialport/bindings-cpp", "ioctl"],
        workspace: "packages/transport-node-serial",
      },
    ],
  );
  for (const [workspace, manifest] of originalManifests) {
    assert.equal(await readFile(join(scratch, workspace, "package.json"), "utf8"), manifest);
  }
});

async function workspaceClosure(entryPaths) {
  const pending = entryPaths.map((path) => resolve(repositoryRoot, path));
  const visited = new Set();
  while (pending.length > 0) {
    const directory = pending.shift();
    if (visited.has(directory)) continue;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const source of Object.values(manifest[field] ?? {})) {
        if (typeof source === "string" && source.startsWith("file:")) {
          pending.push(resolve(directory, source.slice("file:".length)));
        }
      }
    }
  }
  return [...visited]
    .map((path) => relative(repositoryRoot, path))
    .sort();
}
