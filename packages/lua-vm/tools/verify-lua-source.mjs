#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";

import { isMainModule } from "../../generated-cli/src/node-entry-point.ts";
import { RETAINED_LUA_BUILD_RECIPE as recipe } from "../src/index.ts";

export async function luaSourceAnchor(sourceDirectory) {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".c") || entry.name.endsWith(".h")))
    .map((entry) => entry.name)
    .sort(compareBytes);
  if (names.length !== recipe.lua.sourceMemberCount) {
    throw new Error(
      `lua-vm.source.member-count: expected ${recipe.lua.sourceMemberCount} .c/.h members, observed ${names.length}`,
    );
  }

  const memberDigests = [];
  for (const name of names) {
    if (basename(name) !== name) throw new Error(`lua-vm.source.basename: ${JSON.stringify(name)} is not a basename`);
    const contents = await readFile(resolve(sourceDirectory, name));
    const contentDigest = createHash("sha256").update(contents).digest("hex");
    memberDigests.push(createHash("sha256")
      .update(Buffer.from(name, "utf8"))
      .update(Uint8Array.of(0))
      .update(Buffer.from(contentDigest, "ascii"))
      .digest("hex"));
  }
  memberDigests.sort(compareBytes);
  const stream = `${memberDigests.join("\n")}\n`;
  const expectedStreamByteLength = recipe.lua.sourceMemberCount * 65; // 64 hex octets plus newline per member
  if (Buffer.byteLength(stream, "ascii") !== expectedStreamByteLength) {
    throw new Error(`lua-vm.source.stream-length: expected ${expectedStreamByteLength} octets, observed ${Buffer.byteLength(stream, "ascii")}`);
  }
  return {
    digest: createHash("sha256").update(stream, "ascii").digest("hex"),
    memberCount: names.length,
    names,
    streamByteLength: Buffer.byteLength(stream, "ascii"),
  };
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function main() {
  const sourceIndex = process.argv.indexOf("--source");
  if (sourceIndex < 0 || process.argv[sourceIndex + 1] === undefined) {
    throw new Error("usage: verify-lua-source.mjs --source LUA_SRC [--expect DIGEST]");
  }
  const result = await luaSourceAnchor(resolve(process.argv[sourceIndex + 1]));
  const expectIndex = process.argv.indexOf("--expect");
  const expected = expectIndex < 0 ? undefined : process.argv[expectIndex + 1];
  if (expected !== undefined && result.digest !== expected) {
    throw new Error(`lua-vm.source.digest-mismatch: expected ${expected}, observed ${result.digest}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (await isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
