import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {VirtualClock} from '../clock.ts';
import {MockTransport} from '../../packages/transport-mock/src/index.ts';
import {splitEvoCollectedFrames} from '../../packages/lua-vm/test/evo-collected-frames.mjs';

const DYNAMIC_REQUEST_HEX=[
  '013020537e3020402d2359317e2e22354d3e0d',
  '01492146686830312f6765742f686830312f696e662f7265733f6e616d653d64796e616d6963696e666f240d',
  '012c2241222242383121314020500d','0124234468560d','0123245a430d','012325422c0d',
];
const same=(left,right)=>Buffer.from(left).equals(Buffer.from(right));
const sum=bytes=>bytes.reduce((total,octet)=>total+octet,0);
const checksum=(length,sequence,command,body)=>{
  const value=(length+sequence+command+sum(body))&0xff;
  return 0x20+(((value&0x3f)+(value>>6))&0x3f);
};
function acknowledgement(frame){
  const command=String.fromCharCode(frame[3]);
  let last,body;
  if(frame[1]===0x20){const count=(frame[4]-0x20)*95+(frame[5]-0x20);last=count+6;}
  else last=4+(frame[1]-0x23);
  const raw=frame.subarray(4,last);
  body=command==='S'||command==='F'?raw:command==='A'?Uint8Array.of(0x59):new Uint8Array();
  const length=0x23+body.length,result=new Uint8Array(body.length+6);
  result.set([1,length,frame[2],0x59],0);result.set(body,4);
  result.set([checksum(length,frame[2],0x59,body),0x0d],4+body.length);
  return result;
}
function transactions(frames){
  const result=[];let current;
  for(const frame of frames){const command=String.fromCharCode(frame[3]);
    if(command==='S'){assert.equal(current,undefined);current=[];}
    if(current)current.push(frame);
    if(command==='B'&&current){result.push(current);current=undefined;}
  }
  assert.equal(current,undefined);return result;
}
export async function retainedStimulus(){
  const root=new URL('./fixtures/',import.meta.url);
  const screenIn=splitEvoCollectedFrames(await readFile(new URL('evo-screen3-one.in.bin',root)));
  const screenOut=splitEvoCollectedFrames(await readFile(new URL('evo-screen3.out.bin',root)));
  const sessionIn=splitEvoCollectedFrames(await readFile(new URL('evo-session.in.bin',root)));
  const screenRequest=screenOut.slice(0,6),screenAcknowledgements=screenOut.slice(6,6+screenIn.length);
  assert.equal(screenRequest.map(frame=>String.fromCharCode(frame[3])).join(''),'SFADZB');
  assert.equal(screenAcknowledgements.length,screenIn.length);
  const sessionTransactions=transactions(sessionIn),wrongScreenResponse=sessionTransactions.find(frames=>frames.filter(frame=>frame[3]===0x44).length>1);
  assert.ok(wrongScreenResponse);
  return {dynamicRequest:DYNAMIC_REQUEST_HEX.map(hex=>Buffer.from(hex,'hex')),
    dynamicResponse:sessionTransactions[0],screenRequest,screenResponse:screenIn,screenAcknowledgements,
    wrongScreenResponse,wrongScreenAcknowledgements:wrongScreenResponse.map(acknowledgement)};
}
export function retainedExchange(stimulus,observe=()=>{}){
  let stage='dynamic-request',member=0,responseFrames,responseAcknowledgements,responseIndex=0;
  const begin=(frames,acks)=>{responseFrames=frames;responseAcknowledgements=acks;responseIndex=0;stage='response';return [frames[0]];};
  return bytes=>{
    observe({kind:'write',stage,index:stage==='response'?responseIndex:member,bytes:[...bytes]});
    if(stage==='dynamic-request'){
      assert.ok(same(bytes,stimulus.dynamicRequest[member]),`dynamic request ${member} differs`);member++;
      if(member===6){member=0;return begin(stimulus.dynamicResponse,stimulus.dynamicResponse.map(acknowledgement));}
      return [];
    }
    if(stage==='screen-request'){
      assert.ok(same(bytes,stimulus.screenRequest[member]),`screen request ${member} differs`);member++;
      if(member===6){member=0;return begin(stimulus.screenResponse,stimulus.screenAcknowledgements);}
      return [];
    }
    if(stage==='response'){
      assert.ok(same(bytes,responseAcknowledgements[responseIndex]),`acknowledgement ${responseIndex} differs`);responseIndex++;
      if(responseIndex<responseFrames.length)return [responseFrames[responseIndex]];
      stage=responseFrames===stimulus.dynamicResponse?'screen-request':'complete';member=0;return [];
    }
    assert.fail(`unexpected write in ${stage}`);
  };
}
export async function nativeOptions(caseName,observe){
  const stimulus=await retainedStimulus(),clock=new VirtualClock();let channel,closed=false,stage='dynamic-request',member=0;
  let responseFrames,responseAcknowledgements,responseIndex;
  const offer=bytes=>{observe({kind:'offer',stage,index:responseIndex,bytes:[...bytes]});channel.enqueueReceived(Uint8Array.from(bytes));};
  const beginResponse=(frames,acks)=>{responseFrames=frames;responseAcknowledgements=acks;responseIndex=0;stage='response';offer(frames[0]);};
  return {clock,async open(){
    const connection=new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'screenshot',profileId:'serial'});
    channel=connection.channel('main');const acquire=channel.acquire.bind(channel),close=connection.close.bind(connection);
    connection.close=async(...args)=>{closed=true;observe({kind:'close'});return close(...args);};
    channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
      lease.write=async bytes=>{observe({kind:'write',stage,index:member,closed,bytes:[...bytes]});const receipt=await write(bytes);
        if(stage==='dynamic-request'){
          assert.ok(same(bytes,stimulus.dynamicRequest[member]),`dynamic request ${member} differs`);member++;
          if(member===6){member=0;beginResponse(stimulus.dynamicResponse,stimulus.dynamicResponse.map(acknowledgement));}
        }else if(stage==='screen-request'){
          assert.ok(same(bytes,stimulus.screenRequest[member]),`screen request ${member} differs`);member++;
          if(member===6){member=0;beginResponse(stimulus.screenResponse,stimulus.screenAcknowledgements);}
        }else if(stage==='response'){
          assert.ok(same(bytes,responseAcknowledgements[responseIndex]),`acknowledgement ${responseIndex} differs`);
          responseIndex++;
          if(responseIndex<responseFrames.length)offer(responseFrames[responseIndex]);
          else {stage=responseFrames===stimulus.dynamicResponse?'screen-request':'complete';member=0;}
        }else assert.fail(`unexpected write in ${stage}`);
        return receipt;
      };return lease;};observe({kind:'open',caseName});return connection;
  }};
}
