import { DEFAULT_HOST_RESOURCE_LIMITS } from '../packages/contracts/src/limits.ts';

function check(condition, message) { if (!condition) throw new Error(message); }
export function observations() {
  const seen = [], waiters = new Set();
  return { seen,
    add(event) { seen.push(event); for (const waiter of waiters) if (waiter.accept(event)) { waiters.delete(waiter); waiter.resolve(event); } },
    wait(accept) {
      const existing = seen.find(accept);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { accept, resolve: value => { clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("product observation did not arrive within 10000ms")); }, 10_000);
        waiters.add(waiter);
      });
    },
  };
}

// Only this public client and the owning-side registrars are used here. The
// control does not call a server's handle(), execute(), cancel() or broker.
export async function productControls(context, native, { iterations = 100, loss = false } = {}) {
  const { client } = context, events = [], timings = [];
  await client.attach("retained-product-observer");
  const subscription = client.subscribe(event => events.push(event));
  const destination = await context.capture();
  const captureId = await client.startCapture(destination.id, { sidecarThresholdBytes: 4096 });
  await client.connect({ mode: "challenge" });
  if (loss) {
    const handle = await client.startOperation({ operation: "wait", arguments: {} });
    await native.wait(event => event.kind === "write" && event.value === "WAIT");
    check((await client.getSnapshot()).activeOperations.includes(handle.operationId), "wait operation must be suspended before recording-loss injection");
    // One native delivery exceeds the product recorder's selected queue. No
    // timing race with its sink is needed to force required-recording loss.
    const refusedBytes = DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes + 1;
    native.inject("Z".repeat(refusedBytes));
    const result = await client.awaitOperation(handle.operationId);
    check(result.outcome === "cancelled" && result.error?.code === "capture.recorder-overrun",
      "required recording loss must revoke the suspended operation: " + JSON.stringify(result));
    await native.wait(event => event.kind === "ingress" && event.value.length === refusedBytes);
    check(!native.seen.some(event => event.kind === "write" && event.value.startsWith("GHOST")), "recording loss must precede consuming and resuming Lua");
    const summary = await client.stopCapture(captureId), records = await destination.records();
    check(summary.completeness === "incomplete" && records.some(record => record.kind === "gap"), "actual product artifact must retain positioned loss");
    await client.acknowledgeOperation(handle.operationId);
    await client.disconnect("recording-loss control complete"); subscription.dispose();
    return { result, capture: summary, records, controls: ["required-recording revocation", "no post-loss ordinary write", "positioned incomplete artifact"] };
  }
  const output = [];
  const outputId = await context.registerResource({ async write(bytes) { output.push(new TextDecoder().decode(bytes)); }, async close() {} });
  const results = [];
  for (let i = 1; i <= iterations; i++) {
    const before = performance.now();
    const handle = await client.startOperation({ operation: "answer-challenge", arguments: { output: { kind: "resource", id: outputId } } });
    const result = await client.awaitOperation(handle.operationId);
    const completed = performance.now();
    check(result.outcome === "completed" && result.result === "ABC:" + i,
      "helper/authored/helper must consume ABC once through retained product execution: " + JSON.stringify(result));
    check(output.at(-1) === "ABC", "real product resource sink must receive ABC");
    if (i <= 2) {
      const snapshot = await client.getSnapshot();
      check(snapshot.retainedResults.includes(handle.operationId), "completion retained independently of subscriber delivery");
      check((await client.awaitOperation(handle.operationId)).result === result.result, "repeated reliable collection is stable");
    }
    await client.acknowledgeOperation(handle.operationId);
    timings.push({ completionMs: completed - before, acknowledgedMs: performance.now() - before });
    if (i <= 2) results.push(result);
  }
  const beforeForge = output.length;
  const forged = await client.startOperation({ operation: "forge", arguments: {} });
  const refusal = await client.awaitOperation(forged.operationId);
  check(refusal.outcome === "failed" && refusal.error?.code === "retained.resource-not-granted", "forged resource has a typed refusal: " + JSON.stringify({ refusal, lastSinkWrite: output.at(-1) }));
  check(output.length === beforeForge, "forged resource cannot reach any owning-side sink");
  await client.acknowledgeOperation(forged.operationId);

  const pending = await client.startOperation({ operation: "wait", arguments: {} });
  await native.wait(event => event.kind === "write" && event.value === "WAIT");
  check((await client.getSnapshot()).activeOperations.includes(pending.operationId), "wait operation must be suspended before cancellation");
  await client.cancelOperation(pending.operationId);
  const cancelled = await client.awaitOperation(pending.operationId);
  check(cancelled.outcome === "cancelled" && cancelled.error?.code === "retained.cancelled", "suspended operation settles cancelled on public completion channel");
  native.inject("Z");
  await native.wait(event => event.kind === "ingress" && event.value === "Z");
  // A subsequent reliable public call is a barrier, not an arbitrary sleep.
  const snapshot = await client.getSnapshot();
  check(!snapshot.activeOperations.includes(pending.operationId), "late input cannot revive the operation");
  check(!native.seen.some(event => event.kind === "write" && event.value.startsWith("GHOST")), "zero ordinary writes after public cancellation and observed late ingress");
  check((await client.awaitOperation(pending.operationId)).outcome === "cancelled", "late ingress cannot replace retained cancellation");
  await client.acknowledgeOperation(pending.operationId);
  const summary = await client.stopCapture(captureId);
  const records = await destination.records();
  check(summary.completeness === "complete", "product capture must be complete");
  check(records.filter(record => record.kind === "rx-delivered").length === iterations + 1, "capture includes unowned late ingress");
  await client.disconnect("product experiment complete"); subscription.dispose();
  return { results, refusal, cancelled, timings, capture: summary, records,
    writes: native.seen.filter(event => event.kind === "write").map(event => event.value), output,
    events: events.map(event => event.kind), controls: ["retained private state", "helper/authored/helper ownership", "granted resource sink",
      "forged resource refusal", "reliable result retention", "suspended cancellation", "late ingress cannot write or revive", "complete capture"] };
}
