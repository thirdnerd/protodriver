import test from 'node:test';
import assert from 'node:assert/strict';
import {InputWorkAccount} from '../src/input-work.ts';
import {NativeHelperData} from '../src/native-helper.ts';
import {make,bounded} from './fixtures/handler-delivery-harness.mjs';
import {Worker} from 'node:worker_threads';

test('a pending publication keeps original funding and backing capacity through revocation',()=>{
 const data=new NativeHelperData(512),source=new InputWorkAccount(data,1000,1,false);
 const owner={work:0};source.bind(owner);
 const initial=source.work,frame=source.publication(100);
 assert.equal(source.work,initial+1,'publication frame setup is uncharged');
 assert.throws(()=>source.publication(1),/already has/);
 source.revoke();source.close();
 assert.throws(()=>data.reserve(50),/data account exhausted/,'backing capacity was freed before its holder settled');
 assert.equal(source.closed,false,'publication still owns a frame');
 assert.throws(()=>source.charge(1),/exhausted/,'ordinary authority survived revocation');
 assert.throws(()=>{owner.work++;},/finalized/,'bound activation authority survived revocation');
 frame.release();assert.equal(source.closed,true);
 assert.equal(source.work,initial+3,'frame release and final source disposal must spend the original reservation');
 const final=source.work;frame.release();source.close();assert.equal(source.work,final);
 data.reserve(400).release();
});
test('a queued group input does not dispatch ahead of a held authored turn',{timeout:8000},async t=>{
 const h=await make(t,{group:true,dispatchGate:true,consumedRanges:true,
   body:'io.request({kind="input-consume",length=#args.input});io.request({kind="write",value=pdrv.bytes(args.input)})'});
 h.inject([65],'responses');await h.wait(e=>e.kind==='gated');
 h.inject([66],'events');
 await h.wait(e=>e.kind==='ingress'&&h.metrics('events').deliveredBytes===1);
 assert.equal(h.seen.filter(e=>e.kind==='start'&&e.binding==='input').length,1);
 h.gate.resolve();await h.wait(e=>e.kind==='write'&&e.bytes[0]===66);
 const c=await h.capture();assert.equal(c.footer.completeness,'complete');
 const rx=c.records.filter(r=>r.kind==='rx-delivered');assert.equal(rx.length,2);
 assert.deepEqual(rx.map(r=>r.ch),['responses','events']);
 assert.deepEqual(h.writes(),[[65],[66]]);
});
test('revocation drops a queued group publication without dispatching its bytes',{timeout:8000},async t=>{
 const h=await make(t,{group:true,dispatchGate:true});
 h.inject([65],'responses');await h.wait(e=>e.kind==='gated');
 h.inject([66],'events');await h.wait(e=>e.kind==='ingress'&&h.metrics('events').deliveredBytes===1);
 await h.client.disconnect();h.gate.resolve();
 await h.wait(e=>e.kind==='retired');
 assert.equal(h.seen.filter(e=>e.kind==='start'&&e.binding==='input').length,1);
 assert.deepEqual(h.writes(),[]);
});
test('group setup and disposal debit the original account on the actual executor path',{timeout:8000},async t=>{
 const worker=new Worker(new URL('./fixtures/publication-work.mjs',import.meta.url));t.after(()=>worker.terminate());
 const r=await bounded(new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(Error('publication observer exited '+code)));}),'publication debit observation');
 assert.deepEqual(r.writes,[[65],[66]]);assert.equal(r.completeness,'complete');
 for(const phase of ['setup','release']){
  const rows=r.debits.filter(d=>d.phase===phase);assert.equal(rows.length,2);
  for(const row of rows){assert.ok(row.before>0);assert.equal(row.after-row.before,1,phase+' did not debit its original input account');}
 }
});
