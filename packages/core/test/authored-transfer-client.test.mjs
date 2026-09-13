import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createAuthoredSession,admitAuthoredModule} from '../src/authored-module.ts';
import {admitAuthoredDescription} from '../src/authored-admission.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../src/capture-rpc.ts';
import {loadCapture} from '../src/capture.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {observations} from '../../../test-support/client-harness.mjs';
import {source,settings} from '../../../test-support/checkpoint-service/fixture.mjs';
import {runCases} from '../../../test-support/checkpoint-service/population.mjs';
test('transfer service admission resolves bindings and bounds its source and target domain',{timeout:3000},async()=>{
  const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const module=await admitAuthoredModule([{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(source)}],wasm);
  for(const [change,code]of [
    [o=>delete o.transfer,'authored.declaration.invalid'],
    [o=>o.requires=o.requires.filter(r=>r!=='transfer.checkpoint'),'authored.declaration.invalid'],
    [o=>o.transfer.resumeBinding='missing','authored.binding.unresolved'],
    [o=>o.transfer.sourceArgument='missing','authored.declaration.invalid'],
    [o=>o.arguments.image.minimumBytes=0,'authored.declaration.invalid'],
    [o=>o.transfer.targetLength=67,'authored.declaration.invalid'],
    [o=>o.arguments.image.maximumBytes=2097088,'authored.declaration.invalid'],
  ]){const d=structuredClone(module.description);change(d.operations[0]);assert.throws(()=>admitAuthoredDescription(d,module.bindings),e=>e.code===code);}
});
test('admitted checkpoint effects and resume RPC preserve committed suffix and source refusal',{timeout:5000},async()=>{
  const store=new InMemoryTransferCheckpointStore();
  const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const members=[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(source)}];
  const rows=await runCases(async name=>{
    const native=observations(),host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry();
    native.command=()=>native.add({kind:'offer-barrier',writes:native.seen.filter(e=>e.kind==='write').map(e=>e.bytes)});
    const localStore=Object.fromEntries(['create','read','claim','commit','complete','release'].map(k=>[k,store[k].bind(store)]));
    const options=settings(localStore,new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name);
    const {server}=await createAuthoredSession(members,wasm,{...options,platform:'node'});
    const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
    return {client,native,async close(){await client.disconnect();await client.close();await host.endSession(name);},
      registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),
      async capture(){
        const chunks=[];let committed=false;
        const id=await destinations.register({async openPart(){return host.registerSink({async write(b){chunks.push(b.slice());},async close(){}},{kind:'session',sessionId:name});},async commit(){committed=true;},async abort(){}},name);
        return {id,async records(){assert.equal(committed,true);return (await loadCapture((async function*(){yield* chunks;})())).records;}};
      }};
  });
  assert.deepEqual(rows.map(r=>r.outcome),['cancelled','failed','failed','completed']);
});
test('pending inspection holds one storage slot through revocation and refuses stale completion',{timeout:3000},async t=>{
  const store=new InMemoryTransferCheckpointStore(),gate=Promise.withResolvers(),entered=Promise.withResolvers();let reads=0;
  store.read=async()=>{reads++;entered.resolve();return gate.promise;};
  const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const {server}=await createAuthoredSession([{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(source)}],wasm,
    {...settings(store,{}, {},()=>{},'held-inspection'),platform:'node'});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{gate.resolve(null);await client.disconnect();await client.close();});
  await client.attach('held-inspection');await client.connect({mode:'challenge'});
  const pending=assert.rejects(client.inspectTransferCheckpoint('held'),e=>e.error?.code==='retained.revoked');await entered.promise;
  await assert.rejects(client.inspectTransferCheckpoint('second'),e=>e.error?.code==='authored.transfer.inspection-pending');
  await assert.rejects(client.startOperation({operation:'write',arguments:{}}),e=>e.error?.code==='authored.transfer.inspection-pending');
  await client.disconnect();
  await assert.rejects(client.inspectTransferCheckpoint('third'),e=>e.error?.code==='authored.transfer.inspection-pending');
  assert.equal(reads,1);gate.resolve(null);await pending;
});
