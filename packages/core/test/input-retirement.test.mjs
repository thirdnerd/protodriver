import test from 'node:test';
import assert from 'node:assert/strict';
import {InputRetirementIndex,InputCustodyRanges,ProtocolCustodyAccounts} from '../src/input-retirement.ts';
import {BoundedIngress} from '../src/ingress.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';

function fixture(){
  let work=0,resident=0,queries=0;
  const reserve=bytes=>{resident+=bytes;let live=true;return{dispose(){if(live){live=false;resident-=bytes;}}};};
  const index=new InputRetirementIndex(()=>({iteration(){work++;},reserve,close(){}}));
  return{index,reserve,iteration(){queries++;},get work(){return work;},get queries(){return queries;},get resident(){return resident;}};
}
test('retirement includes stamped but unpublished input; installation fails after a read starts',async()=>{
  const f=fixture(),clock=new VirtualClock(),ingress=new BoundedIngress({clock,channelId:'in',hardLimitBytes:1024});
  const bind=ingress.bindInputCustody({observed:(s,n)=>f.index.register(s,n),revoked:()=>f.index.close()});
  const iterator=ingress.incoming()[Symbol.asyncIterator]();
  const pending=iterator.next();ingress.push(new Uint8Array(423));
  const before=clock.nextSequence();
  assert.equal(f.index.retired(1,before,f.iteration),false,'pending iterator publication lost custody');
  const {value}=await pending;
  assert.throws(()=>ingress.bindInputCustody({observed(){},revoked(){}}),/cut-unavailable/);
  f.index.consume(value.atSequence,256);
  assert.equal(f.index.retired(1,before,f.iteration),false,'first subdivision retired the tail');
  const hold=f.index.retain(value.atSequence);
  f.index.consume(value.atSequence,167);
  assert.equal(f.index.retired(1,before,f.iteration),false,'consumption erased active classification');
  hold.dispose();assert.equal(f.index.retired(1,before,f.iteration),true);
  assert.equal(f.resident,0);bind.dispose();await iterator.return();
});
test('installation inventories already queued input and raw prefixes survive handler return',()=>{
  const f=fixture(),clock=new VirtualClock(),ingress=new BoundedIngress({clock,channelId:'in',hardLimitBytes:1024});
  ingress.push(new Uint8Array(47));
  ingress.bindInputCustody({observed:(s,n)=>f.index.register(s,n),revoked:()=>f.index.close()});
  const hold=f.index.retain(1);hold.dispose();
  assert.equal(f.index.retired(1,2,f.iteration),false);
  f.index.consume(1,46);assert.equal(f.index.retired(1,2,f.iteration),false);
  f.index.consume(1,1);assert.equal(f.index.retired(1,2,f.iteration),true);
});
test('an ancient observation cannot pin a later interval; unrelated arrivals never recheck a watch',()=>{
  const f=fixture();f.index.register(1,1);f.index.register(10,1);
  let completed=0;
  const watch=f.index.watch(5,20,()=>completed++,f.iteration,f.reserve),queries=f.queries;
  for(let s=20;s<1020;s++){f.index.register(s,1);f.index.consume(s,1);}
  assert.equal(f.queries,queries,'unrelated ingress queried history');assert.equal(completed,0);
  f.index.consume(10,1);assert.equal(completed,1);
  assert.equal(f.index.retired(5,20,f.iteration),true);watch.dispose();
  f.index.close();assert.equal(f.resident,0);
  assert.throws(()=>f.index.retired(5,20,f.iteration),/revoked/);
});
test('AVL interval lookup agrees with a distinct-observation oracle through arbitrary removals',()=>{
  const f=fixture(),points=new Set();
  for(let s=1;s<=4096;s++){f.index.register(s,1);points.add(s);}
  let seed=0x12345678;
  for(let n=0;n<8192;n++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const s=1+seed%4096;
    if(points.delete(s))f.index.consume(s,1);
    const from=1+(seed>>>12)%4096,before=from+1+(seed>>>20)%100;
    const initial=f.queries;
    assert.equal(f.index.retired(from,before,f.iteration),![...points].some(p=>from<=p&&p<before));
    assert.ok(f.queries-initial<=24,'interval lookup traversed the population instead of the index');
  }
  f.index.close();assert.equal(f.resident,0);
});
test('a watch follows successive witnesses once and refuses malformed consumption',()=>{
  const f=fixture();for(const s of [10,11,12])f.index.register(s,2);
  let ready=0;f.index.watch(10,13,()=>ready++,f.iteration,f.reserve);
  assert.throws(()=>f.index.consume(10,3),/invalid-consumption/);
  for(const s of [11,10]){f.index.consume(s,2);assert.equal(ready,0);}
  f.index.consume(12,2);assert.equal(ready,1);assert.equal(f.resident,0);
});
test('a throwing retirement callback cannot strand the other watches or their storage',()=>{
  const f=fixture();f.index.register(1,1);
  f.index.watch(1,2,()=>{throw Error('broken observer');},f.iteration,f.reserve);
  let settled=0;f.index.watch(1,2,()=>settled++,f.iteration,f.reserve);
  assert.throws(()=>f.index.consume(1,1),/broken observer/);
  assert.equal(settled,1);assert.equal(f.resident,0);assert.equal(f.index.size,0);
});
test('generation close releases every reservation even when accounting reports a failure',()=>{
  let resident=0,refuse=false,closed=0;
  const reserve=n=>{resident+=n;let live=true;return{dispose(){if(live){live=false;resident-=n;}}};};
  const index=new InputRetirementIndex(()=>({iteration(){if(refuse)throw Error('account failed');},reserve,close(){closed++;}}));
  for(let s=1;s<=3;s++)index.register(s,1);
  const stale=index.retain(1);index.watch(1,4,()=>assert.fail('close published a positive proof'),()=>{},reserve);
  refuse=true;assert.throws(()=>index.close(),/account failed/);
  assert.equal(closed,3);assert.equal(index.closed,true);assert.equal(resident,0);stale.dispose();
});
test('each lookup iteration spends the requesting work allowance, not just query entry',()=>{
  const f=fixture();for(let s=1;s<=1024;s++)f.index.register(s,1);
  let remaining=3;
  assert.throws(()=>f.index.retired(1000,1001,()=>{if(--remaining<0)throw Error('query work exhausted');}),/query work exhausted/);
  assert.equal(f.index.retired(1000,1001,f.iteration),false);
  f.index.close();assert.equal(f.resident,0);
});
test('insertion refuses before publishing an observation whose traversal is unfunded',()=>{
  let resident=0,refuse=false,remaining=3;
  const reserve=n=>{resident+=n;let live=true;return{dispose(){if(live){live=false;resident-=n;}}};};
  const index=new InputRetirementIndex(s=>({iteration(){if(refuse&&s===1025&&--remaining<0)throw Error('source work exhausted');},reserve,close(){}}));
  for(let s=1;s<=1024;s++)index.register(s,1);
  const before=resident;refuse=true;
  assert.throws(()=>index.register(1025,1),/source work exhausted/);
  assert.equal(index.size,1024);assert.equal(resident,before);
  assert.equal(index.retired(1025,1026,()=>{}),true);
  index.close();assert.equal(resident,0);
});
test('a released or terminated ingress binding cannot keep answering successful cuts',async()=>{
  for(const end of ['released','terminated']){
    const f=fixture(),clock=new VirtualClock(),ingress=new BoundedIngress({clock,channelId:'in',hardLimitBytes:10});
    let reason;
    const binding=ingress.bindInputCustody({observed:(s,n)=>f.index.register(s,n),revoked:r=>{reason=r;f.index.close();}});
    const it=ingress.incoming()[Symbol.asyncIterator](),pending=it.next();
    if(end==='released'){binding.dispose();ingress.close({kind:'closed-by-host'});}
    else ingress.close({kind:'closed-by-host'});
    assert.equal((await pending).done,true);assert.equal(reason,end);
    assert.throws(()=>f.index.retired(1,2,f.iteration),/revoked/);
    binding.dispose();assert.equal(reason,end);
  }
});
test('revocation observer failure cannot turn pending input termination into a hang',async()=>{
  const ingress=new BoundedIngress({clock:new VirtualClock(),channelId:'in',hardLimitBytes:10});
  ingress.bindInputCustody({observed(){},revoked(){throw Error('observer fault');}});
  const pending=ingress.incoming()[Symbol.asyncIterator]().next();
  assert.throws(()=>ingress.close({kind:'closed-by-host'}),/observer fault/);
  assert.equal((await pending).done,true);
});
test('custody reservation failure terminates reliable input instead of dropping and continuing',async()=>{
  const ingress=new BoundedIngress({clock:new VirtualClock(),channelId:'in',hardLimitBytes:10});
  let revoked=false;
  ingress.bindInputCustody({observed(){throw Error('custody full');},revoked(){revoked=true;}});
  const pending=ingress.incoming()[Symbol.asyncIterator]().next();
  const rejected=assert.rejects(pending,e=>e.termination?.error?.code==='input.retirement.accounting-failed');
  assert.throws(()=>ingress.push(Uint8Array.of(1)),/custody full/);
  await rejected;assert.equal(revoked,true);assert.equal(ingress.metrics.acceptedBytes,0);
  assert.equal(ingress.push(Uint8Array.of(2)).kind,'terminated');
});
test('failed installation revokes its partial index without consuming queued bytes',()=>{
  const f=fixture(),ingress=new BoundedIngress({clock:new VirtualClock(),channelId:'in',hardLimitBytes:10});
  ingress.push(Uint8Array.of(1));ingress.push(Uint8Array.of(2));
  assert.throws(()=>ingress.bindInputCustody({observed(s,n){if(s===2)throw Error('inventory full');f.index.register(s,n);},revoked(){f.index.close();}}),/inventory full/);
  assert.equal(f.index.closed,true);assert.equal(f.resident,0);assert.equal(ingress.metrics.retainedBytes,2);
});
test('lease release invalidates its cut even if the caller retains the binding object',async()=>{
  const f=fixture(),connection=new MockTransport(new VirtualClock()).openConnection({channelIds:['main']});
  const lease=await connection.channel('main').acquire('protocol');
  const binding=lease.bindInputCustody({observed:(s,n)=>f.index.register(s,n),revoked:()=>f.index.close()});
  await lease.release();assert.equal(f.index.closed,true);binding.dispose();
  assert.throws(()=>f.index.retired(1,2,f.iteration),/revoked/);
  await connection.close();
});
test('raw-prefix inventory moves once and never rebuilds on unrelated append or short consumption',()=>{
  const f=fixture(),raw=new InputCustodyRanges(f.index),receiver=new InputCustodyRanges(f.index);
  f.index.register(1,3);raw.append(1,3);
  for(let s=2;s<=4096;s++){
    f.index.register(s,3);
    const before=f.work;raw.append(s,3);
    assert.equal(f.work-before,1,'append visited the accumulated inventory');
  }
  const before=f.work;receiver.moveFrom(raw);
  assert.equal(f.work-before,1,'handoff traversed all original ranges');
  assert.equal(raw.bytes,0);assert.equal(receiver.bytes,12288);
  const prefix=receiver.take(4);
  assert.equal(prefix.lastSequence,2);assert.equal(receiver.bytes,12284);
  assert.equal(f.index.retired(1,2,f.iteration),false);
  prefix.dispose();assert.equal(f.index.retired(1,2,f.iteration),true);
  assert.equal(f.index.retired(2,3,f.iteration),false,'consumption erased the retained tail');
  receiver.dispose();assert.equal(f.index.size,0);assert.equal(f.resident,0);
});
test('failed prefix split restores the earlier moved ranges for ordinary revocation cleanup',()=>{
  let resident=0,refuse=false;
  const index=new InputRetirementIndex(()=>({iteration(){},close(){},reserve:n=>{
    if(refuse)throw Error('split reservation refused');
    resident+=n;let live=true;return{dispose(){if(live){live=false;resident-=n;}}};
  }}));
  const raw=new InputCustodyRanges(index);
  index.register(1,2);raw.append(1,2);index.register(2,2);raw.append(2,2);
  refuse=true;assert.throws(()=>raw.take(3),/split reservation refused/);
  assert.equal(raw.bytes,4);raw.dispose();assert.equal(index.size,0);assert.equal(resident,0);
});
test('predecessor account closes once and no disposed reservation can charge a finalized account',()=>{
  const pool=new ProtocolCustodyAccounts(8),account=pool.open();
  const a=account.reserve(64),b=account.reserve(32);
  account.iteration();a.dispose();account.retire();account.close();
  const work=pool.work;b.dispose();account.close();
  assert.equal(pool.closed,1);assert.equal(pool.work,work);
  assert.throws(()=>account.iteration(),/work-exhausted/);
  assert.throws(()=>account.reserve(1),/account-closed/);
});
