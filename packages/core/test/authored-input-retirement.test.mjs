import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeScratch,withNativeScratch} from '@protodriver/lua-vm/retained';
import {AuthoredInputRetirementService} from '../src/authored-input-retirement.ts';
import {InputRetirementIndex} from '../src/input-retirement.ts';
import {NativeHelperData} from '../src/native-helper.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {BoundedIngress} from '../src/ingress.ts';

// Service controls, not the still-owed product-path B9 acceptance population.
function fixture(record) {
  const clock=new VirtualClock(), data=new NativeHelperData();
  const index=new InputRetirementIndex(()=>({iteration(){},reserve:n=>{
    const held=data.reserve(n);return{dispose:()=>held.release()};},close(){}}));
  let current=Object.freeze({index,clock,basisId:'test-basis',generation:1}),work=0,limit=Infinity;
  const records=[];
  const service=new AuthoredInputRetirementService(clock,()=>current,observation=>{
    records.push(structuredClone(observation));return record?.(observation);
  });
  const scoped=run=>{
    const scratch=new NativeScratch(data,units=>{if(work+units>limit)throw Error('caller work exhausted');work+=units;});
    try{return withNativeScratch(scratch,run);}finally{scratch.close();}
  };
  const sample=(fields={})=>scoped(()=>service.sample({kind:'input-retirement',basisId:'test-basis',generation:1,fromSequence:1,beforeSequence:2,...fields}));
  clock.nextSequence();
  return{clock,index,service,records,scoped,sample,get work(){return work;},set limit(n){limit=n;},
    get current(){return current;},set current(value){current=value;}};
}
const code=expected=>cause=>cause.error?.code===expected;

for(const [label,fields,diagnostic] of [
  ['wrong basis',{basisId:'other'},'basis'],['wrong generation',{generation:2},'generation'],
  ['future',{beforeSequence:3},'future'],['zero',{fromSequence:0},'invalid'],
  ['reversed',{fromSequence:3,beforeSequence:2},'invalid'],['empty',{fromSequence:2},'invalid'],
  ['fraction',{fromSequence:1.5},'invalid'],['unsafe',{beforeSequence:2**53},'invalid'],
  ['string endpoint',{beforeSequence:'2'},'invalid'],
])test('B9 service refuses '+label+' without recording a verdict',()=>{
  const f=fixture();assert.throws(()=>f.sample(fields),code('retained.input-retirement-'+diagnostic));
  assert.equal(f.records.length,0);
});

test('B9 service refuses uninstalled, wrong-clock and revoked cuts; an old generation cannot borrow a new cut',()=>{
  const f=fixture(),old=f.current;
  f.current=undefined;assert.throws(()=>f.sample(),code('retained.input-retirement-unavailable'));
  f.current={...old,clock:new VirtualClock()};assert.throws(()=>f.sample(),code('retained.input-retirement-unavailable'));
  f.current={...old,generation:2};assert.throws(()=>f.sample(),code('retained.input-retirement-generation'));
  assert.equal(f.sample({generation:2}).retired,true);
  f.index.close();assert.throws(()=>f.sample({generation:2}),code('retained.input-retirement-unavailable'));
});

test('B9 service traversal spends the caller account and never mints a per-query grant',()=>{
  const f=fixture(),empty=fixture();for(let s=1;s<=4096;s++)f.index.register(s,1);
  for(let s=1;s<=4096;s++){f.clock.nextSequence();empty.clock.nextSequence();}
  const request={fromSequence:4095,beforeSequence:4096};
  empty.sample(request);const entryOnly=empty.work;
  assert.equal(f.sample(request).retired,false);
  // Independently measure the empty index, not the filled query under test:
  // calibrating from the mutant's own total would hide its omitted traversal.
  f.limit=f.work+entryOnly+2;
  assert.throws(()=>f.sample({fromSequence:4095,beforeSequence:4096}),/caller work exhausted/);
  assert.equal(f.records.length,1);f.index.close();
});

test('B9 service does not replace interval existence with a global low watermark',()=>{
  const f=fixture();f.index.register(1,1);f.clock.nextSequence();
  assert.equal(f.sample({fromSequence:2,beforeSequence:3}).retired,true);
  f.index.register(2,1);
  assert.equal(f.sample({fromSequence:2,beforeSequence:3}).retired,false);
  f.index.consume(2,1);
  assert.equal(f.sample({fromSequence:2,beforeSequence:3}).retired,true);
  assert.equal(f.index.has(1),true);f.index.close();
});
