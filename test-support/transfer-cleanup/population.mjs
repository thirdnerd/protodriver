import {runCases as checkpointCases} from '../checkpoint-service/population.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const released=e=>e.kind==='source-released';
export async function runCases(open,{resume=true,names=['abort','refused','no-input','bad-cookie','bad-generation','ordinary']}={}){
 const rows=resume?await checkpointCases(async name=>{
  const c=await open(name),start=c.client.startOperation.bind(c.client),resume=c.client.resumeTransfer.bind(c.client),stop=c.client.stopCapture.bind(c.client);
  const args=r=>({...r,arguments:{...r.arguments,scenario:{kind:'value',value:'keep'}}});
  c.client.startOperation=r=>start(args(r));c.client.resumeTransfer=r=>resume(args(r));
  c.client.stopCapture=async(...args)=>{await c.native.wait(released);return stop(...args);};return c;
 }):[];
 for(const name of names){
  const c=await open(name),{client,native}=c;
  try{
   await client.attach('F47');await client.connect({mode:'challenge'});const destination=await c.capture(),capture=await client.startCapture(destination.id,{});
   const data=Uint8Array.of(0,128,255,65);let at=0;
   const id=await c.registerResource({origin:'memory',byteLength:4,async seek(offset){at=offset;},async read(into){const bytes=data.slice(at,at+into.length);into.set(bytes);at+=bytes.length;return {bytesRead:bytes.length,eof:at===4};},async close(){}});
   const op=await client.startOperation({operation:'write',arguments:{image:{kind:'resource',id},scenario:{kind:'value',value:name}}});
   if(name!=='ordinary'){
    const e=await native.wait(e=>e.kind==='checkpoint'&&e.checkpoint.confirmedRanges[0]?.length===2);
    check(e.checkpoint.authoredTransfer.admittedEnd===4,'committed and accepted collapsed');await client.cancelOperation(op.operationId);
   }
   const result=await client.awaitOperation(op.operationId),success=name==='abort';
   if(name==='ordinary'){check(result.outcome==='failed'&&result.error.code==='authored.cleanup.authority','ordinary authority acquired retirement: '+JSON.stringify(result));}
   else{
    check(result.outcome==='cancelled','cleanup changed cancellation');
    check(result.error.details.cleanup.outcome===(success?'completed':'failed'),'cleanup outcome differs: '+JSON.stringify(result));
    if(success){await native.wait(e=>e.kind==='checkpoint-removed');check(result.transferReceipt.verified===false&&result.transferReceipt.retirement.independentRollback===false,'retirement relabelled as verification');}
    else{const e=await native.wait(e=>e.kind==='checkpoint-retained');check(e.checkpoint.confirmedRanges[0].length===2,'failed abort lost committed checkpoint');}
    const expected={refused:'lua-vm.invocation.program-failure','no-input':'authored.transfer.report-unobserved','bad-cookie':'transfer.resume.identity-mismatch','bad-generation':'transfer.resume.identity-mismatch'}[name];
    if(expected)check(result.error.details.cleanup.error.code===expected,'wrong retirement refusal: '+JSON.stringify(result));
   }
   if(success||name==='ordinary')await native.wait(released);
   // Failed cleanup ends the connection and closes recording itself. Wait for
   // destination commit rather than racing a second stop-capture RPC.
   if(success||name==='ordinary')await client.stopCapture(capture);
   const footer=(await native.wait(e=>e.kind==='record'&&e.record.kind==='footer')).record;
   if(success||name==='ordinary')check(footer.completeness==='complete','successful cleanup lost required capture');
   const records=await destination.records();
   const writes=records.filter(r=>r.kind==='tx-requested').map(r=>[...atob(r.data)].map(c=>c.charCodeAt(0)));
   check(JSON.stringify(writes)===JSON.stringify(name==='ordinary'?[]:[[66,69,71,73,78],[0,128,255,65],[65,66,79,82,84]]),'wrong protocol writes: '+JSON.stringify(writes));
   if(name!=='ordinary'){
    check(result.error.details.cleanup.work<=100000&&result.error.details.cleanup.consumed<=10000,'cleanup partition exceeded');
   }
   rows.push({name,outcome:result.outcome,cleanup:result.error.details?.cleanup?.outcome??null,code:result.error.details?.cleanup?.error?.code??result.error.code,writes,retired:success,capture:footer.completeness});
  }finally{await c.close();}
 }
 return rows;
}
