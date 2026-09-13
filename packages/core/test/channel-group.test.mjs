import assert from 'node:assert/strict';
import test from 'node:test';
import {ChannelGroup} from '../src/channel-group.ts';
const roles={request:'requests',response:'responses',event:'events'};
function fixture({fail=-1,releaseFails=-1,heldAcquire}={}){
 const held=new Set(),acquired=[],released=[];let live=true;
 const channels=['requests','responses','events'].map((id,i)=>({id,direction:i?'in':'out',async acquire(){
  if(i===fail)throw new Error('acquisition failed');await heldAcquire?.(i);held.add(id);acquired.push(id);
  return {async release(){released.push(id);if(i===releaseFails)throw new Error('release failed');held.delete(id);}};
 }}));
 return {connection:{channels},held,acquired,released,live:()=>{if(!live)throw new Error('revoked');},revoke(){live=false;}};
}
test('all roles are validated before any acquisition',async()=>{
 for(const selected of [{...roles,event:'missing'},{...roles,response:'requests'}]){
  const h=fixture();await assert.rejects(ChannelGroup.acquire(h.connection,selected,h.live),e=>/^retained.channel-/.test(e.error.code));assert.deepEqual(h.acquired,[]);
 }
});
test('aliases acquire one physical lease and expose one receive iterator',async()=>{
 const h=fixture();h.connection.channels[0].direction='duplex';
 const g=await ChannelGroup.acquire(h.connection,{request:'requests',response:'requests',event:'requests'},h.live);
 assert.deepEqual(h.acquired,['requests']);assert.equal(g.inputs.length,1);await g.release();assert.equal(h.held.size,0);
});
for(const fail of [0,1,2])test(`partial acquisition ${fail} leaves no earlier lease held`,async()=>{
 const h=fixture({fail});await assert.rejects(ChannelGroup.acquire(h.connection,roles,h.live),/acquisition failed/);
 assert.equal(h.held.size,0);assert.deepEqual(h.released,h.acquired.toReversed());
});
test('rollback continues after a throwing release and reports the unreleased member',async()=>{
 const h=fixture({fail:2,releaseFails:1});await assert.rejects(ChannelGroup.acquire(h.connection,roles,h.live),e=>e.error?.code==='retained.channel-rollback-failed');
 assert.deepEqual([...h.held],['responses']);assert.deepEqual(h.released,['responses','requests']);
});
test('revocation during an acquisition releases its late lease, never publishes a partial group',{timeout:2000},async t=>{
 const entered=Promise.withResolvers(),gate=Promise.withResolvers();t.after(()=>gate.resolve());
 const h=fixture({heldAcquire:async i=>{if(i===2){entered.resolve();await gate.promise;}}});
 const result=assert.rejects(ChannelGroup.acquire(h.connection,roles,h.live),/revoked/);await entered.promise;h.revoke();
 assert.deepEqual([...h.held],['requests','responses']);gate.resolve();await result;assert.equal(h.held.size,0);
});
