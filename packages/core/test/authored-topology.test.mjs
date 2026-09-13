import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { observations } from "../../../test-support/client-harness.mjs";
import { inputs, nativeFixture, instrumentVm } from "../../../test-support/handler-topology/fixture.mjs";

const source = await readFile(new URL("./fixtures/authored-topology/device.lua", import.meta.url), "utf8");
const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
export const refusals = [
  ["unresolved", "authored.binding.unresolved"], ["operation-role", "authored.handler.binding-role"], ["entry-role", "authored.handler.binding-role"],
  ["unknown-event", "authored.handler.event"], ["duplicate-binding", "authored.handler.binding-role"], ["duplicate-consumer", "authored.handler.consumer"],
  ["duplicate-id", "authored.handler.identity"], ["over-reservation", "authored.handler.task-limit"], ["too-many", "authored.handler.task-limit"],
  ["unavailable-channel", "authored.handler.channel-unavailable"], ["unavailable-capability", "authored.handler.capability-unavailable"],
];
async function make(t, name, authoredSource = source) {
  const native = observations(), fixture = nativeFixture(event => native.add(event));
  const restore = instrumentVm(event => native.add(event)); t.after(restore);
  const { server, module } = await createAuthoredSession(inputs(authoredSource, name), artifact,
    { ...fixture.options, platform: "node", resourceBroker: {}, captureDestinationAdapter: {} });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("topology-test");
  return { client, native, fixture, module,
    async start(operation) { return (await client.startOperation({ operation, arguments: {} })).operationId; },
    async result(id) { const r = await client.awaitOperation(id); await client.acknowledgeOperation(id); return r; } };
}
for (const [name, code] of refusals) test("topology refuses " + name + " before acquisition or retained execution", { timeout: 3000 }, async t => {
  const seen = [], restore = instrumentVm(event => seen.push(event)); t.after(restore);
  const fixture = nativeFixture(event => seen.push(event));
  let accepted;
  try {
    accepted = await createAuthoredSession(inputs(source, name), artifact, { ...fixture.options, platform: "node", resourceBroker: {}, captureDestinationAdapter: {} });
    // A removed refusal gets an actual opportunity to run, not an unexercised
    // accepted descriptor that is immediately discarded by the test.
    const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(accepted.server));
    try { await client.attach("unexpected"); await client.connect({ mode: "challenge" }); }
    finally { await client.disconnect(); await client.close(); }
    assert.fail("invalid topology admitted; observations=" + JSON.stringify(seen));
  } catch (cause) { assert.equal(cause.code, code, String(cause)); }
  assert.deepEqual(seen, [], "refusal followed native acquisition or a real retained VM dispatch");
});
for (const name of ["zero", "omitted"]) test("zero handlers is valid: " + name, { timeout: 3000 }, async t => {
  const h = await make(t, name); assert.deepEqual(h.native.seen, []);
  await h.client.connect({ mode: "challenge" });
  assert.equal((await h.result(await h.start("idle"))).outcome, "completed");
  assert.ok(h.native.seen.some(e => e.kind === "vm-dispatch"));
  assert.equal(h.module.description.handlers?.length ?? 0, 0);
});
test("admitted handler really demultiplexes input to a suspended operation", { timeout: 3000 }, async t => {
  const h = await make(t, "valid"); assert.deepEqual(h.native.seen, []);
  await h.client.connect({ mode: "challenge" });
  const id = await h.start("wait"); h.fixture.ingress("payload");
  const result = await h.result(id); assert.equal(result.result, "message:reply:payload", JSON.stringify(result));
  await h.native.wait(e => e.kind === "write" && e.value === "H2:payload");
  assert.ok(h.native.seen.filter(e => e.kind === "vm-dispatch").length > 4);
  await assert.rejects(h.start("receiver"), e => e.error?.code === "retained.unknown-operation");
});
test("foreground cancellation does not cancel a suspended admitted handler", { timeout: 3000 }, async t => {
  const h = await make(t, "valid"); await h.client.connect({ mode: "challenge" });
  const id = await h.start("wait"); h.fixture.ingress("hold");
  await h.native.wait(e => e.kind === "write" && e.value === "H1:hold");
  await h.client.cancelOperation(id); assert.equal((await h.result(id)).outcome, "cancelled");
  h.fixture.ingress("release"); await h.native.wait(e => e.kind === "write" && e.value === "H2:hold");
});
test("admitted locks prevent a handler from bypassing a suspended operation", { timeout: 3000 }, async t => {
  const h = await make(t, "locks"); await h.client.connect({ mode: "challenge" });
  const id = await h.start("locked"); h.fixture.ingress("blocked");
  await h.native.wait(e => e.kind === "ingress" && e.value === "blocked");
  // Idle is a real queue barrier; no sleep guesses whether the handler ran.
  await h.result(await h.start("idle"));
  assert.equal(h.native.seen.some(e => e.kind === "write"), false);
  await h.client.cancelOperation(id); await h.result(id);
  await h.native.wait(e => e.kind === "write" && e.value === "H2:blocked");
});
test("maximum admitted reservation runs 31 handlers plus 32 operations", { timeout: 5000 }, async t => {
  const h = await make(t, "valid"); await h.client.connect({ mode: "challenge" });
  const subscription = h.client.subscribe(e => { if (e.kind === "operation-end") h.native.add({ kind: "terminal", result: e.result }); });
  t.after(() => subscription.dispose());
  for (let i = 0; i < 31; i++) {
    const before = h.native.seen.filter(e => e.kind === "write").length; h.fixture.ingress("hold");
    await h.native.wait(e => e.kind === "write" && h.native.seen.filter(x => x.kind === "write").length > before);
  }
  const ids = [];
  for (let i = 0; i < 32; i++) ids.push(await h.start("wait"));
  const last = await h.native.wait(e => e.kind === "terminal" || e.kind === "vm-effect" && h.native.seen.filter(x => x.kind === "vm-effect" && x.effect === "message-wait").length === 63);
  assert.equal(last.kind, "vm-effect", "capacity refused after admission: " + JSON.stringify(last));
  assert.equal((await h.client.getSnapshot()).activeOperations.length, 32);
  assert.equal(h.native.seen.filter(e => e.kind === "write").length, 31);
  await h.client.disconnect();
  for (const id of ids) assert.equal((await h.result(id)).outcome, "cancelled");
});
test("reacquisition cannot deliver an old mailbox value to a new operation", { timeout: 3000 }, async t => {
  const h = await make(t, "valid"); await h.client.connect({ mode: "challenge" });
  h.fixture.ingress("old"); await h.native.wait(e => e.kind === "write" && e.value === "H2:old");
  assert.equal((await h.result(await h.start("cycle"))).outcome, "completed");
  const id = await h.start("wait"); h.fixture.ingress("new");
  assert.equal((await h.result(id)).result, "message:reply:new");
});
test("a generation change revokes even the initiating operation's old observation tap", { timeout: 3000 }, async t => {
  const changed = source.replace('local grant=io.request({kind="connection-grant"})', 'local tap=io.request({kind="tap-open"}); local grant=io.request({kind="connection-grant"})')
    .replace('io.request({kind="connection-reacquire"})', 'io.request({kind="connection-reacquire"}); io.request({kind="tap-poll",tap=tap})');
  const h = await make(t, "valid", changed); await h.client.connect({ mode: "challenge" });
  const result = await h.result(await h.start("cycle"));
  assert.equal(result.error?.code, "retained.tap-not-granted");
});
test("D2 real queued-range overflow fails visibly without a foreground operation", { timeout: 5000 }, async t => {
  const h = await make(t, "one-slot"); await h.client.connect({ mode: "challenge" });
  const closed = Promise.withResolvers();
  const subscription = h.client.subscribe(e => { if (e.kind === "connection-close") closed.resolve(e); });
  t.after(() => subscription.dispose());
  h.fixture.ingress("hold"); await h.native.wait(e => e.kind === "write" && e.value === "H1:hold");
  // One occupied slot no longer makes the next range an overflow. Exhaust
  // the unchanged aggregate mailbox instead, while that handler is suspended.
  for (let i = 0; i < 1024; i++) h.fixture.ingress("excess");
  const event = await closed.promise;
  assert.equal(event.error?.code, "retained.mailbox-overflow");
  assert.equal((await h.client.getSnapshot()).fault?.code, "retained.mailbox-overflow");
  assert.equal(h.native.seen.some(e => e.kind === "write" && e.value === "H1:excess"), false);
});
