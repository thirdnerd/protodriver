import { relay } from "../../../test-support/refusal/cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule, createAuthoredSession } from "../src/authored-module.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";
const source=await readFile(new URL("./fixtures/write-relay.lua",import.meta.url),"utf8");
const wasm=new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm",import.meta.url)));
const inputs=code=>[{logicalName:"device.lua",sourceBytes:new TextEncoder().encode(code)},
  {logicalName:"pdpkg.json",sourceBytes:new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}')}];
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(new Error(label+" did not settle (5000ms hang detector)")),5000);
})]);}finally{clearTimeout(timer);}}
async function make(t,selected="accept",extra={}) {
  let code=source.replace('local selected = "accept"','local selected = '+JSON.stringify(selected))
    .replace('writeVia="receiver",locks=pdrv.array({"protocol"})','writeVia="receiver",locks='+ (extra.unlocked?'empty':'pdrv.array({"protocol"})'));
  if(extra.deadline)code=code.replace('"channel.write-via","mailbox"','"channel.write-via","mailbox","operation.deadline"')
    .replace('command=function(args,io)','command=function(args,io) io.request({kind="deadline-arm",milliseconds=500})');
  const writes=[],clock=new VirtualClock(),entered=Promise.withResolvers(),release=Promise.withResolvers(),submitted=Promise.withResolvers();
  const retired=Promise.withResolvers(), ingress=Promise.withResolvers(),order=[],authorized=[];
  const queued=Promise.withResolvers();let relayRequests=0,released=false;release.promise.then(()=>{released=true;});
  let channel,server,module;
  const options={platform:"node",clock,modeId:"interactive",profileId:"serial",channelId:"main",helpers:{},resourceBroker:{},captureDestinationAdapter:{},...extra.options,
    async open(){const c=new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"interactive",profileId:"serial"});
      channel=c.channel("main");const acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease),incoming=lease.incoming.bind(lease);
        lease.incoming=async function*(){for await(const chunk of incoming()){yield chunk;ingress.resolve();}};
        lease.write=async bytes=>{writes.push([...bytes]);order.push("write");submitted.resolve();const receipt=await write(bytes);
          if(extra.nativeGate)await release.promise;
          if(!extra.noReply)channel.enqueueReceived(new TextEncoder().encode("OK"));return receipt;};return lease;};return c;}};
  if(extra.gate) {
    module=await admitAuthoredModule(inputs(code),wasm);const execution=await module.openExecution();
    server=new RetainedSessionRpcServer({...options,description:module.description,logicalDevice:module.description.id,operations:["command","alarm"],
      capabilities:{"channel.write-via":{available:true},mailbox:{available:true},"operation.deadline":{available:true}},
      execution:{...execution,async startOperation(...args){
        order.push(args[1]);
        if(args[1]==="authorizeWrite")authorized.push(args[2].operationId);
        if(args[1]==="authorizeWrite"&&extra.gate==="queue")entered.resolve();
        if(args[1]==="authorizeWrite"&&extra.gate==="before"){entered.resolve();await release.promise;}
        const result=await execution.startOperation(...args);
        if(extra.gate==='work-prefix'&&result.value?.kind==='reschedule')order.push('native-prefix:'+args[0]);
        return result;
      },async dispatch(...args){
        if(extra.gate==="queue"&&args[0].includes("write-authorization")&&!released)return {consumed:1,value:{kind:"reschedule"}};
        const result=await execution.dispatch(...args);
        if(extra.gate==='work-prefix'&&result.value?.kind==='reschedule')order.push('native-prefix:'+args[0]);
        if(result.value?.kind==="write-via"&&++relayRequests===2)queued.resolve();
        if(extra.gate==="atomic"&&result.value?.kind==="result"&&result.value.value?.accepted===true){
          channel.enqueueReceived(new TextEncoder().encode("ALARM"));await ingress.promise;
        }
        if(extra.gate==="after"&&result.value?.kind==="result"&&result.value.value?.accepted===true){entered.resolve();await release.promise;}
        return result;},async retire(id){await execution.retire(id);if(id.includes("write-authorization"))retired.resolve();}}});
  } else ({module,server}=await createAuthoredSession(inputs(code),wasm,options));
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{release.resolve();await client.disconnect();await client.close();});
  await client.attach("C2-control");await bounded(client.connect({mode:"interactive"}),"quiet connection");
  assert.deepEqual(writes,[],"no ingress or native write needed to establish this probe");
  return {client,module,clock,writes,entered,release,submitted,retired,queued,ingress,order,authorized,inject(value){channel.enqueueReceived(new TextEncoder().encode(value));},
    async start(operation="command"){return client.startOperation({operation,arguments:{}});},
    async result(id){return bounded(client.awaitOperation(id),"relay operation");}};
}
// Either 31,024-octet comparison arm fits. Both exceed the shared grant
// before adding any host sizing/encoding; no threshold near a yield boundary.
for(const selected of ["accept","binary","twice","lua-owner","lua-operation","work-owner","work-operation"])
  test("C2 quiet exact-byte relay: "+selected,{timeout:8000},async t=>{
    const h=await make(t,selected,{options:{maximumEffectWork:50000}}),op=await h.start(),result=await h.result(op.operationId);
    assert.equal(result.outcome,"completed",JSON.stringify(result));assert.equal(result.result,"message:reply:OK");
    const bytes=selected==="binary"?[0,255,128]:[...Buffer.from("QUERY\r\n")];
    assert.deepEqual(h.writes,selected==="twice"?[bytes,bytes]:[bytes]);
  });
