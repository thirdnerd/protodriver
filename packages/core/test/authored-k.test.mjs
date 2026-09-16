import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AuthoredState } from "../src/authored-state.ts";
import { ReadyQueue } from "../src/ready-queue.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { admitAuthoredModule, createAuthoredSession } from "../src/authored-module.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { ResourceBrokerHost, ResourceBrokerRpcClient, DirectResourceRpcAdapter } from "../src/resources.ts";
import { nativeOptions } from "../../../test-support/k-remainder/fixture.mjs";
import { requireAuthoredOutput } from "../../control-model/src/authored.ts";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const source = await readFile(new URL("./fixtures/authored-k/device.lua", import.meta.url), "utf8");
const population = (lua = source) => [{ logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
  { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(lua) }];
const module = await admitAuthoredModule(population(), artifact);

function stateHarness(t, canArm = () => true) {
  const clock = new VirtualClock(), queue = new ReadyQueue(), output = [];
  const state = new AuthoredState({ reading: { type: { kind: "integer", widthBits: 16, signed: false }, freshForMs: 1 } }, clock, queue,
    () => clock.nextSequence(), (changed, sequence) => { for (const [id, cell] of Object.entries(changed)) output.push({ id, ...cell, sequence }); }, () => {}, canArm);
  t.after(() => { state.close(); queue.close(); }); return { clock, queue, output, state };
}
test("state publication waits behind an already-ready peer, not merely eventual completion", { timeout: 2000 }, async t => {
  const h = stateHarness(t), order = [];
  const peer = h.queue.enqueue(h.clock.nextSequence(), async () => { order.push(h.state.snapshot().reading.quality); });
  const publish = h.state.update("reading", "valid", 0, () => {});
  await Promise.all([peer, publish]);
  assert.deepEqual(order, ["unknown"]); assert.equal(h.state.snapshot().reading.value, 0);
});
test("unknown, current zero, stale zero and explicit unknown retain distinct facts", { timeout: 2000 }, async t => {
  const h = stateHarness(t); assert.deepEqual(h.state.snapshot().reading, { quality: "unknown", revision: 0 });
  await h.state.update("reading", "valid", 0, () => {}); const first = h.state.snapshot().reading;
  assert.equal(first.quality, "valid"); assert.equal(first.value, 0);
  await h.clock.advance(1000); await h.queue.enqueue(h.clock.nextSequence(), async () => {});
  assert.deepEqual(h.state.snapshot().reading, { ...first, quality: "stale" });
  await h.state.update("reading", "unknown", null, () => {});
  assert.equal(h.state.snapshot().reading.quality, "unknown"); assert.equal("value" in h.state.snapshot().reading, false);
  assert.equal(h.state.snapshot().reading.revision, 2);
  assert.ok(h.output.every((value, i) => i === 0 || value.sequence > h.output[i - 1].sequence));
});
test("queued publication checks cancellation at execution, before changing state", { timeout: 2000 }, async t => {
  const h = stateHarness(t); let live = true;
  const peer = h.queue.enqueue(h.clock.nextSequence(), async () => { live = false; });
  const publish = h.state.update("reading", "valid", 7, () => { if (!live) throw new Error("revoked"); });
  await assert.rejects(publish, /revoked/); await peer;
  assert.deepEqual(h.state.snapshot().reading, { quality: "unknown", revision: 0 }); assert.deepEqual(h.output, []);
});
test("old expiry cannot stale a newer publication", { timeout: 2000 }, async t => {
  const h = stateHarness(t), release = Promise.withResolvers(), entered = Promise.withResolvers();
  await h.state.update("reading", "valid", 0, () => {});
  const block = h.queue.enqueue(h.clock.nextSequence(), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const newer = h.state.update("reading", "valid", 1, () => {});
  await h.clock.advance(1000); release.resolve(); await block; await newer;
  await h.queue.enqueue(h.clock.nextSequence(), async () => {});
  assert.equal(h.state.snapshot().reading.quality, "valid"); assert.equal(h.state.snapshot().reading.value, 1);
});
test("typed and timer-bound refusals preserve existing public cell", { timeout: 2000 }, async t => {
  const h = stateHarness(t);
  await assert.rejects(h.state.update("reading", "valid", "zero", () => {}));
  await assert.rejects(h.state.update("missing", "valid", 0, () => {}));
  await assert.rejects(h.state.update("reading", "unknown", 0, () => {}));
  assert.equal(h.state.snapshot().reading.revision, 0);
  const full = stateHarness(t, () => false);
  await assert.rejects(full.state.update("reading", "valid", 0, () => {}), /timer-limit/);
  assert.equal(full.state.snapshot().reading.revision, 0);
});

for (const [name, mutate] of [
  ["entry binding", d => { d.entry.binding = "missing"; }],
  ["event binding", d => { d.invalidation = "missing"; }],
  ["result direction", d => { d.operations[0].result.direction = "in"; }],
  ["result bounds", d => { d.operations[0].result.maximumBytes = 2; }],
  ["result host ceiling", d => { d.operations[0].result.maximumBytes = 1024 * 1024 + 1; }],
  ["result media", d => { d.operations[0].result.mediaType = "not a type"; }],
  ["result extension", d => { d.operations[0].result.suggestedExtension = "../bad"; }],
  ["state refresh", d => { d.state.reading.refresh = "missing"; }],
  ["state freshness", d => { d.state.reading.freshForMs = 0; }],
]) test("admission rejects invalid " + name + " before execution", () => {
  const d = structuredClone(module.description); mutate(d); assert.throws(() => admitAuthoredDescription(d, module.bindings));
});

async function harness(t, lua = source, overrides = {}) {
  const native = [], host = new ResourceBrokerHost();
  const result = await createAuthoredSession(population(lua), artifact, { ...nativeOptions(e => native.push(e)), platform: "node",
    resourceBroker: new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)), captureDestinationAdapter: {}, ...overrides });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(result.server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("test");
  return { client, host, native, async run(operation, args = {}, id) {
    const handle = await client.startOperation({ operation, arguments: args, ...(id ? { resultDestinationId: id } : {}) });
    return client.awaitOperation(handle.operationId);
  } };
}
test("entry effects wait for admission and entry static refusal precedes acquisition", { timeout: 3000 }, async t => {
  const h = await harness(t); assert.deepEqual(h.native, []);
  await h.client.connect({ mode: "main" }); assert.deepEqual(h.native.map(e => e.value ?? e.kind), ["native-open", "ENTRY"]);
  assert.equal((await h.client.getSnapshot()).stateCells.boot.value, true);
  const refused = await harness(t, source.replace('{"channel.write"}', '{"usb.control"}'));
  await assert.rejects(refused.client.connect({ mode: "main" }), e => e.error?.code === "authored.capability.unavailable");
  assert.deepEqual(refused.native, []);
});
test("disconnect while entry write is pending cannot publish boot or revive connect", { timeout: 3000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), options = nativeOptions();
  t.after(() => release.resolve());
  const h = await harness(t, source, { async open() {
    const c = await options.open(), channel = c.channel("main"), acquire = channel.acquire.bind(channel);
    channel.acquire = async (...args) => {
      const lease = await acquire(...args), write = lease.write.bind(lease);
      lease.write = async bytes => { if (new TextDecoder().decode(bytes) === "ENTRY") { entered.resolve(); await release.promise; } return write(bytes); }; return lease;
    }; return c;
  } });
  const connecting = h.client.connect({ mode: "main" });
  const refused = assert.rejects(connecting);
  await entered.promise; await h.client.disconnect(); release.resolve(); await refused;
  const snapshot = await h.client.getSnapshot(); assert.equal(snapshot.state, "closed"); assert.equal(snapshot.stateCells.boot.quality, "unknown");
});
test("declared invalidation runs and invalidates public state", { timeout: 3000 }, async t => {
  const h = await harness(t); await h.client.connect({ mode: "main" });
  const result = await h.run("cycle"); assert.equal(result.outcome, "completed", JSON.stringify(result));
  assert.equal((await h.client.getSnapshot()).stateCells.boot.quality, "unknown");
});
test("unaged state loses basis on explicit invalidation, actual reacquisition and session close", { timeout: 3000 }, async t => {
  const h = await harness(t); await h.client.connect({ mode: "main" });
  const original = (await h.client.getSnapshot()).stateCells.boot;
  assert.equal((await h.run("advance-day")).outcome, "completed");
  assert.deepEqual((await h.client.getSnapshot()).stateCells.boot, original);
  assert.equal((await h.run("unaged-forget")).outcome, "completed");
  assert.equal((await h.client.getSnapshot()).stateCells.boot.quality, "unknown");
  await h.run("unaged-zero");
  assert.equal((await h.client.getSnapshot()).stateCells.boot.quality, "valid");
  assert.equal((await h.run("cycle")).outcome, "completed");
  const replaced = (await h.client.getSnapshot()).stateCells.boot;
  assert.equal(replaced.quality, "unknown"); assert.equal("value" in replaced, false);
  assert.equal(h.native.filter(e => e.kind === "native-open").length, 2);
  await h.run("unaged-zero"); assert.equal((await h.client.getSnapshot()).stateCells.boot.quality, "valid");
  await h.client.disconnect();
  const closed = (await h.client.getSnapshot()).stateCells.boot;
  assert.equal(closed.quality, "unknown"); assert.equal("value" in closed, false);
});
test("effect-caused invalidations cannot replenish the causing operation's Lua fuel", { timeout: 3000 }, async t => {
  // Eight 120,000-iteration bodies exceed D5's 1M Lua grant; no native-work
  // grant or connection count is scaled to make the refusal happen.
  const lua = source.replace("invalidatedGeneration=generation", "local total=0; for i=1,120000 do total=total+i end; assert(total==7200060000); invalidatedGeneration=generation")
    .replace("cycle=function(args,io)", "cycle=function(args,io) for iteration=1,8 do")
    .replace('io.request({kind="connection-reacquire"})', 'io.request({kind="connection-reacquire"}) end');
  const h = await harness(t, lua); await h.client.connect({ mode: "main" });
  const result = await h.run("cycle");
  assert.equal(result.outcome, "failed", JSON.stringify(result));
  assert.equal(result.error.code, "lua-vm.resource.fuel-exhausted");
  assert.ok(h.native.filter(e => e.kind === "native-open").length > 1, "must have run callbacks, not refused before execution");
});
test("a failed output close cannot mint a completed resource receipt", { timeout: 3000 }, async t => {
  const h = await harness(t); await h.client.connect({ mode: "main" });
  const id = await h.host.registerSink({ async write() {}, async close() { throw new Error("close failed"); } }, { kind: "host" });
  const result = await h.run("file", { payload: { kind: "value", value: { type: "bytes", encoding: "base64", value: "AP8K" } } }, id);
  assert.equal(result.outcome, "failed"); assert.equal(result.resourceResult, undefined);
  assert.ok(result.error.details.effects.some(e => e.kind === "resource-write" && e.outcome === "settled" && e.bytes === 3));
});
test("generated save requires operation-level meaning, not merely delivered bytes", () => {
  const model = module.description.operations[0].result;
  const outcome = { operationId: "op", outcome: "completed", durationMs: 0, result: null,
    resourceResult: { kind: "file", destinationId: "sink", byteLength: 3, content: model.content, mediaType: model.mediaType, suggestedExtension: "bin" } };
  requireAuthoredOutput(model, outcome, "sink", 3);
  assert.throws(() => requireAuthoredOutput(model, { ...outcome, resourceResult: undefined, result: { payload: { type: "bytes", encoding: "base64", value: "AP8K" } } }, "sink", 3));
});
