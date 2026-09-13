import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {buildPdpkg,verifyLuaSourceSet} from "@protodriver/contracts";
import {openRetainedLua} from "@protodriver/lua-vm/retained";
import {createAuthoredSession,admitAuthoredModule} from "../src/authored-module.ts";
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from "../src/rpc.ts";
import {cases,runCase} from "../../../test-support/vm-diagnostics/population.mjs";
import {diagnosticOptions} from "../../../test-support/vm-diagnostics/fixture.mjs";
const artifact=new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm",import.meta.url)));
const members=await Promise.all(["pdpkg.json","device.lua"].map(async logicalName=>({logicalName,
  sourceBytes:new Uint8Array(await readFile(new URL("./fixtures/authored-vm-diagnostics/"+logicalName,import.meta.url)))})));
test("D5 retained-context opening keeps effect-free admission at 100000 fuel",{timeout:5000},async()=>{
  const source=await verifyLuaSourceSet({bootstrap:{packageFormat:"supported",generatorContract:"supported"},
    members:[{logicalName:"device.lua",sourceBytes:Buffer.from('pcall(function() while true do end end); return {id="caught"},{}')}]});
  await assert.rejects(openRetainedLua(source,artifact,{}),error=>{
    assert.equal(error.code,"lua-vm.resource.fuel-exhausted");assert.equal(error.phase,"admission");
    assert.equal(error.fuelConsumed,100000);return true;
  });
});
for(const kind of cases)test("retained VM diagnostics: "+kind,{timeout:5000},async t=>{
  const original=WebAssembly.instantiate,dispatches=[];
  WebAssembly.instantiate=async(...args)=>{
    const result=await original(...args),e=result.instance.exports;
    return {...result,instance:{exports:{...e,pdrv_retained_result_dispatch(...input){
      const status=e.pdrv_retained_result_dispatch(...input);
      dispatches.push({status,fuelConsumed:new DataView(e.memory.buffer).getUint32(input[6],true)});return status;
    }}}};
  };
  t.after(()=>{WebAssembly.instantiate=original;});
  const {server}=await createAuthoredSession(members,artifact,{...diagnosticOptions(),platform:"node",resourceBroker:{},captureDestinationAdapter:{}});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  const row=await runCase(client,kind);
  if(["fuel","allocation","program"].includes(kind)) {
    assert.equal(dispatches.length,1,"no second VM turn after terminal refusal");
    assert.equal(row.details.fuelConsumed,dispatches[0].fuelConsumed,"wire fuel equals the native out-parameter");
    assert.equal(row.details.vmStatus,dispatches[0].status);
    assert.deepEqual(row.details.dispatch,{action:"start",role:"operation",binding:"run"},"bounded host dispatch context survives the error envelope");
  }
});
test("retained VM diagnostics identify the effect whose completion resumed a failed dispatch",{timeout:5000},async t=>{
  // Unique regression: a live-effect failure was indistinguishable from a start-turn failure on Darwin HIL.
  const source=Buffer.from(`
    return {apiVersion="device/v2",id="vm-resume-diagnostics",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
      operations=pdrv.array({{id="run",title="Run",binding="run",arguments={},result={kind="value",type={kind="string"}},
        risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({}),
        availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({"timer"})}})},
      {run=function(_,io) io.request({kind="timer-arm",milliseconds=1000});error("private authored failure") end}
  `);
  const input=[members[0],{logicalName:"device.lua",sourceBytes:source}];
  const {server}=await createAuthoredSession(input,artifact,{...diagnosticOptions(),platform:"node",resourceBroker:{},captureDestinationAdapter:{}});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("vm-resume-diagnostics");await client.connect({mode:"main"});
  const operation=await client.startOperation({operation:"run",arguments:{}}),result=await client.awaitOperation(operation.operationId);
  assert.equal(result.error.code,"lua-vm.environment.program");
  assert.deepEqual(result.error.details.dispatch,{action:"resume",role:"operation",binding:"run",resumingEffect:"timer-arm"});
  assert.doesNotMatch(JSON.stringify(result.error),/private authored failure/u,"authored prose remains private");
});
test("retained VM preserves a named failure across an authored cleanup effect",{timeout:5000},async t=>{
  // Unique regression: a pdrv.fail caught for authored cleanup losing its
  // named envelope when the saved failure crosses a suspended effect turn.
  const source=Buffer.from(`
    return {apiVersion="device/v2",id="vm-reraised-diagnostics",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
      operations=pdrv.array({{id="run",title="Run",binding="run",arguments={},result={kind="value",type={kind="string"}},
        risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({}),
        availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({"timer"})}})},
      {run=function(_,io)
        local ok,failure=pcall(function() pdrv.fail("author.refused",{stage="entry"}) end)
        if not ok then io.request({kind="timer-arm",milliseconds=1});error(failure) end
      end}
  `);
  const input=[members[0],{logicalName:"device.lua",sourceBytes:source}];
  const {server}=await createAuthoredSession(input,artifact,{...diagnosticOptions(),platform:"node",resourceBroker:{},captureDestinationAdapter:{}});
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("vm-reraised-diagnostics");await client.connect({mode:"main"});
  const operation=await client.startOperation({operation:"run",arguments:{}}),result=await client.awaitOperation(operation.operationId);
  assert.equal(result.error.code,"lua-vm.invocation.program-failure");
  assert.deepEqual(result.error.details,{name:"author.refused",details:{stage:"entry"}});
});
test("retained admission -2 is output capacity, unlike dispatch scratch -2",{timeout:5000},async()=>{
  await assert.rejects(admitAuthoredModule(members,artifact,{luaResourcePolicy:{maximumEncodedOutputBytes:100}}),error=>{
    assert.equal(error.code,"lua-vm.resource.output-limit");assert.equal(error.vmStatus,-2);
    assert.equal(error.phase,"admission");assert.ok(error.fuelConsumed>0);return true;
  });
});
test("retained admission preserves an authored failure raised after require refusal",{timeout:5000},async()=>{
  // Unique regression: retained admission flattening a pdrv.fail caught and reraised during member resolution.
  const source=Buffer.from(`
    local ok,value=pcall(require,"required.lua")
    if not ok then pdrv.fail("module.source-member",{member="required.lua"}) end
    return value
  `);
  await assert.rejects(admitAuthoredModule([members[0],{logicalName:"device.lua",sourceBytes:source}],artifact),error=>{
    assert.equal(error.code,"lua-vm.admission.program-failure");
    assert.equal(error.programFailureName,"module.source-member");
    assert.deepEqual(error.programFailureDetails,{member:"required.lua"});
    assert.equal(error.phase,"admission");
    return true;
  });
});
test("retained root admission preserves authored program failures",{timeout:5000},async()=>{
  // Unique regression: K8 root attribution relabeling an authored pdrv.fail as a host source-member failure.
  const source=Buffer.from('pdrv.fail("root.authored",{kind="ordinary"})');
  await assert.rejects(admitAuthoredModule([members[0],{logicalName:"device.lua",sourceBytes:source}],artifact),error=>{
    assert.equal(error.code,"lua-vm.admission.program-failure");
    assert.equal(error.programFailureName,"root.authored");assert.deepEqual(error.programFailureDetails,{kind:"ordinary"});
    return true;
  });
});
test("retained admission attributes only the failed required member and coarse class",{timeout:5000},async()=>{
  // Unique regression: direct multi-file admission losing or spoofably inferring the innermost failed logical member.
  const encode=source=>Buffer.from(source);
  const cases=[
    {id:"missing",members:[{logicalName:"device.lua",sourceBytes:encode('return require("required.lua")')}],
      member:"required.lua",reason:"missing"},
    {id:"corrupt",members:[{logicalName:"device.lua",sourceBytes:encode('return require("required.lua")')},
      {logicalName:"required.lua",sourceBytes:encode("this is not lua")}],member:"required.lua",reason:"initialization-failed"},
    // Unique regression: an authored ordinary error string spoofing the host-only missing classification.
    {id:"authored error cannot spoof missing",members:[{logicalName:"device.lua",sourceBytes:encode('return require("required.lua")')},
      {logicalName:"required.lua",sourceBytes:encode('error("lua-vm.require.missing: required.lua")')}],member:"required.lua",reason:"initialization-failed"},
    {id:"nested corrupt",members:[{logicalName:"device.lua",sourceBytes:encode('return require("outer.lua")')},
      {logicalName:"outer.lua",sourceBytes:encode('return require("leaf.lua")')},
      {logicalName:"leaf.lua",sourceBytes:encode("this is not lua")}],member:"leaf.lua",reason:"initialization-failed"},
  ];
  for(const row of cases)await assert.rejects(admitAuthoredModule([members[0],...row.members],artifact),error=>{
    assert.equal(error.code,"lua-vm.admission.source-member",row.id);
    assert.equal(error.sourceMember,row.member,row.id);
    assert.equal(error.sourceMemberFailure,row.reason,row.id);
    assert.deepEqual(Object.keys(error),["code","sourceMember","sourceMemberFailure","phase"],row.id);
    assert.doesNotMatch(error.message,/this is not lua|device\.lua|outer\.lua/u,row.id);
    return true;
  });
});
test("retained admission attributes corrupt and byte-substituted roots without parser disclosure",{timeout:5000},async()=>{
  // Unique regression: direct root loading or archive integrity failure bypassing K8 with VM status, source text, or archive position.
  const corrupt=Buffer.from("this root is not lua"),valid=Buffer.from('return {apiVersion="device/v2",id="root"},{}');
  const built=await buildPdpkg([{logicalName:"device.lua",sourceBytes:valid}]);
  const substituted=Buffer.from(built.archive),offset=substituted.indexOf(valid);assert.ok(offset>=0);
  substituted[offset+10]^=1;
  for(const [id,input] of [["corrupt",[members[0],{logicalName:"device.lua",sourceBytes:corrupt}]],
    ["byte-substituted",substituted]])await assert.rejects(admitAuthoredModule(input,artifact),error=>{
    assert.equal(error.code,"lua-vm.admission.source-member",id);
    assert.equal(error.sourceMember,"device.lua",id);
    assert.equal(error.sourceMemberFailure,"initialization-failed",id);
    assert.deepEqual(Object.keys(error),["code","sourceMember","sourceMemberFailure","phase"],id);
    assert.doesNotMatch(error.message,/this root is not lua|centralDirectory|\.lua:|stack/u,id);
    return true;
  });
  // Unique regression: the root-only archive adapter attributing a corrupt sibling to device.lua.
  const sibling=Buffer.from('return {value=1}'),multi=await buildPdpkg([
    {logicalName:"device.lua",sourceBytes:Buffer.from('return require("sibling.lua")')},
    {logicalName:"sibling.lua",sourceBytes:sibling},
  ]);
  const siblingSubstituted=Buffer.from(multi.archive),siblingOffset=siblingSubstituted.indexOf(sibling);assert.ok(siblingOffset>=0);
  siblingSubstituted[siblingOffset+10]^=1;
  await assert.rejects(admitAuthoredModule(siblingSubstituted,artifact),error=>{
    assert.equal(error.diagnostic?.code,"pdpkg.member.crc-mismatch");assert.equal(error.code,undefined);return true;
  });
});
for(const [kind,code,source] of [
  ["fuel","lua-vm.resource.fuel-exhausted","while true do end"],
  ["allocation","lua-vm.resource.allocation-limit",'return string.rep("x",33554432)'],
])test("retained admission preserves "+kind,{timeout:5000},async()=>{
  const input=members.map(m=>m.logicalName==="device.lua"?{...m,sourceBytes:Buffer.from(source)}:m);
  await assert.rejects(admitAuthoredModule(input,artifact),error=>{
    assert.equal(error.code,code);assert.equal(error.phase,"admission");assert.ok(error.fuelConsumed>0);
    if(kind==="fuel")assert.equal(error.fuelConsumed,100000);return true;
  });
});
