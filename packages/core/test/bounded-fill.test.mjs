import assert from "node:assert/strict";
import test from "node:test";
import { BoundedFill } from "../src/bounded-fill.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

test("fill accounts every one-octet visit/copy and refuses an overrun", () => {
  const fill = new BoundedFill(256), ranges = Array.from({ length: 256 }, (_, i) => ({ length: 1, sequence: i + 1 }));
  for (let n = 0; n < 256; n++) assert.equal(fill.ready(ranges.slice(0, n), n, 10), undefined);
  assert.equal(fill.used, 0, "partial queues are not repeatedly scanned");
  assert.equal(fill.ready(ranges, 256, 10), 256);
  assert.equal(fill.ready(ranges, 256, 10), 256); assert.equal(fill.used, 256, "ready candidate is not rescanned");
  assert.equal(fill.take("x".repeat(256), ranges), "x".repeat(256));
  assert.equal(ranges.length, 0); assert.equal(fill.used, 513); assert.equal(fill.bound, 513);
  assert.throws(() => fill.charge(), e => e.error.code === "retained.fill-work-exhausted");
  assert.throws(() => fill.charge(), e => e.error.code === "retained.fill-work-exhausted", "exhaustion cannot mint credit");
});

test("fill keeps the suffix provenance and clamps already-queued readiness to registration", () => {
  const ranges = [{ length: 1, sequence: 3 }, { length: 4, sequence: 7 }], fill = new BoundedFill(3);
  assert.equal(fill.ready(ranges, 5, 12), 12);
  assert.equal(fill.take("abcde", ranges), "abc");
  assert.deepEqual(ranges, [{ length: 2, sequence: 7 }]); assert.equal(fill.used, 5);
});
for (const count of [0]) test(`fill refuses invalid count ${count}`, () => {
  assert.throws(() => new BoundedFill(count), e => e.error.code === "retained.invalid-fill");
});

async function harness(t, program) {
  const clock = new VirtualClock(), observations = [], registration = Promise.withResolvers();
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p" });
  const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
  channel.acquire = async (...args) => {
    const lease = await acquire(...args), incoming = lease.incoming.bind(lease);
    lease.incoming = async function*() {
      for await (const chunk of incoming()) { yield chunk; observations.shift()?.resolve(chunk.atSequence); }
    };
    return lease;
  };
  let task;
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "fill", modeId: "m", profileId: "p", channelId: "main",
    operations: ["run"], open: async () => connection, helpers: {}, resourceBroker: {}, captureDestinationAdapter: {},
    execution: { async register() { task = program(); }, async dispatch(_id, input) {
      const step = await task.next(input.split("|").slice(2).join("|"));
      // The host registers the returned effect synchronously in the following
      // microtasks. setImmediate is a phase barrier, not a readiness delay.
      if (step.value.kind === "wait-fill") setImmediate(() => registration.resolve());
      return { value: step.value, consumed: 1 };
    }, async retire() {}, async close() {} },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("fill"); await client.connect({ mode: "m" });
  return { client, clock, registered: registration.promise,
    ingress(value) { const done = Promise.withResolvers(); observations.push(done); channel.enqueueReceived(new TextEncoder().encode(value)); return done.promise; },
    async run() { const h = await client.startOperation({ operation: "run", arguments: {} }); return client.awaitOperation(h.operationId); } };
}

for (const complete of [false, true]) test(`fill deadline wins without consuming ${complete ? "later complete" : "partial"} input; old ranges retain order and readiness`, { timeout: 3000 }, async t => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await harness(t, async function*() {
    const deadline = yield { kind: "timer-arm", milliseconds: 1 };
    ready.resolve(); await release.promise;
    const lost = yield { kind: "wait-fill", count: 3, timers: [deadline] };
    assert.match(lost, /^timer:/);
    // At-most's original range must still precede an already-expired new
    // timer: keeping just bytes but re-stamping them is also a defect.
    const later = yield { kind: "timer-arm", milliseconds: 0 };
    await h.clock.advance(0);
    const first = yield { kind: "wait-any", maximum: 3, timers: [later] };
    assert.equal(first, "receive:A");
    const second = yield { kind: "read", maximum: 3 };
    assert.equal(second, complete ? "BC" : "B");
    yield { kind: "result", value: "preserved" };
  });
  const result = h.run(); await ready.promise;
  await h.ingress("A"); await h.clock.advance(1000); await h.ingress(complete ? "BC" : "B");
  release.resolve();
  assert.equal((await result).result, "preserved");
});

test("pending fill loses at the unchanged deadline without waiting for its Nth byte", { timeout: 3000 }, async t => {
  const h = await harness(t, async function*() {
    const timer = yield { kind: "timer-arm", milliseconds: 1 };
    const result = yield { kind: "wait-fill", count: 3, timers: [timer] };
    assert.match(result, /^timer:/);
    assert.equal(yield { kind: "read", maximum: 3 }, "A");
    yield { kind: "result", value: "deadline" };
  });
  const result = h.run(); await h.registered; await h.ingress("A"); await h.clock.advance(1000);
  assert.equal((await result).result, "deadline"); assert.equal(h.clock.pending.length, 0);
});

test("registered fill is ready at the Nth byte, not its earlier partial range", { timeout: 3000 }, async t => {
  const h = await harness(t, async function*() {
    const timer = yield { kind: "timer-arm", milliseconds: 1 };
    const result = yield { kind: "wait-fill", count: 3, timers: [timer] };
    assert.match(result, /^timer:/);
    assert.equal(yield { kind: "read", maximum: 3 }, "A");
    assert.equal(yield { kind: "read", maximum: 3 }, "BC");
    yield { kind: "result", value: "nth" };
  });
  const result = h.run(); await h.registered;
  // All three observations precede the MessageChannel arbitration turn.
  // A first-byte timestamp would falsely rank the receive before the timer.
  await h.ingress("A"); await h.clock.advance(1000); await h.ingress("BC");
  assert.equal((await result).result, "nth");
});

test("at-most stays short even when a second range is already queued", { timeout: 3000 }, async t => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await harness(t, async function*() {
    ready.resolve(); await release.promise;
    assert.equal(yield { kind: "wait-any", maximum: 256, timers: [] }, "receive:A");
    assert.equal(yield { kind: "read", maximum: 256 }, "BC");
    yield { kind: "result", value: "short" };
  });
  const result = h.run(); await ready.promise; await h.ingress("A"); await h.ingress("BC"); release.resolve();
  assert.equal((await result).result, "short");
});

test("cancelling a partial fill withdraws interest without consuming another operation's input", { timeout: 3000 }, async t => {
  let run = 0;
  const h = await harness(t, async function*() {
    if (++run === 1) yield { kind: "wait-fill", count: 256, timers: [] };
    else assert.equal(yield { kind: "read", maximum: 256 }, "A");
    yield { kind: "result", value: "later" };
  });
  const { operationId } = await h.client.startOperation({ operation: "run", arguments: {} });
  await h.registered; await h.ingress("A");
  await h.client.cancelOperation(operationId);
  assert.equal((await h.client.awaitOperation(operationId)).outcome, "cancelled");
  await h.client.acknowledgeOperation(operationId);
  assert.equal((await h.run()).result, "later");
});
