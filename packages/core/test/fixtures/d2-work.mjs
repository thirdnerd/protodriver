import { subdivision } from "../../../../test-support/refusal/cases.mjs";
import {registerHooks} from 'node:module';
import {parentPort} from 'node:worker_threads';
const debits=[];
globalThis[Symbol.for('d2-debit-observation')]=row=>debits.push(row);
registerHooks({load(url,context,next){
  const loaded=next(url,context);
  if(!url.endsWith('/core/src/retained-session.ts'))return loaded;
  let source=String(loaded.source);
  const before='if (!delivery.parent && !delivery.root && !delivery.inputWork) activation.work = delivery.work;';
  const after='this.#nativeTransient(activation, () => this.#reserve("handler:" + id, input));';
  for(const needle of [before,after])if(source.split(needle).length!==2)throw new Error('D2 work observer target drift');
  source=source.replace(before,before+' const d2Before=(activation.accountParent??activation).work, d2Source=delivery.inputWork?.work;');
  source=source.replace(after,'globalThis[Symbol.for("d2-debit-observation")]({before:d2Before,original:d2Source,after:(activation.accountParent??activation).work,owner:(activation.accountParent??activation).id});'+after);
  return {...loaded,source};
}});
const {make}=await import('./handler-delivery-harness.mjs');
const cleanup=[];
try {
  const h=await make({after(fn){cleanup.push(fn);}},{work:subdivision.grant,
    body:'if count==2 then for i=1,200000 do io.request({kind="reschedule"}) end end;io.request({kind="write",value=pdrv.bytes(args.input)})'});
  h.inject(new Uint8Array(484));
  const ended=await h.wait(e=>e.kind==='connection-close');
  parentPort.postMessage({debits,writes:h.writes(),turns:h.seen.filter(e=>e.kind==='turn'),error:ended.error});
} finally {for(const fn of cleanup.reverse())await fn();}
