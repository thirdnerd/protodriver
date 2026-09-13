import { readFile } from "node:fs/promises";
import { workerData } from "node:worker_threads";

import { buildPdpkg } from "../../../../packages/contracts/src/pdpkg.ts";
import { createAuthoredSession } from "../../../../packages/core/src/authored-module.ts";
import { PostMessageCaptureDestinationRpcAdapter } from "../../../../packages/core/src/capture-rpc.ts";
import { RealClock } from "../../../../packages/core/src/clock.ts";
import { PostMessageResourceRpcAdapter, ResourceBrokerRpcClient } from "../../../../packages/core/src/resources.ts";
import { serveSessionRpc } from "../../../../packages/core/src/rpc.ts";
import { MockTransport } from "../../../../packages/transport-mock/src/index.ts";

const source = `local a=pdrv.array
return {apiVersion="device/v2",id="authored-capture",modes=a({"interactive"}),profiles=a({"serial"}),operations=a({
 {id="exchange",binding="exchange",title="Exchange",arguments={},result={kind="value",type={kind="integer",widthBits=16,signed=false}},
 risk="read-only",repeatability="safe-to-repeat",locks=a({"channel"}),availability={modes=a({"interactive"}),profiles=a({"serial"})},
 requires=a({"channel.read","channel.write"})}
})},{exchange=function(args,io)
 io.request({kind="write",value=pdrv.bytes(string.rep(string.char(0x5a),256))})
 return #io.request({kind="read-bytes",maximum=256})
end}`;

const clock = new RealClock();
const connection = new MockTransport(clock).openConnection({
  identity: { transport: "mock", stableKeyAssurance: "none" },
  modeId: "interactive",
  profileId: "serial",
});
connection.channel("main").enqueueReceived(new Uint8Array(256).fill(0xa5));
const archive = (await buildPdpkg([{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(source) }])).archive;
const artifact = new Uint8Array(await readFile(new URL(
  "../../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm",
  import.meta.url,
)));
const captureAdapter = new PostMessageCaptureDestinationRpcAdapter(workerData.capturePort);
const resourceAdapter = new PostMessageResourceRpcAdapter(workerData.resourcePort);
const created = await createAuthoredSession(archive, artifact, {
  platform: "node",
  clock,
  modeId: "interactive",
  profileId: "serial",
  channelId: "main",
  helpers: {},
  async open() { return connection; },
  captureDestinationAdapter: captureAdapter,
  resourceBroker: new ResourceBrokerRpcClient(resourceAdapter),
});

serveSessionRpc(workerData.sessionPort, created.server);
