import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../packages/generated-cli/src/node-entry-point.ts";

test("main-module detection canonicalizes the invoked and loaded paths", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "node-entry-point-alias-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const modulePath = fileURLToPath(import.meta.url);
  const aliasPath = join(scratch, "aliased-entry-point.mjs");
  const otherPath = join(scratch, "other.mjs");
  await Promise.all([
    symlink(modulePath, aliasPath),
    writeFile(otherPath, "export {};\n"),
  ]);

  assert.equal(await isMainModule(import.meta.url, [process.execPath, aliasPath]), true);
  assert.equal(await isMainModule(import.meta.url, [process.execPath, otherPath]), false);
  assert.equal(await isMainModule(import.meta.url, [process.execPath]), false);
});
