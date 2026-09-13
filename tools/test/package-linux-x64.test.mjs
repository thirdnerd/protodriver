import assert from "node:assert/strict";
import test from "node:test";
import { linuxPackageTarget } from "../package/linux-targets.mjs";

// Product archive assertions live in tools/package/linux-x64.test.mjs.
test("Linux target inputs select the ARM64 runtime and all three native paths", () => {
  const x64 = linuxPackageTarget("linux-x64");
  const arm64 = linuxPackageTarget("linux-arm64");
  assert.equal(x64.archiveFormat, "tar.gz");
  assert.equal(arm64.archiveFormat, "tar.gz");
  assert.deepEqual(
    { os: arm64.os, architecture: arm64.architecture, libc: arm64.libc },
    { os: "linux", architecture: "arm64", libc: "glibc" },
  );
  assert.equal(
    arm64.node.officialArchiveUrl,
    "https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-arm64.tar.xz",
  );
  assert.equal(arm64.node.binarySha256, "6bf69d0eda41a12030d5f28d958cd09ce323bc0c13f1ab4d8bb426933aa08812");
  for (const name of ["serialport", "usb", "ioctl"]) {
    assert.equal(typeof arm64.nativeInputs[name].source, "string");
    assert.equal(typeof arm64.nativeInputs[name].packaged, "string");
  }
  assert.notEqual(arm64.nativeInputs.serialport.source, x64.nativeInputs.serialport.source);
  assert.notEqual(arm64.nativeInputs.usb.source, x64.nativeInputs.usb.source);
});
