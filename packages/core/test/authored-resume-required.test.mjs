import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { ResourceBrokerHost, ResourceBrokerRpcClient, DirectResourceRpcAdapter } from "../src/resources.ts";
import { InMemoryTransferCheckpointStore } from "../../transfer-runtime/src/transfer-checkpoint.ts";
import { observations } from "../../../test-support/client-harness.mjs";
import { source as fixture, settings } from "../../../test-support/checkpoint-service/fixture.mjs";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const source = fixture.replace(
  'io.request({kind="read",maximum=1});report(io,2,4,1);io.request({kind="read",maximum=1})\n error("fresh interrupted arm must be cancelled")',
  'io.request({kind="read",maximum=1});report(io,2,4,1)\n io.request({kind="transfer-resume-required",name="probe.response-timeout",details={stage="settlement"}})',
);
assert.notEqual(source, fixture, "classification fixture anchor changed");
const unresolvedSource = source
  .replace('requires=a({"channel.read","channel.write","transfer.checkpoint"})',
    'requires=a({"channel.read","channel.write","transfer.checkpoint","timer"})')
  .replace('io.request({kind="transfer-resume-required",name="probe.response-timeout",details={stage="settlement"}})',
    'io.request({kind="timer-arm",milliseconds=1000})\n io.request({kind="transfer-resume-required",name="probe.response-timeout",details={stage="settlement"}})');
assert.notEqual(unresolvedSource, source, "unresolved-effect fixture anchor changed");

async function harness(t, authoredSource, name, identity) {
  const store = new InMemoryTransferCheckpointStore(), broker = new ResourceBrokerHost(), observed = observations();
  const options = settings(store, new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(broker)), {}, event => observed.add(event), name, identity);
  const members = [
    { logicalName: "pdpkg.json", sourceBytes: Buffer.from('{"packageFormat":1,"generatorContract":2}') },
    { logicalName: "device.lua", sourceBytes: Buffer.from(authoredSource) },
  ];
  const { server } = await createAuthoredSession(members, artifact, { ...options, platform: "node" });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect().catch(() => undefined); await client.close(); await broker.endSession(name); });
  await client.attach(name); await client.connect({ mode: "challenge" });
  const bytes = Uint8Array.of(0, 128, 255, 65); let at = 0;
  const id = await broker.registerSource({ origin: "memory", byteLength: bytes.length,
    async seek(offset) { at = offset; }, async read(into) { const part = bytes.slice(at, at + into.length); into.set(part); at += part.length;
      return { bytesRead: part.length, eof: at === bytes.length }; }, async close() {} }, { kind: "session", sessionId: name });
  return { client, request: { operation: "write", arguments: { image: { kind: "resource", id } } }, rewind() { at = 0; } };
}

test("host admits authored resume-required and a bounded continuation completes", { timeout: 5000 }, async t => {
  const { client, request, rewind } = await harness(t, source, "resume-required-control");
  const first = await client.startOperation(request), classified = await client.awaitOperation(first.operationId);
  assert.equal(classified.outcome, "resume-required", "removing the terminal classification must fail this control");
  assert.deepEqual(classified.authoredCause, { name: "probe.response-timeout", details: { stage: "settlement" } });
  assert.equal(classified.error?.code, "authored.transfer.resume-required");
  assert.equal(classified.transferReceipt?.committedSourceOffset, 2);
  const checkpointId = classified.transferReceipt?.checkpointId;
  assert.equal(typeof checkpointId, "string");
  await client.acknowledgeOperation(first.operationId);
  assert.equal((await client.inspectTransferCheckpoint(checkpointId)).assurance, "verified");
  rewind();
  const resumed = await client.resumeTransfer({ ...request, checkpointId });
  const completed = await client.awaitOperation(resumed.operationId);
  assert.equal(completed.outcome, "completed", JSON.stringify(completed));
});

for (const [stableKeyAssurance, stableKey] of [["none", undefined], ["path-derived", "/dev/ttyUSB0"]]) {
  test(`device generation does not upgrade ${stableKeyAssurance} acquisition assurance`, { timeout: 5000 }, async t => {
    const identity = { transport: "mock", stableKeyAssurance, ...(stableKey === undefined ? {} : { stableKey }) };
    const { client, request, rewind } = await harness(t, source, `resume-required-${stableKeyAssurance}`, identity);
    const first = await client.startOperation(request), classified = await client.awaitOperation(first.operationId);
    assert.equal(classified.outcome, "resume-required");
    const checkpointId = classified.transferReceipt?.checkpointId;
    await client.acknowledgeOperation(first.operationId);
    assert.equal((await client.inspectTransferCheckpoint(checkpointId)).assurance, "unverified");
    rewind();
    const resumed = await client.resumeTransfer({ ...request, checkpointId });
    assert.equal(resumed.assurance, "unverified", "explicit resume must preserve the operator-consent classification");
    assert.equal((await client.awaitOperation(resumed.operationId)).outcome, "completed");
  });
}

test("resume-required refuses an activation with an unresolved native timer", { timeout: 5000 }, async t => {
  const { client, request } = await harness(t, unresolvedSource, "resume-required-unresolved-timer");
  const handle = await client.startOperation(request), outcome = await client.awaitOperation(handle.operationId);
  assert.equal(outcome.outcome, "failed", "unresolved timer was classified as resumable");
  assert.equal(outcome.error?.code, "authored.transfer.resume-disposition-refused",
    "unresolved timer did not reach the named resume admissibility refusal");
  assert.equal(outcome.authoredCause, undefined, "refused classification published an authored cause");
  await client.acknowledgeOperation(handle.operationId);
});
