import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultNodeRuntimeRoot,
  resolveBuildTarget,
} from "../build-package.mjs";
import { main as linuxPackageMain } from "../package-linux.mjs";
import { main as macosPackageMain } from "../package-macos.mjs";
import { main as windowsPackageMain } from "../package-windows.mjs";
import {
  hostPackageTarget,
  nativePackageTarget,
} from "../package/targets.mjs";
import { windowsSmokeInvocation } from "../smoke-package-windows.mjs";

const dummyPackageArguments = [
  "--output", "/unused-output",
  "--web-build", "/unused-web-build",
  "--source-commit", "0".repeat(40),
];

test("the ordinary package target follows the native host", () => {
  assert.equal(hostPackageTarget({ platform: "linux", architecture: "x64" }).id, "linux-x64");
  assert.equal(hostPackageTarget({ platform: "linux", architecture: "arm64" }).id, "linux-arm64");
  assert.equal(hostPackageTarget({ platform: "darwin", architecture: "arm64" }).id, "darwin-arm64");
  assert.equal(hostPackageTarget({ platform: "darwin", architecture: "x64" }).id, "darwin-x64");
  assert.equal(hostPackageTarget({ platform: "win32", architecture: "x64" }).id, "win32-x64");
  assert.throws(
    () => hostPackageTarget({ platform: "freebsd", architecture: "x64" }),
    /cli-package\.host-unsupported/u,
  );
});

test("an explicit one-command target must remain runnable for smoke", () => {
  assert.equal(
    resolveBuildTarget({ target: "linux-x64", platform: "linux", architecture: "x64" }).id,
    "linux-x64",
  );
  assert.throws(
    () => nativePackageTarget("win32-x64", { platform: "linux", architecture: "x64" }),
    /cli-package\.target-not-native/u,
  );
});

test("the package runtime root follows each official archive layout", () => {
  assert.equal(
    defaultNodeRuntimeRoot({ target: { os: "linux" }, executable: "/runtime/bin/node" }),
    "/runtime",
  );
  assert.equal(
    defaultNodeRuntimeRoot({ target: { os: "win32" }, executable: "C:/runtime/node.exe" }),
    "C:/runtime",
  );
});

test("platform package CLIs reject another platform before touching build inputs", async () => {
  await assert.rejects(
    linuxPackageMain(["--target", "darwin-arm64", ...dummyPackageArguments]),
    /linux-package\.target-unknown/u,
  );
  await assert.rejects(
    macosPackageMain(["--target", "linux-x64", ...dummyPackageArguments]),
    /darwin-package\.target-unknown/u,
  );
  await assert.rejects(
    windowsPackageMain(["--target", "linux-x64", ...dummyPackageArguments]),
    /win32-package\.target-unknown/u,
  );
});

test("Windows native smoke starts PowerShell with only operating-system commands on PATH", () => {
  const invocation = windowsSmokeInvocation({
    systemRoot: "C:\\Windows",
    scriptPath: "C:/scratch/smoke.ps1",
  });
  assert.equal(
    invocation.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.match(invocation.path, /^C:\\Windows\\System32;/u);
  assert.equal(invocation.arguments.at(-2), "-File");
  assert.match(invocation.arguments.at(-1), /smoke\.ps1$/u);
});
