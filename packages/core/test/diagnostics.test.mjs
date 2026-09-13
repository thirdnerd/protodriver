import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import {
  DiagnosticRpcBridge,
  DiagnosticSubscriberLimitError,
  DiagnosticTapFanout,
} from "../src/diagnostics.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import {
  DeviceSessionRpcClient,
  PostMessageSessionRpcAdapter,
  serveSessionRpc,
} from "../src/rpc.ts";

class EventQueue {
  values = [];
  waiters = [];

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
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

const snapshot = {
  takenAtSequence: 20,
  state: "connected",
  currentMode: "normal",
  connection: {
    modeId: "normal",
    profileId: "mock",
    displayName: "worker-held mock connection",
  },
  stateCells: {},
  activeOperations: [],
  retainedResults: [],
  maintenanceStatus: "active",
};

test("postMessage diagnostics are lossy without delaying lifecycle delivery", async () => {
  const clock = new VirtualClock();
  const events = new EventQueue();
  const fanout = new DiagnosticTapFanout(32);
  const bridge = new DiagnosticRpcBridge({
    clock,
    fanout,
    emit: (event) => events.push(event),
    defaultBatchIntervalMs: 10,
    defaultMaximumBytesPerBatch: 32,
    maximumSubscribers: 1,
  });
  const requests = [];
  let lifecycleSubscriptionId;
  let diagnosticSubscriptionId;
  const server = {
    events,
    async handle(request) {
      requests.push(request);
      if (request.kind === "subscribe-diagnostics") {
        diagnosticSubscriptionId = request.params.subscriptionId;
        bridge.subscribe(request.params.subscriptionId, request.params.options);
        return { kind: "ok", method: request.kind, callId: request.callId, result: null };
      }
      if (request.kind === "subscribe") {
        lifecycleSubscriptionId = request.params.subscriptionId;
        return { kind: "ok", method: request.kind, callId: request.callId, result: null };
      }
      if (request.kind === "unsubscribe") {
        bridge.unsubscribe(request.params.subscriptionId);
        return { kind: "ok", method: request.kind, callId: request.callId, result: null };
      }
      if (request.kind === "get-snapshot") {
        return { kind: "ok", method: request.kind, callId: request.callId, result: snapshot };
      }
      throw new Error(`diagnostic test server does not handle ${request.kind}`);
    },
  };

  const { port1, port2 } = new MessageChannel();
  const service = serveSessionRpc(port2, server);
  const adapter = new PostMessageSessionRpcAdapter(port1);
  const diagnosticStarted = deferred();
  const releaseDiagnostic = deferred();
  const diagnosticErrors = [];
  const lifecycleEvictions = [];
  const renderedHex = [];
  const lifecycle = [];
  const client = new DeviceSessionRpcClient(adapter, {
    clock,
    onDiagnosticListenerError: (subscriptionId, cause) => {
      diagnosticErrors.push({ subscriptionId, cause });
    },
    onSubscriberTerminated: (subscriptionId, reason) => {
      lifecycleEvictions.push({ subscriptionId, reason });
    },
  });

  const lifecycleSubscription = client.subscribe((event) => { lifecycle.push(event); });
  const diagnosticSubscription = client.subscribeDiagnostics(async (batch) => {
    renderedHex.push(batch.records.map(({ bytes }) => Buffer.from(bytes).toString("hex")));
    renderedHex.push(batch.dropped);
    diagnosticStarted.resolve();
    await releaseDiagnostic.promise;
    throw new Error("hex renderer failed after receiving its copy");
  }, { batchIntervalMs: 10, maximumBytesPerBatch: 32 });

  try {
    await waitFor(
      () => requests.some(({ kind }) => kind === "subscribe")
        && requests.some(({ kind }) => kind === "subscribe-diagnostics"),
      "subscriptions did not reach the worker side",
    );

    for (let index = 0; index < 10; index += 1) {
      fanout.publish({
        sequence: index + 1,
        tUs: (index + 1) * 1_000,
        direction: "rx",
        channelId: "main",
        bytes: Uint8Array.from({ length: 8 }, () => index),
      });
    }
    await clock.advance(10_000);
    await diagnosticStarted.promise;

    assert.deepStrictEqual(renderedHex[0], [
      "0606060606060606",
      "0707070707070707",
      "0808080808080808",
      "0909090909090909",
    ]);
    assert.deepStrictEqual(renderedHex[1], {
      records: 6,
      bytes: 48,
      firstUs: 1_000,
      lastUs: 6_000,
    });

    events.push({
      kind: "event",
      subscriptionId: lifecycleSubscriptionId,
      event: {
        kind: "state",
        from: "opening",
        to: "connected",
        reason: "diagnostic-pressure-did-not-stall-session",
        sequence: 20,
      },
    });
    assert.deepStrictEqual(
      await client.getSnapshot(),
      snapshot,
      "a blocked diagnostic renderer stalled the session RPC path",
    );
    await waitFor(() => lifecycle.length === 1, "lifecycle event was delayed or evicted");
    assert.equal(lifecycle[0].reason, "diagnostic-pressure-did-not-stall-session");
    assert.deepStrictEqual(lifecycleEvictions, []);

    releaseDiagnostic.resolve();
    await waitFor(() => diagnosticErrors.length === 1, "diagnostic listener error was not isolated");
    assert.match(diagnosticErrors[0].cause.message, /hex renderer failed/);

    // A record larger than the declared batch cannot be delivered whole. It
    // is counted as loss and reported in an empty batch instead of sitting at
    // the head forever and wedging every later diagnostic record.
    fanout.publish({
      sequence: 11,
      tUs: 11_000,
      direction: "rx",
      channelId: "main",
      bytes: new Uint8Array(33),
    });
    bridge.flush(diagnosticSubscriptionId);
    await waitFor(() => renderedHex.length === 4, "oversized diagnostic loss was not reported");
    assert.deepStrictEqual(renderedHex[2], []);
    assert.deepStrictEqual(renderedHex[3], {
      records: 7,
      bytes: 81,
      firstUs: 1_000,
      lastUs: 11_000,
    });
  } finally {
    releaseDiagnostic.resolve();
    lifecycleSubscription.dispose();
    diagnosticSubscription.dispose();
    bridge.close();
    await client.close();
    service.dispose();
  }
});

