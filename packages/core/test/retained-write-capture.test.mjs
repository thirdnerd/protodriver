import assert from 'node:assert/strict';
import test from 'node:test';
import {RetainedSessionRpcServer} from '../src/retained-session.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../src/rpc.ts';
import {ResourceBrokerHost,ResourceBrokerRpcClient,DirectResourceRpcAdapter} from '../src/resources.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../src/capture-rpc.ts';
import {loadCapture} from '../src/capture.ts';
import {VirtualClock} from '../../../test-support/clock.ts';
import {MockTransport} from '../../transport-mock/src/index.ts';

for(const end of ['stop','disconnect','settled'])test('write capture settlement lifetime: '+end,{timeout:3000},async t=>{
 const clock=new VirtualClock(),entered=Promise.withResolvers(),release=Promise.withResolvers(),settled=Promise.withResolvers();
 const broker=new ResourceBrokerHost(),destinations=new CaptureDestinationRegistry(),scope={kind:'session',sessionId:'write-capture'};
 const connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
 const channel=connection.channel('main'),acquire=channel.acquire.bind(channel);
 channel.acquire=async(...args)=>{const lease=await acquire(...args);lease.write=async()=>{entered.resolve();await release.promise;return{atSequence:clock.nextSequence(),outcome:{kind:'accepted-by-platform'}};};return lease;};
 let step=0;
 const server=new RetainedSessionRpcServer({clock,platform:'node',logicalDevice:'capture-fixture',modeId:'m',profileId:'p',channelId:'main',operations:['run'],helpers:{},open:async()=>connection,
  resourceBroker:new ResourceBrokerRpcClient(new DirectResourceRpcAdapter(broker)),captureDestinationAdapter:new DirectCaptureDestinationRpcAdapter(destinations,scope.sessionId),
  execution:{async register(){},async dispatch(){return{consumed:1,value:step++===0?{kind:'write',value:'X'}:{kind:'result',value:'done'}};},async retire(){settled.resolve();},async close(){}}});
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{release.resolve();await client.disconnect();await client.close();await broker.endSession(scope.sessionId);});
 async function capture(){const chunks=[];let committed=false;const id=await destinations.register({async openPart(){return broker.registerSink({async write(b){chunks.push(b.slice());},async close(){}},scope);},async commit(){committed=true;},async abort(){}},scope.sessionId);
  return{id,async load(){assert.equal(committed,true);return loadCapture((async function*(){yield* chunks;})());}};}
 await client.attach('capture');await client.connect({mode:'m'});const first=await capture(),cid=await client.startCapture(first.id,{});
 const h=await client.startOperation({operation:'run',arguments:{}});await entered.promise;
 if(end==='settled'){
  release.resolve();await settled.promise;assert.equal((await client.awaitOperation(h.operationId)).outcome,'completed');
  assert.equal((await client.stopCapture(cid)).completeness,'complete');
  assert.deepEqual((await first.load()).records.filter(r=>r.kind==='tx-settled').map(r=>r.outcome.kind),['accepted-by-platform']);return;
 }
 if(end==='stop')assert.equal((await client.stopCapture(cid)).completeness,'incomplete');else await client.disconnect();
 const old=await first.load();assert.equal(old.completeness,'incomplete');assert.ok(old.records.some(r=>r.kind==='gap'));assert.equal(old.records.filter(r=>r.kind==='tx-settled').length,0);
 let next,nid;if(end==='stop'){next=await capture();nid=await client.startCapture(next.id,{});}
 release.resolve();await settled.promise;await client.awaitOperation(h.operationId);
 if(next){await client.stopCapture(nid);const records=(await next.load()).records;
  assert.equal(records.filter(r=>r.kind==='tx-settled').length,0,'late settlement leaked into replacement recording');}
 assert.equal((await first.load()).completeness,'incomplete');
});
