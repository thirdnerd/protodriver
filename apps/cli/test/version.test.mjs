import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { pdrVersion } from "../src/version.ts";

const commit = "0123456789abcdef0123456789abcdef01234567";

test("pdr --version reads independent literal release and untagged manifests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pdr-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = pathToFileURL(join(directory, "PACKAGE-MANIFEST.json"));
  assert.equal(await pdrVersion(manifest), "pdr: not a released build (source commit unavailable)\n");
  await writeFile(manifest, `{"format":"protodriver.cli-package/v1","sourceCommit":"${commit}"}\n`);
  assert.equal(await pdrVersion(manifest), `pdr: not a released build (source commit ${commit})\n`);
  await writeFile(manifest, `{"format":"protodriver.cli-package/v1","sourceCommit":"${commit}","version":"0.1.0"}\n`);
  assert.equal(await pdrVersion(manifest), `pdr 0.1.0 (source commit ${commit})\n`);
});
