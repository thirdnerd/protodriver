import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const source = `local a=pdrv.array
local operation=function(id,result) return {id=id,title=id,binding=id,arguments={},result=result,
  risk="read-only",repeatability="safe-to-repeat",locks=a({"protocol"}),requires=a({}),
  availability={modes=a({"main"}),profiles=a({"serial"})}} end
local disposition={kind="value",type={kind="record",fields={outcome={kind="enum",members=a({"resume-required"})}}}}
return {apiVersion="device/v2",id="resume-classification-probe",modes=a({"main"}),profiles=a({"serial"}),
  operations=a({operation("named",{kind="none"}),operation("value",disposition)})}, {
  named=function() pdrv.fail("transfer.resume.required-after-settlement-timeout",{checkpoint="retained"}) end,
  value=function() return {outcome="resume-required"} end,
}`;
const members = [
  { logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
  { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source) },
];

async function harness(t) {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({
    identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial",
  });
  const { server } = await createAuthoredSession(members, artifact, {
    clock, platform: "node", modeId: "main", profileId: "serial", channelId: "main",
    open: async () => connection, helpers: {}, resourceBroker: {}, captureDestinationAdapter: {},
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("resume-classification-probe");
  await client.connect({ mode: "main" });
  return async operation => {
    const handle = await client.startOperation({ operation, arguments: {} });
    const outcome = await client.awaitOperation(handle.operationId);
    await client.acknowledgeOperation(handle.operationId);
    return outcome;
  };
}

test("contract-2 named failure cannot select the transfer resume disposition", { timeout: 3000 }, async t => {
  const run = await harness(t), outcome = await run("named");
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.error?.code, "lua-vm.invocation.program-failure");
  assert.equal(outcome.error?.retryability, "unknown");
  assert.equal(outcome.error?.details?.name, "transfer.resume.required-after-settlement-timeout");
});

test("resume-required-shaped authored data remains an ordinary completed value", { timeout: 3000 }, async t => {
  const run = await harness(t), outcome = await run("value");
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.result, { outcome: "resume-required" });
});
