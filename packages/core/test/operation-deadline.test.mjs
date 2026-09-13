import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";
import { CaptureDestinationRegistry, DirectCaptureDestinationRpcAdapter } from "../src/capture-rpc.ts";
import { loadCapture } from "../src/capture.ts";

const defer = () => Promise.withResolvers();
const arm = milliseconds => ({ kind: "deadline-arm", milliseconds });
const disarm = deadline => ({ kind: "deadline-disarm", deadline });
const done = value => ({ kind: "result", value });
async function harness(t, programs, extra = {}) {
  const clock = new VirtualClock(), tasks = new Map(), retired = new Map(), writes = [];
  let opens = 0;
  const description = { id: "deadline-test", modes: ["m"], profiles: ["p"], operations: Object.keys(programs).map(id => ({
    id, title: id, binding: id, arguments: {}, result: { kind: "value", type: { kind: "string" } }, locks: [],
    requires: ["operation.deadline"], risk: "changes-state", repeatability: "not-repeatable", availability: { modes: ["m"], profiles: ["p"] },
  })) };
  if (extra.scheduled) {
    description.handlers = [{ id: "receiver", binding: "input", event: { kind: "channel-input", channelId: "main" }, maximumConcurrent: 1, locks: [], requires: [] }];
    description.mailboxes = ["park"];
  }
  if (extra.lifecycle) description.invalidation = "invalidate";
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "deadline-test", modeId: "m", profileId: "p", channelId: "main",
    description, capabilities: { "operation.deadline": { available: true } }, operations: Object.keys(programs), helpers: {}, resourceBroker: {}, captureDestinationAdapter: {},
    async open() {
      opens++;
      const c = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p" });
      if (extra.closeGate) { const close = c.close.bind(c); c.close = async () => { await extra.closeGate(); await close(); }; }
      const channel = c.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args);
        lease.write = async bytes => {
          await extra.beforeWrite?.(bytes);
          writes.push([...bytes]);
          return { atSequence: clock.nextSequence(), outcome: { kind: "accepted-by-platform" } };
        };
        return lease;
      };
      return c;
    },
    execution: {
      async register(id) { retired.set(id, defer()); },
      async startOperation(id, binding) { const task = programs[binding](); tasks.set(id, task); return { consumed: 1, value: (await task.next()).value }; },
      async dispatch(id, input) { return { consumed: 1, value: input.startsWith("invalidate|") ? { kind: "invalidated" }
        : (await tasks.get(id).next(input.split("|").slice(2).join("|"))).value }; },
      async retire(id) { retired.get(id)?.resolve(); }, async close() {},
    }, ...extra.options,
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { extra.release?.(); await client.disconnect(); await client.close(); });
  await client.attach("deadline"); await client.connect({ mode: "m" });
  return { client, clock, writes, opens: () => opens, retired,
    async start(operation) { return (await client.startOperation({ operation, arguments: {} })).operationId; },
    async result(id) { return client.awaitOperation(id); },
    async active(id) { return (await client.getSnapshot()).activeOperations.includes(id); },
  };
}

test("C4 pending write expires autonomously at 500, retaining uncertainty and forbidding late continuation", { timeout: 3000 }, async t => {
  const submitted = defer(), release = defer();
  const h = await harness(t, { async *run() { yield arm(500); yield { kind: "write", value: "*IDN?\r\n" }; yield { kind: "write", value: "LATE" }; yield done("wrong"); } },
    { beforeWrite: async () => { submitted.resolve(); await release.promise; }, release: () => release.resolve() });
  const id = await h.start("run"); await submitted.promise;
  await h.clock.advance(499000); assert.equal(await h.active(id), true);
  await h.clock.advance(1000); assert.equal(await h.active(id), false, "expiry suppressed: operation remains live at due time");
  const result = await h.result(id);
  assert.equal(result.outcome, "cancelled"); assert.equal(result.error.code, "retained.cancelled"); assert.equal(result.error.retryability, "unknown");
  assert.deepEqual(result.error.details.cause, { kind: "authored-deadline", deadlineId: result.error.details.cause.deadlineId,
    milliseconds: 500, acceptedUs: 0, dueUs: 500000, expiredAtSequence: result.error.details.cause.expiredAtSequence });
  assert.ok(result.error.details.effects.some(e => e.kind === "write" && e.bytes === 7 && e.outcome === "indeterminate"));
  assert.deepEqual(h.writes, [], "logical cancellation is observable before the held call emits bytes");
  release.resolve(); await h.retired.get(id).promise;
  assert.deepEqual(h.writes, [[...Buffer.from("*IDN?\r\n")]]);
  assert.deepEqual(await h.result(id), result, "late settlement cannot rewrite the terminal result");
});

