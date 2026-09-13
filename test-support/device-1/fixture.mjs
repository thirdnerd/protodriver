import {VirtualClock} from "../clock.ts";
export const line={baudRate:57600,dataBits:8,parity:"none",stopBits:1,flowControl:"none"};
// Already-open/quiet fixture. This does NOT qualify lifecycle silence/drain.
export const lifecycle={openingDrainQuietMs:0,postTerminationSilence:{minimumMs:0,afterAbnormalTermination:false,afterModeExit:false}};
export const identity={transport:"serial",vendorId:0x1a86,productId:0x7523,stableKeyAssurance:"none"};
export function fixture(input,observe){
  const clock=new VirtualClock();
  let serial=0;
  let deliverLast, initialDelivered=false;
  const sector=Uint8Array.from(input.sector??[]);
  const mark=(kind,fields={})=>observe({kind,order:++serial,atUs:clock.monotonicUs(),...fields});
  return {clock,mark,
    receiver(deliver){deliverLast=deliver;},
    inject(bytes){if(!deliverLast)throw new Error("no native receiver");mark("native-noise",{bytes});deliverLast(Uint8Array.from(bytes));},
    request(bytes,deliver){
      deliverLast=deliver;
      mark("native-write",{bytes:[...bytes]});
      if(input.sectorCarrier){
        const setup={"80,83,69,65,82,67,72":[6,...new TextEncoder().encode("P13GMRS")],"80,49,51,71,77,82,83":[6],"2":Array(8).fill(255),"6":[6]};
        let response=setup[[...bytes].join(",")];
        if(bytes.length===5&&bytes[0]===82){
          const address=bytes[1]+256*bytes[2]+65536*bytes[3],length=bytes[4];
          const payload=length===1&&address%4096===4095?[address===0x1fff?0x16:0]:[...sector.slice(address-4096,address-4096+length)];
          if(payload.length!==length)throw new Error("source-backed carrier read outside fixture sector");
          response=[87,...bytes.slice(1),...payload];
        }else if(bytes.length===69&&bytes[0]===87&&bytes[4]===64){
          const address=bytes[1]+256*bytes[2]+65536*bytes[3];
          if(address<4096||address+64>8192)throw new Error("carrier write outside fixture sector");
          sector.set(bytes.slice(5),address-4096);response=[6];
        }
        if(!response)throw new Error("unexpected sector carrier request");
        mark("native-response",{bytes:response});deliver(Uint8Array.from(response));return;
      }
      if(input.byteEquality) return; // Guarded sector control has no protocol reply.
      let response=input.rx;
      if(input.maintenance){
        // Synthetic protocol model from the existing declaration, not a claim
        // that the retained probe contains the entire establishment/ping.
        const replies={"80,83,69,65,82,67,72":input.rx,"80,49,51,71,77,82,83":[[6]],
          "2":[Array(8).fill(255)],"6":[[6]],"82,0,0,0,0":[[87,0,0,0,0]]};
        response=replies[[...bytes].join(",")];
        if(bytes.length===5&&bytes[0]===82&&bytes[4]===64){
          const address=bytes[1]+256*bytes[2]+65536*bytes[3];
          const reply=Uint8Array.from([87,...bytes.slice(1),...Array.from({length:64},(_,i)=>(address+i)&255)]);
          // Ten 200-ms responses span two seconds within the declared
          // 300-ms per-action limit; no sleep or load-dependent timing.
          clock.timer(200,()=>{mark("native-response",{bytes:[...reply]});deliver(reply);});
          return;
        }
        if(!response)throw new Error("unexpected maintenance request");
      }else if(JSON.stringify([...bytes])!==JSON.stringify(input.tx))throw new Error("unexpected device-1 request");
      // Response is decoded from digest-pinned retained wire, not Lua's result.
      for(const group of response){mark("native-response",{bytes:group});deliver(Uint8Array.from(group));}
    },
    observeConnection(connection){
      const channel=connection.channels[0],acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{
        const lease=await acquire(...args),incoming=lease.incoming.bind(lease),write=lease.write.bind(lease);
        lease.incoming=()=>{
          const iterator=incoming()[Symbol.asyncIterator]();
          return {[Symbol.asyncIterator](){return this;},
            next(){mark("authoritative-read-request");const p=iterator.next();
              if(input.byteEquality&&!input.sectorCarrier&&!initialDelivered){initialDelivered=true;queueMicrotask(()=>{
                const bytes=Uint8Array.from(input.sector);mark("native-response",{bytes:[...bytes]});deliverLast(bytes);
              });}
              return p.then(value=>{mark("authoritative-read-result",{done:!!value.done});return value;},cause=>{mark("authoritative-read-failure",{message:String(cause)});throw cause;});},
            return(){return iterator.return?.()??Promise.resolve({done:true});}};
        };
        lease.write=async bytes=>{mark("lease-write-request",{bytes:[...bytes]});
          try {const result=await write(bytes);mark("lease-write-result",{outcome:result.outcome.kind});return result;}
          catch(cause){mark("lease-write-failure",{code:cause.error?.code??cause.code??null,message:String(cause)});throw cause;}};
        return lease;
      };
      return connection;
    },
  };
}
