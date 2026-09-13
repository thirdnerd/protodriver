import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VirtualClock } from "../../../test-support/clock.ts";
import { ReceiveTerminatedError } from "../../core/src/ingress.ts";
import { MockTransport } from "../src/index.ts";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/phase-0-receive-streams.json", import.meta.url),
  "utf8",
));

const identity = {
  transport: "mock",
  stableKeyAssurance: "none",
};

function concatenate(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function deliver(parts, totalBytes) {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({
    identity,
    modeId: "normal",
    profileId: "fixture",
    maximumBufferedBytesPerChannel: totalBytes + 1,
  });
  const channel = connection.channel("main");
  const lease = await channel.acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const delivered = [];

  for (const part of parts) {
    assert.deepEqual(channel.enqueueReceived(part), {
      kind: "accepted",
      acceptedBytes: part.byteLength,
    });
    const next = await incoming.next();
    assert.equal(next.done, false);
    delivered.push(next.value.bytes);
  }
  return concatenate(delivered);
}

test("slow consumer reaches the hard limit, then terminates without losing accepted bytes", async () => {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({
    identity,
    modeId: "normal",
    profileId: "slow-consumer",
    maximumBufferedBytesPerChannel: 16,
  });
  const channel = connection.channel("main");
  const lease = await channel.acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();
  const accepted = [
    Uint8Array.of(0, 1, 2, 3),
    Uint8Array.of(4, 5, 6, 7),
    Uint8Array.of(8, 9, 10, 11),
    Uint8Array.of(12, 13, 14, 15),
  ];

  for (let index = 0; index < accepted.length; index += 1) {
    assert.deepEqual(channel.enqueueReceived(accepted[index]), {
      kind: "accepted",
      acceptedBytes: 4,
    });
    assert.equal(channel.ingressMetrics.retainedBytes, (index + 1) * 4);
    assert.ok(channel.ingressMetrics.retainedBytes <= 16);
    assert.ok(channel.ingressMetrics.highWaterBytes <= 16);
  }

  assert.deepEqual(channel.enqueueReceived(Uint8Array.of(16, 17, 18, 19)), {
    kind: "overflow",
    rejectedBytes: 4,
  });
  const termination = {
    kind: "receive-overflow",
    limitBytes: 16,
    channel: "main",
  };
  assert.deepEqual(await connection.terminated, termination);
  assert.equal(channel.valid, false);
  assert.deepEqual(channel.ingressMetrics, {
    retainedBytes: 16,
    highWaterBytes: 16,
    acceptedBytes: 16,
    deliveredBytes: 0,
    rejectedBytes: 4,
  });

  const delivered = [];
  for (let index = 0; index < accepted.length; index += 1) {
    const next = await incoming.next();
    assert.equal(next.done, false);
    delivered.push(next.value.bytes);
  }
  assert.deepEqual(concatenate(delivered), concatenate(accepted));
  await assert.rejects(
    incoming.next(),
    (error) => {
      assert.ok(error instanceof ReceiveTerminatedError);
      assert.deepEqual(error.termination, termination);
      return true;
    },
  );
  assert.deepEqual(channel.ingressMetrics, {
    retainedBytes: 0,
    highWaterBytes: 16,
    acceptedBytes: 16,
    deliveredBytes: 16,
    rejectedBytes: 4,
  });
});

test("an oversized first delivery is rejected before any path-owned copy is retained", async () => {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({
    identity,
    modeId: "normal",
    profileId: "oversized-delivery",
    maximumBufferedBytesPerChannel: 16,
  });
  const channel = connection.channel("main");
  const lease = await channel.acquire("protocol");
  const incoming = lease.incoming()[Symbol.asyncIterator]();

  assert.deepEqual(channel.enqueueReceived(new Uint8Array(17)), {
    kind: "overflow",
    rejectedBytes: 17,
  });
  assert.deepEqual(channel.ingressMetrics, {
    retainedBytes: 0,
    highWaterBytes: 0,
    acceptedBytes: 0,
    deliveredBytes: 0,
    rejectedBytes: 17,
  });
  await assert.rejects(incoming.next(), ReceiveTerminatedError);
});

