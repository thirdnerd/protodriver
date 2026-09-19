import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { runPdr } from '../src/pdr.ts';
import { createNodeAuthoredAcquisition } from '../src/authored-acquisition.ts';
import { assertStockNodeWorkerTransport } from '../src/authored-worker-session.ts';
import { buildPdpkg } from '../../../packages/contracts/src/pdpkg.ts';
import { MockTransport } from '../../../packages/transport-mock/src/index.ts';
import { admitAuthoredDescription } from '../../../packages/core/src/authored-admission.ts';
import { DEFAULT_AUTHORED_POLL_POLICY, grantPollPlans, grantRequiredPollPlans, pollPlans } from '../../../packages/core/src/authored-poll.ts';
import { retainedWire, compareImage } from '../../../test-support/ti84-plus-ce/replay-wire.mjs';
import {retainedExchange as evoExchange,retainedStimulus as evoStimulus} from '../../../test-support/ti-84-evo/fixture.mjs';
import {compareEvoBmpToVendorPng} from '../../../test-support/ti-84-evo/oracle.mjs';

const experiment = new URL('../../../test-support/', import.meta.url);
const authoredWorker = new URL('./fixtures/authored-migrated-worker.ts', import.meta.url);
const serial = (modes=['main']) => ({modes,acquisitionFilters:[{transport:'serial',vendorId:6790,productId:29987}],
  transport:{kind:'serial',baudRate:57600,dataBits:8,parity:'none',stopBits:1,flowControl:'none'},
  channels:[{id:'main',protocolDuplex:'half-duplex'}],
  lifecycle:{openingDrainQuietMs:300,postTerminationSilence:{minimumMs:3000,afterAbnormalTermination:true,afterModeExit:true}}});
function description() { return {apiVersion:'device/v2',id:'request',modes:['main'],profiles:['serial'],connectionProfiles:{serial:serial()},
  operations:[{id:'noop',title:'Noop',binding:'noop',arguments:{},result:{kind:'none'},risk:'read-only',repeatability:'safe-to-repeat',locks:[],requires:[],availability:{modes:['main'],profiles:['serial']}}]}; }
async function setup(t,directory,names) {
  const root=await mkdtemp(join(tmpdir(),'f88-pdr-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const members=await Promise.all(names.map(async member=>{const file=typeof member==='string'?member:member.file;
    return {logicalName:typeof member==='string'?member:member.logicalName,sourceBytes:await readFile(new URL(directory+'/'+file,experiment))};}));
  const {archive}=await buildPdpkg(members);
  const path=join(root,'module.pdpkg');await writeFile(path,archive);
  let text='';const output=new Writable({write(chunk,encoding,done){text+=chunk;done();}});
  return {root,path,io:{input:[],output,error:output},text:()=>text};
}
function candidate(profile,modeId,clock,exchange,observed) {
  return {candidate:{candidateId:'mock:selected',matchedProfileId:profile.id,displayName:'selected fixture',identity:{transport:'mock',stableKeyAssurance:'none'}},
    async open(){observed.opens++;const connection=new MockTransport(clock).openConnection({modeId,profileId:profile.id,identity:{transport:'mock',stableKeyAssurance:'none'}});
      const channel=connection.channel('main'),acquire=channel.acquire.bind(channel);
      channel.acquire=async(...args)=>{const lease=await acquire(...args),write=lease.write.bind(lease);
        lease.write=async bytes=>{const receipt=await write(bytes);observed.writes.push(Buffer.from(bytes).toString('hex'));
          for(const response of exchange(Buffer.from(bytes)))channel.enqueueReceived(response);return receipt;};return lease;};
      return connection;}};
}

