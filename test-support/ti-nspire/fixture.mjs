import assert from 'node:assert/strict';
import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';

export const ASSIGN_ADDRESS=Buffer.from('640040036401400313430001fb6401ff00','hex');
const same=(left,right)=>Buffer.from(left).equals(Buffer.from(right));

export function navnetChecksum(bytes){
  let checksum=0;
  for(const byte of bytes){
    const first=(byte<<8)|(checksum>>>8);checksum&=0xff;
    const second=(((((checksum&0x0f)<<4)^checksum)<<8)&0xffff)>>>0;
    const third=second>>>5;checksum=((third>>>7)^first^second^third)&0xffff;
  }
  return checksum;
}

export function projected(frame){
  const value=Buffer.from(frame);return Buffer.concat([value.subarray(2,12),value.subarray(13)]);
}

export function wireFrame(projectedBytes,{checksum=true}={}){
  const payload=Buffer.from(projectedBytes);assert.ok(payload.length>=14&&payload.length<=267);
  if(checksum){const data=navnetChecksum(payload.subarray(13));payload[8]=data>>>8;payload[9]=data&0xff;}
  const frame=Buffer.concat([Buffer.from([0x54,0xfd]),payload.subarray(0,10),Buffer.from([payload.length-13]),payload.subarray(10)]);
  frame[15]=frame.subarray(0,15).reduce((sum,octet)=>(sum+octet)&0xff,0);return frame;
}
export function outboundFrame(payloadBytes){
  const payload=Buffer.from(payloadBytes);return Buffer.concat([
    Buffer.from([0x54,0xfd]),payload.subarray(0,10),Buffer.from([payload.length-13]),payload.subarray(10)]);
}

export function informationFrame(name='TI-Nspire',sequence=0x31){
  const label=Buffer.from(name,'ascii');assert.equal(label.length,9);
  return wireFrame(Buffer.concat([Buffer.from('6401402064008304000000','hex'),Buffer.from([sequence,0,2]),label,Buffer.from([0])]));
}

export function acknowledgementFor(frame){
  const raw=Buffer.from(frame),host=raw.subarray(8,10),checksum=navnetChecksum(host),sequence=raw[14];
  return wireFrame(Buffer.from([0x64,0,0,0xff,0x64,1,raw[4],raw[5],checksum>>>8,checksum&0xff,0x0a,sequence,0,...host]),{checksum:false});
}

export function addressRequest(){return wireFrame(Buffer.from('0000400300004003ec0f0001d50fec','hex'),{checksum:false});}
export function loginRequest(sequence=0x23,sourceService=Buffer.from([0x40,0x11])){
  return wireFrame(Buffer.from([0x64,1,...sourceService,0x64,0,0x40,0x50,0x39,0x76,0,sequence,0,2,0,0,0,0,0]),{checksum:false});
}
export function disconnect(sequence=0x24,loginService=Buffer.from([0x40,0x12])){
  return wireFrame(Buffer.from([0x64,1,0x40,0xde,0x64,0,0x40,0x50,0,0,0,sequence,0,...loginService]));
}
export function receptionAcknowledgement(sequence=0x25){
  return wireFrame(Buffer.from([0x64,1,0,0xff,0x64,0,0x40,0x20,0,0,0x0a,sequence,0,0x40,0x20]));
}
export function unknownFrame(){return wireFrame(Buffer.from([0x64,1,0x41,0x41,0x64,0,0x40,0x50,0,0,0,0x26,0,1]));}

export function expectedServiceUnavailable(frame){
  const raw=Buffer.from(frame),high=raw[4],low=raw[5],sequence=raw[14];
  return outboundFrame(Buffer.from([0x64,0,0,0xd3,0x64,1,high,low,0x50,0x40,0x0a,sequence,(low+sequence+9)&0xff,0x40,0x50]));
}
export function expectedDisconnectAcknowledgement(frame){
  const raw=Buffer.from(frame),high=raw[16],low=raw[17],sequence=raw[14];
  return outboundFrame(Buffer.from([0x64,0,0,0xff,0x64,1,high,low,0x50,0x40,0x0a,sequence,(high+low+sequence+181)&0xff,0x40,0x50]));
}

