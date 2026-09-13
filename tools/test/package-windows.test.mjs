import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  emitJavaScriptPackageTree,
  inspectPeArchitecture,
  verifyTargetNativeArchitectures,
} from "../package-cli.mjs";
import { win32PackageTarget } from "../package/win32-targets.mjs";
import { packageArchiveName } from "../package/targets.mjs";
import { stageWindowsPackageSmokePayload } from "../smoke-package-windows.mjs";
import { packCorpusModule } from "../pack-corpus.mjs";
import { admitAuthoredModule } from "../../packages/core/src/authored-module.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);

test("win32-x64 selects the official runtime and exactly two published native prebuilds", async () => {
  const target = win32PackageTarget("win32-x64");
  assert.equal(target.archiveFormat, "zip");
  assert.equal(packageArchiveName(target), "protodriver-win32-x64.zip");
  assert.deepEqual(target.crossAssemblyHosts, ["linux-x64"]);
  assert.equal(target.projectPackageLayout, "copy");
  assert.deepEqual(target.sourceRepresentation, {
    kind: "javascript",
    execution: "build-time-typescript-transpile",
    generator: "typescript@5.6.3",
  });
  assert.equal(
    target.node.officialArchiveUrl,
    "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip",
  );
  assert.equal(
    target.node.binarySha256,
    "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
  );
  assert.deepEqual(Object.keys(target.nativeInputs), ["serialport", "usb"]);
  for (const input of Object.values(target.nativeInputs)) {
    assert.equal(await inspectPeArchitecture(join(repositoryRoot, input.source)), "x86_64");
  }
});

test("Windows smoke stages the ZIP and generates Expand-Archive extraction", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-win32-smoke-stage-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const archive = join(scratch, "input.zip");
  await writeFile(archive, "staging does not execute this archive\n");
  const payload = await stageWindowsPackageSmokePayload({
    target: "win32-x64",
    archivePath: archive,
    outputDirectory: join(scratch, "payload"),
  });
  assert.equal(basename(payload.stagedArchive), "protodriver-win32-x64.zip");
  const script = await readFile(payload.scriptPath, "utf8");
  assert.match(script, /Expand-Archive -LiteralPath \$archive -DestinationPath \$workRoot/u);
  assert.doesNotMatch(script, /tar\.exe/u);
});

test("current CE delivery documents name an admitted authored operation", async () => {
  // Regression uniquely caught: a copied generated-v1 subcommand can otherwise
  // remain in a current hardware recipe after the package moves to authored v2.
  const [packed, wasm, windowsGuide] = await Promise.all([
    packCorpusModule(join(repositoryRoot, "corpus/ti84-plus-ce")),
    readFile(join(repositoryRoot, "packages/lua-vm/artifacts/protodriver-retained-v2.wasm")),
    readFile(join(repositoryRoot, "docs/windows-x64-package.md"), "utf8"),
  ]);
  const description = (await admitAuthoredModule(packed.archive, new Uint8Array(wasm))).description;
  const operationIds = new Set(description.operations.map(({ id }) => id));
  assertDocumentedWindowsOperation(windowsGuide, operationIds);
  assert.throws(
    () => assertDocumentedWindowsOperation(
      windowsGuide.replace("capture_screenshot --save-result", "capture-screenshot --save-result"),
      operationIds,
    ),
    /unknown authored CE operation "capture-screenshot"/u,
  );
  for (const document of [windowsGuide]) {
    const currentOperation = document.match(
      /current authored-v2 operation id(?: required for each rerun is)?\s+`([^`]+)`/u,
    );
    assert.ok(currentOperation, "current CE delivery document must identify its authored-v2 operation id");
    assert.ok(
      operationIds.has(currentOperation[1]),
      `current CE delivery document names unknown authored operation ${JSON.stringify(currentOperation[1])}`,
    );
  }
  assert.match(windowsGuide, /authored CLI does not transform/u);
});

test("Windows JavaScript emission makes a copied package executable under node_modules", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-win32-javascript-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const application = join(scratch, "app");
  const packageRoot = join(application, "node_modules", "@protodriver", "probe");
  await Promise.all([
    mkdir(join(application, "apps", "cli"), { recursive: true }),
    mkdir(join(application, "packages"), { recursive: true }),
    mkdir(join(packageRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(application, "native-smoke.ts"), "export const nativeSmoke: boolean = true;\n"),
    writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@protodriver/probe",
      type: "module",
      exports: "./src/index.ts",
    }, null, 2)}\n`),
    writeFile(
      join(packageRoot, "src", "index.ts"),
      'import { value } from "./value.ts";\nexport const result: number = value;\n',
    ),
    writeFile(join(packageRoot, "src", "index.js"), 'throw new Error("stale compatibility bridge");\n'),
    writeFile(join(packageRoot, "src", "value.ts"), "export const value: number = 42;\n"),
  ]);

  const invocation = [
    "--input-type=module",
    "--eval",
    'import { result } from "@protodriver/probe"; process.stdout.write(String(result));',
  ];
  await assert.rejects(
    execute(process.execPath, invocation, { cwd: application }),
    (cause) => cause?.stderr?.includes("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"),
  );

  await emitJavaScriptPackageTree(scratch, repositoryRoot);
  const executed = await execute(process.execPath, invocation, { cwd: application });
  assert.equal(executed.stdout, "42");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports, "./src/index.js");
  assert.match(await readFile(join(packageRoot, "src", "index.js"), "utf8"), /\.\/value\.js/u);
  await assert.rejects(readFile(join(packageRoot, "src", "index.ts")), { code: "ENOENT" });
  await readFile(join(application, "native-smoke.js"));
});

test("Windows native admission refuses a prebuild labelled for another architecture", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "protodriver-win32-native-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const target = win32PackageTarget("win32-x64");
  for (const input of Object.values(target.nativeInputs)) {
    const destination = join(scratch, input.source);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(repositoryRoot, input.source), destination);
  }
  const accepted = await verifyTargetNativeArchitectures(scratch, target);
  assert.deepEqual(accepted, { serialport: ["x86_64"], usb: ["x86_64"] });

  const serialport = join(scratch, target.nativeInputs.serialport.source);
  await rm(serialport);
  await writeFile(serialport, peFile(0xaa64));
  await assert.rejects(
    verifyTargetNativeArchitectures(scratch, target),
    /serialport has arm64, expected x86_64/u,
  );
});

function assertDocumentedWindowsOperation(windowsGuide, operationIds) {
  const invocation = windowsGuide.replaceAll(/`\r?\n\s*/gu, " ").match(
    /run \(Join-Path \$delivery "ti84-plus-ce\.pdpkg"\)\s+(\S+) --save-result \$capture/u,
  );
  assert.ok(invocation, "Windows guide must retain a mechanically checkable CE hardware invocation");
  assert.ok(
    operationIds.has(invocation[1]),
    `Windows guide names unknown authored CE operation ${JSON.stringify(invocation[1])}`,
  );
}

function peFile(machine) {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  view.setUint32(0x3c, 64, true);
  bytes.set([0x50, 0x45, 0, 0], 64);
  view.setUint16(68, machine, true);
  return bytes;
}