test('transport admission rejects hidden matchers and incompatible physical requests',()=>{
  // Unique regression: an ignored request field would silently weaken host policy.
  assert.ok(admitAuthoredDescription(description(),['noop']).connectionProfiles.serial);
  for(const mutate of [d=>d.connectionProfiles.serial.acquisitionFilters[0].path='/dev/unrequested',
    d=>d.connectionProfiles.serial.transport.kind='network',d=>d.connectionProfiles.serial.modes=['missing'],
    d=>d.connectionProfiles.extra=serial(),d=>d.connectionProfiles.serial.lifecycle.postTerminationSilence.afterModeExit='yes',
    d=>d.channelRoles={serial:{request:'missing',response:'main',event:'main'}}]){
    const d=description();mutate(d);assert.throws(()=>admitAuthoredDescription(d,['noop']),e=>e.code==='authored.declaration.invalid');
  }
});

test('required poll cadence is explained, cross-checked, and separately host-bounded',async()=>{
  // Unique regression: weakening every poll to admit device-1, or trusting an unexplained sub-second request.
  const constrained=(interval=200,gap=300)=>{const d=description();
    d.operations[0].result={kind:'value',type:{kind:'string'}};
    d.maintenance=[{kind:'poll',mode:'main',operation:'noop',intervalMs:interval,
      maximumInterTransactionGapMs:gap,failureBackoffMs:interval,suspendWhileLocksHeld:[],
      timing:{kind:'idle-reset',activity:'foreground-lifecycle'}}];return d;};
  const admitted=admitAuthoredDescription(constrained(),['noop']),plans=pollPlans(admitted);
  const required=grantRequiredPollPlans(plans,DEFAULT_AUTHORED_POLL_POLICY,
    {minimumIntervalMs:200,maximumNominalPollsPerSecond:5});
  assert.deepEqual(required,{...DEFAULT_AUTHORED_POLL_POLICY,minimumIntervalMs:200,refillEveryMs:200});
  assert.deepEqual(grantPollPlans(plans,required),required);
  const unexplained=constrained();delete unexplained.maintenance[0].maximumInterTransactionGapMs;
  assert.throws(()=>grantRequiredPollPlans(pollPlans(admitAuthoredDescription(unexplained,['noop'])),DEFAULT_AUTHORED_POLL_POLICY,
    {minimumIntervalMs:200,maximumNominalPollsPerSecond:5}),/lacks a consistent maximum/);
  for(const mutate of [d=>d.maintenance[0].maximumInterTransactionGapMs=200,d=>delete d.maintenance[0].timing]){
    const d=constrained();mutate(d);assert.throws(()=>admitAuthoredDescription(d,['noop']),e=>e.code==='authored.declaration.invalid');
  }
  assert.throws(()=>grantRequiredPollPlans(pollPlans(admitAuthoredDescription(constrained(199),['noop'])),DEFAULT_AUTHORED_POLL_POLICY,
    {minimumIntervalMs:200,maximumNominalPollsPerSecond:5}),/below host grant/);
  let enumerations=0;
  const acquire=createNodeAuthoredAcquisition(async()=>{enumerations++;return [];});
  await assert.rejects(acquire(admitAuthoredDescription(constrained(199),['noop']),{}),/below host grant/);
  assert.equal(enumerations,0);
  const ordinary=constrained(5000,6000);
  assert.equal(grantRequiredPollPlans(pollPlans(admitAuthoredDescription(ordinary,['noop'])),DEFAULT_AUTHORED_POLL_POLICY,
    {minimumIntervalMs:200,maximumNominalPollsPerSecond:5}),DEFAULT_AUTHORED_POLL_POLICY);
});

test('device-1 pdr carries half-duplex lifecycle and executes ping after its real entry',async t=>{
  // Unique regression: serial migration losing opening drain/silence or half-duplex policy.
  const c=await setup(t,'device-1',['device.lua','channel-wire.lua','channel-layout.lua']);
  const observed={opens:0,writes:[]},replies=new Map([
    ['50534541524348','06503133474d5253'],['503133474d5253','06'],['02','ffffffffffffffff'],['06','06'],['5200000000','5700000000']]);
  const acquire=createNodeAuthoredAcquisition(async(profile,mode,clock)=>{
    assert.deepEqual(profile,{id:'serial',...serial(['transfer'])});
    return [candidate(profile,mode,clock,bytes=>{const reply=replies.get(bytes.toString('hex'));assert.ok(reply,'unrequested write');return [Buffer.from(reply,'hex')];},observed)];
  });
  await runPdr(['run',c.path,'ping','--json'],c.io,{authoredAcquisition:acquire});
  assert.equal(observed.opens,1);assert.deepEqual(observed.writes,['50534541524348','503133474d5253','02','06','5200000000','06']);
  assert.deepEqual(JSON.parse(c.text()).result,{address:0,length:0});
});

