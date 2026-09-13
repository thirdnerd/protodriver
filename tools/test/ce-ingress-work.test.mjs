import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedMailbox } from '../../packages/core/src/retained-mailbox.ts';
import { NativeScratch, StandaloneNativeData, withNativeScratch } from '../../packages/lua-vm/src/native-account.ts';

const descriptor = sequence => ({sequence,recordedSequence:sequence+1,offset:0,length:1});
function reserveInputWork(mailbox,value,ranges,data) {
  let work=0;const scope=new NativeScratch(data,units=>{work+=units;});
  try {withNativeScratch(scope,()=>assert.equal(mailbox.reserveInput(value,ranges,value.length,0),true));}
  finally {scope.close();}
  return work;
}

test('ingress capacity work per delivery does not grow with prior delivery or unrelated mailbox history',()=>{
  const data=new StandaloneNativeData(),empty=new RetainedMailbox(),withHistory=new RetainedMailbox();
  const history=Array.from({length:64},(_,i)=>({id:'effect-'+i,kind:'write',outcome:'settled',bytes:i}));
  assert.equal(withHistory.reserve('history',history,0),true);
  const first=[descriptor(0)];
  const expected=reserveInputWork(empty,'a',first,data);
  assert.ok(expected>0,'capacity-index publication must still perform measured work');
  assert.equal(reserveInputWork(withHistory,'a',first,data),expected,
    'ingress capacity work must not traverse unrelated mailbox history');
  const ranges=[...first];
  for(let i=1;i<400;i++) {
    ranges.push(descriptor(i));
    const work=reserveInputWork(withHistory,'a'.repeat(i+1),ranges,data);
    assert.equal(work,expected,
      `ingress capacity work must not grow with prior delivery history at delivery ${i+1}`);
  }
});
