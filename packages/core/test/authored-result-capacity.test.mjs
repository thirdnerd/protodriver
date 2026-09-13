import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {admitAuthoredModule,createAuthoredSession} from "../src/authored-module.ts";
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from "../src/rpc.ts";
import {RealClock} from "../src/clock.ts";
import {MockTransport} from "../../transport-mock/src/index.ts";

const artifact=new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm",import.meta.url)));
function instrument(t,scratch=false){
 const original=WebAssembly.instantiate,seen={dispatch:[],encoding:0,fuel:0,work:0};
 WebAssembly.instantiate=async(bytes,imports)=>{
  const charge=imports.env.pdrv_retained_charge_work;
  const result=await original(bytes,{...imports,env:{...imports.env,pdrv_retained_charge_work(units){seen.work+=units;return charge(units);}}});
  const e=result.instance.exports;
  return {...result,instance:{exports:{...e,
   pdrv_retained_result_dispatch(...args){const count=e.pdrv_retained_result_dispatch(...args);seen.dispatch.push(count);
    seen.fuel+=new DataView(e.memory.buffer).getUint32(args[6],true);return scratch&&count===-26?-2:count;},
   pdrv_retained_result_encode(...args){seen.encoding++;return e.pdrv_retained_result_encode(...args);}
  }}};
 };
 t.after(()=>{WebAssembly.instantiate=original;});return seen;
}
function source(length,argumentsDeclaration="{}"){return [
  {logicalName:"pdpkg.json",sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
  {logicalName:"device.lua",sourceBytes:Buffer.from(`
local count=0
return {apiVersion="device/v2",id="capacity-control",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array({
 {id="run",title="Run",binding="run",arguments=${argumentsDeclaration},result={kind="value",type={kind="string"}},
 risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"channel"}),
 availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}
})},{run=function(args,io)
 count=count+1; io.request({kind="write",value="ONCE"})
 return tostring(count)..":"..string.rep("x",${length})
end}`)}];}
// Isolate input/output capacity, not qualification at the unchanged default.
async function harness(t,length,policy={},maximumEffectWork=4000000,argumentsDeclaration="{}",input=source(length,argumentsDeclaration)){
 const writes=[],clock=new RealClock();
 const {server}=await createAuthoredSession(input,artifact,{
  luaResourcePolicy:policy,maximumEffectWork,platform:"node",clock,modeId:"main",profileId:"serial",channelId:"main",
  helpers:{},resourceBroker:{},captureDestinationAdapter:{},async open(){
   const c=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"main",profileId:"serial"});
   const channel=c.channel("main"),acquire=channel.acquire.bind(channel);
   channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
    lease.write=async bytes=>{writes.push(new TextDecoder().decode(bytes));return write(bytes);};return lease;};return c;
  }});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 let closed=false;const close=async()=>{if(closed)return;closed=true;await client.disconnect();await client.close();};
 t.after(close);
 await client.attach("capacity");await client.connect({mode:"main"});
 const run=async(args={})=>{const op=await client.startOperation({operation:"run",arguments:args});return client.awaitOperation(op.operationId);};
 return {client,writes,run,close};
}
test("capacity recovery preserves one native write and one authored turn result",{timeout:5000},async t=>{
 const seen=instrument(t);
 const h=await harness(t,140000),result=await h.run();
 assert.equal(result.outcome,"completed",JSON.stringify(result.error));
 assert.equal(result.result,"1:"+"x".repeat(140000));assert.deepEqual(h.writes,["ONCE"]);
 assert.ok(seen.dispatch.includes(-26));assert.ok(seen.encoding>0);assert.ok(seen.work>0);assert.ok(seen.fuel>0);
});
test("scratch capacity status is not treated as a recoverable output status",{timeout:5000},async t=>{
 const seen=instrument(t,true),h=await harness(t,140000),result=await h.run();
 assert.equal(result.outcome,"failed");assert.match(result.error.message,/-2/);
 assert.equal(seen.encoding,0);assert.deepEqual(h.writes,["ONCE"]);
});
test("resolved encoded output bound rejects visibly without truncating the result",{timeout:5000},async t=>{
 const h=await harness(t,140000,{maximumEncodedOutputBytes:100000}),result=await h.run();
 assert.equal(result.outcome,"failed");assert.equal(result.error.code,"lua-vm.resource.output-limit");
 assert.equal(result.result,null);assert.deepEqual(h.writes,["ONCE"]);
});
test("native encoding uses the activation work account, not a second grant or Lua fuel",{timeout:5000},async t=>{
 const h=await harness(t,140000,{},10000),result=await h.run();
 assert.equal(result.outcome,"failed");assert.equal(result.error.code,"retained.work-exhausted");
 assert.deepEqual(h.writes,["ONCE"]);
});
test("retained admission resolves policy before executing source",async()=>{
 await assert.rejects(admitAuthoredModule(source(1),artifact,{luaResourcePolicy:{maximumEncodedOutputBytes:4194305}}),
  e=>e.code==="lua-vm.resource.policy-limit");
 await assert.rejects(admitAuthoredModule(source(1),artifact,{luaResourcePolicy:{maximumFuel:1}}),
  e=>e.code==="lua-vm.resource.policy-limit");
});
test("resolved input bound refuses before the operation's native write",{timeout:5000},async t=>{
 const h=await harness(t,1,{maximumEncodedInputBytes:8000},undefined,'{payload={kind="string"}}');
 const result=await h.run({payload:{kind:"value",value:"x".repeat(12000)}});
 assert.equal(result.outcome,"failed");assert.equal(result.error.code,"lua-vm.resource.input-limit");assert.deepEqual(h.writes,[]);
});
test("resize and initially sufficient reservations charge equal Lua fuel and actual native work",{timeout:5000},async t=>{
 const seen=instrument(t),small=await harness(t,140000),first=await small.run();
 assert.equal(first.outcome,"completed");await small.close();
 const fuel=seen.fuel,work=seen.work,encodings=seen.encoding;
 assert.ok(encodings>0);assert.ok(work>0);
 const large=await harness(t,140000,{maximumEncodedOutputBytes:4194304}),second=await large.run();
 assert.equal(second.outcome,"completed");await large.close();
 assert.equal(seen.encoding,encodings,"sufficient reservation must not request recovery");
 assert.equal(seen.fuel-fuel,fuel,"resizing must not resume Lua or reset its fuel account");
 assert.equal(seen.work-work,work,"sizing is cached: each arm sizes and encodes once");
 assert.deepEqual(small.writes,["ONCE"]);assert.deepEqual(large.writes,["ONCE"]);
});
test("native member traversal can exhaust work even when byte copies are tiny",{timeout:5000},async t=>{
 const input=source(0);input[1].sourceBytes=Buffer.from(input[1].sourceBytes.toString()
  .replace('type={kind="string"}','type={kind="array",item={kind="boolean"},maximumLength=64.0}')
  .replace('return tostring(count)..":"..string.rep("x",0)','local a={} for i=1,64 do a[i]=true end;return pdrv.array(a)'));
 const enough=await harness(t,0,{},20000,"{}",input),ok=await enough.run();
 assert.equal(ok.outcome,"completed",JSON.stringify(ok.error));assert.deepEqual(ok.result,Array(64).fill(true));
 const limited=await harness(t,0,{},6400,"{}",input),failed=await limited.run();
 assert.equal(failed.outcome,"failed");assert.equal(failed.error.code,"retained.work-exhausted");
 assert.deepEqual(enough.writes,["ONCE"]);assert.deepEqual(limited.writes,["ONCE"]);
});
