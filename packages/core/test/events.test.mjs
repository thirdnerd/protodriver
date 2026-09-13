import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionEventDelivery,
} from "../src/events.ts";

function stateEvent(sequence, reason = `transition-${sequence}`) {
  return {
    kind: "state",
    from: "opening",
    to: "connected",
    reason,
    sequence,
  };
}

function progressEvent(sequence, operationId = "operation-1") {
  return {
    kind: "operation-progress",
    operationId,
    phase: "program",
    completed: sequence,
    total: 20_000,
    sequence,
  };
}

function transferProgressEvent(sequence, operationId = "operation-1") {
  return {
    kind: "transfer-progress",
    operationId,
    checkpointId: "checkpoint-1",
    phase: "transferring",
    sequence,
  };
}

function cellEvent(sequence, name = "frequency") {
  return {
    kind: "state-cells",
    changed: {
      [name]: {
        quality: "valid",
        value: { kind: "number", value: sequence },
        updatedBySequence: sequence,
        revision: sequence,
      },
    },
    sequence,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventLoopTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await eventLoopTurn();
  }
  assert.fail(message);
}

test("four subscribers receive every event and a late subscriber replays transitions", async () => {
  const listenerErrors = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 16,
    maximumReplayCount: 8,
    onListenerError: (subscriptionId, cause) => listenerErrors.push({ subscriptionId, cause }),
  });
  const received = [[], [], [], []];
  const dispatchOrder = [];
  for (let index = 0; index < received.length; index += 1) {
    delivery.subscribe(`subscriber-${index + 1}`, (event) => {
      dispatchOrder.push(`${event.sequence}:${index + 1}`);
      received[index].push(event.sequence);
      if (index === 1) throw new Error(`listener ${index + 1} failed`);
    });
  }

  delivery.publish(stateEvent(1));
  delivery.publish(stateEvent(2));
  delivery.publish(stateEvent(3));
  await waitFor(
    () => received.every((events) => events.length === 3),
    "the four subscribers did not receive the first three transitions",
  );

  assert.deepStrictEqual(received, [
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
    [1, 2, 3],
  ]);
  assert.deepStrictEqual(dispatchOrder.slice(0, 4), ["1:1", "1:2", "1:3", "1:4"]);
  assert.equal(listenerErrors.length, 3, "throwing middle listener was not isolated");

  const late = [];
  delivery.subscribe("subscriber-late", (event) => { late.push(event.sequence); }, { replayLast: 2 });
  delivery.publish(stateEvent(4));
  await waitFor(() => late.length === 3, "late subscriber did not receive replay plus live event");
  assert.deepStrictEqual(late, [2, 3, 4]);
});

test("event replay refuses a request beyond the retained replay envelope", () => {
  const delivery = new SessionEventDelivery({ maximumLosslessQueueDepth: 1, maximumReplayCount: 1 });
  delivery.publish(stateEvent(1));
  delivery.publish(stateEvent(2));
  assert.throws(
    () => delivery.subscribe("too-far-back", () => {}, { replayLast: 2 }),
    /replayLast 2 exceeds maximumReplayCount 1/u,
  );
});

test("10,000 progress and cell updates occupy one slot per key", async () => {
  const blocked = deferred();
  const started = deferred();
  const received = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 2,
    maximumReplayCount: 0,
  });
  delivery.subscribe("stalled", async (event) => {
    received.push(event);
    if (event.kind === "state" && event.reason === "block") {
      started.resolve();
      await blocked.promise;
    }
  });
  delivery.publish(stateEvent(1, "block"));
  await started.promise;

  for (let index = 0; index < 5_000; index += 1) {
    delivery.publish(progressEvent(index + 2));
  }
  for (let index = 0; index < 5_000; index += 1) {
    delivery.publish(transferProgressEvent(index + 5_002));
  }
  for (let index = 0; index < 10_000; index += 1) {
    delivery.publish(cellEvent(index + 10_002));
  }

  assert.deepStrictEqual(delivery.queueState("stalled"), {
    pendingLosslessEvents: 0,
    pendingCoalescedEvents: 2,
    delivering: true,
  });
  blocked.resolve();
  await waitFor(() => received.length === 3, "coalesced latest values were not delivered");
  assert.equal(received[1].kind, "transfer-progress");
  assert.equal(received[1].sequence, 10_001);
  assert.equal(received[2].kind, "state-cells");
  assert.equal(received[2].sequence, 20_001);
});

