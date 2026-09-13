# macOS package exceptions

Start with the [one-command build](building.md):

```sh
node tools/build-package.mjs
```

An arm64 Node process selects `darwin-arm64`; an x64 process selects
`darwin-x64`. The command installs dependencies without lifecycle scripts,
builds the browser distribution, compiles the target's ioctl addon with
`xcrun`, builds the archive, and smokes it.

## Xcode, architectures, and Rosetta

The host needs Xcode Command Line Tools and its macOS SDK. `ioctl@2.0.2` has no
Darwin prebuild, so `tools/package/build-darwin-ioctl.mjs` invokes Apple clang
with the selected `-arch` and the package's macOS 13.5 floor. Both it and the
packager inspect the resulting Mach-O architecture.

Building both release targets on one Apple Silicon Mac means running the
one-command build once with native arm64 Node and once under the official x64
Node with Rosetta. That invokes `xcrun` once per target—twice total—and ensures
each archive is smoked by its own architecture's runtime. A native Intel Mac
builds only `darwin-x64` and does not need Rosetta.

The serialport and USB inputs are pinned universal binaries. Each final archive
contains those universal files plus only its architecture-specific ioctl addon
and Node runtime.

## Smoke boundary

The macOS smoke uses `/usr/bin/env -i` with a scratch `HOME`, `TMPDIR`, payload,
and a command path containing only the required system shell tools. It proves
that Node, npm, and a compiler do not resolve from `PATH`, then uses the
archive's own runtime to serve browser assets, pack and admit Device 2, reach
device discovery, and load all three native addons.

Unlike Linux Bubblewrap, this creates no filesystem or process namespace and
does not isolate the network, system frameworks, services, or devices. It is a
package-relative resolution check, not a sandbox or hardware test.

## Low-level entry points

Release work with dependencies and a shared web build already prepared may use
`tools/package/build-darwin-ioctl.mjs`, `tools/package-macos.mjs`, and
`tools/smoke-package-macos.mjs` directly. `package-macos.mjs` validates that
its target is Darwin; `--target linux-x64` is a refusal rather than a Linux
build through the wrong wrapper.

Device access remains subject to macOS permissions, IOKit state, and kernel
drivers. The smoke does not open hardware.
