import assert from "node:assert/strict";
import test from "node:test";
import { AuthoredState } from "../src/authored-state.ts";
import { RetainedMailbox } from "../src/retained-mailbox.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { ReadyQueue } from "../src/ready-queue.ts";

function fixture(t, declarations) {
  const clock = new VirtualClock(), queue = new ReadyQueue(), mailbox = new RetainedMailbox(), events = [];
  let refusePublication = false, closeOnRefusal = false, refuseCell;
  const state = new AuthoredState(declarations, clock, queue, () => clock.nextSequence(), changed => {
    if (refusePublication) { if (closeOnRefusal) state.close(); throw new Error("publication refused"); }
    events.push(changed);
  }, (id, cell, basis) => {
    if (refuseCell === id) throw new Error("reservation refused");
    const stage = "state-stage:" + id, target = "state:" + id;
    assert.equal(mailbox.reserve(stage, basis ? { observation: cell, basis } : cell, 0), true);
    return { commit() { mailbox.commitStage(stage, target); }, release() { mailbox.delete(stage); } };
  }, () => true);
  t.after(() => { state.close(); queue.close(); });
  return { state, clock, queue, mailbox, events,
    refuse(close = false) { refusePublication = true; closeOnRefusal = close; },
    refuseReservation(id) { refuseCell = id; } };
}
const cell = { type: { kind: "string", maximumLength: 4096 }, freshForMs: null };
test("refused state publication retains its old value AND old capacity, releasing only the stage", async t => {
  const h = fixture(t, { value: cell });
  await h.state.update("value", "valid", "x".repeat(4096), () => {});
  const before = h.state.snapshot(), capacity = h.mailbox.reservedBytes;
  h.refuse();
  await assert.rejects(h.state.update("value", "valid", "short", () => {}), /publication refused/);
  assert.deepEqual(h.state.snapshot(), before);
  assert.equal(h.mailbox.get("state:value").value, "x".repeat(4096));
  assert.equal(h.mailbox.reservedBytes, capacity);
  assert.deepEqual([...h.mailbox.keys()], ["state:value"]);
  assert.equal(h.events.length, 1);
  const remaining = 16 * 1024 * 1024 - capacity - 128;
  assert.equal(h.mailbox.retainRaw(remaining, 0), true);
  assert.equal(h.mailbox.retainRaw(1, 0), false);
});
test("publication failure after session closure cannot restore a valid pre-close observation", async t => {
  const h = fixture(t, { value: cell });
  await h.state.update("value", "valid", "old", () => {});
  h.refuse(true);
  await assert.rejects(h.state.update("value", "valid", "new", () => {}), /publication refused/);
  assert.equal(h.state.snapshot().value.quality, "unknown");
  assert.equal("value" in h.state.snapshot().value, false);
  assert.equal(h.events.length, 1);
});
test("all-cell invalidation reservation failure leaves both observations and timers unchanged", async t => {
  const h = fixture(t, { a: { ...cell, freshForMs: 100 }, b: cell });
  await h.state.update("a", "valid", "A", () => {});
  await h.state.update("b", "valid", "B", () => {});
  const before = h.state.snapshot(), capacity = h.mailbox.reservedBytes;
  h.refuseReservation("b");
  await assert.rejects(h.state.invalidate(() => {}), /reservation refused/);
  assert.deepEqual(h.state.snapshot(), before);
  assert.equal(h.mailbox.reservedBytes, capacity);
  assert.deepEqual([...h.mailbox.keys()], ["state:a", "state:b"]);
  assert.equal(h.state.timerCount, 1); assert.equal(h.events.length, 2);
});
