import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stagePages } from "../stage-pages.mjs";

const PUBLISHABLE = ["index.html", "app.js", "styles.css",
  "sessionWorker.js"];

async function distWith(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "protodriver-stage-pages-"));
  const dist = join(root, "dist");
  await mkdir(dist);
  for (const name of PUBLISHABLE) {
    await writeFile(join(dist, name), overrides[name] ?? `// ${name}\n`);
  }
  return { root, dist, output: join(root, "pages") };
}

test("staging publishes the four browser assets and .nojekyll", async () => {
  const { dist, output } = await distWith();
  const result = await stagePages(dist, output);
  assert.deepEqual(result.files.sort(),
    [".nojekyll", ...PUBLISHABLE].sort(),
    "only the publishable set plus .nojekyll reaches the branch");
  assert.deepEqual((await readdir(output)).sort(), [".nojekyll", ...PUBLISHABLE].sort());
});

test("staging refuses an unexpected sixth source file rather than silently skipping it", async () => {
  const { dist, output } = await distWith();
  await writeFile(join(dist, "surprise.txt"), "unexpected\n");
  await assert.rejects(stagePages(dist, output), /stage-pages\.unexpected-contents/u);
});

test("a reintroduced source map refuses staging", async () => {
  const { dist, output } = await distWith();
  await writeFile(join(dist, "app.js.map"), "private source\n");
  await assert.rejects(stagePages(dist, output), /stage-pages\.source-map-forbidden/u);
});

test("the sourceMappingURL comment is stripped, not published to 404", async () => {
  const { dist, output } = await distWith({
    "app.js": "const a = 1;\n//# sourceMappingURL=app.js.map\n",
  });
  const result = await stagePages(dist, output);
  assert.deepEqual(result.strippedSourceMapComments, ["app.js"]);
  const body = await readFile(join(output, "app.js"), "utf8");
  assert.ok(!body.includes("sourceMappingURL"));
  assert.ok(body.includes("const a = 1;"), "the code itself survives");
});

test("embedded source refuses the whole staging rather than shipping it", async () => {
  // esbuild can inline a map; that carries sourcesContent into the .js itself.
  const { dist, output } = await distWith({
    "sessionWorker.js": 'const m = {"sourcesContent":["export const secret = 1;"]};\n',
  });
  await assert.rejects(
    stagePages(dist, output),
    /stage-pages\.source-leak: sessionWorker\.js contains sourcesContent/u,
    "a leak fails the staging instead of producing a publishable directory",
  );
});
