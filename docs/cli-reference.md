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
pdr run <device-directory-or-package> [--mode id] <operation> [flags]
pdr inspect <device-directory-or-package>
pdr pack <device-source-directory> <output-package>
pdr --version
```

Use `pdr --help` for the current synopsis and `pdr run <package>` for the
operations and generated flags admitted from that package.
