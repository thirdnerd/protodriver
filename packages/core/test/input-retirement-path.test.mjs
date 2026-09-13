import assert from 'node:assert/strict';
import test from 'node:test';
import {make} from './fixtures/handler-delivery-harness.mjs';
const query=`local o=io.request({kind="clock-observe"});local r=io.request({kind="input-retirement",basisId=o.basisId,generation=o.generation,fromSequence=1,beforeSequence=o.sequence});assert(not pcall(function()r.retired=false end));return tostring(r.retired)`;
const opts={retirement:true,consumedRanges:true,entry:true,entryConsumed:true,entryChunks:['R'],
 entryCode:'assert(io.request({kind="wait-fill",count=1,timers=a({})})=="receive:R");io.request({kind="input-consume",length=1});assert(io.request({kind="entry-handoff",parser="empty",timers="none"})=="accepted")',peer:query};
test('B9 actual Lua receives the immutable empty-interval classification',{timeout:5000},async t=>{
 const h=await make(t,opts);const result=await h.peer();assert.equal(result.result,'true');
});
test('B9 actual consumed bytes still block while classification is suspended; terminal dispatch releases them',{timeout:5000},async t=>{
 const h=await make(t,{...opts,body:'io.request({kind="input-consume",length=#args.input});io.request({kind="message-wait",mailboxes=a({"reply"}),timers=a({})})',
 peer:query.replace('return tostring(r.retired)','if not r.retired then io.request({kind="message-send",mailbox="reply",value="done"}) end;return tostring(r.retired)')});
 h.inject([65]);await h.wait(e=>e.kind==='turn'&&e.effect==='input-consume');
 assert.equal((await h.peer()).result,'false');
 await h.wait(e=>e.kind==='retired');
 assert.equal((await h.peer()).result,'true');
});
test('B9 returned handler does not retire its unconsumed prefix',{timeout:5000},async t=>{
 const h=await make(t,{...opts,body:''});h.inject([65]);await h.wait(e=>e.kind==='retired');
 assert.equal((await h.peer()).result,'false');
});
test('B9 a group with missing custody support cannot enter',{timeout:5000},async t=>{
 await assert.rejects(make(t,{...opts,group:true,noCustody:true}),/original-stamp|retirement|connect/i);
});