test('device-2 pdr preserves both modes on one profile and refuses implicit mode selection',async t=>{
  // Unique regression: flattening a single physical profile into a single protocol mode.
  const c=await setup(t,'device-2',['device.lua']);let enumerations=0;
  const observed={opens:0,writes:[]};
  const acquire=createNodeAuthoredAcquisition(async(profile,mode,clock)=>{
    enumerations++;assert.deepEqual(profile.modes,['interactive','silent']);assert.equal(mode,'silent');
    assert.deepEqual(profile.acquisitionFilters,[{transport:'serial',vendorId:1155,productId:14155}]);
    assert.equal(profile.transport.baudRate,115200);assert.equal(profile.channels[0].protocolDuplex,'full-duplex');
    return [candidate(profile,mode,clock,bytes=>{assert.equal(bytes.toString(),'*IDN?\r\n');return [Buffer.from('D2-LABS,D2-MON,1234ABCD,1.0\r\n')];},observed)];
  });
  await assert.rejects(runPdr(['run',c.path,'get_device_info'],c.io,{authoredAcquisition:acquire}),/--mode/);
  assert.equal(enumerations,0);
  await runPdr(['run',c.path,'get_device_info','--mode','silent','--json'],c.io,{authoredAcquisition:acquire});
  assert.equal(enumerations,1);assert.equal(observed.opens,1);assert.equal(observed.writes.length,2);
  assert.deepEqual(JSON.parse(c.text()).result,{identity:'1234ABCD,1.0'});
});

test('CE pdr preserves USB endpoint orientation and delivers a retained screenshot file',async t=>{
  // Unique regression: swapped USB endpoints or lost file-result delivery at the actual CLI front door.
  const c=await setup(t,'ti84-plus-ce/module',['device.lua','directlink.lua','bmp.lua']);
  const {frames,fixture}=await retainedWire(),observed={opens:0,writes:[]};let stage=0,next=0;
  const acquire=createNodeAuthoredAcquisition(async(profile,mode,clock)=>{
    assert.deepEqual(profile.acquisitionFilters,[{transport:'usb',vendorId:1105,productId:57352,usbClass:255}]);
    assert.equal(profile.requiredProductName,'TI-84 Plus CE');assert.equal(profile.transport.configurationValue,'preserve-active');
    assert.equal(profile.transport.interfaceNumber,0);assert.equal(profile.transport.alternateSetting,0);
    assert.deepEqual(profile.transport.channels,[{id:'main',input:{endpointNumber:1,transferType:'bulk',maximumPacketBytes:{full:64}},output:{endpointNumber:2,transferType:'bulk',maximumPacketBytes:{full:64}}}]);
    return [candidate(profile,mode,clock,bytes=>{
      const hex=bytes.toString('hex');
      if(stage===0){assert.equal(hex,'000000040100000400');stage=1;return [frames[0]];}
      if(stage===1){assert.equal(hex,'00000010040000000a0001000300010000000007d0');stage=2;return [Buffer.concat(frames.slice(1,3))];}
      if(stage===2){assert.equal(hex,'0000000205e000');stage=3;return [];}
      if(stage===3){assert.equal(hex,'0000000a0400000004000700010022');stage=4;next=5;return [Buffer.concat(frames.slice(3,5))];}
      assert.equal(stage,4);assert.equal(hex,'0000000205e000');if(next<frames.length)return [frames[next++]];stage=5;return [];
    },observed)];
  });
  const output=join(c.root,'screen.bmp');
  await runPdr(['run',c.path,'capture_screenshot','--save-result',output,'--json'],c.io,{authoredAcquisition:acquire});
  assert.equal(stage,5);assert.equal(observed.opens,1);compareImage(await readFile(output),frames,fixture);
});

