# Windows x64 package exceptions

Start with the [one-command build](building.md) from a Windows x64 checkout:

```powershell
node tools/build-package.mjs
```

The command selects `win32-x64`, installs locked dependencies without running
their lifecycle scripts, builds the browser distribution, emits the authored
TypeScript graph as JavaScript, builds the archive, and runs its generated
PowerShell smoke under a system-only `PATH`.

The package uses the official Node 24.18.0 x64 runtime and the published,
digest-pinned PE x86-64 serialport and USB prebuilds. Windows does not load or
ship the POSIX ioctl addon. The recipient needs no Node, npm, compiler, SDK,
Python, Git, or installation step.

## Why this target emits JavaScript

Node does not strip TypeScript beneath `node_modules`, and Windows packages use
ordinary copied project directories rather than symlinks requiring Developer
Mode. The packager therefore uses pinned TypeScript 5.6.3 to emit project code,
rewrite `.ts` imports and worker URLs, and remove type-only package metadata.
The packager checks that no authored TypeScript remains.

## Native smoke

The unified command stages `smoke.ps1`, starts it with Windows PowerShell under
a `PATH` containing only System32, Windows, and WindowsPowerShell, and fails if
ambient Node, npm, or `cl.exe` resolves. The smoke unpacks the archive, serves
and fetches every browser asset, exercises native stdout/stderr redirection,
packs and admits Device 2, reaches the expected no-candidate result through
both normal and worker entry points, and loads serialport and USB. It opens no
device and launches no browser.

## Compiler-free Linux cross-assembly

All Windows executable inputs are published prebuilds, so the validating
low-level `tools/package-windows.mjs` can assemble `win32-x64` on Linux
x64 when supplied the official extracted Windows Node runtime and a shared web
build. That exception cannot execute the Windows smoke; use
`tools/smoke-package-windows.mjs --stage DIRECTORY` to create the payload and
run its `smoke.ps1` on Windows. The ordinary one-command path deliberately
requires native Windows so a successful command always includes the smoke.

`package-windows.mjs` rejects Linux and Darwin target names before reading any
build input.

## Optional TI-84 Plus CE hardware run

Hardware work is separate from package smoke. Package the current CE source on
the development machine and copy the resulting `.pdpkg` beside the Windows
archive through the authorized transfer path.
The current authored-v2 operation id required for each rerun is
`capture_screenshot`.

The Windows target emits a deterministic ZIP, while the four POSIX targets
retain their gzip-compressed tar archives. Extract it with the built-in
PowerShell command:

```powershell
Expand-Archive -LiteralPath protodriver-win32-x64.zip -DestinationPath .
```

Extract it somewhere short. The deepest path inside the archive is 121
characters, so a destination longer than about 138 characters exceeds the
260-character limit `Expand-Archive` works under. It then fails with one
`PathTooLongException` per member and no summary line, which reads as a broken
download rather than a path that is too long. `$HOMEDownloads` is fine; a
deeply nested project directory may not be.

After checking the transferred hashes and extracting the archive:

```powershell
$delivery = Resolve-Path $HOME\protodriver-win32-delivery
$pdr = Join-Path $delivery "protodriver-win32-x64\bin\pdr.cmd"
$capture = Join-Path $delivery "ti84-plus-ce-screenshot.bmp"
& $pdr run (Join-Path $delivery "ti84-plus-ce.pdpkg") `
  capture_screenshot --save-result $capture
```

The authored CLI does not transform or reinterpret the returned BMP. A
successful command means acquisition, protocol execution, and exact result
storage completed; record device identity and output digest separately when
those facts matter.
