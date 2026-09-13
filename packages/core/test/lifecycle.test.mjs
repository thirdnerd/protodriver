import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventDelivery } from "../src/events.ts";
import {
  OperationResultRetention,
  OperationResultUnavailableError,
} from "../src/lifecycle.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import {
  DeviceSessionRpcClient,
  DirectSessionRpcAdapter,
} from "../src/rpc.ts";

function call(kind, index, params) {
  return { kind, callId: `lease-call-${index}`, params };
}

function operationResult(operationId, value = 1) {
  return {
    operationId,
    outcome: "completed",
    durationMs: 5,
    result: { value: { kind: "number", value } },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a result completed before subscription remains independently collectable", async () => {
  const results = new OperationResultRetention(4);
  const operationId = "operation-before-subscribe";
  const expected = operationResult(operationId, 42);
  results.begin(operationId);
  results.complete(expected);

  const adapter = new DirectSessionRpcAdapter({
    events: { async *[Symbol.asyncIterator]() {} },
    handle: (request) => results.handle(request),
  });
  const client = new DeviceSessionRpcClient(adapter, { clock: new VirtualClock() });
  try {
    assert.deepStrictEqual(results.retainedResults, [operationId]);
    assert.deepStrictEqual(await client.awaitOperation(operationId), expected);
    await client.acknowledgeOperation(operationId);
    assert.deepStrictEqual(results.retainedResults, []);
  } finally {
    await client.close();
  }
});

test("subscriber overflow cannot remove the operation result it observed", async () => {
  const results = new OperationResultRetention(4);
  const operationId = "operation-overflow";
  const expected = operationResult(operationId, 99);
  results.begin(operationId);
  results.complete(expected);

  const gate = deferred();
  const started = deferred();
  const evictions = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 1,
    maximumReplayCount: 0,
    onSubscriberTerminated: (subscriptionId, reason) => evictions.push({ subscriptionId, reason }),
  });
  delivery.subscribe("result-watcher", async () => {
    started.resolve();
    await gate.promise;
  });
  delivery.publish({ kind: "operation-end", result: expected, sequence: 1 });
  await started.promise;
  delivery.publish({
    kind: "state",
    from: "connected",
    to: "closing",
    reason: "first pending lossless event",
    sequence: 2,
  });
  delivery.publish({
    kind: "state",
    from: "closing",
    to: "closed",
    reason: "overflow",
    sequence: 3,
  });
  await turn();

  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].reason.code, "rpc.subscriber-overflow");
  assert.deepStrictEqual(await results.awaitResult(operationId), expected);
  assert.deepStrictEqual(results.retainedResults, [operationId]);
  gate.resolve();
});

test("retention drops the oldest unacknowledged result before growing", async () => {
  const results = new OperationResultRetention(2);
  for (let index = 1; index <= 3; index += 1) {
    const operationId = `operation-${index}`;
    results.begin(operationId);
    results.complete(operationResult(operationId, index));
  }

  assert.deepStrictEqual(results.retainedResults, ["operation-2", "operation-3"]);
  await assert.rejects(
    results.awaitResult("operation-1"),
    (error) => error instanceof OperationResultUnavailableError
      && error.error.code === "operation.result-unavailable",
  );
  assert.equal((await results.awaitResult("operation-2")).result.value.value, 2);
  results.acknowledge("operation-2");
  assert.deepStrictEqual(results.retainedResults, ["operation-3"]);
});

test("an await started before completion receives the retained result", async () => {
  const results = new OperationResultRetention(2);
  const operationId = "operation-pending-await";
  const expected = operationResult(operationId, 7);
  results.begin(operationId);
  const adapter = new DirectSessionRpcAdapter({
    events: { async *[Symbol.asyncIterator]() {} },
    handle: (request) => results.handle(request),
  });
  const client = new DeviceSessionRpcClient(adapter, { clock: new VirtualClock() });
  const pending = client.awaitOperation(operationId);
  await turn();
  results.complete(expected);
  assert.deepStrictEqual(await pending, expected);
  assert.deepStrictEqual(results.retainedResults, [operationId]);
  await client.close();
});
