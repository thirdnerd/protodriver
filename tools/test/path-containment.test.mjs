import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isPathWithin } from "../path-containment.mjs";

test("repository containment distinguishes descendants from siblings on Windows and POSIX", () => {
  for (const { api, root, child, sibling, parent, elsewhere } of [
    {
      api: win32,
      root: "C:\\Users\\third\\Documents\\protodriver",
      child: "C:\\Users\\third\\Documents\\protodriver\\tools\\build-package-web.mjs",
      sibling: "C:\\Users\\third\\Documents\\protodriver-other\\escape.mjs",
      parent: "C:\\Users\\third\\Documents",
      elsewhere: "D:\\outside\\escape.mjs",
    },
    {
      api: posix,
      root: "/home/third/protodriver",
      child: "/home/third/protodriver/tools/build-package-web.mjs",
      sibling: "/home/third/protodriver-other/escape.mjs",
      parent: "/home/third",
      elsewhere: "/outside/escape.mjs",
    },
  ]) {
    assert.equal(isPathWithin(root, child, api), true, `${api === win32 ? "win32" : "posix"} descendant`);
    assert.equal(isPathWithin(root, root, api), true);
    assert.equal(isPathWithin(root, sibling, api), false);
    assert.equal(isPathWithin(root, parent, api), false);
    assert.equal(isPathWithin(root, elsewhere, api), false);
  }
});

test("both traversals use the shared platform-aware containment decision", async () => {
  const bootstrap = await readFile(new URL("../check-package-bootstrap.mjs", import.meta.url), "utf8");
  const offline = await readFile(new URL("../check-browser-offline.mjs", import.meta.url), "utf8");
  assert.match(bootstrap, /if \(!isPathWithin\(root, dependency\)\)/u);
  assert.match(offline, /if \(!isPathWithin\(repositoryRoot, resolved\)\) continue;/u);
});
