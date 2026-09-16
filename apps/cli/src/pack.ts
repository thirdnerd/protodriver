import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import {
  buildPdpkg,
  type LuaSourceMemberCandidate,
} from "@protodriver/contracts";
import { cliFileSystem, expectedCliError } from "./expected-error.ts";

export async function runPackCli(
  argv: readonly string[],
  io: { readonly output: Writable },
): Promise<void> {
  if (argv.length !== 2) {
    throw expectedCliError("cli.pack.usage", "usage: pdr pack <device-source-directory> <output-package>", "invocation");
  }
  const sourceDirectory = resolve(argv[0]!);
  const outputPath = resolve(argv[1]!);
  if (!(await cliFileSystem(sourceDirectory, () => stat(sourceDirectory))).isDirectory()) {
    throw expectedCliError("cli.source.invalid-kind", `${sourceDirectory} must name one Lua source directory`, "invocation");
  }
  const logicalNames = (await cliFileSystem(sourceDirectory, () => readdir(sourceDirectory, { withFileTypes: true })))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
    .map((entry) => entry.name)
    .sort();
  if (!logicalNames.includes("device.lua")) {
    throw expectedCliError("cli.source.entry-missing", `${sourceDirectory} must contain the exact Lua entry device.lua`, "definition");
  }
  const members: readonly LuaSourceMemberCandidate[] = Object.freeze(await Promise.all(
    logicalNames.map(async (logicalName) => Object.freeze({
      logicalName,
      sourceBytes: new Uint8Array(await cliFileSystem(resolve(sourceDirectory, logicalName), () => readFile(resolve(sourceDirectory, logicalName)))),
    })),
  ));
  const packed = await buildPdpkg(members);
  await cliFileSystem(outputPath, () => writeFile(outputPath, packed.archive));
  io.output.write(
    `${outputPath} (${packed.archive.byteLength} bytes;`
    + ` source-set sha256:${packed.sourceSetIdentity.hex})\n`,
  );
}
