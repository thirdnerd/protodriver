import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule,createAuthoredSession} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../src/capture-rpc.ts';
import {loadCapture} from '../src/capture.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {observations} from '../../../test-support/client-harness.mjs';
import {source,settings} from '../../../test-support/carrier-bound/fixture.mjs';
import {runCases} from '../../../test-support/carrier-bound/population.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const inputs=code=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
async function local(store,name,code=source,tune=()=>{}){
 const members=inputs(code);
  const native=observations(),host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry();
  native.command=()=>native.add({kind:'offer-barrier',writes:native.seen.filter(e=>e.kind==='write').map(e=>e.bytes)});
  const local=Object.fromEntries(['create','read','claim','commit','complete','release'].map(k=>[k,store[k].bind(store)]));
  const broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),releaseRead=broker.releaseRead.bind(broker);
  broker.releaseRead=async(...args)=>{try{return await releaseRead(...args);}finally{native.add({kind:'source-released'});}};
  const options=settings(local,broker,new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name);
  tune(options,native);
  const {server}=await createAuthoredSession(members,wasm,{...options,platform:'node'});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  return {client,native,clock:options.clock,registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),async close(){await client.disconnect();await client.close();await host.endSession(name);},
   async capture(){const chunks=[],decoder=new TextDecoder();let partial='',committed=false;const done=Promise.withResolvers();
    const id=await destinations.register({async openPart(){return host.registerSink({async write(bytes){chunks.push(bytes.slice());partial+=decoder.decode(bytes,{stream:true});let end;
     while((end=partial.indexOf('\n'))!==-1){native.add({kind:'record',record:JSON.parse(partial.slice(0,end))});partial=partial.slice(end+1);}},async close(){}},{kind:'session',sessionId:name});},async commit(){committed=true;done.resolve();},async abort(){done.resolve();}},name);
    return {id,async records(){await done.promise;assert.ok(committed);return (await loadCapture((async function*(){yield* chunks;})())).records;}};
   }};
}
async function start(c,operation='exact'){
 await c.client.attach('F48');await c.client.connect({mode:'challenge'});let at=0;const bytes=Uint8Array.of(0,128,255,65);
 const id=await c.registerResource({origin:'memory',byteLength:4,async seek(n){at=n;},async read(into){const b=bytes.slice(at,at+into.length);into.set(b);at+=b.length;return {bytesRead:b.length,eof:at===4};},async close(){}});
 return c.client.startOperation({operation,arguments:{image:{kind:'resource',id}}});
}
test('declared carrier bound accepts exact bytes; under and default refuse before checkpoint admission',{timeout:5000},async()=>{
 assert.equal((await runCases(n=>local(new InMemoryTransferCheckpointStore(),n))).length,3);
});
test('carrier declaration domain and identity are enforced at admission',{timeout:5000},async()=>{
 const m=await admitAuthoredModule(inputs(source),wasm);
 for(const n of [0,-1,1.5,65537,'792',null]){
  const d=structuredClone(m.description);d.operations[0].transfer.maximumCarrierBytes=n;
  assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');
 }
 for(const n of [1,256,792,65536]){
  const d=structuredClone(m.description);d.operations[0].transfer.maximumCarrierBytes=n;
  assert.doesNotThrow(()=>admitAuthoredDescription(d,m.bindings));
 }
 const changed=await admitAuthoredModule(inputs(source.replace('op("exact",792)','op("exact",791)')),wasm);
 assert.notDeepEqual(m.canonicalBytes,changed.canonicalBytes);
 assert.notDeepEqual(m.identity,changed.identity);
});
test('transfer carrier grant does not widen ordinary binary writes',{timeout:5000},async t=>{
 const code=source.replace('kind="transfer-write",offset=0,payloadOffset=788,length=4,value=frame','kind="write",value=frame');
 const c=await local(new InMemoryTransferCheckpointStore(),'ordinary',code);t.after(()=>c.close());
 const op=await start(c),r=await c.client.awaitOperation(op.operationId);
 assert.equal(c.native.seen.filter(e=>e.kind==='write').length,1);assert.equal(r.error.code,'retained.invalid-effect');
 assert.equal(c.native.seen.filter(e=>e.kind==='checkpoint').at(-1).checkpoint.authoredTransfer.admittedEnd,0);
});
test('policy maximum carrier is deliverable with capture without a larger work account',{timeout:5000},async t=>{
 const code=source.replaceAll('792','65536').replaceAll('788','65532');
 const c=await local(new InMemoryTransferCheckpointStore(),'maximum',code,(options)=>{
  const open=options.open;options.open=async()=>{const connection=await open(),channel=connection.channel('requests'),acquire=channel.acquire.bind(channel);
   channel.acquire=async(...args)=>{const l=await acquire(...args),write=l.write.bind(l);l.write=async bytes=>{const r=await write(bytes);if(bytes.length===65536)connection.channel('responses').enqueueReceived(Uint8Array.of(68));return r;};return l;};return connection;};
 });t.after(()=>c.close());
 await c.client.attach('F48 maximum');await c.client.connect({mode:'challenge'});const d=await c.capture(),cap=await c.client.startCapture(d.id,{sidecarThresholdBytes:1048576});
 let at=0;const bytes=Uint8Array.of(0,128,255,65),id=await c.registerResource({origin:'memory',byteLength:4,async seek(n){at=n;},async read(into){const b=bytes.slice(at);into.set(b);at+=b.length;return {bytesRead:b.length,eof:true};},async close(){}});
 const op=await c.client.startOperation({operation:'exact',arguments:{image:{kind:'resource',id}}}),r=await c.client.awaitOperation(op.operationId);assert.equal(r.outcome,'completed',JSON.stringify(r));
 await c.native.wait(e=>e.kind==='source-released');
 await c.client.stopCapture(cap);const records=await d.records(),tx=records.filter(r=>r.kind==='tx-requested');
 assert.deepEqual([...Buffer.from(tx[1].data,'base64')],[...new Uint8Array(65532).fill(90),...bytes]);
 assert.equal((await c.native.wait(e=>e.kind==='record'&&e.record.kind==='footer')).record.completeness,'complete');
});
test('cancelled pending carrier retains the possible horizon, never commitment or an automatic retry',{timeout:5000},async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers(),settled=Promise.withResolvers(),store=new InMemoryTransferCheckpointStore();
 const c=await local(store,'pending',source,options=>{const open=options.open;options.open=async()=>{const connection=await open(),ch=connection.channel('requests'),acquire=ch.acquire.bind(ch);
  ch.acquire=async(...args)=>{const l=await acquire(...args),write=l.write.bind(l);l.write=async bytes=>{if(bytes.length!==792)return write(bytes);const r=await write(bytes);entered.resolve();await gate.promise;settled.resolve();return r;};return l;};return connection;};});
 t.after(async()=>{gate.resolve();await c.close();});const op=await start(c,'pending');await entered.promise;
 await c.client.cancelOperation(op.operationId);const r=await c.client.awaitOperation(op.operationId);assert.equal(r.outcome,'cancelled');
 const cp=await store.read(r.transferReceipt.checkpointId);assert.equal(cp.authoredTransfer.admittedEnd,4);assert.deepEqual(cp.confirmedRanges,[]);
 gate.resolve();await settled.promise;await c.native.wait(e=>e.kind==='claim-released');
 assert.deepEqual(await c.client.awaitOperation(op.operationId),r);assert.deepEqual(c.native.seen.filter(e=>e.kind==='write').map(e=>e.bytes.length),[5,792]);
 assert.equal((await store.read(cp.id)).confirmedRanges.length,0);
});
// B4 and C2 must compose through the actual admitted Lua adapter. A host-only
// callback never exercised the old second 256-octet gate in startOperation.
for(const maximum of [792,65536])test(`complete ${maximum}-octet carrier reaches its Lua owner once`,{timeout:5000},async t=>{
 let code=source.replace('local a=pdrv.array','local a=pdrv.array;local expected')
  .replace('locks=a({"protocol"}),requires=a({"channel.read","channel.write","transfer.checkpoint"})',
   'locks=a({"protocol"}),writeVia="receiver",requires=a({"mailbox","channel.write-via","transfer.checkpoint"})')
  .replace('operations=a({','mailboxes=a({"reply"}),handlers=a({{id="receiver",binding="receive",authorizeWrite="authorize",event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=a({}),requires=a({"channel.input","mailbox"})}}),operations=a({')
  .replace('{resume=function()',`{receive=function(args,io)io.request({kind="message-send",mailbox="reply",value=pdrv.bytes(args.input)})end,
   authorize=function(r)assert(r.origin=="operation");return{accepted=expected and r.bytes==expected or r.bytes=="BEGIN" or r.bytes=="FINAL"}end,
   resume=function()`)
  .replaceAll('kind="write"','kind="write-via"')
  .replaceAll('io.request({kind="read",maximum=1})','io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})}):sub(15)')
  .replace('io.request({kind="read",maximum=129})','io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})}):sub(15)')
  .replace('local frame=pdrv.bytes(string.rep("Z",788)..payload)','expected=string.rep("Z",788)..payload;local frame=pdrv.bytes(expected)');
 if(maximum===65536)code=code.replaceAll('792','65536').replaceAll('788','65532');
 const c=await local(new InMemoryTransferCheckpointStore(),'relay-'+maximum,code,options=>{
  if(maximum!==65536)return;const open=options.open;options.open=async()=>{
   const connection=await open(),channel=connection.channel('requests'),acquire=channel.acquire.bind(channel);
   channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{
    const r=await write(bytes);if(bytes.length===65536)connection.channel('responses').enqueueReceived(Uint8Array.of(68));return r;};return lease;};return connection;
  };
 });t.after(()=>c.close());
 const op=await start(c),r=await c.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'completed',JSON.stringify(r));
 const frames=c.native.seen.filter(e=>e.kind==='write').map(e=>e.bytes);
 assert.deepEqual(frames.map(b=>b.length),[5,maximum,5]);
 assert.deepEqual(frames[1],[...new Uint8Array(maximum-4).fill(90),0,128,255,65]);
});
