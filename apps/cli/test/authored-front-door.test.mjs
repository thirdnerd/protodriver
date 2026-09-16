import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runPdr } from '../src/pdr.ts';
import { buildPdpkg, readPdpkg } from '../../../packages/contracts/src/pdpkg.ts';
import { packageBytes, source, hostGrant } from './fixtures/authored-front-door.mjs';
import { createNspireNative, expectedBmp } from '../../../test-support/ti-nspire/fixture.mjs';

test('front door admits the sole package contract and directories without acquiring', async t => {
  // Catches format dispatch, fallback to another VM, or acquisition during help.
  const root=await mkdtemp(join(tmpdir(),'f87-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'module.pdpkg'),bytes=await packageBytes();await writeFile(path,bytes);
  assert.equal((await readPdpkg(bytes)).bootstrap.generatorContract,'supported');
  let text='';const output=new Writable({write(chunk,encoding,done){text+=chunk;done();}}),io={input:[],output,error:output};
  await runPdr(['run',path],io,{authoredAcquisition:async()=>{throw Error('help acquired');}});
  assert.match(text,/echo: Echo/);assert.match(text,/not self-contained/);
  await assert.rejects(runPdr(['run',path,'echo','--value','7'],io),/authored.acquisition.required/);
  const directory=join(root,'source');await mkdir(directory);
  await writeFile(join(directory,'device.lua'),source);text='';
  await runPdr(['run',directory],io,{authoredAcquisition:async()=>{throw Error('directory help acquired');}});
  assert.match(text,/echo: Echo/);
});

test('ordinary runPdr uses only the host grant and opens a fresh authored execution per command', async t => {
  // Catches wrong native writes, lost typed results, and reuse of a prior command's Lua state.
  const root=await mkdtemp(join(tmpdir(),'f87-cli-grant-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'module.pdpkg');await writeFile(path,await packageBytes());
  const observed={opens:0,writes:[]};let text='';
  const output=new Writable({write(chunk,encoding,done){text+=chunk;done();}}),io={input:[],output,error:output};
  // A malformed flag must settle the newly admitted context without opening the native connection.
  await assert.rejects(runPdr(['run',path,'echo','--value','invalid'],io,
    {authoredAcquisition:async()=>hostGrant(observed)}),SyntaxError);
  for(let i=0;i<2;i++)await runPdr(['run',path,'echo','--value','7','--json'],io,
    {authoredAcquisition:async description=>{assert.equal(description.id,'front-door');return hostGrant(observed);}});
  assert.deepEqual(text.trim().split('\n').map(line=>JSON.parse(line).result),[8,8]);
  assert.deepEqual(observed,{opens:2,writes:['F87','F87']});
});

test('serialized authored pdr refuses a live embedding callback instead of silently ignoring it',async t=>{
  // Unique regression: F87's explicit alternative becoming an implicit or discarded worker fallback.
  const root=await mkdtemp(join(tmpdir(),'f92-cli-callback-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'module.pdpkg');await writeFile(path,await packageBytes());
  const output=new Writable({write(_chunk,_encoding,done){done();}}),io={input:[],output,error:output};
  await assert.rejects(runPdr(['--worker','run',path,'echo','--value','7'],io,
    {worker:{},authoredAcquisition:async()=>hostGrant({opens:0,writes:[]})}),/authored\.acquisition\.worker-callback-unavailable/);
});

test('Nspire ordinary CLI preserves presentation, typed information, and an exact saved BMP',async t=>{
  // Unique regression: the Node front door can flatten Nspire presentation or alter its tagged information and exact file result.
  const root=await mkdtemp(join(tmpdir(),'f116-cli-nspire-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'ti-nspire-handheld.pdpkg'),saved=join(root,'screen.bmp');
  const sourceBytes=await readFile(new URL('../../../test-support/ti-nspire/device.lua',import.meta.url));
  const {archive}=await buildPdpkg([{logicalName:'device.lua',sourceBytes}]);
  await writeFile(path,archive);
  let text='',acquisitions=0;
  const output=new Writable({write(chunk,_encoding,done){text+=chunk;done();}}),io={input:[],output,error:output};
  const acquire=async(description,selection)=>{
    acquisitions++;assert.equal(description.id,'ti-nspire-handheld');
    assert.deepEqual(selection,{modeId:'device_information',profileId:'usb'});
    return {...createNspireNative(()=>{},{simple:true}),modeId:'device_information',profileId:'usb',channelId:'main',helpers:{}};
  };

  await runPdr(['run',path],io,{authoredAcquisition:async()=>{throw Error('direct help acquired');}});
  const directHelp=text;text='';
  await runPdr(['--worker','run',path],io,{worker:{},authoredAcquisition:undefined});
  assert.equal(text,directHelp);assert.match(text,/TI-Nspire Handheld/);assert.match(text,/Handheld services/);
  assert.match(text,/read-device-information: Read device information/);assert.match(text,/capture_screenshot: Capture screenshot/);
  assert.match(text,/file image\/bmp \.bmp/);assert.equal(acquisitions,0);
  text='';await runPdr(['run',path,'read-device-information','--help'],io,{authoredAcquisition:async()=>{throw Error('operation help acquired');}});
  assert.match(text,/Handheld name/);
  const directInformationHelp=text;text='';
  await runPdr(['--worker','run',path,'read-device-information','--help'],io,{worker:{}});
  assert.equal(text,directInformationHelp);

  text='';await runPdr(['run',path,'read-device-information','--json'],io,{authoredAcquisition:acquire});
  const information=JSON.parse(text.trim());assert.equal(information.outcome,'completed');
  assert.deepEqual(information.result.name,{type:'bytes',encoding:'base64',value:Buffer.from('TI-Nspire').toString('base64')});

  text='';await runPdr(['run',path,'capture_screenshot','--save-result',saved],io,{authoredAcquisition:acquire});
  assert.deepEqual(await readFile(saved),expectedBmp());assert.equal(acquisitions,2);
});

test("a saved file result reports its destination and size instead of a blank line",async t=>{
  // A resource result has no result control, so the ordinary renderer prints nothing and
  // success is indistinguishable from a no-op without inspecting the filesystem.
  const root=await mkdtemp(join(tmpdir(),"cli-file-report-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,"ti-nspire-handheld.pdpkg"),saved=join(root,"screen.bmp");
  const sourceBytes=await readFile(new URL("../../../test-support/ti-nspire/device.lua",import.meta.url));
  const {archive}=await buildPdpkg([{logicalName:"device.lua",sourceBytes}]);
  await writeFile(path,archive);
  let text="";
  const output=new Writable({write(chunk,_encoding,done){text+=chunk;done();}}),io={input:[],output,error:output};
  const acquire=async()=>({...createNspireNative(()=>{},{simple:true}),modeId:"device_information",profileId:"usb",channelId:"main",helpers:{}});
  await runPdr(["run",path,"capture_screenshot","--save-result",saved],io,{authoredAcquisition:acquire});
  const written=await readFile(saved);
  assert.ok(text.includes(saved),"the destination the operator asked for must be named: "+JSON.stringify(text));
  assert.match(text,new RegExp(String(written.length)),"the byte count distinguishes a write from a no-op");
});
