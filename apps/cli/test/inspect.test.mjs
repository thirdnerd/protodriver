import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runInspectCli, writeRequiredCliDocument } from "../src/inspect.ts";
import { packageBytes, source } from "./fixtures/authored-front-door.mjs";

test("a document command cannot report success without output", () => {
  const output = { write() { assert.fail("an empty document must not reach the output stream"); } };
  assert.throws(
    () => writeRequiredCliDocument("inspect", output, ""),
    /cli\.inspect\.empty-output: inspect produced no document/u,
  );
});

test("inspect separates an authored package's static interface from opaque executable internals", async t => {
  // Authored inspection must not present opaque Lua as statically analyzed
  // executable protocol branches.
  const directory = await mkdtemp(join(tmpdir(), "pdr-inspect-authored-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "module.pdpkg");
  await writeFile(path, await packageBytes());
  const text = await inspect(path);
  assert.match(text, /^# Static generated interface$/mu);
  assert.match(text, /^front-door \(front-door, device\/v2\)$/mu);
  assert.match(text, /^# Executable internals$/mu);
  assert.match(text, /^Execution contract: authored-v2$/mu);
  assert.match(text, /^Lua members: device\.lua$/mu);
  assert.match(text, /opaque authored Lua; bodies and dynamic control flow were not statically inspected/u);
  assert.match(text, /session entry, acquisition, and application I\/O did not run/u);
  assert.doesNotMatch(text, /function\s+echo/u, "inspect must not dump executable source as an internals account");
});

test("inspect gives an authored source directory the same opaque-internals boundary", async t => {
  // Unique regression: directory convenience bypassing the authored-v2
  // inspection classification used by the package form.
  const directory = await mkdtemp(join(tmpdir(), "pdr-inspect-authored-directory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, "device.lua"), source),
  ]);
  const text = await inspect(directory);
  assert.match(text, /^# Static generated interface$/mu);
  assert.match(text, /^# Executable internals$/mu);
  assert.match(text, /^Lua members: device\.lua$/mu);
  assert.match(text, /opaque authored Lua/u);
});

async function inspect(path) {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  await runInspectCli([path], { output });
  return text;
}
