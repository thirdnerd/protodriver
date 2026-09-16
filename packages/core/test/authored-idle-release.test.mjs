import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule,createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
import {observation,bounded} from '../../../test-support/entry-authority/population.mjs';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const members=source=>[{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},
 {logicalName:'device.lua',sourceBytes:Buffer.from(source)}];
function source({threshold=30000,prefix='io.request({kind="write",value="REENTER"})',body='',extra='',requires='"channel.write"',handler=false,
 suffix='io.request({kind="write",value=context.origin});io.request({kind="state-publish",cell="observed",quality="valid",value="yes"});return "ok"'}={}){
 return `local a=pdrv.array
 return {apiVersion="device/v2",id="idle-test",modes=a({"m"}),profiles=a({"p"}),
 state={observed={type={kind="string"},freshForMs=pdrv.null}${handler?',seen={type={kind="string"},freshForMs=pdrv.null}':''}},
 ${handler?'mailboxes=a({"handler"}),handlers=a({{id="receiver",binding="input",event={kind="channel-input",channelId="main"},maximumConcurrent=1,locks=a({}),requires=a({"channel.input"})}}),':''}
 operations=a({{id="ping",title="ping",binding="ping",arguments={},result={kind="value",type={kind="string"}},
 risk="read-only",repeatability="safe-to-repeat",locks=a({"protocol"}),requires=a({"channel.write","channel.read"}),
 availability={modes=a({"m"}),profiles=a({"p"})},releaseAfterIdleMs=${threshold},reentry={binding="enter",requires=a({${requires}})}}}),
 maintenance=a({{kind="poll",mode="m",operation="ping",intervalMs=200,failureBackoffMs=200,suspendWhileLocksHeld=a({"protocol"}),
 timing={kind="idle-reset",activity="foreground-lifecycle"}}})${extra}},
 {enter=function(_,io,context) ${prefix} end,
 ping=function(args,io,context) ${body}
 ${suffix} end${handler?',input=function(args,io) io.request({kind="state-publish",cell="seen",quality="valid",value=args.input}) end':''}}`;
}
async function harness(t,options={}){
 const clock=new VirtualClock(),writes=[],events=observation(),pending=Promise.withResolvers(),submitted=Promise.withResolvers(),reading=Promise.withResolvers();
 let received,readSettledSequence;
 const {server}=await createAuthoredSession(members(source(options)),wasm,{platform:'node',clock,modeId:'m',profileId:'p',channelId:'main',
 helpers:{},resourceBroker:{},captureDestinationAdapter:{},pollPolicy:{burst:4,refillEveryMs:200,minimumIntervalMs:200,maximumPlans:4},
 async open(){const connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
  const channel=connection.channel('main'),acquire=channel.acquire.bind(channel);channel.protocolDuplex='half-duplex';
  received=bytes=>channel.enqueueReceived(bytes);
  channel.acquire=async(...args)=>{const lease=await acquire(...args),incoming=lease.incoming.bind(lease);
   lease.incoming=()=>{const it=incoming()[Symbol.asyncIterator]();return {[Symbol.asyncIterator](){return this;},next(){reading.resolve();return it.next().then(value=>{readSettledSequence=clock.nextSequence();return value;});},return(){return it.return?.();}};};
   lease.write=async bytes=>{
   writes.push(Buffer.from(bytes).toString());submitted.resolve();if(options.hold)await pending.promise;
   return {atSequence:clock.nextSequence(),outcome:{kind:'accepted-by-platform'}};};return lease;};return connection;},...options.session});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{pending.resolve();await client.disconnect();await client.close();});
 await client.attach('idle');client.subscribe(e=>events.add(e));await client.connect({mode:'m'});
 const retirement=n=>bounded(events.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='retired'&&e.observation.retiredResults===n),'poll retired');
 const released=()=>bounded(events.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='released-idle'),'idle released');
 return {client,clock,writes,events,pending,submitted:submitted.promise,reading:reading.promise,inject:bytes=>received(bytes),retirement,released,
  readSettledSequence:()=>readSettledSequence,
  start:()=>client.startOperation({operation:'ping',arguments:{}})};
}
test('C6 exactly 149 scheduled pings; state invalidates, foreground prefix precedes command',{timeout:5000},async t=>{
 const h=await harness(t);
 for(let n=1;n<=149;n++){await h.clock.advance(200000);await h.retirement(n);}
 assert.equal(h.writes.length,149);
 assert.equal(h.events.seen.filter(e=>e.kind==='operation-end'&&e.result.outcome==='completed').length,149);
 assert.equal((await h.client.getSnapshot()).stateCells.observed.quality,'valid');
 await h.clock.advance(200000);
 const boundary=await bounded(h.events.wait(e=>e.kind==='scheduled-work'&&(e.observation.kind==='released-idle'
  || (e.observation.kind==='retired'&&e.observation.retiredResults===150))),'release or forbidden 150th retirement');
 assert.equal(boundary.observation.kind,'released-idle','maintenance must stop, not reset operator idle');
 assert.equal(h.writes.length,149);const before=await h.client.getSnapshot();
 assert.equal(before.scheduledWork.released,true);assert.equal(before.stateCells.observed.quality,'unknown');
 await h.clock.advance(1000000);assert.equal(h.writes.length,149);
 const op=await h.start(),r=await h.client.awaitOperation(op.operationId);assert.equal(r.outcome,'completed',JSON.stringify(r));
 assert.deepEqual(h.writes.slice(149),['REENTER','foreground']);
 await bounded(h.events.wait(e=>e.kind==='scheduled-work'&&e.observation.kind==='idle-reset'&&e.observation.operationId===op.operationId),'foreground retirement');
 const after=await h.client.getSnapshot();assert.equal(after.scheduledWork.released,false);
 assert.equal(after.scheduledWork.permitsSpent,before.scheduledWork.permitsSpent);
 assert.equal(after.scheduledWork.permitsRemaining,before.scheduledWork.permitsRemaining);
 await h.clock.advance(200000);await h.retirement(150);assert.equal(h.writes.at(-1),'scheduled');
});
test('C6 threshold cannot release or overtake an unresolved native write',{timeout:3000},async t=>{
 const h=await harness(t,{threshold:400,hold:true});await h.clock.advance(200000);await h.submitted;
 await h.clock.advance(200000);let s=await h.client.getSnapshot();assert.equal(s.scheduledWork.released,false);
 assert.deepEqual(h.writes,['scheduled']);await assert.rejects(h.start(),e=>e.error?.code==='retained.channel-busy');
 h.pending.resolve();await h.retirement(1);await h.released();assert.deepEqual(h.writes,['scheduled']);
 const retired=h.events.seen.findIndex(e=>e.kind==='scheduled-work'&&e.observation.kind==='retired');
 const released=h.events.seen.findIndex(e=>e.kind==='scheduled-work'&&e.observation.kind==='released-idle');
 assert.ok(released>retired,'release observation must follow native settlement and activation retirement');
});
test('C6 failed reentry has no ordinary suffix or automatic retry',{timeout:3000},async t=>{
 const h=await harness(t,{threshold:1,prefix:'io.request({kind="write",value="ATTEMPT"});pdrv.fail("failed-entry",{})'});
 await h.clock.advance(1000);await h.released();const op=await h.start(),r=await h.client.awaitOperation(op.operationId);
 assert.equal(r.outcome,'failed');assert.deepEqual(h.writes,['ATTEMPT']);
 await h.clock.advance(1000000);assert.deepEqual(h.writes,['ATTEMPT']);assert.equal((await h.client.getSnapshot()).scheduledWork.released,true);
});
test('C6 cancelled logical read retains the native obstruction until delivery',{timeout:3000},async t=>{
 const h=await harness(t,{threshold:400,body:'io.request({kind="read",maximum=1});'});
 await h.clock.advance(200000);await h.reading;await h.clock.advance(200000);
 const s=await h.client.getSnapshot(),id=s.scheduledWork.plans[0].activeOperation;
 await h.client.cancelOperation(id);await h.retirement(1);
 assert.equal((await h.client.getSnapshot()).scheduledWork.released,false);
 assert.equal(h.events.seen.some(e=>e.kind==='scheduled-work'&&e.observation.kind==='released-idle'),false);
 h.inject(Uint8Array.of(0x41));const release=await h.released();
 assert.ok(release.sequence>h.readSettledSequence(),'release must follow the actual native read settlement');
 assert.deepEqual(h.writes,[],'cancelled ordinary suffix remains revoked');
});
test('C6 unsupported reentry authority refuses before effects',{timeout:3000},async t=>{
 const h=await harness(t,{threshold:1,requires:'"usb.control"'});await h.clock.advance(1000);await h.released();
 await assert.rejects(h.start(),e=>e.error?.code==='authored.capability.unavailable');assert.deepEqual(h.writes,[]);
});
test('C6 prefix and ordinary computation share cumulative Lua fuel',{timeout:3000},async t=>{
 const loop=n=>`local sum=0;for i=1,${n} do sum=sum+i end;`;
 const prefix=n=>loop(n)+'io.request({kind="write",value="PREFIX-FUNDED"})';
 const positive=await harness(t,{threshold:1,prefix:prefix(200000),body:loop(200000)});await positive.clock.advance(1000);await positive.released();
 const p=await positive.start();assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');assert.deepEqual(positive.writes,['PREFIX-FUNDED','foreground']);
 const limited=await harness(t,{threshold:1,prefix:prefix(300000),body:loop(300000)});await limited.clock.advance(1000);await limited.released();
 const q=await limited.start(),r=await limited.client.awaitOperation(q.operationId);
 assert.deepEqual(limited.writes,['PREFIX-FUNDED']);assert.equal(r.error.code,'lua-vm.resource.fuel-exhausted');
});
test('C6 prefix native work is not refunded before the ordinary suffix',{timeout:3000},async t=>{
 const work='for i=1,16 do io.request({kind="write",value="step"}) end;';
 const positive=await harness(t,{threshold:1,prefix:work,body:work,session:{maximumEffectWork:100000}});
 await positive.clock.advance(1000);await positive.released();const p=await positive.start();
 assert.equal((await positive.client.awaitOperation(p.operationId)).outcome,'completed');assert.equal(positive.writes.at(-1),'foreground');
 const limited=await harness(t,{threshold:1,prefix:work,body:work,session:{maximumEffectWork:30000}});
 await limited.clock.advance(1000);await limited.released();const q=await limited.start(),r=await limited.client.awaitOperation(q.operationId);
 assert.ok(!limited.writes.includes('foreground'));assert.equal(r.error.code,'retained.work-exhausted');
});
test('C6 cancelling a suspended reentry cannot run its ordinary suffix',{timeout:3000},async t=>{
 const h=await harness(t,{threshold:1,hold:true});await h.clock.advance(1000);await h.released();
 const op=await h.start();await h.submitted;await h.client.cancelOperation(op.operationId);
 assert.equal((await h.client.awaitOperation(op.operationId)).outcome,'cancelled');
 await assert.rejects(h.start(),e=>e.error?.code==='retained.outbound-unresolved');
 h.pending.resolve();assert.deepEqual(h.writes,['REENTER']);
});
test('C6 refuses the H-I consuming-handler and idle-release pair at admission',{timeout:3000},async()=>{
 // This uniquely catches accidentally admitting the H-I census pair despite
 // block C6 selecting direct-channel reentry. Admission is the actual
 // boundary: do not fabricate a handler execution before the pair exists.
 await assert.rejects(admitAuthoredModule(members(source({threshold:400,handler:true,requires:'',
  prefix:'error("FORBIDDEN REENTRY")',suffix:'return "ok"'})),wasm),
 e=>e.code==='authored.declaration.invalid'&&e.message.endsWith('m: idle release requires direct-channel topology'));
});
for(const threshold of [0,-1,1.5,2147483648])test('C6 refuses invalid per-operation threshold '+threshold,async()=>{
 await assert.rejects(admitAuthoredModule(members(source({threshold})),wasm),e=>e.code==='authored.declaration.invalid');
});
