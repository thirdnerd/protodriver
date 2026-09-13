import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {admitAuthoredModule} from '../src/authored-module.ts';
const wasm=new Uint8Array(await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
async function execution(t,body){
 const source=`local a=pdrv.array return {apiVersion="device/v2",id="retirement",modes=a({"m"}),profiles=a({"p"}),operations=a({{id="run",title="run",binding="run",arguments={},result={kind="none"},risk="read-only",repeatability="safe-to-repeat",locks=a({}),requires=a({}),availability={modes=a({"m"}),profiles=a({"p"})}}})},{run=function(_,io) ${body} end}`;
 const m=await admitAuthoredModule([{logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')},{logicalName:'device.lua',sourceBytes:Buffer.from(source)}],wasm);
 const e=await m.openExecution();t.after(()=>e.close());return e;
}
test('normal return retires within remaining terminal work without another Lua turn',async t=>{
 const e=await execution(t,'return nil');let work=0,ceiling=100000;
 await e.register('root',undefined,n=>{work+=n;assert.ok(work<=ceiling,'terminal allowance cannot afford a second ABI crossing');});
 const r=await e.startOperation('root','run',{},{});assert.equal(r.value.kind,'result');r.release();
 await assert.rejects(e.register('root'),/account-limit/,'task death does not release the host account');
 ceiling=work+16;const retired=await e.retire('root');assert.equal(retired.consumed,0);
});
for(const forged of [false,true])test('author-yielded result'+(forged?' with forged death fields':'')+' cannot survive retirement',async t=>{
 const e=await execution(t,'io.request({kind="result",value=pdrv.null'+(forged?',ended=true':'')+'});return "STALE TAIL"');
 await e.register('same');const r=await e.startOperation('same','run',{},{});r.release();
 await e.retire('same');await e.register('same');
 await assert.rejects(e.dispatch('same','resume|same|'),/lua-vm.environment.program/,'retirement must remove a suspended coroutine, not trust authored result fields');
});
test('completed root retains its spent fuel for a delivery sibling',async t=>{
 const e=await execution(t,'return nil');await e.register('root',undefined,undefined,100);
 const r=await e.startOperation('root','run',{},{});r.release();await e.retire('root',true);
 await e.register('child','root');
 await assert.rejects(e.startOperation('child','run',{},{}),/retained Lua execution failed/,'retained parent must not become a fresh child grant');
});
