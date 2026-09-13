const NODE_LICENSE_SHA256 = "d9c4eeda951d6d08f4aa1316b61aafcf67e6da5f79b18f8edeb56fa6abdc038c";

function nativeInput(source, packaged, sha256) {
  return Object.freeze({ source, packaged, sha256 });
}

export const WIN32_PACKAGE_TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    id: "win32-x64",
    os: "win32",
    architecture: "x64",
    archiveFormat: "zip",
    manifestTarget: Object.freeze({ os: "win32", architecture: "x64" }),
    packageRootName: "protodriver-win32-x64",
    // The Windows target has only published prebuilds and a pinned official
    // runtime. It can therefore be assembled on the Linux x64 development
    // host without executing a target binary or running an install script.
    crossAssemblyHosts: Object.freeze(["linux-x64"]),
    projectPackageLayout: "copy",
    sourceRepresentation: Object.freeze({
      kind: "javascript",
      execution: "build-time-typescript-transpile",
      generator: "typescript@5.6.3",
    }),
    runtimeBinarySource: "node.exe",
    runtimeBinaryPackaged: "bin/node.exe",
    node: Object.freeze({
      version: "24.18.0",
      officialArchive: "node-v24.18.0-win-x64.zip",
      officialArchiveUrl: "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip",
      binarySha256: "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
      licenseSha256: NODE_LICENSE_SHA256,
    }),
    nativeFormat: "pe",
    peArchitecture: "x86_64",
    nativeInputs: Object.freeze({
      serialport: nativeInput(
        "apps/cli/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node",
        "app/node_modules/@serialport/bindings-cpp/prebuilds/win32-x64/@serialport+bindings-cpp.node",
        "eead9115994f9ad9471cd607ead9aa5c3dbf460c878bafdde41b68b57679fefc",
      ),
      usb: nativeInput(
        "apps/cli/node_modules/usb/prebuilds/win32-x64/node.napi.node",
        "app/node_modules/usb/prebuilds/win32-x64/node.napi.node",
        "d7532a9f5848cc6f2eafca813b9263ba1f7eb7f01264be447dcc7a3ed05410eb",
      ),
    }),
  }),
});

export function win32PackageTarget(id) {
  const target = WIN32_PACKAGE_TARGETS[id];
  if (target === undefined) {
    throw new Error(
      `win32-package.target-unknown: ${JSON.stringify(id)}; expected ${Object.keys(WIN32_PACKAGE_TARGETS).join(" or ")}`,
    );
  }
  return target;
}
