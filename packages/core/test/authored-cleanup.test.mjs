import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule,createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const limits={maximumMilliseconds:50,maximumLuaFuel:100000,maximumWork:100000};
function source(body,restore='io.request({kind="write",value="RESTORED"})',bounds=limits){
 return `local a=pdrv.array
 return {apiVersion="device/v2",id="cleanup-test",modes=a({"m"}),profiles=a({"p"}),operations=a({
 {id="run",title="run",binding="run",arguments={},result={kind="value",type={kind="string"}},risk="changes-state",repeatability="not-repeatable",
 locks=a({"protocol"}),requires=a({"channel.read","channel.write","timer","operation.deadline"}),availability={modes=a({"m"}),profiles=a({"p"})},
 cleanup={binding="restore",requires=a({"channel.read","channel.write","timer"}),maximumMilliseconds=${bounds.maximumMilliseconds},maximumLuaFuel=${bounds.maximumLuaFuel},maximumWork=${bounds.maximumWork}}}
 })},{run=function(_,io) ${body} end,restore=function(args,io) ${restore} end}`;
}
async function harness(t,body,restore,bounds=limits,options={}){
 const members=[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
  {logicalName:'device.lua',sourceBytes:Buffer.from(source(body,restore,bounds))}];
 const clock=new VirtualClock(),writes=[],reading=Promise.withResolvers(),submitted=Promise.withResolvers(),release=Promise.withResolvers();
 let connection;
 const {server}=await createAuthoredSession(members,wasm,{platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:{},captureDestinationAdapter:{},
  async open(){connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
   const ch=connection.channel('main'),acquire=ch.acquire.bind(ch);ch.protocolDuplex='half-duplex';ch.acquire=async(...args)=>{const lease=await acquire(...args),incoming=lease.incoming.bind(lease);
    lease.incoming=()=>{const it=incoming()[Symbol.asyncIterator]();return {[Symbol.asyncIterator](){return this;},next(){reading.resolve();return it.next();},return(){return it.return?.();}};};
    lease.write=async bytes=>{writes.push(Buffer.from(bytes).toString());submitted.resolve();if(options.holdWrite)await release.promise;
     if(writes.length===1&&options.writeError)throw options.writeError;
     if(writes.length===1&&options.writeOutcome)return {atSequence:clock.nextSequence(),outcome:options.writeOutcome};
     return {atSequence:clock.nextSequence(),outcome:{kind:'accepted-by-platform'}};};
    if(options.synchronousWriteError){const write=lease.write;lease.write=bytes=>{
     if(writes.length===0){writes.push(Buffer.from(bytes).toString());throw options.synchronousWriteError;}return write(bytes);};}
    return lease;};return connection;},...options.session});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{release.resolve();await client.disconnect();await client.close();});
 await client.attach('cleanup');await client.connect({mode:'m'});
 return {client,clock,writes,reading:reading.promise,submitted:submitted.promise,release,
  start:()=>client.startOperation({operation:'run',arguments:{}})};
}
for(const kind of ['rejected','may-be-partial','thrown','thrown-sync','thrown-partial','authored'])test('D6 terminal write disposition: '+kind,{timeout:3000},async t=>{
 const writeOutcome=kind==='rejected'?{kind,error:{code:'platform.refused',message:'not submitted'}}:
  kind==='may-be-partial'?{kind,knownAcceptedBytes:1,possiblyAcceptedBytesUpTo:8}:undefined;
 const writeError=kind==='thrown'||kind==='thrown-partial'?{error:{code:kind==='thrown'?'retained.write-rejected':'retained.write-may-be-partial',message:'not a receipt'}}:undefined;
 const synchronousWriteError=kind==='thrown-sync'?{error:{code:'retained.write-rejected',message:'not a receipt'}}:undefined;
 const code=kind==='authored'?'lua-vm.invocation.program-failure':kind.startsWith('thrown')?'retained.write-indeterminate':'retained.write-'+kind;
 const body=kind==='authored'?'pdrv.fail("retained.write-rejected",{})':
  'pcall(function()io.request({kind="write",value="ORDINARY"})end);io.request({kind="write",value="FORBIDDEN"});return "wrong"';
 const h=await harness(t,body,'local keys={};for k in pdrv.record_fields(args)do keys[#keys+1]=k end;io.request({kind="write",value=table.concat(keys,",")..":"..args.outcome..":"..args.code})',limits,{writeOutcome,writeError,synchronousWriteError});
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.equal(r.error.code,code);
 assert.deepEqual(h.writes,[...(kind==='authored'?[]:['ORDINARY']),'code,outcome:failed:'+code]);
 if(writeOutcome)assert.deepEqual(r.error.details.outcome,writeOutcome);
});
for(const kind of ['normal','local-error','cancel','deadline'])test('D6 distinct cleanup restores after '+kind,{timeout:3000},async t=>{
 const body=kind==='normal'?'return "ok"':kind==='local-error'?'pdrv.fail("local-failure",{})':
  `${kind==='deadline'?'io.request({kind="deadline-arm",milliseconds=1})':''} io.request({kind="read",maximum=1});io.request({kind="write",value="FORBIDDEN"});return "wrong"`;
 const h=await harness(t,body),op=await h.start();
 if(kind==='cancel'||kind==='deadline'){await h.reading;if(kind==='cancel')await h.client.cancelOperation(op.operationId);else await h.clock.advance(1000);}
 const result=await h.client.awaitOperation(op.operationId);
 assert.equal(result.outcome,kind==='normal'?'completed':kind==='local-error'?'failed':'cancelled',JSON.stringify(result));
 assert.deepEqual(h.writes,['RESTORED']);
 if(kind==='cancel'||kind==='deadline')assert.equal(result.error.details.cleanup.outcome,'completed');
});
test('D6 cleanup cannot publish an operation result',{timeout:3000},async t=>{
 const h=await harness(t,'return "original"','return "replacement"'),op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.equal(r.error.code,'authored.cleanup.failed');assert.equal(r.result,null);assert.deepEqual(h.writes,[]);
});
test('D6 arbitrary cleanup failure detail cannot consume the terminal runway',{timeout:3000},async t=>{
 const h=await harness(t,'return "ok"','pdrv.fail("cleanup-detail",{payload=string.rep("x",12000)})'),op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.equal(r.error.details.cleanup.error.code,'lua-vm.invocation.program-failure');
 assert.equal(r.error.details.cleanup.error.details.detailsOmitted,true);
});
test('D6 cleanup has no deadline renewal authority',{timeout:3000},async t=>{
 const h=await harness(t,'return "ok"','io.request({kind="deadline-arm",milliseconds=999});io.request({kind="write",value="FORBIDDEN"})');
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.error.details.cleanup.error.code,'authored.cleanup.authority');assert.deepEqual(h.writes,[]);
});
test('D6 insufficient prepaid work refuses before any operation effect',{timeout:3000},async t=>{
 const h=await harness(t,'io.request({kind="write",value="FORBIDDEN"});return "ok"',undefined,limits,{session:{maximumEffectWork:100000}});
 await assert.rejects(h.start(),e=>e.error?.code==='authored.cleanup.budget');assert.deepEqual(h.writes,[]);
});
test('D6 cleanup times out while suspended and never resumes its tail',{timeout:3000},async t=>{
 const h=await harness(t,'return "ok"','io.request({kind="read",maximum=1});io.request({kind="write",value="FORBIDDEN"})');
 const op=await h.start();await h.reading;await h.clock.advance(50000);const r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.error.details.cleanup.error.code,'authored.cleanup.timeout');assert.deepEqual(h.writes,[]);
});
test('D6 unresolved ordinary write blocks cleanup rather than reordering it',{timeout:3000},async t=>{
 const h=await harness(t,'io.request({kind="write",value="ORDINARY"});io.request({kind="write",value="LATE"});return "ok"',undefined,limits,{holdWrite:true});
 const op=await h.start();await h.submitted;await h.client.cancelOperation(op.operationId);const r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'cancelled');assert.equal(r.error.details.cleanup.error.code,'retained.outbound-unresolved');assert.deepEqual(h.writes,['ORDINARY']);
 h.release.resolve();assert.deepEqual(await h.client.awaitOperation(op.operationId),r);
});
test('D6 Lua exhaustion is sticky and cannot enter cleanup',{timeout:3000},async t=>{
 const h=await harness(t,'pcall(function() while true do end end);return "wrong"'),op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.equal(r.error.details.cleanup.outcome,'skipped');assert.deepEqual(h.writes,[]);
});
test('D6 ordinary Lua cannot spend its withheld cleanup fuel',{timeout:3000},async t=>{
 const h=await harness(t,'local sum=0;for i=1,460000 do sum=sum+i end;io.request({kind="write",value="FORBIDDEN"});return "ok"');
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.deepEqual(h.writes,[]);assert.equal(r.error.code,'lua-vm.resource.fuel-exhausted');assert.equal(r.error.details.cleanup.outcome,'skipped');
});
test('D6 cleanup fuel itself is finite and exhaustion cannot restore success',{timeout:3000},async t=>{
 const h=await harness(t,'return "ok"','pcall(function() while true do end end);io.request({kind="write",value="FORBIDDEN"})');
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.error.details.cleanup.error.code,'lua-vm.resource.fuel-exhausted');assert.equal(r.error.details.cleanup.consumed,100000);assert.deepEqual(h.writes,[]);
});
test('D6 finite cleanup computation fits only its declared Lua partition',{timeout:3000},async t=>{
 const body=count=>`local sum=0;for i=1,${count} do sum=sum+i end;io.request({kind="write",value="RESTORED"})`;
 const positive=await harness(t,'return "ok"',body(20000)),p=await positive.start();
 assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');assert.deepEqual(positive.writes,['RESTORED']);
 const limited=await harness(t,'return "ok"',body(60000)),q=await limited.start(),r=await limited.client.awaitOperation(q.operationId);
 assert.deepEqual(limited.writes,[]);assert.equal(r.error.details.cleanup.error.code,'lua-vm.resource.fuel-exhausted');
});
test('D6 cleanup native work is its declared partition, not the global allowance',{timeout:3000},async t=>{
 const body='for i=1,20 do io.request({kind="write",value="step"}) end;io.request({kind="write",value="RESTORED"})';
 const positive=await harness(t,'return "ok"',body),p=await positive.start();
 assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');assert.equal(positive.writes.at(-1),'RESTORED');
 const limited=await harness(t,'return "ok"',body,{...limits,maximumWork:5000}),q=await limited.start(),r=await limited.client.awaitOperation(q.operationId);
 assert.ok(!limited.writes.includes('RESTORED'));assert.equal(r.outcome,'failed');assert.equal(r.error.details.cleanup.error.code,'retained.work-exhausted');
});
test('D6 ordinary native work cannot consume prepaid cleanup work',{timeout:3000},async t=>{
 // Fits 30,000, but not the 20,000 left after reserving 10,000 for cleanup.
 const body='for i=1,16 do io.request({kind="write",value="step"}) end;io.request({kind="write",value="ORDINARY-END"});return "ok"';
 const positive=await harness(t,body,undefined,{...limits,maximumWork:10000},{session:{maximumEffectWork:40000}}),p=await positive.start();
 assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');assert.ok(positive.writes.includes('ORDINARY-END'));
 const h=await harness(t,body,undefined,{...limits,maximumWork:10000},{session:{maximumEffectWork:30000}});
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.ok(!h.writes.includes('ORDINARY-END'));assert.equal(r.outcome,'failed');assert.equal(r.error.code,'retained.work-exhausted');
});
for(const [key,value] of [['maximumMilliseconds',10001],['maximumLuaFuel',100001],['maximumWork',3200001],['maximumMilliseconds',0],['maximumWork',1.5]])
 test('D6 admission refuses cleanup '+key+'='+value,{timeout:3000},async()=>{
  const members=[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
   {logicalName:'device.lua',sourceBytes:Buffer.from(source('return "ok"',undefined,{...limits,[key]:value}))}];
  await assert.rejects(admitAuthoredModule(members,wasm),e=>e.code==='authored.declaration.invalid');
 });
test('D6 cleanup retirement must fit before ordinary success is published',{timeout:3000},async t=>{
 const positive=await harness(t,'return "ok"','return',{...limits,maximumLuaFuel:100}),p=await positive.start();
 assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');
 const limited=await harness(t,'return "ok"','return',{...limits,maximumLuaFuel:60}),q=await limited.start(),r=await limited.client.awaitOperation(q.operationId);
 assert.equal(r.outcome,'failed','binding return is not completion of its funded retirement');
 assert.equal(r.error.details.cleanup.error.code,'lua-vm.resource.fuel-exhausted');
});
test('D6 cleanup retains channel exclusion and cannot be cancelled into another grant',{timeout:3000},async t=>{
 const h=await harness(t,'return "ok"','io.request({kind="read",maximum=1})'),op=await h.start();await h.reading;
 await assert.rejects(h.start(),e=>e.error?.code==='retained.channel-busy');
 await h.client.cancelOperation(op.operationId);await h.client.cancelOperation(op.operationId);
 await h.clock.advance(50000);const r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.error.details.cleanup.error.code,'authored.cleanup.timeout');assert.deepEqual(h.writes,[]);
});
