import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import {createHash} from 'node:crypto';
import { BrowserSessionWorkerHost } from '../src/session-worker-host.ts';
import { DirectSessionRpcAdapter, DeviceSessionRpcClient, PostMessageSessionRpcAdapter, serveSessionRpc } from '../../../packages/core/src/rpc.ts';
import { ResourceBrokerHost, ResourceBrokerRpcClient, DirectResourceRpcAdapter } from '../../../packages/core/src/resources.ts';
import { CaptureDestinationRegistry, DirectCaptureDestinationRpcAdapter } from '../../../packages/core/src/capture-rpc.ts';
import { packageBytes, hostGrant } from '../../cli/test/fixtures/authored-front-door.mjs';
import { collectAuthoredOutput } from '../../../packages/generated-web/src/authored-output.ts';
import { BrowserMemoryCaptureDestination } from '../src/session-worker-client.ts';
import { loadCapture } from '../../../packages/core/src/capture.ts';
import { migratedBrowserTransport, migratedPackage } from './fixtures/migrated-browser.mjs';

test('browser admission reaches v2 controls without granting acquisition', async t => {
  // Catches the ordinary browser loader still taking v1 or silently inventing a connection.
  const authoredArtifact=new Uint8Array(await readFile(new URL('../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const host=new BrowserSessionWorkerHost({authoredArtifact}),loaded=await host.admit(await packageBytes());
  assert.equal(loaded.authored.model.operations[0].id,'echo');assert.equal(loaded.authored.hostGrant,null);
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(host));t.after(()=>client.close());await client.attach('test');
  assert.deepEqual(await client.resolveCandidates({mode:'main'}),[]);
  await assert.rejects(client.connect({mode:'main'}),/authored.acquisition.required/);
});

test('browser front door executes with host grant and keeps the generation usable after invalid arguments', async t => {
  // Catches a grant bypass or an argument refusal killing an otherwise usable session.
  const authoredArtifact=new Uint8Array(await readFile(new URL('../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const observed={opens:0,writes:[]},resources=new DirectResourceRpcAdapter(new ResourceBrokerHost());
  const capture=new DirectCaptureDestinationRpcAdapter(new CaptureDestinationRegistry(),'f87-web');
  const host=new BrowserSessionWorkerHost({authoredArtifact,authoredAcquisition:async()=>hostGrant(observed),
    resourceBroker:new ResourceBrokerRpcClient(resources),captureDestinationAdapter:capture});
  const loaded=await host.admit(await packageBytes());assert.equal(loaded.authored.hostGrant.profileId,'serial');assert.equal(observed.opens,0);
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(host));
  t.after(async()=>{await client.disconnect();await client.close();await resources.close();await capture.close();});
  await client.attach('test');await client.connect({mode:'main'});
  await assert.rejects(client.startOperation({operation:'echo',arguments:{value:{kind:'value',value:-1}}}));
  const handle=await client.startOperation({operation:'echo',arguments:{value:{kind:'value',value:7}}});
  const result=await client.awaitOperation(handle.operationId);assert.equal(result.outcome,'completed');assert.equal(result.result,8);
  await client.acknowledgeOperation(handle.operationId);assert.deepEqual(observed,{opens:1,writes:['F87']});
});

test('device-1 ordinary browser defers construction through chooser grant and executes ping',async t=>{
  // Unique regression: browser admission eagerly opening device-1 or dropping its selected serial candidate.
  const bytes=await migratedPackage('device-1',['device.lua','channel-wire.lua','channel-layout.lua']);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('device-1'),'transfer','serial');
  const result=await runValue(surface.client,'ping');assert.deepEqual(result,{address:0,length:0});
});

test('device-2 ordinary browser keeps silent mode distinct while executing device information',async t=>{
  // Unique regression: the browser acquisition join flattening device-2's two modes on one serial profile.
  const bytes=await migratedPackage('device-2',['device.lua']);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('device-2'),'silent','serial');
  const result=await runValue(surface.client,'get_device_info');assert.deepEqual(result,{identity:'1234ABCD,1.0'});
});

test('CE ordinary browser opens the admitted USB endpoint orientation and returns its screenshot',async t=>{
  // Unique regression: stock browser acquisition swapping CE's WebUSB input/output endpoints.
  const bytes=await migratedPackage('ti84-plus-ce/module',['device.lua','directlink.lua','bmp.lua']);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('ce'),'screenshot','usb');
  const operation=surface.loaded.authored.model.operations.find(({id})=>id==='capture_screenshot');assert.ok(operation);
  const result=await collectAuthoredOutput(surface.client,operation,{},resource=>surface.resources.registerSink(resource,
    {kind:'session',sessionId:'f92-browser'}));
  assert.equal(result.outcome.outcome,'completed');assert.ok(result.blob.size>1000);
});

test('Evo ordinary browser resolves four source members and previews exact BMP bytes',async t=>{
  // Unique regression: browser source-set admission or image collection re-encoding Evo's streamed BMP.
  const bytes=await migratedPackage('ti-84-evo',['device.lua','evo.lua','screen.lua','cbor.lua']);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('evo'),'screenshot','serial');
  const operation=surface.loaded.authored.model.operations.find(({id})=>id==='capture_screen');assert.ok(operation);
  assert.equal(surface.loaded.authored.model.description,'Acquire the current calculator display as a directly saveable BMP file.');
  assert.equal(operation.title,'Capture screen');assert.equal(operation.risk,'read-only');assert.equal(operation.repeatability,'safe-to-repeat');
  assert.deepEqual(operation.result,{kind:'file',direction:'out',content:'Current display, 320 by 240 RGB565',mediaType:'image/bmp',
    suggestedExtension:'bmp',minimumBytes:153666,maximumBytes:153666});
  const result=await collectAuthoredOutput(surface.client,operation,{},resource=>surface.resources.registerSink(resource,
    {kind:'session',sessionId:'f106-browser'}));
  assert.equal(result.outcome.outcome,'completed');assert.equal(result.blob.type,'image/bmp');assert.equal(result.blob.size,153666);
  const bmp=Buffer.from(await result.blob.arrayBuffer());
  assert.equal(createHash('sha256').update(bmp.subarray(66)).digest('hex'),'d67cf653c07cb7781ad1aa9c2a3cac7e2a9e09e1b74fc209cc192db6a4d93265');
});

