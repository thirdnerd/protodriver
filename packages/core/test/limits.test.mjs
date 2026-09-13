import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { CaptureDestinationRegistry } from "../src/capture-rpc.ts";
import {
  DiagnosticRpcBridge,
  DiagnosticSubscriberLimitError,
  DiagnosticTapFanout,
} from "../src/diagnostics.ts";
import { HostResourceLimitError } from "../src/limits.ts";
import { OperationResultRetention } from "../src/lifecycle.ts";
import {
  DirectResourceRpcAdapter,
  ResourceBrokerError,
  ResourceBrokerHost,
  ResourceBrokerRpcClient,
} from "../src/resources.ts";
import {
  DirectSessionRpcAdapter,
  PostMessageSessionRpcAdapter,
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function ok(request, result = null) {
  return { kind: "ok", method: request.kind, callId: request.callId, result };
}

const rpcCorpus = [
  {
    kind: "disconnect",
    callId: "size-1",
    params: { reason: "operator μ-check" },
  },
  {
    kind: "start-operation",
    callId: "size-2",
    params: {
      request: {
        operation: "write",
        arguments: {
          flags: { kind: "value", value: ["alpha", "zulu"] },
          data: { kind: "value", value: { type: "bytes", encoding: "base64", value: "AAEC/w==" } },
        },
      },
    },
  },
  {
    kind: "resolve-candidates",
    callId: "size-3",
    params: {
      request: { grant: { grantId: "grant-1", matchedFilters: [0, 3, 7] } },
    },
  },
];

async function measureCorpus(kind) {
  const events = new EventQueue();
  const measured = [];
  const server = { events, handle: async (request) => ok(request) };
  const options = {
    onMessageMeasured(message, bytes) {
      if (message.kind !== "ok" && message.kind !== "error") measured.push(bytes);
    },
  };
  let adapter;
  let dispose = () => {};
  if (kind === "direct") {
    adapter = new DirectSessionRpcAdapter(server, options);
  } else {
    const { port1, port2 } = new MessageChannel();
    const service = serveSessionRpc(port2, server);
    adapter = new PostMessageSessionRpcAdapter(port1, options);
    dispose = () => service.dispose();
  }
  try {
    for (const request of rpcCorpus) await adapter.request(structuredClone(request));
    const nextEvent = adapter.events[Symbol.asyncIterator]().next();
    events.push({
      kind: "diagnostics",
      subscriptionId: "size-diagnostics",
      batch: {
        records: [{
          sequence: 1,
          tUs: 2,
          direction: "rx",
          channelId: "main",
          bytes: Uint8Array.of(0xa5, 0x5a, 0xd3),
        }],
        dropped: { records: 0, bytes: 0 },
      },
    });
    assert.equal((await nextEvent).value.kind, "diagnostics");
    return measured;
  } finally {
    await adapter.close();
    dispose();
  }
}

test("direct and postMessage enforce one canonical RPC size metric", async () => {
  const direct = await measureCorpus("direct");
  const postMessage = await measureCorpus("postMessage");
  assert.deepStrictEqual(direct, postMessage);
  assert.deepStrictEqual(direct, [95, 293, 192, 263]);
});

test("an oversized RPC call is refused without tearing down the session", async () => {
  const events = new EventQueue();
  const server = { events, handle: async (request) => ok(request) };
  const adapter = new DirectSessionRpcAdapter(server, { maximumMessageBytes: 180 });
  await assert.rejects(
    adapter.request({
      kind: "disconnect",
      callId: "large",
      params: { reason: "x".repeat(256) },
    }),
    (error) => error instanceof HostResourceLimitError
      && error.error.code === "rpc.message-too-large",
  );
  const rejectedEvent = adapter.events[Symbol.asyncIterator]().next();
  events.push({
    kind: "diagnostics",
    subscriptionId: "oversized-event",
    batch: {
      records: [{
        sequence: 1,
        tUs: 1,
        direction: "rx",
        channelId: "main",
        bytes: new Uint8Array(512),
      }],
      dropped: { records: 0, bytes: 0 },
    },
  });
  assert.deepStrictEqual(await rejectedEvent, {
    done: false,
    value: {
      kind: "subscriber-evicted",
      subscriptionId: "oversized-event",
      reason: {
        code: "rpc.message-too-large",
        message: "rpc exceeds maximumRpcMessageBytes: observed 771, maximum 180",
        retryability: "no",
        details: {
          limit: "maximumRpcMessageBytes",
          maximum: 180,
          observed: 771,
          scope: "rpc",
        },
      },
    },
  });
  assert.equal((await adapter.request(rpcCorpus[0])).kind, "ok");
  await adapter.close();
});

test("pending calls and per-client subscription reservations are independently bounded", async () => {
  const events = new EventQueue();
  const blocked = deferred();
  const blockedSubscription = deferred();
  let blockCalls = true;
  let blockSubscriptions = true;
  const server = {
    events,
    async handle(request) {
      if (blockCalls && request.kind === "disconnect") await blocked.promise;
      if (blockSubscriptions && request.kind === "subscribe") await blockedSubscription.promise;
      return ok(request);
    },
  };
  const pendingAdapter = new DirectSessionRpcAdapter(server, { maximumPendingCalls: 1 });
  const first = pendingAdapter.request({ kind: "disconnect", callId: "pending-1", params: {} });
  await assert.rejects(
    pendingAdapter.request({ kind: "disconnect", callId: "pending-2", params: {} }),
    (error) => error instanceof HostResourceLimitError
      && error.error.code === "rpc.pending-call-limit",
  );
  blocked.resolve();
  await first;
  blockCalls = false;
  assert.equal((await pendingAdapter.request({
    kind: "disconnect", callId: "pending-3", params: {},
  })).kind, "ok");
  await pendingAdapter.close();

  const subscriptionAdapter = new DirectSessionRpcAdapter(server, {
    maximumSubscriptionsPerClient: 1,
  });
  const firstSubscription = subscriptionAdapter.request({
    kind: "subscribe", callId: "sub-call-1", params: { subscriptionId: "sub-1" },
  });
  await assert.rejects(
    subscriptionAdapter.request({
      kind: "subscribe", callId: "sub-call-2", params: { subscriptionId: "sub-2" },
    }),
    (error) => error instanceof HostResourceLimitError
      && error.error.code === "rpc.subscription-limit",
  );
  blockSubscriptions = false;
  blockedSubscription.resolve();
  await firstSubscription;
  await assert.rejects(
    subscriptionAdapter.request({
      kind: "subscribe", callId: "sub-call-active", params: { subscriptionId: "sub-2" },
    }),
    (error) => error instanceof HostResourceLimitError
      && error.error.code === "rpc.subscription-limit",
  );
  await subscriptionAdapter.request({
    kind: "unsubscribe", callId: "unsub-call-1", params: { subscriptionId: "sub-1" },
  });
  assert.equal((await subscriptionAdapter.request({
    kind: "subscribe", callId: "sub-call-3", params: { subscriptionId: "sub-2" },
  })).kind, "ok");
  await subscriptionAdapter.close();
});

test("all seven cardinality allocators issue typed refusals", async () => {
  const codes = [];

  const events = new EventQueue();
  const never = new Promise(() => {});
  const pendingAdapter = new DirectSessionRpcAdapter(
    { events, handle: async () => never },
    { maximumPendingCalls: 1 },
  );
  const heldCall = pendingAdapter.request({ kind: "disconnect", callId: "p-1", params: {} });
  await assert.rejects(
    pendingAdapter.request({ kind: "disconnect", callId: "p-2", params: {} }),
    (error) => { codes.push(error.error.code); return error instanceof HostResourceLimitError; },
  );
  await pendingAdapter.close();
  await assert.rejects(heldCall, /closed/);

  const subAdapter = new DirectSessionRpcAdapter(
    { events: new EventQueue(), handle: async (request) => ok(request) },
    { maximumSubscriptionsPerClient: 0 },
  );
  await assert.rejects(
    subAdapter.request({ kind: "subscribe", callId: "s-1", params: { subscriptionId: "s" } }),
    (error) => { codes.push(error.error.code); return error instanceof HostResourceLimitError; },
  );
  await subAdapter.close();

  const diagnostic = new DiagnosticRpcBridge({
    clock: new VirtualClock(),
    fanout: new DiagnosticTapFanout(8),
    emit() {},
    maximumSubscribers: 0,
  });
  assert.throws(
    () => diagnostic.subscribe("diagnostic-1"),
    (error) => { codes.push(error.error.code); return error instanceof DiagnosticSubscriberLimitError; },
  );

  const operations = new OperationResultRetention(1, 1);
  operations.begin("operation-1");
  assert.throws(
    () => operations.begin("operation-2"),
    (error) => { codes.push(error.error.code); return error instanceof HostResourceLimitError; },
  );

  const resourceHost = new ResourceBrokerHost({ maximumOpenResources: 1 });
  const source = { byteLength: 0, async read() { return { bytesRead: 0, eof: true }; }, async close() {} };
  await resourceHost.registerSource(source, { kind: "host" });
  await assert.rejects(
    resourceHost.registerSource(source, { kind: "host" }),
    (error) => { codes.push(error.error.code); return error instanceof HostResourceLimitError; },
  );

  const callHost = new ResourceBrokerHost({ maximumOutstandingCalls: 1 });
  const started = deferred();
  const release = deferred();
  const blockedId = await callHost.registerSource({
    byteLength: 1,
    async read(into) { started.resolve(); await release.promise; into[0] = 1; return { bytesRead: 1, eof: true }; },
    async close() {},
  }, { kind: "host" });
  const otherId = await callHost.registerSource(source, { kind: "host" });
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(callHost));
  const firstRead = client.read(blockedId, 1, { callId: "broker-1" });
  await started.promise;
  await assert.rejects(
    client.read(otherId, 1, { callId: "broker-2" }),
    (error) => { codes.push(error.error.code); return error instanceof ResourceBrokerError; },
  );
  await client.cancel("broker-1");
  release.resolve();
  await assert.rejects(firstRead, (error) => error instanceof ResourceBrokerError
    && error.error.code === "resource.cancelled");
  await client.closeAdapter();

  const destination = { async openPart() { return "part-resource"; }, async commit() {}, async abort() {} };
  const captureRegistry = new CaptureDestinationRegistry(1);
  const destinationId = await captureRegistry.register(destination, "session-1");
  assert.equal((await captureRegistry.handle({
    kind: "open-part", destinationId, name: "session.pdcap",
  }, "session-1")).kind, "part-opened");
  const refusedPart = await captureRegistry.handle({
    kind: "open-part", destinationId, name: "payload.0.bin",
  }, "session-1");
  assert.equal(refusedPart.kind, "error");
  codes.push(refusedPart.error.code);

  assert.deepStrictEqual(codes, [
    "rpc.pending-call-limit",
    "rpc.subscription-limit",
    "diagnostic.subscriber-limit",
    "operation.concurrent-limit",
    "resource.open-limit",
    "resource.outstanding-call-limit",
    "capture.part-limit",
  ]);
});

test("resource chunk refusal is scoped to the call and leaves the resource usable", async () => {
  const host = new ResourceBrokerHost({ maximumChunkBytes: 4 });
  const id = await host.registerSource({
    byteLength: 1,
    async read(into) { into[0] = 0x5a; return { bytesRead: 1, eof: true }; },
    async close() {},
  }, { kind: "host" });
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
  await assert.rejects(
    client.read(id, 5, { callId: "chunk-large" }),
    (error) => error instanceof ResourceBrokerError
      && error.error.code === "resource.chunk-too-large",
  );
  const result = await client.read(id, 4, { callId: "chunk-small" });
  assert.deepStrictEqual(new Uint8Array(result.data), Uint8Array.of(0x5a));
  await client.closeAdapter();
});