for(const selected of ["refuse","invalid","rewrite","throw","unrelated","raw","fuel","lua-both","work-both"])
  test("C2 refuses without native bytes: "+selected,{timeout:8000},async t=>{
    if(selected==='work-both') relay.begin();
    const h=await make(t,selected,{options:{maximumEffectWork:relay.grant},gate:selected==='work-both'?'work-prefix':undefined}),op=await h.start(),result=await h.result(op.operationId);
    if(selected==='work-both') {
      relay.check({ code: result.error?.code,
        foreground: h.order.some(x=>x.startsWith('native-prefix:retained-operation-')),
        authorizer: h.order.some(x=>x.startsWith('native-prefix:retained-write-authorization-')),
        writes: h.writes, value: result.result });
      return;
    }
    assert.deepEqual(h.writes,[],"owner refusal MUST prevent native bytes including UNAUTHORIZED");
    assert.equal(result.outcome,"failed",JSON.stringify(result));
    assert.equal(result.error.code,selected==="raw"?"retained.wrong-owner":["fuel","work-both"].includes(selected)?"retained.work-exhausted":
      selected==="throw"?"lua-vm.environment.program":selected==="lua-both"?"lua-vm.resource.fuel-exhausted":"retained.relay-refused");
    if(["throw","lua-both"].includes(selected)) {
      assert.equal(result.error.details.vmStatus,selected==="throw"?-7:-18);
      assert.ok(result.error.details.fuelConsumed>0&&result.error.details.fuelConsumed<1000000);
    }
  });
test("C2 first approval cannot authorize different bytes on a second request",{timeout:8000},async t=>{
  const h=await make(t,"replay"),op=await h.start(),result=await h.result(op.operationId);
  assert.deepEqual(h.writes,[[...Buffer.from("QUERY\r\n")]],"previous approval must not submit UNAUTHORIZED bytes");
  assert.equal(result.outcome,"failed");assert.equal(result.error.code,"retained.relay-refused");
});
for(const gate of ["before","after"])for(const action of ["cancel","disconnect"])
  test("C2 "+action+" "+gate+" affirmative return prevents submission",{timeout:8000},async t=>{
    const h=await make(t,"accept",{gate}),op=await h.start();await bounded(h.entered.promise,"authorization gate");
    if(action==="cancel")await h.client.cancelOperation(op.operationId);else await h.client.disconnect();
    h.release.resolve();const result=await h.result(op.operationId);
    await bounded(h.retired.promise,"late authorization retirement");
    assert.equal(result.outcome,"cancelled");assert.deepEqual(h.writes,[]);
    if(action==="cancel") {
      h.inject("ALARM");const alarm=await h.start("alarm");
      assert.equal((await h.result(alarm.operationId)).result,"message:alarm:ALARM","ordinary cancellation must not kill independent input");
    }
  });