test('Nspire ordinary browser preserves its single-root presentation and previews exact BMP bytes',async t=>{
  // Unique regression: browser admission can flatten Nspire presentation or re-encode its single-root BMP result.
  const bytes=await migratedPackage('ti-nspire',['device.lua']);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('nspire'),'device_information','usb');
  assert.equal(surface.loaded.authored.model.description,'Read device information and capture the display through measured NavNet exchanges.');
  const information=surface.loaded.authored.model.operations.find(({id})=>id==='read-device-information');
  const screenshot=surface.loaded.authored.model.operations.find(({id})=>id==='capture_screenshot');
  assert.deepEqual({title:information.title,risk:information.risk,repeatability:information.repeatability,result:information.result},
    {title:'Read device information',risk:'read-only',repeatability:'safe-to-repeat',result:{kind:'value',type:{kind:'record',
      fields:{name:{kind:'bytes',minimumLength:9,maximumLength:9}},fieldLabels:{name:'Handheld name'}}}});
  assert.deepEqual(await runValue(surface.client,'read-device-information'),
    {name:{type:'bytes',encoding:'base64',value:Buffer.from('TI-Nspire').toString('base64')}});
  const result=await collectAuthoredOutput(surface.client,screenshot,{},resource=>surface.resources.registerSink(resource,
    {kind:'session',sessionId:'f116-browser'}));
  assert.equal(result.outcome.outcome,'completed');assert.equal(result.blob.type,'image/bmp');assert.equal(result.blob.size,230454);
  assert.equal(createHash('sha256').update(Buffer.from(await result.blob.arrayBuffer())).digest('hex'),
    '37fd346a4a9897c8f365fbe998d6a19b538212f7f4b534b1c829b44c138e5e4e');
});

