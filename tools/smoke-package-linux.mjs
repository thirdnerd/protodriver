#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { linuxPackageTarget } from "./package/linux-targets.mjs";
import { stagePackageSmokePayload } from "./package/smoke-payload.mjs";

/**
 * Stage the target-neutral inputs and shell program that run inside either a
 * bubblewrap root or an OCI container. This step never executes the package.
 */
export async function stageLinuxPackageSmokePayload({
  target: targetId,
  archivePath,
  outputDirectory,
  sourceDirectory,
} = {}) {
  linuxPackageTarget(targetId);
  return stagePackageSmokePayload({
    target: targetId,
    archivePath,
    outputDirectory,
    ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
  });
}

/** Local convenience runner. The payload above is the same one used by Docker. */
export async function smokeLinuxPackage({
  target: targetId,
  archivePath,
  scratchParent = tmpdir(),
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (archivePath === undefined) throw new TypeError("archivePath is required");
  const target = linuxPackageTarget(targetId);
  if (process.platform !== target.os || process.arch !== target.architecture) {
    throw new Error(`smoke-package-linux.target-mismatch: requested ${target.id}, runner is ${process.platform}-${process.arch}`);
  }
  await assertExecutable("/usr/bin/bwrap", "bubblewrap");
  await assertExecutable("/usr/bin/busybox", "static busybox");

  const scratch = await mkdtemp(join(resolve(scratchParent), `.${target.id}-smoke.`));
  const payload = join(scratch, "payload");
  const root = join(scratch, "root");
  try {
    await stageLinuxPackageSmokePayload({ target: target.id, archivePath, outputDirectory: payload });
    await stageBubblewrapRoot(root, payload, target);
    return await run("/usr/bin/bwrap", [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--setenv", "HOME", "/tmp",
      "--setenv", "PATH", "/bin:/usr/bin",
      "--setenv", "TMPDIR", "/tmp",
      "--bind", root, "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "/bin/sh", "/smoke/smoke.sh",
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function stageBubblewrapRoot(root, payload, target) {
  await Promise.all([
    mkdir(join(root, "bin"), { recursive: true }),
    mkdir(join(root, "dev"), { recursive: true }),
    mkdir(join(root, "proc"), { recursive: true }),
    mkdir(join(root, "run", "udev"), { recursive: true }),
    mkdir(join(root, "sys"), { recursive: true }),
    mkdir(join(root, "tmp"), { recursive: true }),
    mkdir(join(root, "usr", "bin"), { recursive: true }),
  ]);
  await cp("/usr/bin/busybox", join(root, "bin", "busybox"));
  for (const command of ["grep", "mkdir", "rm", "sh", "tar"]) {
    await symlink("busybox", join(root, "bin", command));
  }
  await cp(payload, join(root, "smoke"), { recursive: true });
  for (const [source, destination] of target.smokeSharedLibraries) {
    await assertFile(source, `shared-library fixture ${source}`);
    await mkdir(dirname(join(root, destination)), { recursive: true });
    await cp(source, join(root, destination), { dereference: true });
  }
  await stageOsExecutable(root, "/usr/bin/udevadm");
}

async function stageOsExecutable(root, executable) {
  await assertExecutable(executable, `target OS prerequisite ${executable}`);
  await mkdir(dirname(join(root, executable)), { recursive: true });
  await cp(executable, join(root, executable), { dereference: true });
  const linked = await run("ldd", [executable]);
  const libraries = new Set();
  for (const line of linked.stdout.split("\n")) {
    const match = line.match(/(?:=>\s+|^\s*)(\/[^\s(]+)/u);
    if (match !== null) libraries.add(match[1]);
  }
  for (const library of libraries) {
    await assertFile(library, `shared library for ${executable}`);
    await mkdir(dirname(join(root, library)), { recursive: true });
    await cp(library, join(root, library), { dereference: true });
  }
}

async function assertFile(path, subject) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`smoke-package-linux.input-missing: ${subject} at ${path}`);
}

async function assertExecutable(path, subject) {
  await assertFile(path, subject);
  const info = await stat(path);
  if ((info.mode & 0o111) === 0) {
    throw new Error(`smoke-package-linux.input-not-executable: ${subject} at ${path}`);
  }
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
  return "usage: node tools/smoke-package-linux.mjs --target linux-x64|linux-arm64 --archive FILE [--stage-container DIRECTORY]";
}

function parseArguments(argv) {
  let target;
  let archivePath;
  let stageDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--target" || name === "--archive" || name === "--stage-container") && value !== undefined) {
      if (name === "--target") target = value;
      else if (name === "--archive") archivePath = value;
      else stageDirectory = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (target === undefined || archivePath === undefined) throw new Error(usage());
  return { target, archivePath: resolve(archivePath), stageDirectory };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.stageDirectory !== undefined) {
    const staged = await stageLinuxPackageSmokePayload({
      target: options.target,
      archivePath: options.archivePath,
      outputDirectory: options.stageDirectory,
    });
    process.stdout.write(`${staged.outputDirectory}\n`);
    return;
  }
  const result = await smokeLinuxPackage({ target: options.target, archivePath: options.archivePath });
  process.stdout.write(result.stdout);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
