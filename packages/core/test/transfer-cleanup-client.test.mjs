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
import {source,settings} from '../../../test-support/transfer-cleanup/fixture.mjs';
import {runCases} from '../../../test-support/transfer-cleanup/population.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const inputs=code=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
const idleTransferSource=source
 .replace('operations=a({',`maintenance=a({{kind="poll",mode="challenge",operation="idle",intervalMs=1000,failureBackoffMs=1000,suspendWhileLocksHeld=a({"channel"}),timing={kind="idle-reset",activity="foreground-lifecycle"}}}),
 operations=a({{id="idle",title="idle",binding="idle",arguments={},result={kind="value",type={kind="string"}},risk="read-only",repeatability="safe-to-repeat",locks=a({"channel"}),requires=a({}),availability={modes=a({"challenge"}),profiles=a({"serial"})},releaseAfterIdleMs=1},`)
 .replaceAll('availability={modes=a({"challenge"}),profiles=a({"serial"})}','availability={modes=a({"challenge"}),profiles=a({"serial"})},reentry={binding="reenter",requires=a({"channel.read","channel.write"})}')
 .replace('requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"challenge"}),profiles=a({"serial"})},reentry={binding="reenter",requires=a({"channel.read","channel.write"})}',
  'requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"challenge"}),profiles=a({"serial"})},reentry={binding="quietReenter",requires=a({})}')
 .replace('{restore=function',`{reenter=function(_,io)
   io.request({kind="write",value="PAIR"})
   io.request({kind="read-bytes",maximum=2});io.request({kind="input-channel"})
   io.request({kind="read-bytes",maximum=2});io.request({kind="input-channel"})
 end,quietReenter=function() end,idle=function() return "idle" end,restore=function`);
