import {settings as base} from '../channel-group/fixture.mjs';
export const data=Uint8Array.of(0,128,255,65);
export const carrier=Uint8Array.from({length:792},(_,i)=>i<788?90:data[i-788]);
export const source=`local a=pdrv.array
local function op(id,bound)
 local t={sourceArgument="image",targetOffset=64,targetLength=128,resumeBinding="resume",finalization="repeatable"}
 if bound then t.maximumCarrierBytes=bound end
 return {id=id,title=id,binding="run",arguments={image={kind="stream-source",minimumBytes=4,maximumBytes=4}},result={kind="none"},risk="destructive",repeatability="not-repeatable",locks=a({"protocol"}),requires=a({"channel.read","channel.write","transfer.checkpoint"}),availability={modes=a({"challenge"}),profiles=a({"serial"})},transfer=t}
end
return {apiVersion="device/v2",id="carrier-bound",modes=a({"challenge"}),profiles=a({"serial"}),
channelRoles={serial={request="requests",response="responses",event="events"}},
operations=a({op("exact",792),op("under",791),op("default"),op("pending",792),op("ordinary",792)})},
{resume=function() error("not a resume probe") end,
run=function(args,io)
 io.request({kind="transfer-open"});io.request({kind="write",value="BEGIN"});assert(io.request({kind="read",maximum=1})=="D")
 io.request({kind="transfer-report",cookie="00ff",generation=7,committed=0,volatile=0,buffered=0})
 local payload=io.request({kind="source-read",source=args.image,maximum=4});assert(#payload==4)
 local frame=pdrv.bytes(string.rep("Z",788)..payload)
 io.request({kind="transfer-write",offset=0,payloadOffset=788,length=4,value=frame})
 assert(io.request({kind="read",maximum=1})=="D")
 io.request({kind="transfer-report",cookie="00ff",generation=7,committed=4,volatile=4,buffered=0})
 io.request({kind="transfer-finalize"});io.request({kind="write",value="FINAL"})
 local reports=io.request({kind="read",maximum=129});local src,target=reports:match("^([0-9a-f]+)|([0-9a-f]+)$")
 io.request({kind="transfer-verify",source=src,target=target})
end}`;
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 const o=base(store,resourceBroker,captureDestinationAdapter,observe,name),open=o.open;
 o.open=async()=>{const c=await open(),request=c.channel('requests'),acquire=request.acquire.bind(request);
  request.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
   lease.write=async bytes=>{const r=await write(bytes);if(bytes.length===792)c.channel('responses').enqueueReceived(Uint8Array.of(68));return r;};return lease;};return c;};return o;
}
