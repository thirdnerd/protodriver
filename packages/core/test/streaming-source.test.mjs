import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {StreamingSource} from '../src/streaming-source.ts';
import {StreamingSha256} from '../src/streaming-sha256.ts';
import {AuthoredTransfer,transferSegmentCount} from '../src/authored-transfer.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {InMemoryTransferCheckpointStore} from '../../transfer-runtime/src/transfer-checkpoint.ts';

const octet=n=>(n*17+31)&255;
function provider(length,options={}){let offset=0,reads=0;return {origin:'memory',byteLength:length,
  async seek(n){offset=n;options.seek?.(n);},async close(){},get reads(){return reads;},
  async read(into){reads++;await options.gate?.();const end=length+(options.extra??0),n=Math.min(into.length,Math.max(0,end-offset),options.chunk??256);
    for(let i=0;i<n;i++)into[i]=options.byte?.(offset+i)??octet(offset+i);offset+=n;
    return {bytesRead:n,eof:options.unresolved?false:options.emptyEof?n===0:offset===end};}};}
async function harness(length,options={}){
  const host=new ResourceBrokerHost(),broker=new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(host)),p=provider(length,options);
  const id=await host.registerSource(p,{kind:'session',sessionId:'stream'});let serial=0,work=0,held=0,peak=0,live=true,budget=32000000;
  const observations=[];
  const c={id:'stream-operation',broker,live(){assert.ok(live,'revoked');},iteration(){if(++work>budget)throw new Error('work exhausted');},native:run=>run(),
    reserve(n){held+=n;peak=Math.max(peak,held);assert.ok(held<100000,'source service cannot retain whole input');let released=false;return {release(){assert.equal(released,false);released=true;held-=n;}};},
    preflight(){throw new Error('stream must not materialize a value');},
    async call(kind,fields,run){observations.push({kind,fields});return run('stream-call-'+(++serial));},
    async read(fields,maximum,run){const r=await run('stream-call-'+(++serial));observations.push({kind:'source-read',fields,bytes:r.data.byteLength,eof:r.eof});return r;},
    mark(kind,fields){observations.push({kind,fields});}};
  const s=await StreamingSource.open('image',id,0,length,c);
  return {s,c,p,host,observations,get work(){return work;},get peak(){return peak;},get held(){return held;},set budget(n){budget=n;},revoke(){live=false;}};
}
test('incremental SHA-256 is independently checked at padding boundaries and device-3 scale',{timeout:5000},()=>{
  for(const length of [0,1,55,56,63,64,65,1024,2097088]){
    let work=0;const h=new StreamingSha256(()=>work++),oracle=createHash('sha256');
    for(let offset=0;offset<length;offset+=256){const b=Uint8Array.from({length:Math.min(256,length-offset)},(_,i)=>octet(offset+i));h.update(b);oracle.update(b);}
    assert.equal(h.hex(),oracle.digest('hex'));assert.ok(work>=length);
  }
});
test('streamed input exceeds B1 without whole-file allocation; seek preserves origin and exact EOF',{timeout:3000},async()=>{
  const h=await harness(70001,{chunk:113,emptyEof:true});let count=0;
  while(count<70001){const bytes=await h.s.read(256);for(let i=0;i<bytes.length;i++)assert.equal(bytes[i],octet(count+i));count+=bytes.length;}
  assert.equal((await h.s.read(256)).length,0);await h.s.seek(69999);assert.deepEqual([...await h.s.read(256)],[octet(69999),octet(70000)]);
  assert.ok(h.peak<10000);assert.ok(h.observations.filter(e=>e.kind==='source-read').every(e=>e.fields.origin==='memory'));
  await h.s.release();assert.equal(h.held,0);
});
test('SHA compression rounds cannot become unmetered native work',{timeout:1000},()=>{
  let work=0;const h=new StreamingSha256(()=>{if(++work>1500)throw new Error('work exhausted');});
  assert.throws(()=>{h.update(new Uint8Array(512));h.hex();},/work exhausted/);
});
test('exact-length without EOF cannot complete by truncation or by repeated probes',{timeout:3000},async()=>{
  for(const options of [{extra:1,emptyEof:true},{unresolved:true}]){
    const h=await harness(4,options);await assert.rejects(h.s.read(256),/contradicted|unresolved/);assert.equal(h.p.reads,2);await h.s.release();
  }
});
test('stream work is charged before a native source read',{timeout:3000},async()=>{
  const h=await harness(70001);h.budget=0;await assert.rejects(h.s.read(256),/work exhausted/);assert.equal(h.p.reads,0);await h.s.release();
});
test('late source completion keeps its native slot, is accounted and cannot enter a revoked binding',{timeout:3000},async t=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers();const h=await harness(70001,{gate:()=>{entered.resolve();return gate.promise;}});
  t.after(()=>gate.resolve());
  const pending=assert.rejects(h.s.read(256),/revoked/);await entered.promise;h.revoke();
  assert.equal(h.host.metrics.currentReadBufferBytes,256);gate.resolve();await pending;
  assert.equal(h.observations.find(e=>e.kind==='source-read').bytes,256);await h.s.release();assert.equal(h.held,0);
});
const identity={execution:'a'.repeat(64),mode:'main',device:'device-A',policy:'b'.repeat(64)};
test('B5 explicit range needs no out-of-range EOF probe but early EOF still refuses',{timeout:3000},async()=>{
 const h=await harness(8,{extra:1,emptyEof:true});h.s.selectTransferRange({offset:2,length:4});await h.s.seek(0);
 assert.deepEqual([...await h.s.read(256)],[2,3,4,5].map(octet));assert.equal(h.p.reads,1);assert.equal((await h.s.read(256)).length,0);await h.s.release();
 const short=await harness(8,{extra:-4});short.s.selectTransferRange({offset:2,length:4});await short.s.seek(0);
 await assert.rejects(short.s.read(256),/ended before/);await short.s.release();
});
test('B5 late range read remains recorded and cannot cross revocation',{timeout:3000},async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers(),h=await harness(100,{gate:()=>{entered.resolve();return gate.promise;}});
 h.s.selectTransferRange({offset:11,length:4});await h.s.seek(0);t.after(()=>gate.resolve());
 const pending=assert.rejects(h.s.read(256),/revoked/);await entered.promise;h.revoke();gate.resolve();await pending;
 const record=h.observations.find(e=>e.kind==='source-read');assert.equal(record.fields.offset,11);assert.equal(record.bytes,4);
 await h.s.release();assert.equal(h.held,0);
});
const operation={id:'write',transfer:{sourceArgument:'image',targetOffset:0,targetLength:2097088,resumeBinding:'resume',finalization:'repeatable'}};
function transferContext(h){let sequence=0;return {live:()=>h.c.live(),charge:n=>{for(let i=0;i<n;i++)h.c.iteration();},reserve:n=>h.c.reserve(n),native:run=>run(),
  takeEvidence:()=>({sequence:++sequence,bytes:1}),call:async(kind,run)=>run(),progress(){}};}