test("terminal accounting retires all 64 accepted timers and keeps capture complete", { timeout: 3000 }, async t => {
  const parts = new Map(), registry = new CaptureDestinationRegistry();
  const destination = await registry.register({ async openPart(name) { parts.set(name, []); return name; }, async commit() {}, async abort() {} }, "terminal");
  const h = await harness(t, { async *run() {
    for (let i = 0; i < 65; i++) yield { kind: "timer-arm", milliseconds: 1000 };
    yield { kind: "write", value: "FORBIDDEN" };
  } }, { options: { maximumEffectWork: 1000000,
    captureDestinationAdapter: new DirectCaptureDestinationRpcAdapter(registry, "terminal"),
    resourceBroker: { async write(id, data) { parts.get(id).push(Buffer.from(data)); }, async close() {} },
  } });
  const capture = await h.client.startCapture(destination, { sidecarThresholdBytes: 65536 });
  const id = await h.start("run"), result = await h.result(id);
  await h.retired.get(id).promise;
  assert.equal(result.error?.code, "retained.effect-limit");
  assert.deepEqual(h.writes, []);
  const summary = await h.client.stopCapture(capture);
  assert.equal(summary.completeness, "complete"); assert.equal(summary.gapCount, 0);
  const loaded = await loadCapture((async function*() { yield Buffer.concat([...parts.values()].flat()); })());
  assert.equal(loaded.completeness, "complete");
  assert.equal(h.clock.pending.length, 0);
});

for (const expireFirst of [false, true]) test("C4 host sequence decides disarm race: expiry first=" + expireFirst, { timeout: 3000 }, async t => {
  const armed = defer(), release = defer(), disarmed = defer();
  const h = await harness(t, { async *run() {
    const id = yield arm(1); armed.resolve(); await release.promise;
    const result = yield disarm(id); disarmed.resolve(result); yield done("finished");
  } }, { release: () => release.resolve() });
  const id = await h.start("run"); await armed.promise;
  if (expireFirst) { await h.clock.advance(1000); assert.equal(await h.active(id), false); release.resolve(); }
  else { release.resolve(); assert.equal(await disarmed.promise, "disarmed"); await h.clock.advance(1000); }
  assert.equal((await h.result(id)).outcome, expireFirst ? "cancelled" : "completed");
  assert.equal(h.clock.pending.length, 0);
});

test("C4 nested deadline retains the total bound after inner disarm", { timeout: 3000 }, async t => {
  const ready = defer(), release = defer();
  const h = await harness(t, { async *run() {
    yield arm(3); const inner = yield arm(1); yield disarm(inner);
    ready.resolve(); await release.promise; yield done("late");
  } }, { release: () => release.resolve() });
  const id = await h.start("run"); await ready.promise; await h.clock.advance(1000); assert.equal(await h.active(id), true);
  await h.clock.advance(2000); assert.equal(await h.active(id), false); assert.equal((await h.result(id)).error.details.cause.milliseconds, 3);
});

for (const kind of ["guessed", "wrong-kind", "disarmed"]) test("C4 refuses " + kind + " deadline ID", { timeout: 3000 }, async t => {
  const h = await harness(t, { async *run() {
    let id = "retained-effect-guessed";
    if (kind === "wrong-kind") id = yield { kind: "timer-arm", milliseconds: 1 };
    if (kind === "disarmed") { id = yield arm(1); yield disarm(id); }
    yield disarm(id); yield done("wrong");
  } });
  assert.equal((await h.result(await h.start("run"))).error.code, "retained.deadline-not-granted");
  assert.equal(h.clock.pending.length, 0);
});

test("C4 foreign live deadline is not peer cancellation authority", { timeout: 3000 }, async t => {
  const ready = defer(), release = defer(); let foreign;
  const h = await harness(t, {
    async *owner() { foreign = yield arm(100); ready.resolve(); yield { kind: "message-wait", mailboxes: ["park"], timers: [] }; yield done("end"); },
    async *intruder() { yield disarm(foreign); yield done("wrong"); },
  }, { scheduled: true, release: () => release.resolve() });
  const owner = await h.start("owner"); await ready.promise;
  assert.equal((await h.result(await h.start("intruder"))).error.code, "retained.deadline-not-granted");
  assert.equal(await h.active(owner), true); await h.clock.advance(100000); assert.equal(await h.active(owner), false);
});

