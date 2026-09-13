import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthoredTransfer} from '../src/authored-transfer.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
const op={id:'write',transfer:{sourceArgument:'image',targetOffset:64,targetLength:128,resumeBinding:'resume',finalization:'repeatable'}};
const identity={execution:'a'.repeat(64),mode:'m',device:'board',policy:'b'.repeat(64)};
const code=value=>e=>e.error?.code===value;
function account(){let live=true,n=0,work=0,held=0;return {
 live(){assert.ok(live,'revoked');},revoke(){live=false;},charge(v){work+=v;},native:fn=>fn(),
 reserve(v){held+=v;return {release(){held-=v;}};},takeEvidence:()=>({sequence:++n,bytes:1}),
 call:async(_kind,fn)=>fn(),progress(){},get work(){return work;},get held(){return held;},
 };}
async function begin(){
 const store=new InMemoryTransferCheckpointStore(),ordinary=account(),cleanup=account();
 cleanup.takeEvidence=()=>({sequence:100,bytes:1});
 const s=await AuthoredTransfer.prepare(store,op,{image:{value:'AID/QQ=='}},identity,ordinary),id=(await s.open()).split('|')[0];
 await s.report('00ff',7,0,0,0);await s.admit(0,0,Uint8Array.of(0,128,255,65),4);await s.report('00ff',7,2,4,1);
 return {store,ordinary,cleanup,s,id};
}
test('cleanup retirement uses its own work and input, removes only its claim, never verifies',{timeout:3000},async()=>{
 const {store,ordinary,cleanup,s,id}=await begin(),work=ordinary.work;ordinary.revoke();
 assert.match(s.cleanupState(),/^checkpoint\|.*\|2\|00ff\|7$/);
 assert.equal(await s.retire(cleanup,'00ff',7),'retired');assert.equal(await store.read(id),null);
 assert.equal(ordinary.work,work);assert.ok(cleanup.work>0);assert.equal(s.receipt,undefined);assert.equal(s.retirement.verified,false);
 assert.equal(s.cleanupState(),'retired');await s.release();assert.equal(ordinary.held,0);
});
for(const kind of ['missing-input','empty-input','old-input','cookie','generation'])test('retirement refuses '+kind+' without losing checkpoint',{timeout:3000},async()=>{
 const {store,cleanup,s,id}=await begin();if(kind==='missing-input')cleanup.takeEvidence=()=>undefined;
 if(kind==='empty-input')cleanup.takeEvidence=()=>({sequence:100,bytes:0});
 if(kind==='old-input')cleanup.takeEvidence=()=>({sequence:1,bytes:1});
 await assert.rejects(s.retire(cleanup,kind==='cookie'?'ffff':'00ff',kind==='generation'?8:7),code(kind.endsWith('input')?'authored.transfer.report-unobserved':'transfer.resume.identity-mismatch'));
 assert.equal((await store.read(id)).confirmedRanges[0].length,2);await s.release();const claim=await store.claim(id,'next');await store.release(claim);
});
test('pending ordinary commit blocks retirement; eventual release uses the settled revision',{timeout:3000},async t=>{
 const {store,ordinary,cleanup,s,id}=await begin(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),commit=store.commit.bind(store);
 t.after(()=>gate.resolve());store.commit=async(...args)=>{entered.resolve();await gate.promise;return commit(...args);};
 const pending=s.report('00ff',7,4,4,0);await entered.promise;ordinary.revoke();
 const rejected=assert.rejects(pending,/revoked/);void rejected.catch(()=>{});assert.equal(s.cleanupState(),'pending');
 await assert.rejects(s.retire(cleanup,'00ff',7),code('authored.transfer.cleanup-pending'));
 await assert.rejects(store.claim(id,'competitor'),e=>e.diagnostic?.code==='transfer.checkpoint-held');
 gate.resolve();await rejected;
 const before=await store.read(id),release=store.release.bind(store);let releasedRevision;
 store.release=async claim=>{releasedRevision=claim.checkpoint.revision;return release(claim);};
 await s.release();assert.equal(releasedRevision,before.revision);assert.equal(before.confirmedRanges[0].length,4);
});
test('late retirement retains claim through timeout/release and cannot resume cleanup',{timeout:3000},async t=>{
 const {store,cleanup,s,id,ordinary}=await begin(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),complete=store.complete.bind(store);
 t.after(()=>gate.resolve());let releases=0;const release=store.release.bind(store);store.release=async c=>{releases++;return release(c);};
 store.complete=async c=>{entered.resolve();await gate.promise;return complete(c);};
 const retiring=s.retire(cleanup,'00ff',7);await entered.promise;cleanup.revoke();const failed=assert.rejects(retiring,/revoked/);void failed.catch(()=>{});
 const ending=s.release();assert.equal(releases,0);assert.ok(ordinary.held>0);
 await assert.rejects(store.claim(id,'competitor'),e=>e.diagnostic?.code==='transfer.checkpoint-held');
 assert.equal((await store.read(id)).confirmedRanges[0].length,2);
 gate.resolve();await failed;await ending;assert.equal(await store.read(id),null);assert.equal(releases,0);assert.equal(ordinary.held,0);
 assert.equal(s.retirement.verified,false);assert.equal(s.receipt,undefined);
});
test('failed store retirement leaves the claim releasable, not called verified',{timeout:3000},async()=>{
 const {store,cleanup,s,id}=await begin();store.complete=async()=>{throw new Error('disk unavailable');};
 await assert.rejects(s.retire(cleanup,'00ff',7),/disk unavailable/);assert.equal(s.retirement,undefined);assert.equal(s.receipt,undefined);
 await s.release();const claim=await store.claim(id,'after');assert.equal(claim.checkpoint.confirmedRanges[0].length,2);await store.release(claim);
});
test('unfunded cleanup cannot submit checkpoint removal',{timeout:3000},async()=>{
 const {store,cleanup,s,id}=await begin();cleanup.charge=()=>{throw new Error('cleanup work exhausted');};
 await assert.rejects(s.retire(cleanup,'00ff',7),/cleanup work exhausted/);
 assert.equal((await store.read(id)).confirmedRanges[0].length,2);assert.equal(s.retirement,undefined);await s.release();
});
test('successful deletion survives a failure recording its completion',{timeout:3000},async()=>{
 const {store,cleanup,s,id}=await begin();
 cleanup.call=async(_kind,run)=>{await run();throw new Error('completion recording failed');};
 await assert.rejects(s.retire(cleanup,'00ff',7),/completion recording failed/);
 assert.equal(await store.read(id),null);assert.equal(s.checkpoint,undefined);
 assert.equal(s.retirement.verified,false);assert.equal(s.receipt,undefined);
 let released=false;store.release=async()=>{released=true;throw new Error('removed claim released');};
 await s.release();assert.equal(released,false);
});
