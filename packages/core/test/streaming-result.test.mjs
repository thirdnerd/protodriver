import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAuthoredSession,admitAuthoredModule} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
import {StreamingResult} from '../src/streaming-result.ts';
import {source,checkpointSource,combinedSource} from '../../../test-support/streaming-result/fixture.mjs';
import {settings as transferSettings} from '../../../test-support/checkpoint-service/fixture.mjs';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {observations} from '../../../test-support/client-harness.mjs';
import {settings as segmentedSettings} from '../../../test-support/fixed-segments/fixture.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const members=code=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
async function local(code=source,opts={}){
 const host=new ResourceBrokerHost(),broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),clock=new VirtualClock();
 const {server}=await createAuthoredSession(members(code),wasm,{clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:broker,platform:'node',
  open:async()=>new MockTransport(clock).openConnection({channelIds:['main'],modeId:'m',profileId:'p'}),...opts});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));await client.attach('streamed-result');await client.connect({mode:'m'});
 return {client,broker,sink:(s,scope={kind:'session',sessionId:'result'})=>host.registerSink(s,scope),
  async start(length,sink){const id=typeof sink==='string'?sink:await this.sink(sink);const op=await client.startOperation({operation:'run',arguments:{length:{kind:'value',value:length}},resultDestinationId:id});return op.operationId;},
  async close(){await client.disconnect();await client.close();await host.endSession('result');}};
}
test('streamed result exceeds 1 MiB using bounded chunks and independent incremental digest',{timeout:15000},async t=>{
 const c=await local(source,{maximumEffectWork:1500000});t.after(()=>c.close());let bytes=0,max=0;const hash=createHash('sha256');
 const id=await c.start(1048577,{async write(b){assert.ok(b.every(n=>n===90));max=Math.max(max,b.length);bytes+=b.length;hash.update(b);},async close(){}});
 const r=await c.client.awaitOperation(id);assert.equal(r.outcome,'completed',JSON.stringify(r.error));assert.equal(bytes,1048577);assert.equal(max,256);
 assert.deepEqual(r.resourceResult.digest,{authority:'host-observed',algorithm:'sha256',value:hash.digest('hex'),subject:{kind:'result-range',domain:'synthetic-target',offset:7,length:1048577}});
 assert.equal(r.outputProgress.complete,true);
});
test('bounded result cap survives; malformed range refuses admission',{timeout:3000},async()=>{
 for(const code of [source.replace(',\n streamed={subject="synthetic-target",offset=7,length={argument="length"}}',''),source.replace('offset=7','offset=-1'),source.replace('argument="length"','argument="missing"')])
  await assert.rejects(admitAuthoredModule(members(code),wasm),e=>e.code==='authored.declaration.invalid');
});
test('host hash work is charged before destination submission, including every byte',{timeout:3000},()=>{
 let work=0;const r=new StreamingResult({kind:'result-range',domain:'target',offset:0,length:256},()=>{if(++work>100)throw Error('exhausted');});
 assert.throws(()=>r.prepare(new Uint8Array(256)),/exhausted/);assert.equal(r.bytes,0);
 const a=new StreamingResult({kind:'result-range',domain:'target',offset:0,length:1},()=>{}),b=new StreamingResult({kind:'result-range',domain:'target',offset:1,length:1},()=>{});
 for(const s of [a,b])s.accept(s.prepare(Uint8Array.of(90)),1);
 assert.equal(a.digest().value,b.digest().value);assert.notDeepEqual(a.digest().subject,b.digest().subject);
});
test('a chunk whose hash reservation cannot fit reaches no native destination',{timeout:3000},async t=>{
 // Fits the call without its hash work, not both upfront obligations.
 const c=await local(source,{maximumEffectWork:11000});t.after(()=>c.close());let bytes=0;
 const r=await c.client.awaitOperation(await c.start(256,{async write(b){bytes+=b.length;},async close(){}}));
 assert.equal(bytes,0);assert.equal(r.outcome,'failed');
});
test('short, excessive and over-chunk results cannot claim a completed digest',{timeout:3000},async t=>{
 for(const [change,length,expected] of [[s=>s.replace('n<args.length','n<args.length-1'),1,0],[s=>s.replace('math.min(256,args.length-n)','256'),1,0],[s=>s.replace('math.min(256,args.length-n)','257'),257,0]]){
  const c=await local(change(source));t.after(()=>c.close());let bytes=0;
  const r=await c.client.awaitOperation(await c.start(length,{async write(b){bytes+=b.length;},async close(){}}));
  assert.equal(r.outcome,'failed');assert.equal(r.resourceResult,undefined);assert.equal(bytes,expected);
 }
});
test('cancelled native write retains its sink until late settlement; restart needs a fresh grant',{timeout:5000},async t=>{
 const c=await local();const gate=Promise.withResolvers(),entered=Promise.withResolvers(),closed=Promise.withResolvers();t.after(async()=>{gate.resolve();await c.close();});
 let writes=0;const sink=await c.sink({async write(){writes++;entered.resolve();await gate.promise;},async close(){closed.resolve();}});
 const id=await c.start(257,sink);await entered.promise;await c.client.cancelOperation(id);const r=await c.client.awaitOperation(id);
 assert.equal(r.outcome,'cancelled');assert.deepEqual([r.outputProgress.acceptedBytes,r.outputProgress.resume],[0,'restart-required']);assert.equal(r.resourceResult,undefined);
 await assert.rejects(c.broker.grantWrite(sink,'another',257,{callId:'another'}));
 gate.resolve();await closed.promise;assert.equal(writes,1);assert.equal((await c.client.awaitOperation(id)).resourceResult,undefined);
 let bytes=0;const second=await c.client.awaitOperation(await c.start(257,{async write(b){bytes+=b.length;},async close(){}}));
 assert.equal(second.outcome,'completed');assert.equal(bytes,257);
});
test('already-written destinations and failed writes cannot be recycled',{timeout:3000},async t=>{
 const c=await local();t.after(()=>c.close());let writes=0;const sink=await c.sink({async write(){writes++;},async close(){}});
 await c.broker.write(sink,new Uint8Array(1).buffer,{callId:'old'});
 const r=await c.client.awaitOperation(await c.start(1,sink));assert.equal(r.outcome,'failed');assert.equal(writes,1);
 const failed=await c.sink({async write(){throw Error('partial side effect');},async close(){}}),grant=await c.broker.grantWrite(failed,'op',2,{callId:'grant'});
 await assert.rejects(c.broker.write(failed,new Uint8Array(1).buffer,{callId:'first',writeGrantId:grant}));
 await assert.rejects(c.broker.write(failed,new Uint8Array(1).buffer,{callId:'second',writeGrantId:grant}),/append grant/);
});
test('a refused foreign grant does not acquire cleanup authority to close the sink',{timeout:3000},async t=>{
 const c=await local();t.after(()=>c.close());let closed=0;
 const sink=await c.sink({async write(){throw Error('foreign write');},async close(){closed++;}},{kind:'operation',sessionId:'result',operationId:'other'});
 const r=await c.client.awaitOperation(await c.start(1,sink));assert.equal(r.outcome,'failed');
 await c.client.acknowledgeOperation(r.operationId);await c.client.getSnapshot();assert.equal(closed,0);
});
test('checkpoint resume restarts the entire output, not the committed source offset',{timeout:5000},async()=>{
 const code=checkpointSource;
 const store=new InMemoryTransferCheckpointStore();let checkpoint;
 for(const name of ['fresh','resume']){
  const host=new ResourceBrokerHost(),broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),native=observations(),closed=Promise.withResolvers(),entered=Promise.withResolvers();let bytes=0,at=0;
  const options=transferSettings(store,broker,undefined,e=>native.add(e),name);
  const {server}=await createAuthoredSession(members(code),wasm,{...options,platform:'node',maximumEffectWork:1500000});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  try{
   await client.attach(name);await client.connect({mode:'challenge'});
   const image=await host.registerSource({origin:'memory',byteLength:4,async seek(n){at=n;},async read(into){const data=Uint8Array.of(0,128,255,65).subarray(at,at+into.length);into.set(data);at+=data.length;return {bytesRead:data.length,eof:at===4};},async close(){}},{kind:'session',sessionId:name});
   const destination=await host.registerSink({async write(b){assert.ok(b.length<=256&&b.every(v=>v===90));bytes+=b.length;entered.resolve();},async close(){closed.resolve();}},{kind:'session',sessionId:name});
   const request={operation:'write',arguments:{image:{kind:'resource',id:image}},resultDestinationId:destination};
   const op=name==='fresh'?await client.startOperation(request):await client.resumeTransfer({...request,checkpointId:checkpoint});
   if(name==='fresh'){
    await entered.promise;checkpoint=(await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2)).checkpoint.id;
    await client.cancelOperation(op.operationId);
   }
   const r=await client.awaitOperation(op.operationId);await closed.promise;
   assert.equal(r.outcome,name==='fresh'?'cancelled':'completed',JSON.stringify(r.error));
   assert.equal(bytes,name==='fresh'?2:65537);
   if(name==='resume'){
    assert.equal(r.resourceResult.byteLength,65537);assert.equal(r.resourceResult.digest.subject.length,65537);
    assert.equal(r.transferReceipt.independentReadBack,false);
    assert.deepEqual(native.seen.filter(e=>e.kind==='write').map(e=>e.bytes),[[81,85,69,82,89],[255,65],[70,73,78,65,76]]);
   }
  }finally{await client.disconnect();await client.close();await host.endSession(name);}
 }
});
test('source and output progress share three grants, not two independent initial accounts',{timeout:5000},async()=>{
 const code=combinedSource;
 const host=new ResourceBrokerHost(),broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host));let at=0,bytes=0;
 const {server}=await createAuthoredSession(members(code),wasm,{...segmentedSettings(new InMemoryTransferCheckpointStore(),broker,undefined,()=>{},'coarse'),platform:'node'});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 try{
  await client.attach('combined');await client.connect({mode:'application'});
  const image=await host.registerSource({origin:'memory',byteLength:65537,async seek(n){at=n;},async read(into){const n=Math.min(into.length,65537-at);into.fill(90,0,n);at+=n;return {bytesRead:n,eof:at===65537};},async close(){}},{kind:'session',sessionId:'combined'});
  const output=await host.registerSink({async write(b){assert.ok(b.length<=256&&b.every(v=>v===90));bytes+=b.length;},async close(){}},{kind:'session',sessionId:'combined'});
  const op=await client.startOperation({operation:'coarse',arguments:{image:{kind:'resource',id:image}},resultDestinationId:output}),r=await client.awaitOperation(op.operationId);
  assert.equal(r.outcome,'completed',JSON.stringify(r.error));assert.equal(bytes,65537);assert.equal(r.resourceResult.byteLength,65537);assert.equal(r.transferReceipt.independentReadBack,false);
 }finally{await client.disconnect();await client.close();await host.endSession('combined');}
});
