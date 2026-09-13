import test from 'node:test';
import assert from 'node:assert/strict';
import {InputWorkAccount,InputWorkRanges} from '../src/input-work.ts';
import {InputRetirementIndex} from '../src/input-retirement.ts';
import {CanonicalSizeAccounting} from '../src/limits.ts';
import {NativeHelperData} from '../src/native-helper.ts';
import {make} from './fixtures/handler-delivery-harness.mjs';

test('actual raw discard does not release a pending native promise from the interval or its account',()=>{
 const data=new NativeHelperData(),source=new InputWorkAccount(data,10000,3,true);
 const index=new InputRetirementIndex(()=>source.custodyAccount());
 source.nativeBegin(3);index.register(10,3);source.attachCustody(index,10);
 source.revoke();source.close();
 assert.equal(index.retired(10,11,()=>{}),false);assert.equal(source.closed,false);
 source.nativeEnd();assert.equal(index.retired(10,11,()=>{}),true);assert.equal(source.closed,true);
 const metadata=new CanonicalSizeAccounting().rpcMessageBytes({id:0,capacity:0,usedLength:0});
 const all=data.reserve(data.maximum-16-metadata);all.release();index.close();
});
for(const method of ['publication','deferred'])test('failed '+method+' index reservation returns the entire native capacity',()=>{
 const data=new NativeHelperData(),source=new InputWorkAccount(data,10000,3,true);
 const index=new InputRetirementIndex(()=>source.custodyAccount());
 source.nativeBegin(3);index.register(10,3);source.attachCustody(index,10);
 const reserve=data.reserve.bind(data);let refuse=true;
 data.reserve=(n,...args)=>{if(refuse&&n===64)throw Error('controlled dependency reservation failure');return reserve(n,...args);};
 assert.throws(()=>source[method](100),/controlled dependency/);refuse=false;
 source.revoke();source.nativeEnd();source.close();assert.equal(source.closed,true);
 const metadata=new CanonicalSizeAccounting().rpcMessageBytes({id:0,capacity:0,usedLength:0});
 const all=data.reserve(data.maximum-16-metadata);all.release();index.close();
});

test('input work moves one counter, with no fresh allowance at binding or after finalization',()=>{
 const source=new InputWorkAccount(new NativeHelperData(),100,10,false);
 source.charge(20);const owner={work:0};source.bind(owner);
 assert.equal(owner.work,23);owner.work+=5;assert.equal(source.work,28);
 assert.throws(()=>source.charge(69),/original input account exhausted/);
 assert.throws(()=>source.bind({work:0}),/rebound/);
 source.close();const final=source.work;source.close();
 assert.equal(source.work,final);assert.throws(()=>{owner.work++;},/finalized/);
 assert.throws(()=>source.charge(1),/exhausted/);
});
test('input prefix inventory visits only appended/consumed nodes and prepays their disposal',()=>{
 const source=new InputWorkAccount(new NativeHelperData(),100000,4096,true),ranges=new InputWorkRanges(0);
 const before=source.work;for(let i=0;i<4096;i++)ranges.append(source,1);
 assert.equal(source.work-before,4096);
 ranges.consume(4095);assert.equal(source.remaining,1);
 assert.throws(()=>source.close(),/unconsumed raw prefix/);
 ranges.consume(1);assert.equal(source.remaining,0);source.close();
 const final=source.work;ranges.close();assert.equal(source.work,final);
});
test('legacy entry bytes remain a gap, not consumption of a later funded observation',()=>{
 const source=new InputWorkAccount(new NativeHelperData(),1000,2,true),ranges=new InputWorkRanges(3);
 ranges.append(source,2);ranges.consume(3);assert.equal(source.remaining,2);
 ranges.consume(1);assert.equal(source.remaining,1);ranges.close();source.close();
});
test('native publication refuses an input account that cannot fund its terminal obligation',{timeout:8000},async t=>{
 const h=await make(t,{work:5,capture:false,consumedRanges:true});
 assert.throws(()=>h.inject([1]),/cannot be funded before publication/);
 assert.equal(h.metrics().acceptedBytes,0,'unfunded bytes reached native publication');
 await h.wait(e=>e.kind==='connection-close');
 assert.equal(h.seen.filter(e=>e.kind==='start'&&e.binding==='input').length,0);
});
test('returned handler retains its original input account until a later handler consumes the raw prefix',{timeout:8000},async t=>{
 const h=await make(t,{consumedRanges:true,body:'received=received..args.input;if #received==2 then io.request({kind="input-consume",length=2}) end'});
 h.inject([65]);const first=await h.wait(e=>e.kind==='start'&&e.binding==='input');
 const retired=await h.wait(e=>e.kind==='retired'&&e.id===first.id);
 assert.equal(retired.keep,true,'handler return finalized the account behind its raw prefix');
 h.inject([66]);
 await h.wait(e=>e.kind==='retired'&&e.id===first.id&&!e.keep);
 const cap=await h.capture();assert.equal(cap.footer.completeness,'complete');
});
test('disconnect releases a parked prefix account without waiting for another native byte',{timeout:8000},async t=>{
 const h=await make(t,{consumedRanges:true,body:'received=received..args.input'});
 h.inject([65]);const first=await h.wait(e=>e.kind==='start'&&e.binding==='input');
 assert.equal((await h.wait(e=>e.kind==='retired'&&e.id===first.id)).keep,true);
 await h.client.disconnect();await h.wait(e=>e.kind==='retired'&&e.id===first.id&&!e.keep);
});
test('ingress failure cancels a suspended handler before disposing its delivered prefix',{timeout:8000},async t=>{
 const h=await make(t,{consumedRanges:true,body:'io.request({kind="message-wait",mailboxes=pdrv.array({"reply"}),timers=pdrv.array({})})'});
 h.inject([65]);
 await h.wait(e=>e.kind==='turn'&&e.effect==='message-wait');
 h.failInput();
 await h.wait(e=>e.kind==='connection-close');
 await h.wait(e=>e.kind==='retired');
 assert.deepEqual(h.writes(),[]);
});