export function screenshotTransaction(){
  const compressed=[];for(let index=0;index<300;index++)compressed.push(0x7f,index&0xff);
  return screenshotFromCompressed(Buffer.from(compressed));
}
export function screenshotFromCompressed(compressedBytes){
  const compressed=Buffer.from(compressedBytes),header=Buffer.from([compressed.length>>>24,(compressed.length>>>16)&255,
    (compressed.length>>>8)&255,compressed.length&255,0,0,0,0,1,0x40,0,0xf0,4,0]);
  const logical=Buffer.concat([header,compressed]);
  return screenshotFromLogical(logical);
}
export function screenshotFromLogical(logicalBytes){
  const logical=Buffer.from(logicalBytes),compressed=logical.subarray(14);
  const chunks=[logical.subarray(0,253),logical.subarray(253,506),logical.subarray(506)];
  const frames=chunks.map((chunk,index)=>wireFrame(Buffer.concat([
    Buffer.from([0x64,1,0x40,0x24,0x64,0,0x83,4,0,0,0,0x40+index,0,index===0?1:2]),chunk])));
  return {compressed,logical,frames};
}

export function classifyWrite(bytes){
  const payload=projected(bytes);
  if(same(payload,ASSIGN_ADDRESS))return {kind:'assign'};
  if(payload.subarray(6,8).equals(Buffer.from([0x40,0x20]))&&payload.length===14)return {kind:'information-request',sequence:payload[11]};
  if(payload.subarray(6,8).equals(Buffer.from([0x40,0x24]))&&payload.length===14)return {kind:'screenshot-request',sequence:payload[11]};
  if(payload.subarray(2,4).equals(Buffer.from([0,0xd3])))return {kind:'service-unavailable'};
  if(payload.subarray(2,4).equals(Buffer.from([0,0xff]))&&payload.subarray(8,10).equals(Buffer.from([0x50,0x40])))return {kind:'disconnect-acknowledgement'};
  if(payload.length===15&&payload[10]===0x0a)return {kind:'acknowledgement',service:payload.subarray(6,8).toString('hex')};
  return {kind:'unknown-write',hex:Buffer.from(bytes).toString('hex')};
}

export function expectedBmp(){
  const packed=[];for(let value=0;value<300;value++)for(let count=0;count<128;count++)packed.push(value&0xff);
  return expectedBmpFromPacked(packed);
}
export function expectedBmpFromPacked(packedBytes){
  const packed=Buffer.from(packedBytes);assert.equal(packed.length,38400);
  const header=Buffer.alloc(54);header.write('BM');header.writeUInt32LE(230454,2);header.writeUInt32LE(54,10);
  header.writeUInt32LE(40,14);header.writeInt32LE(320,18);header.writeInt32LE(-240,22);
  header.writeUInt16LE(1,26);header.writeUInt16LE(24,28);header.writeUInt32LE(230400,34);
  const pixels=Buffer.alloc(230400);let out=0;
  for(const value of packed){const high=((value>>>4)&15)*17,low=(value&15)*17;
    pixels.fill(high,out,out+3);pixels.fill(low,out+3,out+6);out+=6;}
  return Buffer.concat([header,pixels]);
}

