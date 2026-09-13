import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import {
  DeviceSessionRpcClient,
  DirectSessionRpcAdapter,
  PostMessageSessionRpcAdapter,
  SessionRpcError,
  SessionWorkerLostError,
  serveSessionRpc,
} from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";

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

const snapshot = {
  takenAtSequence: 41,
  state: "connected",
  currentMode: "application",
  connection: {
    modeId: "application",
    profileId: "serial",
    displayName: "Conformance device",
  },
  stateCells: {},
  activeOperations: [],
  retainedResults: [],
  maintenanceStatus: "active",
};

function containsLiveControl(value, seen = new Set()) {
  if (typeof value === "function" || value instanceof AbortSignal) return true;
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  for (const entry of Object.values(value)) {
    if (containsLiveControl(entry, seen)) return true;
  }
  return false;
}

function makeServer() {
  const events = new EventQueue();
  const requests = [];
  return {
    events,
    requests,
    async handle(request) {
      requests.push(request);
      assert.equal(
        containsLiveControl(request),
        false,
        "an adapter received a listener function or AbortSignal",
      );
      if (request.kind === "get-snapshot") {
        return {
          kind: "ok",
          method: request.kind,
          callId: request.callId,
          result: snapshot,
        };
      }
      if (request.kind === "subscribe") {
        events.push({
          kind: "event",
          subscriptionId: request.params.subscriptionId,
          event: {
            kind: "state",
            from: "opening",
            to: "connected",
            reason: "conformance",
            sequence: 41,
          },
        });
        return { kind: "ok", method: request.kind, callId: request.callId, result: null };
      }
      if (request.kind === "unsubscribe") {
        return { kind: "ok", method: request.kind, callId: request.callId, result: null };
      }
      if (request.kind === "disconnect") {
        return {
          kind: "error",
          method: request.kind,
          callId: request.callId,
          error: {
            code: "conformance.refused",
            message: "deliberate conformance error",
            retryability: "no",
          },
        };
      }
      throw new Error(`conformance server does not handle ${request.kind}`);
    },
  };
}

async function directHarness() {
  const server = makeServer();
  const adapter = new DirectSessionRpcAdapter(server);
  return {
    server,
    adapter,
    async close() {
      await adapter.close();
    },
  };
}

async function postMessageHarness() {
  const server = makeServer();
  const { port1, port2 } = new MessageChannel();
  const service = serveSessionRpc(port2, server);
  const adapter = new PostMessageSessionRpcAdapter(port1);
  return {
    server,
    adapter,
    async close() {
      await adapter.close();
      service.dispose();
    },
  };
}

async function waitForRequest(server, kind) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const request = server.requests.find((candidate) => candidate.kind === kind);
    if (request !== undefined) return request;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`server did not receive ${kind}`);
}

async function adapterConformance(createHarness) {
  const harness = await createHarness();
  const client = new DeviceSessionRpcClient(harness.adapter);
  try {
    assert.deepStrictEqual(await client.getSnapshot(), snapshot);

    const controller = new AbortController();
    let subscription;
    const received = new Promise((resolve) => {
      const listener = (event) => resolve(event);
      // This deliberately makes the retained local object carry both kinds
      // of value forbidden on the wire. If the facade forwards the listener
      // instead of translating it to an id, the direct server sees it and a
      // real MessagePort either refuses or strips it.
      listener.signal = controller.signal;
      subscription = client.subscribe(listener, { replayLast: 1 });
    });
    try {
      assert.deepStrictEqual(await received, {
        kind: "state",
        from: "opening",
        to: "connected",
        reason: "conformance",
        sequence: 41,
      });
    } finally {
      subscription.dispose();
    }
    const subscribe = await waitForRequest(harness.server, "subscribe");
    assert.deepStrictEqual(Object.keys(subscribe.params).sort(), ["options", "subscriptionId"]);

    const clock = new VirtualClock();
    let blockedStartedResolve;
    const blockedStarted = new Promise((resolve) => { blockedStartedResolve = resolve; });
    const blockedSubscription = client.subscribe(async () => {
      blockedStartedResolve();
      await clock.sleep(10_000);
    });
    try {
      await blockedStarted;
      assert.deepStrictEqual(
        await client.getSnapshot(),
        snapshot,
        "a listener blocked for ten virtual seconds delayed the session",
      );
      clock.advance(10_000_000);
    } finally {
      blockedSubscription.dispose();
    }

    await assert.rejects(
      client.disconnect("fail"),
      (error) => error instanceof SessionRpcError
        && error.error.code === "conformance.refused",
    );
  } finally {
    await client.close();
    await harness.close();
  }
}

