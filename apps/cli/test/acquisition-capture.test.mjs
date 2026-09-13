import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import test from "node:test";

import { loadCapture } from "../../../packages/core/src/capture.ts";
import {
  CaptureDestinationRegistry,
  serveCaptureDestinationRpc,
} from "../../../packages/core/src/capture-rpc.ts";
import {
  ResourceBrokerHost,
  serveResourceRpc,
} from "../../../packages/core/src/resources.ts";
import {
  DeviceSessionRpcClient,
  PostMessageSessionRpcAdapter,
} from "../../../packages/core/src/rpc.ts";
import { NodeCaptureDestination } from "../src/capture-destination.ts";

function recordingEndpoint(port, sent) {
  return {
    postMessage(message) {
      sent.push(structuredClone(message));
      port.postMessage(message);
    },
    addEventListener(type, listener) {
      port.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      port.removeEventListener(type, listener);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

test("capture-by-id writes worker session bytes to a main-thread destination", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "protodriver-capture-by-id-"));
  const sessionChannel = new MessageChannel();
  const captureChannel = new MessageChannel();
  const resourceChannel = new MessageChannel();
  const worker = new Worker(
    new URL("./fixtures/authored-capture-session-worker.mjs", import.meta.url),
    {
      workerData: {
        sessionPort: sessionChannel.port2,
        capturePort: captureChannel.port2,
        resourcePort: resourceChannel.port2,
      },
      transferList: [sessionChannel.port2, captureChannel.port2, resourceChannel.port2],
    },
  );
  const workerFailure = new Promise((_, reject) => worker.once("error", reject));
  const resources = new ResourceBrokerHost();
  const destinations = new CaptureDestinationRegistry();
  const captureService = serveCaptureDestinationRpc(
    captureChannel.port1,
    destinations,
    "capture-by-id-session",
  );
  const resourceService = serveResourceRpc(resourceChannel.port1, resources);
  const sessionMessages = [];
  const sessionAdapter = new PostMessageSessionRpcAdapter(
    recordingEndpoint(sessionChannel.port1, sessionMessages),
  );
  const client = new DeviceSessionRpcClient(sessionAdapter);
  let destinationId;

  try {
    await client.attach("capture-by-id-client");
    const destination = await NodeCaptureDestination.create({
      directory,
      registrar: resources,
      sessionId: "capture-by-id-session",
    });
    destinationId = await destinations.register(destination, "capture-by-id-session");
    assert.equal(destinations.size, 1);
    const foreignSession = await destinations.handle({
      kind: "open-part",
      destinationId,
      name: "foreign.pdcap",
    }, "another-session");
    assert.equal(foreignSession.kind, "error");
    assert.equal(foreignSession.error.code, "capture.destination-unknown");
    assert.deepStrictEqual(await readdir(directory), []);

    const captureId = await Promise.race([
      client.startCapture(destinationId, { sidecarThresholdBytes: 4_096 }),
      workerFailure,
    ]);
    await Promise.race([client.connect({ mode: "interactive" }), workerFailure]);
    const operation = await Promise.race([client.startOperation({ operation: "exchange", arguments: {} }), workerFailure]);
    const outcome = await Promise.race([client.awaitOperation(operation.operationId), workerFailure]);
    assert.equal(outcome.outcome, "completed", JSON.stringify(outcome));
    assert.equal(outcome.result, 256);
    await client.acknowledgeOperation(operation.operationId);
    const summary = await Promise.race([client.stopCapture(captureId), workerFailure]);
    assert.deepStrictEqual(
      {
        captureId: summary.captureId,
        completeness: summary.completeness,
        gapCount: summary.gapCount,
        partCount: summary.partCount,
      },
      {
        captureId,
        completeness: "complete",
        gapCount: 0,
        partCount: 1,
      },
    );

    const start = sessionMessages.find(({ kind }) => kind === "start-capture");
    assert.deepStrictEqual(start.params, {
      destinationId,
      options: { sidecarThresholdBytes: 4_096 },
    });
    assert.equal("destination" in start.params, false);
    assert.equal(Object.values(start.params).some((value) => typeof value === "function"), false);

    assert.deepStrictEqual(
      (await readdir(directory)).sort(),
      ["session.pdcap"],
    );
    const capturePath = join(directory, "session.pdcap");
    const loaded = await loadCapture(createReadStream(capturePath));
    assert.equal(loaded.completeness, "complete");
    const byteRecords = loaded.records.filter(
      ({ kind }) => kind === "tx-requested" || kind === "rx-delivered",
    );
    assert.equal(byteRecords.length, 2);
    for (const [record, byte, length] of [
      [byteRecords[0], 0xa5, 256],
      [byteRecords[1], 0x5a, 256],
    ]) {
      assert.equal(record.blob, undefined);
      const resolved = Buffer.from(record.data, "base64");
      assert.equal(resolved.byteLength, length);
      assert.ok(resolved.every((value) => value === byte));
    }

    await destinations.release(destinationId);
    assert.equal(destinations.size, 0);
    assert.deepStrictEqual(await resources.outstanding(), []);
  } finally {
    if (destinationId !== undefined) await destinations.release(destinationId);
    await client.close();
    captureService.dispose();
    resourceService.dispose();
    await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});
