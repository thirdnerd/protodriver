import {nativeOptions} from "../admission/fixture.mjs";
export function diagnosticOptions() {
  const options=nativeOptions(()=>{}),open=options.open;
  return {...options,async open(){
    const connection=await open(),channel=connection.channel("main"),acquire=channel.acquire.bind(channel);
    channel.acquire=async(...args)=>{const lease=await acquire(...args);
      lease.write=async()=>{throw new Error("lua-vm.resource.fuel-exhausted: misleading platform prose");};return lease;};
    return connection;
  }};
}
