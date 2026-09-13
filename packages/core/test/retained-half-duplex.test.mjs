import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { native } from "../../../test-support/device-1/node-native.mjs";

// The REAL serial adapter refuses overlapping authority. Only its native port
// is fake; it delivers these identity octets only after an actual port write.
const input = { tx: [...Buffer.from("PSEARCH")], rx: [[6], [...Buffer.from("P13GMRS")]] };
async function harness(t, program) {
  const events = [], reading = Promise.withResolvers();
  const transport = native(input, "half-duplex", e => { events.push(e); if (e.kind === "authoritative-read-request") reading.resolve(); });
  let task;
  const server = new RetainedSessionRpcServer({ clock: transport.clock, platform: "node", logicalDevice: "duplex-control",
    modeId: "transfer", profileId: "serial", channelId: "main", operations: ["run"], helpers: {},
    open: transport.open, resourceBroker: {}, captureDestinationAdapter: {},
    execution: { async register() { task = program(); }, async dispatch(_id, wire) {
      const step = await task.next(wire.split("|").slice(2).join("|"));
      return { value: step.value, consumed: 1 };
    }, async retire() {}, async close() {} },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("duplex-control"); await client.connect({ mode: "transfer" });
  return { client, events, reading: reading.promise, clock: transport.clock, async run() {
    const h = await client.startOperation({ operation: "run", arguments: {} });
    return client.awaitOperation(h.operationId);
  } };
}

for (const kind of ["write-only", "read", "wait-any", "wait-fill"])
test(`half-duplex ${kind}: first write and repeated operation never race a speculative read`, { timeout: 2000 }, async t => {
  const h = await harness(t, async function* () {
    yield { kind: "write", value: "PSEARCH" };
    if (kind !== "write-only") {
      let received = "";
      while (received.length < 8) {
        const reply = yield kind === "read" ? { kind, maximum: 8 } : kind === "wait-fill"
          ? { kind, count: 8, timers: [] } : { kind, maximum: 8, timers: [] };
        received += kind === "read" ? reply : reply.slice(8);
      }
      assert.equal(received, "\x06P13GMRS");
    }
    yield { kind: "result", value: "accepted" };
  });
  for (let i = 0; i < 2; i++) {
    const result = await h.run();
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(result.result, "accepted");
  }
  assert.equal(h.events.filter(e => e.kind === "native-write").length, 2);
  // A settled reply must not leave a pending next() between operations.
  assert.equal(h.events.filter(e => e.kind === "authoritative-read-request").length,
    h.events.filter(e => e.kind === "authoritative-read-result").length);
});

test("half-duplex cancellation cannot falsely settle an unresolved authoritative read", { timeout: 2000 }, async t => {
  let run = 0;
  const h = await harness(t, async function* () {
    if (++run === 1) yield { kind: "read", maximum: 8 };
    yield { kind: "write", value: "PSEARCH" };
    yield { kind: "result", value: "written" };
  });
  const first = await h.client.startOperation({ operation: "run", arguments: {} });
  await h.reading;
  await h.client.cancelOperation(first.operationId);
  assert.equal((await h.client.awaitOperation(first.operationId)).outcome, "cancelled");
  const second = await h.run();
  assert.equal(second.outcome, "failed", JSON.stringify(second));
  assert.equal(second.error.code, "transport.half-duplex-conflict");
  assert.equal(h.events.filter(e => e.kind === "native-write").length, 0);
  assert.equal(h.events.filter(e => e.kind === "authoritative-read-request").length, 1);
});

test("half-duplex ready timer wins without starting a receive that blocks the following write", { timeout: 2000 }, async t => {
  const h = await harness(t, async function* () {
    const timer = yield { kind: "timer-arm", milliseconds: 0 };
    await h.clock.advance(0);
    assert.equal(yield { kind: "wait-fill", count: 8, timers: [timer] }, "timer:" + timer);
    yield { kind: "write", value: "PSEARCH" };
    yield { kind: "result", value: "written" };
  });
  const result = await h.run();
  assert.equal(result.outcome, "completed", JSON.stringify(result));
  assert.equal(h.events.filter(e => e.kind === "authoritative-read-request").length, 0);
  assert.equal(h.events.filter(e => e.kind === "native-write").length, 1);
});
