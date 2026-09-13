import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const source=(close,requires='"connection.lifecycle","timer"')=>`local a=pdrv.array
return {apiVersion="device/v2",id="scheduled-cleanup",modes=a({"m"}),profiles=a({"p"}),invalidation="invalidated",mailboxes=a({"reply"}),
handlers=a({{id="receiver",binding="input",event={kind="channel-input",channelId="main"},maximumConcurrent=2,locks=a({"parser"}),requires=a({"channel.input","channel.write","timer"})}}),
operations=a({{id="run",title="run",binding="run",arguments={},result={kind="none"},risk="read-only",repeatability="safe-to-repeat",
locks=a({"operation"}),requires=a({"mailbox"}),availability={modes=a({"m"}),profiles=a({"p"})},
cleanup={binding="cleanup",requires=a({${requires}}),maximumMilliseconds=50,maximumLuaFuel=10000,maximumWork=100000}}})},
{run=function(_,io) io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})}) end,
input=function(_,io) io.request({kind="write",value="HANDLER"});local t=io.request({kind="timer-arm",milliseconds=20});io.request({kind="wait-any",maximum=0,timers=a({t})});io.request({kind="write",value="TAIL"}) end,
cleanup=function(_,io) local t=io.request({kind="timer-arm",milliseconds=10});io.request({kind="wait-any",maximum=0,timers=a({t})});${close?'local c=io.request({kind="connection-grant"});io.request({kind="connection-close",connection=c:match("^([^|]+)")})':''} end,
invalidated=function() end}`;
async function harness(t,close,requires){
 const clock=new VirtualClock(),timers=[],waiters=[],writes=[],writeWaiters=[];let channel,closed=false;
 const timer=clock.timer.bind(clock);clock.timer=(ms,fn)=>{const v=timer(ms,fn);timers.push(ms);for(const w of waiters)w();return v;};
 const waitTimer=ms=>new Promise(resolve=>{const check=()=>{if(timers.includes(ms))resolve();};waiters.push(check);check();});
 const {server}=await createAuthoredSession([{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
 {logicalName:'device.lua',sourceBytes:Buffer.from(source(close,requires))}],wasm,{platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:{},captureDestinationAdapter:{},
 async open(){const c=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
 channel=c.channel('main');const acquire=channel.acquire.bind(channel),end=c.close.bind(c);
 c.close=async()=>{closed=true;return end();};channel.acquire=async(...args)=>{const l=await acquire(...args);l.write=async bytes=>{
 writes.push(Buffer.from(bytes).toString());for(const w of writeWaiters)w();return{atSequence:clock.nextSequence(),outcome:{kind:'accepted-by-platform'}};};return l;};return c;}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{await client.disconnect();await client.close();});await client.attach('F41');await client.connect({mode:'m'});
 return{client,clock,writes,waitTimer,waitWrite:value=>new Promise(resolve=>{const check=()=>{if(writes.includes(value))resolve();};writeWaiters.push(check);check();}),inject:()=>channel.enqueueReceived(Uint8Array.of(88)),closed:()=>closed};
}
for(const close of [false,true])test('scheduled cleanup cancellation '+(close?'closes and revokes handler tail':'leaves unrelated handler runnable'),{timeout:3000},async t=>{
 const h=await harness(t,close);h.inject();await h.waitTimer(20);
 const op=await h.client.startOperation({operation:'run',arguments:{}});
 await h.client.cancelOperation(op.operationId);await h.waitTimer(10);
 await assert.rejects(h.client.startOperation({operation:'run',arguments:{}}),e=>e.error?.code==='authored.lock-busy');
 await h.clock.advance(10000);const r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'cancelled');assert.equal(r.error.details.cleanup.outcome,'completed');
 assert.ok(r.error.details.cleanup.work>0&&r.error.details.cleanup.work<=100000);
 assert.equal(h.closed(),close);assert.deepEqual(h.writes,['HANDLER']);
 await h.clock.advance(10000);
 if(!close)await h.waitWrite('TAIL');
 assert.deepEqual(h.writes,close?['HANDLER']:['HANDLER','TAIL']);
});
test('scheduled cleanup still refuses ungranted direct channel authority before start',{timeout:3000},async t=>{
 const h=await harness(t,false,'"channel.read"');
 await assert.rejects(h.client.startOperation({operation:'run',arguments:{}}),e=>e.error?.code==='authored.capability.unavailable'&&e.error.details.started===false);
 assert.deepEqual(h.writes,[]);
});
