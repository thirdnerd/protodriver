import assert from 'node:assert/strict';
import nodeTest from 'node:test';
import {AuthoredTransfer,inspectAuthoredCheckpoint} from '../src/authored-transfer.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';
import {createHash} from 'node:crypto';
const source=Uint8Array.of(0,128,255,65), sha=b=>createHash('sha256').update(b).digest('hex');
const test=(name,run)=>nodeTest(name,{timeout:3000},run);
const operation={id:'write',transfer:{sourceArgument:'image',targetOffset:64,targetLength:128,resumeBinding:'resume',finalization:'repeatable'}};
const identity={execution:'a'.repeat(64),mode:'application',device:'board-A',policy:'b'.repeat(64)};
const values=(bytes=source)=>({image:{type:'bytes',encoding:'base64',value:Buffer.from(bytes).toString('base64')},length:4});
function context(){let live=true,bytes=0,work=0,sequence=0;const observations=[];return {
  live(){assert.ok(live,'revoked');},charge(n){work+=n;assert.ok(work<1000000,'finite service account');},
  reserve(n){bytes+=n;assert.ok(bytes<1000000);let released=false;return {release(){assert.equal(released,false);released=true;bytes-=n;}};},
  native:run=>run(),takeEvidence:()=>({sequence:++sequence,bytes:4}),async call(kind,run){observations.push(kind);return run();},progress(cp){observations.push(structuredClone(cp));},
  revoke(){live=false;},get bytes(){return bytes;},get work(){return work;},observations};}
