import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {RetainedSessionRpcServer} from '../src/retained-session.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const source=`local a=pdrv.array;local pending=""
local function report(io)io.request({kind="transfer-report",cookie="00",generation=1,committed=0,volatile=0,buffered=0})end
local function wait(io)io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})end
return{apiVersion="device/v2",id="consumed-input",modes=a({"m"}),profiles=a({"p"}),mailboxes=a({"reply"}),
 handlers=a({{id="receiver",binding="receive",inputEvidence="consumed-ranges",event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=a({"parser"}),requires=a({"channel.input","mailbox"})}}),
 operations=a({{id="probe",title="probe",binding="run",arguments={image={kind="byte-source",minimumBytes=1,maximumBytes=1}},result={kind="none"},risk="changes-state",repeatability="not-repeatable",locks=a({}),requires=a({"mailbox","transfer.checkpoint"}),availability={modes=a({"m"}),profiles=a({"p"})},
 transfer={sourceArgument="image",targetOffset=0,targetLength=1,resumeBinding="resume",finalization="repeatable"}}})},
{run=function(_,io)io.request({kind="transfer-open"});wait(io);report(io);wait(io);report(io);pdrv.fail("probe.complete",{})end,
 resume=function()end,
 receive=function(args,io)
  pending=pending..args.input
  while true do local n=pending:find("\\n",1,true);if not n then break end
   pending=pending:sub(n+1)
   io.request({kind="input-consume",length=n})
   io.request({kind="message-send",mailbox="reply",value="decoded"})
  end
 end}
