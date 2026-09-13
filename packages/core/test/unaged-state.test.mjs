import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AuthoredState } from "../src/authored-state.ts";
import { ReadyQueue } from "../src/ready-queue.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { admitAuthoredModule } from "../src/authored-module.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";

const wasm = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const lua = new Uint8Array(await readFile(new URL("../../../test-support/device-2/state-preflight.lua", import.meta.url)));
const module = await admitAuthoredModule([{ logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
  { logicalName: "device.lua", sourceBytes: lua }], wasm);
function harness(t, canArm = () => true) {
  const clock = new VirtualClock(), queue = new ReadyQueue(), events = [], reservations = [];
  const state = new AuthoredState({ alarm: { type: { kind: "boolean" }, freshForMs: null },
    rate: { type: { kind: "integer", widthBits: 16, signed: false }, freshForMs: 5500 } }, clock, queue,
    () => clock.nextSequence(), changed => { for (const [id, cell] of Object.entries(changed)) events.push({ id, cell }); }, (id, cell) => reservations.push({ id, cell }), canArm);
  t.after(() => { state.close(); queue.close(); });
  return { clock, queue, state, events, reservations, async advance(ms) {
    await clock.advance(ms * 1000); await queue.enqueue(clock.nextSequence(), async () => {});
  } };
}
test("unaged public description admits explicit null; null is not omission or zero", () => {
  assert.equal(module.description.state.alarm_channel.freshForMs, null);
  for (const value of [undefined, 0, -1, 86400001, Infinity, NaN, "unaged", false]) {
    const d = structuredClone(module.description);
    if (value === undefined) delete d.state.alarm_channel.freshForMs;
    else d.state.alarm_channel.freshForMs = value;
    assert.throws(() => admitAuthoredDescription(d, module.bindings), e => e.code === "authored.declaration.invalid");
  }
  for (const value of [1, 86400000]) {
    const d = structuredClone(module.description); d.state.alarm_channel.freshForMs = value;
    assert.equal(admitAuthoredDescription(d, module.bindings).state.alarm_channel.freshForMs, value);
  }
});
test("unaged publication reserves state, needs no timer capacity and does not manufacture refreshes", { timeout: 2000 }, async t => {
  const h = harness(t, () => false);
  await h.state.update("alarm", "valid", true, () => {});
  const initial = h.state.snapshot().alarm;
  assert.equal(h.state.timerCount, 0); assert.equal(h.reservations.length, 1);
  await h.advance(3 * 86400000);
  assert.deepEqual(h.state.snapshot().alarm, initial); assert.equal(h.events.length, 1);
  await assert.rejects(h.state.update("rate", "valid", 100, () => {}), /timer-limit/);
  assert.equal(h.state.snapshot().rate.quality, "unknown");
});
test("mixed aging and unaged inputs retain distinct qualities at 5500ms and beyond 24 hours", { timeout: 2000 }, async t => {
  const h = harness(t);
  await h.state.update("alarm", "valid", true, () => {}); await h.state.update("rate", "valid", 100, () => {});
  const initial = h.state.snapshot(); assert.equal(h.state.timerCount, 1);
  await h.advance(5499); assert.deepEqual(h.state.snapshot(), initial);
  await h.advance(1); assert.equal(h.state.snapshot().rate.quality, "stale"); assert.deepEqual(h.state.snapshot().alarm, initial.alarm);
  await h.advance(2 * 86400000); assert.deepEqual(h.state.snapshot().alarm, initial.alarm);
});
test("explicit unknown removes an unaged value and a new observation can supersede it", { timeout: 2000 }, async t => {
  const h = harness(t);
  await h.state.update("alarm", "valid", true, () => {});
  await h.state.update("alarm", "unknown", null, () => {});
  assert.equal(h.state.snapshot().alarm.quality, "unknown"); assert.equal("value" in h.state.snapshot().alarm, false);
  await h.state.update("alarm", "valid", false, () => {});
  assert.equal(h.state.snapshot().alarm.value, false); assert.equal(h.state.snapshot().alarm.revision, 3);
});
test("generation invalidation removes unaged basis just as it removes aging basis", { timeout: 2000 }, async t => {
  const h = harness(t);
  await h.state.update("alarm", "valid", true, () => {}); await h.state.update("rate", "valid", 100, () => {});
  await h.state.invalidate(() => {});
  for (const cell of Object.values(h.state.snapshot())) { assert.equal(cell.quality, "unknown"); assert.equal("value" in cell, false); }
  assert.equal(h.state.timerCount, 0);
  await h.advance(2 * 86400000);
  assert.equal(h.state.snapshot().alarm.quality, "unknown");
});
test("revoked queued publication cannot revive an unaged cell", { timeout: 2000 }, async t => {
  const h = harness(t); let live = true;
  await h.state.update("alarm", "valid", true, () => {});
  const barrier = h.queue.enqueue(h.clock.nextSequence(), async () => { live = false; });
  const publication = h.state.update("alarm", "valid", false, () => { if (!live) throw new Error("revoked"); });
  await assert.rejects(publication, /revoked/); await barrier;
  await h.state.invalidate(() => {});
  assert.equal(h.state.snapshot().alarm.quality, "unknown"); assert.equal("value" in h.state.snapshot().alarm, false);
});
test("close removes unaged basis and queued updates cannot resurrect it", { timeout: 2000 }, async t => {
  const h = harness(t); await h.state.update("alarm", "valid", true, () => {});
  const revision = h.state.snapshot().alarm.revision;
  const barrier = h.queue.enqueue(h.clock.nextSequence(), async () => { h.state.close(); });
  const publication = h.state.update("alarm", "valid", false, () => {});
  await assert.rejects(publication, /invalid-publication/); await barrier;
  assert.deepEqual(h.state.snapshot().alarm, { quality: "unknown", revision });
});