async function transfer(h,store,id,op=operation){return AuthoredTransfer.prepare(store,op,{image:h.s.token},identity,transferContext(h),id,h.s);}
test('D7 EOF has no bonus grant and fresh recovery earns no credit for its old prefix',{timeout:3000},async()=>{
  assert.deepEqual([1,65536,65537,2097088].map(transferSegmentCount),[1,1,2,32]);
  const op={...operation,transfer:{...operation.transfer,segmented:true,maximumCarrierBytes:65536}};
  const store=new InMemoryTransferCheckpointStore(),h=await harness(65537),s=await transfer(h,store,undefined,op);
  const [id,digest]=(await s.open()).split('|');await s.report('00ff',7,0,0,0);
  const parts=[];for(let i=0;i<256;i++)parts.push(await h.s.read(256));await s.admit(0,0,Buffer.concat(parts),65536);
  assert.equal(s.segmentProgress.eligibleIndex,1);assert.equal(s.segmentProgress.committedSourceOffset,0);
  await s.report('00ff',7,65536,65536,0);await s.release();await h.s.release();
  const changed=await harness(65537,{byte:n=>octet(n)^(n===65536?1:0)});
  await assert.rejects(transfer(changed,store,id,op),e=>e.error?.code==='transfer.resume.source-mismatch');await changed.s.release();
  const fresh=await harness(65537),r=await transfer(fresh,store,id,op);
  try{
    assert.equal(r.segmentProgress.eligibleIndex,0);await r.open();await r.report('00ff',7,65536,65536,0);
    assert.equal(r.segmentProgress.count,1);assert.equal(r.segmentProgress.eligibleIndex,0);
    const tail=await fresh.s.read(1);await r.admit(65536,0,tail,1);await r.report('00ff',7,65537,65537,0);
    assert.equal(r.segmentProgress.eligibleIndex,0);await r.finalize();await r.verify(digest,'c'.repeat(64));
  }finally{await r.release();await fresh.s.release();}
});
test('device-3 full source prehash uses a constant window, not a 2 MB materialization',{timeout:8000},async()=>{
  const h=await harness(2097088),store=new InMemoryTransferCheckpointStore(),s=await transfer(h,store);
  const parts=(await s.open()).split('|');assert.equal(parts[1].length,64);assert.ok(h.peak<100000);assert.ok(h.work<32000000);
  assert.equal(h.observations.filter(e=>e.kind==='source-read').reduce((n,e)=>n+e.bytes,0),2097088);
  await s.release();await h.s.release();assert.equal(h.held,0);
});
test('resume validates whole and actual prefix identities, then reads the committed suffix',{timeout:3000},async()=>{
  const store=new InMemoryTransferCheckpointStore(),h=await harness(4),s=await transfer(h,store),id=(await s.open()).split('|')[0];
  await s.report('00ff',7,0,0,0);const bytes=await h.s.read(4);await s.admit(0,0,bytes,4);await s.report('00ff',7,2,4,1);await s.release();await h.s.release();
  const bad=await harness(4,{byte:n=>octet(n)^1});await assert.rejects(transfer(bad,store,id),e=>e.error?.code==='transfer.resume.source-mismatch');await bad.s.release();
  const seeks=[],r=await harness(4,{seek:n=>seeks.push(n)}),resumed=await transfer(r,store,id);
  await assert.rejects(r.s.read(2),e=>e.error?.code==='transfer.resume.preparation-incomplete');
  await resumed.report('00ff',7,3,3,0);assert.equal(seeks.at(-1),3);
  const suffix=await r.s.read(256);assert.deepEqual([...suffix],[octet(3)]);await resumed.admit(3,0,suffix,1);await resumed.report('00ff',7,4,4,0);await resumed.finalize();
  await resumed.verify((await resumed.open()).split('|')[1],'e'.repeat(64));assert.equal(await store.read(id),null);
  await resumed.release();await r.s.release();assert.equal(r.held,0);
});
test('source mutation after prehash cannot claim verification or resume from a relabelled prefix',{timeout:3000},async()=>{
  let changed=false;const h=await harness(4,{byte:n=>octet(n)^(changed?1:0)}),store=new InMemoryTransferCheckpointStore(),s=await transfer(h,store),id=(await s.open()).split('|')[0];
  await s.report('00ff',7,0,0,0);changed=true;const bytes=await h.s.read(4);await s.admit(0,0,bytes,4);await s.report('00ff',7,4,4,0);
  await assert.rejects(s.finalize(),e=>e.error?.code==='transfer.verification.digest-mismatch');await s.release();await h.s.release();
  const original=await harness(4);await assert.rejects(transfer(original,store,id),e=>e.error?.code==='transfer.resume.source-mismatch');await original.s.release();
});
test('a matching possible prefix does not authorize a changed unsubmitted tail',{timeout:3000},async()=>{
  const store=new InMemoryTransferCheckpointStore(),h=await harness(8),s=await transfer(h,store),id=(await s.open()).split('|')[0];
  await s.report('00ff',7,0,0,0);const bytes=await h.s.read(4);await s.admit(0,0,bytes,4);await s.report('00ff',7,2,4,1);
  await s.release();await h.s.release();
  const changed=await harness(8,{byte:n=>octet(n)^(n>=4?1:0)});
  await assert.rejects(transfer(changed,store,id),e=>e.error?.code==='transfer.resume.source-mismatch');await changed.s.release();
});
test('a fully committed resume can repeat finalization without requesting nonexistent DATA',{timeout:3000},async()=>{
  const store=new InMemoryTransferCheckpointStore(),h=await harness(4),s=await transfer(h,store),id=(await s.open()).split('|')[0];
  await s.report('00ff',7,0,0,0);const bytes=await h.s.read(4);await s.admit(0,0,bytes,4);await s.report('00ff',7,4,4,0);await s.finalize();
  await s.release();await h.s.release();
  const resumed=await harness(4,{emptyEof:true}),r=await transfer(resumed,store,id);await r.open();await r.report('00ff',7,4,4,0);
  await r.finalize();await r.verify((await r.open()).split('|')[1],'e'.repeat(64));assert.equal(await store.read(id),null);
  await r.release();await resumed.s.release();
});
test('read-ahead window refuses before the read which would grow it',{timeout:3000},async()=>{
  const h=await harness(70001),store=new InMemoryTransferCheckpointStore(),s=await transfer(h,store);await s.open();await s.report('00ff',7,0,0,0);
  for(let n=0;n<256;n++)await h.s.read(256);const reads=h.p.reads;
  await assert.rejects(h.s.read(1),e=>e.error?.code==='authored.source.window-full');assert.equal(h.p.reads,reads);
  await s.release();await h.s.release();assert.equal(h.held,0);
});
