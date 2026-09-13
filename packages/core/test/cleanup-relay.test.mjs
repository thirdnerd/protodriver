import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {RetainedSessionRpcServer} from '../src/retained-session.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const source=`local a=pdrv.array
local pending=""
local function op(id,cleanup)
 return{id=id,title=id,binding="run",arguments={},result={kind="none"},risk="changes-state",repeatability="not-repeatable",
 locks=a({}),requires=a({"mailbox","channel.write-via"}),writeVia="receiver",availability={modes=a({"m"}),profiles=a({"p"})},
 cleanup={binding=cleanup,writeVia="receiver",requires=a({"channel.write-via","mailbox"}),maximumMilliseconds=100,maximumLuaFuel=10000,maximumWork=100000}}
end
local function restore(io,letter)
 io.request({kind="write-via",value=letter})
 if letter=="A" then
  assert(io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})=="message:reply:OLD")
  assert(io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})=="message:reply:PARTIAL")
  assert(io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})=="message:reply:ACK")
 end
end
return{apiVersion="device/v2",id="cleanup-relay",modes=a({"m"}),profiles=a({"p"}),mailboxes=a({"hold","reply"}),
 handlers=a({{id="receiver",binding="input",authorizeWrite="authorize",event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=a({"parser"}),requires=a({"channel.input","channel.write","mailbox"})}}),
 operations=a({op("a","cleanup_a"),op("b","cleanup_b")})},
{run=function(_,io)io.request({kind="message-wait",mailboxes=a({"hold"}),timers=a({})});io.request({kind="write-via",value="LATE"})end,
 cleanup_a=function(_,io)restore(io,"A")end,cleanup_b=function(_,io)restore(io,"B")end,
 authorize=function(r,io)
  if r.origin=="operation" then return{accepted=r.cleanupOf=="" and r.bytes=="LATE"}end
  assert(r.origin=="cleanup" and r.cleanupOf~="" and r.operationId~=r.cleanupOf)
  if r.bytes=="A" then for i=1,16 do io.request({kind="reschedule"})end end
  return{accepted=(r.operation=="a" and r.bytes=="A") or (r.operation=="b" and r.bytes=="B")}
 end,
 input=function(args,io)
  if args.input=="BUSY" then io.request({kind="write",value="BUSY"});return end
  pending=pending..args.input
  while true do local at=pending:find("\\n",1,true);if not at then break end
   local line=pending:sub(1,at-1);pending=pending:sub(at+1)
   io.request({kind="message-send",mailbox="reply",value=line})
  end
 end}
