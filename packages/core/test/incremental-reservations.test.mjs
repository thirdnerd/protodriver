import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedMailbox } from '../src/retained-mailbox.ts';
import { CanonicalSizeAccounting } from '../src/limits.ts';
import { NativeScratch, StandaloneNativeData, withNativeScratch } from '../../lua-vm/src/native-account.ts';

function measured(fn) {
  let work=0;
  const scope=new NativeScratch(new StandaloneNativeData(),n=>{work+=n;});
  try { withNativeScratch(scope,fn); return work; } finally { scope.close(); }
}
const sizes=new CanonicalSizeAccounting();
function canonicalCapacity(mailbox) {
  let bytes=8;
  for(const [key,value] of mailbox) bytes+=sizes.rpcMessageBytes(key)+sizes.rpcMessageBytes(value)+32+
    (Array.isArray(value)?value.length*64:value instanceof Map?value.size*64:64);
  return bytes;
}

test('ordinary replacements match independent canonical capacity without refreshing unrelated headroom',()=>{
  const mailbox=new RetainedMailbox();
  for(const [key,value] of [['a',{text:'éÿ',values:[1,false,null]}],['b',new Map([['x',42]])],['a','smaller'],['c',new Uint8Array([0,255])]]) {
    assert.equal(mailbox.reserve(key,value,0),true);
    assert.equal(mailbox.reservedBytes,canonicalCapacity(mailbox));
  }
  const before=mailbox.reservedBytes;
  mailbox.set('c',new Uint8Array());
  assert.equal(mailbox.reserve('a','smaller',0),true);
  assert.equal(mailbox.reservedBytes,before,'unrelated shrink retains already reserved capacity');
  mailbox.delete('c'); assert.equal(mailbox.reservedBytes,canonicalCapacity(mailbox));
});

test('effect-window reservation work converges: unchanged history cannot add per-window work',()=>{
  const mailbox=new RetainedMailbox(),history=new Map(),live=new Map(),windows=[];
  assert.equal(mailbox.reserve('owner',history,0),true);
  // Equal-width IDs isolate history length from actual new-value encoding.
  for(let window=0;window<5;window++) windows.push(measured(()=>{
    for(let i=0;i<4;i++) {
      const effect={id:'effect-'+String(window*4+i).padStart(3,'0'),kind:'write',outcome:'not-submitted'};
      assert.equal(mailbox.reserveEffect('owner',history,live,effect,undefined,0),true);
      for(const value of ['resume|owner|bytes',{kind:'receive',maximumBytes:6}])
        assert.equal(mailbox.reserve('turn:owner',value,0),true);
      mailbox.delete('turn:owner');
      effect.outcome='accepted-by-platform';effect.bytes=6;
      live.delete(effect.id);mailbox.releaseEffect(effect);
    }
  }));
  assert.ok(Math.max(...windows.slice(1))-Math.min(...windows.slice(1))<=2,
    'effect-window convergence: retained history must not amplify reservations: '+windows);
  assert.equal(history.size,20);assert.equal(live.size,0);
  assert.ok(mailbox.reservedBytes>=sizes.rpcMessageBytes(mailbox));
});

test('effect append checks both containers before eviction or publication, including raw and fill capacity',()=>{
  const mailbox=new RetainedMailbox(),history=new Map(),live=new Map();
  const old={id:'old',kind:'write',outcome:'not-submitted'};
  assert.equal(mailbox.reserveEffect('owner',history,live,old,undefined,0),true);
  live.delete(old.id);mailbox.releaseEffect(old);
  const bytes=mailbox.reservedBytes, raw=16*1024*1024-bytes-128;
  assert.equal(mailbox.retainRaw(raw,0),true);
  const next={id:'new',kind:'write',outcome:'not-submitted'};
  assert.equal(mailbox.reserveEffect('owner',history,live,next,old.id,0),false);
  assert.deepEqual([...history.values()],[old]);assert.equal(live.size,0);assert.equal(mailbox.reservedBytes,16*1024*1024);
  mailbox.releaseRaw(raw);
  assert.equal(mailbox.reserveEffect('owner',history,live,next,old.id,16*1024*1024-bytes),false);
  assert.deepEqual([...history.values()],[old]);assert.equal(live.size,0);assert.equal(mailbox.reservedBytes,bytes);
  assert.equal(mailbox.reserveEffect('owner',history,live,next,old.id,0),true);
  assert.deepEqual([...history.values()],[next]);assert.equal(live.get(next.id),next);
});

