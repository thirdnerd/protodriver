import {registerHooks} from 'node:module';
import {parentPort} from 'node:worker_threads';
const debits=[];
globalThis[Symbol.for('publication-debit-observation')]=row=>debits.push(row);
registerHooks({load(url,context,next){
 const loaded=next(url,context);if(!url.endsWith('/core/src/retained-session.ts'))return loaded;
 let source=String(loaded.source);
 const before='pump.pending = true; // one queued/native range per physical pump, not one per promise reaction';
 const after='let queued = true;';
 const release='hold.release();\n        }\n      } else await process();';
 for(const needle of [before,after,release])if(source.split(needle).length!==2)throw Error('publication observer anchor drift');
 source=source.replace(before,before+'\n const publicationBefore=inputWork?.work;');
 source=source.replace(after,'globalThis[Symbol.for("publication-debit-observation")]({phase:"setup",before:publicationBefore,after:inputWork?.work});'+after);
 source=source.replace(release,'const releaseBefore=inputWork?.work;hold.release();globalThis[Symbol.for("publication-debit-observation")]({phase:"release",before:releaseBefore,after:inputWork?.work});\n        }\n      } else await process();');
 return{...loaded,source};
}});
const {make}=await import('./handler-delivery-harness.mjs'),cleanup=[];
try{
 const h=await make({after(fn){cleanup.push(fn);}},{group:true});
 for(const [id,b] of [['responses',65],['events',66]]){
  h.inject([b],id);await h.wait(e=>e.kind==='write'&&e.bytes[0]===b);
 }
 await h.wait(e=>e.kind==='retired'&&h.seen.filter(x=>x.kind==='retired').length===2);
 const capture=await h.capture();parentPort.postMessage({debits,writes:h.writes(),completeness:capture.footer.completeness});
}finally{for(const fn of cleanup.reverse())await fn();}
