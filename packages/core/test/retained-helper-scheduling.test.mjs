import { routed } from "../../../test-support/refusal/cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

async function harness(t, program, helpers, maximumEffectWork = 20000) {
  const clock = new VirtualClock(), tasks = new Map(), alarms = [];
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p" });
  const channel = connection.channel("main");
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "test", modeId: "m", profileId: "p", channelId: "main",
    operations: ["run", "remaining"], open: async () => connection, helpers, maximumEffectWork,
    scheduling: { demultiplexer: "demux", mailboxes: ["reply", "alarms"] },
    resourceBroker: {}, captureDestinationAdapter: {},
    execution: { async register() {}, async dispatch(id, input) {
      const [action, , ...pieces] = input.split("|"), value = pieces.join("|");
      if (action === "start") {
        const [name, , packet] = pieces;
        tasks.set(id, name === "demux" ? (async function*() {
          if (packet === "ALARM") alarms.push(id);
          else yield { kind: "message-send", mailbox: "reply", value: packet };
          yield { kind: "result", value: "handled" };
        })() : name === "remaining" ? (async function*() {
          const rest = yield { kind: "message-wait", mailboxes: ["reply"], timers: [] };
          yield { kind: "result", value: rest };
        })() : program());
      }
      return { value: (await tasks.get(id).next(value)).value, consumed: 1 };
    }, async retire(id) { tasks.delete(id); }, async close() {} },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("test"); await client.connect({ mode: "m" });
  return { client, alarms, inject: text => channel.enqueueReceived(new TextEncoder().encode(text)), async run(operation = "run") {
    const { operationId } = await client.startOperation({ operation, arguments: {} }); return client.awaitOperation(operationId);
  } };
}
const helper = name => ({ kind: "helper", name });
const read = maximum => ({ kind: "read", maximum });

test("routed helper handback preserves suffix; former owner cannot consume or write", { timeout: 2000 }, async t => {
  const waiting = Promise.withResolvers(); let former;
  const h = await harness(t, async function*() {
    const a = yield helper("first"), b = yield read(1), cd = yield helper("last");
    yield { kind: "result", value: a + b + cd };
  }, {
    first: { mailbox: "reply", async run(offer) { former = offer.accept(); const pending = former.read(1); waiting.resolve(); return { value: await pending, handback: former.offerBack() }; } },
    last: { mailbox: "reply", async run(offer) {
      const channel = offer.accept();
      await assert.rejects(async () => former.read(1), e => e.error?.code === "retained.wrong-owner");
      await assert.rejects(async () => former.write("STALE"), e => e.error?.code === "retained.wrong-owner");
      return { value: await channel.read(2), handback: channel.offerBack() };
    } },
  });
  const result = h.run(); await waiting.promise; h.inject("ABCDE");
  assert.equal((await result).result, "ABCD");
  assert.equal((await h.run("remaining")).result, "message:reply:E", "retirement flushed unread routed input");
});

test("pending routed receive prevents nested handoff without discarding bytes", { timeout: 2000 }, async t => {
  const waiting = Promise.withResolvers(); let called = false;
  const h = await harness(t, async function*() { yield { kind: "result", value: yield helper("first") }; }, {
    first: { mailbox: "reply", async run(offer, context) {
      const channel = offer.accept(), pending = channel.read(1);
      await assert.rejects(context.call("last"), e => e.error?.code === "retained.handoff-unavailable");
      waiting.resolve();
      return { value: await pending, handback: channel.offerBack() };
    } },
    last: { mailbox: "reply", async run() { called = true; throw new Error("must not run"); } },
  });
  const result = h.run(); await waiting.promise; h.inject("AB");
  assert.equal((await result).result, "A"); assert.equal(called, false);
  assert.equal((await h.run("remaining")).result, "message:reply:B");
});

test("scheduled helper without a routed grant is refused before its body", { timeout: 2000 }, async t => {
  let called = false;
  const h = await harness(t, async function*() { yield helper("raw"); }, { raw: { async run() { called = true; } } });
  assert.equal((await h.run()).error.code, "retained.helper-channel-not-granted"); assert.equal(called, false);
});

test("nested helper cannot widen its parent's routed channel", { timeout: 2000 }, async t => {
  let called = false;
  const h = await harness(t, async function*() { yield helper("first"); }, {
    first: { mailbox: "reply", async run(offer, context) { offer.accept(); await context.call("other"); } },
    other: { mailbox: "alarms", async run() { called = true; } },
  });
  assert.equal((await h.run()).error.code, "retained.helper-channel-not-granted"); assert.equal(called, false);
});

test(routed.name, { timeout: 2000 }, async t => {
  routed.begin();
  const waiting = Promise.withResolvers();
  const output = new Uint32Array(3);
  const h = await harness(t, async function*() { yield { kind: "result", value: yield helper("first") }; }, {
    first: { mailbox: "reply", async run(offer, context) {
      const channel = offer.accept(); let value = "";
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 50000; j++) { context.iteration(); output[i]++; }
        const pending = channel.read(1); waiting.resolve(); value += await pending;
      }
      return { value, handback: channel.offerBack() };
    } },
  }, routed.grant);
  const result = h.run();
  await Promise.race([waiting.promise,result.then(()=>{throw new Error('routed body refused before its input-suspension prefix');})]);
  h.inject("ABC");
  const terminal=await result;
  routed.check({ code: terminal.error?.code, output: [...output], value: terminal.result });

});
