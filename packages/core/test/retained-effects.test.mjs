import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const deferred = () => Promise.withResolvers();
const arm = { kind: "timer-arm", milliseconds: 1 };
const setup = { direction: "device-to-host", requestType: "vendor", recipient: "device", request: 1, value: 0, index: 0, length: 2 };
async function harness(t, program, { available = true, control = async () => ({ settled: "completed", payload: Uint8Array.of(0, 255), atSequence: 1 }) } = {}) {
  const clock = new VirtualClock(), ingressed = deferred();
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p" });
  let calls = 0;
  connection.control = async request => { calls++; return control(request); };
  const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
  channel.acquire = async (...args) => {
    const lease = await acquire(...args), incoming = lease.incoming.bind(lease);
    lease.incoming = async function*() { for await (const chunk of incoming()) { yield chunk; ingressed.resolve(); } };
    return lease;
  };
  let task;
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "test", modeId: "m", profileId: "p", channelId: "main",
    operations: ["run"], open: async () => connection, helpers: {}, maximumConcurrentTimers: 2,
    usbControl: { available, limitation: "serial adapter has no control support" },
    // No resource/capture effect is used by this unit population. Full product
    // resource and capture services are exercised by the two-host Lua gate.
    resourceBroker: {}, captureDestinationAdapter: {},
    execution: { async register() { task = program(); }, async dispatch(_id, input) {
      const step = await task.next(input.split("|").slice(2).join("|"));
      return { value: step.value, consumed: 1 };
    }, async retire() {}, async close() {} },
  });
  const adapter = new DirectSessionRpcAdapter(server), client = new DeviceSessionRpcClient(adapter);
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("test"); await client.connect({ mode: "m" });
  return { client, clock, calls: () => calls, async ingress() { channel.enqueueReceived(Uint8Array.of(88)); await ingressed.promise; },
    async run() { const handle = await client.startOperation({ operation: "run", arguments: {} }); return client.awaitOperation(handle.operationId); } };
}

for (const timerFirst of [true, false]) test("retained wait-any uses host sequence: " + (timerFirst ? "timer first" : "ingress first"), { timeout: 2000 }, async t => {
  const ready = deferred(), release = deferred();
  const h = await harness(t, async function*() {
    const timer = yield arm;
    ready.resolve(); await release.promise;
    const value = yield { kind: "wait-any", timers: [timer], maximum: 1 };
    yield { kind: "result", value };
  });
  const result = h.run(); await ready.promise;
  if (timerFirst) { await h.clock.advance(1000); await h.ingress(); }
  else { await h.ingress(); await h.clock.advance(1000); }
  release.resolve();
  assert.equal((await result).result.startsWith(timerFirst ? "timer:" : "receive:X"), true);
});

test("expired timer cancellation removes undelivered readiness by ID", { timeout: 2000 }, async t => {
  const ready = deferred(), release = deferred();
  const h = await harness(t, async function*() {
    const timer = yield arm; ready.resolve(); await release.promise;
    yield { kind: "timer-cancel", timer };
    yield { kind: "wait-any", timers: [timer], maximum: 0 };
    yield { kind: "result", value: "wrong" };
  });
  const result = h.run(); await ready.promise; await h.clock.advance(1000); release.resolve();
  assert.equal((await result).error.code, "retained.timer-not-granted");
  assert.equal(h.clock.pending.length, 0);
});

test("outstanding timer limit refuses the third timer and operation failure clears registrations", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() { yield arm; yield arm; yield arm; yield { kind: "result", value: "unbounded" }; });
  assert.equal((await h.run()).error.code, "retained.timer-limit");
  assert.equal(h.clock.pending.length, 0);
  assert.equal((await h.run()).error.code, "retained.timer-limit", "a later operation has fresh slots, not leaked registrations");
});

test("known unsupported control has an effect ID and makes no native submission", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() { const value = yield { kind: "control", setup, payload: [] }; yield { kind: "result", value }; }, { available: false });
  const value = JSON.parse((await h.run()).result);
  assert.equal(value.settled, "unsupported"); assert.equal(value.submitted, false);
  assert.match(value.limitation, /serial/); assert.ok(value.effectId); assert.equal(h.calls(), 0);
});

test("operation cancellation reports the retired timer state, not its pre-revocation snapshot", { timeout: 2000 }, async t => {
  const armed = deferred(), release = deferred();
  const h = await harness(t, async function*() {
    yield arm; armed.resolve(); await release.promise;
    yield { kind: "result", value: "late" };
  });
  const handle = await h.client.startOperation({ operation: "run", arguments: {} });
  await armed.promise;
  await h.client.cancelOperation(handle.operationId);
  const result = await h.client.awaitOperation(handle.operationId);
  release.resolve();
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.error.details.effects.find(effect => effect.kind === "timer").outcome, "owner-ended");
  assert.equal(h.clock.pending.length, 0);
});

test("invalid USB setup is not disguised as unavailable capability", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() { yield { kind: "control", setup: { ...setup, request: 256 }, payload: [] }; }, { available: false });
  const result = await h.run();
  assert.equal(result.error.code, "retained.invalid-control"); assert.equal(h.calls(), 0);
  assert.equal(result.error.details.submitted, false);
});

test("control completion preserves binary response octets", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() { const value = yield { kind: "control", setup, payload: [] }; yield { kind: "result", value }; });
  assert.deepEqual(JSON.parse((await h.run()).result).payload, [0, 255]); assert.equal(h.calls(), 1);
});

test("platform control failure preserves its cause instead of becoming unsupported", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() { yield { kind: "control", setup, payload: [] }; }, { control: async () => ({
    settled: "failed", atSequence: 3, error: { code: "platform.stall", message: "stall", retryability: "after-reconnect" },
  }) });
  const result = await h.run();
  assert.equal(result.error.code, "platform.stall"); assert.equal(result.error.retryability, "after-reconnect");
  assert.equal(result.error.details.submitted, true); assert.equal(h.calls(), 1);
});
