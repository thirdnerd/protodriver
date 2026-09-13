import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule, createAuthoredSession } from "../src/authored-module.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const source=await readFile(new URL("./fixtures/entry-handoff.lua",import.meta.url),"utf8");
const wasm=new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm",import.meta.url)));
const inputs=code=>[{logicalName:"device.lua",sourceBytes:new TextEncoder().encode(code)},
  {logicalName:"pdpkg.json",sourceBytes:new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}')}];
async function bounded(promise,label) {
  let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" did not settle (5000ms hang detector)")),5000);
  })]); } finally { clearTimeout(timer); }
}
async function make(t, selected="accept", extra={}) {
  const code=source.replace('local selected = "accept"','local selected = '+JSON.stringify(selected))
    .replace('maximumConcurrent=8','maximumConcurrent='+(extra.capacity??8));
  const writes=[], clock=new VirtualClock(), entered=Promise.withResolvers(), release=Promise.withResolvers();
  let channel, opened=0;
  const options={platform:"node",clock,modeId:"interactive",profileId:"serial",channelId:"main",helpers:{},
    resourceBroker:{},captureDestinationAdapter:{},...extra.options,
    async open() {
      opened++;
      const c=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"interactive",profileId:"serial"});
      channel=c.channel("main"); const acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{
        const lease=await acquire(...args),write=lease.write.bind(lease),incoming=lease.incoming.bind(lease);
        lease.incoming=async function*(){for await(const chunk of incoming()){
          yield chunk;extra.onIngress?.(new TextDecoder().decode(chunk.bytes));
        }};
        lease.write=async bytes=>{
          const value=new TextDecoder().decode(bytes); writes.push(value);
          const receipt=await write(bytes);
          extra.onWrite?.(value);
          if(writes.length===1 && !extra.preexisting) channel.enqueueReceived(new TextEncoder().encode("RLEFT"));
          return receipt;
        }; return lease;
      };
      if(extra.preexisting) channel.enqueueReceived(new TextEncoder().encode("RLEFT"));
      return c;
    }};
  let server,module;
  if(extra.gate) {
    module=await admitAuthoredModule(inputs(code),wasm); const execution=await module.openExecution();
    server=new RetainedSessionRpcServer({...options,description:module.description,logicalDevice:module.description.id,operations:["collect"],
      capabilities:{"channel.read":{available:false},"channel.write":{available:false},mailbox:{available:true}},
      execution:{...execution,async startOperation(...args) {
        if(args[1]==="accept") { entered.resolve(); await release.promise; }
        return execution.startOperation(...args);
      }}});
  } else ({server,module}=await createAuthoredSession(inputs(code),wasm,options));
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{release.resolve(); await client.disconnect(); await client.close();});
  await client.attach("C1-control");
  return {client,module,writes,entered,release,clock,get opened(){return opened;},
    ingress(value){channel.enqueueReceived(new TextEncoder().encode(value));},
    connect:()=>bounded(client.connect({mode:"interactive"}),"C1 connect"),
    async collect(){const op=await client.startOperation({operation:"collect",arguments:{}});
      const result=await bounded(client.awaitOperation(op.operationId),"C1 collect");
      await client.acknowledgeOperation(op.operationId); assert.equal(result.outcome,"completed",JSON.stringify(result)); return result.result;}};
}
for(const [name,tail] of [["accept","LEFT"],["refuse","EFT"],["invalid","EFT"],["unsupported","LEFT"],["timer","LEFT"],["fuel-entry","LEFT"],["fuel-recipient","LEFT"],["fuel-input-only","LEFT"]])
  test("C1 "+name+": exclusive authority and unread suffix",{timeout:8000},async t=>{
    const h=await make(t,name); await h.connect(); assert.equal(await h.collect(),"message:reply:"+tail);
    assert.deepEqual(h.writes,["\r\n","H:"+tail]);
  });
for(const name of ["stale-write","stale-read","return"])
  test("C1 refuses "+name,{timeout:8000},async t=>{
    const h=await make(t,name);
    const outcome=await h.connect().then(value=>({value}),error=>({error}));
    assert.ok(!h.writes.includes("UNAUTHORIZED"),"stale entry wrote native bytes: "+JSON.stringify(h.writes));
    assert.equal(outcome.error?.error?.code,name==="return"?"authored.entry.handoff-incomplete":"retained.wrong-owner");
  });
