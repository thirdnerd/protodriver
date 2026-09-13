import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import {
  DirectResourceRpcAdapter,
  PartialResourceWriteError,
  PostMessageResourceRpcAdapter,
  ResourceBrokerError,
  ResourceBrokerHost,
  ResourceBrokerRpcClient,
  serveResourceRpc,
} from "../src/resources.ts";

const MIB = 1024 * 1024;
const SOURCE_BYTES = 16 * MIB;
const CHUNK_BYTES = 64 * 1024;

class PatternSource {
  byteLength = SOURCE_BYTES;
  offset = 0;
  closeCount = 0;

  async read(into) {
    const bytesRead = Math.min(into.byteLength, this.byteLength - this.offset);
    for (let index = 0; index < bytesRead; index += 1) {
      into[index] = ((this.offset + index) * 29 + 17) & 0xff;
    }
    this.offset += bytesRead;
    return { bytesRead, eof: this.offset === this.byteLength };
  }

  async seek(offset) {
    this.offset = offset;
  }

  async close() {
    this.closeCount += 1;
  }
}

async function makeHarness(kind, host = new ResourceBrokerHost()) {
  if (kind === "direct") {
    const adapter = new DirectResourceRpcAdapter(host);
    return {
      host,
      adapter,
      async close() {
        await adapter.close();
      },
    };
  }
  const { port1, port2 } = new MessageChannel();
  const service = serveResourceRpc(port2, host);
  const adapter = new PostMessageResourceRpcAdapter(port1);
  return {
    host,
    adapter,
    async close() {
      await adapter.close();
      service.dispose();
    },
  };
}

function call(index, signal) {
  return {
    callId: `resource-test-${index}`,
    ...(signal === undefined ? {} : { signal }),
  };
}

