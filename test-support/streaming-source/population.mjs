import {runCases as checkpoints} from '../checkpoint-service/population.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
export async function runCases(open,lengths=[70001,2097088]){
 const rows=await checkpoints(async name=>{
  const c=await open(name),stop=c.client.stopCapture.bind(c.client);
  c.client.stopCapture=async(...args)=>{await c.client.getSnapshot();return stop(...args);};return c;
 });
 for(const length of lengths){
  const c=await open('stream-'+length),{client}=c;let offset=0,reads=0,maximum=0;
  try{
   await client.attach('F45 stream');await client.connect({mode:'challenge'});
   const destination=await c.capture(),capture=await client.startCapture(destination.id,{});
   const id=await c.registerResource({origin:'memory',byteLength:length,async seek(n){offset=n;},async close(){},async read(into){
    reads++;maximum=Math.max(maximum,into.length);const n=Math.min(into.length,length-offset);
    for(let i=0;i<n;i++)into[i]=((offset+i)*17+31)&255;offset+=n;return {bytesRead:n,eof:offset===length};}});
   const h=await client.startOperation({operation:'scan',arguments:{image:{kind:'resource',id}}}),result=await client.awaitOperation(h.operationId);
   check(result.outcome==='completed'&&result.result===length,'stream '+length+' failed: '+JSON.stringify(result));
   check(maximum<=256,'native read cap widened');
   await client.getSnapshot();
   const summary=await client.stopCapture(capture),records=await destination.records();
   check(summary.completeness==='complete','stream capture incomplete');
   check(records.every(r=>r.kind!=='gap'),'stream capture contains a gap');
   rows.push({name:'stream-'+length,length,reads,maximum,result:result.result,complete:summary.completeness});
  }finally{await c.close();}
 }
 return rows;
}
