import {readFile} from 'node:fs/promises';
import {admitAuthoredModule} from '../../src/authored-module.ts';
import {RetainedSessionRpcServer} from '../../src/retained-session.ts';
import {DeviceSessionRpcClient,DirectSessionRpcAdapter} from '../../src/rpc.ts';
import {CaptureDestinationRegistry,DirectCaptureDestinationRpcAdapter} from '../../src/capture-rpc.ts';
import {VirtualClock} from '../../../../test-support/clock.ts';
import {MockTransport} from '../../../transport-mock/src/index.ts';
export const bounded=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' (2000ms hang detector)')),2000);})]);}finally{clearTimeout(timer);}};
const wasm=new Uint8Array(await readFile(new URL('../../../lua-vm/artifacts/protodriver-retained-v2.wasm',import.meta.url)));
const format='local function fmt(o) return string.format("%s|%d|%d|%d",o.basisId,o.generation,o.sequence,o.elapsedUs) end';
export async function make(t,options={}) {
 const code=`local a=pdrv.array;local saved;local runs=0;${format}
 return {apiVersion="device/v2",id="clock-control",modes=a({"m"}),profiles=a({"p"}),${options.handler?`handlers=a({{id="receiver",binding="input",event={kind="channel-input",channelId="main"},maximumConcurrent=1,locks=a({}),requires=a({"channel.input","channel.write","clock.observe"})}}),`:''}
 operations=a({{id="run",title="run",binding="run",arguments={},result={kind="value",type={kind="string",maximumLength=256}},locks=a({}),requires=a({${options.noGrant?'':'"clock.observe",'}${options.expiryGrant?'"expiry.observe",':''}${options.writeGrant?'"channel.write",':''}"timer"}),risk="read-only",repeatability="safe-to-repeat",availability={modes=a({"m"}),profiles=a({"p"})}
 ${options.cleanup?`,cleanup={binding="cleanup",requires=a({"clock.observe","channel.write"${options.expiryGrant?',"expiry.observe"':''}}),maximumMilliseconds=50,maximumWork=100000,maximumLuaFuel=100000}`:''}}})},
 {run=function(_,io) ${options.body??'local o=io.request({kind="clock-observe"});assert(not pcall(function()o.elapsedUs=99 end));return fmt(o)'} end,
 input=function(args,io) ${options.handler??''} end,
 cleanup=function(args,io) ${options.cleanup??''} end}`;
 const module=await admitAuthoredModule([{logicalName:'device.lua',sourceBytes:Buffer.from(code)},
 {logicalName:'pdpkg.json',sourceBytes:Buffer.from('{"packageFormat":1,"generatorContract":2}')}],wasm);
 const execution=await module.openExecution(),clock=options.clock??new VirtualClock();await clock.advance(9000000000);
 const seen=[],waiters=new Set(),parts=new Map();let channel,partial='';
 const emit=e=>{seen.push(e);for(const w of waiters)if(w.p(e)){waiters.delete(w);w.resolve(e);}};
 const wait=async p=>{const found=seen.find(p);if(found)return found;let w;try{return await bounded(new Promise(resolve=>{w={p,resolve};waiters.add(w);}), 'B7 observation');}catch(e){throw Error(e.message+'; snapshot='+JSON.stringify(await client.getSnapshot())+'; tail='+JSON.stringify(seen.slice(-8)));}finally{waiters.delete(w);}};
 const registry=new CaptureDestinationRegistry();
 const destination=await registry.register({async openPart(name){parts.set(name,[]);return name;},async commit(){},async abort(){}},'B7');
 const observeEffect=(owner,result)=>{if(result.value?.kind)emit({kind:'effect',owner,effect:result.value.kind});};
 const wrapped={...execution,
  async startOperation(...args){await options.beforeStart?.(args[1]);const result=await execution.startOperation(...args);observeEffect(args[0],result);return result;},
  async dispatch(...args){const result=await execution.dispatch(...args);observeEffect(args[0],result);return result;},
  async dispatchObservation(...args){const observation=args[1];if(observation?.basisId)emit({kind:'clock-observation',source:'requested',observation});
   const result=await execution.dispatchObservation(...args);observeEffect(args[0],result);await options.afterObservation?.();return result;},
  async retire(...args){await execution.retire(...args);emit({kind:'retired',owner:args[0]});},
 };
 const server=new RetainedSessionRpcServer({platform:'node',clock,logicalDevice:module.description.id,modeId:'m',profileId:'p',channelId:'main',description:module.description,
  operations:['run'],helpers:{},execution:wrapped,capabilities:{'clock.observe':{available:true},'expiry.observe':{available:true},timer:{available:true},'channel.write':{available:true}},
  resourceBroker:{async write(id,data){parts.get(id).push(Buffer.from(data));partial+=Buffer.from(data).toString();let end;
   while((end=partial.indexOf('\n'))!==-1){const r=JSON.parse(partial.slice(0,end));partial=partial.slice(end+1);if(r.kind==='footer')emit({...r,kind:'capture-footer'});}
  },async close(){}},captureDestinationAdapter:new DirectCaptureDestinationRpcAdapter(registry,'B7'),
  async open(){const c=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});channel=c.channel('main');
   const acquire=channel.acquire.bind(channel);channel.acquire=async(...args)=>{const lease=await acquire(...args);lease.write=async bytes=>{emit({kind:'native-write',text:Buffer.from(bytes).toString()});return {atSequence:clock.nextSequence(),outcome:{kind:'accepted-by-platform'}};};return lease;};return c;},
  ...options.session,
 });
 const client=new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
 t.after(async()=>{options.release?.();await client.disconnect();await client.close();});
 await client.attach('clock');const subscription=client.subscribe(emit);t.after(()=>subscription.dispose());await client.connect({mode:'m'});const capture=await client.startCapture(destination,{});
 return {module,clock,client,seen,wait,inject(bytes){channel.enqueueReceived(Uint8Array.from(bytes));},
  async start(){return client.startOperation({operation:'run',arguments:{}});},
  async run(){const h=await this.start();const r=await bounded(client.awaitOperation(h.operationId),'B7 result');await client.acknowledgeOperation(h.operationId);return r;},
  async stop(){return client.stopCapture(capture);},
 };
}
