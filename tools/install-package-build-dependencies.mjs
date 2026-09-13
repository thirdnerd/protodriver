#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { packageTarget } from "./package/targets.mjs";

const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// This is deliberately an explicit recipe. The package-build test derives the
// closure independently from the two product hosts and reddens if the graph
// changes without this list changing with it.
export const PACKAGE_BUILD_WORKSPACES = Object.freeze([
  "apps/cli",
  "apps/web",
  "packages/contracts",
  "packages/control-model",
  "packages/core",
  "packages/generated-cli",
  "packages/generated-web",
  "packages/lua-vm",
  "packages/transfer-runtime",
  "packages/transport-browser-serial",
  "packages/transport-browser-usb",
  "packages/transport-mock",
  "packages/transport-node-serial",
  "packages/transport-node-usb",
]);

const linuxApprovals = Object.freeze([
  Object.freeze({
    packages: Object.freeze(["serialport", "@serialport/bindings-cpp", "usb", "ioctl"]),
    workspace: "apps/cli",
  }),
  Object.freeze({
    packages: Object.freeze(["@serialport/bindings-cpp", "ioctl"]),
    workspace: "packages/transport-node-serial",
  }),
]);

export function packageBuildDependencyPlan(targetId) {
  const target = packageTarget(targetId);
  const installArguments = target.os === "linux" ? ["ci"] : ["ci", "--ignore-scripts"];
  return Object.freeze({
    approvals: target.os === "linux" ? linuxApprovals : Object.freeze([]),
    installArguments: Object.freeze(installArguments),
    target: target.id,
    workspaces: PACKAGE_BUILD_WORKSPACES,
  });
}

export async function installPackageBuildDependencies({
  target,
  sourceDirectory = defaultSourceRoot,
  npmCli,
} = {}) {
  const sourceRoot = resolve(sourceDirectory);
  const plan = packageBuildDependencyPlan(target);
  await verifyWorkspaceInputs(sourceRoot, plan.workspaces);
  const npm = npmInvocation(npmCli);
  const version = (await captureNpm(npm, ["--version"], sourceRoot)).trim();
  const major = Number.parseInt(version.split(".")[0], 10);
  if (!Number.isSafeInteger(major)) {
    throw new Error(`package-build-dependencies.npm-version-invalid: ${JSON.stringify(version)}`);
  }

  for (const workspace of plan.workspaces) {
    process.stdout.write(
      `package-build-dependencies: ${workspace}: npm ${plan.installArguments.join(" ")}\n`,
    );
    await runNpm(npm, plan.installArguments, join(sourceRoot, workspace));
  }

  if (plan.approvals.length > 0 && major >= 11) {
    for (const approval of plan.approvals) {
      await approveAndRebuild(npm, sourceRoot, approval);
    }
  } else if (plan.approvals.length > 0) {
    for (const approval of plan.approvals) {
      process.stdout.write(
        `package-build-dependencies: ${approval.workspace}: explicitly rebuild ${approval.packages.join(", ")} under npm ${version}\n`,
      );
      await runNpm(
        npm,
        ["rebuild", ...approval.packages],
        join(sourceRoot, approval.workspace),
      );
    }
  }

  process.stdout.write(
    `package-build-dependencies: installed ${plan.workspaces.length} workspaces for ${plan.target}\n`,
  );
  return Object.freeze({ npmVersion: version, plan });
}

async function approveAndRebuild(npm, sourceRoot, approval) {
  const workspaceRoot = join(sourceRoot, approval.workspace);
  const manifestPath = join(workspaceRoot, "package.json");
  const originalManifest = await readFile(manifestPath);
  try {
    process.stdout.write(
      `package-build-dependencies: ${approval.workspace}: approve and rebuild ${approval.packages.join(", ")}\n`,
    );
    await runNpm(npm, ["approve-scripts", ...approval.packages], workspaceRoot);
    await runNpm(npm, ["rebuild", ...approval.packages], workspaceRoot);
  } finally {
    // npm approve-scripts records policy in package.json. Build preparation is
    // allowed to create node_modules, but must not change authored product bytes.
    await writeFile(manifestPath, originalManifest);
  }
}

async function verifyWorkspaceInputs(sourceRoot, workspaces) {
  for (const workspace of workspaces) {
    for (const name of ["package.json", "package-lock.json"]) {
      const path = join(sourceRoot, workspace, name);
      try {
        if (!(await stat(path)).isFile()) throw new Error("not a file");
      } catch {
        throw new Error(`package-build-dependencies.workspace-input-missing: ${workspace}/${name}`);
      }
    }
  }
}

function npmInvocation(npmCli) {
  if (npmCli !== undefined) {
    return Object.freeze({ command: process.execPath, prefix: Object.freeze([resolve(npmCli)]) });
  }
  return Object.freeze({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefix: Object.freeze([]),
  });
}

async function runNpm(npm, arguments_, cwd) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(npm.command, [...npm.prefix, ...arguments_], { cwd, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(
        `package-build-dependencies.npm-failed: npm ${arguments_.join(" ")} in ${cwd}`
          + ` exited ${code ?? `for signal ${signal}`}`,
      ));
    });
  });
}

async function captureNpm(npm, arguments_, cwd) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(npm.command, [...npm.prefix, ...arguments_], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(
        `package-build-dependencies.npm-failed: npm ${arguments_.join(" ")} in ${cwd}`
          + ` exited ${code ?? `for signal ${signal}`}`,
      ));
    });
  });
}

function parseArguments(argv) {
  let target;
  let sourceDirectory = defaultSourceRoot;
  let npmCli;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(usage());
    if (name === "--target") target = value;
    else if (name === "--source") sourceDirectory = value;
    else if (name === "--npm-cli") npmCli = value;
    else throw new Error(usage());
  }
  if (target === undefined) throw new Error(usage());
  return { npmCli, sourceDirectory, target };
}

function usage() {
  return "usage: node tools/install-package-build-dependencies.mjs --target TARGET [--source DIRECTORY] [--npm-cli FILE]";
}

if (await isMainModule(import.meta.url)) {
  await installPackageBuildDependencies(parseArguments(process.argv.slice(2)));
}
