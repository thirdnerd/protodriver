import assert from 'node:assert/strict';
import test from 'node:test';
import {CaptureWriter,loadCapture} from '../src/capture.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
async function setup(maximumBufferedBytes=4096,fail=false){
 const chunks=[],gated=Promise.withResolvers();let calls=0;
 const sink={async write(bytes){calls++;if(calls===2)await gated.promise;
  if(fail&&calls===3)throw new Error('batch storage failure');chunks.push(bytes.slice());},async close(){}};
 const writer=await CaptureWriter.create({sink,clock:new VirtualClock(),captureId:'batch',logicalDevice:'fixture',host:{platform:'node'},maximumBufferedBytes});
 return {writer,chunks,gated,calls:()=>calls};
}
test('already queued capture lines share writes with byte-exact order and per-record counts',{timeout:3000},async()=>{
 const h=await setup(),rows=Array.from({length:24},(_,i)=>({kind:'event',name:'row-'+i}));
 for(const row of rows)h.writer.record(row);
 assert.equal(h.calls(),2,'the first record is written immediately, without a batching timer');
 h.gated.resolve();const summary=await h.writer.close();
 const loaded=await loadCapture(h.chunks),expected=rows.map((r,i)=>({...r,seq:i+1,tUs:0}));
 assert.deepEqual(loaded.records,expected);assert.equal(summary.recordCount,24);
 assert.equal(loaded.completeness,'complete');
 assert.ok(h.chunks.slice(1,-1).some(b=>Buffer.from(b).toString().trim().split('\n').length>1),'adjacent queued lines must not each cross the resource wire');
 assert.equal(Buffer.concat(h.chunks.slice(1,-1)).toString(),expected.map(r=>JSON.stringify(r)+'\n').join(''));
});
test('batch scratch cannot borrow an outstanding record reservation',{timeout:3000},async()=>{
 const row={kind:'event',name:'x'},size=Buffer.byteLength(JSON.stringify({...row,seq:1,tUs:0})+'\n');
 const h=await setup(size*4),hold=h.writer.reserveObservation(size*2);
 h.writer.record(row);h.writer.record(row);h.gated.resolve();await h.writer.flush();
 hold.record(row,3,0);const summary=await h.writer.close();
 assert.equal(summary.completeness,'complete');assert.equal((await loadCapture(h.chunks)).records.length,3);
});
test('failed grouped storage cannot count unwritten records or report complete',{timeout:3000},async()=>{
 const h=await setup(4096,true);for(let i=0;i<12;i++)h.writer.record({kind:'event',name:String(i)});
 h.gated.resolve();const summary=await h.writer.close();
 assert.equal(summary.completeness,'incomplete');assert.equal(summary.recordCount,1);
 assert.match(summary.storageError.message,/batch storage failure/);
});
test('in-flight batch copy and reserved observations share the original capacity ceiling',{timeout:3000},async()=>{
 const row={kind:'event',name:'x'},size=Buffer.byteLength(JSON.stringify({...row,seq:1,tUs:0})+'\n');
 const first=Promise.withResolvers(),batch=Promise.withResolvers(),entered=Promise.withResolvers();let calls=0;
 const sink={async write(bytes){calls++;if(calls===2)await first.promise;if(calls===3){entered.resolve(bytes.length);await batch.promise;}},async close(){}};
 const writer=await CaptureWriter.create({sink,clock:new VirtualClock(),captureId:'capacity',logicalDevice:'fixture',host:{platform:'node'},maximumBufferedBytes:size*10});
 const held=writer.reserveObservation(size*4);
 for(let i=0;i<5;i++)writer.record(row);
 first.resolve();
 try{
  assert.equal(await entered.promise,size*2,'batch may use only unreserved scratch headroom');
  assert.throws(()=>writer.reserveObservation(1),/reservation-refused/,'in-flight batch copy must remain accounted');
 }finally{batch.resolve();held.release();await writer.close();}
});
