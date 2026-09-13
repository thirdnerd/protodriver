#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { releaseVersionFromTag } from "./package/release-version.mjs";
import { CLI_PACKAGE_TARGETS, packageArchiveName } from "./package/targets.mjs";

const executeFile = promisify(execFile);

export function releaseArchiveNames(tag) {
  const version = releaseVersionFromTag(tag);
  return Object.values(CLI_PACKAGE_TARGETS)
    .map((target) => packageArchiveName(target, version))
    .sort();
}

export async function prepareReleaseAssets({ tag, directory }) {
  const root = resolve(directory);
  const names = releaseArchiveNames(tag);
  const actual = (await readdir(root)).sort();
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error(`release-assets.archive-set-invalid: expected ${names.join(", ")}; found ${actual.join(", ")}`);
  }
  const lines = [];
  for (const name of names) {
    const path = join(root, name);
    if (!(await stat(path)).isFile()) throw new Error(`release-assets.not-file: ${path}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ${name}`);
  }
  const sumsPath = join(root, "SHA256SUMS");
  await writeFile(sumsPath, `${lines.join("\n")}\n`, { flag: "wx" });
  return Object.freeze({ archivePaths: names.map((name) => join(root, name)), sumsPath });
}

export async function publishDraftRelease({ tag, assets, execute = executeFile }) {
  releaseVersionFromTag(tag);
  const args = [
    "release", "create", tag, "--draft", "--verify-tag", "--title", tag,
    "--notes", "", ...assets.archivePaths, assets.sumsPath,
  ];
  await execute("gh", args);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error("usage: release-assets --tag TAG --directory DIRECTORY [--publish-draft]");
    if (name === "--tag") options.tag = value;
    else if (name === "--directory") options.directory = value;
    else throw new Error("usage: release-assets --tag TAG --directory DIRECTORY [--publish-draft]");
  }
  if (options.tag === undefined || options.directory === undefined) {
    throw new Error("usage: release-assets --tag TAG --directory DIRECTORY [--publish-draft]");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const publish = argv.includes("--publish-draft");
  const options = parseArguments(argv.filter((arg) => arg !== "--publish-draft"));
  const assets = await prepareReleaseAssets(options);
  if (publish) await publishDraftRelease({ tag: options.tag, assets });
  process.stdout.write(`${assets.sumsPath}\n`);
}

if (await isMainModule(import.meta.url)) await main();
