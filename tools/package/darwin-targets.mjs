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

const SERIALPORT_SOURCE = "apps/cli/node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node";
const SERIALPORT_PACKAGED = "app/node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node";
const USB_SOURCE = "apps/cli/node_modules/usb/prebuilds/darwin-x64+arm64/node.napi.node";
const USB_PACKAGED = "app/node_modules/usb/prebuilds/darwin-x64+arm64/node.napi.node";
const IOCTL_PACKAGED = "app/node_modules/ioctl/build/Release/ioctl.node";

function darwinTarget({ architecture, machOArchitecture, node }) {
  const id = `darwin-${architecture}`;
  return Object.freeze({
    id,
    os: "darwin",
    architecture,
    archiveFormat: "tar.gz",
    // Both pinned Node binaries declare 13.5 in LC_BUILD_VERSION. The
    // universal serialport and USB slices declare older minimums.
    minimumMacos: "13.5",
    manifestTarget: Object.freeze({ os: "darwin", architecture, minimumMacos: "13.5" }),
    packageRootName: `protodriver-${id}`,
    node,
    nativeFormat: "mach-o",
    machOArchitecture,
    nativeInputs: Object.freeze({
      serialport: nativeInput(
        SERIALPORT_SOURCE,
        SERIALPORT_PACKAGED,
        "23daa6940614b42ac940c96e0f420d7576738a515f29c25bc1e1790f9abd5704",
      ),
      usb: nativeInput(
        USB_SOURCE,
        USB_PACKAGED,
        "dfd07f2c18f1aaabf6acef35435c2097ebef5683aa949a663c424ccb3b4960d0",
      ),
      ioctl: nativeInput(
        `packages/transport-node-serial/node_modules/ioctl/build/protodriver/${id}-node-v24.18.0/ioctl.node`,
        IOCTL_PACKAGED,
      ),
    }),
  });
}

export const DARWIN_PACKAGE_TARGETS = Object.freeze({
  "darwin-arm64": darwinTarget({
    architecture: "arm64",
    machOArchitecture: "arm64",
    node: nodeRuntime(
      "node-v24.18.0-darwin-arm64.tar.gz",
      "ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a",
    ),
  }),
  "darwin-x64": darwinTarget({
    architecture: "x64",
    machOArchitecture: "x86_64",
    node: nodeRuntime(
      "node-v24.18.0-darwin-x64.tar.gz",
      "c5afe80c9fd47c0e1ba3a7221173d061dae04577acc67e21e945d16e34c696c8",
    ),
  }),
});

export function darwinPackageTarget(id) {
  const target = DARWIN_PACKAGE_TARGETS[id];
  if (target === undefined) {
    throw new Error(
      `darwin-package.target-unknown: ${JSON.stringify(id)}; expected ${Object.keys(DARWIN_PACKAGE_TARGETS).join(" or ")}`,
    );
  }
  return target;
}
