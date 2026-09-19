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
`--candidate` selection. On Node, `--serial-path <path>` instead grants one
operator-named serial endpoint without enumeration; it is mutually exclusive
with `--candidate`. Native acquisition can instead be supplied by an embedding
host through its trusted authored-acquisition callback.

The stock `--worker` adapter refuses serial profiles before opening a port
because the pinned native bindings cannot deliver serial read completion
safely from a Node worker thread. Run serial profiles without `--worker`; USB
profiles and host-supplied worker implementations remain available through
that route.

Scalar arguments use `--name VALUE` (JSON for structured values), source
arguments use `--name PATH`, and `--json` prints the settled operation result.
Run generated help for the exact flags admitted by a module:

```text
pdr run corpus/device-1 write-channel-configuration --help
```
