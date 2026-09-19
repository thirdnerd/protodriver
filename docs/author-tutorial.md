# Write and run a contract-2 device module

This guide assumes that you have only an extracted Protodriver release archive.
You do not need a repository checkout, a separate Node.js installation, or
TypeScript dependencies. The release contains the product launcher, this guide,
the current contract reference, a blank Lua source set, and complete worked
source sets.

The release can be explored without producing anything for this project. One
low-risk tour is to package the blank source, inspect
generated help, copy it for your own work, and replace its presentation and
placeholder identifiers. Hardware is useful only after you add an operation
whose acquisition, request, response, and completion boundary you understand.

The blank file deliberately contains no measured device facts. Worked sources
remain useful references and adapting one is legitimate when it represents the
device you intend to use. Copying one does not establish a new protocol while
its identity, framing, request/response, bounds, and completion facts remain
copied. The tools can host new device behavior, but they cannot infer it.

## Locate the launcher and source

For the Linux x64 release, the launcher is `./bin/pdr` from the extracted
release root. The target guide beside this document names the equivalent
launcher and prerequisites for its delivered platform.

The [blank starting source](../examples/start/device.lua) has one entry
named `device.lua`. Package it unchanged before editing; no `pdr init` command
is required. Its module, mode, and profile names say `replace-with-...` at their
point of use. It intentionally omits `connectionProfiles`, because valid serial
settings or USB acquisition identifiers, interfaces, endpoints, and packet
sizes must come from your device rather than from a template.

Every source set has one `device.lua` entry. Helpers are other `.lua` files in
the same directory. A package-local request such as
`require("screen.lua")` names an exact member; it does not search directories,
append an extension, use a host Lua installation, or fetch a dependency.

The complete [Device 3 source](../corpus/device-3/device.lua) is a current
single-file worked source. It supports serial and USB, but its USB profile is
the useful reference for a device that deliberately has no TTY. The CE, Evo,
and Nspire directories included with the release show current multi-file source
sets after the blank shape is familiar. Their measured constants belong to
their named devices and are not framework defaults.

## What `device.lua` returns

A contract-2 entry returns two Lua values: a public declaration and a binding
table. The declaration is inert data. It identifies modes, acquisition
requests, physical channels, operations, results, risk, repeatability, bounds,
and the owners allowed to request effects. The binding table supplies the Lua
functions named by that declaration.

The source cannot enumerate, select, open, claim, or close native devices by
itself. A connection profile is a request which the host checks against an
operator-selected candidate. Likewise, naming an effect in `requires` makes it
available only to that active entry, handler, operation, reentry, invalidation,
or cleanup owner.

The closed Lua environment supplies the ordinary language plus these values:

- `pdrv.array` constructs an ordered host array, including an explicitly empty
  one;
- `pdrv.bytes` converts a Lua byte string into an exact byte value;
- `pdrv.integer` carries a decimal spelling when a public integer can exceed
  exact Lua/JSON number range;
