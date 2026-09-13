import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import {
  buildPdpkg,
  type LuaSourceMemberCandidate,
} from "@protodriver/contracts";

export async function runPackCli(
  argv: readonly string[],
  io: { readonly output: Writable },
): Promise<void> {
  if (argv.length !== 2) {
    throw new Error("usage: pdr pack <device-source-directory> <output-package>");
  }
  const sourceDirectory = resolve(argv[0]!);
  const outputPath = resolve(argv[1]!);
  if (!(await stat(sourceDirectory)).isDirectory()) {
    throw new Error(`${sourceDirectory} must name one Lua source directory`);
  }
  const logicalNames = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
    .map((entry) => entry.name)
    .sort();
  if (!logicalNames.includes("device.lua")) {
    throw new Error(`${sourceDirectory} must contain the exact Lua entry device.lua`);
  }
  const members: readonly LuaSourceMemberCandidate[] = Object.freeze(await Promise.all(
    logicalNames.map(async (logicalName) => Object.freeze({
      logicalName,
      sourceBytes: new Uint8Array(await readFile(resolve(sourceDirectory, logicalName))),
    })),
  ));
  const packed = await buildPdpkg(members);
  await writeFile(outputPath, packed.archive);
  io.output.write(
    `${outputPath} (${packed.archive.byteLength} bytes;`
    + ` source-set sha256:${packed.sourceSetIdentity.hex})\n`,
  );
}
