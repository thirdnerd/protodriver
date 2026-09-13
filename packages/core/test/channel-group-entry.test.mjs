import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule,createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {settings} from '../../../test-support/channel-group/fixture.mjs';
const original=await readFile(new URL('./fixtures/entry-handoff.lua',import.meta.url),'utf8');
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const code=original.replace('apiVersion="device/v2"','channelRoles={serial={request="requests",response="responses",event="events"}},apiVersion="device/v2"')
 .replaceAll('interactive','challenge').replace('args.modeId=="challenge" and "\\r\\n" or "*IDN?\\r\\n"','"PAIR"')
 .replace('mailbox="reply",value=args.input','mailbox="reply",value=args.channelId..":"..args.input');
const members=[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(code)}];
test('role admission refuses missing, malformed and unknown-profile bindings; roles affect identity',async()=>{
 const inputs=value=>[members[0],{...members[1],sourceBytes:Buffer.from(value)}];
 for(const value of [code.replace(',event="events"',''),code.replace('event="events"','event="bad id"'),code.replace('channelRoles={serial=','channelRoles={missing=')])
  await assert.rejects(admitAuthoredModule(inputs(value),wasm),e=>e.code==='authored.declaration.invalid');
 const base=await admitAuthoredModule(members,wasm),changed=code.replace('event="events"','event="responses"');
 assert.notEqual((await admitAuthoredModule(inputs(changed),wasm)).identity.digest,base.identity.digest);
});
test('entry handoff preserves each physical input in handler bytes and metadata',{timeout:5000},async t=>{
 const native=[],options=settings(new InMemoryTransferCheckpointStore(),{},{},e=>native.push(e),'entry');
 const {server}=await createAuthoredSession(members,wasm,{...options,platform:'node'});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));t.after(async()=>{await client.disconnect();await client.close();});
 await client.attach('B3 entry');await client.connect({mode:'challenge'});
 const answers=[];
 for(let i=0;i<2;i++){
  const op=await client.startOperation({operation:'collect',arguments:{}}),result=await client.awaitOperation(op.operationId);
  assert.equal(result.outcome,'completed',JSON.stringify(result));answers.push(result.result);
 }
 assert.deepEqual(answers,['message:reply:responses:L','message:reply:events:E']);
 assert.deepEqual(native.filter(e=>e.kind==='write').map(e=>new TextDecoder().decode(Uint8Array.from(e.bytes))),['PAIR','H:L','H:E']);
});
test('iterator-install failure releases the entire group and closes its connection',{timeout:5000},async()=>{
 const native=[],options=settings(new InMemoryTransferCheckpointStore(),{},{},e=>native.push(e),'entry'),open=options.open;
 let closed=false;
 options.open=async()=>{
  const c=await open(),close=c.close.bind(c);c.close=async()=>{await close();closed=true;};
  const event=c.channel('events'),acquire=event.acquire.bind(event);
  event.acquire=async(...args)=>{const lease=await acquire(...args);lease.incoming=()=>{throw new Error('iterator install rejected');};return lease;};return c;
 };
 const {server}=await createAuthoredSession(members,wasm,{...options,platform:'node'}),client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 try{await client.attach('B3 failure');await assert.rejects(client.connect({mode:'challenge'}),/iterator install rejected/);
  assert.equal(closed,true);assert.deepEqual(native.filter(e=>e.kind==='lease-released').map(e=>e.channel),['events','responses','requests']);
  assert.equal(native.filter(e=>e.kind==='write').length,0);
 }finally{await client.disconnect();await client.close();}
});
