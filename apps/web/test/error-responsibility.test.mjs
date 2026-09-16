import assert from "node:assert/strict";
import test from "node:test";

import { browserFailure, browserFailureText } from "../src/errors.ts";

test("browser failure presentation carries remediation from trusted envelopes", () => {
  const failure = browserFailure({ error: {
    code: "authored.api-version",
    message: "device/v2 required",
    responsibility: "definition",
    retryability: "no",
  } });
  assert.deepEqual(failure, {
    code: "authored.api-version",
    message: "device/v2 required",
    responsibility: "definition",
    retryability: "no",
  });
  assert.equal(browserFailureText(failure), "Fix the device definition: device/v2 required");
});

test("browser diagnostic wrappers declare responsibility without changing diagnostics", () => {
  assert.deepEqual(browserFailure({
    responsibility: "definition",
    diagnostic: { code: "pdpkg.archive.invalid", message: "archive is invalid" },
  }), {
    code: "pdpkg.archive.invalid",
    message: "archive is invalid",
    responsibility: "definition",
  });
});

test("browser failures without carried responsibility are visibly unexpected", () => {
  assert.deepEqual(browserFailure({
    diagnostic: { code: "future.failure", message: "classification missing" },
  }), {
    code: "future.failure",
    message: "classification missing",
    classification: "unexpected",
  });
  assert.deepEqual(browserFailure(new Error("untyped")), {
    code: "web.failed",
    message: "Error: untyped",
    classification: "unexpected",
  });
});
