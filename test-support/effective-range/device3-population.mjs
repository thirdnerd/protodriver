import {imageByte} from './device3-fixture.mjs';
const check=(v,m)=>{if(!v)throw Error(m);};
export async function runCases(open,names=['device3-4-4','device3-4-8','device3-6144-8192','device3-65537-70000']){
 const rows=[];
 for(const name of names){const [,extent,descriptor]=name.split('-'),length=Number(extent),size=Number(descriptor),c=await open(name),{client,native}=c;
  try{await client.attach('D3LINK fresh range');await client.connect({mode:'application'});const d=await c.capture(),cap=await client.startCapture(d.id,{sidecarThresholdBytes:1048576});
   let at=0,readBytes=0;const id=await c.registerResource({origin:'memory',byteLength:size,async seek(n){at=n;},async close(){},async read(into){
    const n=Math.min(into.length,size-at);for(let i=0;i<n;i++)into[i]=imageByte(at+i);at+=n;readBytes+=n;return{bytesRead:n,eof:at===size};}});
   const op=await client.startOperation({operation:'write_image',arguments:{image:{kind:'resource',id},length:{kind:'value',value:length}}});
   const result=await client.awaitOperation(op.operationId);await client.acknowledgeOperation(op.operationId);
   // Always retain a failed protocol attempt as evidence; do not hang waiting
   // for the successful release path after an unexpected terminal outcome.
   await client.stopCapture(cap).catch(()=>{});const footer=await native.wait(e=>e.kind==='record'&&e.record.kind==='footer');const records=await d.records();
   rows.push({name,length,size,readBytes,result,commits:native.seen.filter(e=>e.kind==='device-commit').map(({committed,accepted})=>({committed,accepted})),
    frames:native.seen.filter(e=>e.kind==='write').length});
   check(result.outcome==='completed',JSON.stringify(rows.at(-1)));
   check(footer.record.completeness==='complete','successful protocol capture incomplete');
   check(result.transferReceipt.source.subject.length===length&&result.transferReceipt.source.subject.offset===0,'D3 digest subject');
   check(result.transferReceipt.independentReadBack===false&&result.transferReceipt.target.authority==='device-reported','target authority upgraded');
   check(readBytes===length*2,'range not exactly two passes');
  }finally{await c.close();}
 }return rows;
}