async function begin(store=new InMemoryTransferCheckpointStore(),c=context()){
  const s=await AuthoredTransfer.prepare(store,operation,values(),identity,c),fields=(await s.open()).split('|');
  assert.equal(fields[1],sha(source),'source identity comes from host-read bytes');
  await s.report('00ff',7,0,0,0);return {s,store,c,id:fields[0]};
}
const code=expected=>error=>error.error?.code===expected;
test('B5 bounded input hashes only its selected bytes and refuses subject substitution',async()=>{
  const op={...operation,transfer:{...operation.transfer,sourceRange:{offset:1,length:{argument:'length'}}}};
  const v={...values(),length:2},store=new InMemoryTransferCheckpointStore(),s=await AuthoredTransfer.prepare(store,op,v,identity,context());
  const [id,digest]=(await s.open()).split('|');assert.equal(digest,sha(source.slice(1,3)));
  await s.report('00ff',7,0,0,0);await s.admit(0,0,source.slice(1,3),2);await s.report('00ff',7,1,2,1);await s.release();
  const cp=await store.read(id);assert.deepEqual(cp.source.subject,{kind:'effective-range',offset:1,length:2});
  for(const subject of [undefined,null,{kind:'file',offset:1,length:2},{kind:'effective-range',offset:1,length:3}]){
    const changed=structuredClone(cp);if(subject===undefined)delete changed.source.subject;else changed.source.subject=subject;
    assert.throws(()=>inspectAuthoredCheckpoint(changed,identity,op),e=>['transfer.checkpoint-invalid','transfer.resume.source-mismatch'].includes(e.error?.code));
  }
  // Keep bytes, argument identity and digest unchanged. Only falsify the
  // recorded subject, so another digest/definition refusal cannot mask this.
  const mislabeled=structuredClone(cp),otherStore=new InMemoryTransferCheckpointStore();
  mislabeled.source.subject.offset=0;await otherStore.create(mislabeled);
  await assert.rejects(AuthoredTransfer.prepare(otherStore,op,v,identity,context(),id),code('transfer.resume.source-mismatch'));
  const moved={...op,transfer:{...op.transfer,sourceRange:{offset:0,length:2}}};
  await assert.rejects(AuthoredTransfer.prepare(store,moved,v,identity,context(),id),code('transfer.resume.source-mismatch'));
  const changed={...v,image:values(Uint8Array.of(17,128,255,18,19)).image};
  const r=await AuthoredTransfer.prepare(store,op,changed,identity,context(),id);
  try{await r.open();await r.report('00ff',7,1,1,0);await r.admit(1,0,source.slice(2,3),1);await r.report('00ff',7,2,2,0);
    await r.finalize();await r.verify(digest,'e'.repeat(64));assert.deepEqual(r.receipt.source.subject,cp.source.subject);
  }finally{await r.release();}
});
test('accepted source bytes do not advance a durable checkpoint or permit finalization',async()=>{
  const {s,store,c,id}=await begin();
  await s.admit(0,1,Uint8Array.of(99,...source),4);
  assert.equal((await store.read(id)).authoredTransfer.admittedEnd,4);
  assert.deepEqual((await store.read(id)).confirmedRanges,[]);
  await assert.rejects(s.finalize(),code('transfer.resume.offset-mismatch'));
  await s.report('00ff',7,2,4,1);
  assert.deepEqual((await store.read(id)).confirmedRanges,[{targetOffset:64,length:2}]);
  await s.release();assert.equal(c.bytes,0);
});
test('carrier declaration is part of durable transfer definition identity',async()=>{
 const {s,store,id}=await begin();await s.release();
 const changed={...operation,transfer:{...operation.transfer,maximumCarrierBytes:792}};
 await assert.rejects(AuthoredTransfer.prepare(store,changed,values(),identity,context(),id),code('transfer.resume.definition-mismatch'));
 const claim=await store.claim(id,'after-refusal');assert.equal(claim.checkpoint.authoredTransfer.admittedEnd,0);await store.release(claim);
});
test('resume is claimed, source-bound, quiescent and rechunked at committed offset',async()=>{
  const {s,store,id}=await begin();await s.admit(0,0,source,4);await s.report('00ff',7,2,4,1);await s.release();
  const c=context(),r=await AuthoredTransfer.prepare(store,operation,values(),identity,c,id);
  assert.equal((await r.open()).split('|')[2],'2');
  await assert.rejects(r.admit(2,0,source.slice(2),2),code('transfer.resume.preparation-incomplete'));
  assert.equal(await r.report('00ff',7,2,4,1),'not-quiescent|2');
  await assert.rejects(r.admit(2,0,source.slice(2),2),code('transfer.resume.preparation-incomplete'));
  await r.report('00ff',7,2,2,0);
  await assert.rejects(r.admit(0,0,source,4),code('transfer.resume.offset-mismatch'));
  await r.admit(2,0,source.slice(2),2);await r.report('00ff',7,4,4,0);await r.finalize();
  await r.verify(sha(source),'c'.repeat(64));assert.equal(await store.read(id),null);
  assert.equal(r.receipt.source.authority,'host-computed-device-confirmed');
  assert.equal(r.receipt.target.authority,'device-reported');assert.equal(r.receipt.independentReadBack,false);
  await r.release();assert.equal(c.bytes,0);
});
test('resume-required committed prefix cannot exceed the admitted source horizon',async()=>{
  const {s,store,id}=await begin();const checkpoint=structuredClone(await store.read(id));await s.release();
  checkpoint.confirmedRanges=[{targetOffset:64,length:1}];
  assert.throws(()=>inspectAuthoredCheckpoint(checkpoint,identity,operation),error=>
    error.error?.code==='transfer.checkpoint-invalid'&&error.message==='invalid authored checkpoint fields');
});
test('resume-required remains unavailable after a verification receipt',async()=>{
  const {s}=await begin();await s.admit(0,0,source,4);await s.report('00ff',7,4,4,0);await s.finalize();
  await s.verify(sha(source),'c'.repeat(64));
  assert.equal(s.checkpoint,undefined,'verification receipt retained a live checkpoint claim');
  assert.throws(()=>s.resumeRequired(),error=>error.error?.code==='authored.transfer.resume-disposition-refused'
    && error.message==='resume-required is unavailable after a verification or retirement receipt');
  await s.release();
});
test('resume-required quiescence blocks DATA while volatile device work remains',async()=>{
  const {s,store,id}=await begin();await s.admit(0,0,source,4);await s.report('00ff',7,2,4,1);await s.release();
  const r=await AuthoredTransfer.prepare(store,operation,values(),identity,context(),id);await r.open();
  assert.equal(await r.report('00ff',7,2,4,1),'not-quiescent|2');
  await assert.rejects(r.admit(2,0,source.slice(2),2),error=>error.error?.code==='transfer.resume.preparation-incomplete'
    && error.message==='DATA requires a bound generation and quiescent resume report before finalization');
  assert.equal(r.checkpoint.authoredTransfer.admittedEnd,4,'non-quiescent resume admitted new DATA');
  await r.release();
});
test('wrong carrier bytes, invalid durable report, cookie and generation are refused',async()=>{
  const {s}=await begin();
  await assert.rejects(s.admit(0,0,Uint8Array.of(1,2,3,4),4),code('transfer.resume.source-mismatch'));
  await assert.rejects(s.report('00ff',7,1,1,0),code('transfer.resume.offset-mismatch'));
  await assert.rejects(s.report('ffff',7,0,0,0),code('transfer.resume.identity-mismatch'));
  await assert.rejects(s.report('00ff',8,0,0,0),code('transfer.resume.identity-mismatch'));
  await s.release();
});
test('a Lua offset without a host input basis is not durable evidence',async()=>{
  const {s,c}=await begin();c.takeEvidence=()=>undefined;
  await assert.rejects(s.report('00ff',7,0,0,0),code('authored.transfer.report-unobserved'));await s.release();
});
test('source digest mismatch cannot complete or delete a checkpoint',async()=>{
  const {s,store,id}=await begin();await s.admit(0,0,source,4);await s.report('00ff',7,4,4,0);await s.finalize();
  await assert.rejects(s.verify('d'.repeat(64),'e'.repeat(64)),code('transfer.verification.digest-mismatch'));
  assert.notEqual(await store.read(id),null);await s.release();
});
test('re-delivering an old mailbox basis does not create a second device report',async()=>{
  const {s,c}=await begin();c.takeEvidence=()=>({sequence:100,bytes:4});
  await s.report('00ff',7,0,0,0);
  await assert.rejects(s.report('00ff',7,0,0,0),code('authored.transfer.report-unobserved'));await s.release();
});
test('non-repeatable finalization cannot be undone by a progress report or resumed',async()=>{
  const store=new InMemoryTransferCheckpointStore(),op={...operation,transfer:{...operation.transfer,finalization:'not-repeatable'}};
  const s=await AuthoredTransfer.prepare(store,op,values(),identity,context());const id=(await s.open()).split('|')[0];
  await s.report('00ff',7,0,0,0);await s.admit(0,0,source,4);await s.report('00ff',7,4,4,0);await s.finalize();
  await assert.rejects(s.finalize(),code('transfer.resume.finalization-not-repeatable'));
  await assert.rejects(s.report('00ff',7,4,4,0),code('transfer.checkpoint-invalid'));await s.release();
  await assert.rejects(AuthoredTransfer.prepare(store,op,values(),identity,context(),id),code('transfer.resume.finalization-not-repeatable'));
});
test('changed source and ordinary arguments release the claim and run no carrier',async()=>{
  const {s,store,id}=await begin();await s.release();
  for(const [v,expected]of [[values(Uint8Array.of(1,2,3,4)),'transfer.resume.source-mismatch'],[{...values(),length:3},'transfer.resume.definition-mismatch']]){
    const c=context();await assert.rejects(AuthoredTransfer.prepare(store,operation,v,identity,c,id),code(expected));assert.equal(c.bytes,0);
    const claim=await store.claim(id,'next');await store.release(claim);
  }
});
test('old, changed execution, device, mode, policy and malformed prefix refuse inspection',async()=>{
  const {s,store,id}=await begin();const cp=await store.read(id);await s.release();
  for(const [change,expected]of [[{execution:'c'.repeat(64)},'manifest'],[{device:'board-B'},'identity'],[{mode:'other'},'mode'],[{policy:'e'.repeat(64)},'definition']])
    assert.throws(()=>inspectAuthoredCheckpoint(cp,{...identity,...change}),code('transfer.resume.'+expected+'-mismatch'));
  const old={...cp};delete old.authoredTransfer;
  assert.throws(()=>inspectAuthoredCheckpoint(old,identity),code('transfer.checkpoint-invalid'));
  assert.throws(()=>inspectAuthoredCheckpoint({...cp,confirmedRanges:[{targetOffset:64,length:1}]},identity),code('transfer.checkpoint-invalid'));
});
test('cancellation during a real store commit keeps its claim until settlement',async()=>{
  const {s,store,c,id}=await begin();const gate=Promise.withResolvers(),arrived=Promise.withResolvers(),commit=store.commit.bind(store);
  store.commit=async(...args)=>{arrived.resolve();await gate.promise;return commit(...args);};
  const pending=s.admit(0,0,source,4);await arrived.promise;c.revoke();
  await assert.rejects(store.claim(id,'competing'),error=>error.diagnostic?.code==='transfer.checkpoint-held');
  gate.resolve();await assert.rejects(pending,/revoked/);await s.release();
  const claim=await store.claim(id,'after-settlement');assert.equal(claim.checkpoint.authoredTransfer.admittedEnd,4);
  assert.deepEqual(claim.checkpoint.confirmedRanges,[]);await store.release(claim);assert.equal(c.bytes,0);
});
test('progress checkpoint stays one range rather than retaining every report',async()=>{
  const {s,store,id}=await begin();await s.admit(0,0,source,4);
  for(let committed=1;committed<=4;committed++){await s.report('00ff',7,committed,committed,0);assert.equal((await store.read(id)).confirmedRanges.length,1);}
  await assert.rejects(s.report('00ff',7,3,4,0),code('transfer.resume.offset-mismatch'));await s.release();
});
test('source hashing exhausts per-block work before native submission, not just at entry',async()=>{
  const c=context();let used=0;c.charge=n=>{used+=n;if(used>700)throw new Error('hash budget exhausted');};
  const op={...operation,transfer:{...operation.transfer,targetLength:1024}};
  await assert.rejects(AuthoredTransfer.prepare(new InMemoryTransferCheckpointStore(),op,values(new Uint8Array(512)),identity,c),/hash budget exhausted/);
  assert.equal(c.observations.includes('transfer-hash'),false,'over-budget hashing reached the platform');
  assert.equal(c.bytes,0);
});
