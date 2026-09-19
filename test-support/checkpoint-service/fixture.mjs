import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
export const source=`local a=pdrv.array
local function open(io) local v=io.request({kind="transfer-open"});return v:match("^[^|]+|([^|]+)|") end
local function report(io,n,v,b) return io.request({kind="transfer-report",cookie="00ff",generation=7,committed=n,volatile=v,buffered=b}) end
return {apiVersion="device/v2",id="durable-service-probe",modes=a({"challenge"}),profiles=a({"serial"}),
operations=a({{id="write",title="Write",binding="fresh",arguments={image={kind="byte-source",minimumBytes=4,maximumBytes=4}},result={kind="none"},risk="destructive",repeatability="not-repeatable",locks=a({"protocol"}),requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"challenge"}),profiles=a({"serial"})},
transfer={sourceArgument="image",targetOffset=64,targetLength=128,resumeBinding="resume",finalization="repeatable"}}})},
{fresh=function(args,io)
 open(io);io.request({kind="write",value="BEGIN"});io.request({kind="read",maximum=1});report(io,0,0,0)
 io.request({kind="transfer-write",offset=0,payloadOffset=0,length=4,value=pdrv.bytes("\\x00\\x80\\xffA")})
 io.request({kind="read",maximum=1});report(io,2,4,1);io.request({kind="read",maximum=1})
 error("fresh interrupted arm must be cancelled")
end,resume=function(args,io)
 local digest=open(io)
 io.request({kind="write",value="QUERY"})
 local q=io.request({kind="read",maximum=1})
 if q=="Q" then report(io,2,2,0) else report(io,2,4,1) end
 io.request({kind="transfer-write",offset=2,payloadOffset=0,length=2,value=pdrv.bytes("\\xffA")})
 io.request({kind="read",maximum=1});report(io,4,4,0);io.request({kind="transfer-finalize"})
 io.request({kind="write",value="FINAL"})
 local reports=io.request({kind="read",maximum=129})
 local src,target=reports:match("^([0-9a-f]+)|([0-9a-f]+)$")
 io.request({kind="transfer-verify",source=src,target=target})
end}`;
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name,
  identity={transport:'mock',stableKeyAssurance:'serial-number',stableKey:'service-board-A'}){
  const clock=new VirtualClock();
  const commit=store.commit.bind(store),release=store.release.bind(store);
  store.commit=async(...args)=>{const claim=await commit(...args);observe({kind:'checkpoint',checkpoint:claim.checkpoint});return claim;};
  store.release=async(...args)=>{await release(...args);observe({kind:'claim-released'});};
  return {clock,checkpointStore:store,resourceBroker,captureDestinationAdapter,helpers:{},modeId:'challenge',profileId:'serial',channelId:'main',
    async open(){
      const connection=new MockTransport(clock).openConnection({identity,modeId:'challenge',profileId:'serial'});
      const channel=connection.channel('main'),acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{
        const lease=await acquire(...args),write=lease.write.bind(lease);
        lease.write=async bytes=>{observe({kind:'write',bytes:[...bytes]});const result=await write(bytes);
          const text=new TextDecoder().decode(bytes);
          if(text==='QUERY')channel.enqueueReceived(Uint8Array.of(name==='not-quiet'?78:81));
          else if(text==='BEGIN'||bytes.length===4||bytes.length===2)channel.enqueueReceived(Uint8Array.of(68));
          // Independent literal SHA-256 of 00 80 ff 41, not the service result.
          else if(text==='FINAL')channel.enqueueReceived(new TextEncoder().encode('78a11bc94dd1062333933e91f3d90051ceecef81bf2172116e0f6a305699000c|'+'e'.repeat(64)));
          return result;};
        return lease;
      };return connection;
    }};
}
