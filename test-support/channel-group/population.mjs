import {runCases as checkpointCases} from '../checkpoint-service/population.mjs';
const check=(ok,message)=>{if(!ok)throw new Error(message);};
export async function runCases(open){
 const rows=await checkpointCases(async name=>{const c=await open(name),stop=c.client.stopCapture.bind(c.client);
  c.client.stopCapture=async(...args)=>{await c.client.getSnapshot();return stop(...args);};return c;});
 for(const name of ['roles','reacquire','stale','late','fill']){
  const c=await open(name),{client,native}=c;
  try{
   await client.attach('F46');await client.connect({mode:'challenge'});const destination=await c.capture(),capture=await client.startCapture(destination.id,{});
   const op=await client.startOperation({operation:name,arguments:{}}),result=await client.awaitOperation(op.operationId);
   if(name==='stale'){check(result.outcome==='failed'&&result.error.code==='retained.capability-not-granted','stale group lease accepted: '+JSON.stringify(result));check(!native.seen.some(e=>e.kind==='write'),'old lease wrote');}
   else if(name==='fill')check(result.outcome==='failed'&&result.error.code==='retained.channel-fill-unavailable','distinct streams silently concatenated: '+JSON.stringify(result));
   else{check(result.outcome==='completed','group operation failed: '+JSON.stringify(result));check(result.result===(['roles','late'].includes(name)?'responses:R|events:E':'fresh'),'channel bytes or order lost: '+JSON.stringify(result));}
   if(name==='late')await native.wait(e=>e.kind==='old-native-completion');
   const summary=await client.stopCapture(capture),records=await destination.records();check(summary.completeness==='complete','group capture incomplete');
   const rx=records.filter(r=>r.kind==='rx-delivered').map(r=>r.ch),tx=records.filter(r=>r.kind==='tx-requested').map(r=>r.ch);
   if(['roles','late'].includes(name)){check(rx.includes('responses')&&rx.includes('events'),'capture lost physical input channel');check(tx.length===1&&tx[0]==='requests','capture lost request channel');check(rx.length===2,'stale native completion reached capture');}
   if(['reacquire','stale','late'].includes(name)){
    check(native.seen.filter(e=>e.kind==='lease-acquired').length===6,'reacquire did not obtain three fresh leases');
    check(native.seen.filter(e=>e.kind==='lease-released'&&e.ordinal===1).length===3,'old group not released');
   }
   rows.push({name,outcome:result.outcome,result:result.result,error:result.error?.code??null,complete:summary.completeness});
  }finally{await c.close();}
 }
 return rows;
}
