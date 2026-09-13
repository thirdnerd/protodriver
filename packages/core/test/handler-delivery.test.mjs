import { subdivision } from "../../../test-support/refusal/cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { make, bounded } from './fixtures/handler-delivery-harness.mjs';
import { Worker } from 'node:worker_threads';
test('variable authored failure is reported intact without consuming fixed cleanup capacity', {timeout:8000}, async t => {
  const h=await make(t,{work:1000000,body:'pdrv.fail("controlled",{detail=string.rep("x",8192)})'});
  h.inject([1]);
  const ended=await h.wait(e=>e.kind==='connection-close');
  assert.equal(ended.error.code,'lua-vm.invocation.program-failure');
  assert.equal(ended.error.details.details.detail,'x'.repeat(8192));
  assert.deepEqual(h.writes(),[]);
  const capture=await h.capture();
  assert.equal(capture.footer.completeness,'complete');assert.equal(capture.footer.gapCount,0);
});
for (const size of [1,213,256,469,484,1281]) test(`D2 ${size} bytes: bounded binary writes, short tail, one native capture`,{timeout:8000},async t=>{
  const h=await make(t,{work:250000}),input=Array.from({length:size},(_,i)=>i%256);h.inject(input);
  await h.wait(e=>e.kind==="write"&&h.writes().flat().length===size);
  assert.deepEqual(h.writes().flat(),input);assert.deepEqual(h.writes().map(b=>b.length),Array.from({length:Math.ceil(size/256)},(_,i)=>Math.min(256,size-i*256)));
  const capture=await h.capture(),rx=capture.records.filter(r=>r.kind==="rx-delivered");
  assert.equal(rx.length,1);assert.deepEqual([...Buffer.from(rx[0].data,"base64")],input);
  assert.equal(capture.footer.gapCount,0);assert.equal(capture.footer.completeness,"complete");
});
test("D2 a logical message spans callbacks without a host parser",{timeout:8000},async t=>{
  const h=await make(t,{body:'received=received..args.input; if received:sub(-1)=="!" then io.request({kind="write",value=tostring(#received)}) end'});
  h.inject([...Buffer.from("x".repeat(483)+"!")]);await h.wait(e=>e.kind==="write");assert.deepEqual(h.writes(),[[...Buffer.from("484")]]);
});
test("D2 queued byte capacity refuses an overflowing range before delivery",{timeout:8000},async t=>{
  const h=await make(t,{capture:false,nativeGate:true});h.inject([1]);await h.wait(e=>e.kind==="write");
  for(let i=0;i<6;i++){
    h.inject(new Uint8Array(3*1024*1024));
    const observation=await h.wait(e=>e.kind==="connection-close"||(e.kind==="ingress"&&h.seen.filter(x=>x.kind==="ingress"&&x.length>1).length>i));
    if(observation.kind==="connection-close")break;
  }
  assert.equal((await h.client.getSnapshot()).fault?.code,"retained.mailbox-overflow");
  assert.equal(h.seen.filter(e=>e.kind==="ingress"&&e.length>1).length,5,"overflowing range reached the consumer queue");
  assert.equal(h.writes().length,1);h.gate.resolve();
});
test("D2 scheduled entry fill accepts a large native range",{timeout:8000},async t=>{
  const h=await make(t,{entry:true});await h.wait(e=>e.kind==="write"&&h.writes().flat().length===484);
  assert.deepEqual(h.writes().flat(),[...Buffer.from("x".repeat(484))]);
  const c=await h.capture();
  const rx=c.records.filter(r=>r.kind==="rx-delivered");assert.equal(rx.length,1);
});
test(subdivision.name,{timeout:8000},async t=>{
  // One subdivision unit cannot overwhelm all surrounding host work. Observe
  // actual account conservation at that boundary, independent of host totals,
  // AND exhaust a 200,000-turn body after the two legitimate subdivision turns.
  subdivision.begin();
  const worker=new Worker(new URL('./fixtures/d2-work.mjs',import.meta.url));
  t.after(()=>worker.terminate());
  const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);
    worker.once('exit',code=>reject(new Error('D2 worker exited before reporting: '+code)));});
  subdivision.check({ code: result.error?.code, writes: result.writes,
    resumed: result.turns.some(r=>r.effect==='reschedule'), debits: result.debits });
  assert.ok(result.debits.length >= 2);
  for (const debit of result.debits) {
    assert.ok(debit.original > 0, 'native observation/preparation spent no original work');
    assert.equal(debit.before, debit.original, 'dispatch lost or duplicated original input work');
  }

});
test("D2 ready peer precedes the second subrange",{timeout:8000},async t=>{
  const h=await make(t,{work:250000,concurrency:4,dispatchGate:true});h.inject(new Uint8Array(1281));await h.wait(e=>e.kind==="gated");
  const {operationId}=await h.client.startOperation({operation:"peer",arguments:{}});
  const peer=h.client.awaitOperation(operationId);h.gate.resolve();assert.equal((await peer).outcome,"completed");
  await h.wait(e=>e.kind==="write"&&h.writes().flat().length===1281);
  const starts=h.seen.filter(e=>e.kind==="start").map(e=>e.binding);
  assert.ok(starts.indexOf("peer")<starts.indexOf("input",1),JSON.stringify(starts));
});
test("D2 disconnect revokes a 484-byte tail before the first dispatch returns",{timeout:8000},async t=>{
  const h=await make(t,{dispatchGate:true,concurrency:4});h.inject(new Uint8Array(484));await h.wait(e=>e.kind==="gated");
  await bounded(h.client.disconnect(),"revocation does not await dispatch");h.gate.resolve();
  await h.wait(e=>e.kind==="retired");assert.equal(h.seen.filter(e=>e.kind==="start").length,1);assert.deepEqual(h.writes(),[]);
  await h.capture();
});
test("D2 revocation leaves a submitted native call pending and never submits the tail",{timeout:8000},async t=>{
  const h=await make(t,{nativeGate:true,concurrency:4});h.inject(new Uint8Array(484));await h.wait(e=>e.kind==="write");
  await bounded(h.client.disconnect(),"revocation does not await native call");assert.equal(h.writes().length,1);
  assert.equal(h.seen.some(e=>e.kind==="retired"),false,"native call's task retired while still pending");
  const c=await h.capture();assert.equal(c.records.filter(r=>r.kind==="tx-settled").length,0);
  h.gate.resolve();await h.wait(e=>e.kind==="retired");assert.equal(h.writes().length,1);
});
for(const kind of ["work","Lua"])for(const size of [256,484])test(`D2 ${kind} cumulative account, ${size} bytes`,{timeout:8000},async t=>{
  const h=await make(t,{work:100000,body:(kind==="work"
    ? 'for i=1,25 do io.request({kind="reschedule"}) end '
    : 'local n=0; for i=1,300000 do n=n+i end; assert(n==45000150000) ')
    +'io.request({kind="write",value=count==1 and "FIRST" or "FORBIDDEN"})'});
  h.inject(new Uint8Array(size));await h.wait(e=>e.kind==="write");
  if(size===484){await h.wait(e=>e.kind==="connection-close"||(e.kind==="write"&&Buffer.from(e.bytes).toString()==="FORBIDDEN"));}
  assert.deepEqual(h.writes(),[[...Buffer.from("FIRST")]],"sibling refinanced the native delivery");
});
test("D2 subdivision keeps taps lossy while the reliable consumer is blocked",{timeout:8000},async t=>{
  const h=await make(t,{nativeGate:true,peer:'local tap=io.request({kind="tap-open"}); io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})}); return io.request({kind="tap-poll",tap=tap})',
    body:'io.request({kind="message-send",mailbox="reply",value="ready"}); io.request({kind="write",value=pdrv.bytes(args.input)})'});
  // Opening and suspending the peer precedes native delivery; an idle snapshot
  // is not a VM readiness barrier, so observe its actual first turn here.
  const peer=h.peer();await h.wait(e=>e.kind==="start"&&e.binding==="peer");
  // The first turn creates the tap before returning its first effect. Await a
  // second ordinary peer to place a FIFO barrier after that accepted effect.
  const barrier=h.peer();await h.wait(e=>e.kind==="start"&&e.binding==="peer"&&h.seen.filter(x=>x.kind==="start"&&x.binding==="peer").length===2);
  h.inject(new Uint8Array(1281));
  const r=await peer;assert.equal(r.outcome,"completed",JSON.stringify(r));
  const observation=JSON.parse(r.result);assert.equal(observation.reliable,false);assert.equal(observation.dropped,4);
  assert.deepEqual(observation.records.map(r=>r.value.length),[256,1]);await h.wait(e=>e.kind==="write");assert.equal(h.writes().length,1,"tap must not wait for the reliable tail");
  await h.client.disconnect();await barrier;
});
