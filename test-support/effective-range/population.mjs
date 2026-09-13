import {octet} from './fixture.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
export async function runCases(open,names=['prefix','offset','invalid','one-grant','two-grants','recovery','cancel']){
 const rows=[];
 for(const name of names){const c=await open(name),{client,native}=c,gate=Promise.withResolvers();let sub,held=false;
  try{
   await client.attach('B5 '+name);await client.connect({mode:'application'});const events=[];sub=client.subscribe(e=>events.push(e));await client.getSnapshot();
   const d=await c.capture(),cap=await client.startCapture(d.id,{sidecarThresholdBytes:1048576});const reads=[],results=[];
   async function resource(size,change=()=>false){let at=0;return c.registerResource({origin:'memory',byteLength:size,async seek(n){at=n;},async close(){},async read(into){
    if(name==='cancel'&&!held){held=true;native.add({kind:'held-range-read'});await gate.promise;}
    const n=Math.min(into.length,size-at);for(let i=0;i<n;i++)into[i]=octet(at+i)^(change(at+i)?1:0);reads.push({offset:at,length:n});at+=n;return{bytesRead:n,eof:at===size};}});}
   const start=name==='offset'||name==='cancel'?11:name==='recovery'?10:0,length=name==='one-grant'?65536:name==='two-grants'?65537:name==='recovery'?512:name==='invalid'?9:4;
   const physical=['prefix','invalid'].includes(name)?8:262144;
   const operation=name==='recovery'?'cut':name.endsWith('grant')||name==='two-grants'?'budget':'fresh';
   const args=async(size=physical,change,offset=start)=>({image:{kind:'resource',id:await resource(size,change)},offset:{kind:'value',value:offset},length:{kind:'value',value:length}});
   let releases=0;
   async function finish(h){const r=await client.awaitOperation(h.operationId);results.push(r);await client.acknowledgeOperation(h.operationId);
    releases++;await native.wait(e=>e.kind==='source-released'&&native.seen.filter(x=>x.kind==='source-released').length>=releases);return r;}
   const handle=await client.startOperation({operation,arguments:await args()});
   if(name==='cancel'){
    await native.wait(e=>e.kind==='held-range-read');await client.cancelOperation(handle.operationId);
    // Native completion is deliberately after the cancellation verdict, not a
    // race between a cross-worker write notification and another Lua turn.
    gate.resolve();
   }
   const first=await finish(handle);
   const expected=name==='invalid'?'authored.transfer.source-range':name==='one-grant'?'lua-vm.resource.fuel-exhausted':name==='recovery'?'authored.transfer.incomplete':null;
   check(name==='cancel'?first.outcome==='cancelled':expected?first.error?.code===expected:first.outcome==='completed','unexpected first outcome '+JSON.stringify(first));
   if(name==='recovery'){
    const id=first.transferReceipt.checkpointId;
    const offered=await client.inspectTransferCheckpoint(id);check(offered.source.subject.offset===start&&offered.source.byteLength===length,'inspection lost range');
    const before=native.seen.filter(e=>e.kind==='write').length;await client.getSnapshot();await client.getSnapshot();
    check(native.seen.filter(e=>e.kind==='write').length===before,'offer performed I/O');
    const bad=await finish(await client.resumeTransfer({checkpointId:id,operation,arguments:await args(physical,n=>n===start+length-1)}));
    check(bad.error?.code==='transfer.resume.source-mismatch','changed in-range tail accepted');
    check(native.seen.filter(e=>e.kind==='write').length===before,'wrong-source recovery reached protocol');
    const moved=await finish(await client.resumeTransfer({checkpointId:id,operation,arguments:await args(physical,undefined,start+1)}));
    check(moved.error?.code==='transfer.resume.source-mismatch','changed range accepted');
    check(native.seen.filter(e=>e.kind==='write').length===before,'changed-range recovery reached protocol');
    const resumed=await finish(await client.resumeTransfer({checkpointId:id,operation,arguments:await args(physical-1,n=>n<start||n>=start+length)}));
    check(resumed.outcome==='completed','outside bytes/descriptor change invalidated range '+JSON.stringify(resumed));
   }
   if(name!=='one-grant'){
    await client.stopCapture(cap);
   }
   await native.wait(e=>e.kind==='record'&&e.record.kind==='footer');const records=await d.records();
   const footer=native.seen.find(e=>e.kind==='record'&&e.record.kind==='footer').record;
   if(name!=='one-grant')check(footer.completeness==='complete','capture incomplete');
   else check(footer.completeness==='complete'||(footer.completeness==='incomplete'&&footer.replayability==='diagnostic-only'&&records.some(r=>r.kind==='gap')),'unsafe shutdown status lost');
   if(name==='invalid'){check(reads.length===0&&!native.seen.some(e=>e.kind==='write'),'invalid range read or wrote');}
   else{
    if(name!=='recovery')check(reads.every(r=>r.offset>=start&&r.offset+r.length<=start+length),'read outside selected range');
    if(['prefix','offset','two-grants'].includes(name))check(reads.reduce((n,r)=>n+r.length,0)===2*length,'normal range did not use two passes');
   }
   if(name==='cancel'){
    check(reads.length===1&&reads[0].offset===11&&reads[0].length===4,'late read lost selected range');
    check(!native.seen.some(e=>e.kind==='write'),'revoked prehash entered protocol');
   }
   const last=results.at(-1);if(last.outcome==='completed'){
    const receipt=last.transferReceipt;check(receipt.source.subject.kind==='effective-range'&&receipt.source.subject.offset===start&&receipt.source.subject.length===length,'receipt mislabels source digest');
    check(receipt.source.length===length&&receipt.target.authority==='device-reported'&&receipt.independentReadBack===false,'digest authority lost');
    check(events.some(e=>e.kind==='transfer-progress'&&e.sourceSubject?.offset===start&&e.sourceSubject?.length===length),'progress lost range subject');
   }
   rows.push({name,outcomes:results.map(r=>({outcome:r.outcome,code:r.error?.code??null})),readBytes:reads.reduce((n,r)=>n+r.length,0),
    writes:native.seen.filter(e=>e.kind==='write').map(e=>e.bytes),receipt:last.outcome==='completed'?last.transferReceipt:null,capture:footer.completeness});
  }finally{gate.resolve();sub?.dispose();await c.close();}
 }return rows;
}
