import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkBrowserOffline } from "../check-browser-offline.mjs";
import { buildPackageWeb } from "../build-package-web.mjs";
import { stageWebApplication } from "../package-cli.mjs";
import {
  PACKAGE_WEB_BUILD_MANIFEST,
  packageWebSourceSha256,
} from "../package/web-build.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("packaged web assets reproduce, stay offline, and reject a planted network load", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-web-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const firstBuildRoot = join(scratch, "first", "web-build");
  const secondBuildRoot = join(scratch, "nested", "second", "web-build");
  const firstBuild = await buildPackageWeb({
    outputDirectory: firstBuildRoot,
    sourceDirectory: repositoryRoot,
  });
  const secondBuild = await buildPackageWeb({
    outputDirectory: secondBuildRoot,
    sourceDirectory: repositoryRoot,
  });
  assert.deepEqual(firstBuild.manifest, secondBuild.manifest);

  const firstRoot = join(scratch, "package", "protodriver-linux-x64");
  const secondRoot = join(scratch, "package", "protodriver-win32-x64");
  const first = await stageWebApplication(firstRoot, repositoryRoot, firstBuildRoot);
  const second = await stageWebApplication(secondRoot, repositoryRoot, firstBuildRoot);

  assert.equal(first.offlineFilesChecked, 4);
  assert.deepEqual(first.assets, second.assets);
  assert.equal(first.sourceSha256, second.sourceSha256);
  assert.equal(first.assets.length, 4);
  assert.deepEqual(
    first.assets.filter(({ path }) => path.endsWith(".map")).map(({ path }) => path),
    [],
  );
  for (const { path } of first.assets) {
    assert.deepEqual(
      await readFile(join(firstRoot, "app/apps/web/dist", path)),
      await readFile(join(secondRoot, "app/apps/web/dist", path)),
      `${path} differs across builds`,
    );
  }

  const staleManifestPath = join(secondBuildRoot, PACKAGE_WEB_BUILD_MANIFEST);
  const staleManifest = JSON.parse(await readFile(staleManifestPath, "utf8"));
  staleManifest.sourceSha256 = "0".repeat(64);
  await writeFile(staleManifestPath, `${JSON.stringify(staleManifest, null, 2)}\n`);
  await assert.rejects(
    stageWebApplication(join(scratch, "stale-package"), repositoryRoot, secondBuildRoot),
    /package-web-build\.source-stale/u,
  );
  await writeFile(
    staleManifestPath,
    `${JSON.stringify(secondBuild.manifest, null, 2)}\n`,
  );
  const changedAssetPath = join(secondBuildRoot, "dist", "app.js");
  await writeFile(changedAssetPath, `${await readFile(changedAssetPath, "utf8")}\n`);
  await assert.rejects(
    stageWebApplication(join(scratch, "changed-package"), repositoryRoot, secondBuildRoot),
    /package-web-build\.assets-changed/u,
  );
  await assert.rejects(
    stageWebApplication(join(scratch, "absent-package"), repositoryRoot, join(scratch, "absent")),
    /package-web-build\.manifest-invalid/u,
  );

  await writeFile(join(firstBuildRoot, "dist", "app.js.map"), "private source\n");
  await assert.rejects(
    stageWebApplication(join(scratch, "map-package"), repositoryRoot, firstBuildRoot),
    /package-web-build\.sourcemap-forbidden/u,
  );

  const indexPath = join(firstRoot, "app/apps/web/dist/index.html");
  await writeFile(
    indexPath,
    `${await readFile(indexPath, "utf8")}\n<script src="https://control.invalid/planted.js"></script>\n`,
  );
  const broken = await checkBrowserOffline(join(firstRoot, "app/apps/web/dist"));
  assert.equal(broken.failures.length, 1);
  assert.match(broken.failures[0], /https:\/\/control\.invalid\/planted\.js/u);
});

test("the shared web source fingerprint reaches new source and ignores installed dependencies", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-package-web-source-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(scratch, "apps/web"), { recursive: true }),
    mkdir(join(scratch, "packages"), { recursive: true }),
    mkdir(join(scratch, "tools/package"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(scratch, "apps/web/main.ts"), "export const value = 1;\n"),
    writeFile(join(scratch, "tools/build-package-web.mjs"), "build\n"),
    writeFile(join(scratch, "tools/check-browser-offline.mjs"), "offline\n"),
    writeFile(join(scratch, "tools/package/web-build.mjs"), "manifest\n"),
  ]);
  const initial = await packageWebSourceSha256(scratch);
  await writeFile(join(scratch, "packages/new-input.ts"), "export const added = true;\n");
  const changed = await packageWebSourceSha256(scratch);
  assert.notEqual(changed, initial);
  await mkdir(join(scratch, "apps/web/node_modules/esbuild"), { recursive: true });
  await writeFile(join(scratch, "apps/web/node_modules/esbuild/platform"), "darwin-arm64\n");
  assert.equal(await packageWebSourceSha256(scratch), changed);
});