test("C1 real ingress during acceptance remains ordered after unread suffix",{timeout:8000},async t=>{
  const ingress=Promise.withResolvers();
  const h=await make(t,"accept",{gate:true,onIngress:value=>{if(value==="NEXT")ingress.resolve();}}), connecting=h.connect();
  await bounded(h.entered.promise,"acceptance gate"); assert.deepEqual(h.writes,["\r\n"]);
  h.ingress("NEXT"); await bounded(ingress.promise,"broker accepted NEXT");h.release.resolve();await connecting;
  assert.equal(await h.collect(),"message:reply:LEFT");
  assert.equal(await h.collect(),"message:reply:NEXT");
  assert.deepEqual(h.writes,["\r\n","H:LEFT","H:NEXT"]);
});
test("D2 handoff queues more ranges than handler concurrency without losing entry's suffix",{timeout:8000},async t=>{
  const ingress=Promise.withResolvers();
  const h=await make(t,"accept",{gate:true,capacity:1,onIngress:value=>{if(value==="4")ingress.resolve();}}),connecting=h.connect();
  await bounded(h.entered.promise,"capacity acceptance gate");
  for(const value of ["1","2","3","4"])h.ingress(value);
  await bounded(ingress.promise,"four pending deliveries");
  assert.deepEqual(h.writes,["\r\n"]);h.release.resolve();await connecting;
  for(const value of ["LEFT","1","2","3","4"])assert.equal(await h.collect(),"message:reply:"+value);
  assert.deepEqual(h.writes,["\r\n","H:LEFT","H:1","H:2","H:3","H:4"]);
});
test("C1 disconnect before acceptance revokes late decision and queued bytes",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate:true}), connecting=h.connect();
  const rejected=assert.rejects(connecting,e=>e.error?.code==="retained.cancelled");
  await bounded(h.entered.promise,"acceptance gate"); await h.client.disconnect(); h.release.resolve();
  await rejected; assert.deepEqual(h.writes,["\r\n"]);
});
test("C1 recipient work spends entry's finite account",{timeout:8000},async t=>{
  // Includes metered value encoding; still cannot fund the recipient's loop.
  const h=await make(t,"fuel",{options:{maximumEffectWork:20000}});
  await assert.rejects(h.connect(),e=>e.error?.code==="retained.work-exhausted");
  assert.deepEqual(h.writes,["\r\n"]);
});
test("C1 recipient Lua instructions cannot get a fresh fuel account",{timeout:8000},async t=>{
  const h=await make(t,"fuel-vm");
  await assert.rejects(h.connect(),e=>e.error?.code==="lua-vm.resource.fuel-exhausted"
    && e.error.details.vmStatus===-18 && e.error.details.fuelConsumed>0 && e.error.details.fuelConsumed<1000000);
  assert.deepEqual(h.writes,["\r\n"]);
});
test("C1 pre-existing ingress belongs to entry, then the unread suffix transfers",{timeout:8000},async t=>{
  const h=await make(t,"accept",{preexisting:true});await h.connect();
  assert.equal(await h.collect(),"message:reply:LEFT");assert.deepEqual(h.writes,["\r\n","H:LEFT"]);
});
test("C1 buffered handler cannot refinance entry's consumed Lua fuel after entry returns",{timeout:8000},async t=>{
  const closed=Promise.withResolvers();
  const h=await make(t,"fuel-input",{onWrite:value=>{if(value.startsWith("H:"))closed.resolve({unauthorizedFuelWrite:value});}});
  const subscription=h.client.subscribe(e=>{if(e.kind==="connection-close")closed.resolve(e);});
  t.after(()=>subscription.dispose());
  await h.connect();
  const event=await bounded(closed.promise,"inherited suffix account");
  assert.equal(event.error?.code,"lua-vm.resource.fuel-exhausted",JSON.stringify(event));
  assert.equal(event.error.details.vmStatus,-18);
  assert.ok(event.error.details.fuelConsumed>0&&event.error.details.fuelConsumed<1000000);
  assert.deepEqual(h.writes,["\r\n"]);
});
const base=await admitAuthoredModule(inputs(source),wasm);
for(const [name,change,code] of [
  ["absent target",d=>d.entry.handoffTo="absent","authored.declaration.invalid"],
  ["missing acceptance",d=>delete d.handlers[0].acceptHandoff,"authored.declaration.invalid"],
  ["orphan acceptance",d=>delete d.entry.handoffTo,"authored.declaration.invalid"],
  ["unresolved acceptance",d=>d.handlers[0].acceptHandoff="absent","authored.binding.unresolved"],
  ["acceptance role reuse",d=>d.handlers[0].acceptHandoff="enter","authored.handler.binding-role"],
  ["acceptance task reservation",d=>d.handlers[0].maximumConcurrent=32,"authored.handler.task-limit"],
]) test("C1 admission refuses "+name,()=>{
  const d=structuredClone(base.description);change(d);
  assert.throws(()=>admitAuthoredDescription(d,base.bindings),e=>e.code===code);
});