test('retired-effect eviction does constant work and preserves chronological history',t=>{
  const costs=[];
  for(const count of [8,32,64]) {
    const mailbox=new RetainedMailbox(),history=new Map(),live=new Map();
    for(let i=0;i<count;i++) {
      const effect={id:'effect-'+String(i).padStart(3,'0'),kind:'write',outcome:'not-submitted'};
      assert.equal(mailbox.reserveEffect('owner',history,live,effect,undefined,0),true);
      live.delete(effect.id);mailbox.releaseEffect(effect);
    }
    const next={id:'effect-999',kind:'write',outcome:'not-submitted'};
    const expected=[...history.values()].slice(1).concat(next);
    costs.push(measured(()=>assert.equal(mailbox.reserveEffect('owner',history,live,next,'effect-000',0),true)));
    assert.deepEqual([...history.values()],expected,'eviction keeps surviving records in chronological order');
    assert.equal(history.size,count);assert.deepEqual([...live.values()],[next]);
    assert.ok(mailbox.reservedBytes>=sizes.rpcMessageBytes(mailbox));
  }
  assert.deepEqual(costs,[costs[0],costs[0],costs[0]],'eviction must not compact or rewalk surviving history slots');
  t.diagnostic('eviction W at 8/32/64 records: '+costs.join('/'));
});

test('ordinary and effect reservations refuse exhausted work before publishing',()=>{
  const mailbox=new RetainedMailbox(),history=new Map(),live=new Map();
  assert.equal(mailbox.reserve('turn','old',0),true);const bytes=mailbox.reservedBytes;
  const scope=new NativeScratch(new StandaloneNativeData(),()=>{throw new Error('work refused');});
  try {withNativeScratch(scope,()=>{
    assert.throws(()=>mailbox.reserve('turn','new',0),/work refused/);
    assert.throws(()=>mailbox.reserveEffect('owner',history,live,{id:'effect'},undefined,0),/work refused/);
  });} finally {scope.close();}
  assert.equal(mailbox.get('turn'),'old');assert.equal(mailbox.reservedBytes,bytes);
  assert.equal(history.size,0);assert.equal(live.size,0);assert.equal(mailbox.has('owner'),false);
});

test('ordinary turns and effect append never inspect unchanged effect fields',()=>{
  const mailbox=new RetainedMailbox(),history=new Map(),live=new Map();
  const first={id:'first',kind:'write',outcome:'not-submitted'};
  assert.equal(mailbox.reserveEffect('owner',history,live,first,undefined,0),true);
  Object.defineProperty(first,'outcome',{enumerable:true,get(){throw new Error('old history traversed');}});
  assert.equal(mailbox.reserve('turn:owner',{kind:'receive',maximumBytes:6},0),true);
  assert.equal(mailbox.reserveEffect('owner',history,live,{id:'second',kind:'read',outcome:'not-submitted'},undefined,0),true);
  assert.equal(history.size,2);assert.equal(live.size,2);
});

test('both new effect-container slots share the item ceiling and late work refusal is atomic',()=>{
  const mailbox=new RetainedMailbox(),history=new Map(),live=new Map(),effect={id:'first',kind:'write',outcome:'not-submitted'};
  for(let i=0;i<1023;i++)assert.equal(mailbox.retainRaw(0,0),true);
  assert.equal(mailbox.reserveEffect('owner',history,live,effect,undefined,0),false);
  assert.equal(mailbox.size,0);assert.equal(history.size,0);assert.equal(live.size,0);
  mailbox.releaseRaw(0);
  // Reach the last charged index update, then refuse before either publication.
  const probe=new RetainedMailbox();
  const required=measured(()=>assert.equal(probe.reserveEffect('owner',new Map(),new Map(),effect,undefined,0),true));
  let spent=0;const bytes=mailbox.reservedBytes;
  const scope=new NativeScratch(new StandaloneNativeData(),n=>{spent+=n;if(spent>=required)throw new Error('late refusal');});
  try {assert.throws(()=>withNativeScratch(scope,()=>mailbox.reserveEffect('owner',history,live,effect,undefined,0)),/late refusal/);}
  finally {scope.close();}
  assert.equal(spent,required);assert.equal(mailbox.reservedBytes,bytes);
  assert.equal(mailbox.size,0);assert.equal(history.size,0);assert.equal(live.size,0);
  assert.equal(mailbox.reserveEffect('owner',history,live,effect,undefined,0),true);
  assert.equal(mailbox.reservedItems,1024);
});
