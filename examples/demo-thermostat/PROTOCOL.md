# DemoBench serial thermostat protocol

This is a fictional device for learning the authored-driver workflow. It is
not a claim about any physical thermostat. Its serial port is 9600 baud, 8 data
bits, no parity, one stop bit, and no flow control. The illustrative USB-serial
identity is vendor `0x1209`, product `0xd001`; only the demo host supplies it.

Each request and reply is printable 7-bit ASCII followed by one carriage
return byte (`CR`, `0x0d`). There is no line feed, echo, prompt, or unsolicited
traffic. A write completing only proves that the host handed off bytes; the
request succeeds only after a complete, valid reply. A reply may arrive in
arbitrarily split serial chunks. The driver accepts at most 64 content bytes
before `CR` and gives each exchange 300 ms from write to complete reply.

| Request (before CR) | Reply (before CR) | Meaning |
| --- | --- | --- |
| `ID?` | `ID DEMOBENCH-THERMOSTAT 1` | Exact identity and protocol version |
| `STATUS?` | `STATUS <sequence> <centi-C> <target-centi-C> <on\|off>` | Current sample |
| `SET <centi-C>` | `SET-OK <centi-C>` | Set target; echo the applied value |

The initial state is temperature `2150` centi-°C (21.50 °C), target `2200`
centi-°C (22.00 °C), and sequence zero. `STATUS?` increments the sequence
before replying. Temperature remains fixed in this teaching simulator; heating
is `on` when temperature is below target, otherwise `off`. Each field is one
space apart. Integers use unsigned decimal with no leading zero except zero
itself. Sequence is 1..2147483647 and wraps to 1 after the maximum;
temperatures and targets are 500..3500 centi-°C. A successful `SET` changes
only the target, not the sequence.

`SET` outside 500..3500 replies `ERR RANGE` and leaves the target unchanged.
Any other request receives no bytes at all. A syntactically valid request gets
one reply line, with no trailing bytes. A malformed reply, a reply over 64
content bytes, or silence past 300 ms is a driver refusal, not a default value.
