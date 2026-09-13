import { readFile } from 'node:fs/promises';
import { buildPdpkg } from '../../../../packages/contracts/src/pdpkg.ts';
import { retainedWire } from '../../../../test-support/ti84-plus-ce/replay-wire.mjs';
import {retainedExchange,retainedStimulus} from '../../../../test-support/ti-84-evo/fixture.mjs';
import {classifyWrite,informationFrame,screenshotTransaction} from '../../../../test-support/ti-nspire/fixture.mjs';

const experiment=new URL('../../../../test-support/',import.meta.url);

export async function migratedPackage(directory,names){
  const members=await Promise.all(names.map(async member=>{const file=typeof member==='string'?member:member.file;
    return {logicalName:typeof member==='string'?member:member.logicalName,sourceBytes:await readFile(new URL(directory+'/'+file,experiment))};}));
  return (await buildPdpkg(members)).archive;
}

export async function migratedBrowserTransport(kind){
  if(kind==='device-1'){const port=new ReactiveSerialPort(6790,29987,device1Exchange());return {serial:{async getPorts(){return [port];}}};}
  if(kind==='device-2'){const port=new ReactiveSerialPort(1155,14155,device2Exchange());return {serial:{async getPorts(){return [port];}}};}
  if(kind==='device-3'){const port=new ReactiveSerialPort(1027,24592,device3Exchange());return {serial:{async getPorts(){return [port];}}};}
  if(kind==='ce'){
    const {frames}=await retainedWire();const device=new ReactiveUsbDevice(ceExchange(frames));
    return {usb:{async getDevices(){return [device];},addEventListener(){},removeEventListener(){}}};
  }
  if(kind==='evo'){
    const port=new ReactiveSerialPort(1105,57368,retainedExchange(await retainedStimulus()));
    return {serial:{async getPorts(){return [port];}}};
  }
  if(kind==='nspire'){
    const device=new ReactiveUsbDevice(nspireExchange(),{productId:57362,productName:'TI-Nspire(tm) Handheld',
      deviceClass:255,interfaceNumber:0,inputEndpoint:1,outputEndpoint:1});
    return {usb:{async getDevices(){return [device];},addEventListener(){},removeEventListener(){}}};
  }
  throw new Error('unknown migrated browser fixture');
}

