import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { admitAuthoredModule, createAuthoredSession } from "../src/authored-module.ts";
import { admitAuthoredDescription, validateAuthoredArguments } from "../src/authored-admission.ts";
import { buildPdpkg, readPdpkg } from "../../contracts/src/pdpkg.ts";
import { generateAuthoredControlModel } from "../../control-model/src/index.ts";
import { RetainedSessionRpcServer } from "../src/retained-session.ts";
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from "../src/rpc.ts";
import { RealClock } from "../src/clock.ts";
import { MockTransport } from "../../transport-mock/src/index.ts";

const artifact = new Uint8Array(await readFile(new URL("../../lua-vm/artifacts/protodriver-retained-v2.wasm", import.meta.url)));
async function population() { return Promise.all(["pdpkg.json", "device.lua"].map(async logicalName => ({logicalName,sourceBytes:new Uint8Array(await readFile(new URL("./fixtures/authored-admission/" + logicalName, import.meta.url)))}))); }
async function harness(t, input, grant = false) {
  const module = await admitAuthoredModule(input ?? await population(), artifact), execution = await module.openExecution();
  const clock = new RealClock(), writes = [], starts = [], events = [];
  let controls = 0, connection, opens = 0;
  const register = execution.register; execution.register = async id => { starts.push(id); await register(id); };
  const server = new RetainedSessionRpcServer({ platform: "node", clock, logicalDevice: module.description.id, modeId: "main", profileId: "serial", channelId: "main",
    description: module.description, operations: module.description.operations.map(op=>op.id), capabilities: {"usb.control":{available:grant,limitation:"controlled transport"}},
    usbControl:{available:grant,limitation:"controlled transport"},execution,helpers:{},resourceBroker:{},captureDestinationAdapter:{},
    async open() {
      opens++;const c = new MockTransport(clock).openConnection({identity:{transport:"mock",stableKeyAssurance:"none"},modeId:"main",profileId:"serial"});connection=c;
      c.control = async()=>{controls++;return {settled:"completed",atSequence:clock.nextSequence()};};
      const channel=c.channel("main"),acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{writes.push(new TextDecoder().decode(bytes));return write(bytes);};return lease;};return c;
    },
  });
  const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach("test");const subscription=client.subscribe(event=>events.push(event));t.after(()=>subscription.dispose());await client.connect({mode:"main"});
  return {module,client,writes,starts,events,controls:()=>controls,connection:()=>connection,opens:()=>opens,
    async run(operation,args={}){const h=await client.startOperation({operation,arguments:args});return client.awaitOperation(h.operationId);}};
}
test("real device/v2 source admits and returns nested records, arrays, enums, units and variants",{timeout:3000},async t=>{
  const h=await harness(t),result=await h.run("record",{voltage:{kind:"value",value:3300}});
  assert.equal(result.outcome,"completed",JSON.stringify(result));assert.deepEqual(result.result,{status:"ready",readings:[{voltage:3300}],detail:{kind:"variant",tag:"ok",value:{verified:true}}});
  assert.equal(h.module.description.operations[0].result.type.fields.readings.item.fields.voltage.unit.id,"millivolt");assert.deepEqual(h.writes,["VISIBLE"]);
});
test("wrong authored result fails with the earlier accepted device write still reported",{timeout:3000},async t=>{
  const h=await harness(t),result=await h.run("wrong-result");
  assert.equal(result.outcome,"failed");assert.equal(result.error.code,"authored.result.invalid");assert.deepEqual(h.writes,["VISIBLE"]);
  assert.equal(result.error.details.effects.find(e=>e.kind==="write")?.outcome,"accepted-by-platform");
});
test("static unavailable requirement refuses before operation-start, VM registration and writes",{timeout:3000},async t=>{
  const h=await harness(t);
  await assert.rejects(h.run("static-control"),e=>e.error?.code==="authored.capability.unavailable"||e.code==="authored.capability.unavailable");
  assert.equal(h.starts.length,0);assert.deepEqual(h.writes,[]);assert.equal(h.events.some(e=>e.kind==="operation-start"),false);
});
test("dynamic unsupported and invalid setup stay distinct and never reach native control",{timeout:3000},async t=>{
  const h=await harness(t),unsupported=await h.run("dynamic-control"),invalid=await h.run("invalid-control");
  assert.equal(JSON.parse(unsupported.result).settled,"unsupported");assert.equal(invalid.error.code,"retained.invalid-control");assert.equal(h.controls(),0);assert.equal(h.starts.length,2);
});
test("no-result authored success is null, not a fabricated value",{timeout:3000},async t=>{
  const h=await harness(t),result=await h.run("none");assert.equal(result.outcome,"completed");assert.equal(result.result,null);assert.deepEqual(h.writes,["NO-RESULT"]);
});

