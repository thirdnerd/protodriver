-- Qualified five-operation D1-CHAN device/v2 module.
local W=require("channel-wire.lua")
local L=require("channel-layout.lua")
local a=pdrv.array
local locks=a({"protocol"})
local needs=a({"channel.read","channel.write","timer","connection.lifecycle","operation.deadline"})
local cleanupNeeds=a({"channel.read","channel.write","timer","connection.lifecycle"})
local ready,disturbed=false,false
local localFailure=false
local function publish(io,cell,value) io.request({kind="state-publish",cell=cell,quality="valid",value=value}) end
local function fault(io,code)
  ready=false
  publish(io,"protocol_fault",code)
end
local function restore(io,ordinary)
  W.replace(io);W.enter(io,ordinary);ready=true;disturbed=false
end
local function reenter(_,io) W.recover(io);ready=true end
local function guarded(body)
  return function(args,io,context)
    if not ready then pdrv.fail("device-1.recovery-required",{}) end
    localFailure=false
    local ok,result=pcall(body,args,io)
    if ok then return result end
    local code=tostring(result)
    if not code:match("^device%-1%.") then code="device-1.operation-failed" end
    if localFailure then pdrv.fail(code,{recovered=false}) end
    fault(io,code)
    -- Recovery settles readiness, NEVER retries the failed/destructive command.
    if not disturbed then
      local recovered=pcall(W.recover,io)
      if recovered then ready=true end
    end
    pdrv.fail(code,{recovered=ready})
  end
end
local tags={}
for i=0,14 do tags["tag"..i]={kind="bytes",minimumLength=1,maximumLength=1} end
local bytes={kind="bytes",minimumLength=4096,maximumLength=4096}
local function channelResult(written)
  local fields={sectorBase={kind="integer",widthBits=32,signed=false,maximum=0xffffff},raw=bytes,
    tags={kind="record",fields=tags},channels={kind="array",minimumLength=250,maximumLength=250,item=L.rowType}}
  if written then fields.writeTransactions={kind="integer",widthBits=32,signed=false,minimum=64,maximum=64} end
  return {kind="record",fields=fields}
end
local function operation(id,binding,result,arguments,destructive,restart)
  return {id=id,title=id,binding=binding,arguments=arguments or {},result={kind="value",type=result},
    risk=destructive and "destructive" or "read-only",repeatability=destructive and "not-repeatable" or "safe-to-repeat",
    locks=locks,requires=needs,availability={modes=a({"transfer"}),profiles=a({"serial"})},
    reentry={binding="reenter",requires=needs},
    cleanup=restart and {binding="cleanup",requires=cleanupNeeds,maximumMilliseconds=4900,maximumLuaFuel=100000,maximumWork=1000000} or nil}
end
local ping=operation("ping","ping",{kind="record",fields={address={kind="integer",widthBits=8,signed=true},length={kind="integer",widthBits=8,signed=true}}});ping.releaseAfterIdleMs=30000
return {apiVersion="device/v2",id="d1-chan",modes=a({"transfer"}),profiles=a({"serial"}),
 connectionProfiles={serial={modes=a({"transfer"}),
  acquisitionFilters=a({{transport="serial",vendorId=0x1a86,productId=0x7523}}),
  transport={kind="serial",baudRate=57600,dataBits=8,parity="none",stopBits=1,flowControl="none"},
  channels=a({{id="main",protocolDuplex="half-duplex"}}),
  lifecycle={openingDrainQuietMs=300,postTerminationSilence={minimumMs=3000,afterAbnormalTermination=true,afterModeExit=true}}}},
 entry={binding="enter",locks=locks,requires=a({"channel.read","channel.write","timer"})},invalidation="invalidated",
 state={device_identity={type={kind="string"},freshForMs=pdrv.null},firmware_version={type={kind="string"},freshForMs=pdrv.null},
  status_raw={type={kind="bytes",minimumLength=2,maximumLength=2},freshForMs=pdrv.null},
  protocol_fault={type={kind="string"},freshForMs=pdrv.null}},
 maintenance=a({{kind="poll",mode="transfer",operation="ping",intervalMs=200,failureBackoffMs=200,
  maximumInterTransactionGapMs=300,suspendWhileLocksHeld=locks,timing={kind="idle-reset",activity="foreground-lifecycle"}}}),
 operations=a({
  operation("get_device_info","info",{kind="record",fields={identity={kind="string"},firmware={kind="string"},
    maximumReadLength={kind="integer",widthBits=8,signed=true},maximumWriteLength={kind="integer",widthBits=8,signed=true}}},{},false,true),
  operation("get_status","status",{kind="record",fields={raw={kind="bytes",minimumLength=2,maximumLength=2},observedDuringProbe={kind="boolean"}}},{},false,true),
  ping,operation("read_channel_configuration","read",channelResult(false)),
  operation("write_channel_configuration","write",channelResult(true),{
    channelIndex={kind="integer",widthBits=16,signed=true,minimum=0,maximum=249},
    expectedCurrent={kind="byte-source",minimumBytes=4096,maximumBytes=4096},edits=L.editType},true)
 })}, {
 enter=function(_,io) W.enter(io,false);ready=true end,
 invalidated=function() ready=false end,
 reenter=reenter,
 cleanup=function(_,io) if disturbed then restore(io,false) end end,
 ping=guarded(function(_,io) W.read(io,0,0);return {address=0,length=0} end),
 info=guarded(function(_,io)
  disturbed=true;W.replace(io)
  W.exchange(io,"PSEARCH","\x06P13GMRS",true)
  W.exchange(io,"SYSINFO","\x06",true)
  local reply=W.exchange(io,"\x56\0\0\0\x01",{prefix="\x56",header=3,maximum=10},true)
  W.exchange(io,"\x06","\x06",true)
  if reply:sub(1,3)~="\x56\x01\x0a" or reply:sub(4)~="V06.03.009" then error("device-1.firmware-mismatch",0) end
  W.delay(io,600);restore(io,true)
  publish(io,"device_identity","P13GMRS");publish(io,"firmware_version","V06.03.009")
  return {identity="P13GMRS",firmware="V06.03.009",maximumReadLength=64,maximumWriteLength=64}
 end),
 status=guarded(function(_,io)
  disturbed=true;W.replace(io);W.exchange(io,"PSEARCH","\x06P13GMRS",true)
  local raw=W.exchange(io,"PASSSTA",3,true)
  if raw:sub(1,1)~="P" then error("device-1.unknown-message",0) end
  raw=raw:sub(2);restore(io,true);publish(io,"status_raw",pdrv.bytes(raw))
  return {raw=pdrv.bytes(raw),observedDuringProbe=false}
 end),
 read=guarded(function(_,io)
  local base,observed,raw=W.selected(io)
  return {sectorBase=base,raw=pdrv.bytes(raw),tags=observed,channels=L.decode_sector(raw)}
 end),
 write=guarded(function(args,io)
  local base,observed,raw=W.selected(io)
  localFailure=true
  L.decode_sector(raw)
  local edited=L.edit(raw,args.channelIndex,args.edits)
  if args.expectedCurrent~=pdrv.bytes(raw) then error("device-1.expected-current-mismatch",0) end
  localFailure=false
  for offset=0,4095,64 do W.exchange(io,"W"..W.header(base+offset,64)..edited:sub(offset+1,offset+64),"\x06",true) end
  local verified=W.sector(io,base)
  if verified~=edited then error("device-1.channel-write-verification-mismatch",0) end
  return {sectorBase=base,raw=pdrv.bytes(edited),tags=observed,channels=L.decode_sector(verified),writeTransactions=64}
 end),
}
