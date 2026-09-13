#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPdpkg } from "../packages/contracts/src/pdpkg.ts";
import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function packCorpusModule(sourceDirectory) {
  const logicalNames = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
    .map((entry) => entry.name)
    .sort();
  if (!logicalNames.includes("device.lua")) {
    throw new Error(`pack-corpus.entry-missing: ${sourceDirectory} has no device.lua`);
  }
  const members = Object.freeze(await Promise.all(logicalNames.map(async (logicalName) => Object.freeze({
    logicalName,
    sourceBytes: new Uint8Array(await readFile(resolve(sourceDirectory, logicalName))),
  }))));
  return buildPdpkg(members);
}

export async function packageFileEvidence(path) {
  path = resolve(path);
  const bytes = await readFile(path);
  return Object.freeze({
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    provenance: "exact package bytes fingerprinted before execution",
  });
}

export async function writeCorpusPackage(sourceDirectory, outputPath) {
  outputPath = resolve(outputPath);
  const packed = await packCorpusModule(resolve(sourceDirectory));
  await writeFile(outputPath, packed.archive, { flag: "wx" });
  return Object.freeze({
    ...await packageFileEvidence(outputPath),
    sourceSetIdentity: packed.sourceSetIdentity,
    provenance: "packed on demand from the repository Lua source set into this run output",
  });
}

export async function packCorpusDirectory(corpusDirectory, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const modules = [];
  for (const entry of await readdir(corpusDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDirectory = resolve(corpusDirectory, entry.name);
    if (!await isFile(resolve(sourceDirectory, "device.lua"))) continue;
    const packed = await packCorpusModule(sourceDirectory);
    const outputPath = resolve(outputDirectory, `${entry.name}.pdpkg`);
    await writeFile(outputPath, packed.archive);
    modules.push(Object.freeze({
      name: entry.name,
      outputPath,
      archiveBytes: packed.archive.byteLength,
      sourceSetIdentity: packed.sourceSetIdentity,
    }));
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  if (modules.length === 0) {
    throw new Error(`pack-corpus.empty: no device.lua modules found beneath ${corpusDirectory}`);
  }
  return Object.freeze(modules);
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function requiredOutput(argv) {
  if (argv.length !== 2 || argv[0] !== "--output") {
    throw new Error("usage: node tools/pack-corpus.mjs --output DIRECTORY");
  }
  return resolve(argv[1]);
}

export async function main(argv = process.argv.slice(2)) {
  const outputDirectory = requiredOutput(argv);
  const modules = await packCorpusDirectory(resolve(repositoryRoot, "corpus"), outputDirectory);
  for (const module of modules) {
    console.log(
      `${module.name}: ${module.outputPath} (${module.archiveBytes} bytes;`
      + ` source-set sha256:${module.sourceSetIdentity.hex})`,
    );
  }
}

if (await isMainModule(import.meta.url)) {
  await main();
}
