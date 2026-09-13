import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../../../test-support/clock.ts";
import { AuthoredPollService, DEFAULT_AUTHORED_POLL_POLICY as policy, grantPollPlans, pollPlans } from "../src/authored-poll.ts";
import { admitAuthoredDescription } from "../src/authored-admission.ts";
const refresh = {kind:"poll",mode:"interactive",operation:"query",intervalMs:5000,failureBackoffMs:30000,suspendWhileLocksHeld:["protocol"]};
const description = {apiVersion:"device/v2",id:"poll-control",modes:["interactive","silent"],profiles:["serial"],
  operations:[{id:"query",title:"query",binding:"query",arguments:{},result:{kind:"value",type:{kind:"string"}},
    risk:"read-only",repeatability:"safe-to-repeat",locks:["protocol"],requires:[],availability:{modes:["interactive","silent"],profiles:["serial"]}}],
  state:{a:{type:{kind:"string"},freshForMs:5500,refresh},b:{type:{kind:"boolean"},freshForMs:null,dependsOn:["a"],refresh}}};
const admitted=()=>admitAuthoredDescription(description,["query"]);
const idleTiming={kind:"idle-reset",activity:"foreground-lifecycle"};
const idlePlans=()=>[{...pollPlans(admitted())[0],intervalMs:200,failureBackoffMs:1000,timing:idleTiming,cells:[]}];
test("C5 destination-less references share admission, identity and grant",()=>{
  const d=structuredClone(description);delete d.state;d.maintenance=[{...refresh,timing:idleTiming}];
  assert.deepEqual(pollPlans(admitAuthoredDescription(d,["query"]))[0].cells,[]);
  d.state={a:{...description.state.a,refresh:d.maintenance[0]}};
  assert.equal(pollPlans(admitAuthoredDescription(d,["query"])).length,1);
  d.state.a.refresh=refresh;
  assert.throws(()=>admitAuthoredDescription(d,["query"]),/disagree/);
});
for(const activity of ["tx","rx","either","frame-settlement"])
  test("C5 names unsupported activity "+activity,()=>{
    const d=structuredClone(description);delete d.state;d.maintenance=[{...refresh,timing:{...idleTiming,activity}}];
    assert.throws(()=>admitAuthoredDescription(d,["query"]),new RegExp(activity));
  });
