import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAuthoredSession } from "../src/authored-module.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const wasm = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const source = `
local bytes={}; for i=0,255 do bytes[#bytes+1]=string.char(i) end
local expected=table.concat(bytes)
return {apiVersion="device/v2",id="device-scale",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
  operations=pdrv.array({{id="stream",title="Stream",binding="stream",arguments={},result={kind="none"},
    risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({"channel"}),
    availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({"channel.read","channel.write"})}})}, {
  stream=function(args,io)
    io.request({kind="write",value="READ"})
    for i=1,65 do
      local value=io.request({kind="read-bytes",maximum=256.0})
      if value~=expected then error("binary range corrupted") end
    end
  end,
}`;
const population = lua => [{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(lua) },
  { logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') }];
function native() {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
  return { clock, connection, options: { clock, platform: "node", logicalDevice: "scale", modeId: "main", profileId: "serial", channelId: "main",
    open: async () => connection, helpers: {}, resourceBroker: {}, captureDestinationAdapter: {} } };
}
async function clientFor(t, server) {
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("scale"); await client.connect({ mode: "main" });
  return client;
}
async function run(client, operation) {
  const { operationId } = await client.startOperation({ operation, arguments: {} });
  const result = await client.awaitOperation(operationId);
  await client.acknowledgeOperation(operationId);
  return result;
}

test("admitted binary stream completes 65 reads without retaining 66 live effects", { timeout: 5000 }, async t => {
  const n = native(), channel = n.connection.channel("main"), acquire = channel.acquire.bind(channel);
  let delivered = 0;
  channel.acquire = async (...args) => {
    const lease = await acquire(...args), write = lease.write.bind(lease);
    lease.write = async bytes => {
      const receipt = await write(bytes);
      assert.equal(new TextDecoder().decode(bytes), "READ");
      for (let i = 0; i < 65; i++) { channel.enqueueReceived(Uint8Array.from({ length: 256 }, (_, j) => j)); delivered += 256; }
      return receipt;
    };
    return lease;
  };
  const { server } = await createAuthoredSession(population(source), wasm, { ...n.options, maximumEffectWork: 10000000 });
  const client = await clientFor(t, server), result = await run(client, "stream");
  assert.equal(result.outcome, "completed", JSON.stringify(result));
  assert.equal(delivered, 16640);
});

test("C4 refuses 63 concurrent helper writes behind one unresolved submission", { timeout: 5000 }, async t => {
  const n = native(), gates = [], submitted = Promise.withResolvers();
  const channel = n.connection.channel("main"), acquire = channel.acquire.bind(channel);
  let calls = 0, writes;
  channel.acquire = async (...args) => {
    const lease = await acquire(...args);
    lease.write = () => {
      calls++;
      if (calls > 1) return Promise.resolve({ atSequence: n.clock.nextSequence(), outcome: { kind: "accepted-by-platform" } });
      const gate = Promise.withResolvers(); gates.push(gate);
      submitted.resolve();
      return gate.promise;
    };
    return lease;
  };
  const server = new RetainedSessionRpcServer({ ...n.options, operations: ["flood", "probe"],
    helpers: { flood: { async run(offer) {
      const lease = offer.accept();
      writes = Array.from({ length: 64 }, () => lease.write(Uint8Array.of(255)));
      await Promise.allSettled(writes);
      return { value: "done", handback: lease.offerBack() };
    } } },
    execution: { async register() {}, async dispatch(_id, input) {
      const [action, , operation] = input.split("|");
      return { consumed: 1, value: action !== "start" ? { kind: "result", value: "done" }
        : operation === "flood" ? { kind: "helper", name: "flood" } : { kind: "write", value: "probe" } };
    }, async retire() {}, async close() {} },
  });
  t.after(async () => {
    for (const gate of gates) gate.resolve({ atSequence: n.clock.nextSequence(), outcome: { kind: "accepted-by-platform" } });
    await Promise.allSettled(writes ?? []);
  });
  const client = await clientFor(t, server);
  const { operationId } = await client.startOperation({ operation: "flood", arguments: {} });
  await submitted.promise;
  const refusals = await Promise.allSettled(writes.slice(1));
  assert.equal(refusals.length, 63);
  assert.ok(refusals.every(r => r.status === "rejected" && r.reason.error.code === "retained.outbound-unresolved"));
  await client.cancelOperation(operationId);
  const cancelled = await client.awaitOperation(operationId);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.error.details.effects.filter(e => e.outcome === "indeterminate").length, 1);
  await client.acknowledgeOperation(operationId);
  const blocked = await run(client, "probe");
  assert.equal(calls, 1, "cancellation/acknowledgement must not admit an overtaking write");
  assert.equal(blocked.error?.code, "retained.outbound-unresolved", JSON.stringify(blocked));
  gates[0].resolve({ atSequence: n.clock.nextSequence(), outcome: { kind: "accepted-by-platform" } });
  await writes[0];
  const reopened = await run(client, "probe");
  assert.equal(reopened.outcome, "completed", JSON.stringify(reopened));
  assert.equal(calls, 2, "actual settlement permits a fresh request");
});

test("C4 abandoned write retains aggregate slot independently of outbound ordering", { timeout: 5000 }, async t => {
  const n = native(), held = Promise.withResolvers(), submitted = Promise.withResolvers(), full = Promise.withResolvers();
  const retired = Promise.withResolvers(), channel = n.connection.channel("main"), acquire = channel.acquire.bind(channel);
  let resourceCalls = 0;
  channel.acquire = async (...args) => {
    const lease = await acquire(...args);
    lease.write = () => { submitted.resolve(); return held.promise; }; return lease;
  };
  const tasks = new Map();
  const programs = {
    *held() { yield { kind: "helper", name: "hold" }; yield { kind: "result", value: "late" }; },
    *fill() {
      const timers = [];
      for (let i = 0; i < 62; i++) timers.push(yield { kind: "timer-arm", milliseconds: 10000 });
      // A wait is the 63rd nonconflicting live effect. Observe it registered by
      // admitting a probe on the same ReadyQueue, not by sleeping.
      full.resolve(); yield { kind: "wait-any", timers, maximum: 0 };
      yield { kind: "result", value: "finished" };
    },
    *probe() { yield { kind: "resource-write", resource: "output", value: "RESOURCE" }; yield { kind: "result", value: "ok" }; },
  };
  const server = new RetainedSessionRpcServer({ ...n.options, maximumEffectWork: 1000000, operations: Object.keys(programs),
    scheduling: { demultiplexer: "input", mailboxes: ["reply"] },
    resourceBroker: { async write() { resourceCalls++; } },
    helpers: { hold: { mailbox: "reply", async run(offer) { const lease = offer.accept(); await lease.write("HELD"); return { value: "done", handback: lease.offerBack() }; } } },
    execution: { async register() {}, async dispatch(id, input) {
      const [action, , op] = input.split("|");
      if (action === "start") tasks.set(id, programs[op]());
      return { consumed: 1, value: tasks.get(id).next(input.split("|").slice(2).join("|")).value };
    }, async retire(id) { if (id === heldId) retired.resolve(); }, async close() {} },
  });
  let heldId;
  t.after(() => held.resolve({ atSequence: n.clock.nextSequence(), outcome: { kind: "accepted-by-platform" } }));
  const client = await clientFor(t, server);
  heldId = (await client.startOperation({ operation: "held", arguments: {} })).operationId;
  await submitted.promise; await client.cancelOperation(heldId); await client.acknowledgeOperation(heldId);
  await client.startOperation({ operation: "fill", arguments: {} }); await full.promise;
  const probe = async () => {
    const op = await client.startOperation({ operation: "probe", arguments: { output: { kind: "resource", id: "output" } } });
    const result = await client.awaitOperation(op.operationId); await client.acknowledgeOperation(op.operationId); return result;
  };
  const blocked = await probe();
  assert.equal(resourceCalls, 0, "refunding the held write admits forbidden aggregate capacity");
  assert.equal(blocked.error?.code, "retained.effect-limit", JSON.stringify(blocked));
  held.resolve({ atSequence: n.clock.nextSequence(), outcome: { kind: "accepted-by-platform" } }); await retired.promise;
  assert.equal((await probe()).outcome, "completed"); assert.equal(resourceCalls, 1);
});

test("terminal history is bounded and its eviction is visible on later failure", { timeout: 2000 }, async t => {
  const n = native(); let count = 0;
  const server = new RetainedSessionRpcServer({ ...n.options, maximumEffectWork: 500000, operations: ["history"],
    execution: { async register() {}, async dispatch() {
      return { consumed: 1, value: count++ < 70 ? { kind: "write", value: "X" } : { kind: "invalid" } };
    }, async retire() {}, async close() {} },
  });
  const client = await clientFor(t, server), result = await run(client, "history");
  assert.equal(result.error.code, "retained.invalid-effect", JSON.stringify(result));
  assert.equal(result.error.details.effects.length, 64);
  assert.equal(result.error.details.effectsEvicted, 6);
  assert.ok(result.error.details.effects.every(e => e.outcome === "accepted-by-platform" && e.bytes === 1));
});
