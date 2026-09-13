import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
import {source as transferSource} from '../streaming-source/fixture.mjs';
import {source as segmentedSource} from '../fixed-segments/fixture.mjs';
export const source=`local a=pdrv.array
return {apiVersion="device/v2",id="streamed-result",modes=a({"m"}),profiles=a({"p"}),operations=a({
 {id="run",title="Run",binding="run",arguments={length={kind="integer",minimum=1,maximum=2097152,widthBits=32,signed=true}},
 result={kind="file",direction="out",content="Synthetic bytes",mediaType="application/octet-stream",suggestedExtension="bin",minimumBytes=1,maximumBytes=2097152,
 streamed={subject="synthetic-target",offset=7,length={argument="length"}}},
 risk="read-only",repeatability="safe-to-repeat",locks=a({}),requires=a({}),availability={modes=a({"m"}),profiles=a({"p"})}}
})},{run=function(args,io)
 -- Deliberately faulty result branches for pre-submission refusal controls.
 if args.length==3 then return io.resultDestination end
 if args.length==4 or args.length==5 then
  io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(string.rep("Z",args.length==4 and 5 or 257))})
  return io.resultDestination
 end
 local n=0;while n<args.length do local size=math.min(256,args.length-n)
 io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(string.rep("Z",size))});n=n+size end
 return io.resultDestination
end}`;
export function settings(resourceBroker,captureDestinationAdapter){
 const clock=new VirtualClock();
 return {clock,modeId:'m',profileId:'p',channelId:'main',helpers:{},resourceBroker,captureDestinationAdapter,
  open:async()=>new MockTransport(clock).openConnection({channelIds:['main'],modeId:'m',profileId:'p'})};
}
const report='result={kind="resource",direction="out",content="Independent synthetic report",mediaType="application/octet-stream",minimumBytes=65537,maximumBytes=65537,streamed={subject="report",offset=0,length=65537}}';
const emit='local function emit(io,n) while n>0 do local size=math.min(256,n);io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(string.rep("Z",size))});n=n-size end end\n';
export const checkpointSource=emit+transferSource.replace('result={kind="none"}',report).replace('transfer={sourceArgument=','transfer={segmented=true,sourceArgument=')
 .replace('report(io,2,4,1);io.request','report(io,2,4,1);emit(io,2);io.request')
 .replace('io.request({kind="transfer-verify",source=src,target=target})','io.request({kind="transfer-verify",source=src,target=target});emit(io,65537);return io.resultDestination');
export const combinedSource=segmentedSource.replace('result={kind="none"}',report)
 .replace('if #part==0 then break end','if #part==0 then break end;io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(part)})')
 .replace('local bytes=table.concat(parts)','local bytes=table.concat(parts);if n==size and offset==0 then burn(200000) end')
 .replace('io.request({kind="transfer-verify",source=s,target=t})','io.request({kind="transfer-verify",source=s,target=t});return io.resultDestination')
 .replaceAll('function(a,i) run(','function(a,i) return run(');