async function requirePostTerminalTaint(client){
  await assert.rejects(client.startOperation({operation:"none",arguments:{}}),
    error=>error.error?.code==="retained.protocol-reestablishment-required","S03 post-terminal operation must carry the named taint refusal");
}
test("S03 raw terminal owns bytes and requires explicit protocol re-establishment after close",{timeout:3000},async t=>{
  const h=await harness(t),received=Promise.withResolvers();
  const subscription=h.client.subscribe(event=>{if(event.kind==="raw-terminal-bytes")received.resolve(event);});t.after(()=>subscription.dispose());
  const terminal=await h.client.openRawTerminal(subscription.subscriptionId);
  assert.equal(terminal.exitRequirement.kind,"reconnect-required");
  const receipt=await h.client.writeRawTerminal(terminal.terminalId,Uint8Array.of(82,65,87));
  assert.equal(receipt.outcome.kind,"accepted-by-platform");assert.equal(h.writes.at(-1),"RAW");
  h.connection().channel("main").enqueueReceived(Uint8Array.of(0,127,255));
  const event=await received.promise;assert.deepEqual([...event.bytes],[0,127,255]);assert.equal(event.terminalId,terminal.terminalId);
  const exit=await h.client.exitRawTerminal(terminal.terminalId);
  assert.deepEqual(exit,{kind:"reestablishment-required",refusal:"retained.protocol-reestablishment-required"});
  await requirePostTerminalTaint(h.client);
  await h.client.connect({mode:"main"});assert.equal(h.opens(),2);
  assert.equal((await h.run("none")).outcome,"completed");
});
test("S03 evicting the owning subscription closes its raw terminal",{timeout:3000},async t=>{
  const h=await harness(t),subscription=h.client.subscribe(()=>{});
  await h.client.openRawTerminal(subscription.subscriptionId);const terminated=h.connection().terminated;subscription.dispose();await terminated;
  await requirePostTerminalTaint(h.client);
});
test("the static capability instrument admits the same operation when granted", {timeout:3000}, async t => {
  const h = await harness(t, undefined, true), result = await h.run("static-control");
  assert.equal(result.outcome, "completed"); assert.equal(result.result, "started");
  assert.equal(h.starts.length, 1); assert.deepEqual(h.writes, ["MUST-NOT-START"]);
});

