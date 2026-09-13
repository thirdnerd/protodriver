import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoredState, inheritedStateQuality } from "../src/authored-state.ts";
import { ReadyQueue } from "../src/ready-queue.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";
import { admitAuthoredModule } from "../src/authored-module.ts";
import { runDerived } from "../../../test-support/device-2/derived-preflight.mjs";

const wasm = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const lua = new Uint8Array(await readFile(new URL("../../../test-support/device-2/derived-preflight.lua", import.meta.url)));
const module = await admitAuthoredModule([{ logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
  { logicalName: "device.lua", sourceBytes: lua }], wasm);
const bool = { type: { kind: "boolean" }, freshForMs: null };
function harness(t, declarations = { source: { ...bool, freshForMs: 5500 }, alarm: bool,
  derived: { ...bool, dependsOn: ["source", "alarm"] }, chained: { ...bool, dependsOn: ["derived"] } }) {
  const clock = new VirtualClock(), queue = new ReadyQueue(), events = [], reservations = [];
  const state = new AuthoredState(declarations, clock, queue, () => clock.nextSequence(),
    (changed, sequence) => events.push({ changed, sequence }), (id, cell, basis) => reservations.push({ id, cell, basis }), () => true);
  t.after(() => { state.close(); queue.close(); });
  return { state, clock, queue, events, reservations, async advance(ms) {
    await clock.advance(ms * 1000); await queue.enqueue(clock.nextSequence(), async () => {});
  }, async seed() {
    await state.update("source", "valid", true, () => {});
    await state.update("alarm", "valid", true, () => {});
    await state.update("derived", undefined, true, () => {});
    await state.update("chained", undefined, true, () => {});
  } };
}

test("optional per-cell inputs admit without a protocol/expression graph", () => {
  assert.deepEqual(module.description.state.sample_rate_is_slowest.dependsOn, ["sample_rate_ms"]);
  const d = structuredClone(module.description); delete d.state.sample_rate_is_slowest.dependsOn;
  assert.equal(admitAuthoredDescription(d, module.bindings).state.sample_rate_ms.freshForMs, 5500);
});
for (const [name, change] of [
  ["empty", d => { d.sample_rate_is_slowest.dependsOn = []; }],
  ["null", d => { d.sample_rate_is_slowest.dependsOn = null; }],
  ["non-array", d => { d.sample_rate_is_slowest.dependsOn = "sample_rate_ms"; }],
  ["duplicate", d => { d.sample_rate_is_slowest.dependsOn.push("sample_rate_ms"); }],
  ["missing", d => { d.sample_rate_is_slowest.dependsOn = ["absent"]; }],
  ["non-string", d => { d.sample_rate_is_slowest.dependsOn = [12]; }],
  ["self", d => { d.sample_rate_is_slowest.dependsOn = ["sample_rate_is_slowest"]; }],
  ["cycle", d => { d.sample_rate_ms.freshForMs = null; d.sample_rate_ms.dependsOn = ["sample_rate_is_slowest"]; }],
  ["independent age", d => { d.sample_rate_is_slowest.freshForMs = 5500; }],
  ["population", d => { d.sample_rate_is_slowest.dependsOn = Array.from({ length: 129 }, (_, i) => "cell" + i); }],
]) test("admission refuses validity dependency " + name, () => {
  const d = structuredClone(module.description); change(d.state);
  assert.throws(() => admitAuthoredDescription(d, module.bindings), e => e.code === "authored.declaration.invalid");
});

test("all quality pairs preserve invalid > unknown > stale > valid, independent of input order", () => {
  // Direct authored invalid publication remains unavailable. This tests the
  // quality combiner's invalid branch, not a nonexistent producer of it.
  const order = ["valid", "stale", "unknown", "invalid"];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    assert.equal(inheritedStateQuality("valid", [order[a], order[b]]), order[Math.max(a, b)]);
    assert.equal(inheritedStateQuality("unknown", [order[a], order[b]]), order[Math.max(2, a, b)]);
  }
});
test("one source expiry projects the whole chain in one event without another timer", { timeout: 2000 }, async t => {
  const h = harness(t); await h.seed(); const initial = h.state.snapshot();
  assert.equal(h.state.timerCount, 1);
  assert.deepEqual(h.reservations.find(r => r.id === "derived").basis, { source: 1, alarm: 1 });
  await h.advance(5499); assert.deepEqual(h.state.snapshot(), initial);
  const count = h.events.length; await h.advance(1);
  assert.equal(h.events.length, count + 1);
  assert.deepEqual(Object.keys(h.events.at(-1).changed).sort(), ["chained", "derived", "source"]);
  for (const id of ["source", "derived", "chained"]) {
    assert.deepEqual(h.state.snapshot()[id], { ...initial[id], quality: "stale" });
    assert.deepEqual(h.events.at(-1).changed[id], h.state.snapshot()[id]);
  }
  assert.equal(h.state.snapshot().alarm.quality, "valid");
  assert.equal(h.state.timerCount, 0);
});
test("new basis cannot bless an old computation; refreshing unaged input cannot freshen aging input", { timeout: 2000 }, async t => {
  const h = harness(t); await h.seed(); await h.advance(5500);
  await h.state.update("alarm", "valid", false, () => {});
  assert.equal(h.state.snapshot().derived.quality, "unknown");
  assert.equal("value" in h.state.snapshot().derived, false);
  await h.state.update("derived", undefined, false, () => {});
  assert.equal(h.state.snapshot().derived.quality, "stale");
  assert.equal(h.state.snapshot().derived.value, false);
  await h.state.update("source", "valid", false, () => {});
  assert.equal(h.state.snapshot().derived.quality, "unknown");
  await h.state.update("derived", undefined, false, () => {});
  assert.equal(h.state.snapshot().derived.quality, "valid");
  assert.equal(h.state.snapshot().derived.value, false);
  assert.equal(h.state.snapshot().chained.quality, "unknown");
});
test("missing observation, unknown input, and explicit generation invalidation hide derived values", { timeout: 2000 }, async t => {
  const h = harness(t);
  await h.state.update("derived", undefined, true, () => {});
  assert.equal(h.state.snapshot().derived.quality, "unknown"); assert.equal("value" in h.state.snapshot().derived, false);
  await h.seed(); await h.state.update("alarm", "unknown", null, () => {});
  assert.equal(h.state.snapshot().chained.quality, "unknown"); assert.equal("value" in h.state.snapshot().chained, false);
  await h.state.invalidate(() => {});
  for (const cell of Object.values(h.state.snapshot())) { assert.equal(cell.quality, "unknown"); assert.equal("value" in cell, false); }
  await h.state.update("source", "valid", true, () => {}); await h.state.update("alarm", "valid", true, () => {});
  assert.equal(h.state.snapshot().derived.quality, "unknown", "generation invalidation discards the old computation");
});
test("derived author quality, wrong values and revoked publications cannot change public state", { timeout: 2000 }, async t => {
  const h = harness(t); await h.seed(); const before = h.state.snapshot();
  for (const quality of ["valid", "stale", "unknown", "invalid", null]) await assert.rejects(h.state.update("derived", quality, true, () => {}), /invalid-publication/);
  await assert.rejects(h.state.update("derived", undefined, "bad", () => {}));
  let live = true;
  const barrier = h.queue.enqueue(h.clock.nextSequence(), async () => { live = false; });
  await assert.rejects(h.state.update("derived", undefined, false, () => { if (!live) throw new Error("revoked"); }), /revoked/);
  await barrier; assert.deepEqual(h.state.snapshot(), before);
  h.state.close();
  for (const cell of Object.values(h.state.snapshot())) { assert.equal(cell.quality, "unknown"); assert.equal("value" in cell, false); }
  await assert.rejects(h.state.update("derived", undefined, false, () => {}), /invalid-publication/);
});
test("ordinary identifier constructor participates in a memoized diamond", { timeout: 2000 }, async t => {
  const h = harness(t, { constructor: bool, left: { ...bool, dependsOn: ["constructor"] },
    right: { ...bool, dependsOn: ["constructor"] }, end: { ...bool, dependsOn: ["left", "right"] } });
  await h.state.update("constructor", "valid", false, () => {});
  for (const id of ["left", "right", "end"]) await h.state.update(id, undefined, false, () => {});
  assert.equal(h.state.snapshot().end.quality, "valid"); assert.equal(h.state.snapshot().end.value, false);
});
test("admitted Lua: 1ms-separated publications expire together; fresh false and close survive", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pdrv-inherited-validity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runDerived(join(directory, "acceptance"));
  assert.equal(report.arms.length, 2); assert.deepEqual(report.arms.map(arm => arm.gapMs), [1, 0]);
});
