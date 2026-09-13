import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {InputWorkAccount,InputWorkRanges} from '../src/input-work.ts';
import {NativeHelperData} from '../src/native-helper.ts';
import {BoundedIngress} from '../src/ingress.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {bounded} from './fixtures/handler-delivery-harness.mjs';

async function observe(t,workerData){
 const w=new Worker(new URL('./fixtures/input-tail-work.mjs',import.meta.url),{workerData});t.after(()=>w.terminate());
 return bounded(new Promise((yes,no)=>{w.once('message',yes);w.once('error',no);w.once('exit',code=>no(Error('tail observer exited '+code)));}),'tail executor observation');
}
test('entry read, multi-observation fill and C1.1 move the same funded raw prefixes',{timeout:8000},async t=>{
 const r=await observe(t,'entry');assert.deepEqual(r.writes,[[65,66,67,120]]);assert.equal(r.completeness,'complete');
 assert.deepEqual(r.prefix.map(s=>s.remaining),[1,3]);assert.ok(r.prefix[0].sequence<r.prefix[1].sequence);
 for(const s of r.prefix){assert.equal(s.work,s.parent,'observation minted a separate grant');assert.ok(s.work>s.initial);assert.equal(s.closed,false);}
 assert.deepEqual(r.prefix.map(s=>s.observationDebit),[5,5],'native census did not spend entry work before publishing');
 assert.deepEqual(r.consumptions.at(-1),[{remaining:0,closed:false},{remaining:0,closed:false}],
  'consumption dropped an older prefix dependency before its interpreting turn ended');
 assert.ok(r.deferrals.length>0,'control did not exercise funded deferred publication');
 for(const d of r.deferrals)assert.equal(d.after-d.before,1,'deferred frame did not debit the original account');
 for(const s of r.final){assert.equal(s.remaining,0,'handoff lost original custody');assert.equal(s.closed,true);assert.equal(s.work,s.parent);}
});
test('revoked iterator promise retains its original capacity and disposal funding on the executor',{timeout:8000},async t=>{
 const r=await observe(t,'promise');assert.equal(r.quotaHeld,true,'native backing was reusable before actual receipt');
 assert.equal(r.before.closed,false);assert.equal(r.after.closed,true);assert.ok(r.after.work>r.before.work);assert.deepEqual(r.writes,[]);
});
test('raw consumption retains an older source through the consuming activation, not just its byte claim',()=>{
 const data=new NativeHelperData(2048),source=new InputWorkAccount(data,1000,2,true),ranges=new InputWorkRanges(0);
 ranges.append(source,2);let interpretation;
 ranges.consume(2,s=>{interpretation=s.interpretation();});source.close();
 assert.equal(source.remaining,0);assert.equal(source.closed,false);
 assert.throws(()=>data.reserve(1800),/data account exhausted/);
 interpretation.release();assert.equal(source.closed,true);data.reserve(1800).release();
});
test('native dequeue transfers its ticket; discard releases only nodes still owned by the queue',async()=>{
 const clock=new VirtualClock(),ingress=new BoundedIngress({clock,channelId:'main',hardLimitBytes:20});
 const data=new NativeHelperData(),sources=[];
 ingress.bindInputCustody({clock,observed(sequence,bytes){const s=new InputWorkAccount(data,1000,bytes,true);s.nativeBegin(bytes);sources.push(s);
  return{discarded(){s.nativeEnd();s.revoke();s.close();}};},revoked(){for(const s of sources){s.revoke();s.close();}}});
 const iterator=ingress.incoming()[Symbol.asyncIterator]();const pending=iterator.next();
 ingress.push(Uint8Array.of(65));ingress.push(Uint8Array.of(66));ingress.discardAndClose();
 assert.equal(sources[0].closed,false);assert.equal(sources[1].closed,true);
 const result=await pending;assert.deepEqual([...result.value.bytes],[65]);sources[0].nativeEnd();assert.equal(sources[0].closed,true);
});
test('a failed installation census keeps earlier native nodes funded until rollback discards them',()=>{
 const clock=new VirtualClock(),ingress=new BoundedIngress({clock,channelId:'main',hardLimitBytes:20}),data=new NativeHelperData();
 ingress.push(Uint8Array.of(65));ingress.push(Uint8Array.of(66));let source;
 assert.throws(()=>ingress.bindInputCustody({clock,observed(sequence,bytes){
  if(source)throw Error('census refused second observation');
  source=new InputWorkAccount(data,1000,bytes,true);source.nativeBegin(bytes);
  return{discarded(){source.nativeEnd();source.revoke();source.close();}};
 },revoked(){source.revoke();source.close();}}),/census refused/);
 assert.equal(ingress.metrics.retainedBytes,2);assert.equal(source.closed,false);
 ingress.discardAndClose();assert.equal(source.closed,true);assert.equal(ingress.metrics.retainedBytes,0);
});
test('deferred and grouped frames cannot free an original observation before every holder releases',()=>{
 const data=new NativeHelperData(4096),s=new InputWorkAccount(data,1000,1,false);
 s.nativeBegin(100);const group=s.publication(200),deferred=s.deferred(300);s.close();
 s.nativeEnd();group.release();assert.equal(s.closed,false);
 assert.throws(()=>data.reserve(3800),/data account exhausted/);const before=s.work;
 deferred.release();assert.equal(s.closed,true);assert.equal(s.work,before+2);data.reserve(3800).release();
});
test('borrowed custody conserves entry reservations and never freezes the parent counter',()=>{
 const parent={work:17,reserved:0},data=new NativeHelperData();
 const s=new InputWorkAccount(data,1000,2,true,{work:()=>parent.work,reserve:n=>{parent.reserved+=n;},charge:n=>{parent.work+=n;},spend:n=>{parent.reserved-=n;parent.work+=n;},release:n=>{parent.reserved-=n;}});
 s.nativeBegin(2);const entry=s.interpretation(),ranges=new InputWorkRanges(0);ranges.append(s,2);
 let consumer;ranges.consume(2,source=>{consumer=source.interpretation();});s.nativeEnd();s.close();entry.release();consumer.release();
 assert.equal(parent.work,30);assert.equal(parent.reserved,0);assert.equal(s.closed,true);
 parent.work+=4;assert.equal(parent.work,34,'source disposal ended entry authority');
});