- `pdrv.null` distinguishes null from an omitted member; and
- `pdrv.fail` raises a stable author-owned failure with bounded details.
- During a declared resumable transfer,
  `io.request({kind="transfer-resume-required",name="...",details={...}})`
  terminally reports “not finished yet.” It is distinct from `pdrv.fail` and
  from returning result data; see [Durable transfer metadata](declaration-reference.md#durable-transfer-metadata).

The [contract-2 reference](declaration-reference.md) describes the declaration
and binding relationship accepted from a contract-2 author.

## What a reliable protocol description needs

A reliable driver needs exact candidate identity, configuration or line
settings, endpoint/channel directions, frame boundaries, a maximum accepted
frame, request bytes, variable fields, response and event distinction,
acknowledgement ordering, and an end-to-end deadline. Keeping these device facts
beside the Lua makes incorrect assumptions easier to spot. Meaningful completion
is also device-specific: a particular value, file, or protocol acknowledgement
must distinguish success from merely receiving plausible bytes.

A permissive parser is dangerous: an unrelated packet can become a plausible
result. Reject invalid lengths, checksums, sequence or correlation fields,
unexpected response kinds, and trailing residue unless your observations prove
a wider accepted domain. One overall deadline is a transaction bound; starting
a fresh full timeout after each partial response is not equivalent.

### USB transfers are not protocol frames

For USB input, the current transports request one selected live endpoint packet
at a time. A short packet completes that request. A zero-length packet contributes
no Lua byte, while a literal `0x00` padding byte is data and can arrive by itself.
Your parser must accept arbitrary splits, retain bounded partial frames, and
validate required padding rather than manufacturing it. A frame-size or buffered-
byte containment ceiling is not the native read request size.

## What packaging and inspection show

The release's blank source packages with this command, which was executed using
the delivered Linux x64 launcher:

```console
$ ./bin/pdr pack examples/start blank-device.pdpkg
```

Packaging records the bounded source set and exact
source-set identity. It does not evaluate the source, admit the declaration, or
acquire hardware. The first generated-help command performs evaluation,
admission, and binding resolution without acquiring hardware.

These generated mode, operation, and inspection views expose admission results
without a live run. The commands below were executed against the package
produced above:

```console
$ ./bin/pdr run blank-device.pdpkg --help
$ ./bin/pdr run blank-device.pdpkg draft_operation --help
$ ./bin/pdr inspect blank-device.pdpkg
```

Mode help shows the admitted mode, profile, tasks, risk, repeatability, and
result. Operation help shows admitted arguments and result shape. Inspect prints
the static generated interface and executable-internals section for a contract-2
package. If generated help refuses the source, the first named diagnostic is
usually the most useful; widening device behavior does not repair a declaration
error.

## Continue from the blank source

After the unchanged pack/help/inspect loop succeeds, copy the `examples/start`
directory with your platform's ordinary file tools. Change its placeholder
module, mode, and profile identifiers and its presentation. Repackaging shows
how those edits reach generated help. A deliberate declaration error, such as
changing the returned `apiVersion`, demonstrates named admission refusal;
restore the admitted file before continuing.

The blank `draft_operation` binding fails explicitly with
`blank.protocol-not-implemented`. Do not run it as a hardware check. Before a
live run, add a measured `connectionProfiles` record, declare only the effects
the operation uses, implement its protocol, and set risk and repeatability to
truthful device claims. The release supplies neither hardware simulation
nor the project's internal mock transport, so pack, admission, generated help,
and effect-free inspection are the honest hardware-free boundary.

You may instead copy a complete source under `examples/` when adapting the
named device or when a worked mechanism is the clearest reference. Keep its
device-specific constants only when your own evidence says they apply.

This separates three facts which are easy to blur: Lua parsed, the declaration
was admitted, and a host later executed an operation. None implies the next.

## What a live run does

A read-only, safe-to-repeat operation minimizes risk when exploring matching
hardware. A capture started before native acquisition can help you diagnose the
first failure together with the accepted write/input prefix, but creating or
sharing one is optional. Generated operation help is the authority for flag
placement and required arguments on the package being run.

Acquisition success, entry success, operation success, and a meaningful result
are separate facts. A USB device being listed does not prove that its interface
opened or that an authored write occurred. A structurally valid file does not
prove that it represents the physical device; use an independent witness when
the content claim matters.

Do not use a state-changing or destructive operation merely to prove the
toolchain. Device 3’s `write_image` operation is deliberately not the starting
operation; its generated help labels it destructive and not repeatable.

## Ownership model

Entry establishes the bounded session precondition. A response-bearing probe
can establish liveness; an accepted write followed only by silence cannot.
Entry may hand parser prefix custody to exactly one handler when both sides
declare and accept that handoff.

A channel-input handler owns continuing input for its declared channel. It can
validate frames, retain generation-local parser suffixes, authorize a relayed
write, and send bounded messages to a foreground operation. An operation owns
one public task. Cleanup owns only its declared terminal work and limits.
Invalidation clears generation-local state. A binding must not silently play
two incompatible roles.

Persistent partial frames, transactions, timers, mailboxes, result handles, and
transfer checkpoints all need an explicit generation and terminal disposition.
Cancellation or connection loss is not permission to reuse them in a later
operation.

## Collect several replies without an unbounded loop

Use the raw effects explicitly. This skeleton assumes
`next_message(io, timers)` is your device-specific bounded parser: it returns a
complete validated message or the id of the timer which won, and it retains any
partial next frame. `write_ack` derives and writes the exact acknowledgement.
The operation must declare `channel.read`, `channel.write`, `timer`, and
`operation.deadline` in `requires`.

```lua
local function arm(io, milliseconds)
  return io.request({kind="timer-arm", milliseconds=milliseconds})
end

local function cancel(io, timer)
  if timer then io.request({kind="timer-cancel", timer=timer}) end
end

local function collect_replies(io, next_message, write_ack, limits)
  local deadline = io.request({
    kind="deadline-arm", milliseconds=limits.maximumMilliseconds,
  })
  local quiet = nil
  local replies, count, payload_bytes = {}, 0, 0

  while true do
    local timers = {}
    if quiet then timers[#timers + 1] = quiet end
    local message, expired = next_message(io, pdrv.array(timers))

    if expired then
      if quiet and expired == quiet and count > 0 then
        quiet = nil -- the expired timer is no longer owned
        break
      end
      pdrv.fail("example.unexpected-timer", {received=count})
    end

    cancel(io, quiet)
    quiet = nil
    count = count + 1
    payload_bytes = payload_bytes + #message
    if count > limits.maximumMessages
        or payload_bytes > limits.maximumPayloadBytes then
      pdrv.fail("example.reply-bound", {
        received=count, payloadBytes=payload_bytes,
      })
    end

    write_ack(io, message) -- only after framing, validation and bound checks
    replies[#replies + 1] = pdrv.bytes(message)
    quiet = arm(io, limits.quietMilliseconds)
  end

  io.request({kind="deadline-disarm", deadline=deadline})
  return pdrv.array(replies)
end
```

The limits are explicit driver policy unless a device specification or varied
observations establish them. They are necessary for bounded, correct execution,
not for a project submission. The operation deadline never resets. Quiet begins
only after one accepted reply and resets after each later reply. Count and
cumulative bytes are checked before the ACK, so an over-bound reply is not
confirmed. If the protocol needs late-close draining, keep the same bounded
conversation alive until its quiet condition; returning success is not a drain
request.

## Results and captures

A value result is converted by its declared type and emitted losslessly in the
public JSON envelope. A file result declares byte bounds, media type, content,
and a safe extension; the host writes the returned bytes unchanged to the
operator’s selected destination. Streamed inputs and outputs remain bounded by
the declaration and host resource service.

A capture is execution evidence only when it begins before acquisition and
records the relevant connection. A complete, zero-gap, byte-exact capture can
support a separately written replay tool; `pdr` does not offer capture replay.
An incomplete or footerless prefix is diagnostic evidence, not a completed
hardware claim.

## Optional verification beyond exit zero

Suppose an operation writes `result.bin`, emits JSON lines to `result.jsonl`,
and records `capture/`. A concrete verification pass looks like this:

```console
$ ./protodriver-linux-x64/bin/pdr run device.pdpkg \
    --json --capture capture --save-result result.bin read_existing_file \
    > result.jsonl
$ ./protodriver-linux-x64/bin/node verify-result.mjs \
    --result-json result.jsonl \
    --expect-outcome completed \
    --file result.bin --expect-bytes 330732 \
    --expect-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
    --capture capture --require-complete --require-zero-gaps \
    --expect-rx-bytes 331500 --expect-tx-bytes 12000 \
    --require-ack-order request,data,ack,complete
```

This is an optional way to build confidence in a result or troubleshoot it; no
verification artifact is submitted to the project. `verify-result.mjs` here
stands for a small author-owned verifier whose expected
counts, digest and ACK state machine come from device evidence, not from the
module under test. The illustrative numbers and operation name need
device-specific replacements. An image can be independently decoded and checked
for width, height, pixel format, and a pixel hash; an archive can be enumerated,
decompressed, and checked against stored CRCs. Keeping those checks beside a
complete capture makes later diagnosis easier. A valid container, matching byte
count, or completed JSON outcome alone does not imply the other checks.

## Resource limits are part of the protocol design

Every direct input delivery is at most 256 octets. Current defaults include a
4 MiB buffered-input envelope per channel, 1 MiB encoded Lua input and output,
1 MiB public-value and resource chunks, and 16 MiB retained VM allocation. One
retained activation has finite Lua fuel and effect work; cleanup has smaller
declared maxima. These are containment boundaries, not device facts and not
native USB request sizes. The [contract reference](declaration-reference.md#limits-an-author-must-design-around)
lists the current values and distinguishes host envelopes from bounds supplied
by the driver.

Choosing announced-size, message-count, cumulative-payload, and deadline policy
before an envelope failure keeps the parser's behavior deterministic. Values
kept beside the parser/collector are easier to review; over-bound input must be
rejected before acknowledgement, and streamed sources/results avoid approaching
an envelope with one materialized Lua value.

## Current product boundary

Current contract-2 packages run through direct Node, the ordinary browser, and
serialized Node `--worker run`, subject to the transports each host can grant.
The stock worker refuses serial profiles before opening a port because the
pinned native bindings cannot deliver serial read completion safely from a
Node worker thread; use direct Node for those profiles. `pdr inspect` describes
generated package output; for contract-2 authoring, use pack admission plus
generated mode and operation help. The browser’s live protocol view is raw
transmit/receive evidence, not an authored frame debugger.

Generated help and inspect do not enumerate acquisition candidates. The CLI has
no list-only authored-candidate command. An actual operation begins acquisition
and may run entry protocol writes after selection.

`--worker run` means that the Node product uses its serialized adapter. It is
not a thread-reuse switch. Contract 2 gives an author no control over JavaScript
thread pools, worker reuse, or Wasm-instance reuse, and does not promise fresh or
reused host threads as part of operation semantics. Treat host startup/runtime
cost as product behavior, measure it separately, and never make correctness or
deadlines depend on an environment flag.

When more detail is useful, the exact [contract reference](declaration-reference.md)
and multi-file sources under `examples/` show the available surface in the
release. Those examples demonstrate complete mechanisms, but their acquisition
identifiers, packet sizes, locks, deadlines, and result bounds are device facts
rather than framework defaults.
