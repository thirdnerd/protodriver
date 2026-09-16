import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildWebDistribution } from "../build.mjs";

const sourceDirectory = fileURLToPath(new URL("..", import.meta.url));

test("the web build declares only a configured package catalog in the document", async () => {
  const root = await mkdtemp(join(tmpdir(), "protodriver-web-build-"));
  const configuredOutput = join(root, "configured");
  const defaultOutput = join(root, "default");
  const catalogHref = '../pdpackages/catalog.json?channel=stable&label="public"';

  await buildWebDistribution({ sourceDirectory, outputDirectory: configuredOutput, catalogHref });
  const configuredPage = await readFile(join(configuredOutput, "index.html"), "utf8");
  assert.ok(configuredPage.includes(
    '<meta name="protodriver-package-catalog" content="../pdpackages/catalog.json?channel=stable&amp;label=&quot;public&quot;">',
  ));
  assert.ok(!(await readFile(join(configuredOutput, "app.js"), "utf8")).includes(catalogHref));

  await buildWebDistribution({ sourceDirectory, outputDirectory: defaultOutput });
  assert.equal(
    await readFile(join(defaultOutput, "index.html"), "utf8"),
    await readFile(join(sourceDirectory, "src", "index.html"), "utf8"),
  );
  assert.ok(!(await readFile(join(defaultOutput, "index.html"), "utf8")).includes(
    "protodriver-package-catalog",
  ));
});

// The deployment that publishes the hosted page is the only caller that sets a
// catalog location, and it invokes this builder as a command. An option reachable
// only from JavaScript would leave that deployment writing a one-off script, and
// an unrecognised flag must be refused rather than silently ignored.

const execute = promisify(execFile);
const builder = fileURLToPath(new URL("../build.mjs", import.meta.url));

test("the catalog location is settable from the command line", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "protodriver-web-cli-")), "dist");
  await execute(process.execPath, [builder, "--output", output, "--catalog", "../pdpackages/catalog.json"]);
  assert.ok((await readFile(join(output, "index.html"), "utf8")).includes(
    '<meta name="protodriver-package-catalog" content="../pdpackages/catalog.json">'),
    "the built page must declare the location the command line gave");
});

test("an unrecognised build flag is refused rather than ignored", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "protodriver-web-cli-")), "dist");
  await assert.rejects(
    execute(process.execPath, [builder, "--output", output, "--catalogue", "../typo/catalog.json"]),
    "a misspelled flag must fail the build, not produce a page without the declaration",
  );
});