test("C4 shares timer capacity and does not reset consumed work", { timeout: 3000 }, async t => {
  const h = await harness(t, {
    async *capacity() { yield { kind: "timer-arm", milliseconds: 20 }; yield arm(20); yield arm(20); yield done("wrong"); },
    async *fuel() { for (;;) { const id = yield arm(20); yield disarm(id); } },
  }, { options: { maximumConcurrentTimers: 2, maximumEffectWork: 15000 } });
  const first = await h.start("capacity"); assert.equal((await h.result(first)).error.code, "retained.timer-limit");
  const second = await h.start("fuel"); assert.equal((await h.result(second)).error.code, "retained.work-exhausted");
  assert.equal(h.clock.pending.length, 0);
});

test("C4 abandonment obstructs a new owner on bytes until genuine native settlement", { timeout: 3000 }, async t => {
  const submitted = defer(), release = defer(); let first = true;
  const h = await harness(t, {
    async *held() { yield arm(1); yield { kind: "write", value: "FIRST" }; yield done("wrong"); },
    async *next() { yield { kind: "write", value: "SECOND" }; yield done("ok"); },
  }, { beforeWrite: async () => { if (first) { first = false; submitted.resolve(); await release.promise; } }, release: () => release.resolve() });
  const held = await h.start("held"); await submitted.promise; await h.clock.advance(1000);
  assert.equal(await h.active(held), false);
  const denied = await h.result(await h.start("next"));
  // Byte assertion FIRST: deleting the obstruction must move SECOND while
  // FIRST is still held, not merely rename the refusal diagnostic.
  assert.deepEqual(h.writes, [], "SECOND overtook unresolved FIRST");
  assert.equal(denied.error.code, "retained.outbound-unresolved");
  assert.equal(denied.error.details.submitted, false);
  assert.equal(denied.error.details.predecessor.operationId, held);
  release.resolve(); await h.retired.get(held).promise;
  assert.equal((await h.result(await h.start("next"))).outcome, "completed");
  assert.deepEqual(h.writes, [[...Buffer.from("FIRST")], [...Buffer.from("SECOND")]]);
});

test("C4 generation and lease turnover cannot clear an unresolved outbound predecessor", { timeout: 3000 }, async t => {
  const submitted = defer(), release = defer(); let first = true;
  const h = await harness(t, {
    async *held() { yield arm(1); yield { kind: "write", value: "OLD" }; yield done("late"); },
    async *reopen() {
      const [connection] = (yield { kind: "connection-grant" }).split("|");
      yield { kind: "connection-close", connection };
      const [, lease] = (yield { kind: "connection-reacquire" }).split("|");
      yield { kind: "lease-write", lease, value: "NEW" }; yield done("reopened");
    },
    async *fresh() { yield { kind: "write", value: "NEW" }; yield done("ok"); },
  }, { lifecycle: true, beforeWrite: async () => { if (first) { first = false; submitted.resolve(); await release.promise; } }, release: () => release.resolve() });
  const id = await h.start("held"); await submitted.promise; await h.clock.advance(1000);
  const blocked = await h.result(await h.start("reopen"));
  assert.deepEqual(h.writes, [], "generation turnover emitted NEW ahead of OLD");
  assert.equal(blocked.error.code, "retained.outbound-unresolved"); assert.equal(h.opens(), 1);
  assert.equal((await h.client.getSnapshot()).state, "idle");
  release.resolve(); await h.retired.get(id).promise;
  await h.client.connect({ mode: "m" });
  assert.equal((await h.result(await h.start("fresh"))).outcome, "completed");
  assert.deepEqual(h.writes, [[...Buffer.from("OLD")], [...Buffer.from("NEW")]]);
});

test("C4 supported control cannot bypass an unresolved write", { timeout: 3000 }, async t => {
  const submitted = defer(), release = defer();
  const h = await harness(t, {
    async *held() { yield arm(1); yield { kind: "write", value: "OLD" }; yield done("late"); },
    async *control() { yield { kind: "control", setup: { direction: "host-to-device", requestType: "vendor", recipient: "device", request: 1, value: 0, index: 0, length: 1 }, payload: [9] }; yield done("wrong"); },
  }, { beforeWrite: async () => { submitted.resolve(); await release.promise; }, release: () => release.resolve(),
    options: { usbControl: { available: true } } });
  await h.start("held"); await submitted.promise; await h.clock.advance(1000);
  const result = await h.result(await h.start("control"));
  assert.equal(result.error.code, "retained.outbound-unresolved"); assert.equal(result.error.details.submitted, false);
});

test("C4 requirement unavailable refuses before any operation body", { timeout: 3000 }, async t => {
  let entered = false;
  const h = await harness(t, { *run() { entered = true; yield arm(1); } }, { options: { capabilities: {} } });
  await assert.rejects(h.start("run"), /required capability unavailable/); assert.equal(entered, false);
});

