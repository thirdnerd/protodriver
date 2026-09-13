import {registerHooks} from 'node:module';
import {parentPort,workerData} from 'node:worker_threads';
const sources=[],consumptions=[],deferrals=[];
const disposed=Promise.withResolvers();
globalThis[Symbol.for('input-tail-observer')]=(account,entry,sequence,before)=>{
 sources.push({account,entry,sequence,initial:account.work,observationDebit:entry?account.work-before:null});
 const release=account.disposed;
 account.disposed=()=>{release();disposed.resolve();};
};
globalThis[Symbol.for('input-tail-consumption')]=()=>consumptions.push(sources.map(s=>({remaining:s.account.remaining,closed:s.account.closed})));
globalThis[Symbol.for('input-tail-deferral')]=row=>deferrals.push(row);
registerHooks({load(url,context,next){
 const loaded=next(url,context);if(!url.endsWith('/core/src/retained-session.ts'))return loaded;
 let source=String(loaded.source);
 const anchor='this.#inputWork.set(sequence, account); this.#nativeInputWork.set(sequence, account);';
 if(source.split(anchor).length!==2)throw Error('tail observer anchor drift');
 const account='const account = new InputWorkAccount';
 if(source.split(account).length!==2)throw Error('tail funding observer drift');
 source=source.replace(account,'const observationBefore=entry?.work;'+account);
 source=source.replace(anchor,anchor+'globalThis[Symbol.for("input-tail-observer")](account,entry,sequence,observationBefore);');
 const consumed='this.#stamp();\n    effect.outcome = "consumed";';
 if(source.split(consumed).length!==2)throw Error('tail consumption observer drift');
 source=source.replace(consumed,'globalThis[Symbol.for("input-tail-consumption")]();'+consumed);
 // Anchor on the surrounding statement rather than the call under mutation.
 const start='// traversal of prior payloads needs an invented work owner.';
 const end='const range = { bytes: chunk.bytes, sequence, recordedSequence, ...(storage ? { storage } : {}),';
 for(const a of [start,end])if(source.split(a).length!==2)throw Error('tail deferral stage drift');
 source=source.replace(start,start+'\n const deferredBefore=inputWork?.work;');
 source=source.replace(end,'globalThis[Symbol.for("input-tail-deferral")]({before:deferredBefore,after:inputWork?.work});'+end);
 return{...loaded,source};
}});
const {make,bounded}=await import('./handler-delivery-harness.mjs');
const {NativeHelperData}=await import('../../src/native-helper.ts');
const empty=new NativeHelperData();let low=0,high=empty.maximum;
while(low<high){const n=Math.ceil((low+high)/2);try{empty.reserve(n).release();low=n;}catch{high=n-1;}}
const fullCapacity=low;
const cleanup=[];
try{
 if(workerData==='promise'){
  const data=new NativeHelperData(),h=await make({after(f){cleanup.push(f);}},{receiveGate:true,consumedRanges:true,nativeData:data});
  h.inject([65]);await h.wait(e=>e.kind==='native-received');
  await h.client.disconnect();
  const before={closed:sources[0].account.closed,work:sources[0].account.work};
  let quotaHeld=false;try{data.reserve(fullCapacity).release();}catch{quotaHeld=true;}
  h.gate.resolve();await bounded(disposed.promise,'old native promise disposal');
  data.reserve(fullCapacity).release();
  parentPort.postMessage({before,quotaHeld,after:{closed:sources[0].account.closed,work:sources[0].account.work},writes:h.writes()});
 }else{
  const h=await make({after(f){cleanup.push(f);}},{entry:true,entryConsumed:true,consumedRanges:true,dispatchGate:true,
   entryChunks:['RA','BCx'],
   entryCode:'assert(io.request({kind="read",maximum=1})=="R");io.request({kind="input-consume",length=1});received=io.request({kind="wait-fill",count=2,timers=a({})}):sub(9);assert(received=="AB");assert(io.request({kind="entry-handoff",parser="retained-prefixes",timers="none"})=="accepted")',
   body:'received=received..args.input;io.request({kind="input-consume",length=#received});io.request({kind="write",value=received})'});
  await h.wait(e=>e.kind==='gated');
  const prefix=sources.map(s=>({sequence:s.sequence,remaining:s.account.remaining,closed:s.account.closed,work:s.account.work,parent:s.entry?.work,initial:s.initial,observationDebit:s.observationDebit}));
  h.gate.resolve();await h.wait(e=>e.kind==='write');
  const entry=h.seen.find(e=>e.kind==='start'&&e.binding==='enter');
  await h.wait(e=>e.kind==='retired'&&e.id===entry.id);
  const capture=await h.capture();
  parentPort.postMessage({prefix,consumptions,deferrals,final:sources.map(s=>({remaining:s.account.remaining,closed:s.account.closed,work:s.account.work,parent:s.entry?.work})),
   writes:h.writes(),completeness:capture.footer.completeness});
 }
}finally{for(const f of cleanup.reverse())await f();}
