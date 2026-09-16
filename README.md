# Protodriver

A browser app and CLI for running Lua device modules over serial or USB. Each
module describes its device and operations; the shared runtime handles device
I/O, so adding a device does not require changing either host.

## Getting `pdr`

Download the prebuilt archive for your machine from the [Releases
page](https://github.com/thirdnerd/protodriver/releases) when a release is
published. If no release is listed yet, you can build from source below. The
v0.1.0 release archives are named:

| Machine | Archive |
| --- | --- |
| Linux x64 | `protodriver-0.1.0-linux-x64.tar.gz` |
| Linux arm64 | `protodriver-0.1.0-linux-arm64.tar.gz` |
| macOS Apple Silicon | `protodriver-0.1.0-darwin-arm64.tar.gz` |
| macOS Intel | `protodriver-0.1.0-darwin-x64.tar.gz` |
| Windows x64 | `protodriver-0.1.0-win32-x64.zip` |

Each archive includes the Node runtime, native bindings, Lua VM, author guide,
blank starter, and worked modules. The receiving machine needs no Node, npm,
or compiler. Download `SHA256SUMS` with the archive to check its digest; each
archive also has a build-provenance attestation. After extraction, run
`./bin/pdr --version` (Windows: `.\bin\pdr.cmd --version`) from the extracted
directory to see the release version and source commit. Its README has a
hardware-free first run.

To build your own archive from a repository checkout, run:

```sh
node tools/build-package.mjs
```

The [package build guide](docs/building.md) covers prerequisites and the short
[Linux](docs/linux-x64-package.md), [macOS](docs/macos-package.md), and
[Windows](docs/windows-x64-package.md) exception guides. `pdr` is not installed
from this checkout or npm; the commands below assume you have added an
extracted archive's `bin/` directory to your PATH.

## Running a module

A module source is a directory of Lua headed by `device.lua`. From this
repository's root, package a sample and ask it what it can do:

```bash
pdr pack corpus/device-1 device-1.pdpkg
pdr run device-1.pdpkg --help
pdr run device-1.pdpkg get_device_info --help
pdr inspect device-1.pdpkg
```

None of those four touches hardware. Packaging records the source set without
executing it. Generated help evaluates and admits the package but acquires
nothing. `inspect` reports the static interface and the executable identity
without running entry or any operation.

If you only have the release archive, use `examples/device-1` in place of
`corpus/device-1`; the archive README also shows a blank-starter first run.

Running an actual operation is different: it begins acquisition and may perform
entry writes after selecting a device.

The [`pdr` CLI reference](docs/cli-reference.md) documents commands, structured
error output, responsibility categories, and process exit statuses.

## What is in `corpus/`

Six module sources, each a complete `device/v2` declaration plus its Lua
bindings:

| | |
| --- | --- |
| `device-1`, `device-2`, `device-3` | framework fixtures with synthetic identities |
| `ti-84-evo`, `ti84-plus-ce`, `ti-nspire-handheld` | three physical calculators |

Packages, public descriptions and identities are derived on demand and are not
committed under `corpus/`.

## Writing your own

The release archive includes the tutorial, blank starter, progressive
thermostat walkthrough, and six complete worked modules. You can follow them
from the extracted directory without a repository checkout.

Start with [Write a device module](docs/author-tutorial.md), which packages,
runs help and inspects without any hardware attached. Then read its [TI-84 Plus
CE screenshot example](examples/ti84-plus-ce/README.md), which walks
through a finished module for a real calculator.

[The DemoBench thermostat
walkthrough](examples/demo-thermostat/README.md) builds a fictional serial
driver in stages. Its included transcript lets you study the results without
thermostat hardware.

[`examples/start/`](examples/start) is a starting skeleton. It packages and
admits, but its operation cannot run until you fill in facts about your device.

When an exact declaration or effect shape is not in an example, the
[contract-2 author reference](docs/declaration-reference.md) has it.

On Linux, [USB permissions](docs/linux-usb-permissions.md) is usually the first
thing that stops a device from appearing.

## The browser

`apps/web` uses the same runtime in a browser. From a repository checkout,
build and serve it from that directory:

```bash
cd apps/web
npm ci
npm run build
npm run serve
```

It imports `.pdpkg` files, re-verifies stored packages, and runs admitted
contract-2 modules.

WebUSB and Web Serial depend on the browser supporting them and on the operator
granting permission per device.

The page itself needs no third-party service. On each load it checks for a
same-origin `catalog.json`; no catalog is required. A deployed catalog can list
`.pdpkg` files at any URL, including another origin. Choosing one fetches and
admits it like a package imported from disk, then remembers it in this browser.

To offer packages, put `catalog.json` beside the deployed `index.html`:

```json
{"packages":[{"name":"My device","url":"packages/my-device.pdpkg"}]}
```

Entry URLs resolve relative to the catalog's URL. A cross-origin package host
must allow the browser to read its response.

## Working on protodriver itself

After cloning, install the locked workspace dependencies once (or let the
package build do that for you):

```bash
node tools/install-package-build-dependencies.mjs
```

Then run the test suite:

```bash
bash tools/run-tests.sh
```

Pass a commit or branch name to test a different ref.

By default, it extracts HEAD into a clean directory, discovers every workspace
and test suite rather than reading a list, stages dependencies for all of them
before running any, and prints a verdict. If dependencies are missing, it stops
with the install command instead of running a partial suite.

Three checks also run standalone:

```bash
node tools/check-browser-offline.mjs
node tools/protocol-fragmentation-sweep.mjs --seed 0x3f17a5c9
node tools/protocol-fuzz.mjs --seed 0x7a310f5d --population fuzzer
```

Branch pushes do not trigger the test suite, so run it locally before pushing.
A `v*` tag push triggers the five-target packaging workflow; a valid release
tag creates a draft release if every target passes. The workflow can also be
started manually.
