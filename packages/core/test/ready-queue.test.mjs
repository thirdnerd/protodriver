import assert from "node:assert/strict";
import test from "node:test";
import { ReadyQueue } from "../src/ready-queue.ts";

test("ready peer produces output before a voluntary continuation's next turn", { timeout: 2000 }, async t => {
  const queue = new ReadyQueue(); t.after(() => queue.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
  const output = []; let sequence = 0;
  const again = count => queue.enqueue(++sequence, async () => {
    output.push("A" + count);
    if (count === 3) finished.resolve();
    else void again(count + 1);
  });
  const first = queue.enqueue(++sequence, async () => {
    entered.resolve(); await release.promise;
    output.push("A1"); void again(2);
  });
  await entered.promise;
  const peer = queue.enqueue(++sequence, async () => { output.push("B1"); });
  release.resolve();
  await Promise.all([first, peer, finished.promise]);
  assert.deepEqual(output, ["A1","B1","A2","A3"]);
});

test("out-of-order callback arrival cannot override earlier host readiness", { timeout: 2000 }, async t => {
  const queue = new ReadyQueue(); t.after(() => queue.close());
  const output = [];
  await Promise.all([
    queue.enqueue(20, async () => { output.push("later"); }),
    queue.enqueue(10, async () => { output.push("earlier"); }),
  ]);
  assert.deepEqual(output, ["earlier","later"]);
});

test("matched wait reactions join readiness before the next dispatch selection", { timeout: 2000 }, async t => {
  const matched = Promise.withResolvers(), output = [];
  let once = false;
  const queue = new ReadyQueue(() => { if (!once) { once = true; matched.resolve(); } });
  t.after(() => queue.close());
  const earlier = matched.promise.then(() => queue.enqueue(10, async () => { output.push("matched"); }));
  const later = queue.enqueue(20, async () => { output.push("peer"); });
  await Promise.all([earlier, later]);
  assert.deepEqual(output, ["matched","peer"]);
});

test("a failed readiness hook rejects pending turns instead of stranding them", { timeout: 2000 }, async t => {
  const queue = new ReadyQueue(() => { throw new Error("readiness failed"); });
  t.after(() => queue.close());
  await assert.rejects(queue.enqueue(1, async () => "must not run"), /readiness failed/);
});