test("C2 input progresses during approval while requesting operation holds protocol lock",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate:"before"}),op=await h.start();await bounded(h.entered.promise,"approval waiting");
  // This gate holds a VM dispatch; release after enqueuing real input, then
  // the callback itself reschedules, allowing the independent input task.
  h.inject("ALARM");await bounded(h.ingress.promise,"real input accepted by broker");h.release.resolve();
  const alarm=await h.start("alarm");assert.equal((await h.result(alarm.operationId)).result,"message:alarm:ALARM");
  assert.equal((await h.result(op.operationId)).outcome,"completed");
  assert.ok(h.order.indexOf("input")<h.order.indexOf("write"),JSON.stringify(h.order));
});
test("C4 bounds queued C2 requests and refuses their submission behind the first pending write",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate:"before",unlocked:true});
  const first=await h.start();await bounded(h.entered.promise,"first authorization");
  const queued=[];for(let i=0;i<31;i++)queued.push(await h.start());
  await assert.rejects(h.start());
  await h.client.cancelOperation(queued[0].operationId);h.release.resolve();
  assert.equal((await h.result(first.operationId)).outcome,"completed");
  assert.equal((await h.result(queued[0].operationId)).outcome,"cancelled");
  for(const op of queued.slice(1))assert.equal((await h.result(op.operationId)).error.code,"retained.outbound-unresolved");
  assert.equal(h.writes.length,1);
  assert.deepEqual(h.authorized,[first.operationId],"queued permission must not survive an unresolved predecessor");
  for(const op of [first,...queued])await h.client.acknowledgeOperation(op.operationId);
  const fresh=await h.start();assert.equal((await h.result(fresh.operationId)).outcome,"completed");
  assert.equal(h.writes.length,2);assert.deepEqual(h.authorized,[first.operationId,fresh.operationId],"fresh request needs fresh authorization");
});
test("C2 authorization readiness remains FIFO when refusals submit no predecessor",{timeout:8000},async t=>{
  const h=await make(t,"refuse",{gate:"before",unlocked:true});
  const first=await h.start();await bounded(h.entered.promise,"first refusal authorization");
  const queued=[];for(let i=0;i<31;i++)queued.push(await h.start());
  await h.client.cancelOperation(queued[0].operationId);h.release.resolve();
  for(const op of [first,...queued.slice(1)])assert.equal((await h.result(op.operationId)).error.code,"retained.relay-refused");
  assert.equal((await h.result(queued[0].operationId)).outcome,"cancelled");
  assert.deepEqual(h.writes,[],"refusal cannot submit bytes");
  assert.deepEqual(h.authorized,[first,...queued.slice(1)].map(op=>op.operationId),"per-owner authorization readiness is FIFO after removing revoked owners");
});
test("C2 submitted write survives cancellation as an actual native write",{timeout:8000},async t=>{
  const h=await make(t,"accept",{nativeGate:true,noReply:true}),op=await h.start();await bounded(h.submitted.promise,"native submission");
  await h.client.cancelOperation(op.operationId);const result=await h.result(op.operationId);
  assert.equal(result.outcome,"cancelled");assert.deepEqual(h.writes,[[...Buffer.from("QUERY\r\n")]]);
  assert.ok(result.error.details.effects.some(e=>e.kind==="write"&&e.outcome==="indeterminate"));h.release.resolve();
});
for(const gate of ["before","after"])test("C4 autonomous expiry during C2 authorization "+gate+" decision revokes submission, not independent input",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate,deadline:true}),op=await h.start();await bounded(h.entered.promise,"authorization");
  await h.clock.advance(499000);assert.ok((await h.client.getSnapshot()).activeOperations.includes(op.operationId));
  await h.clock.advance(1000);assert.ok(!(await h.client.getSnapshot()).activeOperations.includes(op.operationId));
  const result=await h.result(op.operationId);
  assert.equal(result.error.details.cause.kind,"authored-deadline");
  assert.ok(result.error.details.effects.every(e=>e.kind!=="write"),"expiry before submission must not invent write uncertainty");
  h.release.resolve();await bounded(h.retired.promise,"authorization retirement");assert.deepEqual(h.writes,[]);
  h.inject("ALARM");const alarm=await h.start("alarm");assert.equal((await h.result(alarm.operationId)).result,"message:alarm:ALARM");
});
test("C4 expiry removes an unsubmitted C2 queue member without authorizing it",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate:"queue",deadline:true,unlocked:true});
  const first=await h.start(),second=await h.start();await bounded(Promise.all([h.queued.promise,h.entered.promise]),"second relay queued behind first authorization");
  await h.client.getSnapshot();await h.clock.advance(499000);
  assert.ok((await h.client.getSnapshot()).activeOperations.includes(second.operationId));
  await h.clock.advance(1000);
  assert.ok(!(await h.client.getSnapshot()).activeOperations.includes(second.operationId));
  for(const op of [first,second])assert.equal((await h.result(op.operationId)).error.details.cause.kind,"authored-deadline");
  h.release.resolve();await bounded(h.retired.promise,"causal authorization retired");
  assert.deepEqual(h.writes,[]);assert.deepEqual(h.authorized,[first.operationId]);
});
test("C2 final decision and native acceptance precede an already-ready input turn",{timeout:8000},async t=>{
  const h=await make(t,"accept",{gate:"atomic"}),op=await h.start();
  assert.equal((await h.result(op.operationId)).outcome,"completed");
  const alarm=await h.start("alarm");assert.equal((await h.result(alarm.operationId)).result,"message:alarm:ALARM");
  assert.ok(h.order.indexOf("write")<h.order.indexOf("input"),JSON.stringify(h.order));
  assert.deepEqual(h.writes,[[...Buffer.from("QUERY\r\n")]]);
});
const base=await admitAuthoredModule(inputs(source),wasm);
for(const [name,change,code] of [
  ["C4 deadline is not entry authority",d=>d.entry.requires.push("operation.deadline"),"authored.declaration.invalid"],
  ["C4 deadline is not handler authority",d=>d.handlers[0].requires.push("operation.deadline"),"authored.declaration.invalid"],
  ["absent route",d=>d.operations[0].writeVia="missing","authored.declaration.invalid"],
  ["missing authorization",d=>delete d.handlers[0].authorizeWrite,"authored.declaration.invalid"],
  ["orphan binding",d=>{delete d.operations[0].writeVia;d.operations[0].requires=["mailbox"];},"authored.declaration.invalid"],
  ["missing capability",d=>d.operations[0].requires=["mailbox"],"authored.declaration.invalid"],
  ["unrouted capability",d=>delete d.operations[0].writeVia,"authored.declaration.invalid"],
  ["direct write",d=>d.operations[0].requires.push("channel.write"),"authored.declaration.invalid"],
  ["unresolved binding",d=>d.handlers[0].authorizeWrite="missing","authored.binding.unresolved"],
  ["role reuse",d=>d.handlers[0].authorizeWrite="input","authored.handler.binding-role"],
  ["task reservation",d=>d.handlers[0].maximumConcurrent=31,"authored.handler.task-limit"],
])test("C2 admission: "+name,()=>{const d=structuredClone(base.description);change(d);assert.throws(()=>admitAuthoredDescription(d,base.bindings),e=>e.code===code);});
test("C2 declaration cannot grant a different channel",async()=>{
  let opened=0;
  await assert.rejects(createAuthoredSession(inputs(source),wasm,{platform:"node",clock:new VirtualClock(),
    modeId:"interactive",profileId:"serial",channelId:"other",helpers:{},resourceBroker:{},captureDestinationAdapter:{},
    async open(){opened++;throw new Error("must not run");}}),e=>e.code==="authored.handler.channel-unavailable");
  assert.equal(opened,0);
});