for (const value of [0, -1, 1.5, 2147483648, "1", null]) test("C4 refuses invalid deadline duration " + JSON.stringify(value), { timeout: 3000 }, async t => {
  const h = await harness(t, { *run() { yield arm(value); yield done("wrong"); } });
  assert.equal((await h.result(await h.start("run"))).error.code, "retained.invalid-deadline");
  assert.equal(h.clock.pending.length, 0);
});

test("C4 ordinary completion retires an armed deadline before later clock expiry", { timeout: 3000 }, async t => {
  const h = await harness(t, { *run() { yield arm(1); yield done("complete"); } });
  const id = await h.start("run"), result = await h.result(id);
  assert.equal(result.outcome, "completed"); assert.equal(h.clock.pending.length, 0);
  await h.clock.advance(1000); assert.deepEqual(await h.result(id), result);
});

for (const end of ["stop", "disconnect", "storage-failure"]) test("C4 capture lifetime at deadline: " + end, { timeout: 3000 }, async t => {
  const submitted = defer(), release = defer(), cleanup = defer(), parts = new Map(), registry = new CaptureDestinationRegistry();
  const destination = await registry.register({ async openPart(name) { parts.set(name, []); return name; }, async commit() {}, async abort() {} }, "C4");
  let fail = false;
  const h = await harness(t, { async *held() { yield arm(1); yield { kind: "write", value: "PENDING" }; yield done("late"); } }, {
    beforeWrite: async () => { submitted.resolve(); await release.promise; },
    closeGate: end === "disconnect" ? () => cleanup.promise : undefined,
    release: () => { release.resolve(); cleanup.resolve(); },
    options: { captureDestinationAdapter: new DirectCaptureDestinationRpcAdapter(registry, "C4"), resourceBroker: {
      async write(id, buffer) { if (fail) throw new Error("C4 forced storage failure"); parts.get(id).push(Buffer.from(buffer).subarray()); }, async close() {},
    } },
  });
  const capture = await h.client.startCapture(destination, { sidecarThresholdBytes: 65536 });
  const id = await h.start("held"); await submitted.promise;
  fail = end === "storage-failure";
  await h.clock.advance(1000); assert.equal(await h.active(id), false, "storage failure cannot suppress revocation");
  assert.equal((await h.result(id)).outcome, "cancelled");
  if (end === "disconnect") {
    await h.client.disconnect(); // both platform write AND close are still held
    assert.equal((await h.client.getSnapshot()).state, "closed");
  } else {
    const summary = await h.client.stopCapture(capture);
    // Revocation is prompt, but the native receipt is still missing. Neither
    // an explicit stop nor a storage failure can certify that future tail.
    assert.equal(summary.completeness, "incomplete");
  }
  const before = Buffer.concat([...parts.values()].flat());
  if (end !== "storage-failure") {
    const recording = await loadCapture((async function*() { yield before; })());
    assert.equal(recording.completeness, "incomplete");
    assert.ok(recording.records.some(r => r.kind === "gap"));
    assert.equal(recording.records.filter(r => r.kind === "tx-settled").length, 0);
  }
  release.resolve(); cleanup.resolve(); await h.retired.get(id).promise;
  assert.deepEqual(Buffer.concat([...parts.values()].flat()), before, "late native receipt must not rewrite the ended capture");
});

test("concurrent disconnect callers join capture finalization", { timeout: 3000 }, async t => {
  // Unique regression: authored failure began teardown, CLI disconnect returned at #closed, then its capture adapter closed under the recorder.
  const entered = defer(), release = defer(), parts = new Map(), registry = new CaptureDestinationRegistry();
  let commits = 0;
  const destination = await registry.register({
    async openPart(name) { parts.set(name, []); return name; },
    async commit() { commits++; },
    async abort() { throw new Error("unexpected capture abort"); },
  }, "disconnect-join");
  const adapter = new DirectCaptureDestinationRpcAdapter(registry, "disconnect-join");
  t.after(async () => { release.resolve(); await adapter.close(); });
  const h = await harness(t, { *unused() { yield done("unused"); } }, {
    closeGate: async () => { entered.resolve(); await release.promise; },
    release: () => release.resolve(),
    options: { captureDestinationAdapter: adapter, resourceBroker: {
      async write(id, buffer) { parts.get(id).push(Buffer.from(buffer).subarray()); }, async close() {},
    } },
  });
  await h.client.startCapture(destination, { sidecarThresholdBytes: 65536 });
  const first = h.client.disconnect();
  await entered.promise;
  let secondSettled = false;
  const second = h.client.disconnect().then(() => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondSettled, false, "a later caller must not return while recorder teardown is still pending");
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(commits, 1, "the joined teardown finalizes the capture exactly once");
});
