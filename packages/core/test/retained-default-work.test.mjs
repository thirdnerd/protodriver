import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAuthoredSession} from '../src/authored-module.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';
import {DEFAULT_RETAINED_EFFECT_WORK,RETAINED_LUA_FUEL} from '../../lua-vm/src/retained.ts';

const wasm=await readFile(new URL('../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url));
const source=Buffer.from(`
local function work()
  -- The comparison body alone exceeds the former 100,000 grant.
  local a=pdrv.bytes(string.rep("x",131072))
  local b=pdrv.bytes(string.rep("x",131071).."x")
  assert(a==b)
end
return {apiVersion="device/v2",id="default-policy",modes=pdrv.array({"m"}),profiles=pdrv.array({"p"}),
 entry={binding="enter",locks=pdrv.array({}),requires=pdrv.array({})},
 operations=pdrv.array({{id="run",binding="run",title="Run",arguments={},result={kind="value",type={kind="boolean"}},
 risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({}),requires=pdrv.array({}),
 availability={modes=pdrv.array({"m"}),profiles=pdrv.array({"p"})}}})},
 {enter=function() work() end,run=function() work();return true end}`);
async function client(t,options={},input=source) {
 const clock=new VirtualClock();
 const {server}=await createAuthoredSession([{logicalName:'device.lua',sourceBytes:input},
  {logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}],wasm,
  {clock,platform:'node',modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker:{},captureDestinationAdapter:{},
   open:async()=>new MockTransport(clock).openConnection({modeId:'m',profileId:'p',identity:{transport:'mock',stableKeyAssurance:'none'}}),...options});
 const c=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{await c.disconnect();await c.close();});await c.attach('default-policy');return c;
}
test('D4 native default widens entry and operation, not explicit work policy',{timeout:5000},async t=>{
 assert.equal(DEFAULT_RETAINED_EFFECT_WORK,32000000);assert.equal(RETAINED_LUA_FUEL,1000000);
 const c=await client(t);await c.connect({mode:'m'});
 const op=await c.startOperation({operation:'run',arguments:{}}),result=await c.awaitOperation(op.operationId);
 assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(result.result,true);
 const limited=await client(t,{maximumEffectWork:100000});
 await assert.rejects(limited.connect({mode:'m'}),e=>(e.error?.code??e.code)==='retained.work-exhausted');
});
test('D5 runaway still exhausts the independent Lua account',{timeout:5000},async t=>{
 const input=Buffer.from(source.toString().replace('work();return true','while true do end'));
 const c=await client(t,{},input);await c.connect({mode:'m'});
 const op=await c.startOperation({operation:'run',arguments:{}}),result=await c.awaitOperation(op.operationId);
 assert.equal(result.error?.code,'lua-vm.resource.fuel-exhausted');
 assert.equal(result.error.details.fuelConsumed,1000000);
});
test('D5 entry and operation complete real Lua work beyond the former allowance',{timeout:5000},async t=>{
 // The loop body alone executes more than 100,000 Lua instructions. It does
 // no native iteration work and checks its value, not just a policy constant.
 const input=Buffer.from(source.toString().replace(/local function work\(\)[\s\S]*?\nend/,`local function work()
   local total=0;for i=1,60000 do total=total+1 end;assert(total==60000)
 end`));
 const c=await client(t,{},input);await c.connect({mode:'m'});
 const op=await c.startOperation({operation:'run',arguments:{}}),result=await c.awaitOperation(op.operationId);
 assert.equal(result.outcome,'completed',JSON.stringify(result));assert.equal(result.result,true);
});
