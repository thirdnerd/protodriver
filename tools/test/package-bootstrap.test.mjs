import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkPackageBootstrap } from "../check-package-bootstrap.mjs";

test("the one-command package static graph cannot need node_modules before installation", async () => {
  const result = await checkPackageBootstrap();
  assert.deepEqual(result.violations, []);
  assert.ok(result.files.includes("apps/web/build.mjs"));
  assert.ok(result.files.includes("tools/check-browser-offline.mjs"));
});

test("the graph check catches a transitive static bare import", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "package-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tools"), { recursive: true });
  await writeFile(join(root, "tools/build-package.mjs"), 'import "./nested.mjs";\n');
  await writeFile(join(root, "tools/nested.mjs"), 'import "esbuild";\n');
  const result = await checkPackageBootstrap({ sourceDirectory: root });
  assert.match(result.violations.join("\n"), /tools\/nested\.mjs: static import "esbuild"/u);
});
