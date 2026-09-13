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
import {source,settings} from '../../../test-support/effective-range/fixture.mjs';
import {runCases} from '../../../test-support/effective-range/population.mjs';
import {runCases as device3Cases} from '../../../test-support/effective-range/device3-population.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const members=code=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
async function local(name,code=source,tune=()=>{}){
 const host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry(),native=observations(),store=new InMemoryTransferCheckpointStore();
 const broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),releaseRead=broker.releaseRead.bind(broker);
 broker.releaseRead=async(...args)=>{try{return await releaseRead(...args);}finally{native.add({kind:'source-released'});}};
 const options=settings(store,broker,new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name);tune(options,native);
 const {server}=await createAuthoredSession(members(code),wasm,{...options,platform:'node'}),client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 return {client,native,store,registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),async close(){await client.disconnect();await client.close();await host.endSession(name);},
  async capture(){const records=[],decoder=new TextDecoder();let partial='';const done=Promise.withResolvers();
   const id=await destinations.register({async openPart(){return host.registerSink({async write(bytes){partial+=decoder.decode(bytes,{stream:true});let end;
    while((end=partial.indexOf('\n'))!==-1){const record=JSON.parse(partial.slice(0,end));records.push(record);native.add({kind:'record',record});partial=partial.slice(end+1);}},async close(){}},{kind:'session',sessionId:name});},async commit(){done.resolve();},async abort(){done.resolve();}},name);
   return {id,async records(){await done.promise;return records;}};
  }};
}

for(const name of ['prefix','offset','invalid','one-grant','two-grants','recovery','cancel'])test('B5 '+name+' range on the session client',{timeout:5000},async()=>{assert.equal((await runCases(n=>local(n),[name])).length,1);});
test('B5 D3LINK selected prefix and split durable DATA range',{timeout:5000},async()=>{
 const code=await readFile(new URL('../../../test-support/effective-range/device3.lua',import.meta.url),'utf8');
 assert.equal((await device3Cases(n=>local(n,code),['device3-4-8','device3-6144-8192'])).length,2);
});
test('B5 range admission checks selectors, endpoints and effective rather than enclosing maximum',{timeout:3000},async()=>{
 const m=await admitAuthoredModule(members(source),wasm);
 const bad=[{}, {offset:0,length:0}, {offset:-1,length:4}, {offset:0.5,length:4},
  {offset:0,length:{argument:'absent'}}, {offset:0,length:{argument:'image'}},
  {offset:262144,length:1}, {offset:0,length:4,quantum:1}];
 for(const range of bad){const d=structuredClone(m.description);d.operations[0].transfer.sourceRange=range;
  assert.throws(()=>admitAuthoredDescription(d,m.bindings),e=>e.code==='authored.declaration.invalid');}
 const missing=structuredClone(m.description);delete missing.operations[0].arguments.length.maximum;
 assert.throws(()=>admitAuthoredDescription(missing,m.bindings),e=>e.code==='authored.declaration.invalid');
 const huge=structuredClone(m.description),op=huge.operations[0];op.arguments.image.maximumBytes=Number.MAX_SAFE_INTEGER-1;
 op.transfer.sourceRange={offset:0,length:4};op.transfer.targetLength=68;
 assert.doesNotThrow(()=>admitAuthoredDescription(huge,m.bindings),'four-byte range must not authorize the enormous file domain');
 const unsafe=structuredClone(huge);unsafe.operations[0].transfer.sourceRange={offset:Number.MAX_SAFE_INTEGER-1,length:4};
 assert.throws(()=>admitAuthoredDescription(unsafe,m.bindings),e=>e.code==='authored.declaration.invalid');
 const target=structuredClone(huge);target.operations[0].transfer.targetLength=67;
 assert.throws(()=>admitAuthoredDescription(target,m.bindings),e=>e.code==='authored.declaration.invalid');
 const shared=structuredClone(m.description),both=shared.operations[0];both.arguments.image.maximumBytes=100;
 both.arguments.length.maximum=100;both.transfer.sourceRange={offset:{argument:'length'},length:{argument:'length'}};both.transfer.targetLength=114;
 assert.doesNotThrow(()=>admitAuthoredDescription(shared,m.bindings),'same argument in both selectors has maximum effective length 50, not 99');
});