function expectedPatternDigest() {
  const hash = createHash("sha256");
  const chunk = new Uint8Array(CHUNK_BYTES);
  for (let offset = 0; offset < SOURCE_BYTES; offset += chunk.byteLength) {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      chunk[index] = ((offset + index) * 29 + 17) & 0xff;
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function streamSixteenMiB(kind) {
  const harness = await makeHarness(kind);
  const source = new PatternSource();
  const id = await harness.host.registerSource(source, { kind: "host" });
  const client = new ResourceBrokerRpcClient(harness.adapter);
  try {
    assert.deepStrictEqual(await client.describe(id), {
      byteLength: SOURCE_BYTES,
      seekable: true,
    });
    const hash = createHash("sha256");
    let received = 0;
    let previousProgress = -1;
    let callIndex = 1;
    while (true) {
      const result = await client.read(id, CHUNK_BYTES, call(callIndex++));
      const bytes = new Uint8Array(result.data);
      hash.update(bytes);
      received += bytes.byteLength;
      assert.ok(received > previousProgress, "stream progress must be strictly monotonic");
      previousProgress = received;
      if (result.eof) break;
    }
    assert.equal(received, SOURCE_BYTES);
    assert.equal(hash.digest("hex"), expectedPatternDigest());
    assert.equal(harness.host.metrics.currentReadBufferBytes, 0);
    assert.equal(harness.host.metrics.highWaterReadBufferBytes, CHUNK_BYTES);
    assert.deepStrictEqual(await harness.host.outstanding(), [id]);
    await client.close(id);
  } finally {
    await client.closeAdapter();
    await harness.close();
  }
}

for (const kind of ["direct", "postMessage"]) {
  test(`a 16 MiB source streams with bounded workspace through the Node ${kind} path`, async () => {
    await streamSixteenMiB(kind);
  });
}

test("short reads preserve the host source's explicit eof instead of inferring it", async () => {
  const host = new ResourceBrokerHost();
  const steps = [
    { bytes: [], eof: false },
    { bytes: [0x41, 0x42], eof: false },
    { bytes: [0x43], eof: true },
  ];
  const id = await host.registerSource({
    byteLength: undefined,
    async read(into) {
      const step = steps.shift();
      assert.notEqual(step, undefined);
      into.set(step.bytes);
      return { bytesRead: step.bytes.length, eof: step.eof };
    },
    async close() {},
  }, { kind: "host" });
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
  assert.deepStrictEqual(await client.read(id, 8, call(1)), { data: new ArrayBuffer(0), eof: false });
  assert.deepStrictEqual(new Uint8Array((await client.read(id, 8, call(2))).data), new Uint8Array([0x41, 0x42]));
  const final = await client.read(id, 8, call(3));
  assert.deepStrictEqual(new Uint8Array(final.data), new Uint8Array([0x43]));
  assert.equal(final.eof, true);
  await client.closeAdapter();
});

test("one resource refuses a second call while preserving the first", async () => {
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const host = new ResourceBrokerHost();
  const id = await host.registerSource({
    byteLength: 1,
    async read(into) {
      startedResolve();
      await blocked;
      into[0] = 0x5a;
      return { bytesRead: 1, eof: true };
    },
    async close() {},
  }, { kind: "host" });
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
  const first = client.read(id, 1, call(1));
  await started;
  await assert.rejects(
    client.read(id, 1, call(2)),
    (error) => error instanceof ResourceBrokerError
      && error.error.code === "resource.call-in-flight",
  );
  release();
  assert.deepStrictEqual(new Uint8Array((await first).data), new Uint8Array([0x5a]));
  await client.closeAdapter();
});

test("cancel before completion rejects at a chunk boundary with an exact receipt", async () => {
  let release;
  let startedResolve;
  let cancelResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const cancelSent = new Promise((resolve) => { cancelResolve = resolve; });
  const host = new ResourceBrokerHost();
  const source = new PatternSource();
  const cancelAt = 5 * MIB;
  const originalRead = source.read.bind(source);
  source.read = async (into) => {
    if (source.offset === cancelAt) {
      startedResolve();
      await blocked;
    }
    return originalRead(into);
  };
  const id = await host.registerSource(source, { kind: "host" });
  const base = new DirectResourceRpcAdapter(host);
  const observed = {
    async request(request) {
      const response = await base.request(request);
      if (request.kind === "cancel") cancelResolve(request);
      return response;
    },
    close: () => base.close(),
  };
  const client = new ResourceBrokerRpcClient(observed);
  let received = 0;
  let callIndex = 1;
  while (received < cancelAt) {
    const result = await client.read(id, CHUNK_BYTES, call(callIndex++));
    assert.equal(result.eof, false);
    received += result.data.byteLength;
  }
  assert.equal(received, cancelAt);

  const controller = new AbortController();
  const cancelledCallId = `resource-test-${callIndex}`;
  const pending = client.read(id, CHUNK_BYTES, call(callIndex++, controller.signal));
  await started;
  controller.abort();
  const cancelRequest = await cancelSent;
  assert.equal(cancelRequest.targetCallId, cancelledCallId);
  assert.equal("signal" in cancelRequest.call, false, "AbortSignal crossed into the adapter");
  release();
  await assert.rejects(
    pending,
    (error) => error instanceof ResourceBrokerError
      && error.error.code === "resource.cancelled",
  );
  assert.equal(received, cancelAt, "only delivered whole chunks belong to the partial receipt");
  assert.equal(host.metrics.currentReadBufferBytes, CHUNK_BYTES);
  assert.ok(host.metrics.highWaterReadBufferBytes <= CHUNK_BYTES);

  // The host read completed after cancellation, so the broker retains that
  // one bounded chunk rather than losing it from the logical source.
  const resumed = new Uint8Array((await client.read(id, CHUNK_BYTES, call(callIndex++))).data);
  for (let index = 0; index < resumed.byteLength; index += 1) {
    assert.equal(resumed[index], ((cancelAt + index) * 29 + 17) & 0xff);
  }
  assert.equal(host.metrics.currentReadBufferBytes, 0);
  await client.closeAdapter();
});

test("a result committed before cancel still reaches the caller", async () => {
  let settledResolve;
  let deliver;
  const settled = new Promise((resolve) => { settledResolve = resolve; });
  const deliveryGate = new Promise((resolve) => { deliver = resolve; });
  const host = new ResourceBrokerHost();
  const id = await host.registerSource({
    byteLength: 1,
    async read(into) {
      into[0] = 0xa5;
      return { bytesRead: 1, eof: true };
    },
    async close() {},
  }, { kind: "host" });
  const adapter = {
    async request(request) {
      const response = await host.handle(request);
      if (request.kind === "read") {
        settledResolve();
        await deliveryGate;
      }
      return response;
    },
    async close() {},
  };
  const client = new ResourceBrokerRpcClient(adapter);
  const pending = client.read(id, 1, call(1));
  await settled;
  await client.cancel("resource-test-1");
  deliver();
  const result = await pending;
  assert.deepStrictEqual(new Uint8Array(result.data), new Uint8Array([0xa5]));
  assert.equal(result.eof, true);
});

test("a partial sink write is a typed failure and close is idempotent", async () => {
  const host = new ResourceBrokerHost();
  let closeCount = 0;
  const accepted = [];
  const id = await host.registerSink({
    async write(data) {
      accepted.push(...data.subarray(0, 2));
      throw new PartialResourceWriteError(2, data.byteLength);
    },
    async close() {
      closeCount += 1;
    },
  }, { kind: "host" });
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
  await assert.rejects(
    client.write(id, new Uint8Array([1, 2, 3, 4]).buffer, call(1)),
    (error) => error instanceof ResourceBrokerError
      && error.error.code === "resource.partial-write"
      && error.error.details.knownAcceptedBytes === 2,
  );
  assert.deepStrictEqual(accepted, [1, 2]);
  await client.close(id);
  await client.close(id);
  assert.equal(closeCount, 1);
  await client.closeAdapter();
});

test("scope cleanup orders operation before session, reports host, and never reuses ids", async () => {
  const host = new ResourceBrokerHost();
  const sessionId = "session-a";
  const operationId = "operation-a";
  const closed = [];
  const source = (name) => ({
    byteLength: 0,
    async read() { return { bytesRead: 0, eof: true }; },
    async close() { closed.push(name); },
  });
  const operation = await host.registerSource(source("operation"), {
    kind: "operation",
    sessionId,
    operationId,
  });
  await host.registerSource(source("session"), { kind: "session", sessionId });
  const hostId = await host.registerSource(source("host"), { kind: "host" });

  const report = await host.endSession(sessionId);
  assert.deepStrictEqual(closed, ["operation", "session"]);
  assert.deepStrictEqual(report.outstandingHostResources, [hostId]);
  assert.deepStrictEqual((await host.shutdown()).outstandingHostResources, [hostId]);
  assert.deepStrictEqual(closed, ["operation", "session"], "shutdown silently closed a host resource");

  const replacement = await host.registerSource(source("replacement"), { kind: "host" });
  assert.notEqual(replacement, operation);
  const client = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));
  await assert.rejects(
    client.read(operation, 1, call(1)),
    (error) => error instanceof ResourceBrokerError
      && error.error.code === "resource.unknown-id",
  );
  await client.closeAdapter();
});