`;
const inputs=s=>[{logicalName:'device.lua',sourceBytes:Buffer.from(s)},{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}];
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('consumed-input boundary did not settle (3000ms)')),3000);})]);}finally{clearTimeout(timer);}}
async function harness(t,code=source){
 const module=await admitAuthoredModule(inputs(code),wasm),execution=await module.openExecution(),clock=new VirtualClock(),store=new InMemoryTransferCheckpointStore();
 const events=[],waiters=new Set(),commits=[];let connection;
 const emit=e=>{events.push(e);for(const w of waiters)if(w.p(e)){waiters.delete(w);w.y(e);}};
 const wait=p=>{const e=events.find(p);return e?Promise.resolve(e):bounded(new Promise(y=>waiters.add({p,y})));};
 const commit=store.commit.bind(store);store.commit=async(...args)=>{const value=await commit(...args);commits.push(value);return value;};
 const observed=(id,r)=>{emit({id,kind:r.value?.kind});return r;};
 const host=new ResourceBrokerHost();let read=false;
 const resource=await host.registerSource({origin:'memory',byteLength:1,async seek(n){assert.equal(n,0);read=false;},async read(into){const n=read?0:1;if(n)into[0]=65;read=true;return{bytesRead:n,eof:true};},async close(){}},{kind:'session',sessionId:'test'});
 const server=new RetainedSessionRpcServer({platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),captureDestinationAdapter:{},checkpointStore:store,
  capabilities:{mailbox:{available:true},'transfer.checkpoint':{available:true},'connection.lifecycle':{available:true}},
  executionIdentity:{digest:module.identity.digest},checkpointPolicyDigest:'a'.repeat(64),
  description:module.description,operations:module.description.operations.map(o=>o.id),logicalDevice:module.description.id,channelRoles:module.description.channelRoles?.p,
  execution:{...execution,async startOperation(id,...args){return observed(id,await execution.startOperation(id,...args));},
   async dispatch(id,...args){return observed(id,await execution.dispatch(id,...args));},async retire(id){await execution.retire(id);emit({id,kind:'retired'});}},
  async open(){const multi=module.description.channelRoles!==undefined;
   const c=new MockTransport(clock).openConnection({...(multi?{channelIds:['requests','responses','events']}:{}),identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
   if(multi)for(const ch of c.channels)ch.direction=ch.id==='requests'?'out':'in';connection=c;return c;}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{await client.disconnect();await client.close();await host.endSession('test');});await client.attach('F55');await client.connect({mode:'m'});
 const op=await client.startOperation({operation:'probe',arguments:{image:{kind:'resource',id:resource}}});
 await Promise.race([wait(e=>e.id===op.operationId&&e.kind==='message-wait'),client.awaitOperation(op.operationId).then(r=>{throw Error('probe ended before receive: '+JSON.stringify(r));})]);
 return{client,op,commits,events,wait,inject:(v,ch='main')=>connection.channel(ch).enqueueReceived(Buffer.from(v)),result:()=>bounded(client.awaitOperation(op.operationId)),
 async another(){let read=false;const id=await host.registerSource({origin:'memory',byteLength:1,async seek(){read=false;},async read(into){const n=read?0:1;if(n)into[0]=65;read=true;return{bytesRead:n,eof:true};},async close(){}},{kind:'session',sessionId:'test'});
  const op=await client.startOperation({operation:'probe',arguments:{image:{kind:'resource',id}}});await wait(e=>e.id===op.operationId&&e.kind==='message-wait');return()=>bounded(client.awaitOperation(op.operationId));}};
}
test('consumed ranges: two frames in one read back two reports',{timeout:5000},async t=>{
 const h=await harness(t);h.inject('A\nB\n');const r=await h.result();assert.equal(r.error.code,'lua-vm.invocation.program-failure');assert.match(JSON.stringify(r.error),/probe.complete/);assert.equal(h.commits.length,2);
});
test('consumed ranges span handler activations without counting the tail twice',{timeout:5000},async t=>{
 const h=await harness(t);h.inject('A');await h.wait(e=>e.kind==='retired'&&e.id.includes('handler'));
 h.inject('\nB\n');const r=await h.result();assert.equal(r.error.code,'lua-vm.invocation.program-failure');assert.match(JSON.stringify(r.error),/probe.complete/);assert.equal(h.commits.length,2);
});
test('one frame spans D2 subdivisions of a single native delivery',{timeout:5000},async t=>{
 const h=await harness(t);h.inject('A'.repeat(300)+'\nB\n');const r=await h.result();
 assert.equal(r.error.code,'lua-vm.invocation.program-failure');assert.match(JSON.stringify(r.error),/probe.complete/);assert.equal(h.commits.length,2);
});
test('delivered but unconsumed messages cannot back a transfer report',{timeout:5000},async t=>{
 const h=await harness(t,source.replace('io.request({kind="input-consume",length=n})',''));h.inject('A\nB\n');
 assert.equal((await h.result()).error.code,'authored.transfer.report-unobserved');assert.equal(h.commits.length,0);
});
test('one consumed message cannot back two reports without a second wait',{timeout:5000},async t=>{
 const h=await harness(t,source.replace('report(io);wait(io);report(io)','report(io);report(io)'));h.inject('A\nB\n');
 assert.equal((await h.result()).error.code,'authored.transfer.report-unobserved');assert.equal(h.commits.length,1);
});
test('sending a consumed receipt twice does not copy its authority',{timeout:5000},async t=>{
 const send='io.request({kind="message-send",mailbox="reply",value="decoded"})';
 const h=await harness(t,source.replace(send,send+';'+send));h.inject('A\n');
 assert.equal((await h.result()).error.code,'authored.transfer.report-unobserved');assert.equal(h.commits.length,1);
});
test('one receipt cannot fund reports in two different transfer claims',{timeout:5000},async t=>{
 const send='io.request({kind="message-send",mailbox="reply",value="decoded"})';
 const code=source.replace('wait(io);report(io);wait(io);report(io)','wait(io);report(io)').replace(send,send+';'+send);
 const h=await harness(t,code),other=await h.another();h.inject('A\n');
 const results=await Promise.all([h.result(),other()]);
 assert.deepEqual(results.map(r=>r.error.code).sort(),['authored.transfer.report-unobserved','lua-vm.invocation.program-failure']);assert.equal(h.commits.length,1);
});
test('input consumption cannot claim a byte that has not been delivered',{timeout:5000},async t=>{
 const h=await harness(t,source.replace('length=n','length=n+5'));h.inject('A\nB\n');
 assert.equal((await h.result()).error.code,'retained.input-consumption');assert.equal(h.commits.length,0);
});
test('a consumed byte prefix cannot be claimed again',{timeout:5000},async t=>{
 const send='io.request({kind="message-send",mailbox="reply",value="decoded"})';
 const h=await harness(t,source.replace(send,send+';io.request({kind="input-consume",length=n});'+send));h.inject('A\n');
 assert.equal((await h.result()).error.code,'retained.input-consumption');assert.ok(h.commits.length<=1);
});
test('ordinary operations cannot consume a handler byte range',{timeout:5000},async t=>{
 const h=await harness(t,source.replace('wait(io);report(io)','wait(io);io.request({kind="input-consume",length=1});report(io)'));h.inject('A\nB\n');
 assert.equal((await h.result()).error.code,'retained.input-consumption');assert.equal(h.commits.length,0);
});
test('a partial response cannot fund consumption on the USB event channel',{timeout:5000},async t=>{
 const code=source.replace('profiles=a({"p"}),mailboxes=', 'profiles=a({"p"}),channelRoles={p={request="requests",response="responses",event="events"}},mailboxes=')
  .replace('wait(io);report(io);wait(io);report(io)','wait(io);report(io)');
 const h=await harness(t,code);h.inject('A','responses');await h.wait(e=>e.kind==='retired'&&e.id.includes('handler'));
 // Deliberately wrong parser joins endpoints. The host must not let its claim
 // consume the response byte as if it had arrived on events.
 h.inject('B\n','events');assert.equal((await h.result()).error.code,'retained.input-consumption');assert.equal(h.commits.length,0);
});
test('reacquisition cannot spend an earlier generation unconsumed prefix',{timeout:5000},async t=>{
 const code=source.replace('id="consumed-input",','id="consumed-input",invalidation="invalidate",')
  .replace('operations=a({','operations=a({{id="reset",title="reset",binding="reset",arguments={},result={kind="none"},risk="changes-state",repeatability="not-repeatable",locks=a({}),requires=a({"connection.lifecycle"}),availability={modes=a({"m"}),profiles=a({"p"})}},')
  .replace('{run=function','{invalidate=function()end,reset=function(_,io)local c=io.request({kind="connection-grant"}):match("^([^|]+)");io.request({kind="connection-close",connection=c});io.request({kind="connection-reacquire"})end,run=function')
  .replace('wait(io);report(io);wait(io);report(io)','wait(io);report(io)');
 const h=await harness(t,code);h.inject('A');await h.wait(e=>e.kind==='retired'&&e.id.includes('handler'));
 const reset=await h.client.startOperation({operation:'reset',arguments:{}}),r=await h.client.awaitOperation(reset.operationId);assert.equal(r.outcome,'completed',JSON.stringify(r));
 const other=await h.another();h.inject('\n');
 // Lua deliberately retains A; the new native generation supplies only one
 // byte. Keeping the old host cursor would wrongly authorize length two.
 assert.equal((await other()).error.code,'retained.input-consumption');assert.equal(h.commits.length,0);
});
test('consumed-range declaration is exact and participates in identity',{timeout:5000},async()=>{
 const m=await admitAuthoredModule(inputs(source),wasm),legacy=await admitAuthoredModule(inputs(source.replace('inputEvidence="consumed-ranges",','')),wasm);
 assert.notDeepEqual(m.canonicalBytes,legacy.canonicalBytes);
 for(const value of [null,true,'messages',0]){const d=structuredClone(m.description);d.handlers[0].inputEvidence=value;
  assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');}
});
