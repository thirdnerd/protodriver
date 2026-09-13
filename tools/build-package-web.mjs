#!/usr/bin/env node

import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWebDistribution } from "../apps/web/build.mjs";
import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import {
  finalizePackageWebBuild,
  packageWebSourceSha256,
} from "./package/web-build.mjs";

const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildPackageWeb({
  outputDirectory,
  sourceDirectory = defaultSourceRoot,
} = {}) {
  if (outputDirectory === undefined) throw new TypeError("outputDirectory is required");
  const output = resolve(outputDirectory);
  const sourceRoot = resolve(sourceDirectory);
  const sourceBefore = await packageWebSourceSha256(sourceRoot);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await buildWebDistribution({
    outputDirectory: join(output, "dist"),
    sourceDirectory: join(sourceRoot, "apps", "web"),
  });
  const manifest = await finalizePackageWebBuild({
    buildDirectory: output,
    sourceDirectory: sourceRoot,
  });
  if (manifest.sourceSha256 !== sourceBefore) {
    throw new Error(
      `package-web-build.source-changed-during-build: began ${sourceBefore}, ended ${manifest.sourceSha256}`,
    );
  }
  return Object.freeze({ manifest, outputDirectory: output });
}

function parseArguments(argv) {
  let outputDirectory;
  let sourceDirectory = defaultSourceRoot;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(usage());
    if (name === "--output") outputDirectory = value;
    else if (name === "--source") sourceDirectory = value;
    else throw new Error(usage());
  }
  if (outputDirectory === undefined) throw new Error(usage());
  return { outputDirectory, sourceDirectory };
}

function usage() {
  return "usage: node tools/build-package-web.mjs --output DIRECTORY [--source DIRECTORY]";
}

if (await isMainModule(import.meta.url)) {
  const result = await buildPackageWeb(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${result.outputDirectory}\nsource sha256:${result.manifest.sourceSha256}\n`
      + `assets:${result.manifest.assets.length}\n`,
  );
}
