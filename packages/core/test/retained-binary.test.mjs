import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

for (const routed of [false,true]) test(`retained octets survive helper/authored/helper and transmit: routed=${routed}`, {timeout:2000}, async t=> {
  const clock=new VirtualClock(), tasks=new Map(), observed=[], waiting=Promise.withResolvers();let former;
  const connection=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"m",profileId:"p"});
  const channel=connection.channel("main"), acquire=channel.acquire.bind(channel);
  channel.acquire=async(...args)=> {const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{observed.push([...bytes]);return write(bytes);};return lease;};
  const original=Uint8Array.from({length:256},(_,i)=>i);
  const helpers={
    first:{...(routed?{mailbox:"reply"}:{}),async run(offer){former=offer.accept();const value=former.readBytes(128);waiting.resolve();return {value:await value,handback:former.offerBack()};}},
    last:{...(routed?{mailbox:"reply"}:{}),async run(offer){const grant=offer.accept();await assert.rejects(async()=>former.readBytes(1),e=>e.error?.code==="retained.wrong-owner");return {value:await grant.readBytes(127),handback:grant.offerBack()};}},
  };
  async function dispatch(id,input) {
    const wire=input instanceof Uint8Array?String.fromCharCode(...input):input;
    const [action,,...rest]=wire.split("|"),value=rest.join("|");
    if(action==="start") {
      if(value.startsWith("demux||")) tasks.set(id,(async function*(){yield {kind:"message-send",mailbox:"reply",value:Uint8Array.from(value.slice(7),c=>c.charCodeAt(0))};yield {kind:"result",value:"handled"};})());
      else tasks.set(id,(async function*(){
        const first=yield {kind:"helper",name:"first"},between=yield {kind:"read-bytes",maximum:1},last=yield {kind:"helper",name:"last"};
        const all=Uint8Array.of(...first,...between,...last);
        assert.deepEqual(all,original);
        yield {kind:"write",value:all};
        yield {kind:"result",value:"ok"};
      })());
    }
    return {value:(await tasks.get(id).next(input instanceof Uint8Array && action==="resume"?Uint8Array.from(value,c=>c.charCodeAt(0)):value)).value,consumed:1};
  }
  const server=new RetainedSessionRpcServer({clock,platform:"node",logicalDevice:"binary",modeId:"m",profileId:"p",channelId:"main",operations:["run"],helpers,
    ...(routed?{scheduling:{demultiplexer:"demux",mailboxes:["reply"]}}:{}),open:async()=>connection,resourceBroker:{},captureDestinationAdapter:{},
    execution:{register:async()=>{},dispatch,dispatchBytes:dispatch,retire:async id=>tasks.delete(id),close:async()=>{}}});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("test");await client.connect({mode:"m"});const {operationId}=await client.startOperation({operation:"run",arguments:{}});
  await waiting.promise;channel.enqueueReceived(original);
  const result=await client.awaitOperation(operationId);assert.equal(result.outcome,"completed",JSON.stringify(result));assert.equal(result.result,"ok");assert.deepEqual(observed,[[...original]]);
});

for (const scenario of ["missing-read-adapter", "oversized-write", "oversized-handback", "missing-handback-adapter", "text-read", "text-wait", "text-message-wait"])
test(`retained byte boundary refuses ${scenario} without a follow-on write`, {timeout:2000}, async t=> {
  const clock=new VirtualClock(), writes=[], events=[];
  const connection=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"m",profileId:"p"});
  const channel=connection.channel("main"), acquire=channel.acquire.bind(channel);
  channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{writes.push([...bytes]);return write(bytes);};return lease;};
  let turn=0;
  const first={
    "missing-read-adapter":{kind:"read-bytes",maximum:1},
    "oversized-write":{kind:"write",value:new Uint8Array(257)},
    "oversized-handback":{kind:"helper",name:"bytes"},
    "missing-handback-adapter":{kind:"helper",name:"bytes"},
    "text-read":{kind:"read",maximum:256},
    "text-wait":{kind:"wait-any",maximum:256,timers:[]},
    "text-message-wait":{kind:"message-send",mailbox:"reply",value:Uint8Array.of(0xff)},
  }[scenario];
  const dispatch=async()=>({consumed:1,value:turn++===0?first:
    scenario==="text-message-wait" && turn===2?{kind:"message-wait",timers:[],mailboxes:["reply"]}:
    turn<4?{kind:"write",value:"must-not-submit"}:{kind:"result",value:"silently accepted"}});
  const server=new RetainedSessionRpcServer({clock,platform:"node",logicalDevice:"binary",modeId:"m",profileId:"p",channelId:"main",operations:["run"],
    helpers:{bytes:{async run(offer){const grant=offer.accept();return {value:new Uint8Array(scenario==="oversized-handback"?257:1),handback:grant.offerBack()};}}},
    ...(scenario==="text-message-wait"?{scheduling:{demultiplexer:"demux",mailboxes:["reply"]}}:{}),
    open:async()=>connection,resourceBroker:{},captureDestinationAdapter:{},observe:event=>events.push(event),
    execution:{register:async()=>{},dispatch,...(scenario==="oversized-handback"?{dispatchBytes:dispatch}:{}),retire:async()=>{},close:async()=>{}}});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("test");await client.connect({mode:"m"});
  if(scenario==="text-read" || scenario==="text-wait") channel.enqueueReceived(Uint8Array.of(0,128,255));
  const {operationId}=await client.startOperation({operation:"run",arguments:{}}),result=await client.awaitOperation(operationId);
  assert.equal(result.outcome,"failed",JSON.stringify(result));
  assert.equal(result.error.code,scenario.startsWith("oversized")?"retained.invalid-effect":"retained.unsupported-bytes");
  assert.deepEqual(writes,[]);
  if(scenario.startsWith("oversized")) assert.equal(events.filter(e=>e.kind==="accepted" && e.effect==="write").length,0);
});
