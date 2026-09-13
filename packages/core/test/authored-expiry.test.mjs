import assert from 'node:assert/strict';
import test from 'node:test';
import {make,bounded} from './fixtures/authored-time-harness.mjs';
import {VirtualClock} from '../../../test-support/clock.ts';
import {AuthoredTimeBasis} from '../src/authored-clock.ts';
import {AuthoredExpiryLedger,EXPIRY_WORK,EXPIRY_SCRATCH} from '../src/authored-expiry.ts';
import {NativeHelperData} from '../src/native-helper.ts';
import {NativeRunway} from '../src/native-runway.ts';
import {nativeJson} from '../../lua-vm/src/native-account.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';

function ledger(){
 const clock=new VirtualClock(),basis=new AuthoredTimeBasis(clock),data=new NativeHelperData(),records=[],stored=new Map();
 let generation=1,serial=0,paid=0;const failures=[];
 const service=new AuthoredExpiryLedger({clock,basis,generation:()=>generation,live:()=>true,hasCapacity:()=>service.size<2,
  identity:()=>`expiry-${++serial}`,prepay:()=>{paid+=EXPIRY_WORK;const r=new NativeRunway(data,()=>{},()=>{},()=>{});r.ensure(EXPIRY_WORK,EXPIRY_SCRATCH);return r;},
  reserve:(id,v)=>stored.set(id,v),forget:id=>stored.delete(id),record:(kind,fields)=>records.push(JSON.parse(nativeJson({kind,...fields}))),failed:e=>failures.push(e)});
 return{clock,service,records,failures,stored,paid:()=>paid,
  reserve(owner,ms){const id=service.reserve(owner,ms);service.commitDelivery(owner,id);return id;},
  end(){generation++;service.clear('generation-ended');}};
}
for(const inputFirst of [true,false])test(`B8 native input and expiry share sequence order; inputFirst=${inputFirst}`,async()=>{
 const h=ledger(),c=new MockTransport(h.clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'}),channel=c.channel('main');
 const lease=await channel.acquire('raw'),iterator=lease.incoming()[Symbol.asyncIterator]();
 try{
  const id=h.reserve('ended-owner',10);
  if(inputFirst)h.clock.timer(10,()=>channel.enqueueReceived(Uint8Array.of(65)));
  h.service.terminal('ended-owner',0);
  if(!inputFirst)h.clock.timer(10,()=>channel.enqueueReceived(Uint8Array.of(65)));
  await h.clock.advance(10000);const input=(await iterator.next()).value;
  await h.clock.advance(10000);const read=h.service.read(id);
  assert.equal(read.status,'expired');assert.equal(read.elapsedUs,input.tUs);
  assert.equal(input.atSequence<read.sequence,inputFirst);
  assert.deepEqual(read,h.records.find(r=>r.kind==='expiry-observed').expiry,'read preserves original event, not read time');
  assert.equal(h.paid(),EXPIRY_WORK);assert.deepEqual(h.failures,[]);
 }finally{h.end();await lease.release();await c.close();}
});
test('B8.1 host-owned delivery retires at terminal without refund or an expiry event',async()=>{
 const h=ledger();
 for(let i=0;i<16;i++){
  const id=h.service.reserve('a',1);
  assert.throws(()=>h.service.read(id),/host delivery/);
  assert.throws(()=>h.service.release(id),/host delivery/);
  assert.throws(()=>h.service.start('a',id),/host delivery/);
  assert.throws(()=>h.service.commitDelivery('other',id),/pending delivery/);
  h.service.terminal('a',0);
  assert.equal(h.service.size,0);assert.equal(h.stored.size,0);
 }
 await h.clock.advance(1000);
 assert.equal(h.records.filter(r=>r.kind==='expiry-observed').length,0);
 assert.equal(h.records.filter(r=>r.kind==='expiry-retired'&&r.reason==='undelivered').length,16);
 assert.equal(h.paid(),16*EXPIRY_WORK);assert.deepEqual(h.failures,[]);h.end();
});
test('B8.1 commit is irreversible without an executor acknowledgement; generation end clears the residue',async()=>{
 const h=ledger(),id=h.reserve('a',1);
 assert.throws(()=>h.service.commitDelivery('a',id),/pending delivery/);
 h.service.terminal('a',0);await h.clock.advance(1000);
 assert.equal(h.service.read(id).status,'expired');assert.equal(h.service.size,1);
 assert.equal(h.records.filter(r=>r.kind==='expiry-retired').length,0);
 h.end();assert.equal(h.service.size,0);assert.equal(h.stored.size,0);
 assert.equal(h.records.at(-1).reason,'generation-ended');assert.equal(h.paid(),EXPIRY_WORK);
});
test('B8 expired slots remain occupied; creator-only start and generation revocation are enforced',async()=>{
 const h=ledger(),a=h.reserve('a',1),b=h.reserve('b',1);
 assert.throws(()=>h.service.start('other',a),/creator/);h.service.start('a',a);h.service.terminal('b',0);
 await h.clock.advance(1000);assert.equal(h.service.size,2);assert.throws(()=>h.service.reserve('c',1),/slots exhausted/);
 h.service.release(a);const c=h.reserve('c',1);assert.equal(h.service.read(c).status,'reserved');
 h.end();assert.equal(h.service.size,0);assert.equal(h.stored.size,0);assert.equal(h.clock.pending.length,0);
 assert.throws(()=>h.service.read(b),/unknown, released or/);
});
test('B8 revoked creator stays dead while a successor reads its expiry; ordinary timer stays revoked',{timeout:5000},async t=>{
 const h=await make(t,{expiryGrant:true,writeGrant:true,body:`runs=runs+1
  if runs==1 then io.request({kind="write",value="READY"});saved={expiry=io.request({kind="expiry-reserve",milliseconds=10}),timer=io.request({kind="timer-arm",milliseconds=1000})}
   io.request({kind="wait-any",maximum=0,timers=a({saved.timer})});io.request({kind="write",value="FORBIDDEN"});return "bad"
  elseif runs==2 then local o=io.request({kind="expiry-read",expiry=saved.expiry});assert(not pcall(function()o.sequence=0 end));return o.status.."|"..string.format("%d",o.elapsedUs)
  else io.request({kind="timer-cancel",timer=saved.timer});return "bad" end`});
 const op=await h.start();await h.wait(e=>e.kind==='effect'&&e.owner===op.operationId&&e.effect==='wait-any');
 await h.client.cancelOperation(op.operationId);assert.equal((await h.client.awaitOperation(op.operationId)).outcome,'cancelled');
 await h.clock.advance(1001000);
 assert.equal((await h.run()).result,'expired|10000');assert.equal((await h.run()).error.code,'retained.timer-not-granted');
 assert.deepEqual(h.seen.filter(e=>e.kind==='native-write').map(e=>e.text),['READY']);assert.equal((await h.stop()).completeness,'complete');
});
test('B8 host terminal starts the expiry before delayed cleanup can run',{timeout:5000},async t=>{
 const held=Promise.withResolvers(),gate=Promise.withResolvers();let starts=0;
 const h=await make(t,{expiryGrant:true,handler:'return',body:`runs=runs+1;if runs>1 then return runs==2 and "peer" or saved end
  saved=io.request({kind="expiry-reserve",milliseconds=10});local timer=io.request({kind="timer-arm",milliseconds=1000});io.request({kind="wait-any",maximum=0,timers=a({timer})})`,
  cleanup:'if args.outcome=="cancelled" then local o=io.request({kind="expiry-read",expiry=saved});saved=o.status.."|"..string.format("%d",o.elapsedUs) end',
  beforeStart:async binding=>{if(binding==='run'&&++starts===2){held.resolve();await gate.promise;}},release:()=>gate.resolve()});
 const op=await h.start();await h.wait(e=>e.kind==='effect'&&e.owner===op.operationId&&e.effect==='wait-any');
 const peer=await h.start();await bounded(held.promise,'peer held');await h.client.cancelOperation(op.operationId);
 await h.clock.advance(20000);gate.resolve();
 assert.equal((await bounded(h.client.awaitOperation(op.operationId),'cleanup result')).outcome,'cancelled');
 assert.equal((await h.client.awaitOperation(peer.operationId)).outcome,'completed');assert.equal((await h.run()).result,'expired|10000');
});
test('B8 reads after delayed input dispatch preserve both equal-time orders',{timeout:5000},async t=>{
 for(const inputFirst of [true,false]){
  const held=Promise.withResolvers(),gate=Promise.withResolvers();let first=true;
  const h=await make(t,{expiryGrant:true,handler:'io.request({kind="write",value=string.format("%d",args.observation.sequence)})',
   body:'runs=runs+1;if runs==1 then saved=io.request({kind="expiry-reserve",milliseconds=10});return "reserved" end;local o=io.request({kind="expiry-read",expiry=saved});return string.format("%d",o.sequence)',
   beforeStart:async binding=>{if(binding==='input'&&first){first=false;held.resolve();await gate.promise;}},release:()=>gate.resolve()});
  if(inputFirst)h.clock.timer(10,()=>h.inject(new Uint8Array(600)));
  assert.equal((await h.run()).result,'reserved');
  if(!inputFirst)h.clock.timer(10,()=>h.inject(new Uint8Array(600)));
  await h.clock.advance(10000);await bounded(held.promise,'input held');await h.clock.advance(10000);gate.resolve();
  await h.wait(e=>e.kind==='native-write'&&h.seen.filter(x=>x.kind==='native-write').length===3);
  const expiry=+(await h.run()).result,inputs=h.seen.filter(e=>e.kind==='native-write').map(e=>+e.text);
  assert.equal(inputs.length,3);assert.equal(new Set(inputs).size,1);assert.equal(inputs[0]<expiry,inputFirst);
 }
});
test('B8 grants, prepaid work and the shared ordinary timer bound refuse before registration',{timeout:5000},async t=>{
 const ungranted=await make(t,{body:'io.request({kind="expiry-reserve",milliseconds=1});return "bad"'});
 assert.equal((await ungranted.run()).error.code,'retained.expiry-not-granted');
 const low=await make(t,{expiryGrant:true,body:'io.request({kind="expiry-reserve",milliseconds=1});return "bad"',session:{maximumEffectWork:8000}});
 const refused=await low.run();assert.equal(refused.outcome,'failed');assert.equal(refused.error?.code,'retained.work-exhausted');
 const full=await make(t,{expiryGrant:true,body:'io.request({kind="expiry-reserve",milliseconds=1});io.request({kind="timer-arm",milliseconds=1});return "bad"',session:{maximumConcurrentTimers:1}});
 assert.equal((await full.run()).error.code,'retained.timer-limit');
});