`;
const inputs=s=>[{logicalName:'device.lua',sourceBytes:Buffer.from(s)},{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}];
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('cleanup control boundary not reached (3000ms)')),3000);})]);}finally{clearTimeout(timer);}}
async function harness(t,{refuse=false,gate=false,raw=false}={}){
 let code=source;
 if(refuse)code=code.replace('return{accepted=(r.operation==','return{accepted=false and (r.operation==');
 if(raw)code=code.replace('io.request({kind="write-via",value=letter})','io.request({kind="read",maximum=1})');
 const module=await admitAuthoredModule(inputs(code),wasm),execution=await module.openExecution(),clock=new VirtualClock();
 const events=[],waiters=new Set(),writes=[],authorizations=[],release=Promise.withResolvers();let channel;
 const emit=e=>{events.push(e);for(const w of waiters)if(w.p(e)){waiters.delete(w);w.y(e);}};
 const wait=p=>{const e=events.find(p);return e?Promise.resolve(e):bounded(new Promise(y=>waiters.add({p,y})));};
 const observed=(id,r)=>{emit({id,kind:r.value?.kind});return r;};
 const server=new RetainedSessionRpcServer({platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:{},captureDestinationAdapter:{},
  description:module.description,operations:['a','b'],logicalDevice:module.description.id,
  capabilities:{mailbox:{available:true},'channel.write-via':{available:true}},
  execution:{...execution,async startOperation(id,binding,args,...rest){
   if(binding==='authorize'){authorizations.push(args);emit({kind:'authorization',id});if(gate&&authorizations.length===1)await release.promise;}
   return observed(id,await execution.startOperation(id,binding,args,...rest));
  },async dispatch(id,...args){return observed(id,await execution.dispatch(id,...args));},async retire(id){await execution.retire(id);emit({kind:'retired',id});}},
  async open(){const c=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});channel=c.channel('main');const acquire=channel.acquire.bind(channel);
   channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{
    const text=Buffer.from(bytes).toString();writes.push(text);emit({kind:'write',text});const receipt=await write(bytes);
    if(text==='BUSY')await release.promise;
    if(text==='A')channel.enqueueReceived(Buffer.from('TIAL\nACK\n'));
    return receipt;
   };return lease;};return c;}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{release.resolve();await client.disconnect();await client.close();});await client.attach('D6.4');await client.connect({mode:'m'});
 return{client,clock,writes,authorizations,release,events,wait,inject:v=>channel.enqueueReceived(Buffer.from(v)),
 async start(name='a'){const op=await client.startOperation({operation:name,arguments:{}});await wait(e=>e.id===op.operationId&&e.kind==='message-wait');return op.operationId;},
 async result(id){return bounded(client.awaitOperation(id));},async prefix(){channel.enqueueReceived(Buffer.from('OLD\nPAR'));await wait(e=>e.kind==='retired'&&e.id.includes('handler'));}};
}
test('D6.4 preserves a queued reply and partial input across cancellation with one receiver',{timeout:5000},async t=>{
 const h=await harness(t),id=await h.start();await h.prefix();await h.client.cancelOperation(id);const result=await h.result(id);
 assert.deepEqual(h.writes,['A']);assert.equal(result.outcome,'cancelled');assert.equal(result.error.details.cleanup.outcome,'completed');
 assert.equal(h.authorizations.length,1);assert.equal(h.authorizations[0].cleanupOf,id);assert.equal(h.authorizations[0].operation,'a');
 assert.ok(result.error.details.cleanup.work>0&&result.error.details.cleanup.work<=100000);
 h.inject('TAIL\n');await h.client.getSnapshot();assert.deepEqual(h.writes,['A']);
});
test('D6.4 owner refusal prevents cleanup bytes',{timeout:5000},async t=>{
 const h=await harness(t,{refuse:true}),id=await h.start();await h.client.cancelOperation(id);const result=await h.result(id);
 assert.deepEqual(h.writes,[]);assert.equal(result.error.details.cleanup.error.code,'retained.relay-refused');assert.equal(result.outcome,'cancelled');
});
test('D6.4 route cannot acquire direct consuming authority',{timeout:5000},async t=>{
 const h=await harness(t,{raw:true}),id=await h.start();await h.client.cancelOperation(id);const result=await h.result(id);
 assert.deepEqual(h.writes,[]);assert.equal(result.error.details.cleanup.error.code,'authored.cleanup.authority');
});
test('D6.4 unresolved owner write prevents overlapping cleanup submission',{timeout:5000},async t=>{
 const h=await harness(t),id=await h.start('b');h.inject('BUSY');await h.wait(e=>e.kind==='write'&&e.text==='BUSY');
 await h.client.cancelOperation(id);const result=await h.result(id);
 assert.deepEqual(h.writes,['BUSY'],'cleanup B must not overlap the still-unsettled native write');
 assert.equal(result.error.details.cleanup.error.code,'retained.outbound-unresolved');h.release.resolve();
});
test('D6.4 cleanup authorization serializes actual writes while first approval yields',{timeout:5000},async t=>{
 const h=await harness(t,{gate:true}),first=await h.start('a'),second=await h.start('b');await h.prefix();
 await h.client.cancelOperation(first);await h.wait(e=>e.kind==='authorization');await h.client.cancelOperation(second);h.release.resolve();
 const results=await Promise.all([h.result(first),h.result(second)]);
 assert.deepEqual(h.writes,['A'],'second cleanup must not authorize and submit ahead of the first');
 assert.equal(results[1].error.details.cleanup.error.code,'retained.outbound-unresolved');
 for(const result of results)assert.equal(result.outcome,'cancelled');
});
test('D6.4 explicit cleanup-only route admits; inherited, absent and raw routes do not',async()=>{
 const m=await admitAuthoredModule(inputs(source),wasm),base=structuredClone(m.description);
 for(const op of base.operations){delete op.writeVia;op.requires=['mailbox'];}
 assert.doesNotThrow(()=>admitAuthoredDescription(structuredClone(base),m.bindings));
 for(const change of [d=>delete d.operations[0].cleanup.writeVia,d=>{d.operations[0].cleanup.writeVia='absent';},
  d=>d.operations[0].cleanup.requires.push('channel.read'),d=>{delete d.operations[0].cleanup.writeVia;d.operations[0].cleanup.requires=['mailbox'];}]){
  const d=structuredClone(base);change(d);assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');
 }
});
test('D6.4 generation loss while approval is pending prevents late cleanup bytes',{timeout:5000},async t=>{
 const h=await harness(t,{gate:true}),id=await h.start('b');await h.client.cancelOperation(id);await h.wait(e=>e.kind==='authorization');
 await bounded(h.client.disconnect());h.release.resolve();const r=await h.result(id);
 assert.deepEqual(h.writes,[]);assert.equal(r.outcome,'cancelled');assert.notEqual(r.error.details.cleanup.outcome,'completed');
});
test('D6.4 original cleanup wall allowance expires while approval is pending',{timeout:5000},async t=>{
 const h=await harness(t,{gate:true}),id=await h.start('b');await h.client.cancelOperation(id);await h.wait(e=>e.kind==='authorization');
 await h.clock.advance(100000);h.release.resolve();const r=await h.result(id);
 assert.deepEqual(h.writes,[]);assert.equal(r.outcome,'cancelled');assert.equal(r.error.details.cleanup.outcome,'failed');
});
