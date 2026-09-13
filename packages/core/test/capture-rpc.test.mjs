import assert from "node:assert/strict";
import test from "node:test";

import { CaptureDestinationRegistry } from "../src/capture-rpc.ts";

test("a raw capture RPC writer cannot bypass destination part-name containment", async () => {
  const opened = [];
  const registry = new CaptureDestinationRegistry();
  const destinationId = await registry.register({
    async openPart(name) {
      opened.push(name);
      return "part-resource";
    },
    async commit() {},
    async abort() {},
  }, "capture-rpc-name-session");

  const response = await registry.handle({
    kind: "open-part",
    destinationId,
    name: "../outside.bin",
  }, "capture-rpc-name-session");
  assert.equal(response.kind, "error");
  assert.equal(response.error.code, "capture.open-part-failed");
  assert.match(response.error.message, /character-set rule/u);
  assert.deepEqual(opened, [], "the hostile writer reached its destination backend");
});
