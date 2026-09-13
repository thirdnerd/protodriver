#!/usr/bin/env node

import { isMainModule } from "../packages/generated-cli/src/node-entry-point.ts";
import {
  buildCliPackage,
  discoverCliProjectPackages,
  main as packageCliMain,
} from "./package-cli.mjs";
import { linuxPackageTarget } from "./package/linux-targets.mjs";

export { discoverCliProjectPackages };

export function buildLinuxPackage(options = {}) {
  linuxPackageTarget(options.target);
  return buildCliPackage(options);
}

export async function main(argv = process.argv.slice(2)) {
  return packageCliMain(argv, buildLinuxPackage);
}

if (await isMainModule(import.meta.url)) {
  await main();
}
