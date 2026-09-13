import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../src/capture-rpc.ts';
import {loadCapture} from '../src/capture.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {observations} from '../../../test-support/client-harness.mjs';
import {source,settings} from '../../../test-support/channel-group/fixture.mjs';
import {runCases} from '../../../test-support/channel-group/population.mjs';
test('atomic role groups preserve bytes, sequence, fresh authority and checkpoint consent',{timeout:5000},async()=>{
 const store=new InMemoryTransferCheckpointStore(),wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
 const members=[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(source)}];
 const rows=await runCases(async name=>{
  const native=observations(),host=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry();
  native.command=()=>native.add({kind:'offer-barrier',writes:native.seen.filter(e=>e.kind==='write').map(e=>e.bytes)});
  const local=Object.fromEntries(['create','read','claim','commit','complete','release'].map(k=>[k,store[k].bind(store)]));
  const {server}=await createAuthoredSession(members,wasm,{...settings(local,new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),new DirectCaptureDestinationRpcAdapter(destinations,name),e=>native.add(e),name),platform:'node',maximumEffectWork:2000000});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  return {client,native,registerResource:r=>host.registerSource(r,{kind:'session',sessionId:name}),async close(){await client.disconnect();await client.close();await host.endSession(name);},
   async capture(){const chunks=[],decoder=new TextDecoder();let partial='',committed=false;
    const id=await destinations.register({async openPart(){return host.registerSink({async write(bytes){chunks.push(bytes.slice());partial+=decoder.decode(bytes,{stream:true});let end;
     while((end=partial.indexOf('\n'))!==-1){native.add({kind:'record',record:JSON.parse(partial.slice(0,end))});partial=partial.slice(end+1);}},async close(){}},{kind:'session',sessionId:name});},async commit(){committed=true;},async abort(){}},name);
    return {id,async records(){assert.ok(committed);return (await loadCapture((async function*(){yield* chunks;})())).records;}};
   }};
 });
 assert.deepEqual(rows.slice(0,4).map(r=>r.outcome),['cancelled','failed','failed','completed']);
 assert.equal(rows.length,9);
});
