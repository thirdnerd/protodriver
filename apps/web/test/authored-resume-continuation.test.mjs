import assert from "node:assert/strict";
import test from "node:test";

import { runAuthoredOperationWithOneResume } from "../src/authored-controls.ts";

test("authored browser coordinator performs exactly one verified resume", async () => {
  const calls = [], results = [
    { operationId: "first", outcome: "resume-required", durationMs: 1, result: null,
      authoredCause: { name: "device-3.response-timeout", details: {} },
      transferReceipt: { checkpointId: "checkpoint-1", committedSourceOffset: 4096, verified: false } },
    { operationId: "second", outcome: "completed", durationMs: 1, result: null },
  ];
  const client = {
    async startOperation(request) { calls.push(["start", request]); return { operationId: "first", acceptedAtSequence: 1 }; },
    async awaitOperation(id) { calls.push(["await", id]); return results.shift(); },
    async acknowledgeOperation(id) { calls.push(["ack", id]); },
    async inspectTransferCheckpoint(id) { calls.push(["inspect", id]); return { assurance: "verified" }; },
    async resumeTransfer(request) { calls.push(["resume", request]); return { operationId: "second", acceptedAtSequence: 2, assurance: "verified" }; },
  };
  const accepted = [];
  const result = await runAuthoredOperationWithOneResume(client, { operation: "write_image", arguments: {} }, id => accepted.push(id));
  assert.equal(result.outcome.outcome, "completed"); assert.equal(result.resumeCount, 1);
  assert.deepEqual(accepted, ["first", "second"]);
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "await", "ack", "inspect", "resume", "await", "ack"]);
});

test("authored browser coordinator stops for explicit consent when acquisition identity is unverified", async () => {
  let resumes = 0;
  const classified = { operationId: "first", outcome: "resume-required", durationMs: 1, result: null,
    authoredCause: { name: "probe.timeout", details: {} },
    transferReceipt: { checkpointId: "checkpoint-1", committedSourceOffset: 1, verified: false } };
  const client = {
    async startOperation() { return { operationId: "first", acceptedAtSequence: 1 }; },
    async awaitOperation() { return classified; }, async acknowledgeOperation() {},
    async inspectTransferCheckpoint() { return { assurance: "unverified" }; },
    async resumeTransfer() { resumes++; throw new Error("unverified checkpoint must not continue automatically"); },
  };
  await assert.rejects(runAuthoredOperationWithOneResume(client, { operation: "write", arguments: {} }),
    /explicit operator consent is required/);
  assert.equal(resumes, 0);
});

test("authored browser coordinator does not turn repeated classification into a retry loop", async () => {
  let starts = 0, resumes = 0;
  const classified = id => ({ operationId: id, outcome: "resume-required", durationMs: 1, result: null,
    authoredCause: { name: "probe.timeout", details: {} },
    transferReceipt: { checkpointId: "checkpoint-1", committedSourceOffset: 1, verified: false } });
  const client = {
    async startOperation() { starts++; return { operationId: "first", acceptedAtSequence: 1 }; },
    async awaitOperation(id) { return classified(id); }, async acknowledgeOperation() {},
    async inspectTransferCheckpoint() { return { assurance: "verified" }; },
    async resumeTransfer() { resumes++; return { operationId: "second", acceptedAtSequence: 2, assurance: "verified" }; },
  };
  const result = await runAuthoredOperationWithOneResume(client, { operation: "write", arguments: {} });
  assert.equal(result.outcome.outcome, "resume-required"); assert.equal(result.resumeCount, 1);
  assert.equal(starts, 1); assert.equal(resumes, 1);
});

test("authored browser coordinator does not resume an ordinary failure", async () => {
  let inspections = 0, resumes = 0;
  const failed = { operationId: "first", outcome: "failed", durationMs: 1, result: null,
    error: { code: "lua-vm.invocation.program-failure", message: "response timeout", retryability: "unknown" },
    transferReceipt: { checkpointId: "checkpoint-1", committedSourceOffset: 4096, verified: false } };
  const client = {
    async startOperation() { return { operationId: "first", acceptedAtSequence: 1 }; },
    async awaitOperation() { return failed; }, async acknowledgeOperation() {},
    async inspectTransferCheckpoint() { inspections++; return { assurance: "verified" }; },
    async resumeTransfer() { resumes++; throw new Error("ordinary failure must not resume"); },
  };
  const result = await runAuthoredOperationWithOneResume(client, { operation: "write", arguments: {} });
  assert.equal(result.outcome, failed); assert.equal(result.resumeCount, 0);
  assert.equal(inspections, 0); assert.equal(resumes, 0);
});

test("resume-required checkpoint identity is mandatory before inspection or resume", async () => {
  let inspections = 0, resumes = 0;
  const classified = { operationId: "first", outcome: "resume-required", durationMs: 1, result: null,
    authoredCause: { name: "probe.timeout", details: {} },
    transferReceipt: { committedSourceOffset: 4096, verified: false } };
  const client = {
    async startOperation() { return { operationId: "first", acceptedAtSequence: 1 }; },
    async awaitOperation() { return classified; }, async acknowledgeOperation() {},
    async inspectTransferCheckpoint() { inspections++; return { assurance: "verified" }; },
    async resumeTransfer() { resumes++; throw new Error("missing checkpoint identity must not resume"); },
  };
  await assert.rejects(runAuthoredOperationWithOneResume(client, { operation: "write", arguments: {} }),
    /resume-required outcome omitted its checkpoint identity/);
  assert.equal(inspections, 0, "missing checkpoint identity reached inspection");
  assert.equal(resumes, 0, "missing checkpoint identity reached resume");
});
