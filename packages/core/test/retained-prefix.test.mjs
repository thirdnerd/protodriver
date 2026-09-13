import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {RetainedSessionRpcServer} from '../src/retained-session.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const source=`local a=pdrv.array;local prefixes={};local offers=0
return{apiVersion="device/v2",id="retained-prefix",modes=a({"m"}),profiles=a({"p"}),mailboxes=a({"reply"}),
 channelRoles={p={request="requests",response="responses",event="events"}},
 entry={binding="entry",handoffTo="receiver",inputEvidence="consumed-ranges",locks=a({"entry"}),requires=a({"channel.read","channel.write"})},
 handlers=a({{id="receiver",binding="receive",acceptHandoff="accept",inputEvidence="consumed-ranges",event={kind="channel-input",channelId="main"},maximumConcurrent=2,locks=a({"parser"}),requires=a({"channel.input","channel.write","mailbox"})}}),
 operations=a({{id="collect",title="collect",binding="collect",arguments={},result={kind="value",type={kind="string"}},risk="read-only",repeatability="safe-to-repeat",locks=a({}),requires=a({"mailbox"}),availability={modes=a({"m"}),profiles=a({"p"})}}})},
{entry=function(_,io)
 io.request({kind="write",value="HELLO"})
 for i=1,2 do local b=io.request({kind="read",maximum=2});local ch=io.request({kind="input-channel"});prefixes[ch]=b end
 local answer=io.request({kind="entry-handoff",parser="retained-prefixes",timers="none"})
 if answer=="refused" then answer=io.request({kind="entry-handoff",parser="retained-prefixes",timers="none"})end
 assert(answer=="accepted")
 -- STALE
 end,
 accept=function(o,io)
  offers=offers+1;assert(o.parser=="retained-prefixes" and #o.prefixes==2)
  for _,p in ipairs(o.prefixes)do assert(p["end"]-p.start==#prefixes[p.channelId])end
  return{accepted=true}
 end,
 receive=function(args,io)
  local b=(prefixes[args.channelId] or "")..args.input;prefixes[args.channelId]=nil
  io.request({kind="input-consume",length=#b});io.request({kind="write",value=b})
  io.request({kind="message-send",mailbox="reply",value=b})
 end,
 collect=function(_,io)return io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})end}
`;
const inputs=code=>[{logicalName:'device.lua',sourceBytes:Buffer.from(code)},{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}];
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('retained-prefix control did not settle (3000ms)')),3000);})]);}finally{clearTimeout(timer);}}
async function make(t,code=source){
 const module=await admitAuthoredModule(inputs(code),wasm),execution=await module.openExecution(),clock=new VirtualClock();
 const arrived=Promise.withResolvers(),release=Promise.withResolvers(),ingress=Promise.withResolvers(),written=Promise.withResolvers(),closed=Promise.withResolvers(),writes=[],offers=[];let connection,readTails=0;
 const server=new RetainedSessionRpcServer({platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',channelRoles:module.description.channelRoles.p,
  description:module.description,operations:['collect'],logicalDevice:module.description.id,helpers:{},resourceBroker:{},captureDestinationAdapter:{},capabilities:{mailbox:{available:true}},
  execution:{...execution,async startOperation(...args){if(args[1]==='accept'){offers.push(args[2]);arrived.resolve();await release.promise;}
   return execution.startOperation(...args);}},
  async open(){connection=new MockTransport(clock).openConnection({channelIds:['requests','responses','events'],modeId:'m',profileId:'p',identity:{transport:'mock',stableKeyAssurance:'none'}});
   for(const ch of connection.channels){ch.direction=ch.id==='requests'?'out':'in';const acquire=ch.acquire.bind(ch);ch.acquire=async(...args)=>{
    const lease=await acquire(...args),write=lease.write.bind(lease),incoming=lease.incoming.bind(lease);
    lease.incoming=async function*(){for await(const chunk of incoming()){if(['12','34'].includes(Buffer.from(chunk.bytes).toString())&&++readTails===2)ingress.resolve();yield chunk;}};
    lease.write=async b=>{const value=Buffer.from(b).toString();writes.push(value);const r=await write(b);
     if(value==='HELLO'){connection.channel('responses').enqueueReceived(Buffer.from('AB'));connection.channel('events').enqueueReceived(Buffer.from('CD'));}
     if(writes.length===3)written.resolve();return r;};return lease;};}return connection;}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));await client.attach('C1.1');
 const sub=client.subscribe(e=>{if(e.kind==='connection-close')closed.resolve(e);});
 t.after(async()=>{release.resolve();sub.dispose();await client.disconnect();await client.close();});
 return{client,writes,offers,release,arrived,closed,connect:()=>client.connect({mode:'m'}),
  async tails(){connection.channel('responses').enqueueReceived(Buffer.from('12'));connection.channel('events').enqueueReceived(Buffer.from('34'));await bounded(ingress.promise);},
  outcome:()=>bounded(Promise.race([written.promise,closed.promise])),
  async collect(){const op=await client.startOperation({operation:'collect',arguments:{}});const r=await bounded(client.awaitOperation(op.operationId));assert.equal(r.outcome,'completed');return r.result;}};
}
const emptyOffer=source.replace('local answer=io.request',
 'assert(io.request({kind="entry-handoff",parser="empty",timers="none"})=="refused","pending prefix cannot be empty");local answer=io.request')
 .replace('offers=offers+1;assert', 'offers=offers+1;if o.parser=="empty" then return{accepted=true}end;assert');
for(const [name,code,count] of [['accept',source,1],['refuse then reoffer',source.replace('return{accepted=true}','return{accepted=offers>1}'),2],['empty form refuses before recipient',emptyOffer,1]])
test('retained prefixes '+name+': distinct channel bytes survive pending acceptance',{timeout:5000},async t=>{
 const h=await make(t,code),connection=h.connect().then(()=>null,e=>e);await bounded(h.arrived.promise);assert.deepEqual(h.writes,['HELLO']);
 await h.tails();h.release.resolve();const error=await connection;if(!error)await h.outcome();
 assert.deepEqual(h.writes,['HELLO','AB12','CD34'],'pending prefix custody must preserve exact channel bytes, once');
 assert.equal(error,null,String(error));
 assert.equal(await h.collect(),'message:reply:AB12');assert.equal(await h.collect(),'message:reply:CD34');
 assert.deepEqual(h.offers[0].prefixes.map(p=>[p.channelId,p.start,p.end]),[['responses',0,2],['events',0,2]]);
 assert.equal(h.offers.length,count);
});
test('retained prefixes: stale entry cannot consume after commitment',{timeout:5000},async t=>{
 const h=await make(t,source.replace('-- STALE','io.request({kind="input-consume",length=1});io.request({kind="write",value="BAD"})'));
 const connection=h.connect(),rejected=assert.rejects(connection,e=>e.error?.code==='retained.input-consumption');
 await bounded(h.arrived.promise);h.release.resolve();await rejected;assert.deepEqual(h.writes,['HELLO']);
});
test('retained prefixes: disconnect revokes a pending offer and its attribution',{timeout:5000},async t=>{
 const h=await make(t),connection=h.connect(),rejected=assert.rejects(connection,e=>e.error?.code==='retained.cancelled');
 await bounded(h.arrived.promise);await h.tails();await h.client.disconnect();h.release.resolve();await rejected;assert.deepEqual(h.writes,['HELLO']);
});
test('retained prefixes require matching entry and receiver admission',{timeout:5000},async()=>{
 const m=await admitAuthoredModule(inputs(source),wasm);
 for(const mutate of [d=>delete d.entry.handoffTo,d=>delete d.handlers[0].inputEvidence,d=>d.entry.inputEvidence='invented']){
  const d=structuredClone(m.description);mutate(d);assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');}
});
