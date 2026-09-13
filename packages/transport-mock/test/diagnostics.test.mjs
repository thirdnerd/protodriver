import assert from "node:assert/strict";
import test from "node:test";

import { CaptureWriter, loadCapture } from "../../core/src/capture.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../src/index.ts";

class MemorySink {
  chunks = [];

  async write(data) {
    this.chunks.push(Uint8Array.from(data));
  }

  async close() {}

  async *source() {
    for (const chunk of this.chunks) yield chunk;
  }
}

test("diagnostic pressure loses only copied observations, never ingress or capture", async () => {
  const clock = new VirtualClock(1_700_000_000_000);
  const connection = new MockTransport(clock).openConnection({
    identity: { transport: "mock", stableKeyAssurance: "none" },
    modeId: "normal",
    profileId: "diagnostic-pressure",
    maximumBufferedBytesPerChannel: 1_024,
    maximumDiagnosticBytesPerTap: 32,
  });
  const channel = connection.channel("main");
  const lease = await channel.acquire("protocol");
  const authoritative = lease.incoming()[Symbol.asyncIterator]();
  const tap = channel.observe();
  const diagnostic = tap.records[Symbol.asyncIterator]();
  const sink = new MemorySink();
  const recorder = await CaptureWriter.create({
    sink,
    clock,
    captureId: "diagnostic-pressure-capture",
    logicalDevice: "test.diagnostic-pressure",
    host: { platform: "node" },
    maximumBufferedBytes: 4_096,
  });
  recorder.record({
    kind: "connection-open",
    conn: 1,
    profileId: connection.profileId,
    modeId: connection.modeId,
    identity: connection.identity,
    channels: connection.channels.map(({ id, direction }) => ({ id, direction })),
  });

  const expected = [];
  for (let index = 0; index < 10; index += 1) {
    await clock.advance(1_000);
    const bytes = Uint8Array.from({ length: 8 }, () => index);
    expected.push(...bytes);
    assert.deepStrictEqual(channel.enqueueReceived(bytes), {
      kind: "accepted",
      acceptedBytes: 8,
    });
    recorder.recordBytes({ kind: "rx-delivered", conn: 1, ch: "main" }, bytes);
  }

  const received = [];
  for (let index = 0; index < 10; index += 1) {
    const delivery = await authoritative.next();
    assert.equal(delivery.done, false);
    received.push(...delivery.value.bytes);
  }
  assert.deepStrictEqual(received, expected);
  assert.deepStrictEqual(channel.ingressMetrics, {
    retainedBytes: 0,
    highWaterBytes: 80,
    acceptedBytes: 80,
    deliveredBytes: 80,
    rejectedBytes: 0,
  });

  assert.deepStrictEqual(tap.dropped, {
    records: 6,
    bytes: 48,
    firstUs: 1_000,
    lastUs: 6_000,
  });
  const observed = [];
  for (let index = 0; index < 4; index += 1) {
    const record = await diagnostic.next();
    assert.equal(record.done, false);
    observed.push(...record.value.bytes);
  }
  assert.deepStrictEqual(observed, expected.slice(48));

  const summary = await recorder.close();
  const loaded = await loadCapture(sink.source());
  const captured = loaded.records
    .filter(({ kind }) => kind === "rx-delivered")
    .flatMap(({ data }) => [...Buffer.from(data, "base64")]);
  assert.equal(summary.completeness, "complete");
  assert.equal(summary.gapCount, 0);
  assert.equal(loaded.replayability, "byte-exact-replayable");
  assert.deepStrictEqual(captured, expected);

  // A tap is deliberately incapable of producing a fixture. It exposes no
  // capture identity, framing, completeness, record method, or footer.
  assert.equal("captureId" in tap, false);
  assert.equal("completeness" in tap, false);
  assert.equal("recordBytes" in tap, false);

  tap.close();
  await lease.release();
});
