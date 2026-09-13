import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { verifyLuaSourceSet } from "@protodriver/contracts";
import { openRetainedLua } from "@protodriver/lua-vm/retained";
import { NativeHelperData } from "../src/native-helper.ts";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
const code = error => error.code ?? error.error?.code;
async function open(body, data = new NativeHelperData()) {
  const source = await verifyLuaSourceSet({ bootstrap: { packageFormat: "supported", generatorContract: "supported" },
    members: [{ logicalName: "device.lua", sourceBytes: new TextEncoder().encode(`return {id="containment"},{run=function(args,io) ${body} end}`) }] });
  return openRetainedLua(source, artifact, {}, data);
}

test("default inline encoding admits the former 16000-byte refusal intact", async () => {
  const vm = await open("return args.value");
  try {
    await vm.execution.register("root");
    const result=await vm.execution.startOperation("root", "run", { value: "x".repeat(16000) }, { value: { kind: "string" } });
    assert.deepEqual(result.value,{kind:"result",value:"x".repeat(16000)});result.release();
    assert.equal(vm.execution.terminated, false);
  } finally { vm.close(); }
});

test("a decoded authored failure retires only its operation; the same VM accepts another", async () => {
  class ObservedData extends NativeHelperData {
    resident = 8;
    reserve(capacity, usedLength = capacity) {
      const held = super.reserve(capacity, usedLength), bytes = capacity + 84;
      this.resident += bytes; let live = true;
      return { release: () => { if (live) { live = false; this.resident -= bytes; held.release(); } } };
    }
  }
  const data = new ObservedData();
  const vm = await open('if args.fail then pdrv.fail("expected", {reason="controlled"}) end; return args.value', data);
  try {
    const admission = data.resident;
    await vm.execution.register("failed");
    await assert.rejects(vm.execution.startOperation("failed", "run", { fail: true, value: "unused" },
      { fail: { kind: "boolean" }, value: { kind: "string" } }), e => e.programFailureName === "expected");
    assert.equal(vm.execution.terminated, false);
    const independentCapacity = 16 * 1024 * 1024 - admission - 84;
    assert.throws(() => data.reserve(independentCapacity), e => e.error?.code === "retained.helper-data-exhausted");
    assert.ok(data.resident > admission, "escaped failure details still occupy the aggregate");
    await vm.execution.retire("failed");
    assert.equal(data.resident, admission, "failure storage retires at consumer handoff");
    data.reserve(independentCapacity).release();
    await vm.execution.register("next");
    const result = await vm.execution.startOperation("next", "run", { fail: false, value: "SURVIVED" },
      { fail: { kind: "boolean" }, value: { kind: "string" } });
    assert.deepEqual(result.value, { kind: "result", value: "SURVIVED" }); result.release();
    await vm.execution.retire("next");
  } finally { vm.close(); }
});

test("native work survives child retirement instead of buying a grant per invocation", {timeout:10000}, async () => {
  const vm = await open('local a=pdrv.bytes(string.rep("x",65536)); local b=pdrv.bytes(string.rep("x",65535).."x"); assert(a==b); return "checked"'), results = [];
  try {
    await vm.execution.register("root");
    await assert.rejects(async () => {
      // 512 actual 65,536-byte comparisons alone exceed 32M. Tiny boundary
      // values avoid making the fast control execute millions of JS ABI bodies.
      for (let i = 0; i < 512; i++) {
        const id = "child-" + i;
        await vm.execution.register(id, "root");
        const result = await vm.execution.startOperation(id, "run", {}, {});
        assert.equal(result.value.value, "checked"); result.release(); results.push(id);
        await vm.execution.retire(id);
      }
    }, error => code(error) === "retained.work-exhausted");
    assert.ok(results.length > 1 && results.length < 512, JSON.stringify(results));
    assert.equal(vm.execution.terminated, true);
  } finally { vm.close(); }
});

test("C scratch refusal cannot be caught into a result; removing the account admits it", async () => {
  const body = 'local t={} for i=1,1100 do t["key"..i]=true end; local ok=pcall(function() pdrv.record_fields(t) end); return ok';
  async function run() {
    const vm = await open(body, new NativeHelperData(32 * 1024));
    try {
      await vm.execution.register("root");
      const result = await vm.execution.startOperation("root", "run", {}, {});
      const value = result.value; result.release(); return value;
    } finally { vm.close(); }
  }
  await assert.rejects(run(), error => code(error) === "retained.helper-data-exhausted");
  // A semantic mutation of the whole C reservation mechanism, not a spy on
  // calls. The JS aggregate, work accounts, Lua allocator and source stay live.
  const original = WebAssembly.instantiate;
  try {
    WebAssembly.instantiate = (bytes, imports) => original(bytes, { ...imports, env: { ...imports.env,
      pdrv_retained_reserve() { return 1; }, pdrv_retained_release() {} } });
    assert.deepEqual(await run(), { kind: "result", value: true });
  } finally { WebAssembly.instantiate = original; }
});

test("consumed invocation storage cannot occupy the pending result's lifetime", async () => {
  class ObservedData extends NativeHelperData {
    resident=8;
    reserve(capacity,usedLength=capacity) {
      const held=super.reserve(capacity,usedLength), bytes=capacity+84;
      this.resident+=bytes;let live=true;
      return {release:()=>{if(live){live=false;this.resident-=bytes;held.release();}}};
    }
  }
  const data=new ObservedData(),vm=await open('io.request({kind="write",value="WAIT"}); return #args.value==2048',data);
  try {
    const admission=data.resident;
    await vm.execution.register('root');
    const first=await vm.execution.startOperation('root','run',{value:'x'.repeat(2048)},{value:{kind:'string'}});
    assert.deepEqual(first.value,{kind:'write',value:'WAIT'});
    // Another owner may use the aggregate after the input is consumed, while
    // this small result is still pending. Keep its 8 KiB headroom intact.
    const independent=data.reserve(16*1024*1024-admission-8192-84);
    independent.release();first.release();
    const resumed=await vm.execution.dispatch('root','resume|root|settled');
    assert.deepEqual(resumed.value,{kind:'result',value:true});resumed.release();
  } finally {vm.close();}
  assert.equal(data.resident,8);
});
