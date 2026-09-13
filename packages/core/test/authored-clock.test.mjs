import assert from 'node:assert/strict';
import test from 'node:test';
import {VirtualClock} from '../../../test-support/clock.ts';
import {AuthoredTimeBasis} from '../src/authored-clock.ts';
const parse=s=>{const [basisId,generation,sequence,elapsedUs]=s.split('|');return {basisId,generation:+generation,sequence:+sequence,elapsedUs:+elapsedUs};};
import {make,bounded} from './fixtures/authored-time-harness.mjs';
test('B7 actual Lua receives immutable session-relative time; shared values survive and wall time is never read',{timeout:5000},async t=>{
 const clock=new VirtualClock();clock.wallClockUnixMs=()=>{throw Error('wall clock accessed');};
 // Capture header legitimately uses human wall time, so disallow it AFTER setup.
 const wall=clock.wallClockUnixMs;clock.wallClockUnixMs=()=>0;
 t.after(()=>{clock.wallClockUnixMs=()=>0;});
 const h=await make(t,{clock,body:'local o=io.request({kind="clock-observe"});assert(not pcall(function()o.elapsedUs=99 end));local old=saved;saved=o;return fmt(old or o)'});
 clock.wallClockUnixMs=wall;
 const first=await h.run();assert.equal(first.outcome,'completed',JSON.stringify(first));const a=parse(first.result);assert.equal(a.elapsedUs,0);
 await clock.advance(240001000);const second=await h.run();assert.equal(second.result,first.result);
 const observations=h.seen.filter(e=>e.kind==='clock-observation'&&e.source==='requested').map(e=>e.observation);
 await h.wait(e=>e.kind==='clock-observation'&&e.observation.elapsedUs===240001000);
 assert.equal(observations[0].basisId,a.basisId);clock.wallClockUnixMs=()=>0;assert.equal((await h.stop()).completeness,'complete');
});
test('B7 clock reads require a declared grant and spend the ordinary work account',{timeout:5000},async t=>{
 const refused=await make(t,{noGrant:true});assert.equal((await refused.run()).error.code,'retained.clock-not-granted');
 const limited=await make(t,{body:'while true do io.request({kind="clock-observe"}) end',session:{maximumEffectWork:20000}});
 const result=await limited.run();assert.equal(result.error.code,'retained.work-exhausted');
 assert.ok(limited.seen.filter(e=>e.kind==='clock-observation').length>1);assert.equal(limited.clock.pending.length,0);
});
test('B7 cleanup receives original terminal time, not delayed dispatch time',{timeout:5000},async t=>{
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let starts=0;
 const h=await make(t,{handler:'return',body:'runs=runs+1;if runs>1 then return runs==2 and "peer" or saved end;local timer=io.request({kind="timer-arm",milliseconds=240001});io.request({kind="wait-any",maximum=0,timers=a({timer})})',
  cleanup:'if args.outcome=="cancelled" then local now=io.request({kind="clock-observe"});saved=string.format("%d|%d",args.terminal.elapsedUs,now.elapsedUs) end',
  beforeStart:async binding=>{if(binding==='run'&&++starts===2){entered.resolve();await gate.promise;}},release:()=>gate.resolve()});
  const op=await h.start();await h.wait(e=>e.kind==='effect'&&e.owner===op.operationId&&e.effect==='wait-any');
 const peer=await h.start();await bounded(entered.promise,'peer holds scheduler');
 await h.clock.advance(1000);await h.client.cancelOperation(op.operationId);
 await h.clock.advance(2000);gate.resolve();
 const result=await bounded(h.client.awaitOperation(op.operationId),'cancelled cleanup');assert.equal(result.outcome,'cancelled',JSON.stringify(result));
 assert.equal((await h.client.awaitOperation(peer.operationId)).outcome,'completed');
 assert.equal((await h.run()).result,'1000|3000');
});
test('B7 input observation survives delayed dispatch and all D2 subdivisions',{timeout:5000},async t=>{
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();let first=true;
 const h=await make(t,{handler:'assert(not pcall(function()args.observation.elapsedUs=99 end));io.request({kind="write",value=string.format("%d|%d|%d",args.observation.elapsedUs,args.observation.sequence,#args.input)})',
  beforeStart:async binding=>{if(binding==='input'&&first){first=false;entered.resolve();await gate.promise;}},release:()=>gate.resolve()});
 await h.clock.advance(1000);h.inject(new Uint8Array(600));await bounded(entered.promise,'input held');
 await h.clock.advance(2000);gate.resolve();await h.wait(e=>e.kind==='native-write'&&e.text.endsWith('|88'));
 const rows=h.seen.filter(e=>e.kind==='native-write').map(e=>e.text.split('|').map(Number));
 assert.deepEqual(rows.map(r=>r[0]),[1000,1000,1000]);assert.equal(new Set(rows.map(r=>r[1])).size,1);
 assert.deepEqual(rows.map(r=>r[2]),[256,256,88]);assert.equal((await h.stop()).completeness,'complete');
});
test('B7 cancellation suppresses a delayed completion without reviving its continuation',{timeout:5000},async t=>{
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();
 const h=await make(t,{body:'io.request({kind="clock-observe"});io.request({kind="write",value="FORBIDDEN"});return "bad"',
  afterObservation:async()=>{entered.resolve();await gate.promise;},release:()=>gate.resolve()});
 const op=await h.start();await bounded(entered.promise,'observation held');await h.client.cancelOperation(op.operationId);gate.resolve();
 const result=await bounded(h.client.awaitOperation(op.operationId),'cancelled observation');assert.equal(result.outcome,'cancelled');
 await h.wait(e=>e.kind==='retired'&&e.owner===op.operationId);assert.deepEqual(h.seen.filter(e=>e.kind==='native-write'),[]);
});
test('B7 basis distinguishes sessions; generation changes do not reset origin; invalid clocks fail closed',()=>{
 let now=9000000;const clock={monotonicUs:()=>now};const a=new AuthoredTimeBasis(clock),b=new AuthoredTimeBasis(clock);
 assert.notEqual(a.state.basisId,b.state.basisId);now+=2000;
 assert.equal(a.observe(1,1).elapsedUs,2000);assert.equal(a.observe(2,2).elapsedUs,2000);
 const equal=a.observe(3,2);assert.equal(equal.elapsedUs,2000);assert.equal(equal.sequence,3);
 assert.equal(a.observe(3,2,9001000).elapsedUs,1000,'older input is not a regressing current observation');
 now--;assert.throws(()=>a.observe(4,2),/regressed/);now=NaN;assert.throws(()=>a.observe(4,2),/regressed/);
});
test('B7 origin shares the integer-microsecond lattice of native input stamps',()=>{
 let now=9000000.75;const basis=new AuthoredTimeBasis({monotonicUs:()=>now});
 assert.equal(basis.observe(1,1).elapsedUs,0);
 assert.equal(basis.observe(2,1,Math.floor(now)).elapsedUs,0,'same-tick native input must not predate its basis');
 now+=1;assert.equal(basis.observe(3,1).elapsedUs,1);
 assert.equal(basis.observe(4,1,Math.floor(now)).elapsedUs,1);
 now-=0.1;assert.throws(()=>basis.observe(5,1),/regressed/,'sub-microsecond source regression is not hidden by flooring');
});
test('B7 replay resumes the actual Lua with the retained observation, without a new clock read',{timeout:5000},async t=>{
 const h=await make(t);await h.clock.advance(1234);const live=await h.run();assert.equal(live.outcome,'completed');
 const record=await h.wait(e=>e.kind==='clock-observation'&&e.source==='requested');
 await h.stop();const replay=await h.module.openExecution();t.after(()=>replay.close());
 await replay.register('replay');const request=await replay.startOperation('replay','run',{},{});
 assert.equal(request.value.kind,'clock-observe');request.release();
 const result=await replay.dispatchObservation('replay',JSON.parse(JSON.stringify(record.observation)));
 assert.deepEqual(result.value,{kind:'result',value:live.result});result.release();await replay.retire('replay');
});
