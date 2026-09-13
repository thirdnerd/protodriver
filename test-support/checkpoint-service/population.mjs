const check=(v,m)=>{if(!v)throw new Error(m);};
async function argument(context,wrong=false){
  const data=Uint8Array.of(wrong?1:0,128,255,65);let at=0;
  const id=await context.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},
    async read(into){const bytes=data.slice(at,at+into.length);into.set(bytes);at+=bytes.length;return {bytesRead:bytes.length,eof:at===4};},async close(){}});
  return {image:{kind:'resource',id}};
}
export async function runCases(open){
  const rows=[];let checkpointId;
  for(const name of ['fresh','wrong-source','not-quiet','resume']){
    const c=await open(name),{client,native}=c;
    try{
      await client.attach('F44 '+name);await client.connect({mode:'challenge'});
      const destination=await c.capture(),capture=await client.startCapture(destination.id,{});
      const args=await argument(c,name==='wrong-source');let handle,result;
      if(name==='fresh'){
        handle=await client.startOperation({operation:'write',arguments:args});
        const observed=await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2);
        checkpointId=observed.checkpoint.id;
        check(observed.checkpoint.authoredTransfer.admittedEnd===4,'accepted horizon not distinct from committed prefix');
        await client.cancelOperation(handle.operationId);result=await client.awaitOperation(handle.operationId);
        check(result.outcome==='cancelled','fresh arm not cancelled');
        await native.wait(e=>e.kind==='claim-released');
      }else{
        const assurance=await client.inspectTransferCheckpoint(checkpointId);
        check(assurance.assurance==='verified','checkpoint identity assurance missing');
        // Two causally completed RPC observations while offered, no timer sleep.
        await client.getSnapshot();await client.getSnapshot();
        native.command('barrier');
        const barrier=await native.wait(e=>e.kind==='offer-barrier');
        check(barrier.writes.length===0,'resume offer wrote before operator consent');
        handle=await client.resumeTransfer({checkpointId,operation:'write',arguments:args});
        result=await client.awaitOperation(handle.operationId);
        if(name==='wrong-source'){
          check(result.outcome==='failed'&&result.error?.code==='transfer.resume.source-mismatch','changed source admitted: '+JSON.stringify(result));
          check(!native.seen.some(e=>e.kind==='write'),'source mismatch reached protocol');await native.wait(e=>e.kind==='claim-released');
        }else if(name==='not-quiet'){
          check(result.outcome==='failed'&&result.error?.code==='transfer.resume.preparation-incomplete','volatile suffix admitted: '+JSON.stringify(result));
          await native.wait(e=>e.kind==='claim-released');
          check(native.seen.filter(e=>e.kind==='write').length===1,'not-quiescent resume sent DATA');
        }else{
          check(result.outcome==='completed','quiescent resume failed: '+JSON.stringify(result));
          check(result.transferReceipt.source.authority==='host-computed-device-confirmed'&&result.transferReceipt.target.authority==='device-reported'
            &&result.transferReceipt.independentReadBack===false,'verification authority flattened');
        }
      }
      await client.acknowledgeOperation(handle.operationId);
      const summary=await client.stopCapture(capture),records=await destination.records();
      check(summary.completeness==='complete','capture incomplete');
      const writes=records.filter(r=>r.kind==='tx-requested').map(r=>[...atob(r.data)].map(c=>c.charCodeAt(0)));
      const expected=name==='fresh'?[[66,69,71,73,78],[0,128,255,65]]:name==='wrong-source'?[]:name==='not-quiet'?[[81,85,69,82,89]]:[[81,85,69,82,89],[255,65],[70,73,78,65,76]];
      check(JSON.stringify(writes)===JSON.stringify(expected),'recorded DATA or operator ordering differs: '+JSON.stringify(writes));
      rows.push({name,outcome:result.outcome,code:result.error?.code??null,writes,receipt:name==='resume'?result.transferReceipt:null,complete:summary.completeness});
    }finally{await c.close();}
  }return rows;
}
