import assert from "node:assert/strict";
import test from "node:test";
import { NativeScratch, StandaloneNativeData, withNativeScratch, nativeArray, nativeRecord, nativeSort, nativeValue } from "../src/native-account.ts";
import { encodeLuaValueAbiFrame, decodeLuaValueAbiFrame } from "../src/value-abi.ts";

test("array short circuit spends visited work, and refusal precedes the next callback", () => {
  let left = 3;
  const scope = new NativeScratch(new StandaloneNativeData(), units => {
    if (units > left) throw new Error("spent"); left -= units;
  });
  try { withNativeScratch(scope, () => {
    assert.equal(nativeArray([true, false, false]).some(Boolean), true);
    assert.equal(left, 2);
    assert.equal(nativeArray([false, true, true]).every(Boolean), false);
    assert.equal(left, 1);
    const seen = [];
    assert.throws(() => nativeArray([1, 2, 3]).map(value => { seen.push(value); return value; }), /spent/);
    assert.deepEqual(seen, [1]);
  }); } finally { scope.close(); }
});
test("native record output refuses before accepting the unaffordable next member", () => {
  let left = 2, entered = 0;
  const scope = new NativeScratch(new StandaloneNativeData(), units => {
    if (units > left) throw new Error("spent"); left -= units;
  });
  try { withNativeScratch(scope, () => {
    function* entries() { for (let i = 0; i < 3; i++) { entered++; yield [String(i), i]; } }
    assert.throws(() => nativeRecord(entries()), /spent/);
    assert.equal(entered, 3); // yielded input is not acceptance/publication of a record
  }); } finally { scope.close(); }
});
test("completed size-walk scratch releases without refunding work", () => {
  let resident=0, work=0;
  const data={reserve(n){resident+=n;let live=true;return {release(){if(live){live=false;resident-=n;}}};}};
  const scope=new NativeScratch(data,n=>{work+=n;});
  try {
    scope.reserve(16);
    scope.transient(temporary=>{temporary.reserve(4096);temporary.work(7);assert.equal(resident,4112);});
    assert.equal(resident,16);assert.equal(work,7);
    assert.throws(()=>scope.transient(temporary=>{temporary.reserve(2048);temporary.work(3);throw new Error('refused');}),/refused/);
    assert.equal(resident,16);assert.equal(work,10);
  } finally {scope.close();}
  assert.equal(resident,0);
});
test("sorting does not strip the accounting wrapper from a subsequent map", () => {
  let left=2;const seen=[];
  const scope=new NativeScratch(new StandaloneNativeData(),n=>{if(n>left)throw new Error('spent');left-=n;});
  try {withNativeScratch(scope,()=>{
    assert.throws(()=>nativeSort(nativeArray([2,1]),(a,b)=>a-b).map(value=>{seen.push(value);return value;}),/spent/);
    assert.deepEqual(seen,[1]);
  });} finally {scope.close();}
});
for(const kind of ['map','set'])test(`native structural copying accounts for ${kind} contents before cloning`,()=>{
  const value=kind==='map'?new Map([['payload',new Uint8Array(1024)]]):new Set([new Uint8Array(1024)]);
  const scope=new NativeScratch({reserve(n){if(n>=1024)throw new Error('capacity');return {release(){}};}},()=>{});
  let published=false;
  try {withNativeScratch(scope,()=>{
    assert.throws(()=>{structuredClone(nativeValue(value));published=true;},/capacity/);
    assert.equal(published,false);
  });} finally {scope.close();}
});

test("finished ABI writers release their number arrays while encoded bytes remain usable", () => {
  let resident = 0;
  const maximum = 1024 * 1024;
  const data = { reserve(n) {
    if (n > maximum - resident) throw new Error("native capacity");
    resident += n; let live = true;
    return { release() { if (live) { live = false; resident -= n; } } };
  } };
  const value = { kind: "array", items: [{ kind: "text", value: "x".repeat(1024) }] };
  const expected = encodeLuaValueAbiFrame("value", value);
  const scope = new NativeScratch(data, () => {});
  try {
    const bytes = withNativeScratch(scope, () => encodeLuaValueAbiFrame("value", value));
    // Independent work can use the aggregate without retiring the encoded
    // result. Retaining any finished writer defeats this capacity control.
    const independent = data.reserve(maximum - 16384);
    assert.deepEqual(bytes, expected);
    assert.deepEqual(decodeLuaValueAbiFrame(bytes).semantic, value);
    independent.release();
  } finally { scope.close(); }
  assert.equal(resident, 0);
});
