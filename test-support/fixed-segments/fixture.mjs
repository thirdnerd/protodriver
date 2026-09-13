import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
export const length=65537;
export const source=`local a=pdrv.array
local function burn(n) local v=0;for i=1,n do v=(v+i)&65535 end;return v end
local function op(id)
 return {id=id,title=id,binding=id,arguments={image={kind="stream-source",minimumBytes=65537,maximumBytes=65537}},
 result={kind="none"},risk="destructive",repeatability="not-repeatable",locks=a({"wire"}),
 requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"application"}),profiles=a({"usb"})},
 transfer={segmented=true,sourceArgument="image",targetOffset=0,targetLength=65537,maximumCarrierBytes=65536,resumeBinding="resume",finalization="repeatable"},
 cleanup={binding="cleanup",requires=a({"channel.read","channel.write","transfer.cleanup"}),maximumMilliseconds=501,maximumLuaFuel=10000,maximumWork=100000}}
end
local function report(io,n) io.request({kind="transfer-report",cookie="00ff",generation=7,committed=n,volatile=n,buffered=0}) end
local function run(args,io,size,discard,runaway)
 io.request({kind="transfer-open"});io.request({kind="write",value="BEGIN"});assert(io.request({kind="read",maximum=1})=="D");report(io,0)
 burn(runaway and 450000 or 200000)
 local offset=0
 while true do
  local parts,n={},0
  while n<size do
   local part=io.request({kind="source-read",source=args.image,maximum=math.min(256,size-n)})
   if #part==0 then break end
   parts[#parts+1]=part;n=n+#part
  end
  local bytes=table.concat(parts)
  if #bytes==0 then break end
  if not discard then
   io.request({kind="transfer-write",offset=offset,payloadOffset=0,length=#bytes,value=pdrv.bytes(bytes)})
   assert(io.request({kind="read",maximum=1})=="D");report(io,offset+#bytes)
  end
  offset=offset+#bytes
  if offset==65536 then burn(200000) end
 end
 io.request({kind="transfer-finalize"});io.request({kind="write",value="FINAL"})
 local v=io.request({kind="read",maximum=129});local s,t=v:match("^([0-9a-f]+)|([0-9a-f]+)$")
 io.request({kind="transfer-verify",source=s,target=t})
end
return {apiVersion="device/v2",id="fixed-source-segments",modes=a({"application"}),profiles=a({"usb"}),
channelRoles={usb={request="requests",response="responses",event="events"}},operations=a({op("coarse"),op("fine"),op("discard"),op("runaway"),op("cancel")})},
{coarse=function(a,i) run(a,i,65536,false,false) end,fine=function(a,i) run(a,i,32768,false,false) end,
discard=function(a,i) run(a,i,65536,true,false) end,runaway=function(a,i) run(a,i,65536,false,true) end,
cancel=function(a,i) run(a,i,65536,false,false) end,resume=function() error("not a recovery fixture") end,
cleanup=function(args,io)
 if args.outcome~="cancelled" then return end
 io.request({kind="write",value="ABORT"});assert(io.request({kind="read",maximum=1})=="A")
 io.request({kind="transfer-retire",cookie="00ff",generation=7})
end}`;
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 const clock=new VirtualClock();let sent=0;
 const release=store.release.bind(store);store.release=async claim=>{await release(claim);observe({kind:'claim-released'});};
 return {clock,modeId:'application',profileId:'usb',channelId:'group',helpers:{},checkpointStore:store,resourceBroker,captureDestinationAdapter,
 async open(){const c=new MockTransport(clock).openConnection({channelIds:['requests','responses','events'],identity:{transport:'mock',stableKeyAssurance:'serial-number',stableKey:'segmented-A'},modeId:'application',profileId:'usb'});
  for(const ch of c.channels)ch.direction=ch.id==='requests'?'out':'in';
  const response=c.channel('responses'),request=c.channel('requests'),acquire=request.acquire.bind(request);
  request.acquire=async(...args)=>{const l=await acquire(...args),write=l.write.bind(l);l.write=async bytes=>{
   const text=new TextDecoder().decode(bytes);const r=await write(bytes);observe({kind:'write',size:bytes.length,tag:['BEGIN','FINAL','ABORT'].includes(text)?text:'DATA'});
   if(text==='BEGIN')response.enqueueReceived(Uint8Array.of(68));
   else if(text==='ABORT')response.enqueueReceived(Uint8Array.of(65));
   else if(text==='FINAL'){
    // Independent pinned SHA-256 of 65537 Z octets; no whole-domain buffer.
    response.enqueueReceived(new TextEncoder().encode('866a0d5bb3f1ddb04de4ed7ef911957b0fff959c4bdf17569109727c7c2e1254'+'|'+'e'.repeat(64)));
   }else{
    if(!bytes.every(b=>b===90))throw Error('wrong source bytes');sent+=bytes.length;
    if(name==='cancel'&&sent===65536)observe({kind:'cancel-boundary'});
    else response.enqueueReceived(Uint8Array.of(68));
   }return r;};return l;};return c;
 }};
}
