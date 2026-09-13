// Independent synthetic device model. Do not import candidate algorithms here.
// The legacy table CRC and literal device-3 field offsets cross-check the new
// bit-at-a-time codec. No claim that these generated packets are hardware logs.
function crc32c(bytes) {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0x82f6_3b78);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}
const check=(condition,message)=>{if(!condition) throw new Error(message);};
const dv=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const word=(b,at)=>dv(b).getUint32(at,true);
const set=(b,at,n)=>dv(b).setUint32(at,n,true);
export const original=Uint8Array.from({length:6144},(_,i)=>i&255);
const digest=Uint8Array.of(152,138,209,226,113,121,133,44,132,28,51,47,211,250,245,159,4,212,165,219,80,1,96,12,207,146,72,212,138,53,66,199);
export function oracleFrame(payload) {
  const bytes=new Uint8Array(payload.length+10); bytes.set([165,90,211,1,payload.length&255,payload.length>>8]); bytes.set(payload,6);
  set(bytes,bytes.length-4,crc32c(bytes.subarray(3,-4))); return bytes;
}
export function oraclePayload(bytes) {
  check(bytes[0]===165 && bytes[1]===90 && bytes[2]===211 && bytes[3]===1 && dv(bytes).getUint16(4,true)+10===bytes.length,"oracle TX envelope");
  check(word(bytes,bytes.length-4)===crc32c(bytes.subarray(3,-4)),"oracle TX CRC"); return bytes.slice(6,-4);
}
function response(request,size) {const p=new Uint8Array(size);p.set([2,request[1],request[2],request[3],0]);return p;}
export function binaryDevice(native,variant) {
  let pending=new Uint8Array(), tail=Promise.resolve(), deliveries=0, committed=0, buffered=0, volatile=0;
  let receiving=false, failure, readRequests=[], dataTokens=new Set();
  const writes=[], target=new Uint8Array(6144), volatileImage=new Uint8Array(6144), ingress=[], requests=[], windows=[];
  const inject=bytes=> {
    const copy=bytes.slice();
    tail=tail.then(async()=> {
      for(let offset=0;offset<copy.length;offset+=variant==="fragmented"?17:256) {
        const chunk=copy.slice(offset,offset+(variant==="fragmented"?17:256)); ingress.push(...chunk);
        const expected=++deliveries;
        native.inject([...chunk]); await native.wait(e=>e.kind==="binary-delivered" && e.sequence===expected);
      }
    }).catch(cause=>{failure=cause;});
    return tail;
  };
  const send=payload=>inject(oracleFrame(payload));
  const accept=packet=> {
    const p=oraclePayload(packet); requests.push([...p]); check(p[0]===1,"oracle request kind");
    if(p[1]===0x30) {
      check(p.length===5 && p[4]===0,"oracle QUERY fields");
      const r=response(p,117); set(r,17,0xfedcba98);set(r,21,38);set(r,25,6144);set(r,29,committed);set(r,33,volatile);
      r.set(digest,37);r.set([0,128,255,1,254,2,253,3,252,4,251,5],101);r[113]=buffered;
      send(r);
    } else if(p[1]===0x31) {
      check(p.length===56 && word(p,8)===6144 && digest.every((b,i)=>b===p[12+i]),"oracle BEGIN source identity");
      const r=response(p,25);set(r,5,0xfedcba98);set(r,9,38);set(r,13,committed);r[21]=8;
      dataTokens=new Set();buffered=0;receiving=true;send(r);
    } else if(p[1]===0x32) {
      const offset=word(p,8), length=dv(p).getUint16(12,true), token=dv(p).getUint16(2,true);
      check(receiving && word(p,4)===0xfedcba98 && p.length===length+14 && length>0 && length<=768 && offset+length<=6144,"oracle DATA fields");
      check(offset===volatile,"oracle DATA source offset sequence");
      check(!dataTokens.has(token) && dataTokens.size<8,"oracle pipelining/token bound");dataTokens.add(token);
      check(p.subarray(14).every((b,i)=>b===original[offset+i]),"oracle DATA bytes changed");
      volatileImage.set(p.subarray(14),offset);volatile=offset+length;buffered++;
      // These are accepted volatile bytes. Only window() below commits them.
    } else if(p[1]===0x33) {
      check(committed===6144,"oracle FINALIZE before committed settlement");
      const r=response(p,81);set(r,5,0xfedcba98);set(r,9,38);set(r,13,6144);r.set(digest,17);send(r);
    } else if(p[1]===0x35) {
      check(committed===6144 && p.length===16,"oracle READ before completion");
      readRequests.push(p);
      if(readRequests.length===6) {
        // Reverse responses: collection must correlate tokens, not FIFO replies.
        for(const q of readRequests.reverse()) {
          const offset=word(q,8)-64,size=dv(q).getUint16(12,true);check(size===1024 && offset>=0 && offset+size<=6144,"oracle READ range");
          const r=response(q,1035);set(r,5,offset+64);dv(r).setUint16(9,size,true);r.set(target.subarray(offset,offset+size),11);
          if(variant==="bad-readback" && offset===0) r[11+255]^=1;
          if(variant==="bad-token" && offset===5120) r[2]^=0x40;
          const encoded=oracleFrame(r);if(variant==="bad-crc" && offset===5120) encoded[encoded.length-1]^=1;
          inject(encoded);
        }
        readRequests=[];
      }
    } else throw new Error("oracle unknown request");
  };
  const add=native.add;
  native.add=event=> {
    add(event);
    if(event.kind!=="write") return;
    try {
      check(Array.isArray(event.value) && event.value.length<=256,"wire did not carry bounded octets");
      writes.push(event.value);
      const joined=new Uint8Array(pending.length+event.value.length);joined.set(pending);joined.set(event.value,pending.length);pending=joined;
      while(pending.length>=6) {
        const length=dv(pending).getUint16(4,true)+10;if(pending.length<length) break;
        const packet=pending.slice(0,length);pending=pending.slice(length);accept(packet);
      }
    } catch(cause) {failure=cause;}
  };
  return {writes,requests,ingress,target,windows,
    get failure(){return failure;},get accepted(){return volatile;},get buffered(){return buffered;},
    async flush(){await tail;if(failure) throw failure;},
    async alarm(){const p=new Uint8Array(32);p.set([3,128,0,0]);p[4]=255;await send(p);},
    async window(offset) {
      committed=offset;target.set(volatileImage.subarray(0,offset));windows.push(offset);
      const p=new Uint8Array(28);p.set([3,129,0,0]);set(p,4,0xfedcba98);set(p,8,38);set(p,12,offset);set(p,16,volatile);p[24]=buffered;p[25]=8-buffered;
      await send(p);
    },
    quiesce(){volatile=committed;volatileImage.fill(0,committed);buffered=0;},
  };
}
