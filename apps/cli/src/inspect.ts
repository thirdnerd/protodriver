import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import { buildPdpkg, readPdpkg, type LuaSourceMemberCandidate } from "@protodriver/contracts";
import { admitAuthoredModule } from "@protodriver/core/authored-module";
import { renderAuthoredCliHelp } from "@protodriver/generated-cli";

export async function runInspectCli(
  argv: readonly string[],
  io: { readonly output: Writable },
): Promise<void> {
  if (argv.length !== 1) {
    throw new Error("usage: pdr inspect <device-directory-or-package>");
  }
  const input = await loadInspectionInput(argv[0]!);
  writeRequiredCliDocument("inspect", io.output, renderAuthoredInspection(input));
}

export function writeRequiredCliDocument(
  command: "inspect",
  output: Writable,
  document: string | Uint8Array,
): void {
  if (Buffer.byteLength(document) === 0) {
    throw new Error(`cli.${command}.empty-output: ${command} produced no document`);
  }
  output.write(document);
}

type InspectionInput = { readonly module: Awaited<ReturnType<typeof admitAuthoredModule>>;
  readonly members: readonly string[] };

async function loadInspectionInput(sourcePath: string): Promise<InspectionInput> {
  const source = resolve(sourcePath);
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    const names = (await readdir(source, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".lua"))
      .map((entry) => entry.name)
      .sort();
    if (!names.includes("device.lua")) throw new Error(`${source} must contain the exact Lua entry device.lua`);
    const members = await Promise.all(names.map(async (logicalName): Promise<LuaSourceMemberCandidate> => ({
      logicalName,
      sourceBytes: new Uint8Array(await readFile(resolve(source, logicalName))),
    })));
    return authoredInspection((await buildPdpkg(members)).archive, names);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`${source} must name a Lua source directory or package file`);
  }
  const bytes = new Uint8Array(await readFile(source));
  const packed = await readPdpkg(bytes);
  return authoredInspection(bytes, packed.members.map(({ logicalName }) => logicalName));
}

async function authoredInspection(
  input: Uint8Array | readonly LuaSourceMemberCandidate[],
  members: readonly string[],
): Promise<InspectionInput> {
  const artifact = new Uint8Array(await readFile(
    new URL("../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url),
  ));
  return { module: await admitAuthoredModule(input, artifact), members };
}

function renderAuthoredInspection(input: InspectionInput): string {
  return `${[
    "# Static generated interface",
    "",
    renderAuthoredCliHelp(input.module.description).trimEnd(),
    "",
    "# Executable internals",
    "",
    "Execution contract: authored-v2",
    `Source-set SHA-256: ${input.module.identity.sourceSet}`,
    `Execution identity: ${input.module.identity.digest}`,
    `Lua members: ${input.members.filter((name) => name.endsWith(".lua")).join(", ")}`,
    "Analysis: opaque authored Lua; bodies and dynamic control flow were not statically inspected.",
    "Inspection performed effect-free admission only; session entry, acquisition, and application I/O did not run.",
    "",
  ].join("\n")}\n`;
}