async function local(store,name,code=source){
 const members=inputs(code);
  const native=observations(),host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry();
  native.command=()=>native.add({kind:'offer-barrier',writes:native.seen.filter(e=>e.kind==='write').map(e=>e.bytes)});
  const local=Object.fromEntries(['create','read','claim','commit','complete','release'].map(k=>[k,store[k].bind(store)]));
  const broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),releaseRead=broker.releaseRead.bind(broker);
  broker.releaseRead=async(...args)=>{try{return await releaseRead(...args);}finally{native.add({kind:'source-released'});}};
  const options=settings(local,broker,new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name);
  const {server}=await createAuthoredSession(members,wasm,{...options,platform:'node'});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  return {client,native,clock:options.clock,registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),async close(){await client.disconnect();await client.close();await host.endSession(name);},
   async capture(){const chunks=[],decoder=new TextDecoder();let partial='',committed=false;const done=Promise.withResolvers();
    const id=await destinations.register({async openPart(){return host.registerSink({async write(bytes){chunks.push(bytes.slice());partial+=decoder.decode(bytes,{stream:true});let end;
     while((end=partial.indexOf('\n'))!==-1){native.add({kind:'record',record:JSON.parse(partial.slice(0,end))});partial=partial.slice(end+1);}},async close(){}},{kind:'session',sessionId:name});},async commit(){committed=true;done.resolve();},async abort(){done.resolve();}},name);
    return {id,async records(){await done.promise;assert.ok(committed);return (await loadCapture((async function*(){yield* chunks;})())).records;}};
   }};
}
test('streamed transfer cleanup retires only a confirmed claim and preserves resume',{timeout:5000},async()=>{
 const store=new InMemoryTransferCheckpointStore(),rows=await runCases(name=>local(store,name));
 assert.deepEqual(rows.slice(0,4).map(r=>r.outcome),['cancelled','failed','failed','completed']);
 assert.equal(rows.length,10);
});
test('confirmed abort reaches the wire without rerunning source preparation',{timeout:5000},async()=>{
 const store=new InMemoryTransferCheckpointStore();
 await runCases(name=>local(store,name),{resume:false,names:['abort']});
});
test('C6 direct reentry composes with cleanup, checkpoint, streaming source and channel roles',{timeout:10000},async t=>{
 const store=new InMemoryTransferCheckpointStore(),c=await local(store,'f156-idle-composition',idleTransferSource),{client,native,clock}=c;
 t.after(()=>c.close());
 await client.attach('F156 direct-channel idle composition');const destination=await c.capture(),capture=await client.startCapture(destination.id,{});
 await client.connect({mode:'challenge'});
 const release=async()=>{for(let attempt=0;attempt<5;attempt++){
  const before=await client.getSnapshot();if(before.scheduledWork.released)return;
  await clock.advance(1000);await new Promise(resolve=>setImmediate(resolve));
 }assert.equal((await client.getSnapshot()).scheduledWork.released,true,'foreground retirement must arm idle release');};
 const argument=async(data=Uint8Array.of(0,128,255,65))=>{let at=0;
  const id=await c.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},async read(into){
   const bytes=data.slice(at,at+into.length);into.set(bytes);at+=bytes.length;return {bytesRead:bytes.length,eof:at===4};},async close(){}});
  return {image:{kind:'resource',id}};};
 const sourceReleased=count=>native.wait(e=>e.kind==='source-released'&&native.seen.filter(x=>x.kind==='source-released').length===count);

 const prime=await client.startOperation({operation:'idle',arguments:{}});assert.equal((await client.awaitOperation(prime.operationId)).outcome,'completed');
 await release();
 const scan=await client.startOperation({operation:'scan',arguments:await argument(Uint8Array.of(31,48,65,82))}),scanned=await client.awaitOperation(scan.operationId);
 assert.equal(scanned.outcome,'completed',JSON.stringify(scanned));assert.equal(scanned.result,4);await sourceReleased(1);

 await release();const abort=await client.startOperation({operation:'write',arguments:{...(await argument()),scenario:{kind:'value',value:'abort'}}});
 const abortCheckpoint=(await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2)).checkpoint;
 await client.cancelOperation(abort.operationId);const aborted=await client.awaitOperation(abort.operationId);
 assert.equal(aborted.outcome,'cancelled');assert.equal(aborted.error.details.cleanup.outcome,'completed');
 await native.wait(e=>e.kind==='checkpoint-removed'&&e.id===abortCheckpoint.id);await sourceReleased(2);

 const ordinals=new Set(native.seen.filter(e=>e.kind==='lease-acquired').map(e=>e.ordinal));assert.deepEqual(ordinals,new Set([1]));
 assert.deepEqual(new Set(native.seen.filter(e=>e.kind==='lease-acquired').map(e=>e.channel)),new Set(['requests','responses','events']));
 assert.equal(native.seen.filter(e=>e.kind==='write'&&String(e.bytes)==='80,65,73,82').length,1,'streaming post-idle operation must execute role-routed reentry once');
 const summary=await client.stopCapture(capture);await destination.records();assert.equal(summary.completeness,'complete');
});
test('R-I resume after C6 idle release reaches admitted reentry',{timeout:10000},async t=>{
 const store=new InMemoryTransferCheckpointStore(),c=await local(store,'f156-resume-idle',idleTransferSource),{client,native,clock}=c;
 t.after(()=>c.close());await client.attach('F156 R-I boundary');const destination=await c.capture();await client.startCapture(destination.id,{});await client.connect({mode:'challenge'});
 const release=async()=>{for(let attempt=0;attempt<5;attempt++){
  const before=await client.getSnapshot();if(before.scheduledWork.released)return;
  await clock.advance(1000);await new Promise(resolve=>setImmediate(resolve));
 }assert.equal((await client.getSnapshot()).scheduledWork.released,true,'R-I setup must reach idle release');};
 const argument=async()=>{const data=Uint8Array.of(0,128,255,65);let at=0;
  const id=await c.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},async read(into){
   const bytes=data.slice(at,at+into.length);into.set(bytes);at+=bytes.length;return {bytesRead:bytes.length,eof:at===4};},async close(){}});
  return {image:{kind:'resource',id},scenario:{kind:'value',value:'keep'}};};
 const prime=await client.startOperation({operation:'idle',arguments:{}});assert.equal((await client.awaitOperation(prime.operationId)).outcome,'completed');await release();
 const fresh=await client.startOperation({operation:'write',arguments:await argument()});
 const checkpoint=(await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2)).checkpoint;
 await client.cancelOperation(fresh.operationId);assert.equal((await client.awaitOperation(fresh.operationId)).outcome,'cancelled');
 await native.wait(e=>e.kind==='checkpoint-retained'&&e.checkpoint.id===checkpoint.id);
 await native.wait(e=>e.kind==='source-released');
 assert.equal((await client.inspectTransferCheckpoint(checkpoint.id)).assurance,'verified');await release();
 let resumed;
 try{resumed=await client.resumeTransfer({checkpointId:checkpoint.id,operation:'write',arguments:await argument()});}
 catch(error){assert.fail(`R-I admitted resume must cross C6 reentry after operator action; got ${error.error?.code??error.code??error}`);}
 const result=await client.awaitOperation(resumed.operationId);
 assert.equal(result.outcome,'completed','R-I admitted resume must complete after C6 reentry');
});
test('admission does not grant cleanup a checkpoint belonging to no ordinary transfer',async()=>{
 const module=await admitAuthoredModule(inputs(source),wasm),d=structuredClone(module.description),op=d.operations.find(o=>o.id==='write');
 delete op.transfer;op.requires=op.requires.filter(r=>r!=='transfer.checkpoint');
 assert.throws(()=>admitAuthoredDescription(d,module.bindings),e=>e.code==='authored.declaration.invalid'&&e.message.includes("operation's transfer service"));
});
for(const name of ['ungranted','replaced'])test('cleanup retirement refuses '+name+' authority',{timeout:5000},async t=>{
 const code=name==='ungranted'?source.replace('"channel.write","transfer.cleanup"','"channel.write"'):
  source.replace('"channel.write","transfer.cleanup"','"channel.write","connection.lifecycle","transfer.cleanup"')
   .replace('local state=io.request','local grant=io.request({kind="connection-grant"});io.request({kind="connection-close",connection=grant:match("^([^|]+)")});io.request({kind="connection-reacquire"});local state=io.request');
 const store=new InMemoryTransferCheckpointStore(),c=await local(store,name,code),{client,native}=c;t.after(()=>c.close());
 await client.attach('authority');await client.connect({mode:'challenge'});let at=0;const data=Uint8Array.of(0,128,255,65);
 const id=await c.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},async read(into){const b=data.slice(at,at+into.length);into.set(b);at+=b.length;return {bytesRead:b.length,eof:at===4};},async close(){}});
 const op=await client.startOperation({operation:'write',arguments:{image:{kind:'resource',id},scenario:{kind:'value',value:'abort'}}});
 const e=await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2);await client.cancelOperation(op.operationId);
 const result=await client.awaitOperation(op.operationId);assert.equal(result.outcome,'cancelled');
 assert.equal(result.error.details.cleanup.error.code,name==='ungranted'?'authored.cleanup.authority':'transfer.resume.identity-mismatch');
 await native.wait(e=>e.kind==='checkpoint-retained');assert.equal((await store.read(e.checkpoint.id)).confirmedRanges[0].length,2);
 assert.equal(native.seen.filter(e=>e.kind==='checkpoint-removed').length,0);
});
test('real cleanup deadline keeps a pending retirement claimed and does not reenter after late deletion',{timeout:5000},async t=>{
 const store=new InMemoryTransferCheckpointStore(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),complete=store.complete.bind(store);
 store.complete=async claim=>{entered.resolve();await gate.promise;return complete(claim);};
 const c=await local(store,'abort'),{client,native}=c;
 t.after(async()=>{gate.resolve();await c.close();});await client.attach('late retirement');await client.connect({mode:'challenge'});
 const destination=await c.capture();await client.startCapture(destination.id,{});
 const data=Uint8Array.of(0,128,255,65);let at=0;
 const id=await c.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},async read(into){const bytes=data.slice(at,at+into.length);into.set(bytes);at+=bytes.length;return {bytesRead:bytes.length,eof:at===4};},async close(){}});
 const op=await client.startOperation({operation:'write',arguments:{image:{kind:'resource',id},scenario:{kind:'value',value:'abort'}}});
 const e=await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2);
 await client.cancelOperation(op.operationId);await entered.promise;await c.clock.advance(501000);
 const result=await client.awaitOperation(op.operationId);assert.equal(result.outcome,'cancelled');assert.equal(result.error.details.cleanup.error.code,'authored.cleanup.timeout');
 await assert.rejects(store.claim(e.checkpoint.id,'competitor'),e=>e.diagnostic?.code==='transfer.checkpoint-held');
 gate.resolve();await native.wait(e=>e.kind==='checkpoint-removed');assert.equal(await store.read(e.checkpoint.id),null);
 assert.deepEqual(await client.awaitOperation(op.operationId),result);
 assert.deepEqual(native.seen.filter(e=>e.kind==='write').map(e=>e.bytes),[[66,69,71,73,78],[0,128,255,65],[65,66,79,82,84]]);
 const footer=(await native.wait(e=>e.kind==='record'&&e.record.kind==='footer')).record;
 assert.equal(footer.completeness,'incomplete','pending storage at forced close cannot get a complete capture');
});
