import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule } from "../src/authored-module.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

test("full-duplex input is retained before any authored activation exists", { timeout: 5000 }, async t => {
  const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
  const source = `local a=pdrv.array
return {apiVersion="device/v2",id="idle-input",modes=a({"m"}),profiles=a({"p"}),operations=a({
 {id="read",binding="read",title="Read",arguments={},result={kind="value",type={kind="string"}},
 risk="read-only",repeatability="not-repeatable",locks=a({"channel"}),requires=a({"channel.read"}),
 availability={modes=a({"m"}),profiles=a({"p"})}}
})},{read=function(args,io) return io.request({kind="read",maximum=3.0}) end}`;
  const module = await admitAuthoredModule([
    {logicalName:"pdpkg.json",sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
    {logicalName:"device.lua",sourceBytes:Buffer.from(source)},
  ], artifact);
  const execution = await module.openExecution(), registrations = [], seen = Promise.withResolvers();
  const clock = new VirtualClock(); let channel;
  const server = new RetainedSessionRpcServer({platform:"node",clock,modeId:"m",profileId:"p",channelId:"main",
    logicalDevice:module.description.id,description:module.description,operations:["read"],
    helpers:{},resourceBroker:{},captureDestinationAdapter:{},capabilities:{"channel.read":{available:true}},
    execution:{...execution,async register(...args){registrations.push(args[0]);return execution.register(...args);}},
    async open(){
      const connection = new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"m",profileId:"p"});
      channel=connection.channel("main"); const acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{
        const lease=await acquire(...args), incoming=lease.incoming.bind(lease);
        lease.incoming=async function*(){for await(const chunk of incoming()){yield chunk;seen.resolve();}};
        return lease;
      };
      return connection;
    },
  });
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("idle-ingress"); await client.connect({mode:"m"});
  channel.enqueueReceived(Buffer.from("abc"));
  await seen.promise; // the standing pump processed the delivery and requested its successor
  const idle=await client.getSnapshot();
  assert.equal(idle.state,"connected"); assert.equal(idle.activeOperations.length,0);
  assert.deepEqual(registrations,[]);
  const operation=await client.startOperation({operation:"read",arguments:{}});
  const result=await client.awaitOperation(operation.operationId);
  assert.equal(result.outcome,"completed",JSON.stringify(result));
  assert.equal(result.result,"abc");
  assert.equal(registrations.length,1);
});
