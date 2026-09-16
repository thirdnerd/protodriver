# Build a driver: DemoBench thermostat

This is a fictional serial thermostat, so no hardware or serial-port permission
is needed. Start in the repository root with Node 24.18 and the dependencies
prepared as in the [host build guide](../../docs/building.md). Then run:

```bash
node test-support/demo-thermostat/run.mjs
```

That command regenerates the [checked transcript](transcript.txt). It executes
the displayed `pdr pack`, `--help`, and `inspect` commands as subprocesses.
For simulated operations it calls the same CLI function, `runPdr`, with a
host-injected enumerator; those `runPdr` lines are the runner's stable summaries
of the real outcome and transmitted bytes, not shell commands. The simulator
is [separate host code](../../test-support/demo-thermostat/simulator.mjs):
it parses requests and owns state; it imports neither this module nor `corpus/`.

To write alongside the example, create your own directory and copy only the
first checkpoint's `device.lua` into it. At each later step, edit that one file
to add the behavior explained below; the next checkpoint is a complete file
you can compare against when stuck. Repack *your* directory with `pdr pack`
after each edit. The simulator runner uses the checked
checkpoint files so its published output is reproducible.

```bash
mkdir -p demo-work
cp examples/demo-thermostat/step-1/device.lua demo-work/device.lua
node apps/cli/src/pdr.ts pack demo-work demo-work.pdpkg
```

## 1. Write the protocol before code

Read [PROTOCOL.md](PROTOCOL.md). The whole wire vocabulary is three commands,
one `ERR RANGE` reply, and silence for unknown commands. It specifies `CR`,
9600 8N1, the 64-byte reply bound, 300 ms exchange deadline, integer units,
and initial state. The invented USB-serial IDs are illustrative filters, not
permission or a claim about a physical device.

## 2. Describe the interface; execute nothing

[Step 1 source](step-1/device.lua) declares one mode, one serial profile and
two operations. Both bindings explicitly fail `not-implemented`. They are
descriptions, not an assertion that a thermostat has answered. Package and
inspect it:

```bash
node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-1 declaration.pdpkg
node apps/cli/src/pdr.ts run declaration.pdpkg --help
node apps/cli/src/pdr.ts inspect declaration.pdpkg
```

The runner prints this generated help:

```text
Tasks:
  read_status: Read status [read-only; safe-to-repeat; value]
  set_target: Set target [destructive; not-repeatable; value]

Transport requests declared; acquisition remains subject to host approval.
Profile serial: serial; modes thermostat
```

`inspect` says `Execution contract: authored-v2` and, crucially, `Inspection
performed effect-free admission only; session entry, acquisition, and
application I/O did not run.`

## 3. Add entry: identify before trusting a write

Compare [Step 2 source](step-2/device.lua) with Step 1. It adds a bounded line
reader and `entry.identify`. `ID?\r` must be answered by exactly
`ID DEMOBENCH-THERMOSTAT 1\r`. A completed write alone cannot make entry pass.
The operation is still a placeholder, which makes the boundary visible:

```bash
node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-2 entry.pdpkg
```

```text
runPdr read_status [step-2: identified, operation unfinished]
failure: demo-thermostat.not-implemented
wrote: "ID?\r"

runPdr read_status [step-2: wrong identity]
failure: demo-thermostat.identity-mismatch
wrote: "ID?\r"
```

The `wrote:` text uses JSON escaping, so `\r` means one transmitted carriage
return byte. The host's injectable enumerator provides the fake connection;
the device declaration still requests only serial, never a `mock` transport.

## 4. Add `read_status`: parse a bounded record

[Step 3 source](step-3/device.lua) replaces only `read_status`'s placeholder.
It arms a 400 ms operation deadline before writing `STATUS?\r`; the line
reader's 300 ms timer governs the reply. Its decimal parser rejects leading
zeroes, out-of-range values and extra fields. The result is a typed record:
`temperature_centi_c` and `target_centi_c` have the fixed unit
`centidegree-celsius`, so 2150 means 21.50 °C. Even with every reply byte
delivered as a separate serial chunk, the runner records:

```bash
node apps/cli/src/pdr.ts pack examples/demo-thermostat/step-3 status.pdpkg
```

```text
runPdr read_status [step-3: fragmented]
result: {"heater":"on","sequence":1,"target_centi_c":2200,"temperature_centi_c":2150}
wrote: "ID?\r", "STATUS?\r"
```

## 5. Add `set_target` without an automatic retry

The final [device.lua](device.lua) replaces the second placeholder. Its
declared argument accepts 500..3500 centi-°C. Its risk is `destructive` and
repeatability is `not-repeatable`: a lost acknowledgement must not silently
issue `SET` twice. The CLI's operation help says:

```bash
node apps/cli/src/pdr.ts pack examples/demo-thermostat thermostat.pdpkg
node apps/cli/src/pdr.ts run thermostat.pdpkg set_target --help
```

```text
Risk: destructive
Repeatability: not-repeatable

Inputs:
  target_centi_c: target_centi_c
```

Run the final package in the same simulator, which keeps its target state
between CLI calls:

```text
runPdr read_status [normal]
result: {"heater":"on","sequence":1,"target_centi_c":2200,"temperature_centi_c":2150}
wrote: "ID?\r", "STATUS?\r"

runPdr set_target --target_centi_c 2300 [normal]
result: {"target_centi_c":2300}
wrote: "ID?\r", "SET 2300\r"

runPdr read_status [normal]
result: {"heater":"on","sequence":2,"target_centi_c":2300,"temperature_centi_c":2150}
wrote: "ID?\r", "STATUS?\r"
```

## 6. Make refusals visible

The simulator's fault modes deliberately deviate from the happy reply. This
is the part to copy when testing your own parser: fragment the bytes, corrupt
a field, overrun the line, and send nothing. The runner's actual summaries are:

```text
runPdr read_status [fragmented]
result: {"heater":"on","sequence":1,"target_centi_c":2200,"temperature_centi_c":2150}
wrote: "ID?\r", "STATUS?\r"

runPdr read_status [wrong-identity]
failure: demo-thermostat.identity-mismatch
wrote: "ID?\r"

runPdr read_status [malformed]
failure: demo-thermostat.malformed-status
wrote: "ID?\r", "STATUS?\r"

runPdr read_status [overlong]
failure: demo-thermostat.line-too-long
wrote: "ID?\r", "STATUS?\r"

runPdr read_status [silent]
failure: demo-thermostat.response-timeout
wrote: "ID?\r", "STATUS?\r"

runPdr set_target --target_centi_c 2300 [unexpected-range-refusal]
failure: demo-thermostat.range-refused
wrote: "ID?\r", "SET 2300\r"

runPdr set_target --target_centi_c 4000 [argument bound]
failure: authored.value.invalid
wrote: "ID?\r"
```

The last case deliberately makes a faulty device refuse an *in-range* target,
proving the driver surfaces `ERR RANGE` as a named failure. An honest raw
`SET 4000\r` sent directly to the simulator yields `ERR RANGE`; the public CLI
instead rejects 4000 at its declared argument boundary before transmitting
`SET`. Entry's `ID?` still runs first. `WHAT?\r` produces no reply at all. None
of these refusals substitutes
a plausible status value or retries the potentially destructive write.
