# Contract-2 author reference

This is the reference for packaged Lua source sets. The entry member returns a
`device/v2` declaration followed by a binding
table.

The complete single-file [Device 3 source](../corpus/device-3/device.lua) and
the multi-file source directories under `corpus/` are executable examples in
the release archive. This reference names the surface those files exercise.
Generated-help admission remains the final authority for a particular file.

This is a capability reference, not an assignment or contribution process.
“Required” and “must” below describe what admission, bounded execution, or
device safety needs from a declaration. An author owes the project no source,
package, capture, fixture, evidence archive, report, or explanation.

## Source set and return boundary

The source-set directory contains an exact `device.lua` entry and zero or more
package-local `.lua` members. `require` accepts the exact logical filename of a
member in that set. It performs no filesystem search and has no native library,
network, process, environment, or device access.

The first returned value is inert public description. The second is a record of
Lua functions. Every binding named by the description must exist in that
record, and every callable has only the effects admitted for its active role.
Admission rejects a missing binding, an undeclared root member, a binding reused
for an incompatible role, or a description larger than the selected bound.

Use `pdrv.array` for every declared array, `pdrv.bytes` for an exact byte value,
`pdrv.integer` for an exact public integer spelling, `pdrv.null` for explicit
null, and `pdrv.fail` for a stable author failure. An ordinary Lua sequence table
is not a declared host array.

## Declaration root

| Member | Required | Meaning |
| --- | --- | --- |
| `apiVersion` | yes | Exact value `device/v2`. |
| `id` | yes | Stable package-facing identity. |
| `modes` | yes | Nonempty array of mode ids. |
| `profiles` | yes | Nonempty array of connection-profile ids. |
| `operations` | yes | Nonempty array of public operations. |
| `displayName`, `description` | no | Bounded operator-facing presentation. |
| `modePresentation` | no | Labels or descriptions keyed only by declared mode ids. |
| `connectionProfiles` | no | Inert serial or USB acquisition requests. |
| `channelRoles` | no | Request, response, and event channel ids by profile. |
| `entry` | no | Bounded owner which establishes the session. |
| `handlers`, `mailboxes` | no | Continuing channel-input owners and bounded foreground routes. |
| `invalidation` | no | Binding which clears generation-local state. |
| `state`, `maintenance` | no | Public state cells and declared polling service. |

Ids are names, not presentation text. References in availability,
presentation, handlers, polling, channel roles, transfer metadata, and handoff
must resolve inside the same declaration.

## Connection profiles

A connection profile is a request, never a grant. The host enumerates and the
operator or host policy selects a candidate; the host then revalidates the
candidate against this inert description before it constructs an authored
session.

A serial profile declares its modes, serial acquisition filters, exact line
parameters, one named channel with its protocol duplex, and lifecycle policy.
Vendor and product ids narrow discovery when present. They do not give Lua
permission to open a port.

### Exact serial profile shape

The value at `connectionProfiles.<profile-id>` is a closed record. All five
members below are required; no other member is accepted for a serial profile.

| Member | Exact accepted value |
| --- | --- |
| `modes` | Nonempty `pdrv.array` of declared mode ids. |
| `acquisitionFilters` | `pdrv.array` of 1..128 filter records. Each requires `transport="serial"`; `vendorId` and `productId` are optional integers in 0..65535, and `productId` requires `vendorId`. |
| `transport` | Record containing exactly `kind="serial"`, `baudRate`, `dataBits`, `parity`, `stopBits`, and `flowControl`. |
| `channels` | `pdrv.array` containing exactly one record with exactly `id` and `protocolDuplex`. |
| `lifecycle` | Record containing exactly `openingDrainQuietMs` and `postTerminationSilence`. |

The serial transport domains are closed: `baudRate` is an integer in
1..4294967295; `dataBits` is 7 or 8; `parity` is `none`, `even`, or `odd`;
`stopBits` is 1 or 2; and `flowControl` is `none` or `hardware`.
`protocolDuplex` is `half-duplex` or `full-duplex`.

