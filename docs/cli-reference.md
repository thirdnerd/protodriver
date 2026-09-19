# `pdr` CLI reference

`pdr` writes successful command output to standard output. A failed top-level
command writes one JSON object followed by a newline to standard error:

```json
{"category":"definition","error":{"code":"authored.api-version","message":"device/v2 required","responsibility":"definition","retryability":"no"}}
```

`error.code` is the stable machine-readable failure identifier. Expected
failures also carry `error.responsibility`, which says what must change before
the request can succeed. `retryability`, `details`, and `platformCause` are
present only when the reporting boundary has those facts.

## Exit statuses

| Status | Category | Meaning |
| ---: | --- | --- |
| 0 | success | The command completed successfully. |
| 1 | `unexpected` | `pdr` failed unexpectedly, or a typed failure reached the boundary without responsibility metadata. Report the failure. |
| 2 | `definition` | The module or package author must change the artifact. |
| 3 | `operation` | Recover, retry, or inspect the device or session. |
| 4 | `host` | Repair host resources, permissions, configuration, or infrastructure. |
| 5 | `invocation` | The caller must change this command or request. |
| 130 | `cancelled` | The operation was cancelled. |

The category describes remediation, not the phase in which the failure was
observed. For example, an authored operation returning a value that violates
its declared result remains a `definition` failure even though execution had
already begun.

`unexpected` and `cancelled` are boundary outcomes, not responsibilities. If a
typed failure is missing responsibility, `pdr` preserves its original code and
message but reports `unexpected` with status 1. An untyped thrown value is
reported as `cli.failed`, also with status 1. This prevents a new or incomplete
failure classification from silently acquiring an actionable exit status.

## Commands

```text
pdr run <device-directory-or-package> [--mode id] [--profile id] [--candidate id | --serial-path path] <operation> [flags]
pdr inspect <device-directory-or-package>
pdr pack <device-source-directory> <output-package>
pdr --version
```

Use `pdr --help` for the current synopsis and `pdr run <package>` for the
operations and generated flags admitted from that package.

### Serial selection

Ordinary Node acquisition enumerates serial ports, applies the selected
profile's VID/PID acquisition filters, and accepts `--candidate <id>` only for
an opaque candidate id from that result. `--candidate` never names a new path.

`--serial-path <path>` is an explicit Node-host grant for the operator-named
serial endpoint. It skips serial enumeration and bypasses the profile's
VID/PID discovery filters. It remains subject to the admitted mode and serial
profile, operation availability, line parameters, lifecycle policy, channel
duplex, and module entry checks. The host records only path-derived identity;
it does not infer vendor, product, manufacturer, or serial-number evidence
from the declaration. `--serial-path` and `--candidate` are mutually exclusive.

The stock `--worker run` adapter refuses all serial profiles before it opens a
port, whether the port would have been enumerated or named with `--serial-path`.
The pinned native bindings cannot deliver serial read completion safely from a
Node worker thread. This is an `invocation` failure (status 5), because the
caller must rerun without `--worker`; it does not indicate broken host
resources or configuration. There is no browser or USB equivalent to
`--serial-path`; browser acquisition remains subject to its permission chooser.
