import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
import {settings as device3Settings} from './device3-fixture.mjs';
export const octet=n=>128+(n*17+Math.floor(n/251))%100;
export const source=`local a=pdrv.array
local function op(id)
 return {id=id,title=id,binding=id,arguments={image={kind="stream-source",minimumBytes=1,maximumBytes=262144},
 offset={kind="integer",widthBits=32,signed=true,minimum=0,maximum=200000},length={kind="integer",widthBits=32,signed=true,minimum=1,maximum=131072}},
 result={kind="none"},risk="destructive",repeatability="not-repeatable",locks=a({"wire"}),
 requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"application"}),profiles=a({"usb"})},
 transfer={segmented=true,sourceArgument="image",sourceRange={offset={argument="offset"},length={argument="length"}},
 targetOffset=64,targetLength=2097152,maximumCarrierBytes=256,resumeBinding="resume",finalization="repeatable"}}
end
local function burn() local v=0;for i=1,200000 do v=(v+i)&65535 end end
local function report(io)
 local line=io.request({kind="read",maximum=128});local c,v,b=line:match("^(%d+)|(%d+)|(%d+)$")
 c,v,b=tonumber(c),tonumber(v),tonumber(b)
 io.request({kind="transfer-report",cookie="00ff",generation=7,committed=c,volatile=v,buffered=b});return c
end
local function run(args,io,resume,cut,budget)
 local source_offset,length=assert(tonumber(tostring(args.offset))),assert(tonumber(tostring(args.length)))
 io.request({kind="transfer-open"})
 io.request({kind="write",value=(resume and "R" or "Q").."|"..source_offset.."|"..length})
 local at=report(io);if budget then burn() end
 while at<length do
  local bytes=io.request({kind="source-read",source=args.image,maximum=math.min(256,length-at)})
  io.request({kind="transfer-write",offset=at,payloadOffset=0,length=#bytes,value=pdrv.bytes(bytes)})
  report(io);at=at+#bytes;if cut then return end
 end
 if budget then burn() end
 io.request({kind="transfer-finalize"});io.request({kind="write",value="F"})
 local line=io.request({kind="read",maximum=129});local s,t=line:match("^([0-9a-f]+)|([0-9a-f]+)$")
 io.request({kind="transfer-verify",source=s,target=t})
end
return {apiVersion="device/v2",id="effective-range-probe",modes=a({"application"}),profiles=a({"usb"}),
channelRoles={usb={request="requests",response="responses",event="events"}},operations=a({op("fresh"),op("cut"),op("budget")})},
{fresh=function(a,i)run(a,i,false,false,false)end,cut=function(a,i)run(a,i,false,true,false)end,
 budget=function(a,i)run(a,i,false,false,true)end,resume=function(a,i)run(a,i,true,false,false)end}`;
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 if(name.startsWith('device3-'))return device3Settings(store,resourceBroker,captureDestinationAdapter,observe,name);
 const clock=new VirtualClock();let offset=0,length=0,possible=0,committed=0,first=true;
 return {clock,modeId:'application',profileId:'usb',channelId:'group',helpers:{},checkpointStore:store,resourceBroker,captureDestinationAdapter,
 async open(){const c=new MockTransport(clock).openConnection({channelIds:['requests','responses','events'],identity:{transport:'mock',stableKeyAssurance:'serial-number',stableKey:'range-A'},modeId:'application',profileId:'usb'});
  for(const ch of c.channels)ch.direction=ch.id==='requests'?'out':'in';
  const response=c.channel('responses'),request=c.channel('requests'),acquire=request.acquire.bind(request),reply=s=>response.enqueueReceived(new TextEncoder().encode(s));
  request.acquire=async(...args)=>{const l=await acquire(...args),write=l.write.bind(l);l.write=async bytes=>{
   const text=new TextDecoder().decode(bytes);const r=await write(bytes);observe({kind:'write',bytes:[...bytes]});
   const query=/^([QR])\|(\d+)\|(\d+)$/.exec(text);
   if(query){offset=Number(query[2]);length=Number(query[3]);if(query[1]==='R')possible=committed;reply(committed+'|'+possible+'|0');}
   else if(text==='F'){
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from({length},(_,i)=>octet(offset+i))));
    reply([...hash].map(b=>b.toString(16).padStart(2,'0')).join('')+'|'+'e'.repeat(64));
   }else{
    if(!bytes.every((b,i)=>b===octet(offset+possible+i)))throw Error('wrong selected source bytes');possible+=bytes.length;
    committed=name==='recovery'&&first?128:possible;first=false;reply(committed+'|'+possible+'|'+(committed===possible?0:1));
   }return r;};return l;};return c;
 }};
}
