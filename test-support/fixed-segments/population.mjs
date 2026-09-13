const check=(v,m)=>{if(!v)throw Error(m);};
export async function runCases(open,names=['coarse','fine','discard','runaway','cancel']){
 const rows=[];
 for(const name of names){const c=await open(name),{client,native}=c;let sub;
  try{
   await client.attach('D7 '+name);await client.connect({mode:'application'});const events=[];sub=client.subscribe(e=>events.push(e));await client.getSnapshot();
   const d=await c.capture(),cap=await client.startCapture(d.id,{sidecarThresholdBytes:1048576});let at=0,reads=0;
   const id=await c.registerResource({origin:'memory',byteLength:65537,async seek(n){at=n;},async read(into){const n=Math.min(into.length,65537-at);into.fill(90,0,n);at+=n;reads+=n;return {bytesRead:n,eof:at===65537};},async close(){}});
   const op=await client.startOperation({operation:name,arguments:{image:{kind:'resource',id}}});
   if(name==='cancel'){
    await native.wait(e=>e.kind==='cancel-boundary');
    await client.getSnapshot();
    await client.cancelOperation(op.operationId);
   }
   const result=await client.awaitOperation(op.operationId);
   await client.acknowledgeOperation(op.operationId);
   // A sticky VM failure finalizes capture before its separately reserved
   // source-release call. Keep the external broker alive through that call.
   await c.sourceReleased;
   if(name==='coarse'||name==='fine')check(result.outcome==='completed','continuous segmented transfer failed: '+JSON.stringify(result));
   if(name!=='discard'&&name!=='runaway'){
    await client.stopCapture(cap);
   } // Sticky VM failure closes capture itself; release can settle after it.
   await native.wait(e=>e.kind==='record'&&e.record.kind==='footer');
   const records=await d.records();
   // loadCapture returns its validated footer separately; the observation
   // stream also retains it, unlike LoadedCapture.records.
   const writes=records.filter(r=>r.kind==='tx-requested'),footer=native.seen.find(e=>e.kind==='record'&&e.record.kind==='footer')?.record;
   if(name==='discard'||name==='runaway'){
    check(footer&&(footer.completeness==='complete'||(footer.completeness==='incomplete'&&footer.replayability==='diagnostic-only'
     &&records.some(r=>r.kind==='gap'))),'unsafe shutdown lost truthful recording status');
   }else check(footer?.completeness==='complete','capture incomplete: '+JSON.stringify(footer));
   check(events.filter(e=>e.kind==='operation-end').length===1,'segments published extra terminal results');
   if(name==='coarse'||name==='fine'){
    check(result.outcome==='completed','continuous segmented transfer failed: '+JSON.stringify(result));
    check(reads===131074,'continuous segmented source reread');
    check(result.transferReceipt.independentReadBack===false&&result.transferReceipt.source.authority==='host-computed-device-confirmed'
      &&result.transferReceipt.target.authority==='device-reported','receipt authority flattened');
   }else if(name==='cancel'){
    check(result.outcome==='cancelled','cancellation identity lost');
    check(native.seen.filter(e=>e.kind==='write'&&e.tag==='ABORT').length===1,'ABORT must execute once');
    check(!native.seen.some(e=>e.kind==='write'&&e.tag==='FINAL'),'cancelled transfer finalized');
   }else{
    check(result.outcome==='failed'&&result.error?.code==='lua-vm.resource.fuel-exhausted','ordinary exhaustion did not stay sticky: '+JSON.stringify(result));
    check(writes.length===1,'runaway/discard reached DATA');
   }
   rows.push({name,outcome:result.outcome,code:result.error?.code??null,reads,writes:writes.length,capture:footer.completeness});
  }finally{sub?.dispose();await c.close();}
 }return rows;
}
