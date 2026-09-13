-- Entry/selection diagnostic, not the migrated four-operation/state module.
local modes = pdrv.array({"interactive","silent"})
local profiles = pdrv.array({"serial","serial-control"})
local selection, identity
local function keys(value)
  local names = {}
  for key in pdrv.record_fields(value) do names[#names+1] = key end
  table.sort(names)
  return table.concat(names, ",")
end
local function receive(io, count)
  local timer = io.request({kind="timer-arm",milliseconds=500})
  local value = io.request({kind="wait-fill",count=count,timers=pdrv.array({timer})})
  if value:sub(1,8) ~= "receive:" then error("entry response deadline") end
  io.request({kind="timer-cancel",timer=timer})
  return value:sub(9)
end
local text = {kind="string",maximumLength=256}
return {
  apiVersion="device/v2", id="device-2-mode-preflight", modes=modes, profiles=profiles,
  entry={binding="enter",locks=pdrv.array({"protocol"}),requires=pdrv.array({"channel.read","channel.write","timer"})},
  operations=pdrv.array({{
    id="observe",title="Observe selected entry",binding="observe",arguments={},
    result={kind="value",type={kind="record",fields={
      modeId=text,profileId=text,identity=text,operationArguments=text,received={kind="bytes",maximumLength=42},
    }}},
    risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"protocol"}),
    availability={modes=modes,profiles=profiles},
    requires=pdrv.array({"channel.read","channel.write","timer"}),
  }}),
}, {
  enter=function(args,io)
    assert(keys(args)=="modeId,profileId")
    assert(not pcall(function() args.modeId="silent" end))
    assert(not pcall(function() rawset(args,"profileId","other") end))
    selection=args
    -- The first line after MCU reset commits the echo choice. Reopening the
    -- port does not undo it; choose from host intent before transmitting.
    if args.modeId=="interactive" then
      io.request({kind="write",value="\r\n"})
      assert(receive(io,6)=="\r\nOK\r\n")
    else assert(args.modeId=="silent") end
    io.request({kind="write",value="*IDN?\r\n"})
    if args.modeId=="interactive" then assert(receive(io,7)=="*IDN?\r\n") end
    identity=receive(io,29)
    assert(identity:match("^D2%-LABS,D2%-MON,%x%x%x%x%x%x%x%x,1%.0\r\n$"))
  end,
  observe=function(args,io)
    io.request({kind="write",value="CONF:RATE 100\r\n"})
    local value=receive(io,selection.modeId=="interactive" and 42 or 4)
    return {modeId=selection.modeId,profileId=selection.profileId,identity=identity,
      operationArguments=keys(args),received=pdrv.bytes(value)}
  end,
}