test('migrated authored pdr help renders the admitted surface instead of a private summary',async t=>{
  // Unique regression: either authored-v2 help path bypassing the shared rich renderer used by generated modules.
  const cases=[
    {directory:'device-1',members:['device.lua','channel-wire.lua','channel-layout.lua'],operation:'ping',
      top:['d1-chan (d1-chan, device/v2)','Modes:','transfer','Tasks:','ping','read-only; safe-to-repeat; value'],
      operationHelp:['d1-chan — ping','Risk: read-only','Repeatability: safe-to-repeat','Result:\n  value']},
    {directory:'device-2',members:['device.lua'],operation:'query_errors',
      top:['device-2-authored (device-2-authored, device/v2)','interactive','silent','Drain error history','destructive; not-repeatable; value'],
      operationHelp:['device-2-authored — Drain error history','Risk: destructive','Repeatability: not-repeatable','Result:\n  value']},
    {directory:'ti84-plus-ce/module',members:['device.lua','directlink.lua','bmp.lua'],operation:'capture_screenshot',
      top:['ti84-plus-ce (ti84-plus-ce, device/v2)','screenshot','Capture screenshot','read-only; safe-to-repeat; file image/bmp .bmp'],
      operationHelp:['ti84-plus-ce — Capture screenshot','Risk: read-only','Repeatability: safe-to-repeat','file (image/bmp, .bmp)',
        'Current display, 320 by 240 RGB565','declared bytes 153666..153666','--save-result <path.bmp>']},
    {directory:'device-3',members:[{file:'device3.lua',logicalName:'device.lua'}],operation:'write_image',
      top:['D3LINK (device-3-authored, device/v2)','Inspect a D3LINK implementation','Application protocol',
        'Telemetry and bulk progress','Write image','Write a source image','destructive; not-repeatable; no result'],
      operationHelp:['D3LINK — Write image','Write a source image','Risk: destructive','Repeatability: not-repeatable','Source image',
        'source identity is bound','Image length','Number of source-image bytes','Result:\n  (no result)']},
    {directory:'ti-84-evo',members:['device.lua','evo.lua','screen.lua','cbor.lua'],operation:'capture_screen',
      top:['TI-84 Evo (ti-84-evo, device/v2)','Acquire the current calculator display','Screenshot','320 by 240','Capture screen',
        'Read the current display','read-only; safe-to-repeat; file image/bmp .bmp'],
      operationHelp:['TI-84 Evo — Capture screen','Read the current display','Risk: read-only','Repeatability: safe-to-repeat',
        'file (image/bmp, .bmp)','Current display, 320 by 240 RGB565','declared bytes 153666..153666','--save-result <path.bmp>']},
  ];
  for(const fixture of cases){
    const c=await setup(t,fixture.directory,fixture.members);let acquisitions=0;
    const options={authoredAcquisition:async()=>{acquisitions++;return [];}};
    await runPdr(['run',c.path],c.io,options);const top=c.text();
    await runPdr(['run',c.path,fixture.operation,'--help'],c.io,options);const operationHelp=c.text().slice(top.length);
    assert.equal(acquisitions,0);
    assert.deepEqual(fixture.top.filter(value=>!top.includes(value)),[],`${fixture.directory} admitted presentation must survive top-level help`);
    assert.deepEqual(fixture.operationHelp.filter(value=>!operationHelp.includes(value)),[],`${fixture.directory} admitted presentation must survive operation help`);
  }
});