`openingDrainQuietMs` is a nonnegative safe integer.
`postTerminationSilence` contains exactly `minimumMs`,
`afterAbnormalTermination`, and `afterModeExit`. The duration is a nonnegative
safe integer and the two causes are booleans. A zero duration requires both
causes false; a positive duration requires at least one cause true.
[Session lifetime](#session-lifetime) describes what the two values do, when
each is applied, and how to choose them for a device.

Protodriver does not add a line codec to this profile. The handler receives raw
bounded input pieces and authored Lua owns delimiter recognition, prefix
retention, line-length policy, decoding, and rejection. `read` and handler
input are each capped at 256 octets per delivery; a parser needing a larger
line retains bounded pieces across turns.

When no stable VID/PID evidence exists, a filter containing only
`transport="serial"` is intentionally broad. The host may offer an unrelated
serial port; exact protocol identity then belongs in entry and must refuse the
candidate before public operations. There is no descriptor-text or port-path
matcher in this contract.

A USB profile declares its modes, USB acquisition filters, optional required
product name, and USB transport policy. The transport identifies configuration,
interface, alternate setting, and physical channels. A channel declares input,
output, or both with endpoint number, transfer type, and full/high-speed maximum
packet bytes. Use `pdrv.null` for an absent direction. `channelRoles` maps the
logical request, response, and event roles to those physical channel ids.

The Device 3 USB profile is the exact current example of one bulk OUT request
channel, one bulk IN response channel, and one interrupt IN event channel. Its
declared ids and packet sizes are device facts, not defaults for another device.

### USB delivery granularity and padding

The selected live endpoint's `maximumPacketBytes` has two jobs: admission checks
it against the declaration, and the Node USB/WebUSB transports request exactly
one such packet for each native input transfer. It is not a frame ceiling. The
transport accumulates completed reads in its bounded ingress queue, and authored
framing must accept a protocol frame split across multiple deliveries. It must
also preserve a complete later frame which arrives beside the end of an earlier
one. Do not infer a protocol boundary from a USB callback boundary.

A USB short packet ends one native transfer and contributes its actual octets to
the byte stream. A zero-length packet contributes no authored octet; the host
submits the next input read. That is different from a literal padding octet
`0x00`, which is ordinary protocol data and may arrive alone in a later native
transfer. If a device requires such a pad after particular frame lengths, retain
the parser state until the byte arrives and validate it explicitly. Never invent
the byte because a packet boundary was observed.

The host's frame and buffered-byte ceilings remain containment limits above this
native quantum. They do not make a large native read safe, and changing them does
not change packet size. This distinction is common to Darwin, Linux and Windows.

## Operations

Each operation declares all of the following:

| Member | Meaning |
| --- | --- |
| `id`, `title`, `description` | Stable invocation name and bounded generated-help text. |
| `binding` | Function in the second returned table. |
| `arguments` | Record of named public value or byte-source inputs. |
| `result` | `none`, typed `value`, or outbound `file`/`resource`. |
| `risk` | `read-only`, `changes-state`, `destructive`, or `firmware`. |
| `repeatability` | `safe-to-repeat` or `not-repeatable`. |
| `locks` | Logical exclusions needed for the operation. |
| `availability` | Declared modes and profiles on which the task exists. |
| `requires` | Effect capabilities granted only while this binding is active. |

An operation may additionally name a handler in `writeVia`, bounded `cleanup`,
idle-release `reentry`, or common durable-transfer metadata. Those additions
are relational: `writeVia` requires a handler with a write-authorization
binding; cleanup effects and bounds are separate from ordinary effects; reentry
is required where an idle-released polling mode needs to resume; transfer
metadata and the checkpoint capability occur together.

Generated help is deliberately derived from this declaration. If the help
labels a write operation read-only, omits a required argument, or describes the
wrong result, fix the declaration before any hardware run.

### Exact owner records

The owner declarations are closed records; required and optional members are:

| Owner | Required members | Optional members and bounds |
| --- | --- | --- |
| `entry` | `binding`, `locks`, `requires` | `handoffTo`, `inputEvidence`; the only input-evidence value is `consumed-ranges`, and it requires a handoff recipient. |
| handler item | `id`, `binding`, `event`, `maximumConcurrent`, `locks`, `requires` | `acceptHandoff`, `authorizeWrite`, `inputEvidence`; concurrency is an integer in 1..64; `event` contains exactly `kind="channel-input"` and `channelId`. |
| operation item | `id`, `title`, `binding`, `arguments`, `result`, `risk`, `repeatability`, `locks`, `availability`, `requires` | `description`, `writeVia`, `cleanup`, `releaseAfterIdleMs`, `reentry`, `transfer`. |
| operation `cleanup` | `binding`, `requires`, `maximumMilliseconds`, `maximumLuaFuel`, `maximumWork` | `writeVia`; the three positive integer maxima are respectively at most 10000, 100000, and 3200000. |
| operation `reentry` | `binding`, `requires` | none. |

`event`, `locks`, `requires`, availability modes/profiles, and every other
declared sequence use `pdrv.array`. An operation has 0..32 arguments. A module
has 1..128 operations, at most 64 handlers and at most 32 mailbox names. Names
are 1..96 characters, begin with an ASCII letter, and then contain only ASCII
letters, digits, underscore, dot, or hyphen.

The host calls entry as `binding(context, io)`, where `context` contains the
selected `modeId` and `profileId`. It calls an operation as `binding(args, io)`
with exactly the declared argument keys. It calls invalidation for a generation
boundary; an invalidation binding takes no reusable device authority.

A channel-input handler is called as `binding(args, io)`. `args.input` is a
string or byte value of at most 256 octets; `args.sequence` is an unsigned
64-bit observation sequence. `args.channelId` is also present when the physical
delivery names a channel, and `args.observation` is present only on a topology
which supplies a clock observation. The handler returns no result.

### Exact handoff and relayed-write bindings

For an empty-parser handoff, entry requests an `entry-handoff` with
`parser="empty"` and `timers="none"`. For a retained-prefix handoff, both entry
and recipient declare `inputEvidence="consumed-ranges"`, entry requests
`parser="retained-prefixes"`, and entry must first account for every consumed
input range. No timer or unsettled effect transfers.

The handler’s `acceptHandoff` binding receives one offer record. Its members are
`offerId`, `owner`, `recipient`, `channelId`, `generation`, `parser`, `timers`,
and, for retained prefixes, `prefixes`. Each prefix contains `channelId`,
`start`, `end`, and `physicalSequence`. The binding must return exactly one
boolean field named `accepted`. It may return `{accepted=false}` to refuse; it
receives no ordinary I/O effects. Entry receives `accepted` or `refused` from
its handoff request.

For relayed writes, the operation declares `writeVia=<handler-id>` and includes
`channel.write-via` in `requires`; that handler declares `authorizeWrite`.
The authorization binding receives exactly `requestId`, `operationId`,
`operation`, `origin`, `cleanupOf`, `ownerId`, `channelId`, `generation`, and
`bytes`. `origin` is `operation` or `cleanup`; `bytes` is the proposed exact
byte value. The binding must return exactly `{accepted=<boolean>}` and receives
no ordinary I/O effects. Only an accepted exact request proceeds to native
submission. The operation’s `write-via` request completes as
`accepted-by-platform` only after the whole proposed value receives platform
acceptance.

### Capabilities an operation can require

These are the capability names `requires` accepts; any other name is refused at
admission, so a misspelling never reaches an operator as an unavailable
capability. A capability is either
available for the whole session or it is not; an operation requiring an
unavailable one is refused before its binding runs, and the refusal names both
the requirement and what would satisfy it.

Most are granted by the host, but five are decided by the declaration itself, so
an author controls them directly. Declaring a handler moves reliable input to
that handler: it withdraws `channel.read` and `channel.write` from ordinary
operations and is what makes `mailbox` available. Declaring an `invalidation`
binding is what makes `connection.lifecycle` available at all, and
`channel.write-via` appears only once some handler declares `authorizeWrite`.

| Capability | Available when | Requests it authorizes |
| --- | --- | --- |
| `channel.read` | The declaration has no handler. A declared handler owns reliable input instead. | `read`, `read-bytes`, `input-channel`, `lease-read`, and `wait-any`/`wait-fill` with a positive count. |
| `channel.write` | The declaration has no handler. | `write`, `lease-write`. |
| `channel.write-via` | Some handler declares `authorizeWrite`. | `write-via`, approved byte-exactly by that handler. |
| `mailbox` | The declaration has at least one handler. | `message-send`, `message-wait`. |
| `timer` | Always. | `timer-arm`, `timer-cancel`, `wait-any`, `wait-fill`. |
| `operation.deadline` | Always, for an ordinary operation. Entry and handlers cannot require it. | `deadline-arm`, `deadline-disarm`. |
| `clock.observe` | Always. | `clock-observe`. |
| `expiry.observe` | Always. | `expiry-reserve`, `expiry-start`, `expiry-read`, `expiry-release`. |
| `connection.lifecycle` | The declaration names an `invalidation` binding. | `connection-grant`, `connection-close`, `connection-reacquire`. |
| `usb.control` | The host grants USB control for the selected profile. | `control`. |
| `state.poll` | The host grants a polling policy admitting every declared plan. | The declared state and maintenance polls. Lua issues no request for these; the host runs them. |
| `transfer.checkpoint` | The host grants a durable checkpoint store. | The durable-transfer requests, described under [durable transfer metadata](#durable-transfer-metadata). |
| `transfer.cleanup` | The host grants a durable checkpoint store. | `transfer-cleanup-state` and `transfer-retire`, in cleanup only. |
| `input.retirement` | The host selects its bounded-ingress adapter, `entry.inputEvidence` is `consumed-ranges`, and exactly one handler declares the same. | `input-retirement`. |

A capability is required at four independent sites — `entry.requires`, an
operation's `requires`, its `cleanup.requires`, and its `reentry.requires` —
and each is admitted separately. Requiring one in cleanup does not grant it to
the ordinary operation, and the reverse is equally true.

### Exact core effect requests

Every request is a closed record passed to `io.request`; extra or missing
members are refused. The return spellings below are part of the current Lua
boundary. An opaque id is a host capability string which must be returned only
to the matching effect in the same activation.

| Effect and required capability | Exact request members | Completion |
| --- | --- | --- |
| direct text input; `channel.read` | `kind="read"`, `maximum` in 1..256 | A string containing at most that many available octets. |
| direct bytes input; `channel.read` | `kind="read-bytes"`, `maximum` in 1..256 | Exact byte value. |
| direct output; `channel.write` | `kind="write"`, `value` string or exact bytes | `accepted-by-platform` after a full accepted write; rejection/partial/unknown settlement is a failure. |
| handler-relayed output; `channel.write-via` | `kind="write-via"`, `value` string or exact bytes | `accepted-by-platform` after authorization and full accepted write. |
| arm timer; `timer` | `kind="timer-arm"`, integer `milliseconds` in 0..2147483647 | Opaque timer id. |
| cancel timer; `timer` | `kind="timer-cancel"`, owned `timer` id | `cancelled:<timer-id>`. |
| race input/timers; `timer`, plus `channel.read` when `maximum>0` | `kind="wait-any"`, `maximum` in 0..256, distinct owned `timers` array | `receive:<octets>` or `timer:<timer-id>`; at least input or one timer must be requested. |
| fill exact input count; `timer` and `channel.read` | `kind="wait-fill"`, `count` in 1..256, distinct owned `timers` array | `receive:<octets>` of the requested count, or `timer:<timer-id>`. |
| arm operation deadline; `operation.deadline` | `kind="deadline-arm"`, integer `milliseconds` in 1..2147483647 | Opaque deadline id; expiry cancels the operation. Entry and handlers cannot require this capability. |
| disarm operation deadline; `operation.deadline` | `kind="deadline-disarm"`, owned `deadline` id | `disarmed`. |
| handler-to-foreground route; `mailbox` | `kind="message-send"`, declared `mailbox`, `value` string or exact bytes | `sent`. |
| wait for handler route; `mailbox` and `timer` for supplied timers | `kind="message-wait"`, distinct declared `mailboxes` array, distinct owned `timers` array | `message:<mailbox>:<text>`, a message byte completion, or `timer:<timer-id>`. |
| delivery provenance | `kind="input-channel"` | Current physical channel id; only valid after reliable input in this activation. |
| retained-range accounting | `kind="input-consume"`, positive `length` no greater than unconsumed delivered bytes | `consumed`. |
| entry ownership transfer | `kind="entry-handoff"`, `parser`, `timers="none"` | `accepted` or `refused`. |
| read the current grant; `connection.lifecycle` | `kind="connection-grant"` | The live connection and lease ids joined by a vertical bar. Split on it to obtain the connection id a close requires. |
| close the connection; `connection.lifecycle` | `kind="connection-close"`, the current `connection` id | `closed`, after the host revokes ids, discards queued input, retires timers and delivers the invalidation turn. Refused when the declaration has no `invalidation`. |
| reacquire a connection; `connection.lifecycle` | `kind="connection-reacquire"` | The new connection and lease ids, joined as above. Valid only while no connection is live; `entry` does not run again. |
| write the declared resource result | `kind="resource-write"`, granted `resource` id, `value` exact bytes | `settled`. Valid while no connection is live. |
| publish a public state cell | `kind="state-publish"`, declared `cell`, `value`, and `quality` unless the cell declares `dependsOn` | `published`. |
| observe the session clock; `clock.observe` | `kind="clock-observe"` | A session-relative monotonic observation. There is no ambient clock, and no timer survives it. |

`connection-grant`, `connection-close`, `connection-reacquire`, `resource-write`,
`deadline-arm` and `deadline-disarm` are the requests which do not require a live
connection. Every other effect above is refused from the moment a connection
closes until a reacquisition completes.

The table covers the effects an ordinary device module reaches, and USB control
requests are described below. The runtime also accepts the durable-transfer,
byte-source, expiry-observation, retained-helper, capture-tap, lease and
input-retirement families, whose exact request shapes this reference does not
specify. Device 3 is the worked source for byte-source reads, expiry observation
and input retirement; the retained-helper, capture-tap and lease families have no
worked source in this release.

Use a transaction deadline for the whole request/response operation and timers
for protocol waits or earliest-action delays. A known 50 ms power-up delay says
only that the first request must not be earlier than 50 ms; it supplies no
latest response bound. When observations supply no response maximum, a
conservative driver policy can provide a finite bound. Such a value is policy
rather than a hardware-qualified fact, and a timeout alone does not justify
widening it.

### USB control requests

A profile granted `usb.control` reaches the device's default control endpoint
with one request:

```lua
local reply = io.request({ kind = "control", setup = {
  direction = "device-to-host", requestType = "vendor", recipient = "device",
  request = 0x01, value = 0, index = 0, length = 8,
}, payload = {} })
```

`setup` is a closed record containing exactly `direction`, `requestType`,
`recipient`, `request`, `value`, `index` and `length`; any other member, or a
missing one, is refused. The domains are closed: `direction` is
`device-to-host` or `host-to-device`; `requestType` is `standard`, `class` or
`vendor`; `recipient` is `device`, `interface`, `endpoint` or `other`;
`request` is an integer in 0..255; `value` and `index` are integers in
0..65535; and `length` is an integer in 0..65535, of which a value above 256 is
refused, because 256 octets bounds a control transfer in either direction.

`payload` is always present, as an array of at most 256 octets: the request record
is closed, so omitting the member is refused rather than read as an empty one. A
`device-to-host` request passes an empty array and reads up to `length` octets; a
`host-to-device` request passes exactly `length` octets. Declaring otherwise is
refused before the transfer is submitted.

The completion is JSON text naming the effect, its settlement, and the response
octets. A host which has not granted USB control settles the request
`unsupported` with its limitation rather than raising a failure. An operation
which names `usb.control` in `requires` is separately refused before it starts
on such a host.

### Bounded multi-message collection in contract 2

Contract 2 supplies lower-level pieces for the same bounded conversation: raw
channel reads, timers, one operation deadline, continuing channel-input
handlers, bounded mailboxes, and owned writes. The author owns message framing
and therefore declares the equivalent count, cumulative payload, quiet and
whole-transaction bounds in code. Enforce count and total bytes before writing
an acknowledgement. A quiet interval starts only after the first complete,
validated reply and resets after each later reply; it does not replace the
whole-transaction deadline. A device-specific parser must retain partial frames
across deliveries and distinguish a timer result from received octets.

`maximumConcurrent` on a handler bounds simultaneous activations; it is not a
total message or trigger budget. A handler remains eligible for later input in
the same live generation. If a protocol needs a bounded late-reply drain before
close or reconnect, perform that drain under the current owner and its existing
timer/deadline authority before returning. The host does not infer a drain from
successful result data.

### Limits an author must design around

Protocol facts and resource policy are separate. A module declares device-facing
frame, message-count, cumulative-byte, result/source and deadline bounds from
device facts or explicit driver policy. The current product also enforces these
author-relevant boundaries:

| Boundary | Current contract/default | Design consequence |
| --- | ---: | --- |
| one `read`, `read-bytes`, `wait-any`, `wait-fill`, or handler input delivery | 256 octets | retain and parse larger messages across turns |
| native USB IN request | one selected live endpoint packet | never treat transfer completion as frame completion |
| buffered input per channel | 4 MiB default host envelope | accumulated unread input fails rather than growing without bound |
| encoded Lua input / output | 1 MiB each by default, including ABI overhead | a direct materialized argument/result needs headroom below the envelope |
| retained Lua VM allocation | 16 MiB default | framing tables and copied strings share this allocation |
| one retained activation | 1,000,000 Lua fuel and 32,000,000 effect-work units | long conversations must remain bounded and make progress across yields |
| public value / resource chunk | 1 MiB each by default | stream larger resources in bounded chunks instead of returning one Lua value |
| cleanup declaration | at most 10,000 ms, 100,000 Lua fuel, 3,200,000 work units | cleanup is short terminal protocol work, not a second operation |
| outstanding timers | 1,024 default shared host envelope | release timers promptly; a module cannot assume the operator will raise policy |

Host defaults can be selected more strictly and some are operator-raisable; a
package cannot raise them. The effective design bound is therefore the smaller
of the module's declaration/policy and the host envelope. The 1 MiB frame
ceiling is not a native USB read size.

There is no contract-2 default equivalent to a 512 KiB announced file limit,
4,096 collected messages, a 240-second protocol deadline, or a 600-second job
deadline. Those are protocol/application choices. Announced-size and
message-count maxima need support from device facts or an explicit driver
policy; an operation deadline is explicit, while a launcher/test-harness timeout
remains outside the device contract. A direct result and a streamed result have
different memory costs even when their final byte count is equal.

## Arguments and values

Public values are type-directed. The selected value kinds include null,
boolean, integer, float, decimal, string, bytes, enum, flags, array, record, and
variant. A type can carry only the members meaningful to its kind: integer
width/sign, enum or flags members, record fields and labels, array item,
variants, a fixed semantic unit, numeric bounds, or length bounds. Generated
help admission rejects unknown combinations and values which cannot meet their own
declared domain.

An operation argument may instead be `byte-source` or `stream-source`, with
finite minimum and maximum byte counts plus optional label and description.
The former presents one bounded immutable value. The latter is read through the
host’s bounded source service and is suitable for a source larger than one Lua
value. Device 3’s `write_image` is the complete streamed-source and durable
checkpoint example.

Public integers that do not fit exact JSON number range are emitted with their
declared signedness and decimal spelling. Bytes are emitted with their byte
meaning rather than silently converted to text. Do not choose a smaller or
different type based on one observed value.

### Exact value schemas needed for typed line results

A value schema is a closed record with required `kind` and only the following
kind-specific members:

| Kind | Required members | Optional members |
| --- | --- | --- |
| `null`, `boolean` | none beyond `kind` | none |
| `integer` | `widthBits` (8, 16, 32, or 64), `signed` boolean | exact safe-integer `minimum`/`maximum`, `unit` |
| `float` | none beyond `kind` | finite-number `minimum`/`maximum`, `unit` |
| `kind="decimal"` | none beyond `kind` | `unit` |
| `string`, `bytes` | none beyond `kind` | integer `minimumLength`/`maximumLength` in 0..65536 |
| `enum`, `flags` | nonempty unique `members` array, at most 128 strings | none |
| `array` | `item` value schema | integer `minimumLength`/`maximumLength` in 0..65536 |
| `record` | `fields` record of value schemas | `fieldLabels` record keyed only by declared fields |
| `variant` | nonempty `variants` record of value schemas | none |

Nesting is at most 16 levels and a record has at most 128 fields. `unit`, when
present, contains exactly `kind="fixed"` and one admitted semantic-unit `id`.
Argument schemas may additionally carry nonblank `label` and `description`;
result member schemas may not.

For `result={kind="value", type=<schema>}`, the binding returns the Lua value
described by the schema. A record result has exactly the declared field set.
An array uses `pdrv.array`; flags may be returned as `pdrv.array` of declared
members. A decimal result is returned as a canonical finite decimal string:
optional leading minus, integer digits with no leading zero, and optional dot
followed by one or more fractional digits. A plus sign, exponent, trailing dot,
leading zero, negative zero, Lua number, NaN, or infinity is refused. This is
the exact fixed decimal path; an author may instead declare a bounded integer
with a fixed unit when the public contract is intentionally scaled integer.

The framework cannot derive magnitude or line-length bounds from example wire
values. Useful bases are a device specification, independently varied
observations, or a maintainer/device limit. When no device maximum exists, an
explicit resource/result policy can bound the driver, reject values outside it,
and remain labeled as policy rather than a device guarantee. An example reading
alone does not justify its digit count as a maximum.

## Results

A `none` result returns no public value. A `value` result carries one declared
type and the binding must return a matching value. The Device 3
`get_device_info` operation demonstrates a record containing enum, flags,
ordinary integers, and an exact 64-bit integer.

An outbound `file` or `resource` result declares content text, media type, and
minimum/maximum bytes. A file also declares a safe suggested extension. A
streamed result names its subject and an offset/length range; the binding writes
through the result service instead of constructing an unbounded Lua string.
The CE screenshot and Nspire source sets are the complete admitted file-result
examples included in the release.

The declaration describes bytes and presentation. It does not prove semantic
content. For example, a valid image container is not independent evidence that
the pixels match the device screen.

### Risk and repeatability rule

`read-only` means the operation is not intended to change device or retained
protocol state. `changes-state` means it intentionally changes state but does
not destroy or replace user/device data. `destructive` means it deletes,
overwrites, invalidates, or irreversibly replaces such data. `firmware` is for
firmware mutation and carries that stronger operator warning.

`safe-to-repeat` means repeating the same requested action is safe; it does not
promise an identical sensor reading. `not-repeatable` means an automatic or
casual second invocation can compound harm, perform another irreversible act,
or has no evidence establishing safe re-execution. Thus selecting the same
persistent unit can be `changes-state` and `safe-to-repeat`, while clearing an
irrecoverable log is `destructive` and `not-repeatable`. Each classification
needs a device fact and a defensible inference because generated help exposes
the resulting warning before acquisition.

## Entry, handlers, and handoff

`entry` names a binding, locks, and required effects. The host calls that
binding with immutable selected `modeId` and `profileId` context plus its local
effect facade. Entry establishes a bounded session precondition; it must not
infer liveness from a write that merely entered an OS queue.

A handler declares an id, binding, one `channel-input` event and channel id,
maximum concurrency, locks, and required effects. One reliable channel has one
consumer. A handler can parse fragmented or coalesced input and send bounded
mailbox messages to foreground work. The host, not Lua, schedules it when bytes
arrive.

Entry can hand retained parser-prefix custody to a named handler only when
`entry.handoffTo`, the handler’s `acceptHandoff`, and both sides’
`inputEvidence="consumed-ranges"` declarations agree. The acceptance binding
checks the concrete handoff; naming the relationship is not automatic consent.
Device 3 demonstrates this exact entry-to-handler ownership transition.

An operation can relay writes through a handler by naming its id in `writeVia`
and requiring `channel.write-via`. The handler’s `authorizeWrite` binding sees
the proposed bytes and origin and must affirm the exact write. A relayed owner
does not simultaneously receive direct channel-read or channel-write authority.

## Session lifetime

A connection outlives the operation that ran over it. `entry` runs once, when
the connection is acquired, and not again per operation; the host holds the
connection open between operations and closes it when the session ends. An
operation therefore begins with whatever mode and protocol state the previous
operation left behind.

That is the right arrangement for a device which can sit idle in a stable state.
It is the wrong one for a device whose session is consumed by a single
operation — one which resets on mode exit, or which drops a mode after a
maximum silent interval. For those, an operation which needs the consumable
state must close and reacquire the connection itself, inside the operation:

```lua
local grant = io.request({ kind = "connection-grant" })
io.request({ kind = "connection-close", connection = grant:match("^([^|]+)") })
io.request({ kind = "connection-reacquire" })
```

The close delivers the invalidation turn, the reacquisition opens a fresh
connection, and `entry` does not run again — so anything entry established must
be re-established by the operation. Declare `connection.lifecycle` on the
operation and an `invalidation` binding on the module; without the binding the
capability is unavailable and the operation is refused before it starts. Bound
the whole sequence with a deadline that covers the post-termination silence and
the opening drain, both described below, rather than the exchange alone.

The alternative is to keep the session alive rather than replace it: a
maintenance poll transmits often enough that the device never drops the mode.
The two designs trade against each other, and the trade is the device's, not a
preference. Holding the mode open costs continuous background traffic and a
public read-only operation for the poll to invoke; replacing the session costs
the silence, the drain and a fresh establishment on every operation, and on many
devices a visible reset. Device 1 holds a transfer session open this way and its
constants say so; a device which resets on mode exit wants the replacement above.

### Choosing the lifecycle values

`lifecycle.openingDrainQuietMs` is how long the port must be continuously quiet,
after opening and before the first exchange, for the transport to consider the
line settled. Bytes arriving during the window restart it. Set it from what the
device emits unprompted — an unsolicited banner, the tail of a previous session,
a reset chirp — and set it to zero only when the device is known to say nothing.
A wrong value is invisible on a freshly powered device and on a CLI run that
opens a port nothing else has touched; it appears when a previous session has
left bytes in the pipe, which in practice means the browser, where the same port
is reopened repeatedly within one page.

The drain is bounded by what the transport will buffer, not only by time: a
device which never falls quiet fails the open rather than draining indefinitely.
A long window on a continuously chattering device is therefore not free.

`lifecycle.postTerminationSilence` is how long the host waits after a
termination before reopening. `minimumMs` is that interval;
`afterModeExit` applies it when the host closed the connection, and
`afterAbnormalTermination` applies it when the connection failed. A device with
a mandated recovery interval after a reset needs both true, because the
replacement sequence above is an ordinary host close. A zero interval requires
both false, and a positive one requires at least one true.

`maximumInterTransactionGapMs` on a maintenance poll is the device's bound, not
the poll's period: it declares the longest silence the mode tolerates. The
`intervalMs` is the period the host actually transmits at and belongs strictly
inside that bound, leaving margin for a foreground operation to settle.

## Cleanup, invalidation, and state

Cleanup is optional per operation. When present it declares a separate binding,
its own effect list, optional relayed-write route, and strict maximum elapsed,
Lua-fuel, and work bounds. It is terminal protocol work, not a second ordinary
operation. The Device 3 write cleanup sends its bounded abort and settles the
transfer identity; ordinary read operations need no invented cleanup.

An invalidation binding clears state which cannot survive a connection
generation change. Parser suffixes, transaction reservations, acknowledgements,
mailbox expectations, timers, and handles are examples of values which must not
cross that boundary merely because they remain reachable in Lua.

A public state cell declares a type and either an age or unaged dependency
validity. Its refresh is a declared ordinary operation or a bounded polling
plan. A poll can invoke only an argument-free, read-only, safe-to-repeat value
operation available in its mode. Maintenance uses the same poll shape. Polling
is a host service governed by host policy; the source does not create a free
background loop.

That host policy is a real bound with published numbers, and a plan which
exceeds it is refused at admission rather than slowed down. The ordinary policy
admits a plan whose `intervalMs` is at least 1000. A shorter plan is a
*required* plan and must satisfy all three of the following: it declares a
`maximumInterTransactionGapMs` strictly greater than its own `intervalMs`; its
`intervalMs` is at least the host's granted floor; and the nominal rate of every
plan in the declaration summed together does not exceed the host's granted
polls per second. The CLI and the browser both grant a 200 ms floor and five
polls per second, so a 200 ms heartbeat admits and a 150 ms one does not.


## Durable transfer metadata

The optional transfer service binds a nonempty byte-source argument, an optional
source range, a target offset/domain, a resume binding, finalization policy, and
an optional complete-carrier byte maximum. Segmented mode opts into host-fixed
source grants; it does not let the author choose an arbitrary grant quantum.

Checkpoint reports distinguish committed, volatile, and buffered progress.
They do not replace the device protocol’s acknowledgements or durable evidence.
The Device 3 module is the complete source for query, begin, segmented writes,
window reports, final verification, resume identity, and abort cleanup.

An active transfer may end an attempt as not finished, without calling it a
failure:

```lua
io.request({kind="transfer-resume-required",
  name="my-device.response-timeout",details={stage="settlement"}})
```

This request is terminal; code after it is unreachable. The host admits it
only while the operation owns a live, identity-bound transferring checkpoint
with a validated committed prefix, no verification receipt and no unresolved
native effect. The public result then has `outcome="resume-required"` and a
direct `authoredCause={name=...,details=...}`. Consumers do not inspect the
cause name to choose the outcome. `pdrv.fail` remains an ordinary authored
failure, and returning a record containing `resume-required` remains ordinary
successful result data.

The request does not claim that the device is already quiet. Resume still
enters the declared `resumeBinding`; that binding must report the same device
identity and a quiet boundary (`volatile == committed`, zero buffered work)
before any new transfer DATA. The browser performs at most one automatic
continuation for a verified checkpoint. Unverified identity needs explicit
operator consent, and a second not-finished outcome stops visibly.

## Admission and debugging order

Package first. Then inspect mode help and operation
help. Those steps evaluate the exact source set, enforce structural and
cross-reference rules, resolve bindings, and render the public interface without
opening a device.

The first named refusal is usually the most useful. Resolving syntax and return
count before description shape, description shape before binding resolution,
binding and ownership before topology, and topology before hardware avoids
masking earlier causes. A timeout does not justify a wider parser or deadline,
and a discovered USB candidate proves neither grant nor successful entry.

The files under `corpus/` and the package/help commands in the
[tutorial](author-tutorial.md) are the release-contained current examples.

The host owns JavaScript worker and Wasm-instance lifecycle. Contract 2 exposes
no thread-reuse, worker-pool or fresh-thread declaration, and no environment
flag which an author may require. Serialized Node `--worker run` selects a
product adapter; it is not an opt-in promise to reuse a JavaScript thread across
jobs. Measurements should use the shipped adapter; correctness, isolation, and
deadlines cannot depend on undocumented host reuse.
