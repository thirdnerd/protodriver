import { exchanges } from "../device-2/fixture.mjs";
function check(value,message){if(!value)throw new Error(message);}
export async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
  timer=setTimeout(()=>reject(new Error(label+" did not settle (5000ms hang detector)")),5000);
})]);}finally{clearTimeout(timer);}}
export function observation(){const seen=[],waiters=new Set();return {seen,
  add(event){seen.push(event);for(const w of waiters)if(w.predicate(event)){waiters.delete(w);w.resolve(event);}},
  async wait(predicate){const old=seen.find(predicate);if(old)return old;let w;
    try{return await bounded(new Promise(resolve=>{w={predicate,resolve};waiters.add(w);}),"C1 observation");}finally{waiters.delete(w);}},
};}
export async function runSelected(context,native,mode,retained){
  const {client}=context,events=observation();
  await client.attach("entry-authority-probe");
  const sub=client.subscribe(e=>events.add(e));
  try {
    const destination=await context.capture(),capture=await client.startCapture(destination.id,{sidecarThresholdBytes:4096});
    await bounded(client.connect({mode}),"quiet C1 "+mode);
    const entry=exchanges(mode,retained).slice(0,-1).map(e=>e.tx);
    check(JSON.stringify(native.seen.filter(e=>e.kind==="write").map(e=>e.bytes))===JSON.stringify(entry),"quiet first writes differ");
    const handle=await client.startOperation({operation:"observe",arguments:{}});
    await native.wait(e=>e.kind==="vm-effect"&&e.effect==="message-wait");
    native.inject(retained.rx[0]);
    await events.wait(e=>e.kind==="state-cells"&&e.changed?.alarm_level?.value==="HIGH");
    const snapshot=await client.getSnapshot();
    check(snapshot.activeOperations.includes(handle.operationId),"operation must still be suspended after alarm");
    check(snapshot.stateCells.alarm_channel.value==="CH1"&&snapshot.stateCells.alarm_level.value==="HIGH","alarm state missing");
    native.inject(retained.rx[1]);
    const result=await bounded(client.awaitOperation(handle.operationId),"retained receive-only operation");
    check(result.outcome==="completed"&&result.result.value===btoa(String.fromCharCode(...retained.rx[1])),JSON.stringify(result));
    await client.acknowledgeOperation(handle.operationId);
    const summary=await client.stopCapture(capture),loaded=await destination.load();
    check(summary.completeness==="complete"&&loaded.footer.completeness==="complete"&&loaded.footer.gapCount===0,"capture incomplete");
    const writes=loaded.records.filter(r=>r.kind==="tx-requested").map(r=>r.data);
    check(JSON.stringify(writes)===JSON.stringify(entry.map(bytes=>btoa(String.fromCharCode(...bytes)))),"extra native write");
    return {mode,writes,alarmDuringSuspension:true,result:result.result,complete:true,identity:context.identity.digest};
  }finally{sub.dispose();await context.close();}
}
