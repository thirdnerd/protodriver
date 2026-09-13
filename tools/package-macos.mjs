#!/usr/bin/env node

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { buildCliPackage, main as packageCliMain } from "./package-cli.mjs";
import { darwinPackageTarget } from "./package/darwin-targets.mjs";

export function buildMacosPackage(options = {}) {
  darwinPackageTarget(options.target);
  return buildCliPackage(options);
}

export async function main(argv = process.argv.slice(2)) {
  return packageCliMain(argv, buildMacosPackage);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
