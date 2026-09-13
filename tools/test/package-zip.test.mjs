import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createDeterministicDeflatedZip,
  createDeterministicStoredZip,
  inspectStoredZip,
  readStoredZipMember,
} from "../package/stored-zip.mjs";

const execute = promisify(execFile);

test("stored ZIP output has sorted entries, fixed timestamps, and reproducible bytes", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-stored-zip-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, "source", "product");
  await mkdir(join(root, "bin"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "PACKAGE-MANIFEST.json"), '{"sourceCommit":"0000"}\n'),
    writeFile(join(root, "bin", "pdr.cmd"), "@echo off\r\n"),
  ]);
  const first = join(scratch, "first.zip");
  const second = join(scratch, "second.zip");
  await createDeterministicStoredZip({
    outputPath: first,
    rootDirectory: root,
    rootName: "product",
  });
  await Promise.all([
    utimes(root, 1_000_000_000, 1_000_000_000),
    utimes(join(root, "bin", "pdr.cmd"), 2_000_000_000, 2_000_000_000),
  ]);
  await createDeterministicStoredZip({
    outputPath: second,
    rootDirectory: root,
    rootName: "product",
  });

  assert.deepEqual(await readFile(first), await readFile(second));
  const inspection = await inspectStoredZip(first);
  assert.deepEqual(inspection.entries.map(({ name }) => name), [
    "product/",
    "product/PACKAGE-MANIFEST.json",
    "product/bin/",
    "product/bin/pdr.cmd",
  ]);
  assert.ok(inspection.entries.every(({ dosDate, dosTime }) => dosDate === 0x21 && dosTime === 0));
  assert.equal(
    (await readStoredZipMember(first, "product/PACKAGE-MANIFEST.json", inspection)).toString(),
    '{"sourceCommit":"0000"}\n',
  );
});

test("deflated ZIP output is compressed, reproducible, and independently readable", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-deflated-zip-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, "source", "bundle");
  await mkdir(root, { recursive: true });
  const payload = "compressible author guidance\n".repeat(8_192);
  await writeFile(join(root, "README.md"), payload);
  const first = join(scratch, "first.zip");
  const second = join(scratch, "second.zip");
  await createDeterministicDeflatedZip({
    outputPath: first,
    rootDirectory: root,
    rootName: "bundle",
  });
  await createDeterministicDeflatedZip({
    outputPath: second,
    rootDirectory: root,
    rootName: "bundle",
  });

  const firstBytes = await readFile(first);
  assert.deepEqual(firstBytes, await readFile(second));
  assert.ok(firstBytes.byteLength < Buffer.byteLength(payload));
  await execute("unzip", ["-t", first]);
  assert.equal((await execute("unzip", ["-p", first, "bundle/README.md"])).stdout, payload);
  assert.match(
    (await execute("unzip", ["-lv", first])).stdout,
    /Defl:N\s+\d+\s+\d+%\s+1980-01-01 00:00\s+[0-9a-f]{8}\s+bundle\/README\.md/u,
  );
  assert.deepEqual(
    (await execute("unzip", ["-Z1", first])).stdout.trim().split("\n"),
    ["bundle/", "bundle/README.md"],
  );
});
