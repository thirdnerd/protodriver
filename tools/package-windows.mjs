#!/usr/bin/env node

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import { buildCliPackage, main as packageCliMain } from "./package-cli.mjs";
import { win32PackageTarget } from "./package/win32-targets.mjs";

export function buildWindowsPackage(options = {}) {
  win32PackageTarget(options.target);
  return buildCliPackage(options);
}

export async function main(argv = process.argv.slice(2)) {
  return packageCliMain(argv, buildWindowsPackage);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
