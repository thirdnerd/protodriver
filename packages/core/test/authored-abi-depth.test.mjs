import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { nativeOptions } from "../../../test-support/admission/fixture.mjs";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const bootstrap = new Uint8Array(await readFile(new URL("./fixtures/authored-vm-diagnostics/pdpkg.json", import.meta.url)));

async function invokeNestedReturn(t, depth) {
  const source = `
    return {apiVersion="device/v2",id="abi-depth-${depth}",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
      operations=pdrv.array({{id="run",title="Run",binding="run",arguments={},result={kind="value",type={kind="string"}},
        risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({}),
        availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}})},
      {run=function()
        local value="leaf"
        for i=1,${depth} do value=pdrv.array({value}) end
        return value
      end}
  `;
  const { server } = await createAuthoredSession([
    { logicalName: "pdpkg.json", sourceBytes: bootstrap },
    { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source) },
  ], artifact, { ...nativeOptions(() => {}), platform: "node", resourceBroker: {}, captureDestinationAdapter: {} });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach(`abi-depth-${depth}`);
  await client.connect({ mode: "main" });
  const operation = await client.startOperation({ operation: "run", arguments: {} });
  return client.awaitOperation(operation.operationId);
}

test("retained invocation refuses deeply nested Lua results before JS or WASM stack exhaustion", { timeout: 5000 }, async t => {
  // The dispatcher adds two record levels around the authored return value.
  const within = await invokeNestedReturn(t, 126);
  assert.equal(within.error.code, "authored.result.invalid");
  for (const depth of [127, 2048, 8192]) {
    const result = await invokeNestedReturn(t, depth);
    assert.equal(result.outcome, "failed");
    assert.equal(result.error.code, "lua-vm.resource.depth-limit");
    assert.equal(result.error.retryability, "no");
    assert.equal(result.error.details.vmStatus, -28);
    assert.equal(result.error.details.phase, "dispatch");
  }
});
