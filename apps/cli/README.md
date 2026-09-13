# Authored CLI

Load an authoritative Lua source directory or package and run its generated
commands:

```text
pdr run corpus/device-1 get-device-info
pdr run corpus/ti-84-evo capture-screen --save-result screenshot.bmp
pdr inspect corpus/device-1
pdr pack corpus/device-1 device-1.pdpkg
```

The CLI evaluates and admits `device.lua` before opening a connection. File
results require an operator-owned `--save-result` path; the host never chooses
one silently. Help and inspection do not enumerate or acquire devices.

Connection profiles may request serial or USB acquisition. Multiple eligible
modes, profiles, or candidates require explicit `--mode`, `--profile`, or
`--candidate` selection. Native acquisition can instead be supplied by an
embedding host through its trusted authored-acquisition callback.

Scalar arguments use `--name VALUE` (JSON for structured values), source
arguments use `--name PATH`, and `--json` prints the settled operation result.
Run generated help for the exact flags admitted by a module:

```text
pdr run corpus/device-1 write-channel-configuration --help
```
