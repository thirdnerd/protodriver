import {carrier,data} from './fixture.mjs';
const check=(v,m)=>{if(!v)throw new Error(m);};
export async function runCases(open){
 const rows=[];
 for(const name of ['exact','under','default']){
  const c=await open(name),{client,native}=c;
  try{
   await client.attach('F48');await client.connect({mode:'challenge'});
   const destination=await c.capture(),capture=await client.startCapture(destination.id,{});let at=0;
   const id=await c.registerResource({origin:'memory',byteLength:4,async seek(n){at=n;},async read(into){const b=data.slice(at,at+into.length);into.set(b);at+=b.length;return {bytesRead:b.length,eof:at===4};},async close(){}});
   const op=await client.startOperation({operation:name,arguments:{image:{kind:'resource',id}}}),r=await client.awaitOperation(op.operationId);
   check(r.outcome===(name==='exact'?'completed':'failed'),'wrong outcome: '+JSON.stringify(r));
   if(name!=='exact'){
    const cp=native.seen.filter(e=>e.kind==='checkpoint').at(-1).checkpoint;
    check(cp.authoredTransfer.admittedEnd===0&&cp.confirmedRanges.length===0,'oversize advanced possible or committed horizon');
    check(r.error.code==='authored.transfer.carrier-bound','wrong bound refusal');
    check(r.error.details.actualBytes===792&&r.error.details.maximumCarrierBytes===(name==='under'?791:256),'wrong reported bound');
   }else check(r.transferReceipt.source.authority==='host-computed-device-confirmed'&&r.transferReceipt.target.authority==='device-reported'&&!r.transferReceipt.independentReadBack,'digest authority changed');
   await native.wait(e=>e.kind==='source-released');await client.stopCapture(capture);const records=await destination.records();
   const bytes=records.filter(r=>r.kind==='tx-requested').map(r=>[...atob(r.data)].map(c=>c.charCodeAt(0)));
   const expected=name==='exact'?[[66,69,71,73,78],[...carrier],[70,73,78,65,76]]:[[66,69,71,73,78]];
   check(JSON.stringify(bytes)===JSON.stringify(expected),'carrier bytes, count or pre-refusal write differs');
   const footer=(await native.wait(e=>e.kind==='record'&&e.record.kind==='footer')).record;check(footer.completeness==='complete','capture incomplete');
   rows.push({name,outcome:r.outcome,code:r.error?.code??null,writes:bytes,receipt:name==='exact'?r.transferReceipt:{committedSourceOffset:r.transferReceipt.committedSourceOffset,verified:r.transferReceipt.verified},capture:footer.completeness});
  }finally{await c.close();}
 }return rows;
}
