const NODE_LICENSE_SHA256 = "148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5";

function nodeRuntime(archive, binarySha256) {
  return Object.freeze({
    version: "24.18.0",
    officialArchive: archive,
    officialArchiveUrl: `https://nodejs.org/dist/v24.18.0/${archive}`,
    binarySha256,
    licenseSha256: NODE_LICENSE_SHA256,
  });
}

function nativeInput(source, packaged, sha256) {
  return Object.freeze({ source, packaged, ...(sha256 === undefined ? {} : { sha256 }) });
}

export const LINUX_PACKAGE_TARGETS = Object.freeze({
  "linux-x64": Object.freeze({
    id: "linux-x64",
    os: "linux",
    architecture: "x64",
    archiveFormat: "tar.gz",
    libc: "glibc",
    manifestTarget: Object.freeze({ os: "linux", architecture: "x64", libc: "glibc" }),
    packageRootName: "protodriver-linux-x64",
    node: nodeRuntime(
      "node-v24.18.0-linux-x64.tar.xz",
      "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c",
    ),
    nativeInputs: Object.freeze({
      serialport: nativeInput(
        "apps/cli/node_modules/@serialport/bindings-cpp/prebuilds/linux-x64/@serialport+bindings-cpp.glibc.node",
        "app/node_modules/@serialport/bindings-cpp/prebuilds/linux-x64/@serialport+bindings-cpp.glibc.node",
        "572054004570f2a93630ca716c32947257283d1abbfd536f7a91cf6d98dc50db",
      ),
      usb: nativeInput(
        "apps/cli/node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node",
        "app/node_modules/usb/prebuilds/linux-x64/node.napi.glibc.node",
        "fbbe12c009f1ad4aba6c8b3c489233ecaf98d25b4b15daeba2e3c9f9c86fc75d",
      ),
      ioctl: nativeInput(
        "packages/transport-node-serial/node_modules/ioctl/build/Release/ioctl.node",
        "app/node_modules/ioctl/build/Release/ioctl.node",
      ),
    }),
    smokeSharedLibraries: Object.freeze([
      Object.freeze(["/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", "/lib64/ld-linux-x86-64.so.2"]),
      ...["libc.so.6", "libdl.so.2", "libgcc_s.so.1", "libm.so.6", "libpthread.so.0", "libstdc++.so.6", "libudev.so.1"]
        .map((name) => Object.freeze([`/usr/lib/x86_64-linux-gnu/${name}`, `/usr/lib/x86_64-linux-gnu/${name}`])),
    ]),
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64",
    os: "linux",
    architecture: "arm64",
    archiveFormat: "tar.gz",
    libc: "glibc",
    manifestTarget: Object.freeze({ os: "linux", architecture: "arm64", libc: "glibc" }),
    packageRootName: "protodriver-linux-arm64",
    node: nodeRuntime(
      "node-v24.18.0-linux-arm64.tar.xz",
      "6bf69d0eda41a12030d5f28d958cd09ce323bc0c13f1ab4d8bb426933aa08812",
    ),
    nativeInputs: Object.freeze({
      serialport: nativeInput(
        "apps/cli/node_modules/@serialport/bindings-cpp/prebuilds/linux-arm64/@serialport+bindings-cpp.armv8.glibc.node",
        "app/node_modules/@serialport/bindings-cpp/prebuilds/linux-arm64/@serialport+bindings-cpp.armv8.glibc.node",
        "a92389bed45b1ea7f9613e6c01de18e60cf58d484cddf065d8603c9143876f8f",
      ),
      usb: nativeInput(
        "apps/cli/node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node",
        "app/node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node",
        "bb6e73a8e8285d680bac99d93fe6ae79557ca9205f52aa1e4fa938fe93193e33",
      ),
      ioctl: nativeInput(
        "packages/transport-node-serial/node_modules/ioctl/build/Release/ioctl.node",
        "app/node_modules/ioctl/build/Release/ioctl.node",
      ),
    }),
    smokeSharedLibraries: Object.freeze([
      Object.freeze(["/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1", "/lib/ld-linux-aarch64.so.1"]),
      ...["libc.so.6", "libdl.so.2", "libgcc_s.so.1", "libm.so.6", "libpthread.so.0", "libstdc++.so.6", "libudev.so.1"]
        .map((name) => Object.freeze([`/usr/lib/aarch64-linux-gnu/${name}`, `/usr/lib/aarch64-linux-gnu/${name}`])),
    ]),
  }),
});

export function linuxPackageTarget(id) {
  const target = LINUX_PACKAGE_TARGETS[id];
  if (target === undefined) {
    throw new Error(`linux-package.target-unknown: ${JSON.stringify(id)}; expected ${Object.keys(LINUX_PACKAGE_TARGETS).join(" or ")}`);
  }
  return target;
}
