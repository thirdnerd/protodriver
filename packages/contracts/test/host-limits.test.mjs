import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CAPTURE_CAPACITY_POLICY, DEFAULT_HOST_RESOURCE_LIMITS } from "../src/limits.ts";

test("host defaults do not advertise absent per-value or per-capture-record refusals", () => {
  for (const field of ["maximumPublicValueBytes", "maximumPublicValueDepth", "maximumCaptureRecordBytes"]) {
    assert.equal(Object.hasOwn(DEFAULT_HOST_RESOURCE_LIMITS, field), false, field);
  }
});

test("browser capture capacity reserves a named queue separately from retained bytes", () => {
  assert.equal(DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes, 4_194_304);
  assert.equal(DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes,
    DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes + DEFAULT_CAPTURE_CAPACITY_POLICY.maximumRetainedBytes);
});
