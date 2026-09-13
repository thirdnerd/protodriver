# Worked example: TI-84 Plus CE screenshot

This example explains the qualified `device/v2` source set in
[`corpus/ti84-plus-ce/`](../../corpus/ti84-plus-ce/):
[`device.lua`](../../corpus/ti84-plus-ce/device.lua),
[`directlink.lua`](../../corpus/ti84-plus-ce/directlink.lua), and
[`bmp.lua`](../../corpus/ti84-plus-ce/bmp.lua). The files themselves are the
runnable example; this document does not maintain a second copy.

## Why this example

The TI-84 Plus CE module is a narrow real-device example. It offers one
read-only, safe-to-repeat screenshot operation over one exact USB profile. Its
current authored runtime replays the complete request, acknowledgement,
response, and image path.

## Source map

| Member | Responsibility |
| --- | --- |
| `device.lua` | Public description, USB acquisition request, entry/handler/operation ownership, bounded mailboxes and file-result streaming |
| `directlink.lua` | Exact DirectLink framing, request construction, segment validation and framebuffer assembly |
| `bmp.lua` | Pure 320-by-240 RGB565 BMP construction with exact geometry, masks and length |

`device.lua` is the only entry member. Package-local `require` resolves the two
helpers by their exact logical names; it does not search the filesystem or
fetch dependencies.

## Preserve the observed exchange

The module sends the exact retained buffer-negotiation, normal-mode-entry, and
screenshot requests. Every accepted screenshot segment receives its exact
acknowledgement before the next response is consumed. The handler owns
fragmented/coalesced channel input and hands validated progress to the one
foreground operation through bounded messages.

The source deliberately does not advertise a wider calculator protocol. USB
vendor/product values, interface selection, endpoints, packet sizes, request
bytes, segment bounds, and deadlines are device evidence—not defaults to copy
into another module.

## Keep acquisition and permission outside the source

The `connectionProfiles.usb` declaration requests the measured `0451:e010`
device, configuration/interface, and duplex bulk endpoints. It narrows what a
host may offer; it does not grant access. The ordinary Node or browser host
still owns candidate enumeration, operator authorization, claim, release, and
capture ordering.

## Keep output transformation independent

`bmp.lua` accepts exactly 153,600 framebuffer bytes and emits a 153,666-byte
top-down BMP. It constructs the 66-byte bitfield header with masks `f800`,
`07e0`, and `001f`, then appends the received pixels unchanged. It cannot read
USB, select a response, or authorize a write.

The operation streams those bytes into a host-provided result destination and
declares `image/bmp` plus the `.bmp` extension. Generated help can therefore
describe and save the file without calculator-specific host code.

## Understand the checked project transcript

The [checked transcript](transcript.txt) is a
project-side control record, not a command sequence to run from the release.
It is copied into the release verbatim. Its displayed launcher and source
path name the repository checkout in which the control was generated. The
runnable release interface is the packaged launcher and `examples/` paths shown
in the release README, tutorial, and target guide.

The permanent control at
[`tools/test/author-tutorial.test.mjs`](../../tools/test/author-tutorial.test.mjs)
regenerates every transcript line. Its pack and two help stages execute the
repository CLI as subprocesses. Its final retained-exchange stage invokes that
CLI function in the project harness so it can inject the measured calculator
response through `MockTransport`; the displayed shell line records the public
CLI shape, but was not itself launched as a shell command. The harness checks
all 155 writes (three requests plus 152 acknowledgements), the saved 153,666-byte
BMP, and its 153,600-byte pixel body.

The four recorded stages show distinct results:

1. `pack` records the authored execution
   contract and deterministic source-set identity;
2. mode help shows the one USB mode and one task;
3. operation help shows the read-only risk, repeatability and exact file result;
4. retained execution runs the module against the 154,406-byte measured
   response and saves the BMP.

## Apply the method to another device

Start from evidence and keep the first operation narrow:

1. record candidate identity, framing, exact requests, response boundaries,
   acknowledgement order, and a measured completion bound;
2. declare the physical acquisition request without embedding permission;
3. place native I/O in explicit entry, handler, operation, authorization, and
   cleanup owners;
4. bound every message, timer, input batch, write, and result destination;
5. package the source set; and
6. retain a capture whose start precedes the hardware claim.

Do not widen a parser or deadline merely to make an unknown device pass. A
named refusal at the first unsupported boundary is more useful than a plausible
result assembled from unclaimed bytes.
