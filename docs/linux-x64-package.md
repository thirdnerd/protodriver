# Linux package exceptions

Start with the [one-command build](building.md):

```sh
node tools/build-package.mjs
```

It selects `linux-x64` or `linux-arm64` from the running Node process, installs
dependencies, builds the web distribution and archive, and runs the smoke.

## Native build prerequisites

The build host needs a C++ toolchain, Python 3, `libudev` development headers,
`udevadm`, GNU tar, Bubblewrap, and static BusyBox. On Ubuntu:

```sh
sudo apt-get install build-essential python3 libudev-dev udev bubblewrap busybox-static
```

The Linux dependency recipe runs `npm ci` across the complete CLI/web workspace
closure, then explicitly rebuilds serialport, USB, and ioctl native modules.
The archive contains only the selected target's glibc prebuilds and locally
built ioctl addon. Its observed runtime floor is glibc 2.28; USB requires
`libudev.so.1`, and serial enumeration uses `udevadm`.

The smoke creates a Bubblewrap filesystem and process namespace containing no
ambient Node, npm, compiler, checkout, or builder `node_modules`. It unpacks
the archive, serves and fetches every browser asset, packs and admits the
Device 2 source, reaches the expected no-candidate operation result, and loads
the serialport, USB, and ioctl boundaries. It does not open hardware or run a
browser.

## Linux arm64 container alternative

The ordinary arm64 path must run on an arm64 host. If that host cannot provide
Bubblewrap user namespaces, run the same command inside an arm64 Linux
container with the repository mounted, Node 24.18.0 selected, and the packages
above installed. This is native arm64 execution in a container, not x64
cross-compilation.

## Low-level entry points

Release work that already prepared dependencies and a shared web build may use
the validating lower-level commands:

```sh
node tools/package-linux.mjs --target linux-x64 \
  --source-commit "$(git rev-parse HEAD)" \
  --web-build /path/to/web-build --output /path/to/output
node tools/smoke-package-linux.mjs --target linux-x64 \
  --archive /path/to/output/protodriver-linux-x64.tar.gz
```

`package-linux.mjs` rejects Darwin and Windows targets.

## On-demand Linux x64 archive gate

Before changing Linux packaging or delivering an x64 archive, run:

```sh
node --test tools/package/linux-x64.test.mjs
```

This slow, hardware-free gate builds twice, compares the archives, inspects
their runtime/native/web/VM contents, and runs the isolated smoke. It remains
outside `tools/test/` so the recurring 30-second tools suite does not build a
large archive on every review.

Packaging and smoke do not prove permissions, driver binding, a physical open,
or transfer behavior. Read [Linux USB access](linux-usb-permissions.md) before
a live USB run.
