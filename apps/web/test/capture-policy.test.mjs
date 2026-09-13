import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DEFAULT_CAPTURE_CAPACITY_POLICY, DEFAULT_HOST_RESOURCE_LIMITS } from "@protodriver/contracts/limits";
import { CapturePartNameError, loadCapture } from "@protodriver/core/capture";
import {
  CaptureDestinationRegistry,
  DirectCaptureDestinationRpcAdapter,
} from "@protodriver/core/capture-rpc";
import { DirectResourceRpcAdapter, ResourceBrokerHost, ResourceBrokerRpcClient } from "@protodriver/core/resources";
import {
  BrowserMemoryCaptureDestination,
  BROWSER_CAPTURE_MEMORY_POLICY,
  CAPTURE_MEASURED_COMPLETE_BYTES,
  CAPTURE_MEASURED_SOURCE_CUT_BYTES,
  CAPTURE_SUPPORTED_PAYLOAD_BYTES,
  DEFAULT_BROWSER_CAPTURE_LIMITS,
  DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES,
  browserCaptureMemoryPolicy,
  browserCaptureSidecarThresholdBytes,
  requireBrowserCaptureCapacity,
  requiredBrowserCaptureBytes,
} from "../src/session-worker-client.ts";

test("browser capture queue and retained bytes share one host envelope", async () => {
  assert.equal(CAPTURE_SUPPORTED_PAYLOAD_BYTES, 1_048_576);
  assert.equal(CAPTURE_MEASURED_SOURCE_CUT_BYTES, 9_472_207);
  assert.equal(CAPTURE_MEASURED_COMPLETE_BYTES, 64_737_185);
  assert.equal(DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes, 4_194_304);
  assert.equal(DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES, 4_194_304);
  assert.equal(DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes, 75_405_208);
  assert.equal(
    BROWSER_CAPTURE_MEMORY_POLICY.maximumQueueBytes,
    DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureQueueBytes,
  );
  assert.equal(
    BROWSER_CAPTURE_MEMORY_POLICY.maximumQueueBytes
      + BROWSER_CAPTURE_MEMORY_POLICY.maximumRetainedBytes,
    DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
  );

  const selected = {
    maximumCaptureQueueBytes: 4,
    maximumCaptureInMemoryBytes: 12,
  };
  const policy = browserCaptureMemoryPolicy(selected);
  assert.deepEqual(policy, {
    maximumQueueBytes: 4,
    maximumRetainedBytes: 8,
    maximumAggregateBytes: 12,
  });
  assert.equal(browserCaptureSidecarThresholdBytes(selected), 4);
  assert.equal(browserCaptureSidecarThresholdBytes({ maximumCaptureQueueBytes: 8_388_608, maximumCaptureInMemoryBytes: 9_000_000 }), 4_194_304);
  const resources = new ResourceBrokerHost();
  const destination = new BrowserMemoryCaptureDestination(resources, "capture-policy-session", selected);
  const id = await destination.openPart("session.pdcap");
  const sidecar = await destination.openPart("part-000001.bin");
  const broker = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(resources));
  await broker.write(id, new Uint8Array(6).buffer, { callId: "capture-write-1" });
  await broker.write(sidecar, new Uint8Array(2).buffer, { callId: "capture-write-2" });
  await assert.rejects(
    () => broker.write(sidecar, Uint8Array.of(1).buffer, { callId: "capture-write-3" }),
    /maximumCaptureInMemoryBytes.*maximumCaptureQueueBytes/,
  );
});

test("browser capture setting names its queue rather than claiming a per-record maximum", async () => {
  const page = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  // The wording is free to change; what must hold is that the control is
  // labelled as the queue and never promises a per-record maximum.
  assert.match(page, /<label>[^<]*queue[^<]*\(bytes\)\s*<input id="capture-queue-bytes"/iu);
  assert.doesNotMatch(page, /Largest single record|per-record maximum/iu);
});

test("known authored source sizes are refused before an undersized capture starts device work", () => {
  const limits = {
    maximumCaptureQueueBytes: DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureQueueBytes,
    maximumCaptureInMemoryBytes: DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
  };
  assert.equal(requiredBrowserCaptureBytes(1_048_576), 64_737_185);
  assert.doesNotThrow(() => requireBrowserCaptureCapacity(1_048_576, limits));
  assert.doesNotThrow(() => requireBrowserCaptureCapacity(1_153_433, limits));
  assert.throws(
    () => requireBrowserCaptureCapacity(1_153_434, limits),
    (error) => error.error?.code === "capture.capacity.insufficient"
      && error.error.details.payloadBytes === 1_153_434
      && error.error.details.maximumRetainedCaptureBytes === 71_210_904,
  );
});

test("the measured complete 1 MiB authored capture fits the default browser destination", async () => {
  const sessionId = "capture-capacity-session";
  const resources = new ResourceBrokerHost();
  const destination = new BrowserMemoryCaptureDestination(resources, sessionId);
  const id = await destination.openPart("session.pdcap");
  const broker = new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(resources));
  let remaining = CAPTURE_MEASURED_COMPLETE_BYTES;
  let call = 1;
  while (remaining > 0) {
    const length = Math.min(remaining, DEFAULT_HOST_RESOURCE_LIMITS.maximumResourceChunkBytes);
    await broker.write(id, new Uint8Array(length).buffer, { callId: `authored-capture-${call++}` });
    remaining -= length;
  }
  await destination.commit();
  await resources.endSession(sessionId);
});

test("browser capture destinations enforce the portable part-name language", async () => {
  const resources = new ResourceBrokerHost();
  const destination = new BrowserMemoryCaptureDestination(resources, "capture-name-session");
  await assert.rejects(
    destination.openPart("../outside.bin"),
    (error) => error instanceof CapturePartNameError && error.rule === "character-set",
  );
  assert.equal((await resources.outstanding()).length, 0);
});