test("C5 removed maximum and unknown maintenance fields are not silently accepted",()=>{
  const d=structuredClone(description);delete d.state;d.maintenance=[{...refresh,timing:{...idleTiming,maximumIdleMs:300}}];
  assert.throws(()=>admitAuthoredDescription(d,["query"]),/maximumIdleMs/);
  delete d.maintenance[0].timing;d.maintenance[0].operation="missing";
  assert.throws(()=>admitAuthoredDescription(d,["query"]),/available/);
});
test("C3 coalesces destinations, not grants; manual refresh stays unscheduled",()=>{
  assert.equal(pollPlans(admitted()).length,1);
  assert.deepEqual(pollPlans(admitted())[0].cells,["a","b"]);
  const d=structuredClone(description);d.state.b.refresh="query";
  assert.deepEqual(pollPlans(admitAuthoredDescription(d,["query"]))[0].cells,["a"]);
});
for(const [name,change] of [
  ["different interval",d=>d.state.b.refresh={...refresh,intervalMs:6000}],
  ["different backoff",d=>d.state.b.refresh={...refresh,failureBackoffMs:40000}],
  ["different locks",d=>d.state.b.refresh={...refresh,suspendWhileLocksHeld:[]}],
  ["unknown mode",d=>d.state.a.refresh={...refresh,mode:"absent"}],
  ["unknown lock",d=>d.state.a.refresh={...refresh,suspendWhileLocksHeld:["absent"]}],
  ["argument",d=>d.operations[0].arguments.x={kind:"string"}],
  ["destructive",d=>d.operations[0].risk="destructive"],
  ["not repeatable",d=>d.operations[0].repeatability="not-repeatable"],
  ["no result",d=>d.operations[0].result={kind:"none"}],
  ["short backoff",d=>d.state.a.refresh={...refresh,failureBackoffMs:1}],
])test("C3 refuses "+name+" before execution",()=>{const d=structuredClone(description);change(d);assert.throws(()=>admitAuthoredDescription(d,["query"]));});
test("C3 host grant rejects default 1ms, nominal overcommit, absent grant and plan excess",()=>{
  const one={...pollPlans(admitted())[0],intervalMs:1};
  assert.throws(()=>grantPollPlans([one],policy),/minimum/);
  assert.throws(()=>grantPollPlans([one],{...policy,minimumIntervalMs:1}),/nominal/);
  assert.throws(()=>grantPollPlans(pollPlans(admitted()),null),/not granted/);
  assert.throws(()=>grantPollPlans(Array(5).fill(pollPlans(admitted())[0]),policy),/population/);
});
function harness(plans=pollPlans(admitted()),{defer=false,queue=false}={}) {
  const clock=new VirtualClock(),writes=[],observed=[],jobs=[];let held=false,service;
  const start=(p,debit)=>{
    if(held)throw Object.assign(new Error("held"),{code:"lock-skip"});
    if(!debit())throw Object.assign(new Error("exhausted"),{code:"quota-skip"});
    const id="poll-"+(writes.length+1);writes.push({id,at:clock.monotonicUs(),plan:p.id});return id;
  };
  service=new AuthoredPollService(plans,policy,{clock,start,sequence:()=>clock.nextSequence(),
    enqueue:async(s,f)=>{if(queue)jobs.push(f);else await f();},observe:v=>observed.push(v),failed:e=>{throw e;}});
  const finish=(outcome="completed",retire=true)=>{
    const id=writes.at(-1).id;service.terminal(id,{operationId:id,outcome,result:null,durationMs:0,
      ...(outcome!=="completed"?{error:{code:"device.bad-answer",message:"invalid response",retryability:"no"}}:{})});
    if(retire)service.retired(id);
  };
  return {clock,writes,observed,service,finish,jobs,set held(v){held=v;},async advance(ms){await clock.advance(ms*1000);},
    async flush(){while(jobs.length)await jobs.shift()();}};
}
test("C3 completion-relative due, failure backoff, skip without catchup",async()=>{
  const h=harness();h.service.resume("interactive",1);
  await h.advance(4999);assert.equal(h.writes.length,0);await h.advance(1);assert.equal(h.writes.length,1);
  h.finish("failed");await h.advance(29999);assert.equal(h.writes.length,1);
  h.held=true;await h.advance(1);assert.equal(h.writes.length,1);
  assert.equal(h.observed.at(-1).kind,"skipped");h.held=false;
  await h.advance(4999);assert.equal(h.writes.length,1);await h.advance(1);assert.equal(h.writes.length,2);
  h.finish();assert.ok(h.observed.some(o=>o.kind==="terminal"&&o.result.error?.code==="device.bad-answer"));h.service.close();
});
test("C3 terminal cancellation cannot free an unresolved predecessor",async()=>{
  const h=harness();h.service.resume("interactive",1);await h.advance(5000);h.finish("cancelled",false);
  await h.advance(60000);assert.equal(h.writes.length,1);
  assert.equal(h.service.snapshot.plans[0].activeOperation,h.writes[0].id);
  h.service.retired(h.writes[0].id);await h.advance(0);assert.equal(h.writes.length,2);h.service.close();
});
test("C3 planted nominal admission bypass exhausts unchanged runtime bucket",async()=>{
  // Deliberately bypass grantPollPlans ONLY in this control. Admission cannot
  // conceal removal of runtime debit/refill; actual starts must stop at four.
  const h=harness([{...pollPlans(admitted())[0],intervalMs:1,failureBackoffMs:1}]);h.service.resume("interactive",1);
  for(let i=0;i<4;i++){await h.advance(1);h.finish();}
  for(let i=0;i<20;i++)await h.advance(1);
  assert.equal(h.writes.length,4);assert.equal(h.service.snapshot.permitsRemaining,0);
  assert.equal(h.observed.at(-1).reason,"quota-skip");
  h.service.pause();h.service.resume("silent",2);h.service.resume("interactive",3);
  await h.advance(1);assert.equal(h.writes.length,4,"entry/mode/generation cannot mint credit");
  await h.advance(975);assert.equal(h.writes.length,5,"one elapsed refill permits one activation");h.finish();
  await h.advance(1);assert.equal(h.writes.length,5);h.service.close();
});
test("C3 distinct names spend the same four permits, duplicated cells spend once",async()=>{
  const base=pollPlans(admitted())[0], plans=Array.from({length:4},(_,i)=>({...base,id:"p"+i,operation:"q"+i,intervalMs:1}));
  const h=harness(plans);h.service.resume("interactive",1);await h.advance(1);assert.equal(h.writes.length,4);
  for(const {id} of h.writes){h.service.terminal(id,{operationId:id,outcome:"completed",result:null,durationMs:0});h.service.retired(id);}
  await h.advance(1);assert.equal(h.writes.length,4,"no bucket per plan/name");h.service.close();
  const coalesced=harness();coalesced.service.resume("interactive",1);await coalesced.advance(5000);
  assert.equal(coalesced.writes.length,1,"two referring cells cause ONE actual start");coalesced.service.close();
});
test("C3 late/stale queued tick cannot acquire a fresh generation",async()=>{
  const h=harness(undefined,{queue:true});h.service.resume("interactive",1);await h.advance(5000);
  h.service.pause();h.service.resume("interactive",2);await h.flush();assert.equal(h.writes.length,0);
  await h.advance(4999);await h.flush();assert.equal(h.writes.length,0);
  await h.advance(1);await h.flush();assert.equal(h.writes.length,1);h.service.close();
});
test("C3 idle credit caps at burst and background history is bounded and counted",async()=>{
  const h=harness([{...pollPlans(admitted())[0],intervalMs:1,failureBackoffMs:1}]);
  await h.advance(1000000);h.service.resume("interactive",1);await h.advance(1);h.finish();
  for(let i=0;i<3;i++){await h.advance(1);h.finish();}
  await h.advance(1);assert.equal(h.writes.length,4);
  assert.equal(h.service.snapshot.historyDropped,3);assert.equal(h.service.snapshot.retiredResults,4);h.service.close();
});
test("C5 foreground at 150 postpones 200 to 350, while periodic stays at 200",async()=>{
  for(const idle of [false,true]){
    const plans=idlePlans();if(!idle)delete plans[0].timing;
    const h=harness(plans);h.service.resume("interactive",1);await h.advance(150);
    h.service.foregroundStarted("manual",1);h.service.foregroundRetired("manual");
    await h.advance(50);assert.equal(h.writes.length,idle?0:1);
    if(idle){await h.advance(149);assert.equal(h.writes.length,0);await h.advance(1);assert.equal(h.writes[0].at,350000);}
    h.service.close();
  }
});
test("C5 two-second overlapping foreground stays busy until final native quiescence",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);
  h.service.foregroundStarted("a",1);await h.advance(100);h.service.foregroundStarted("b",1);
  h.service.foregroundRetired("a");await h.advance(1900);
  assert.equal(h.writes.length,0);assert.equal(h.service.snapshot.plans[0].status,"busy/suppressed");
  assert.equal(h.service.snapshot.plans[0].busyUs,2000000);
  h.service.foregroundRetired("b");await h.advance(199);assert.equal(h.writes.length,0);
  await h.advance(1);assert.equal(h.writes[0].at,2200000);h.service.close();
});
test("C5 skips preserve accumulated idle and deferred observations, not a hidden watchdog",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);h.held=true;
  for(let i=0;i<3;i++)await h.advance(200);
  const s=h.service.snapshot.plans[0];
  assert.equal(s.idleSinceUs,0);assert.equal(s.idleUs,600000);assert.equal(s.deferredUs,400000);
  assert.equal(h.observed.filter(e=>e.kind==="skipped").length,3);
  h.held=false;await h.advance(200);assert.equal(h.writes.length,1,"no budget-miss latch survived the cut");h.service.close();
});
test("C5 same-generation queued due loses to earlier foreground; already admitted attempt survives",async()=>{
  const h=harness(idlePlans(),{queue:true});h.service.resume("interactive",1);await h.advance(200);
  h.service.foregroundStarted("manual",1);h.service.foregroundRetired("manual");
  await h.flush();assert.equal(h.writes.length,0);await h.advance(200);await h.flush();assert.equal(h.writes.length,1);
  h.service.foregroundStarted("later",1);h.service.foregroundRetired("later");
  assert.equal(h.service.snapshot.plans[0].activeOperation,h.writes[0].id);h.service.close();
});
test("C5 stale foreground retirement cannot reset replacement generation",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);h.service.foregroundStarted("old",1);
  await h.advance(100);h.service.pause();h.service.resume("interactive",2);await h.advance(100);
  h.service.foregroundRetired("old");await h.advance(100);assert.equal(h.writes[0].at,300000);h.service.close();
});
test("C5 reacquiring foreground operation stays busy on its new capability",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);h.service.foregroundStarted("caller",1);
  h.service.pause();h.service.operationReacquired("caller",2);h.service.resume("interactive",2);
  await h.advance(2000);assert.equal(h.writes.length,0);assert.equal(h.service.snapshot.plans[0].status,"busy/suppressed");
  h.service.foregroundRetired("caller");await h.advance(200);assert.equal(h.writes[0].at,2200000);h.service.close();
});
test("C5 a scheduled operation's own reacquisition must retain its failure backoff",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);await h.advance(200);
  const id=h.writes[0].id;h.service.pause();h.service.operationReacquired(id,2);h.service.resume("interactive",2);
  h.finish("failed");await h.advance(999);assert.equal(h.writes.length,1);
  await h.advance(1);assert.equal(h.writes.length,2);h.service.close();
});
test("C5 a stale queued callback cannot lend its old sequence to a new due attempt",async()=>{
  const h=harness(idlePlans(),{queue:true});h.service.resume("interactive",1);await h.advance(200);
  const between=h.clock.nextSequence();h.service.pause();h.service.resume("interactive",2);
  await h.advance(200);await h.flush();
  assert.equal(h.writes.length,1);assert.ok(h.observed.find(e=>e.kind==="admitted").dueSequence>between);
  h.service.close();
});
test("C5 reset cannot shorten failure backoff or mint default burst credit",async()=>{
  const h=harness(idlePlans());h.service.resume("interactive",1);await h.advance(200);h.finish("failed");
  await h.advance(100);h.service.foregroundStarted("manual",1);h.service.foregroundRetired("manual");
  await h.advance(899);assert.equal(h.writes.length,1);await h.advance(1);assert.equal(h.writes.length,2);h.service.close();
  const stress=harness([{...idlePlans()[0],intervalMs:1,failureBackoffMs:1}]);stress.service.resume("interactive",1);
  for(let i=0;i<4;i++){stress.service.foregroundStarted("m"+i,1);stress.service.foregroundRetired("m"+i);await stress.advance(1);stress.finish();}
  for(let i=0;i<5;i++){stress.service.foregroundStarted("n"+i,1);stress.service.foregroundRetired("n"+i);await stress.advance(1);}
  assert.equal(stress.writes.length,4);assert.equal(stress.service.snapshot.permitsRemaining,0);stress.service.close();
});
