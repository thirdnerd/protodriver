import { buildPdpkg } from '../../../../packages/contracts/src/pdpkg.ts';
import { MockTransport } from '../../../../packages/transport-mock/src/index.ts';
import { RealClock } from '../../../../packages/core/src/clock.ts';

export const source = `local a=pdrv.array
local n=0
return {apiVersion="device/v2",id="front-door",modes=a({"main"}),profiles=a({"serial"}),operations=a({
{id="echo",title="Echo",binding="echo",arguments={value={kind="integer",widthBits=16,signed=true,minimum=0}},
result={kind="value",type={kind="integer",widthBits=16,signed=false}},risk="changes-state",repeatability="not-repeatable",
locks=a({"channel"}),availability={modes=a({"main"}),profiles=a({"serial"})},requires=a({"channel.write"})}
})},{echo=function(args,io) io.request({kind="write",value="F87"}); n=n+1; return args.value+n end}`;
export async function packageBytes() {
  return (await buildPdpkg([{logicalName:'device.lua',sourceBytes:new TextEncoder().encode(source)}])).archive;
}
export function hostGrant(observed) {
  const clock = new RealClock();
  return {clock,modeId:'main',profileId:'serial',channelId:'main',helpers:{},async open(){
    observed.opens++;
    const connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'main',profileId:'serial'});
    const channel=connection.channel('main'), acquire=channel.acquire.bind(channel);
    channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
      lease.write=async bytes=>{observed.writes.push(new TextDecoder().decode(bytes));return write(bytes);};return lease;};
    return connection;
  }};
}
