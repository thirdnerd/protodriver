#!/usr/bin/env node

// Stage the gh-pages branch contents for clatty.org/protodriver/ and refuse
// to produce a publishable directory that leaks source.
//
// The web build emits no source maps, because they embed the private
// TypeScript source. Refuse one rather than trusting the build not to produce
// it: a copy allowlist that silently skips an unexpected file publishes the
// rest and says nothing.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PUBLISHABLE = Object.freeze([
  "index.html",
  "app.js",
  "styles.css",
  "sessionWorker.js",
]);

const FORBIDDEN = Object.freeze(["sourcesContent", "sourceMappingURL"]);

export async function stagePages(distDirectory, outputDirectory) {
  const sourceFiles = (await readdir(distDirectory)).sort();
  const sourceMaps = sourceFiles.filter((name) => name.endsWith(".map"));
  if (sourceMaps.length > 0) {
    throw new Error(`stage-pages.source-map-forbidden: observed ${sourceMaps.join(", ")}`);
  }
  if (sourceFiles.join("\n") !== [...PUBLISHABLE].sort().join("\n")) {
    throw new Error(`stage-pages.unexpected-contents: expected ${PUBLISHABLE.join(", ")}; observed ${sourceFiles.join(", ")}`);
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const stripped = [];
  for (const name of PUBLISHABLE) {
    const source = await readFile(join(distDirectory, name), "utf8");
    const clean = source.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?/gu, "\n");
    if (clean !== source) stripped.push(name);
    await writeFile(join(outputDirectory, name), clean);
  }
  // Pages must not run Jekyll over generated output.
  await writeFile(join(outputDirectory, ".nojekyll"), "");

  const observed = (await readdir(outputDirectory)).sort();
  const expected = [...PUBLISHABLE, ".nojekyll"].sort();
  if (observed.join("\n") !== expected.join("\n")) {
    throw new Error(
      `stage-pages.unexpected-contents: expected ${expected.join(", ")}; observed ${observed.join(", ")}`,
    );
  }

  for (const name of observed) {
    if (name === ".nojekyll") continue;
    const body = await readFile(join(outputDirectory, name), "utf8");
    for (const needle of FORBIDDEN) {
      if (body.includes(needle)) {
        throw new Error(`stage-pages.source-leak: ${name} contains ${needle}`);
      }
    }
  }

  return Object.freeze({ files: observed, strippedSourceMapComments: stripped });
}

if (process.argv[1]?.endsWith("stage-pages.mjs")) {
  const [dist, output] = process.argv.slice(2);
  if (dist === undefined || output === undefined) {
    throw new Error("usage: node tools/stage-pages.mjs DIST_DIRECTORY OUTPUT_DIRECTORY");
  }
  const result = await stagePages(dist, output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