test('Evo pdr preserves its four-file CDC-ACM declaration and retained screenshot bytes',async t=>{
  // Unique regression: Evo siblings admitting while raw Kermit writes or the directly saved BMP disappear at the CLI front door.
  const c=await setup(t,'ti-84-evo',['device.lua','evo.lua','screen.lua','cbor.lua']);
  const stimulus=await evoStimulus(),observed={opens:0,writes:[]};let wrong=false;
  const acquire=createNodeAuthoredAcquisition(async(profile,mode,clock)=>{
    assert.deepEqual(profile.acquisitionFilters,[{transport:'serial',vendorId:1105,productId:57368}]);
    assert.deepEqual(profile.transport,{kind:'serial',baudRate:9600,dataBits:8,parity:'none',stopBits:1,flowControl:'none'});
    assert.deepEqual(profile.channels,[{id:'main',protocolDuplex:'full-duplex'}]);
    assert.deepEqual(profile.lifecycle,{openingDrainQuietMs:0,
      postTerminationSilence:{minimumMs:0,afterAbnormalTermination:false,afterModeExit:false}});
    const selected=wrong?{...stimulus,screenResponse:stimulus.wrongScreenResponse,
      screenAcknowledgements:stimulus.wrongScreenAcknowledgements}:stimulus;
    return [candidate(profile,mode,clock,evoExchange(selected),observed)];
  });
  const output=join(c.root,'evo-screen.bmp');
  await runPdr(['run',c.path,'capture_screen','--save-result',output,'--json'],c.io,{authoredAcquisition:acquire});
  const bmp=await readFile(output);assert.equal(bmp.length,153666);assert.equal(bmp.subarray(0,2).toString(),'BM');
  assert.equal(createHash('sha256').update(bmp.subarray(66)).digest('hex'),'d67cf653c07cb7781ad1aa9c2a3cac7e2a9e09e1b74fc209cc192db6a4d93265');
  const png=await readFile(new URL('../../../test-support/ti-84-evo/fixtures/screenshot-20260827T190357.png',import.meta.url));
  assert.deepEqual(compareEvoBmpToVendorPng(bmp,png),{matching:76800,total:76800,width:324,height:244,inset:[2,2]});
  const swapped=Buffer.from(bmp),red=swapped.readUInt32LE(54),blue=swapped.readUInt32LE(62);swapped.writeUInt32LE(blue,54);swapped.writeUInt32LE(red,62);
  assert.throws(()=>assert.deepEqual([swapped.readUInt32LE(54),swapped.readUInt32LE(58),swapped.readUInt32LE(62)],[0xf800,0x07e0,0x001f]));
  wrong=true;const wrongOutput=join(c.root,'wrong-screen-control.bmp');
  await runPdr(['run',c.path,'capture_screen','--save-result',wrongOutput,'--json'],c.io,{authoredAcquisition:acquire});
  assert.deepEqual(compareEvoBmpToVendorPng(await readFile(wrongOutput),png),{matching:23046,total:76800,width:324,height:244,inset:[2,2]});
  assert.equal(observed.opens,2);assert.equal(observed.writes.length,6+6+6+37+6+6+6+stimulus.wrongScreenResponse.length);
});

test('pdr help never enumerates; ambiguous candidates list all and never open',async t=>{
  // Unique regression: help side effects or first-match acquisition when several devices qualify.
  const c=await setup(t,'device-2',['device.lua']);let enumerations=0,opens=0;
  const acquire=createNodeAuthoredAcquisition(async()=>{enumerations++;return ['first','second'].map(id=>({
    candidate:{candidateId:id,displayName:id+' device',matchedProfileId:'serial'},open:async()=>{opens++;throw Error('must not open');}}));});
  await runPdr(['run',c.path],c.io,{authoredAcquisition:acquire});assert.equal(enumerations,0);
  await assert.rejects(runPdr(['run',c.path,'get_rate','--mode','silent'],c.io,{authoredAcquisition:acquire}),/first \(first device\), second \(second device\)/);
  assert.equal(opens,0);
});

test('pdr refuses candidate and serial-path together before acquisition',async t=>{
  const c=await setup(t,'device-2',['device.lua']);let acquisitions=0;
  await assert.rejects(runPdr(['run',c.path,'get_rate','--mode','silent','--candidate','opaque',
    '--serial-path','/dev/pts/3'],c.io,{authoredAcquisition:async()=>{acquisitions++;throw Error('must not acquire');}}),
  error=>error.error?.code==='cli.option.conflict'&&error.error.responsibility==='invocation');
  assert.equal(acquisitions,0);
});

