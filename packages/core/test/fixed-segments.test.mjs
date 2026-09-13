import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule,createAuthoredSession} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../src/capture-rpc.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {observations} from '../../../test-support/client-harness.mjs';
import {source,settings} from '../../../test-support/fixed-segments/fixture.mjs';
import {runCases} from '../../../test-support/fixed-segments/population.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const members=code=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
async function local(name,code=source,tune=()=>{}){
 const host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry(),native=observations(),store=new InMemoryTransferCheckpointStore();
 const broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),sourceReleased=Promise.withResolvers(),releaseRead=broker.releaseRead.bind(broker);
 broker.releaseRead=async(...args)=>{try{return await releaseRead(...args);}finally{sourceReleased.resolve();}};
 const options=settings(store,broker,new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name);tune(options,native);
 const {server}=await createAuthoredSession(members(code),wasm,{...options,platform:'node'}),client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 return {client,native,store,sourceReleased:sourceReleased.promise,registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),async close(){await client.disconnect();await client.close();await host.endSession(name);},
  async capture(){const records=[],decoder=new TextDecoder();let partial='';const done=Promise.withResolvers();
   const id=await destinations.register({async openPart(){return host.registerSink({async write(bytes){partial+=decoder.decode(bytes,{stream:true});let end;
    while((end=partial.indexOf('\n'))!==-1){const record=JSON.parse(partial.slice(0,end));records.push(record);native.add({kind:'record',record});partial=partial.slice(end+1);}},async close(){}},{kind:'session',sessionId:name});},async commit(){done.resolve();},async abort(){done.resolve();}},name);
   return {id,async records(){await done.promise;return records;}};
  }};
}
for(const name of ['coarse','fine','discard','runaway','cancel'])test('D7 '+name+' uses source credit, not framing or reads',{timeout:5000},async()=>{
 assert.equal((await runCases(n=>local(n),[name])).length,1);
});
test('VM segment schedule is finite, monotonic, and cannot replace a shared account',{timeout:3000},async()=>{
 const m=await admitAuthoredModule(members(source),wasm),e=await m.openExecution();
 try{
  await e.register('a',undefined,undefined,10000,2);await e.register('child','a');
  await assert.rejects(e.advanceSegment('a',1),/segment-revoked/);
  await e.retire('child');await e.advanceSegment('a',1);
  await assert.rejects(e.advanceSegment('a',1),/segment-revoked/);await assert.rejects(e.advanceSegment('a',2),/segment-revoked/);
  await e.close();await assert.rejects(e.advanceSegment('a',1),/segment-revoked/);
 }finally{await e.close();}
});
test('D7 declaration rejects chosen quanta and unrepresentable aggregate domains',{timeout:3000},async()=>{
 const m=await admitAuthoredModule(members(source),wasm);
 for(const change of [{segmented:false},{segmented:1},{sourceQuantum:1}]){
  const d=structuredClone(m.description);Object.assign(d.operations[0].transfer,change);
  assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');
 }
 const d=structuredClone(m.description);d.operations[0].arguments.image.maximumBytes=Number.MAX_SAFE_INTEGER-128;d.operations[0].transfer.targetLength=Number.MAX_SAFE_INTEGER-128;
 assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');
});
test('D7 over-declaration source refuses before its first read or protocol write',{timeout:3000},async t=>{
 const c=await local('oversize');t.after(()=>c.close());await c.client.attach('oversize');await c.client.connect({mode:'application'});let reads=0;
 const id=await c.registerResource({origin:'memory',byteLength:65538,async seek(){},async read(){reads++;throw Error('must refuse descriptor');},async close(){}});
 const op=await c.client.startOperation({operation:'coarse',arguments:{image:{kind:'resource',id}}}),r=await c.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.equal(reads,0);assert.equal(c.native.seen.filter(e=>e.kind==='write').length,0);
});
test('D7 cannot move a cancelled pending boundary write to a new segment',{timeout:5000},async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers();let bytes=0;
 const c=await local('coarse',source,options=>{const open=options.open;options.open=async()=>{const connection=await open(),ch=connection.channel('requests'),acquire=ch.acquire.bind(ch);
  ch.acquire=async(...args)=>{const l=await acquire(...args),write=l.write.bind(l);l.write=async b=>{const r=await write(b);if(b.length===65536){bytes+=65536;entered.resolve();await gate.promise;}return r;};return l;};return connection;};});
 t.after(async()=>{gate.resolve();await c.close();});await c.client.attach('pending');await c.client.connect({mode:'application'});const events=[];const sub=c.client.subscribe(e=>events.push(e));t.after(()=>sub.dispose());await c.client.getSnapshot();
 let at=0;const id=await c.registerResource({origin:'memory',byteLength:65537,async seek(n){at=n;},async read(into){const n=Math.min(into.length,65537-at);into.fill(90,0,n);at+=n;return {bytesRead:n,eof:at===65537};},async close(){}});
 const op=await c.client.startOperation({operation:'coarse',arguments:{image:{kind:'resource',id}}});await entered.promise;
 assert.ok(!events.some(e=>e.segmentation?.index===1));await c.client.cancelOperation(op.operationId);
 gate.resolve();const r=await c.client.awaitOperation(op.operationId);assert.equal(r.outcome,'cancelled');
 assert.ok(!events.some(e=>e.segmentation?.index===1));assert.equal(bytes,65536);
});
