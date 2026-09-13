import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedMailbox } from '../src/retained-mailbox.ts';
import { CanonicalSizeAccounting } from '../src/limits.ts';
import { NativeScratch, StandaloneNativeData, withNativeScratch } from '../../lua-vm/src/native-account.ts';

const utf8 = value => new TextEncoder().encode(value).length;
const descriptor = (sequence, length, offset=0) => ({sequence,recordedSequence:sequence+1,offset,length});
// Independent full traversal, not the incremental implementation under test.
class WholeMapOracle extends Map {
  reservedBytes=8;
  get reservedItems(){return this.size;}
  reserve(key,value) {
    this.set(key,value);const sizes=new CanonicalSizeAccounting();let bytes=8;
    for(const [key,value] of this) bytes+=sizes.rpcMessageBytes(key)+sizes.rpcMessageBytes(value)+32+
      (Array.isArray(value)?value.length*64:value instanceof Map?value.size*64:64);
    this.reservedBytes=bytes;return true;
  }
}

test('incremental ingress capacity matches the whole-map oracle through binary append, shrink and replacement', () => {
  const actual=new RetainedMailbox(), oracle=new WholeMapOracle();
  const history=Array.from({length:64},(_,i)=>({id:'effect-'+i,kind:'write',outcome:'settled',bytes:i}));
  for(const mailbox of [actual,oracle])assert.equal(mailbox.reserve('history',history,0),true);
  let value='',ranges=[];
  for(let turn=0;turn<240;turn++) {
    const added=String.fromCharCode(turn%256,255-turn%256);
    value+=added;ranges.push(descriptor(turn,2));
    assert.equal(actual.reserveInput(value,ranges,utf8(value),127),true);
    assert.equal(oracle.reserve('input-ranges',ranges,127),true);
    assert.equal(oracle.reserve('input',value,127),true);
    assert.equal(actual.reservedBytes,oracle.reservedBytes);
    assert.equal(actual.reservedItems,oracle.reservedItems);
    if(turn%7===6) {
      value=value.slice(1);ranges[0].offset++;ranges[0].length--;
      if(!ranges[0].length)ranges.shift();
      actual.set('input',value);oracle.set('input',value);
    }
    if(turn%31===30)for(const mailbox of [actual,oracle])assert.equal(mailbox.reserve('ordinary',{turn},0),true);
  }
});

test('ingress capacity refusal publishes neither replacement and includes existing raw/fill reservations', () => {
  const mailbox=new RetainedMailbox(), oldRanges=[descriptor(1,1)];
  assert.equal(mailbox.reserveInput('a',oldRanges,1,0),true);
  const old=mailbox.reservedBytes, held=16*1024*1024-old-128;
  assert.equal(mailbox.retainRaw(held,0),true);
  // The provenance replacement alone fits. The extra input byte does not:
  // publishing the first half before checking the second must be observable.
  assert.equal(mailbox.reserveInput('ab',[descriptor(2,2)],2,0),false);
  assert.equal(mailbox.get('input'),'a');assert.equal(mailbox.get('input-ranges'),oldRanges);
  assert.equal(mailbox.reservedBytes,16*1024*1024);
  mailbox.releaseRaw(held);
  assert.equal(mailbox.reserveInput('ab',[...oldRanges,descriptor(2,1)],2,16*1024*1024-old),false);
  assert.equal(mailbox.reservedBytes,old);
  assert.equal(mailbox.reserveInput('ab',[...oldRanges,descriptor(2,1)],2,0),true);
});

test('cached capacity still covers settled mutable effect records without revisiting them', () => {
  const mailbox=new RetainedMailbox(), oracle=new RetainedMailbox();
  const history=Array.from({length:64},(_,i)=>({id:'effect-'+i,kind:'write',outcome:'not-submitted'}));
  assert.equal(mailbox.reserve('history',history,0),true);
  for(const effect of history){effect.outcome='accepted-by-platform';effect.bytes=256;}
  assert.equal(mailbox.reserveInput('a',[descriptor(1,1)],1,0),true);
  // Remove only the already-held mutable-slot headroom from the refreshed
  // oracle. The cached reservation must cover actual growth plus its index.
  assert.equal(oracle.reserve('history',history,0),true);
  assert.equal(oracle.reserveInput('a',[descriptor(1,1)],1,0),true);
  assert.ok(mailbox.reservedBytes>=oracle.reservedBytes-64*history.length);
});

test('two input entries share the existing item ceiling, including raw ranges', () => {
  const mailbox=new RetainedMailbox();
  for(let i=0;i<1023;i++)assert.equal(mailbox.retainRaw(0,0),true);
  assert.equal(mailbox.reserveInput('a',[descriptor(1,1)],1,0),false);
  assert.equal(mailbox.has('input'),false);assert.equal(mailbox.has('input-ranges'),false);
  mailbox.releaseRaw(0);
  assert.equal(mailbox.reserveInput('a',[descriptor(1,1)],1,0),true);
  assert.equal(mailbox.reservedItems,1024);
});

test('400 ingress updates retain a 64-effect history within one cumulative linear work account', () => {
  const mailbox=new RetainedMailbox(), data=new StandaloneNativeData();let work=0;
  const history=Array.from({length:64},(_,i)=>({id:'effect-'+i,kind:'write',outcome:'settled',bytes:i}));
  assert.equal(mailbox.reserve('history',history,0),true);
  const ranges=[];
  for(let i=0;i<400;i++) {
    ranges.push(descriptor(i,1));
    const scope=new NativeScratch(data,units=>{work+=units;assert.ok(work<=1600,'unchanged mailbox/history must not be traversed per arrival');});
    try {withNativeScratch(scope,()=>assert.equal(mailbox.reserveInput('a'.repeat(i+1),ranges,i+1,0),true));}
    finally{scope.close();}
  }
  assert.equal(mailbox.get('input').length,400);assert.equal(mailbox.get('history'),history);
  assert.ok(work>0,'metadata updates still spend the owning account');
});

test('an exhausted ingress work account refuses before changing either entry', () => {
  const mailbox=new RetainedMailbox();assert.equal(mailbox.reserveInput('a',[descriptor(1,1)],1,0),true);
  const before=mailbox.reservedBytes;
  const scope=new NativeScratch(new StandaloneNativeData(),()=>{throw new Error('work refused');});
  try {assert.throws(()=>withNativeScratch(scope,()=>mailbox.reserveInput('ab',[descriptor(1,2)],2,0)),/work refused/);}
  finally{scope.close();}
  assert.equal(mailbox.get('input'),'a');assert.equal(mailbox.reservedBytes,before);
});