test('pdr refuses serial-path for an admitted USB profile as an invocation error',async t=>{
  const c=await setup(t,'ti84-plus-ce/module',['device.lua','directlink.lua','bmp.lua']);
  await assert.rejects(runPdr(['run',c.path,'capture_screenshot','--serial-path','/dev/pts/3',
    '--save-result',join(c.root,'unused.bmp')],c.io),
  error=>error.error?.code==='authored.acquisition.serial-path-profile'
    &&error.error.responsibility==='invocation');
});

test('device-3 pdr exposes two distinct profiles and refuses to flatten selection',async t=>{
  // Unique regression: device-3's directional USB channels being flattened into serial main or one implicit profile.
  const c=await setup(t,'device-3',[{file:'device3.lua',logicalName:'device.lua'}]);let enumerations=0;
  const observed={opens:0,writes:[]};
  const acquire=createNodeAuthoredAcquisition(async (profile,mode,clock)=>{enumerations++;
    if(profile.id==='usb'){
      assert.deepEqual(profile.acquisitionFilters,[
        {transport:'usb',vendorId:5824,productId:1235,usbClass:255},
        {transport:'usb',vendorId:5824,productId:1236,usbClass:255}]);
      assert.deepEqual(profile.transport.channels.map(({id,input,output})=>({id,input:input?.endpointNumber??null,output:output?.endpointNumber??null})),[
        {id:'requests',input:null,output:1},{id:'responses',input:1,output:null},{id:'events',input:2,output:null}]);
      return [];
    }
    assert.equal(profile.id,'serial');
    return [candidate(profile,mode,clock,device3Exchange(),observed)];
  });
  await runPdr(['run',c.path],c.io,{authoredAcquisition:acquire});
  assert.match(c.text(),/Profile serial: serial; modes application/);assert.match(c.text(),/Profile usb: usb; modes application/);
  await assert.rejects(runPdr(['run',c.path,'get_device_info'],c.io,{authoredAcquisition:acquire}),/--profile.*serial, usb/);
  assert.equal(enumerations,0);
  await assert.rejects(runPdr(['run',c.path,'get_device_info','--profile','usb'],c.io,{authoredAcquisition:acquire}),/no candidate matches connection profile usb/);
  assert.equal(enumerations,1);
  await runPdr(['run',c.path,'get_device_info','--profile','serial','--json'],c.io,{authoredAcquisition:acquire});
  const result=JSON.parse(c.text().trim().split('\n').at(-1)).result;
  assert.equal(result.hardwareModel,'daisy-seed-1.2');assert.equal(result.firmwarePatch,3);
  assert.equal(enumerations,2);assert.equal(observed.opens,1);
});

test('device-1 serialized pdr executes entry before ping through the worker RPC boundary',async t=>{
  // Unique regression: --worker admitting device-1 but bypassing its retained entry before the operation.
  const c=await setup(t,'device-1',['device.lua','channel-wire.lua','channel-layout.lua']);
  await runPdr(['--worker','run',c.path,'ping','--json'],c.io,{worker:{workerUrl:authoredWorker}});
  assert.deepEqual(JSON.parse(c.text()).result,{address:0,length:0});
});

test('device-2 serialized pdr carries the selected silent mode into worker construction',async t=>{
  // Unique regression: structured clone dropping device-2's non-default selected mode.
  const c=await setup(t,'device-2',['device.lua']);
  await runPdr(['--worker','run',c.path,'get_device_info','--mode','silent','--json'],c.io,{worker:{workerUrl:authoredWorker}});
  assert.deepEqual(JSON.parse(c.text()).result,{identity:'1234ABCD,1.0'});
});

test('device-2 host-supplied worker carries an operator-named serial path through its boundary',async t=>{
  const c=await setup(t,'device-2',['device.lua']);
  await runPdr(['--worker','run',c.path,'get_device_info','--mode','silent','--serial-path','/dev/pts/worker-fixture','--json'],
    c.io,{worker:{workerUrl:authoredWorker}});
  assert.deepEqual(JSON.parse(c.text()).result,{identity:'SERIAL-PATH,1.0'});
});

