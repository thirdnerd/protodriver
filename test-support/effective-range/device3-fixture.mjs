// Independent synthetic device: literal protocol fields and the existing CRC
// implementation, not the candidate's Lua encoder/parser. No hardware claim.
import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
import {oracleFrame,oraclePayload} from '../binary-oracle.mjs';
export const imageByte=n=>(n*17+Math.floor(n/251))&255;
const check=(v,m)=>{if(!v)throw Error(m);};
const word=(b,i)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(i,true);
const put=(b,i,n)=>new DataView(b.buffer,b.byteOffset,b.byteLength).setUint32(i,n,true);
export function settings(store,resourceBroker,captureDestinationAdapter,observe,name){
 const clock=new VirtualClock(),length=Number(name.split('-')[1]),cookie=Uint8Array.of(0,128,255,1,254,2,253,3,252,4,251,5);
 let at=0,committed=0,nextBoundary=Math.min(4032,length),pending=[],digest;
 return {clock,modeId:'application',profileId:'usb',channelId:'group',helpers:{},checkpointStore:store,resourceBroker,captureDestinationAdapter,
 async open(){const c=new MockTransport(clock).openConnection({channelIds:['requests','responses','events'],identity:{transport:'mock',stableKeyAssurance:'serial-number',stableKey:'device3-probe'},modeId:'application',profileId:'usb'});
  for(const ch of c.channels)ch.direction=ch.id==='requests'?'out':'in';
  const out=c.channel('requests'),acquire=out.acquire.bind(out),send=(channel,body)=>{
   const packet=oracleFrame(body);
   // Independent input streams, and fragmentation not chosen by the parser.
   for(let i=0;i<packet.length;i+=17)c.channel(channel).enqueueReceived(packet.slice(i,i+17));
  };
  const response=(p,size)=>{const b=new Uint8Array(size);b.set([2,p[1],p[2],p[3],0]);return b;};
  out.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);lease.write=async bytes=>{
   const receipt=await write(bytes),p=oraclePayload(bytes);check(p[0]===1,'request kind');observe({kind:'write',bytes:[...bytes]});
   if(p[1]===0x30){check(p.length===5&&p[4]===0,'QUERY fields');const r=response(p,117);
    new DataView(r.buffer).setUint16(7,4096,true);put(r,9,2097152);put(r,13,2097088);r.set(cookie,101);send('responses',r);
   }else if(p[1]===0x31){check(p.length===56&&p.slice(4,8).every(b=>b===0)&&word(p,8)===length,'BEGIN fields');
    digest=new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from({length},(_,i)=>imageByte(i))));
    check(digest.every((b,i)=>b===p[12+i])&&cookie.every((b,i)=>b===p[44+i]),'BEGIN selected digest/cookie');
    const r=response(p,25);put(r,5,0xfedcba98);put(r,9,38);put(r,17,nextBoundary);r[21]=8;send('responses',r);
   }else if(p[1]===0x32){const offset=word(p,8),n=p[12]+p[13]*256;
    check(word(p,4)===0xfedcba98&&p.length===n+14&&n>0&&n<=768,'DATA shape');
    check(offset===at&&offset+n<=length&&offset+n<=committed+6144&&pending.length<8,'DATA window');
    check(n>=512||offset+n===length||offset+n===nextBoundary,'short DATA rule');
    check(p.slice(14).every((b,i)=>b===imageByte(offset+i)),'DATA changed bytes');
    at+=n;pending.push(at);
    while(committed<length&&at>=nextBoundary){committed=nextBoundary;pending=pending.filter(end=>end>committed);nextBoundary=Math.min(committed+4096,length);
     const r=new Uint8Array(28);r.set([3,0x81,0,0]);put(r,4,0xfedcba98);put(r,8,38);put(r,12,committed);put(r,16,at);put(r,20,nextBoundary);r[24]=pending.length;r[25]=8-pending.length;
     observe({kind:'device-commit',committed,accepted:at});send('events',r);
    }
   }else if(p[1]===0x33){check(p.length===8&&word(p,4)===0xfedcba98&&committed===length&&pending.length===0,'FINAL before durable end');
    const r=response(p,81);put(r,5,0xfedcba98);put(r,9,38);put(r,13,length);r.set(digest,17);r.fill(0xee,49);send('responses',r);
   }else throw Error('unexpected opcode '+p[1]);return receipt;
  };return lease;};return c;
 }};
}
