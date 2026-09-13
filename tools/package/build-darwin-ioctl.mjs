#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";
import { inspectMachOArchitectures } from "../package-cli.mjs";
import { darwinPackageTarget } from "./darwin-targets.mjs";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function darwinIoctlCompileArguments({ target, nodeRuntimeRoot, sourceDirectory }) {
  const sourceRoot = resolve(sourceDirectory);
  const runtimeRoot = resolve(nodeRuntimeRoot);
  const ioctlRoot = join(sourceRoot, "packages/transport-node-serial/node_modules/ioctl");
  const output = join(sourceRoot, target.nativeInputs.ioctl.source);
  return Object.freeze({
    output,
    arguments: Object.freeze([
      "--sdk", "macosx", "clang++",
      "-arch", target.machOArchitecture,
      "-shared",
      "-std=c++20",
      `-mmacosx-version-min=${target.minimumMacos}`,
      "-I", join(runtimeRoot, "include/node"),
      "-I", join(sourceRoot, "packages/transport-node-serial/node_modules/nan"),
      "-I", ioctlRoot,
      join(ioctlRoot, "src/ioctl.cpp"),
      "-undefined", "dynamic_lookup",
      "-fPIC",
      "-O2",
      "-DNODE_GYP_MODULE_NAME=ioctl",
      "-DBUILDING_NODE_EXTENSION",
      "-o", output,
    ]),
  });
}

export async function buildDarwinIoctl({
  target: targetId,
  nodeRuntimeRoot,
  sourceDirectory = defaultRepositoryRoot,
} = {}) {
  if (targetId === undefined) throw new TypeError("target is required");
  if (nodeRuntimeRoot === undefined) throw new TypeError("nodeRuntimeRoot is required");
  const target = darwinPackageTarget(targetId);
  if (process.platform !== "darwin") {
    throw new Error(`build-darwin-ioctl.target-mismatch: builder is ${process.platform}-${process.arch}`);
  }
  const compile = darwinIoctlCompileArguments({ target, nodeRuntimeRoot, sourceDirectory });
  if (await lstat(compile.output).catch(() => undefined) !== undefined) {
    throw new Error(`build-darwin-ioctl.output-exists: ${compile.output}`);
  }
  await mkdir(dirname(compile.output), { recursive: true });
  await run("/usr/bin/xcrun", compile.arguments);
  const architectures = await inspectMachOArchitectures(compile.output);
  if (architectures.length !== 1 || architectures[0] !== target.machOArchitecture) {
    throw new Error(
      `build-darwin-ioctl.architecture-mismatch: built ${architectures.join(",")}, expected only ${target.machOArchitecture}`,
    );
  }
  return Object.freeze({ output: compile.output, architectures });
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
      if (code === 0) resolvePromise();
      else reject(new Error(
        `${command} ${arguments_.join(" ")} failed (${signal ?? code})\n`
        + `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`,
      ));
    });
  });
}

function usage() {
  return "usage: node tools/package/build-darwin-ioctl.mjs --target darwin-arm64|darwin-x64 --node-runtime-root DIRECTORY";
}

function parseArguments(argv) {
  let target;
  let nodeRuntimeRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--target" || name === "--node-runtime-root") && value !== undefined) {
      if (name === "--target") target = value;
      else nodeRuntimeRoot = value;
      index += 1;
    } else {
      throw new Error(usage());
    }
  }
  if (target === undefined || nodeRuntimeRoot === undefined) throw new Error(usage());
  return { target, nodeRuntimeRoot };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await buildDarwinIoctl(parseArguments(argv));
  process.stdout.write(`${result.output}\narchitectures:${result.architectures.join(",")}\n`);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