for (const [name, createHarness] of [
  ["direct", directHarness],
  ["postMessage", postMessageHarness],
]) {
  test(`${name} adapter passes the shared session RPC conformance suite`, async () => {
    await adapterConformance(createHarness);
  });
}

test("postMessage adapter round-trips durable-transfer and raw-terminal RPC", async () => {
  const events = new EventQueue();
  const requests = [];
  const operationHandle = { operationId: "resume-operation-1", acceptedAtSequence: 73 };
  const terminalHandle = {
    terminalId: "raw-terminal-1",
    exitRequirement: {
      kind: "declared-recovery",
      strategy: "reconnect",
      message: "Reconnect before returning to protocol work.",
    },
  };
  const writeReceipt = {
    outcome: { kind: "accepted-by-platform" },
    requestedBytes: 3,
    atSequence: 75,
    taintsSession: false,
  };
  const exitResult = {
    kind: "recovered",
    recovery: {
      kind: "recovered",
      strategy: "reconnect",
      connectionReplaced: true,
      discardedBytes: 0,
    },
  };
  const server = {
    events,
    requests,
    async handle(request) {
      requests.push(request);
      switch (request.kind) {
        case "inspect-checkpoint":
          assert.equal(request.params.checkpointId, "checkpoint-1");
          return {
            kind: "ok",
            method: request.kind,
            callId: request.callId,
            result: { assurance: "unverified" },
          };
        case "resume-transfer":
          assert.deepStrictEqual(request.params.request, {
            checkpointId: "checkpoint-1",
            operation: "write-image",
            arguments: { source: { kind: "resource", id: "resource-1" } },
          });
          return {
            kind: "ok",
            method: request.kind,
            callId: request.callId,
            result: { ...operationHandle, assurance: "unverified" },
          };
        case "open-raw-terminal":
          assert.deepStrictEqual(request.params, { subscriptionId: "terminal-subscription" });
          return { kind: "ok", method: request.kind, callId: request.callId, result: terminalHandle };
        case "write-raw-terminal":
          assert.equal(request.params.terminalId, terminalHandle.terminalId);
          assert.deepStrictEqual(request.params.bytes, new Uint8Array([0x10, 0x20, 0x30]));
          return { kind: "ok", method: request.kind, callId: request.callId, result: writeReceipt };
        case "exit-raw-terminal":
          assert.equal(request.params.terminalId, terminalHandle.terminalId);
          return { kind: "ok", method: request.kind, callId: request.callId, result: exitResult };
        case "subscribe":
        case "unsubscribe":
          return { kind: "ok", method: request.kind, callId: request.callId, result: null };
        default:
          throw new Error(`session-contract round-trip server does not handle ${request.kind}`);
      }
    },
  };
  const { port1, port2 } = new MessageChannel();
  const service = serveSessionRpc(port2, server);
  const adapter = new PostMessageSessionRpcAdapter(port1);
  const client = new DeviceSessionRpcClient(adapter);

  try {
    assert.deepStrictEqual(
      await client.inspectTransferCheckpoint("checkpoint-1"),
      { assurance: "unverified" },
    );
    assert.deepStrictEqual(await client.resumeTransfer({
      checkpointId: "checkpoint-1",
      operation: "write-image",
      arguments: { source: { kind: "resource", id: "resource-1" } },
    }), { ...operationHandle, assurance: "unverified" });
    assert.deepStrictEqual(await client.openRawTerminal("terminal-subscription"), terminalHandle);
    assert.deepStrictEqual(
      await client.writeRawTerminal(terminalHandle.terminalId, new Uint8Array([0x10, 0x20, 0x30])),
      writeReceipt,
    );
    assert.deepStrictEqual(await client.exitRawTerminal(terminalHandle.terminalId), exitResult);

    const received = [];
    const subscription = client.subscribe((event) => {
      received.push(event);
    });
    try {
      const subscribe = await waitForRequest(server, "subscribe");
      events.push({
        kind: "event",
        subscriptionId: subscribe.params.subscriptionId,
        event: {
          kind: "raw-terminal-bytes",
          terminalId: terminalHandle.terminalId,
          bytes: new Uint8Array([0xa5, 0x5a]),
          sequence: 76,
          tUs: 123456,
        },
      });
      events.push({
        kind: "event",
        subscriptionId: subscribe.params.subscriptionId,
        event: {
          kind: "mode-maintenance",
          modeId: "application",
          operation: "maintain",
          status: "released-idle",
          sequence: 77,
        },
      });
      events.push({
        kind: "event",
        subscriptionId: subscribe.params.subscriptionId,
        event: {
          kind: "transfer-progress",
          operationId: operationHandle.operationId,
          checkpointId: "checkpoint-1",
          phase: "transferring",
          sequence: 78,
        },
      });
      for (let attempt = 0; attempt < 20 && received.length < 3; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(received.length, 3, "new session events did not cross postMessage");
    } finally {
      subscription.dispose();
    }
    assert.deepStrictEqual(received.map(({ kind }) => kind), [
      "raw-terminal-bytes",
      "mode-maintenance",
      "transfer-progress",
    ]);
    assert.deepStrictEqual(received[0].bytes, new Uint8Array([0xa5, 0x5a]));
    assert.deepStrictEqual(requests.map(({ kind }) => kind).slice(0, 5), [
      "inspect-checkpoint",
      "resume-transfer",
      "open-raw-terminal",
      "write-raw-terminal",
      "exit-raw-terminal",
    ]);
  } finally {
    await client.close();
    service.dispose();
  }
});

async function workerLossHarness(kind) {
  const events = new EventQueue();
  let startedCount = 0;
  let bothStartedResolve;
  const bothStarted = new Promise((resolve) => { bothStartedResolve = resolve; });
  const never = new Promise(() => {});
  const server = {
    events,
    async handle() {
      startedCount += 1;
      if (startedCount === 2) bothStartedResolve();
      return never;
    },
  };
  if (kind === "direct") {
    const adapter = new DirectSessionRpcAdapter(server);
    return { adapter, bothStarted, dispose() {} };
  }
  const { port1, port2 } = new MessageChannel();
  const service = serveSessionRpc(port2, server);
  const adapter = new PostMessageSessionRpcAdapter(port1);
  return { adapter, bothStarted, dispose: () => service.dispose() };
}

for (const kind of ["postMessage"]) {
  test(`${kind} adapter rejects every outstanding handle when its worker dies`, async () => {
    const harness = await workerLossHarness(kind);
    const client = new DeviceSessionRpcClient(harness.adapter);
    const pending = [client.getSnapshot(), client.getSnapshot()];
    await harness.bothStarted;
    const platformCause = new Error("simulated worker exit");
    harness.adapter.workerLost(platformCause);
    for (const handle of pending) {
      await assert.rejects(
        handle,
        (error) => error instanceof SessionWorkerLostError
          && error.error.code === "session.worker-lost"
          && error.error.platformCause.message === platformCause.message,
      );
    }
    await assert.rejects(
      client.getSnapshot(),
      (error) => error instanceof SessionWorkerLostError
        && error.error.code === "session.worker-lost",
    );
    await client.close();
    harness.dispose();
  });
}