class ReactiveSerialPort extends EventTarget{
  readable=null;writable=null;#controller;#vendor;#product;#exchange;
  constructor(vendor,product,exchange){super();this.#vendor=vendor;this.#product=product;this.#exchange=exchange;}
  getInfo(){return {usbVendorId:this.#vendor,usbProductId:this.#product};}
  async open(){
    this.readable=new ReadableStream({start:controller=>{this.#controller=controller;}});
    this.writable=new WritableStream({write:bytes=>{const replies=this.#exchange(Buffer.from(bytes));
      queueMicrotask(()=>{for(const reply of replies)this.#controller.enqueue(Uint8Array.from(reply));});}});
  }
  async close(){this.readable=null;this.writable=null;}
}

class ReactiveUsbDevice{
  vendorId;productId;deviceClass;productName;manufacturerName='TI';serialNumber='F106';opened=false;
  #exchange;#pending=[];#queued=[];#configuration;
  constructor(exchange,options={}){this.#exchange=exchange;this.vendorId=1105;this.productId=options.productId??57352;
    this.deviceClass=options.deviceClass??255;this.productName=options.productName??'TI-84 Plus CE';
    const alternate={alternateSetting:0,endpoints:[
      {endpointNumber:options.inputEndpoint??1,direction:'in',type:'bulk',packetSize:64},
      {endpointNumber:options.outputEndpoint??2,direction:'out',type:'bulk',packetSize:64}]};
    this.#configuration={configurationValue:1,interfaces:[{interfaceNumber:options.interfaceNumber??0,claimed:false,alternate,alternates:[alternate]}]};}
  get configuration(){return this.#configuration;}
  async open(){this.opened=true;}async close(){this.opened=false;this.#flushClosed();}
  async selectConfiguration(){}async claimInterface(){this.#configuration.interfaces[0].claimed=true;}
  async selectAlternateInterface(){}async releaseInterface(){this.#configuration.interfaces[0].claimed=false;this.#flushClosed();}
  async controlTransferIn(){return {status:'ok',data:new DataView(Uint8Array.of(0).buffer)};}
  async controlTransferOut(_setup,data){return {status:'ok',bytesWritten:data?.byteLength??0};}
  transferIn(_endpointNumber,length){return new Promise(resolve=>{this.#pending.push({length,resolve});this.#pump();});}
  async transferOut(_endpointNumber,data){const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
    for(const reply of this.#exchange(bytes))this.#queued.push(Uint8Array.from(reply));this.#pump();
    return {status:'ok',bytesWritten:bytes.length};}
  #pump(){while(this.#pending.length&&this.#queued.length){const pending=this.#pending.shift(),head=this.#queued[0];
    const bytes=head.subarray(0,pending.length);if(bytes.length===head.length)this.#queued.shift();else this.#queued[0]=head.subarray(bytes.length);
    pending.resolve({status:'ok',data:new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)});}}
  #flushClosed(){for(const pending of this.#pending.splice(0))pending.resolve({status:'ok',data:new DataView(new ArrayBuffer(0))});}
}

function device1Exchange(){const replies=new Map([['50534541524348','06503133474d5253'],['503133474d5253','06'],
  ['02','ffffffffffffffff'],['06','06'],['5200000000','5700000000']]);return bytes=>{
    const reply=replies.get(bytes.toString('hex'));if(!reply)throw Error('unrequested device-1 browser write');return [Buffer.from(reply,'hex')];};}
function device2Exchange(){return bytes=>{if(bytes.toString()==='*IDN?\r\n')return [Buffer.from('D2-LABS,D2-MON,1234ABCD,1.0\r\n')];
  if(bytes.toString()==='CONF:RATE?\r\n')return [Buffer.from('1000\r\n')];throw Error('unrequested device-2 browser write');};}
function ceExchange(frames){let stage=0,next=0;return bytes=>{const hex=bytes.toString('hex');
  if(stage===0&&hex==='000000040100000400'){stage=1;return [frames[0]];}if(stage===1&&hex==='00000010040000000a0001000300010000000007d0'){stage=2;return frames.slice(1,3);}
  if(stage===2&&hex==='0000000205e000'){stage=3;return [];}if(stage===3&&hex==='0000000a0400000004000700010022'){stage=4;next=5;return frames.slice(3,5);}
  if(stage===4&&hex==='0000000205e000')return next<frames.length?[frames[next++]]:[];throw Error('unrequested CE browser write');};}
function device3Exchange(){return bytes=>{if(bytes.length<10||bytes[6]!==1||bytes[7]!==1)throw Error('unrequested device-3 browser write');
  const body=Buffer.alloc(31);body[0]=2;body[1]=1;body[2]=bytes[8];body[3]=bytes[9];body[5]=1;body[6]=0x41;
  body[8]=1;body[9]=2;body[10]=3;body[15]=1;body[27]=3;return [device3Frame(body)];};}
function nspireExchange(){const screen=screenshotTransaction();let next=0;return bytes=>{
  const write=classifyWrite(bytes);
  if(write.kind==='assign'||(write.kind==='acknowledgement'&&write.service==='4020'))return [];
  if(write.kind==='information-request')return [informationFrame('TI-Nspire',0x31)];
  if(write.kind==='screenshot-request'){next=0;return [screen.frames[next++]];}
  if(write.kind==='acknowledgement'&&write.service==='4024')return next<screen.frames.length?[screen.frames[next++]]:[];
  throw Error('unrequested Nspire browser write: '+write.kind);
};}
function device3Frame(body){const framed=Buffer.alloc(body.length+10);framed.set([0xa5,0x5a,0xd3,1,body.length&255,body.length>>>8]);framed.set(body,6);
  framed.writeUInt32LE(crc32c(framed.subarray(3,framed.length-4)),framed.length-4);return framed;}
function crc32c(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0x82f63b78:0);}return(value^0xffffffff)>>>0;}
