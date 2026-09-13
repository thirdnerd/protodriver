import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {admitAuthoredModule,createAuthoredSession} from "../src/authored-module.ts";
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from "../src/rpc.ts";
import {RealClock} from "../src/clock.ts";
import {MockTransport} from "../../transport-mock/src/index.ts";
const artifact=new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm",import.meta.url)));
const bytes=value=>({type:"bytes",encoding:"base64",value:Buffer.from(value).toString("base64")});
function source(body,preamble="") {return [
 {logicalName:"pdpkg.json",sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
 {logicalName:"device.lua",sourceBytes:Buffer.from(`${preamble}
 return {apiVersion="device/v2",id="byte-equality",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array({
 {id="run",title="Run",binding="run",arguments={expected={kind="bytes"}},result={kind="value",type={kind="boolean"}},
 risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"channel"}),requires=pdrv.array({}),
 availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})}}
 })},{run=function(args,io) ${body} end}`)}];}
async function harness(t,body,maximumEffectWork=100000,preamble=""){
 const writes=[],clock=new RealClock();
 const {server}=await createAuthoredSession(source(body,preamble),artifact,{
  maximumEffectWork,platform:"node",clock,modeId:"main",profileId:"serial",channelId:"main",helpers:{},resourceBroker:{},captureDestinationAdapter:{},
  async open(){const c=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"main",profileId:"serial"});
   const channel=c.channel("main"),acquire=channel.acquire.bind(channel);channel.acquire=async(...args)=>{
    const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async b=>{writes.push([...b]);return write(b);};return lease;};return c;}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{await client.disconnect();await client.close();});
 await client.attach("bytes");await client.connect({mode:"main"});
 return {writes,async run(value){const op=await client.startOperation({operation:"run",arguments:{expected:{kind:"value",value:bytes(value)}}});return client.awaitOperation(op.operationId);}};
}
const raw=Buffer.from([0,128,255,65]);
test("exact native comparison work exposes the matching prefix, without charging identity as a scan",async()=>{
 async function work(body,value){
  const module=await admitAuthoredModule(source(body),artifact),execution=await module.openExecution();let units=0;
  try{await execution.register("measure",undefined,n=>{units+=n;});
   await execution.startOperation("measure","run",{expected:bytes(value)},{expected:{kind:"bytes"}});return units;
  }finally{await execution.close();}
 }
 const sector=Buffer.alloc(4096,120);
 const construct='local other=pdrv.bytes(string.rep("x",4096));';
 const delta=async value=>await work(construct+'local equal=args.expected==other;return true',value)-await work(construct+'return true',value);
 assert.equal(await delta(sector),4097);
 for(const index of [0,2048,4095]){const mismatch=Buffer.from(sector);mismatch[index]^=1;
  assert.equal(await delta(mismatch),index+2);}
 assert.equal(await delta(Buffer.alloc(4095,120)),1);
 assert.equal(await work('local other=pdrv.bytes("");local equal=args.expected==other;return true',Buffer.alloc(0))
   -await work('local other=pdrv.bytes("");return true',Buffer.alloc(0)),1);
 assert.equal(await work('local equal=args.expected==args.expected;return true',sector)-await work('return true',sector),0);
});
test("bytes equality is content, not identity or mixed-type coercion; its metatable is protected",async t=>{
 const h=await harness(t,`
 local a=args.expected local b=pdrv.bytes("\\x00\\x80\\xffA")
 local empty=pdrv.bytes("")
 assert(a==b and b==a and not rawequal(a,b) and rawequal(a,a))
 assert(a~=pdrv.bytes("\\x00\\x80\\xffB") and a~=empty and empty==pdrv.bytes(""))
 assert(a~="\\x00\\x80\\xffA" and "\\x00\\x80\\xffA"~=a)
 assert(a~=pdrv.array({}) and pdrv.array({})~=a and a~=pdrv.null and pdrv.null~=a)
 assert(a~=pdrv.u64("4") and a~=pdrv.variant("bytes",b))
 assert(getmetatable(a)==false and getmetatable(b)==false)
 assert(not pcall(setmetatable,a,{}) and not pcall(rawset,a,1,0))
 return a==b`);
 const r=await h.run(raw);assert.equal(r.outcome,"completed",JSON.stringify(r.error));assert.equal(r.result,true);assert.deepEqual(h.writes,[]);
});
for(const caught of [false,true])test(`comparison exhaustion remains sticky, protected=${caught}`,async t=>{
 const body=`local compare=function() return args.expected==pdrv.bytes(string.rep("x",4096)) end
 ${caught?'pcall(compare)':'assert(compare())'};io.request({kind="write",value="SENTINEL"});return true`;
 const enough=await harness(t,body,100000),positive=await enough.run(Buffer.alloc(4096,120));
 assert.equal(positive.outcome,"completed",JSON.stringify(positive.error));assert.equal(enough.writes.length,1);
 const limited=await harness(t,body,56000),negative=await limited.run(Buffer.alloc(4096,120));
 assert.deepEqual(limited.writes,[],"exhaustion must prevent the native SENTINEL write");
 assert.equal(negative.outcome,"failed");assert.equal(negative.error.code,"retained.work-exhausted");
});
test("comparisons across a write suspension share the original work grant",async t=>{
 const h=await harness(t,`local a=pdrv.bytes(string.rep("x",3000))
 assert(args.expected==a);io.request({kind="write",value="FIRST"})
 assert(args.expected==a);io.request({kind="write",value="SECOND"});return true`,46000);
 const r=await h.run(Buffer.alloc(3000,120));assert.equal(r.outcome,"failed");assert.equal(r.error.code,"retained.work-exhausted");
 assert.deepEqual(h.writes,[[...Buffer.from("FIRST")]]);
});
test("comparison is available in effect-free evaluation but cannot make native admission work free",async t=>{
 const h=await harness(t,"return true",100000,'assert(pdrv.bytes("abc")==pdrv.bytes("abc"))');
 assert.equal((await h.run(raw)).outcome,"completed");
 await assert.rejects(admitAuthoredModule(source("return true",`
 local a=pdrv.bytes(string.rep("x",60000));local b=pdrv.bytes(string.rep("x",60000))
 pcall(function() assert(a==b);assert(a==b) end)`),artifact),e=>e.code==="retained.work-exhausted");
});
