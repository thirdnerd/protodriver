import {source as streamed} from '../streaming-source/fixture.mjs';
import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
const operation=(id,requires)=>`{id="${id}",title="${id}",binding="${id}",arguments={},result={kind="value",type={kind="string"}},risk="read-only",repeatability="safe-to-repeat",locks=a({"channel"}),requires=a({${requires}}),availability={modes=a({"challenge"}),profiles=a({"serial"})}},`;
export const source=streamed.replace('return {apiVersion','return {invalidation="invalidate",channelRoles={serial={request="requests",response="responses",event="events"}},apiVersion')
 .replace('operations=a({', 'operations=a({'+operation('roles','"channel.read","channel.write"')+operation('late','"connection.lifecycle","channel.read","channel.write"')+operation('fill','"channel.read"')+operation('reacquire','"connection.lifecycle","channel.write"')+operation('stale','"connection.lifecycle","channel.write"'))
 .replace('{scan=function',`{invalidate=function() end,
 roles=function(args,io) io.request({kind="write",value="PAIR"});local r=io.request({kind="read-bytes",maximum=2});local rc=io.request({kind="input-channel"});local e=io.request({kind="read-bytes",maximum=2});local ec=io.request({kind="input-channel"});return rc..":"..r.."|"..ec..":"..e end,
 late=function(args,io) local old=io.request({kind="connection-grant"});io.request({kind="connection-close",connection=old:match("^([^|]+)")});io.request({kind="connection-reacquire"});io.request({kind="write",value="PAIR"});local r=io.request({kind="read-bytes",maximum=2});local rc=io.request({kind="input-channel"});local e=io.request({kind="read-bytes",maximum=2});local ec=io.request({kind="input-channel"});return rc..":"..r.."|"..ec..":"..e end,
 fill=function(args,io) return io.request({kind="wait-fill",count=2,timers=a({})}) end,
 reacquire=function(args,io) local old=io.request({kind="connection-grant"});io.request({kind="connection-close",connection=old:match("^([^|]+)")});local fresh=io.request({kind="connection-reacquire"});assert(fresh~=old);io.request({kind="lease-write",lease=fresh:match("|(.+)$"),value="NEW"});return "fresh" end,
 stale=function(args,io) local old=io.request({kind="connection-grant"});io.request({kind="connection-close",connection=old:match("^([^|]+)")});io.request({kind="connection-reacquire"});io.request({kind="lease-write",lease=old:match("|(.+)$"),value="STALE"});return "bad" end,
 scan=function`);
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 const clock=new VirtualClock(),oldInput=Promise.withResolvers();let generation=0;
 const commit=store.commit.bind(store),release=store.release.bind(store);
 store.commit=async(...args)=>{const claim=await commit(...args);observe({kind:'checkpoint',checkpoint:claim.checkpoint});return claim;};
 store.release=async(...args)=>{await release(...args);observe({kind:'claim-released'});};
 return {clock,checkpointStore:store,resourceBroker,captureDestinationAdapter,helpers:{},modeId:'challenge',profileId:'serial',channelId:'main',
  async open(){
   const ordinal=++generation,connection=new MockTransport(clock).openConnection({channelIds:['requests','responses','events'],identity:{transport:'mock',stableKeyAssurance:'serial-number',stableKey:'service-board-A'},modeId:'challenge',profileId:'serial'});
   const response=connection.channel('responses'),event=connection.channel('events'),eventObserved=Promise.withResolvers();
   for(const channel of connection.channels){
    channel.direction=channel.id==='requests'?'out':'in';const acquire=channel.acquire.bind(channel);
    channel.acquire=async(...args)=>{
     const lease=await acquire(...args),release=lease.release.bind(lease),incoming=lease.incoming.bind(lease),write=lease.write.bind(lease);
     observe({kind:'lease-acquired',channel:channel.id,ordinal});
     lease.release=async()=>{await release();observe({kind:'lease-released',channel:channel.id,ordinal});};
     lease.incoming=()=>{
      if(channel.id==='requests')throw new Error('output-only channel asked for input');
      const iterator=incoming()[Symbol.asyncIterator]();return {[Symbol.asyncIterator](){return this;},async next(){
       let result=await iterator.next();
       if(name==='late'&&ordinal===1&&channel.id==='responses'&&result.done){
        await oldInput.promise;observe({kind:'old-native-completion'});
        result={done:false,value:{bytes:Uint8Array.of(88),atSequence:clock.nextSequence()}};
       }
       // Both observations already carry host sequence. Deliver promises in
       // opposite order in the PAIR control; no wall-clock delay is involved.
       if(name==='roles'&&!result.done){if(channel.id==='responses')await eventObserved.promise;else eventObserved.resolve();}
       return result;},return:()=>iterator.return()};
     };
     lease.write=async bytes=>{
      if(channel.id!=='requests')throw new Error('input-only channel received a write');
      observe({kind:'write',channel:channel.id,ordinal,bytes:[...bytes]});const receipt=await write(bytes),text=new TextDecoder().decode(bytes);
      if(text==='PAIR'){oldInput.resolve();response.enqueueReceived(name==='entry'?Uint8Array.of(82,76):Uint8Array.of(82));event.enqueueReceived(Uint8Array.of(69));}
      else if(text==='QUERY')response.enqueueReceived(Uint8Array.of(name==='not-quiet'?78:81));
      else if(text==='BEGIN'||bytes.length===4&&text!=='PAIR'||bytes.length===2)response.enqueueReceived(Uint8Array.of(68));
      else if(text==='FINAL')response.enqueueReceived(new TextEncoder().encode('78a11bc94dd1062333933e91f3d90051ceecef81bf2172116e0f6a305699000c|'+'e'.repeat(64)));
      return receipt;};return lease;
    };
   }return connection;
  }};
}
