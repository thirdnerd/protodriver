#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { win32PackageTarget } from "./package/win32-targets.mjs";
import { stagePackageSmokePayload } from "./package/smoke-payload.mjs";

export async function stageWindowsPackageSmokePayload({
  target: targetId,
  archivePath,
  outputDirectory,
  sourceDirectory,
} = {}) {
  win32PackageTarget(targetId);
  return stagePackageSmokePayload({
    target: targetId,
    archivePath,
    outputDirectory,
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
  });
}

export function windowsSmokeInvocation({ systemRoot, scriptPath }) {
  if (systemRoot === undefined) throw new TypeError("systemRoot is required");
  if (scriptPath === undefined) throw new TypeError("scriptPath is required");
  const systemPath = [
    win32.join(systemRoot, "System32"),
    systemRoot,
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  return Object.freeze({
    command: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    arguments: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(scriptPath),
    ]),
    path: systemPath,
  });
}

export async function smokeWindowsPackage({
  target: targetId,
  archivePath,
  scratchParent = tmpdir(),
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (archivePath === undefined) throw new TypeError("archivePath is required");
  const target = win32PackageTarget(targetId);
  if (process.platform !== target.os || process.arch !== target.architecture) {
    throw new Error(
      `smoke-package-windows.target-mismatch: requested ${target.id}, runner is ${process.platform}-${process.arch}`,
    );
  }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) {
    throw new Error("smoke-package-windows.system-root-missing: SystemRoot is not set");
  }
  const scratch = await mkdtemp(join(resolve(scratchParent), `.${target.id}-smoke.`));
  try {
    const payload = await stageWindowsPackageSmokePayload({
      target: target.id,
      archivePath,
      outputDirectory: join(scratch, "payload"),
    });
    const invocation = windowsSmokeInvocation({ systemRoot, scriptPath: payload.scriptPath });
    return await run(invocation.command, invocation.arguments, {
      ...process.env,
      PATH: invocation.path,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function usage() {
  return "usage: node tools/smoke-package-windows.mjs --target win32-x64 --archive FILE [--stage DIRECTORY]";
}

function parseArguments(argv) {
  let target;
  let archivePath;
  let outputDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--target" || name === "--archive" || name === "--stage") && value !== undefined) {
      if (name === "--target") target = value;
      else if (name === "--archive") archivePath = value;
      else outputDirectory = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (target === undefined || archivePath === undefined) {
    throw new Error(usage());
  }
  return {
    target,
    archivePath: resolve(archivePath),
    ...(outputDirectory === undefined ? {} : { outputDirectory: resolve(outputDirectory) }),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.outputDirectory !== undefined) {
    const staged = await stageWindowsPackageSmokePayload(options);
    process.stdout.write(`${staged.outputDirectory}\n`);
    return;
  }
  const result = await smokeWindowsPackage(options);
  process.stdout.write(result.stdout);
}

if (await isMainModule(import.meta.url)) {
  await main();
}

async function run(command, arguments_, env) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      const result = Object.freeze({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
      if (code === 0) resolveRun(result);
      else rejectRun(new Error(
        `${command} ${arguments_.join(" ")} failed (${signal ?? code})\n${result.stdout}${result.stderr}`,
      ));
    });
  });
}
