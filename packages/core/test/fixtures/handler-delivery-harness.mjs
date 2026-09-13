import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule } from "../../src/authored-module.ts";
import { RetainedSessionRpcServer } from "../../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../../src/rpc.ts";
import { CaptureDestinationRegistry, DirectCaptureDestinationRpcAdapter } from "../../src/capture-rpc.ts";
import { loadCapture } from "../../src/capture.ts";
import { VirtualClock } from "../../../../test-support/clock.ts";
import { MockTransport } from "../../../transport-mock/src/index.ts";

const wasm = new Uint8Array(await readFile(new URL("../../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
export const bounded = async (p, label) => { let timer; try { return await Promise.race([p, new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error(label + " (5000ms hang detector)")), 5000);
})]); } finally { clearTimeout(timer); } };
export async function make(t, options = {}) {
  let code = `local a=pdrv.array; local count=0; local received=""
return {apiVersion="device/v2",id="delivery-control",modes=a({"m"}),profiles=a({"p"}),mailboxes=a({"reply"}),
handlers=a({{id="receiver",binding="input",${options.consumedRanges?'inputEvidence="consumed-ranges",':''}event={kind="channel-input",channelId="main"},maximumConcurrent=${options.concurrency ?? 1},
locks=a({}),requires=a({"channel.input","channel.write","mailbox","timer"})}}),
operations=a({{id="peer",binding="peer",title="Peer",arguments={},result={kind="value",type={kind="string",maximumLength=4096}},
risk="read-only",repeatability="safe-to-repeat",locks=a({}),requires=a({"mailbox"}),availability={modes=a({"m"}),profiles=a({"p"})}}})},
{input=function(args,io) count=count+1; ${options.body ?? 'io.request({kind="write",value=pdrv.bytes(args.input)})'} end,
peer=function(args,io) ${options.peer ?? 'return "peer"'} end}`;
  if(options.group)code=code.replace('profiles=a({"p"}),','profiles=a({"p"}),channelRoles={p={request="requests",response="responses",event="events"}},');
  if(options.entry)code=code.replace('handlers=a(', `entry={binding="enter",${options.entryConsumed?'inputEvidence="consumed-ranges",':''}locks=a({}),requires=a({"channel.read"}),handoffTo="receiver"},handlers=a(`)
    .replace('binding="input",', 'binding="input",acceptHandoff="accept",')
    .replace('{input=function', `{enter=function(args,io) ${options.entryCode ?? 'assert(io.request({kind="wait-fill",count=1,timers=a({})})=="receive:R");assert(io.request({kind="entry-handoff",parser="empty",timers="none"})=="accepted")'} end,accept=function() return {accepted=true} end,input=function`);
  if(options.retirement)code=code.replace('requires=a({"mailbox"})','requires=a({"mailbox","clock.observe","input.retirement"})');
  const module = await admitAuthoredModule([{logicalName:"device.lua",sourceBytes:Buffer.from(code)},
    {logicalName:"pdpkg.json",sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}], wasm);
  const execution = await module.openExecution(), clock = new VirtualClock(), seen = [], waiters = new Set();
  const emit = event => { seen.push(event); for (const w of waiters) if (w.p(event)) { waiters.delete(w); w.resolve(event); } };
  const wait = async p => { const old = seen.find(p); if (old) return old; let w;
    try { return await bounded(new Promise(resolve => { w={p,resolve};waiters.add(w); }), "D2 observation"); }
    finally { waiters.delete(w); } };
  const gate = Promise.withResolvers(), parts = new Map(), registry = new CaptureDestinationRegistry();
  const destination = await registry.register({async openPart(name) { parts.set(name, []); return name; },async commit(){},async abort(){}}, "D2");
  let channel, starts=0;const channels=new Map();
  const server = new RetainedSessionRpcServer({platform:"node",clock,logicalDevice:module.description.id,modeId:"m",profileId:"p",channelId:"main",
    operations:["peer"],description:module.description,capabilities:{mailbox:{available:true},...(options.retirement?{'input.retirement':{available:true},'clock.observe':{available:true}}:{})},helpers:{},
    ...(options.retirement?{inputRetirementSupport:{adapter:'bounded-ingress-v1',clock}}:{}),
    ...(options.group?{channelRoles:module.description.channelRoles.p}:{}),
    ...(options.work === undefined ? {} : {maximumEffectWork:options.work}),
    ...(options.nativeData ? {nativeData:options.nativeData} : {}),
    captureDestinationAdapter:new DirectCaptureDestinationRpcAdapter(registry,"D2"),
    resourceBroker:{async write(id,buffer){parts.get(id).push(Buffer.from(buffer).subarray());},async close(){}},
    execution:{...execution,async startOperation(...args){
      emit({kind:"start",id:args[0],binding:args[1],arguments:args[2]});
      const result=await execution.startOperation(...args);
      emit({kind:"turn",id:args[0],effect:result.value?.kind});
      if(args[1]==="input"&&++starts===1&&options.dispatchGate){emit({kind:"gated"});await gate.promise;}
      return result;
    },async retire(id,keep){await execution.retire(id,keep);emit({kind:"retired",id,keep:!!keep});}},
    async open(){const c=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"m",profileId:"p",
      ...(options.group?{channelIds:["requests","responses","events"]}:{})});
      channel=c.channel(options.group?"responses":"main");
      for(const ch of c.channels){channels.set(ch.id,ch);if(options.group)ch.direction=ch.id==='requests'?'out':'in';
      const acquire=ch.acquire.bind(ch);
      ch.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease),incoming=lease.incoming.bind(lease);
        if(options.noCustody)lease.bindInputCustody=undefined;
        lease.incoming=async function*(){for await(const chunk of incoming()){
          if(options.receiveGate){emit({kind:"native-received"});await gate.promise;}
          yield chunk;emit({kind:"ingress",length:chunk.bytes.length});}};
        lease.write=async bytes=>{const receipt=await write(bytes);emit({kind:"write",bytes:[...bytes]});
          if(options.nativeGate)await gate.promise;return receipt;};return lease;};}
      if(options.entry)for(const value of options.entryChunks??["R"+"x".repeat(484)])channel.enqueueReceived(Buffer.from(value));return c;},
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  await client.attach("D2"); const sub=client.subscribe(emit);
  t.after(async()=>{gate.resolve();sub.dispose();await client.disconnect();await client.close();});
  const capture=options.capture===false?null:await client.startCapture(destination,{sidecarThresholdBytes:65536});await client.connect({mode:"m"});
  return {client,seen,wait,gate,clock,module,
    inject(bytes,id){return (id?channels.get(id):channel).enqueueReceived(Uint8Array.from(bytes));},
    metrics:id=>(id?channels.get(id):channel).ingressMetrics,
    failInput(){channel.terminate({kind:"fault",error:{code:"control.input-ended",message:"controlled ingress failure",retryability:"no"}});},
    writes:()=>seen.filter(e=>e.kind==="write").map(e=>e.bytes),
    async peer(){const op=await client.startOperation({operation:"peer",arguments:{}});return bounded(client.awaitOperation(op.operationId),"peer result");},
    async capture(){if((await client.getSnapshot()).state!=="closed")await client.stopCapture(capture);
      const data=Buffer.concat([...parts.values()].flat());return loadCapture((async function*(){yield data;})());},
  };
}
