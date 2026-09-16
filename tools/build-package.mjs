#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { buildPackageWeb } from "./build-package-web.mjs";
import { installPackageBuildDependencies } from "./install-package-build-dependencies.mjs";
import { buildLinuxPackage } from "./package-linux.mjs";
import { buildMacosPackage } from "./package-macos.mjs";
import { buildWindowsPackage } from "./package-windows.mjs";
import { buildDarwinIoctl } from "./package/build-darwin-ioctl.mjs";
import { releaseVersionFromTag, validateReleaseVersion } from "./package/release-version.mjs";
import {
  hostPackageTarget,
  nativePackageTarget,
} from "./package/targets.mjs";
import { smokeLinuxPackage } from "./smoke-package-linux.mjs";
import { smokeMacosPackage } from "./smoke-package-macos.mjs";
import { smokeWindowsPackage } from "./smoke-package-windows.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveBuildTarget({
  target,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (target === undefined) return hostPackageTarget({ platform, architecture });
  return nativePackageTarget(target, { platform, architecture });
}

export function defaultNodeRuntimeRoot({
  target,
  executable = process.execPath,
} = {}) {
  if (target === undefined) throw new TypeError("target is required");
  return target.os === "win32"
    ? win32.dirname(executable)
    : posix.resolve(posix.dirname(executable), "..");
}

export async function buildPackage({
  target: targetId,
  outputDirectory,
  sourceCommit,
  releaseVersion,
  releaseTag,
  sourceDirectory = repositoryRoot,
  nodeRuntimeRoot,
  npmCli,
} = {}) {
  const target = resolveBuildTarget({ target: targetId });
  const sourceRoot = resolve(sourceDirectory);
  const output = resolve(outputDirectory ?? join(sourceRoot, `${target.id}-package-output`));
  const runtimeRoot = resolve(nodeRuntimeRoot ?? defaultNodeRuntimeRoot({ target }));
  const commit = sourceCommit ?? await currentCommit(sourceRoot);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new TypeError("sourceCommit must be a full lowercase Git commit");
  }
  if (releaseTag !== undefined && releaseVersion !== undefined) {
    throw new TypeError("pass either releaseTag or releaseVersion, not both");
  }
  const version = releaseTag === undefined
    ? (releaseVersion === undefined ? undefined : validateReleaseVersion(releaseVersion))
    : releaseVersionFromTag(releaseTag);

  process.stdout.write(`build-package: ${target.id}: install dependencies\n`);
  await installPackageBuildDependencies({
    target: target.id,
    sourceDirectory: sourceRoot,
    ...(npmCli === undefined ? {} : { npmCli }),
  });

  if (target.os === "darwin") {
    process.stdout.write(`build-package: ${target.id}: build ioctl\n`);
    await buildDarwinIoctl({
      target: target.id,
      nodeRuntimeRoot: runtimeRoot,
      sourceDirectory: sourceRoot,
    });
  }

  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(output, `.build-${target.id}.`));
  try {
    const webBuildDirectory = join(scratch, "web-build");
    process.stdout.write(`build-package: ${target.id}: build web distribution\n`);
    await buildPackageWeb({
      outputDirectory: webBuildDirectory,
      sourceDirectory: sourceRoot,
    });

    process.stdout.write(`build-package: ${target.id}: build archive\n`);
    const archive = await packageBuilder(target.os)({
      target: target.id,
      nodeRuntimeRoot: runtimeRoot,
      outputDirectory: output,
      sourceCommit: commit,
      releaseVersion: version,
      sourceDirectory: sourceRoot,
      webBuildDirectory,
    });

    process.stdout.write(`build-package: ${target.id}: smoke archive\n`);
    const smoke = await packageSmoke(target.os)({
      target: target.id,
      archivePath: archive.archivePath,
      scratchParent: output,
    });
    process.stdout.write(smoke.stdout);
    return Object.freeze({ archive, outputDirectory: output, sourceCommit: commit, target: target.id });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function packageBuilder(platform) {
  if (platform === "linux") return buildLinuxPackage;
  if (platform === "darwin") return buildMacosPackage;
  if (platform === "win32") return buildWindowsPackage;
  throw new Error(`build-package.platform-unsupported: ${platform}`);
}

function packageSmoke(platform) {
  if (platform === "linux") return smokeLinuxPackage;
  if (platform === "darwin") return smokeMacosPackage;
  if (platform === "win32") return smokeWindowsPackage;
  throw new Error(`build-package.platform-unsupported: ${platform}`);
}

async function currentCommit(sourceRoot) {
  const { stdout } = await executeFile(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { cwd: sourceRoot, encoding: "utf8" },
  );
  return stdout.trim();
}

function usage() {
  return "usage: node tools/build-package.mjs [--target TARGET] [--output DIRECTORY] [--node-runtime-root DIRECTORY] [--source-commit COMMIT] [--release-version VERSION | --release-tag TAG] [--npm-cli FILE]";
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(usage());
    if (name === "--target") options.target = value;
    else if (name === "--output") options.outputDirectory = value;
    else if (name === "--node-runtime-root") options.nodeRuntimeRoot = value;
    else if (name === "--source-commit") options.sourceCommit = value;
    else if (name === "--release-version") options.releaseVersion = value;
    else if (name === "--release-tag") options.releaseTag = value;
    else if (name === "--npm-cli") options.npmCli = value;
    else throw new Error(usage());
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const result = await buildPackage(parseArguments(argv));
  process.stdout.write(
    `build-package: complete ${result.target}\n`
      + `${result.archive.archivePath}\n`
      + `sha256:${result.archive.archiveSha256}\n`
      + `unpacked regular-file bytes:${result.archive.unpackedBytes}\n`
      + `files:${result.archive.fileCount}\n`,
  );
}

if (await isMainModule(import.meta.url)) {
  await main();
}
