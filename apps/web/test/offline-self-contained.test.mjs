import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkBrowserOffline,
  inspectBrowserCss,
  inspectBrowserHtml,
  inspectBrowserScript,
} from "../../../tools/check-browser-offline.mjs";

test("browser offline scan rejects external runtime loads without banning inert URL text", () => {
  assert.equal(inspectBrowserHtml('<!-- https://docs.example/ --><svg xmlns="http://www.w3.org/2000/svg"></svg>').length, 0);
  assert.equal(inspectBrowserScript('// https://docs.example/\nconst documentation = "https://docs.example/";').length, 0);
  assert.deepEqual(
    inspectBrowserHtml('<link rel="stylesheet" href="https://cdn.example/theme.css">')
      .map(({ sink, reference }) => ({ sink, reference })),
    [{ sink: "link[href]", reference: "https://cdn.example/theme.css" }],
  );
  assert.equal(inspectBrowserHtml('<script src="//cdn.example/app.js"></script>').length, 1);
  assert.equal(inspectBrowserCss('@import "https://cdn.example/theme.css";').length, 1);
  assert.equal(inspectBrowserCss('.mark { background: url(//cdn.example/mark.svg); }').length, 1);
  assert.equal(inspectBrowserScript('fetch("https://api.example/state")').length, 1);
  assert.equal(inspectBrowserScript('const request = new XMLHttpRequest(); request.open("GET", "https://api.example/state");').length, 1);
  assert.equal(inspectBrowserScript('new Worker(new URL("https://cdn.example/worker.js"))').length, 1);
});

test("browser offline check fails on an external stylesheet and refuses an empty source population", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "protodriver-browser-offline-"));
  t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, "index.html"), '<link rel="stylesheet" href="https://cdn.example/theme.css">\n');
  await writeFile(join(root, "styles.css"), ":root { color: black; }\n");
  const result = await checkBrowserOffline(root);
  assert.equal(result.fileCount, 2);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /index\.html:1:[0-9]+ external runtime dependency "https:\/\/cdn\.example\/theme\.css" via link\[href\]/u);

  const empty = await mkdtemp(join(tmpdir(), "protodriver-browser-offline-empty-"));
  t.after(() => rm(empty, { recursive: true }));
  await mkdir(empty, { recursive: true });
  await assert.rejects(checkBrowserOffline(empty), /required source index\.html is absent/u);
});

test("browser offline graph reaches the committed Lua VM", async () => {
  const result = await checkBrowserOffline();
  assert.equal(result.runtimeAssetCount, 1);
  assert.deepEqual(result.runtimeAssets.map(path => path.slice(path.lastIndexOf("/packages/") + 1)).sort(), [
    "packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  ]);
  assert.deepEqual(result.failures, []);
});
