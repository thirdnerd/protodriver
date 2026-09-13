# Protodriver

A browser app and a CLI sharing one runtime, talking to hardware over serial
and USB, driven by a **self-contained device module rather than per-device code
built into either host**. A module is Lua: it declares what the device is and
how to talk to it, and the shared runtime — not the module — owns device I/O.

Point it at a device it has never seen, and the module tells it what to do.

## Getting `pdr`

`pdr` is not in this checkout and does not install from npm. It ships as one
self-contained release archive carrying its own Node runtime, native bindings,
Lua VM, author documentation, blank starter, and worked modules, so the machine
that runs it needs no Node, npm, compiler or package manager.

Build one for the current machine with one command:

```sh
node tools/build-package.mjs
```

The [package build guide](docs/building.md) covers prerequisites and the short
[Linux](docs/linux-x64-package.md), [macOS](docs/macos-package.md), and
[Windows](docs/windows-x64-package.md) exception guides. Everything below
assumes `pdr` from the resulting archive is on your PATH.

## Running a module

A module source is a directory of Lua headed by `device.lua`. Package it, then
ask it what it can do:

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

Running an actual operation is different: it begins acquisition and may perform
entry writes after selecting a device.

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

The tutorial is included in every release archive beside a blank starter,
progressive thermostat walkthrough, and six complete worked modules. There is
no second author artifact and no repository checkout is needed after extraction.
[Build the release](docs/building.md) and hand over that one archive.

Start with [Write a device module](docs/author-tutorial.md), which packages,
runs help and inspects without any hardware attached. Then read its [TI-84 Plus
CE screenshot example](examples/ti84-plus-ce/README.md), which walks
through a finished module for a real calculator.

The [DemoBench thermostat
walkthrough](examples/demo-thermostat/README.md) builds a fictional serial
driver in stages and runs it against an independent, host-injected simulator.
Its simulator runner is project-side transcript-generation infrastructure, not
a release transport or a `pdr-demo` executable; the complete checked walkthrough
ships in the archive.

[`examples/start/`](examples/start) is a starting
skeleton. It admits and packages, and its one operation deliberately fails —
there are no invented device facts in it to copy by mistake.

When an exact declaration or effect shape is not in an example, the
[contract-2 author reference](docs/declaration-reference.md) has it.

On Linux, [USB permissions](docs/linux-usb-permissions.md) is usually the first
thing that stops a device from appearing.

## The browser

`apps/web` is the same runtime in a browser. Build it with `npm run build` and
serve it with `npm run serve`. It imports `.pdpkg` bytes, re-verifies packages
it has stored, and runs admitted contract-2 modules.

WebUSB and Web Serial depend on the browser supporting them and on the operator
granting permission per device.

The app ships with no external network dependency. On each page load it checks
for a same-origin `catalog.json`; a missing catalog is silent. A deployed
catalog can list `.pdpkg` files at any URL, including another origin. Choosing
one fetches and admits it like a package imported from disk, then remembers it
in this browser.

To offer packages, put `catalog.json` beside the deployed `index.html`:

```json
{"packages":[{"name":"My device","url":"packages/my-device.pdpkg"}]}
```

Entry URLs resolve relative to the catalog's URL. A cross-origin package host
must allow the browser to read its response.

## Working on protodriver itself

One command runs everything:

```bash
bash tools/run-tests.sh
```

Pass a commit or branch name to test a different ref.

By default, it extracts HEAD into a clean directory, discovers every workspace
and test suite rather than reading a list, stages dependencies for all of them
before running any, and prints a verdict.

Three checks also run standalone:

```bash
node tools/check-browser-offline.mjs
node tools/protocol-fragmentation-sweep.mjs --seed 0x3f17a5c9
node tools/protocol-fuzz.mjs --seed 0x7a310f5d --population fuzzer
```

Nothing runs on push.