function sourceModule(schema, body = "return args.value", args = "{value=schema}") {
  const source = `local schema=${schema}\nreturn {apiVersion="device/v2",id="value-fixture",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array({
    {id="run",title="Run",binding="run",arguments=${args},result={kind="value",type=schema},risk="read-only",repeatability="safe-to-repeat",
    locks=pdrv.array({"channel"}),availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}
  })},{run=function(args,io) ${body} end}`;
  return [{logicalName:"pdpkg.json",sourceBytes:new TextEncoder().encode('{"packageFormat":1,"generatorContract":2}')},
    {logicalName:"device.lua",sourceBytes:new TextEncoder().encode(source)}];
}
test("S02 preserves authenticated presentation metadata through the shared generated model",async()=>{
  const schema='{kind="record",fields={reading={kind="integer",widthBits=16.0,signed=false}},fieldLabels={reading="Reading"}}';
  const input=sourceModule(schema,"return {reading=args.value}",'{value={kind="integer",widthBits=16.0,signed=false,label="Value",description="Value to inspect."}}');
  let source=new TextDecoder().decode(input[1].sourceBytes);
  source=source.replace('id="value-fixture",modes=', 'id="value-fixture",displayName="Value fixture",description="Explains the fixture.",modes=');
  source=source.replace('profiles=pdrv.array({"serial"}),operations=', 'profiles=pdrv.array({"serial"}),modePresentation={main={label="Main mode",description="Explains the mode."}},operations=');
  source=source.replace('id="run",title="Run",binding=', 'id="run",title="Run",description="Explains the operation.",binding=');
  input[1].sourceBytes=new TextEncoder().encode(source);
  const module=await admitAuthoredModule(input,artifact),model=generateAuthoredControlModel(module.description);
  assert.equal(model.displayName,"Value fixture");assert.equal(model.description,"Explains the fixture.");
  assert.deepEqual(model.modePresentation,{main:{label:"Main mode",description:"Explains the mode."}});
  assert.equal(model.operations[0].description,"Explains the operation.");
  assert.equal(model.operations[0].argumentControls.value.label,"Value");
  assert.equal(model.operations[0].argumentControls.value.description,"Value to inspect.");
  assert.equal(model.operations[0].resultControl.fields.reading.label,"Reading");

  const mutations=[
    ["module display name",d=>d.displayName=" \n "],["module description",d=>d.description=" \n "],
    ["mode label",d=>d.modePresentation.main.label=" \n "],["mode description",d=>d.modePresentation.main.description=" \n "],
    ["operation description",d=>d.operations[0].description=" \n "],["argument label",d=>d.operations[0].arguments.value.label=" \n "],
    ["argument description",d=>d.operations[0].arguments.value.description=" \n "],["result field label",d=>d.operations[0].result.type.fieldLabels.reading=" \n "],
  ];
  for(const [name,mutate] of mutations){
    const changed=structuredClone(module.description);mutate(changed);
    assert.throws(()=>admitAuthoredDescription(changed,module.bindings),error=>error.code==="authored.declaration.invalid",`S02 blank ${name} admission guard`);
  }
});
const values = [
  ["boolean", '{kind="boolean"}', true],
  ["i64", '{kind="integer",widthBits=64.0,signed=true}', {type:"i64",value:"-9223372036854775808"}],
  ["u64", '{kind="integer",widthBits=64.0,signed=false}', {type:"u64",value:"18446744073709551615"}],
  ["float", '{kind="float",minimum=0.0,maximum=2.0}', 1.5],
  ["decimal", '{kind="decimal"}', {type:"decimal",value:"1.25"}],
  ["string", '{kind="string",minimumLength=1.0,maximumLength=4.0}', "é"],
  ["bytes", '{kind="bytes",minimumLength=2.0,maximumLength=2.0}', {type:"bytes",encoding:"base64",value:"AP8="}],
  ["enum", '{kind="enum",members=pdrv.array({"red","blue"})}', "blue"],
  ["unicode-enum", '{kind="enum",members=pdrv.array({"開","0"})}', "開"],
  ["flags", '{kind="flags",members=pdrv.array({"a","b"})}', ["a","b"]],
  ["empty-array", '{kind="array",item={kind="boolean"}}', []],
  ["nested-record", '{kind="record",fields={values={kind="array",item={kind="integer",widthBits=64.0,signed=false}}}}', {values:[{type:"u64",value:"18446744073709551615"}]}],
  ["variant", '{kind="variant",variants={yes={kind="record",fields={value={kind="boolean"}}}}}', {kind:"variant",tag:"yes",value:{value:true}}],
  ["null", '{kind="null"}', null],
];
for (const [name,schema,value] of values) test("typed immutable argument/result round-trip: " + name, {timeout:3000}, async t => {
  const h = await harness(t, sourceModule(schema)), result = await h.run("run",{value:{kind:"value",value}});
  assert.equal(result.outcome,"completed",JSON.stringify(result)); assert.deepEqual(result.result,value);
  assert.equal(generateAuthoredControlModel(h.module.description).operations[0].resultControl.declaration.kind,h.module.description.operations[0].result.type.kind);
});
test("immutable arguments reject assignment and rawset while retaining record and array access", {timeout:3000}, async t => {
  const schema='{kind="record",fields={values={kind="array",item={kind="boolean"}}}}';
  const h=await harness(t,sourceModule(schema, `
    assert(not pcall(function() args.value.values[1]=false end))
    assert(not pcall(function() rawset(args.value.values,1,false) end))
    assert(not pcall(function() io.request=nil end))
    local count=0
    for k,v in pdrv.record_fields(args.value) do assert(k=="values"); count=count+1; assert(#v==1) end
    assert(count==1)
    for i,v in ipairs(args.value.values) do assert(i==1 and v==true) end
    return args.value`));
  const result=await h.run("run",{value:{kind:"value",value:{values:[true]}}});
  assert.equal(result.outcome,"completed",JSON.stringify(result));assert.deepEqual(result.result,{values:[true]});
});
test("invalid argument restriction refuses before operation registration, event or write", {timeout:3000}, async t => {
  const h=await harness(t);
  await assert.rejects(h.run("record",{voltage:{kind:"value",value:5001}}));
  assert.equal(h.starts.length,0);assert.deepEqual(h.writes,[]);assert.equal(h.events.some(e=>e.kind==="operation-start"),false);
});
test("description rejects missing claims, unknown availability, unresolved bindings and impossible restrictions", {timeout:3000}, async()=>{
  const module=await admitAuthoredModule(await population(),artifact);
  for(const field of ["binding","arguments","result","risk","repeatability","locks","availability","requires"]){
    const d=structuredClone(module.description);delete d.operations[0][field];assert.throws(()=>admitAuthoredDescription(d,module.bindings),field);
  }
  for(const change of [d=>d.operations[0].binding="missing",d=>d.operations[0].availability.profiles=["missing"],d=>d.operations[0].arguments.voltage.minimum=6000,d=>d.operations[0].risk="safe",d=>d.operations[0].result.type.fields.readings.maximumLength=-1]){
    const d=structuredClone(module.description);change(d);assert.throws(()=>admitAuthoredDescription(d,module.bindings));
  }
});
test("version axes, explicit directory bootstrap and interface marker refuse independently", {timeout:3000}, async()=>{
  const members=await population();
  for(const bootstrap of ['{"packageFormat":0,"generatorContract":2}','{"packageFormat":2,"generatorContract":2}','{"packageFormat":1,"generatorContract":1}','{"packageFormat":1,"generatorContract":3}']){
    await assert.rejects(admitAuthoredModule([{logicalName:"pdpkg.json",sourceBytes:new TextEncoder().encode(bootstrap)},members[1]],artifact));
  }
  await assert.rejects(admitAuthoredModule([members[1]],artifact));
  for(const api of ["device/v1","device/v3"]){
    const changed=structuredClone(members);changed[1].sourceBytes=new TextEncoder().encode(new TextDecoder().decode(changed[1].sourceBytes).replace("device/v2",api));
    await assert.rejects(admitAuthoredModule(changed,artifact),e=>e.code==="authored.api-version");
  }
  const packed=await buildPdpkg([members[1]]);
  assert.equal((await admitAuthoredModule(packed.archive,artifact)).description.apiVersion,"device/v2");
  await readPdpkg(packed.archive);
});
test("an author record imitating an ABI integer is not a scalar result", {timeout:3000}, async t=>{
  const h=await harness(t,sourceModule('{kind="integer",widthBits=16.0,signed=false}', 'return {kind="u64",decimal="1"}', '{}'));
  const result=await h.run("run");assert.equal(result.error.code,"authored.result.invalid");
});
test("fresh context owns source bytes; graph-equal changed export has a different complete identity", {timeout:3000}, async t=>{
  const input=await population(),original=await admitAuthoredModule(input,artifact);
  assert.equal("commonRuntime" in original.identity, false);
  input[1].sourceBytes=new TextEncoder().encode(new TextDecoder().decode(input[1].sourceBytes).replace('value="VISIBLE"','value="CHANGED"'));
  const changed=await admitAuthoredModule(input,artifact);
  assert.deepEqual(changed.canonicalBytes,original.canonicalBytes);
  assert.notEqual(changed.identity.sourceSet,original.identity.sourceSet);assert.notEqual(changed.identity.digest,original.identity.digest);
  await assert.rejects(admitAuthoredModule(input,artifact,{expectedSourceSetSha256:original.identity.sourceSet}),e=>e.code==="authored.expectation.mismatch");
  const execution=await original.openExecution();t.after(()=>execution.close());await execution.register("owned");
  const turn=await execution.startOperation("owned","wrong-result",{},{});
  assert.equal(turn.value.value,"VISIBLE");
});
test("product creation refuses unresolved declarations before invoking native acquisition", {timeout:3000}, async()=>{
  const input=await population();input[1].sourceBytes=new TextEncoder().encode(new TextDecoder().decode(input[1].sourceBytes).replace('binding=id','binding="missing"'));
  let opens=0;
  await assert.rejects(createAuthoredSession(input,artifact,{platform:"node",clock:new RealClock(),modeId:"main",profileId:"serial",channelId:"main",helpers:{},resourceBroker:{},captureDestinationAdapter:{},open:async()=>{opens++;throw new Error("must not open");}}),e=>e.code==="authored.binding.unresolved");
  assert.equal(opens,0);
});
test("authored integer effect fields do not require a float spelling", {timeout:3000}, async t=>{
  const h=await harness(t,sourceModule('{kind="string"}', 'return io.request({kind="timer-arm",milliseconds=1})', '{}'));
  const result=await h.run("run");assert.equal(result.outcome,"completed",JSON.stringify(result));assert.equal(typeof result.result,"string");
});
test("authored globals cannot replace retained dispatcher functions or enter its lexical scope", {timeout:3000}, async t=>{
  const input=sourceModule('{kind="boolean"}', `
    assert(not pcall(function() io.request=nil end))
    io.request({kind="write",value="PROTECTED"})
    return args.value`);
  input[1].sourceBytes=new TextEncoder().encode(new TextDecoder().decode(input[1].sourceBytes).replace('return {apiVersion=', `
    fields=nil; readonly=nil; resume=nil
    pdrv.readonly=function(value) return value end
    pdrv.record_fields=function() error("author replaced fields") end
    table.sort=function() error("author replaced sort") end
    coroutine.resume=function() error("author replaced resume") end
    coroutine.yield=function() error("author replaced yield") end
    return {apiVersion=`));
  const h=await harness(t,input),result=await h.run("run",{value:{kind:"value",value:true}});
  assert.equal(result.outcome,"completed",JSON.stringify(result));assert.equal(result.result,true);assert.deepEqual(h.writes,["PROTECTED"]);
});
test("decimal result is finite exact numeric text, not an arbitrary string", {timeout:3000}, async t=>{
  const h=await harness(t,sourceModule('{kind="decimal"}', 'return "not-a-decimal"', '{}'));
  assert.equal((await h.run("run")).error.code,"authored.result.invalid");
});
test("admitted operation keeps its cumulative Lua fuel account across yielded writes", {timeout:3000}, async t=>{
  const h=await harness(t,sourceModule('{kind="string"}', `
    for turn=1,4 do
      local count=0
      for i=1,200000 do count=count+1 end; assert(count==200000)
      io.request({kind="write",value="TURN"})
    end
    return "unbounded"`, '{}'));
  const result=await h.run("run");
  assert.equal(result.outcome,"failed",JSON.stringify(result));
  assert.equal(result.error.code,"lua-vm.resource.fuel-exhausted");
  assert.equal(result.error.details.vmStatus,-18);
  assert.ok(result.error.details.fuelConsumed>0&&result.error.details.fuelConsumed<1000000,
    "failed dispatch consumes the remainder, not a fresh activation grant");
  assert.ok(h.writes.length>0 && h.writes.length<4,"some turns completed but yields did not reset the account");
});
test("an operation requiring connection.lifecycle is refused when no invalidation binding is declared", {timeout:3000}, async()=>{
  const module=await admitAuthoredModule(await population(),artifact);
  const d=structuredClone(module.description);
  assert.equal(d.invalidation,undefined,"fixture must declare no invalidation for this to be the case under test");
  d.operations[0].requires=["connection.lifecycle"];
  assert.throws(()=>admitAuthoredDescription(d,module.bindings),error=>error.code==="authored.declaration.invalid","static lifecycle dependency must be refused at admission, not at operation start");
});
