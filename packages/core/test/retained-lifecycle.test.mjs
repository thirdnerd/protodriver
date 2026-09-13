import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

async function harness(t, program, options = {}) {
  const clock = new VirtualClock(), retired = Promise.withResolvers();
  const state = { knowledge: 41, fact: "fresh", invalidations: 0 };
  const native = { opened: 0, closed: 0, released: 0, executionClosed: false, writes: [] };
  let task;
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "test", modeId: "m", profileId: "p", channelId: "main",
    operations: ["run"], helpers: {}, resourceBroker: {}, captureDestinationAdapter: {},
    async open() {
      const ordinal = ++native.opened;
      const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p" });
      const close = connection.close.bind(connection);
      connection.close = async () => { native.closed++; await close(); };
      const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), release = lease.release.bind(lease), write = lease.write.bind(lease);
        lease.release = async () => { native.released++; await release(); };
        lease.write = async bytes => { native.writes.push(new TextDecoder().decode(bytes)); return write(bytes); };
        if (ordinal === 2) await options.acquireGate?.();
        return lease;
      };
      if (ordinal === 2) await options.openGate?.();
      return connection;
    },
    execution: { async register() { task = program(state); }, async dispatch(_id, input) {
      const [action, , ...value] = input.split("|");
      if (action === "invalidate") {
        await options.invalidationGate?.();
        state.fact = "unknown"; state.invalidations++;
        return { value: { kind: options.badAck ? "ignored" : "invalidated" }, consumed: 1 };
      }
      return { value: (await task.next(value.join("|"))).value, consumed: 1 };
    }, async retire() { retired.resolve(); }, async close() { native.executionClosed = true; } },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("test"); await client.connect({ mode: "m" });
  return { client, server, native, clock, state, retired: retired.promise, async start() {
    const handle = await client.startOperation({ operation: "run", arguments: {} });
    return { id: handle.operationId, result: client.awaitOperation(handle.operationId) };
  } };
}
const grant = { kind: "connection-grant" }, reacquire = { kind: "connection-reacquire" };

test("retained session refuses a fifth attached client", async t => {
  const h = await harness(t, async function* () {});
  for (let index = 2; index <= 4; index++) {
    const response = await h.server.handle({ kind: "attach-client", callId: `attach-${index}`, params: { clientId: `client-${index}` } });
    assert.equal(response.kind, "ok");
  }
  const refused = await h.server.handle({ kind: "attach-client", callId: "attach-5", params: { clientId: "client-5" } });
  assert.equal(refused.kind, "error");
  assert.equal(refused.error.code, "retained.client-limit");
  for (let index = 2; index <= 4; index++) {
    await h.server.handle({ kind: "detach-client", callId: `detach-${index}`, params: { clientId: `client-${index}` } });
  }
});

test("authored reacquire grants new capabilities and delivers invalidation without wiping knowledge", { timeout: 2000 }, async t => {
  let old, fresh;
  const h = await harness(t, async function*(state) {
    state.knowledge++; old = (yield grant).split("|");
    yield { kind: "timer-arm", milliseconds: 1 };
    yield { kind: "connection-close", connection: old[0] };
    assert.deepEqual(state, { knowledge: 42, fact: "unknown", invalidations: 1 });
    fresh = (yield reacquire).split("|");
    yield { kind: "lease-write", lease: fresh[1], value: "NEW" };
    yield { kind: "result", value: "done" };
  });
  assert.equal((await (await h.start()).result).result, "done");
  assert.notEqual(old[0], fresh[0]); assert.notEqual(old[1], fresh[1]);
  assert.deepEqual(h.native.writes, ["NEW"]); assert.equal(h.clock.pending.length, 0);
});

for (const wrong of ["old-lease", "old-connection", "wrong-kind"]) test("reacquire refuses " + wrong + " before native work", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() {
    const old = (yield grant).split("|");
    yield { kind: "connection-close", connection: old[0] };
    const fresh = (yield reacquire).split("|");
    if (wrong === "old-connection") yield { kind: "connection-close", connection: old[0] };
    else yield { kind: "lease-write", lease: wrong === "old-lease" ? old[1] : fresh[0], value: "STOLEN" };
    yield { kind: "result", value: "wrong" };
  });
  assert.equal((await (await h.start()).result).error.code, "retained.capability-not-granted");
  assert.deepEqual(h.native.writes, []); assert.equal(h.native.closed, 1);
});

test("bad invalidation acknowledgement ends execution, rather than retaining stale state", { timeout: 2000 }, async t => {
  const h = await harness(t, async function*() {
    const [connection] = (yield grant).split("|");
    yield { kind: "connection-close", connection };
    yield reacquire;
  }, { badAck: true });
  assert.equal((await (await h.start()).result).error.code, "retained.invalidation-not-acknowledged");
  await h.retired;
  assert.equal(h.native.executionClosed, true); assert.equal(h.native.opened, 1);
});

for (const boundary of ["open", "acquire", "invalidation"]) test("cancellation during " + boundary + " cannot install or use a new grant", { timeout: 2000 }, async t => {
  const ready = Promise.withResolvers(), release = Promise.withResolvers();
  const h = await harness(t, async function*() {
    const [connection] = (yield grant).split("|");
    yield { kind: "connection-close", connection };
    const [, lease] = (yield reacquire).split("|");
    yield { kind: "lease-write", lease, value: "GHOST" };
  }, { [boundary + "Gate"]: async () => { ready.resolve(); await release.promise; } });
  const operation = await h.start(); await ready.promise;
  await h.client.cancelOperation(operation.id); release.resolve();
  assert.equal((await operation.result).outcome, "cancelled"); await h.retired;
  assert.deepEqual(h.native.writes, []);
  assert.equal(h.native.closed, boundary === "invalidation" ? 1 : 2);
  assert.equal(h.native.released, boundary === "acquire" ? 2 : 1);
  assert.equal((await h.client.getSnapshot()).state, boundary === "invalidation" ? "closed" : "idle");
});