test('stock worker refuses both enumerated and operator-named serial acquisition before opening',async t=>{
  const c=await setup(t,'device-2',['device.lua']);
  for(const extra of [[],['--serial-path','/dev/pts/3']]){
    await assert.rejects(runPdr(['--worker','run',c.path,'get_rate','--mode','silent',...extra],c.io,{worker:{}}),
      error=>error.error?.code==='authored.acquisition.worker-serial-unavailable'
        &&error.error.responsibility==='invocation');
  }
});

test('stock worker refuses native serial while USB remains available',()=>{
  assert.throws(()=>assertStockNodeWorkerTransport(serial()),
    error=>error.error?.code==='authored.acquisition.worker-serial-unavailable'
      &&error.error.responsibility==='invocation');
  assert.doesNotThrow(()=>assertStockNodeWorkerTransport({modes:['main'],acquisitionFilters:[{transport:'usb'}],
    transport:{kind:'usb'}}));
});

test('CE serialized pdr retains worker-owned USB execution and resource delivery',async t=>{
  // Unique regression: the serialized authored route losing CE's file-result resource RPC.
  const c=await setup(t,'ti84-plus-ce/module',['device.lua','directlink.lua','bmp.lua']);
  const output=join(c.root,'worker-screen.bmp');
  await runPdr(['--worker','run',c.path,'capture_screenshot','--save-result',output,'--json'],c.io,{worker:{workerUrl:authoredWorker}});
  const {frames,fixture}=await retainedWire();compareImage(await readFile(output),frames,fixture);
});

test('Evo serialized pdr keeps four-file resolution and exact file delivery',async t=>{
  // Unique regression: the serialized worker re-admitting only device.lua or dropping Evo's streamed file destination.
  const c=await setup(t,'ti-84-evo',['device.lua','evo.lua','screen.lua','cbor.lua']);
  const output=join(c.root,'worker-evo-screen.bmp');
  await runPdr(['--worker','run',c.path,'capture_screen','--save-result',output,'--json'],c.io,{worker:{workerUrl:authoredWorker}});
  const bmp=await readFile(output);assert.equal(bmp.length,153666);
  assert.equal(createHash('sha256').update(bmp.subarray(66)).digest('hex'),'d67cf653c07cb7781ad1aa9c2a3cac7e2a9e09e1b74fc209cc192db6a4d93265');
});

test('device-3 serialized pdr preserves the explicit serial profile and scheduled receiver',async t=>{
  // Unique regression: worker admission flattening device-3's serial/USB choice before its receiver starts.
  const c=await setup(t,'device-3',[{file:'device3.lua',logicalName:'device.lua'}]);
  await runPdr(['--worker','run',c.path,'get_device_info','--profile','serial','--json'],c.io,{worker:{workerUrl:authoredWorker}});
  const result=JSON.parse(c.text()).result;
  assert.deepEqual({hardwareModel:result.hardwareModel,usbIdentity:result.usbIdentity,
    firmwareMajor:result.firmwareMajor,firmwareMinor:result.firmwareMinor,firmwarePatch:result.firmwarePatch},
    {hardwareModel:'daisy-seed-1.2',usbIdentity:'normal',firmwareMajor:1,firmwareMinor:2,firmwarePatch:3});
});

function device3Exchange(){return bytes=>{if(bytes.length<10||bytes[6]!==1||bytes[7]!==1)throw Error('unrequested device-3 write');
  const body=Buffer.alloc(31);body[0]=2;body[1]=1;body[2]=bytes[8];body[3]=bytes[9];body[5]=1;body[6]=0x41;
  body[8]=1;body[9]=2;body[10]=3;body[15]=1;body[27]=3;return [device3Frame(body)];};}
function device3Frame(body){const framed=Buffer.alloc(body.length+10);framed.set([0xa5,0x5a,0xd3,1,body.length&255,body.length>>>8]);framed.set(body,6);
  framed.writeUInt32LE(crc32c(framed.subarray(3,framed.length-4)),framed.length-4);return framed;}
function crc32c(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0x82f63b78:0);}return(value^0xffffffff)>>>0;}
