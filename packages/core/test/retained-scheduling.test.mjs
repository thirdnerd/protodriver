import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

test("cancellation during queued registration cannot dispatch an authored turn", { timeout: 2000 }, async t => {
  const clock = new VirtualClock(), entered = Promise.withResolvers(), release = Promise.withResolvers(), retired = Promise.withResolvers();
  const dispatches = [];
  const connection = new MockTransport(clock).openConnection({
    identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "m", profileId: "p",
  });
  const server = new RetainedSessionRpcServer({ clock, platform: "node", logicalDevice: "test",
    modeId: "m", profileId: "p", channelId: "main", operations: ["run"], helpers: {},
    resourceBroker: {}, captureDestinationAdapter: {}, open: async () => connection,
    execution: {
      async register() { entered.resolve(); await release.promise; },
      async dispatch() { dispatches.push("late authored body"); return { value: { kind: "result", value: "late" }, consumed: 1 }; },
      async retire() { retired.resolve(); }, async close() {},
    },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async () => { release.resolve(); await client.disconnect(); await client.close(); });
  await client.attach("test"); await client.connect({ mode: "m" });
  const handle = await client.startOperation({ operation: "run", arguments: {} });
  await entered.promise;
  await client.cancelOperation(handle.operationId);
  assert.equal((await client.awaitOperation(handle.operationId)).outcome, "cancelled");
  release.resolve(); await retired.promise;
  assert.deepEqual(dispatches, []);
});
