import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { VirtualClock } from "../../../test-support/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
// Deliberately bypass ONLY nominal-rate admission in this isolated test-file
// process. Runtime bucket, product factory, ordinary operations and native
// writes stay shipped code. No permissive hook exists in the product.
const needle='if (plans.reduce((rate, plan) => rate + 1 / plan.intervalMs, 0) > 1 / policy.refillEveryMs)';
let planted=0;
const hook=registerHooks({load(url,context,next){const loaded=next(url,context);
  if(url.endsWith('/retained-session.ts')){
    const source=String(loaded.source),point='if (!this.#closed && !this.#captureFailure && this.#connection && !this.#entering && !this.#resumeOffer) this.#poll?.resume(this.#options.modeId, this.#generation);';
    assert.equal(source.split(point).length,2);
    // Readiness only: wait until the logical operation's finally has run.
    // The assertion below still observes permits/status and native outcomes.
    return {...loaded,source:source.replace(point,'globalThis[Symbol.for("c5-facade-retired")]?.(this, activation.id); '+point)};
  }
  if(url.endsWith('/authored-poll.ts')){
    const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString();
    assert.ok(source.includes(needle),'nominal-admission bypass target missing');planted++;
    return {...loaded,source:source.replace(needle,'if (false)')};
  }return loaded;
}});
const {createAuthoredSession}=await import('../src/authored-module.ts');hook.deregister();
assert.equal(planted,1,'control must actually bypass nominal admission');
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const bounded=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error(label+' (5000ms hang detector)')),5000);})]);}finally{clearTimeout(timer);}};
async function make(t,{names=1,cells=2,nativeGate=false,nativeReadGate=false,idle=false,body='io.request({kind="write",value="QUERY"}); return "ok"'}={}){
  const source=`local a=pdrv.array;local operations,state={},{}\nfor i=1,${names} do
    local id="query"..i
    operations[i]={id=id,title=id,binding="query",arguments={},result={kind="value",type={kind="string"}},risk="read-only",repeatability="safe-to-repeat",
      locks=a({"protocol"}),requires=a({"channel.write","channel.read"}),availability={modes=a({"main"}),profiles=a({"serial"})}}
    for j=1,${cells} do state["cell"..i.."_"..j]={type={kind="string"},freshForMs=5500,refresh={kind="poll",mode="main",operation=id,
      intervalMs=1,failureBackoffMs=1,suspendWhileLocksHeld=a({"protocol"})${idle?',timing={kind="idle-reset",activity="foreground-lifecycle"}':''}}} end
  end
  return {apiVersion="device/v2",id="poll-native-control",modes=a({"main"}),profiles=a({"serial"}),operations=a(operations),state=state},
    {query=function(args,io) ${body} end}`;
  const clock=new VirtualClock(),writes=[],events=[],waiters=new Set(),gate=Promise.withResolvers(),submitted=Promise.withResolvers();
  const {server}=await createAuthoredSession([{logicalName:'device.lua',sourceBytes:new TextEncoder().encode(source)},
    {logicalName:'pdpkg.json',sourceBytes:new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}')}],wasm,{
    platform:'node',clock,modeId:'main',profileId:'serial',channelId:'main',helpers:{},resourceBroker:{},captureDestinationAdapter:{},
    pollPolicy:{burst:4,refillEveryMs:1000,minimumIntervalMs:1,maximumPlans:4},
    async open(){const c=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'main',profileId:'serial'});
      const channel=c.channel('main'),acquire=channel.acquire.bind(channel);
      if(nativeReadGate)channel.protocolDuplex='half-duplex';
      channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
        if(nativeReadGate)lease.incoming=()=>({[Symbol.asyncIterator](){return this;},
          async next(){submitted.resolve();await gate.promise;return {done:false,value:{bytes:Uint8Array.of(65),atSequence:clock.nextSequence(),atMonotonicUs:clock.monotonicUs()}};},async return(){return {done:true};}});
        lease.write=async bytes=>{writes.push({bytes:[...bytes],at:clock.monotonicUs()});submitted.resolve();const r=await write(bytes);if(nativeGate)await gate.promise;return r;};return lease;};return c;},
  });
  // IDs can repeat across sessions. A late earlier-session finally must not
  // satisfy this session's readiness predicate.
  globalThis[Symbol.for('c5-facade-retired')]=(owner,id)=>{if(owner!==server)return;const e={kind:'test-facade-retired',id};events.push(e);for(const w of waiters)if(w.p(e)){waiters.delete(w);w.y(e);}};
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  await client.attach('C3-runtime');const sub=client.subscribe(e=>{events.push(e);for(const w of waiters)if(w.p(e)){waiters.delete(w);w.y(e);}});
  const wait=async p=>{const old=events.find(p);if(old)return old;let w;try{return await bounded(new Promise(y=>{w={p,y};waiters.add(w);}), 'scheduled observation');}finally{waiters.delete(w);}};
  t.after(async()=>{gate.resolve();sub.dispose();await client.disconnect();await client.close();});
  await client.connect({mode:'main'});
  return {clock,writes,events,client,gate,submitted,wait,async advance(ms){await clock.advance(ms*1000);},
    async retired(n){await wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='retired'&&e.observation.retiredResults===n);}};
}
async function quotaDecision(h){
  const e=await h.wait(e=>e.kind==='scheduled-work'&&((e.observation.kind==='skipped'&&e.observation.reason==='authored.poll.quota-skip')
    || (e.observation.kind==='admitted'&&e.observation.permitsSpent===5)));
  // A debit mutant reaches a real fifth write; fail on bytes, not a missing
  // skip notification or the hang detector.
  if(e.observation.kind==='admitted')await h.retired(5);
}
test('C3 runtime debit stops native writes at four, not four per coalesced cell',{timeout:8000},async t=>{
  const h=await make(t,{cells:2});
  for(let n=1;n<=4;n++){await h.advance(1);await h.retired(n);}
  await h.advance(1);await quotaDecision(h);
  assert.equal(h.writes.length,4);assert.deepEqual(h.writes.map(w=>w.bytes),Array(4).fill([...Buffer.from('QUERY')]));
  const s=(await h.client.getSnapshot()).scheduledWork;
  assert.equal(s.permitsRemaining,0);assert.equal(s.plans.length,1);assert.equal(s.plans[0].cells.length,2);
  await h.advance(995);await h.retired(5);assert.equal(h.writes.length,5);
  await h.advance(1);assert.equal((await h.client.getSnapshot()).scheduledWork.permitsSpent,5);
});
test('C3 renamed plans do not buy another runtime grant',{timeout:8000},async t=>{
  const h=await make(t,{names:4,cells:2});
  for(let n=1;n<=4;n++){await h.advance(1);await h.retired(n);}
  await h.advance(1);await quotaDecision(h);
  assert.equal(h.writes.length,4);assert.equal((await h.client.getSnapshot()).scheduledWork.permitsSpent,4);
});
test('C3 pending native write keeps plan active after cancellation and long elapsed time',{timeout:8000},async t=>{
  const h=await make(t,{nativeGate:true});await h.advance(1);
  const admitted=await h.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='admitted');
  // An admitted event precedes the native call. Wait on actual write acceptance
  // by using its pending operation plus a native receipt observation.
  await bounded(h.submitted.promise,'actual native write');
  const id=admitted.observation.operationId;await h.client.cancelOperation(id);
  await h.advance(5000);
  assert.equal(h.writes.length,1);assert.equal((await h.client.getSnapshot()).scheduledWork.plans[0].activeOperation,id);
  h.gate.resolve();await h.retired(1);await h.advance(1);await h.retired(2);
  assert.equal(h.writes.length,2);
});
test('C3 fatal shared VM ends the service rather than funding a dead context',{timeout:8000},async t=>{
  const h=await make(t,{body:'while true do end'});await h.advance(1);
  await h.wait(e=>e.kind==='connection-close');
  await h.advance(100000);const snapshot=await h.client.getSnapshot();
  assert.equal(snapshot.state,'closed');assert.equal(snapshot.scheduledWork.permitsSpent,1);assert.deepEqual(h.writes,[]);
});
test('C5 cancelled foreground remains busy until the actual native promise settles',{timeout:8000},async t=>{
  const h=await make(t,{idle:true,nativeGate:true});
  const manual=await h.client.startOperation({operation:'query1',arguments:{}});
  await bounded(h.submitted.promise,'foreground native write');
  await h.client.cancelOperation(manual.operationId);
  assert.equal((await h.client.awaitOperation(manual.operationId)).outcome,'cancelled');
  await h.advance(5000);
  const busy=(await h.client.getSnapshot()).scheduledWork;
  assert.equal(busy.plans[0].status,'busy/suppressed');assert.equal(busy.permitsSpent,0);
  assert.equal(h.writes.length,1,'public cancellation cannot authorize a keepalive alongside pending native work');
  h.gate.resolve();await h.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='idle-reset'&&e.observation.operationId===manual.operationId);
  await h.advance(1);await h.retired(1);assert.equal(h.writes.length,2);assert.equal(h.writes[1].at,5001000);
});
test('C5 cancelled half-duplex receive stays busy until native next settles',{timeout:8000},async t=>{
  const h=await make(t,{idle:true,nativeReadGate:true,body:'io.request({kind="read",maximum=1}); return "ok"'});
  const manual=await h.client.startOperation({operation:'query1',arguments:{}});
  await bounded(h.submitted.promise,'native next submitted');await h.client.cancelOperation(manual.operationId);
  await h.wait(e=>e.kind==='test-facade-retired'&&e.id===manual.operationId);
  await h.advance(5000);const s=(await h.client.getSnapshot()).scheduledWork;
  assert.equal(s.plans[0].status,'busy/suppressed');assert.equal(s.permitsSpent,0);
  h.gate.resolve();await h.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='idle-reset'&&e.observation.operationId===manual.operationId);
  await h.advance(1);await h.retired(1);assert.equal((await h.client.getSnapshot()).scheduledWork.permitsSpent,1);
});
