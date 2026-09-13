#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { darwinPackageTarget } from "./package/darwin-targets.mjs";
import { stagePackageSmokePayload } from "./package/smoke-payload.mjs";

export async function stageMacosPackageSmokePayload(options = {}) {
  darwinPackageTarget(options.target);
  return stagePackageSmokePayload(options);
}

export async function smokeMacosPackage({
  target: targetId,
  archivePath,
  scratchParent = tmpdir(),
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (archivePath === undefined) throw new TypeError("archivePath is required");
  const target = darwinPackageTarget(targetId);
  if (process.platform !== target.os || process.arch !== target.architecture) {
    throw new Error(`smoke-package-macos.target-mismatch: requested ${target.id}, runner is ${process.platform}-${process.arch}`);
  }

  const scratch = await mkdtemp(join(resolve(scratchParent), `.${target.id}-smoke.`));
  const payload = join(scratch, "payload");
  const commandPath = join(scratch, "bin");
  const home = join(scratch, "home");
  const temporary = join(scratch, "tmp");
  try {
    await Promise.all([
      mkdir(commandPath, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(temporary, { recursive: true }),
      stageMacosPackageSmokePayload({ target: target.id, archivePath, outputDirectory: payload }),
    ]);
    for (const [name, source] of [
      ["grep", "/usr/bin/grep"],
      ["mkdir", "/bin/mkdir"],
      ["rm", "/bin/rm"],
      ["sh", "/bin/sh"],
      ["tar", "/usr/bin/tar"],
    ]) {
      await symlink(source, join(commandPath, name));
    }
    const invocation = macosSmokeInvocation({ commandPath, home, temporary, payload });
    return await run(invocation.command, invocation.arguments);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function macosSmokeInvocation({ commandPath, home, temporary, payload }) {
  return Object.freeze({
    command: "/usr/bin/env",
    arguments: Object.freeze([
      "-i",
      `HOME=${home}`,
      `PATH=${commandPath}`,
      `TMPDIR=${temporary}`,
      `PDR_SMOKE_ROOT=${payload}`,
      "/bin/sh",
      join(payload, "smoke.sh"),
    ]),
  });
}

async function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = Object.freeze({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
      if (code === 0) resolvePromise(result);
      else reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? code})\n${result.stdout}${result.stderr}`));
    });
  });
}

function usage() {
  return "usage: node tools/smoke-package-macos.mjs --target darwin-arm64|darwin-x64 --archive FILE";
}

function parseArguments(argv) {
  let target;
  let archivePath;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--target" || name === "--archive") && value !== undefined) {
      if (name === "--target") target = value;
      else archivePath = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (target === undefined || archivePath === undefined) throw new Error(usage());
  return { target, archivePath: resolve(archivePath) };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await smokeMacosPackage(parseArguments(argv));
  process.stdout.write(result.stdout);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