test("raw terminal byte chunks remain lossless ordered entries and never coalesce", async () => {
  const blocked = deferred();
  const started = deferred();
  const received = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 4,
    maximumReplayCount: 0,
  });
  delivery.subscribe("terminal", async (event) => {
    received.push(event);
    if (event.kind === "state") {
      started.resolve();
      await blocked.promise;
    }
  });
  delivery.publish(stateEvent(1, "block"));
  await started.promise;
  for (let sequence = 2; sequence <= 4; sequence += 1) {
    delivery.publish({
      kind: "raw-terminal-bytes",
      terminalId: "raw-terminal-1",
      bytes: Uint8Array.of(sequence),
      sequence,
      tUs: sequence * 10,
    });
  }
  assert.deepStrictEqual(delivery.queueState("terminal"), {
    pendingLosslessEvents: 3,
    pendingCoalescedEvents: 0,
    delivering: true,
  });
  blocked.resolve();
  await waitFor(() => received.length === 4, "terminal chunks were not all delivered");
  assert.deepStrictEqual(
    received.slice(1).map(({ bytes }) => [...bytes]),
    [[2], [3], [4]],
  );
});

test("cell coalescing preserves the surviving multi-cell update as one event", async () => {
  const blocked = deferred();
  const started = deferred();
  const received = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 2,
    maximumReplayCount: 0,
  });
  delivery.subscribe("stalled", async (event) => {
    received.push(event);
    if (event.kind === "state") {
      started.resolve();
      await blocked.promise;
    }
  });
  delivery.publish(stateEvent(1, "block"));
  await started.promise;
  delivery.publish({
    kind: "state-cells",
    sequence: 2,
    changed: {
      alpha: { quality: "valid", revision: 1 },
      beta: { quality: "valid", revision: 1 },
    },
  });
  delivery.publish({
    kind: "state-cells",
    sequence: 3,
    changed: {
      alpha: { quality: "valid", revision: 2 },
      gamma: { quality: "valid", revision: 1 },
    },
  });
  assert.deepStrictEqual(delivery.queueState("stalled"), {
    pendingLosslessEvents: 0,
    pendingCoalescedEvents: 3,
    delivering: true,
  });

  blocked.resolve();
  await waitFor(() => received.length === 3, "surviving cell batches were not delivered");
  assert.deepStrictEqual(Object.keys(received[1].changed), ["beta"]);
  assert.deepStrictEqual(Object.keys(received[2].changed), ["alpha", "gamma"]);
  assert.equal(received[2].sequence, 3);
});

test("a stalled lossless subscriber is evicted without affecting its peer", async () => {
  const blocked = deferred();
  const slowStarted = deferred();
  const slow = [];
  const fast = [];
  const evictions = [];
  const delivery = new SessionEventDelivery({
    maximumLosslessQueueDepth: 2,
    maximumReplayCount: 0,
    onSubscriberTerminated: (subscriptionId, reason) => evictions.push({ subscriptionId, reason }),
  });
  delivery.subscribe("slow", async (event) => {
    slow.push(event.sequence);
    slowStarted.resolve();
    await blocked.promise;
  });
  delivery.subscribe("fast", (event) => { fast.push(event.sequence); });

  delivery.publish(stateEvent(1));
  await slowStarted.promise;
  await waitFor(() => fast.length === 1, "fast subscriber did not receive first event");
  for (let sequence = 2; sequence <= 4; sequence += 1) {
    delivery.publish(stateEvent(sequence));
    await eventLoopTurn();
  }
  delivery.publish(stateEvent(5));
  await waitFor(() => fast.length === 5 && evictions.length === 1, "overflow outcome was not delivered");

  assert.deepStrictEqual(slow, [1]);
  assert.deepStrictEqual(fast, [1, 2, 3, 4, 5]);
  assert.equal(evictions[0].subscriptionId, "slow");
  assert.equal(evictions[0].reason.code, "rpc.subscriber-overflow");
  assert.equal(delivery.queueState("slow"), undefined);
  blocked.resolve();
});