test('deferred authored browser arms capture before connect entry traffic',async t=>{
  // Unique regression: the page can order start-capture before connect while
  // the chooser-selected candidate is still required to construct the server.
  const bytes=await migratedPackage('ti-nspire',['device.lua']);
  const artifact=new Uint8Array(await readFile(new URL('../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const resources=new ResourceBrokerHost(),resourceAdapter=new DirectResourceRpcAdapter(resources),sessionId='f123-browser-preconnect';
  const destinations=new CaptureDestinationRegistry(),captureAdapter=new DirectCaptureDestinationRpcAdapter(destinations,sessionId);
  const host=new BrowserSessionWorkerHost({...await migratedBrowserTransport('nspire'),authoredArtifact:artifact,
    authoredAcquisitionBinding:{kind:'permission-broker-v1'},resourceBroker:new ResourceBrokerRpcClient(resourceAdapter),captureDestinationAdapter:captureAdapter});
  await host.admit(bytes);const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(host));await client.attach('f123-browser');
  t.after(async()=>{await client.disconnect().catch(()=>undefined);await client.close();await resourceAdapter.close();await captureAdapter.close();});
  const grant={grantId:'f123-nspire-usb',matchedFilters:[0]},candidates=await client.resolveCandidates({mode:'device_information',profile:'usb',grant});assert.equal(candidates.length,1);
  const destination=new BrowserMemoryCaptureDestination(resources,sessionId),destinationId=await destinations.register(destination,sessionId);
  const capturePromise=client.startCapture(destinationId,{});await new Promise(done=>setImmediate(done));
  const connectPromise=client.connect({mode:'device_information',profile:'usb',candidateId:candidates[0].candidateId,grant});
  const [captureId,connected]=await Promise.all([capturePromise,connectPromise]);assert.equal(connected.kind,'connected');
  const summary=await client.stopCapture(captureId);assert.equal(summary.completeness,'complete');
  const loaded=await loadCapture((async function*(){yield destination.bytes();})());
  assert.equal(loaded.records.filter(record=>record.kind==='gap').length,0);
  assert.ok(loaded.records.some(record=>record.kind==='connection-open'));
  assert.ok(loaded.records.some(record=>record.kind==='tx-requested'),'entry traffic began before the browser capture');
  await destinations.release(destinationId);
});

test('device-3 ordinary browser binds the explicit serial profile before starting its receiver',async t=>{
  // Unique regression: a browser grant for device-3 being treated as proof for its other physical profile.
  const bytes=await migratedPackage('device-3',[{file:'device3.lua',logicalName:'device.lua'}]);
  const surface=await openMigratedBrowser(t,bytes,await migratedBrowserTransport('device-3'),'application','serial');
  const result=await runValue(surface.client,'get_device_info');
  assert.deepEqual({hardwareModel:result.hardwareModel,usbIdentity:result.usbIdentity,
    firmwareMajor:result.firmwareMajor,firmwareMinor:result.firmwareMinor,firmwarePatch:result.firmwarePatch},
    {hardwareModel:'daisy-seed-1.2',usbIdentity:'normal',firmwareMajor:1,firmwareMinor:2,firmwarePatch:3});
});

async function openMigratedBrowser(t,bytes,transport,mode,profile){
  const artifact=new Uint8Array(await readFile(new URL('../../../packages/lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
  const resources=new ResourceBrokerHost(),resourceAdapter=new DirectResourceRpcAdapter(resources);
  const capture=new DirectCaptureDestinationRpcAdapter(new CaptureDestinationRegistry(),'f92-browser');
  const host=new BrowserSessionWorkerHost({...transport,authoredArtifact:artifact,
    authoredAcquisitionBinding:{kind:'permission-broker-v1'},
    resourceBroker:new ResourceBrokerRpcClient(resourceAdapter),captureDestinationAdapter:capture});
  const loaded=await host.admit(bytes);assert.ok(loaded.profiles.some(value=>value.modeId===mode&&value.profileId===profile));
  const channel=new MessageChannel(),service=serveSessionRpc(channel.port2,host);
  const client=new DeviceSessionRpcClient(new PostMessageSessionRpcAdapter(channel.port1));await client.attach('f92-browser');
  t.after(async()=>{await client.disconnect().catch(()=>undefined);await client.close();service.dispose();await resourceAdapter.close();await capture.close();});
  const grant={grantId:`f92-${mode}-${profile}`,matchedFilters:[0]};
  const candidates=await client.resolveCandidates({mode,profile,grant});assert.equal(candidates.length,1);
  const connected=await client.connect({mode,profile,candidateId:candidates[0].candidateId,grant});assert.equal(connected.kind,'connected');
  return {client,loaded,resources};
}

async function runValue(client,operation){
  const handle=await client.startOperation({operation,arguments:{}}),outcome=await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);assert.equal(outcome.outcome,'completed');return outcome.result;
}
