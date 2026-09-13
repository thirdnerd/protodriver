# Build Protodriver for this machine

From a clone of the repository, run:

```sh
node tools/build-package.mjs
```

That is the ordinary package build. It detects the platform and architecture
of the Node process, installs the locked workspace dependencies, builds the
shared browser distribution, builds the self-contained CLI/browser archive,
and runs that platform's hardware-free package smoke. The resulting archive is
written beneath `<target>-package-output/`.
This works from a fresh clone: the browser bundler is loaded only after the
workspace installation. To prepare dependencies for tests without building an
archive, run `node tools/install-package-build-dependencies.mjs` once; the
test command deliberately stops with that instruction if they are absent.

The supported native targets are:

| Host process | Target and archive |
| --- | --- |
| Linux x64 | `linux-x64`, `protodriver-linux-x64.tar.gz` |
| Linux arm64 | `linux-arm64`, `protodriver-linux-arm64.tar.gz` |
| macOS Apple Silicon | `darwin-arm64`, `protodriver-darwin-arm64.tar.gz` |
| macOS Intel or Rosetta x64 | `darwin-x64`, `protodriver-darwin-x64.tar.gz` |
| Windows x64 | `win32-x64`, `protodriver-win32-x64.zip` |

The build requires the official Node 24.18.0 distribution selected by the
target data. The package builder checks the runtime binary and license digests;
it does not silently package another Node installation. The normal dependency
step uses each workspace's committed lockfile. It needs no project account or
hosted service, and can run without network access when npm's required package
content is already cached.

The one output archive contains its own Node runtime, project source or emitted
JavaScript as appropriate, native serial and USB modules, the retained Lua VM,
the browser distribution with no external dependency, author documentation, a
blank starter, and the worked modules. The receiving machine does not install
Node, npm, a compiler, or repository dependencies.

The browser page checks for a same-origin `catalog.json` on load; absence is
silent. The release archive ships no catalog and still needs no external
service. A deployed page may provide one whose package entries name any URL;
choosing an entry fetches that package.

## Options

An explicit target turns host detection into an assertion:

```sh
node tools/build-package.mjs --target linux-x64
```

The one-command path only accepts a target runnable by the current Node
process because completing the native smoke is part of success. This catches a
wrong target before dependency installation. Specialized cross-assembly can
still use the validating low-level platform entry points described in the
platform exception guides.

Use `--output DIRECTORY` to choose another output directory. Existing release
automation can also supply `--node-runtime-root`, `--source-commit`, or
`--npm-cli`; ordinary native builds derive those values from the running Node
distribution and current Git commit.

An ordinary build has no release version: its manifest omits `version`, and
`pdr --version` reports the source commit and says it is not a released build.
For a release build, pass `--release-tag v0.1.0` (or `--release-version 0.1.0`).
The archive name then includes `0.1.0`, its manifest records that version beside
the commit, and `pdr --version` reports both. A checkout with no package
manifest also reports that it is not a released build; it does not consult Git.

The command refuses an unsupported host, a runtime or native addon with the
wrong bytes or architecture, a stale browser build, a target mismatch, and a
failed package smoke. It does not overwrite an existing archive.

The extracted root README begins with the packaged launcher's hardware-free
blank-module command. The build checks every internal link in the shipped
README, tutorial, reference, target guide, and module-specific walkthroughs
before it creates the archive. `PACKAGE-MANIFEST.json` binds the complete
release to the source commit.

## Platform prerequisites and exceptions

- [Linux packaging](linux-x64-package.md) records the native build packages,
  the stronger Bubblewrap smoke, and the arm64 container alternative.
- [macOS packaging](macos-package.md) records the Xcode/SDK requirement,
  per-architecture `ioctl` compilation, Rosetta, and the weaker `env -i`
  smoke boundary.
- [Windows packaging](windows-x64-package.md) records compiler-free native
  inputs, emitted JavaScript, the PowerShell smoke, and the Linux
  cross-assembly exception.

## Rebuilding the retained Lua VM

`packages/lua-vm/artifacts/protodriver-retained-v2.wasm` is committed, because
building it needs a toolchain nothing else here needs. You do not have to trust
it: `packages/lua-vm/tools/build-retained.mjs` rebuilds it, and the recipe is
pinned rather than described. It refuses a compiler whose `--version` string is
not the exact one recorded, verifies the Lua source set against its digest,
fixes the flag list, and normalizes `LC_ALL`, `TZ` and `SOURCE_DATE_EPOCH` so
two builds agree.

```bash
node packages/lua-vm/tools/build-retained.mjs <lua-source-dir> <path-to-emcc> out.wasm
```

The compiler version, flags, and the digests of every input are recorded beside
the artifact in `protodriver-retained-v2.wasm.json`, which is where to look
first if a rebuild disagrees. Check the committed binary, the recipe, and the
three local C inputs without rebuilding:

```bash
node packages/lua-vm/tools/check-retained-artifact.mjs
```

## Five-target CI

`.github/workflows/packages.yml` runs this same command on native GitHub-hosted
runners for all five targets. A manual dispatch uploads temporary Actions
artifacts and creates no release. A `v0.x.y` tag push builds and attests every
target archive, then, only when all five succeed, creates a draft GitHub release
with those archives and `SHA256SUMS`. A human publishes the draft. No tag is
created by the workflow. The first release tag is reserved for public
publication; local builds are not releases.

`SHA256SUMS` can be checked with `sha256sum -c SHA256SUMS` after downloading all
five archives. Each archive has a GitHub build-provenance attestation. Archive
byte reproducibility has not yet been measured and is not claimed here.

CI is release convenience, not a separate build implementation. A local build
does not require GitHub, an Actions account, or access to project
infrastructure.
