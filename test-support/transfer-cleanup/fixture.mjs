import {source as grouped,settings as groups} from '../channel-group/fixture.mjs';
export const source=grouped.replace('local a=pdrv.array','local a=pdrv.array;local scenario="keep"')
 .replace('binding="fresh",arguments={image=', 'binding="fresh",cleanup={binding="restore",requires=a({"channel.read","channel.write","transfer.cleanup"}),maximumMilliseconds=501,maximumLuaFuel=10000,maximumWork=100000},arguments={scenario={kind="string",maximumLength=32},image=')
 .replace('fresh=function(args,io)', 'fresh=function(args,io) scenario=args.scenario;if scenario=="ordinary" then io.request({kind="transfer-retire",cookie="00ff",generation=7}) end')
 .replace('resume=function(args,io)', 'resume=function(args,io) scenario=args.scenario;')
 .replace('{invalidate=function()', `{restore=function(args,io)
   if scenario=="keep" or scenario=="ordinary" then return end
   local state=io.request({kind="transfer-cleanup-state"})
   assert(state:match("^checkpoint|"),"cleanup checkpoint unavailable: "..state)
   io.request({kind="write",value="ABORT"})
   if scenario~="no-input" then local ack=io.request({kind="read",maximum=1});if ack~="A" then pdrv.fail("abort-refused",{}) end end
   io.request({kind="transfer-retire",cookie=scenario=="bad-cookie" and "ffff" or "00ff",generation=scenario=="bad-generation" and 8 or 7})
 end,invalidate=function()`);
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 const complete=store.complete.bind(store),release=store.release.bind(store);
 store.complete=async claim=>{await complete(claim);observe({kind:'checkpoint-removed',id:claim.checkpoint.id});};
 store.release=async claim=>{await release(claim);observe({kind:'checkpoint-retained',checkpoint:await store.read(claim.checkpoint.id)});};
 const options=groups(store,resourceBroker,captureDestinationAdapter,observe,name),open=options.open;
 options.open=async()=>{
  const c=await open(),request=c.channel('requests'),acquire=request.acquire.bind(request);
  request.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
   lease.write=async bytes=>{const receipt=await write(bytes);if(new TextDecoder().decode(bytes)==='ABORT')
    c.channel('responses').enqueueReceived(Uint8Array.of(name==='refused'?78:65));return receipt;};return lease;};return c;
 };return options;
}
