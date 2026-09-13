import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { releaseArchiveNames, prepareReleaseAssets, publishDraftRelease } from "../release-assets.mjs";
import { releaseManifestFields, releaseVersionFromTag } from "../package/release-version.mjs";
import { CLI_PACKAGE_TARGETS, packageArchiveName } from "../package/targets.mjs";

const executeFile = promisify(execFile);

test("semantic 0.x tag and archive naming cover all five targets", () => {
  assert.equal(releaseVersionFromTag("v0.1.0"), "0.1.0");
  for (const invalid of ["v0.0.1", "v1.0.0", "v0.01.0", "0.1.0", "v0.1.0-rc1"]) {
    assert.throws(() => releaseVersionFromTag(invalid), /release tag/);
  }
  assert.deepEqual(releaseArchiveNames("v0.1.0"), [
    "protodriver-0.1.0-darwin-arm64.tar.gz",
    "protodriver-0.1.0-darwin-x64.tar.gz",
    "protodriver-0.1.0-linux-arm64.tar.gz",
    "protodriver-0.1.0-linux-x64.tar.gz",
    "protodriver-0.1.0-win32-x64.zip",
  ]);
  for (const target of Object.values(CLI_PACKAGE_TARGETS)) {
    assert.equal(packageArchiveName(target), `${target.packageRootName}.${target.archiveFormat}`);
  }
});

test("an untagged manifest has no version field, including no placeholder", () => {
  const fields = releaseManifestFields(undefined);
  assert.equal(Object.hasOwn(fields, "version"), false);
  assert.deepEqual(fields, {});
  assert.deepEqual(releaseManifestFields("0.1.0"), { version: "0.1.0" });
  assert.throws(() => releaseManifestFields("unreleased"), /release version/);
});

test("release assets require exactly five archives and produce sha256sum-compatible checksums", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = releaseArchiveNames("v0.1.0");
  await assert.rejects(prepareReleaseAssets({ tag: "v0.1.0", directory }), /archive-set-invalid/);
  for (const name of names) await writeFile(join(directory, name), `archive:${name}\n`);
  const assets = await prepareReleaseAssets({ tag: "v0.1.0", directory });
  const checksums = await readFile(assets.sumsPath, "utf8");
  assert.equal(checksums.trimEnd().split("\n").length, 5);
  for (const name of names) {
    const expected = createHash("sha256").update(`archive:${name}\n`).digest("hex");
    assert.ok(checksums.includes(`${expected}  ${name}\n`));
  }
  if (process.platform === "linux") {
    const check = await executeFile("sha256sum", ["-c", "SHA256SUMS"], { cwd: directory });
    assert.equal(check.stdout.trimEnd().split("\n").length, 5);
  }
  const calls = [];
  await publishDraftRelease({ tag: "v0.1.0", assets, execute: async (...args) => calls.push(args) });
  assert.deepEqual(calls[0][0], "gh");
  assert.deepEqual(calls[0][1].slice(0, 4), ["release", "create", "v0.1.0", "--draft"]);
  assert.ok(calls[0][1].includes("--verify-tag"));
  assert.deepEqual(calls[0][1].slice(-6), [...assets.archivePaths, assets.sumsPath]);
});
