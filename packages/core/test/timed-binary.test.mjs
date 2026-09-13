import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createAuthoredSession } from "../src/authored-module.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const wasm = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const original = Uint8Array.from({ length: 256 }, (_, i) => i);
const source = `
local octets={}; for i=0,255 do octets[#octets+1]=string.char(i) end
local expected=table.concat(octets)
return {apiVersion="device/v2",id="timed-binary",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
  operations=pdrv.array({{id="read",title="Read",binding="read",arguments={},result={kind="none"},
    risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({"channel"}),
    availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({"channel.read","channel.write","timer"})}})}, {
  read=function(args,io)
    local timer=io.request({kind="timer-arm",milliseconds=1000})
    io.request({kind="write",value="READ"})
    local received=""
    while #received<256 do
      local completion=io.request({kind="wait-any",maximum=256,timers=pdrv.array({timer})})
      if completion:sub(1,8)~="receive:" then error("wrong completion tag") end
      received=received..completion:sub(9)
    end
    io.request({kind="timer-cancel",timer=timer})
    if received~=expected then error("timed receive corrupted octets") end
    io.request({kind="write",value=pdrv.bytes(received)})
  end,
}`;
const population = [
  { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source) },
  { logicalName: "pdpkg.json", sourceBytes: new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}') },
];

for (const fill of [false, true]) for (const fragments of [[256], [1, 17, 238], ...(fill ? [Array(256).fill(1)] : [])]) {
  test(`admitted timed ${fill ? "fill" : "at-most"} preserves every octet and full payload bound: ${fragments.length} ranges`, { timeout: 5000 }, async t => {
    const clock = new VirtualClock(), writes = [];
    const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
    const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
    channel.acquire = async (...args) => {
      const lease = await acquire(...args), write = lease.write.bind(lease);
      lease.write = async bytes => {
        writes.push(bytes.slice());
        const receipt = await write(bytes);
        if (bytes.length === 4) {
          let offset = 0;
          for (const count of fragments) {
            channel.enqueueReceived(original.slice(offset, offset + count)); offset += count;
          }
        }
        return receipt;
      };
      return lease;
    };
    const selected = fill ? [{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source.replace('kind="wait-any",maximum=256', 'kind="wait-fill",count=256')) }, population[1]] : population;
    const { server } = await createAuthoredSession(selected, wasm, {
      maximumEffectWork: 2000000, // isolate byte completion, not default host-work qualification
      clock, platform: "node", modeId: "main", profileId: "serial", channelId: "main", helpers: {},
      open: async () => connection, resourceBroker: {}, captureDestinationAdapter: {},
    });
    const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
    t.after(async () => { await client.disconnect(); await client.close(); });
    await client.attach("timed-binary"); await client.connect({ mode: "main" });
    for (let i = 0; i < 2; i++) {
      const { operationId } = await client.startOperation({ operation: "read", arguments: {} });
      const outcome = await client.awaitOperation(operationId);
      assert.equal(outcome.outcome, "completed", JSON.stringify(outcome));
      await client.acknowledgeOperation(operationId);
      assert.deepEqual(writes.at(-1), original, "includes NUL, pipe, invalid UTF-8 and every high-bit octet");
      assert.equal(clock.pending.length, 0, "unused timer must be accounted and cancelled");
    }
    assert.equal(writes.length, 4);
  });
}

test("admitted wait-byte adapter bounds metadata separately from the 256-octet payload", async () => {
  const { admitAuthoredModule } = await import("../src/authored-module.ts");
  const module = await admitAuthoredModule(population, wasm), execution = await module.openExecution();
  try {
    await assert.rejects(execution.dispatchWaitBytes("unused", "receive:", new Uint8Array(257)), /byte-completion-limit/);
    await assert.rejects(execution.dispatchWaitBytes("unused", "not-a-wait", original), /invalid-wait-prefix/);
    await assert.rejects(execution.dispatchWaitBytes("unused", "message:" + "x".repeat(65) + ":", original), /invalid-wait-prefix/);
  } finally { await execution.close(); }
});

test("fill does not replenish Lua fuel and pcall cannot recover an exhausted author loop", { timeout: 3000 }, async t => {
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
  const channel = connection.channel("main");
  const lua = source.replace('kind="wait-any",maximum=256', 'kind="wait-fill",count=256')
    .replace('io.request({kind="write",value=pdrv.bytes(received)})', 'pcall(function() while true do end end); error("fuel recovered")');
  const { server } = await createAuthoredSession([{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(lua) }, population[1]], wasm, {
    clock, platform: "node", modeId: "main", profileId: "serial", channelId: "main", helpers: {},
    open: async () => connection, resourceBroker: {}, captureDestinationAdapter: {},
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("timed-binary"); await client.connect({ mode: "main" });
  channel.enqueueReceived(original);
  const { operationId } = await client.startOperation({ operation: "read", arguments: {} });
  const result = await client.awaitOperation(operationId);
  assert.equal(result.outcome, "failed"); assert.equal(result.error.code, "lua-vm.resource.fuel-exhausted");
  assert.equal(result.error.details.vmStatus, -18);
  assert.ok(result.error.details.fuelConsumed > 0 && result.error.details.fuelConsumed < 1000000);
});

test("admitted timed mailbox completion preserves its tag and all 256 octets", { timeout: 5000 }, async t => {
  const lua = `
local mailbox=string.rep("x",64)
local octets={}; for i=0,255 do octets[#octets+1]=string.char(i) end
local expected=table.concat(octets)
return {apiVersion="device/v2",id="timed-mailbox",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
  handlers=pdrv.array({{id="input",binding="input",event={kind="channel-input",channelId="main"},
    maximumConcurrent=1,locks=pdrv.array({}),requires=pdrv.array({})}}),mailboxes=pdrv.array({mailbox}),
  operations=pdrv.array({{id="read",title="Read",binding="read",arguments={},result={kind="none"},
    risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({}),
    availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({"timer"})}})}, {
  input=function(args,io) end,
  read=function(args,io)
    local timer=io.request({kind="timer-arm",milliseconds=1000})
    io.request({kind="message-send",mailbox=mailbox,value=pdrv.bytes(expected)})
    local completion=io.request({kind="message-wait",mailboxes=pdrv.array({mailbox}),timers=pdrv.array({timer})})
    if completion~="message:"..mailbox..":"..expected then error("timed mailbox corrupted octets or tag") end
    io.request({kind="timer-cancel",timer=timer})
  end,
}`;
  const clock = new VirtualClock();
  const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
  const { server } = await createAuthoredSession([
    { logicalName: "device.lua", sourceBytes: new TextEncoder().encode(lua) }, population[1],
  ], wasm, { clock, platform: "node", modeId: "main", profileId: "serial", channelId: "main", helpers: {},
    open: async () => connection, resourceBroker: {}, captureDestinationAdapter: {} });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { await client.disconnect(); await client.close(); });
  await client.attach("timed-mailbox"); await client.connect({ mode: "main" });
  const { operationId } = await client.startOperation({ operation: "read", arguments: {} });
  const outcome = await client.awaitOperation(operationId);
  assert.equal(outcome.outcome, "completed", JSON.stringify(outcome));
  assert.equal(clock.pending.length, 0);
  await client.acknowledgeOperation(operationId);
});
