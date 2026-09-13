import assert from "node:assert/strict";
import test from "node:test";

import { serializeWorkerError } from "../src/session-worker-host.ts";

test("browser public error copies transfer envelope details unchanged", () => {
  const details = Object.freeze({ declared: 8_388_608, envelope: 4_194_304 });
  assert.deepEqual(serializeWorkerError({ diagnostic: {
    code: "transfer.limit.window-bytes",
    message: "declared transfer window exceeds the host envelope",
    details,
  } }), {
    code: "transfer.limit.window-bytes",
    message: "declared transfer window exceeds the host envelope",
    retryability: "no",
    details,
  });
});

test("browser public error retains an explicit after-recovery diagnostic", () => {
  assert.deepEqual(serializeWorkerError({ diagnostic: {
    code: "authored.transfer.resume-required",
    message: "Authored transfer is not finished and requires resume",
    retryability: "after-recovery",
  } }), {
    code: "authored.transfer.resume-required",
    message: "Authored transfer is not finished and requires resume",
    retryability: "after-recovery",
    details: {
      code: "authored.transfer.resume-required",
      message: "Authored transfer is not finished and requires resume",
      retryability: "after-recovery",
    },
  });
});