export function createNspireNative(observe=()=>{},options={}){
  const clock=new VirtualClock(),screen=options.screen??screenshotTransaction(),route=options.route??{spent:false};
  let channel,connection,informationRequests=0,screenAck=0,screenshotRequests=0,seed=0x1195eed;
  const writes=[],deliveryRecords=[];
  const chunks=bytes=>{const value=Buffer.from(bytes);if(options.delivery==='bytewise')return [...value].map(octet=>Buffer.from([octet]));
    if(options.delivery!=='seeded')return [value];const result=[];for(let at=0;at<value.length;){seed=(seed*1664525+1013904223)>>>0;
      const end=Math.min(value.length,at+1+(seed%256));result.push(value.subarray(at,end));at=end;}return result;};
  const enqueue=frames=>queueMicrotask(()=>{const groups=options.coalesceResponses?[Buffer.concat(frames.map(Buffer.from))]:frames.map(Buffer.from);
    for(const group of groups){const parts=chunks(group),frameCount=options.coalesceResponses?frames.length:1;
      deliveryRecords.push({bytes:group.length,frameCount,chunks:parts.map(part=>part.length)});
      observe({kind:'input',bytes:group.length,frameCount,chunks:parts.map(part=>part.length)});for(const part of parts)channel.enqueueReceived(part);}});
  return {clock,writes,screen,route,deliveryRecords,inject(frames){enqueue(frames);},lose(){connection.invalidate({kind:'device-lost'});},async open(){
    connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'device_information',profileId:'usb'});
    channel=connection.channel('main');const acquire=channel.acquire.bind(channel);
    channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
      lease.write=async value=>{const bytes=Buffer.from(value),kind=classifyWrite(bytes);writes.push(bytes);
        observe({kind:'write',classification:kind,bytes:[...bytes]});
        if(options.rejectWrite?.({kind,bytes,writes:[...writes]}))throw new Error('nspire-fixture.reply-write-refused');
        const receipt=await write(value);
        if(kind.kind==='information-request'){
          informationRequests++;const info=informationFrame('TI-Nspire',0x30+informationRequests);
          const selected=options.informationFrames?.({index:informationRequests,info})
            ??(options.simple?[info]:informationRequests===1?[unknownFrame(),loginRequest(),loginRequest(),disconnect(),disconnect(),addressRequest(),addressRequest(),receptionAcknowledgement(),info]
              :[loginRequest(0x33),disconnect(0x34),addressRequest(),info]);
          enqueue(selected);
        }else if(kind.kind==='screenshot-request'){
          screenshotRequests++;screenAck=0;
          if(route.spent)enqueue([receptionAcknowledgement(0x60+screenshotRequests)]);
          else {const selected=options.screenshotFrames?.({screen,index:screenshotRequests})??(options.simple?[screen.frames[0]]
            :[loginRequest(0x43),loginRequest(0x44),disconnect(0x45),disconnect(0x46),addressRequest(),addressRequest(),screen.frames[0]]);
            enqueue(selected);}
        }
        else if(kind.kind==='acknowledgement'&&kind.service==='4024'){
          screenAck++;
          const continuation=options.screenshotContinuation?.({screen,index:screenAck});
          if(continuation!==undefined)enqueue(continuation);
          else if(screenAck<screen.frames.length)enqueue([screen.frames[screenAck]]);else route.spent=true;
        }
        return receipt;};return lease;};return connection;
  }};
}

export function assertQualifiedWrites(writes){
  const kinds=writes.map(classifyWrite),byKind=kind=>kinds.filter(value=>value.kind===kind);
  assert.deepEqual(byKind('information-request').map(value=>value.sequence),[1,1]);
  assert.deepEqual(byKind('screenshot-request').map(value=>value.sequence),[1]);
  assert.equal(byKind('assign').length,6);assert.equal(byKind('service-unavailable').length,2);
  assert.equal(byKind('disconnect-acknowledgement').length,4);
  assert.deepEqual(byKind('acknowledgement').map(value=>value.service),['4020','4020','4024','4024','4024']);
  const expected=[outboundFrame(ASSIGN_ADDRESS),expectedServiceUnavailable(loginRequest()),expectedDisconnectAcknowledgement(disconnect()),
    outboundFrame(ASSIGN_ADDRESS),acknowledgementFor(informationFrame('TI-Nspire',0x31)),expectedDisconnectAcknowledgement(disconnect(0x34)),
    outboundFrame(ASSIGN_ADDRESS),acknowledgementFor(informationFrame('TI-Nspire',0x32)),expectedServiceUnavailable(loginRequest(0x43)),
    expectedDisconnectAcknowledgement(disconnect(0x45)),outboundFrame(ASSIGN_ADDRESS),...screenshotTransaction().frames.map(acknowledgementFor),
    expectedDisconnectAcknowledgement(disconnect(0x55)),outboundFrame(ASSIGN_ADDRESS),outboundFrame(ASSIGN_ADDRESS)];
  const nonRequests=writes.filter(value=>!['information-request','screenshot-request'].includes(classifyWrite(value).kind));
  assert.deepEqual(nonRequests.map(value=>value.toString('hex')),expected.map(value=>value.toString('hex')));
  assert.ok(kinds.every(value=>value.kind!=='unknown-write'));
  return {writes:writes.length,kinds:kinds.map(value=>value.kind)};
}
