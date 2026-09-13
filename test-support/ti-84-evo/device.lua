-- Qualified TI-84 Evo device/v2 source. Corpus retirement waits for the
-- standing all-six-migrations condition.
local E, Screen = require("evo.lua"), require("screen.lua")
local array = pdrv.array
local direct = array({"channel.read", "channel.write", "timer"})

local SCREEN_REQUEST = {
  "\x01\x30\x20\x53\x7e\x30\x20\x40\x2d\x23\x59\x31\x7e\x2e\x22\x35\x4d\x3e\x0d",
  "\x01\x3b\x21\x46\x68\x68\x30\x31\x2f\x67\x65\x74\x2f\x68\x68\x30\x31\x2f\x73\x79\x73\x2f\x73\x63\x72\x65\x65\x6e\x42\x0d",
  "\x01\x2c\x22\x41\x22\x22\x42\x38\x31\x21\x31\x40\x20\x50\x0d",
  "\x01\x24\x23\x44\x68\x56\x0d", "\x01\x23\x24\x5a\x43\x0d", "\x01\x23\x25\x42\x2c\x0d",
}
local DYNAMICINFO_REQUEST = {
  SCREEN_REQUEST[1],
  "\x01\x49\x21\x46\x68\x68\x30\x31\x2f\x67\x65\x74\x2f\x68\x68\x30\x31\x2f\x69\x6e\x66\x2f\x72\x65\x73\x3f\x6e\x61\x6d\x65\x3d\x64\x79\x6e\x61\x6d\x69\x63\x69\x6e\x66\x6f\x24\x0d",
  SCREEN_REQUEST[3], SCREEN_REQUEST[4], SCREEN_REQUEST[5], SCREEN_REQUEST[6],
}

local buffer, active, completed, wanted_write = "", nil, nil, nil

local function close(io)
  local grant = io.request({kind="connection-grant"})
  io.request({kind="connection-close", connection=grant:match("^([^|]+)")})
end

local function write(io, value)
  io.request({kind="write", value=pdrv.bytes(value)})
end

local function fill(io, count, timer)
  local parts,remaining={},count
  while remaining>0 do
    local take=math.min(remaining,256)
    local value=io.request({kind="wait-fill",count=take,timers=array({timer})})
    if value:sub(1,8)~="receive:" then pdrv.fail("evo.response-timeout",{}) end
    parts[#parts+1]=value:sub(9);remaining=remaining-take
  end
  return table.concat(parts)
end

local function read_entry_frame(io, timer)
  local prefix = fill(io, 2, timer)
  if prefix:byte(2) == 0x20 then
    local header = fill(io, 4, timer)
    local partial = prefix .. header
    local length = E.wire_frame_length(partial)
    return partial .. fill(io, length - #partial, timer)
  end
  local length = E.wire_frame_length(prefix)
  return prefix .. fill(io, length - #prefix, timer)
end

local function begin_response(maximum_frames, maximum_bytes, maximum_acknowledgement_bytes, notify)
  active = {phase="S", frames={}, count=0, bytes=0, data_frames=0, acknowledgement_bytes=0,
    maximum_frames=maximum_frames, maximum_bytes=maximum_bytes,
    maximum_acknowledgement_bytes=maximum_acknowledgement_bytes, notify=notify}
  completed = nil
end

local function accept_response(frame, io)
  local read = E.read_frame(frame)
  local command = read.command
  if command == "Y" then return end
  if active == nil then pdrv.fail("evo.unsolicited-response", {command=command}) end
  local phase = active.phase
  local allowed = command == phase or (phase == "D" and command == "Z" and active.data_frames > 0)
  if not allowed then pdrv.fail("evo.response-order", {expected=phase, observed=command}) end
  active.count = active.count + 1
  active.bytes = active.bytes + #frame
  if active.count > active.maximum_frames or active.bytes > active.maximum_bytes then
    pdrv.fail("evo.response-bound", {frames=active.count, bytes=active.bytes})
  end
  active.frames[#active.frames + 1] = frame
  local acknowledgement=E.acknowledgement(frame)
  active.acknowledgement_bytes=active.acknowledgement_bytes+#acknowledgement
  if active.acknowledgement_bytes>active.maximum_acknowledgement_bytes then
    pdrv.fail("evo.acknowledgement-bound",{bytes=active.acknowledgement_bytes})
  end
  write(io, acknowledgement)
  if command == "S" then active.phase = "F"
  elseif command == "F" then active.phase = "A"
  elseif command == "A" then active.phase = "D"
  elseif command == "D" then active.phase = "D";active.data_frames=active.data_frames+1
  elseif command == "Z" then active.phase = "B"
  elseif command == "B" then
    local notify=active.notify
    completed = active.frames
    active = nil
    if notify then io.request({kind="message-send", mailbox="reply", value="complete"}) end
  end
end

local function exchange_entry(io)
  local timer = io.request({kind="timer-arm", milliseconds=1000})
  begin_response(6, 4096, 4096, false)
  for index=1,#DYNAMICINFO_REQUEST do write(io, DYNAMICINFO_REQUEST[index]) end
  while active ~= nil do accept_response(read_entry_frame(io, timer), io) end
  io.request({kind="timer-cancel", timer=timer})
end

return {
  apiVersion="device/v2", id="ti-84-evo", displayName="TI-84 Evo",
  description="Acquire the current calculator display as a directly saveable BMP file.",
  modes=array({"screenshot"}), modePresentation={screenshot={label="Screenshot",
    description="Capture the current 320 by 240 display through the calculator's read-only screen resource."}},
  profiles=array({"serial"}), mailboxes=array({"reply"}), invalidation="invalidated",
  connectionProfiles={serial={modes=array({"screenshot"}),
    acquisitionFilters=array({{transport="serial",vendorId=1105,productId=57368}}),
    transport={kind="serial",baudRate=9600,dataBits=8,parity="none",stopBits=1,flowControl="none"},
    channels=array({{id="main",protocolDuplex="full-duplex"}}),
    lifecycle={openingDrainQuietMs=0,postTerminationSilence={minimumMs=0,afterAbnormalTermination=false,afterModeExit=false}}},
  },
  entry={binding="entry",locks=array({"protocol"}),requires=direct,handoffTo="receiver"},
  handlers=array({{id="receiver",binding="receive",acceptHandoff="accept",authorizeWrite="authorize",
    event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=array({"parser"}),
    requires=array({"channel.input","channel.write","mailbox"})}}),
  operations=array({{id="capture_screen",title="Capture screen",
    description="Read the current display and return a BMP image that can be saved and opened directly.",
    binding="capture",arguments={},result={kind="file",direction="out",
      content="Current display, 320 by 240 RGB565",mediaType="image/bmp",suggestedExtension="bmp",
      minimumBytes=153666,maximumBytes=153666},risk="read-only",repeatability="safe-to-repeat",
    locks=array({"protocol"}),writeVia="receiver",
    requires=array({"channel.write-via","mailbox","operation.deadline"}),
    cleanup={binding="cleanup",requires=array({"connection.lifecycle"}),
      maximumMilliseconds=50,maximumLuaFuel=10000,maximumWork=100000},
    availability={modes=array({"screenshot"}),profiles=array({"serial"})}}}),
}, {
  invalidated=function() buffer,active,completed,wanted_write="",nil,nil,nil end,
  entry=function(_,io)
    local ok, failure = pcall(function() exchange_entry(io);io.request({kind="entry-handoff",parser="empty",timers="none"}) end)
    if not ok then close(io);error(failure) end
  end,
  accept=function(offer) return {accepted=offer.parser=="empty" and offer.timers=="none"} end,
  authorize=function(request) return {accepted=request.operation=="capture_screen" and request.bytes==wanted_write} end,
  receive=function(args,io)
    buffer = buffer .. args.input
    while #buffer > 0 do
      local length = E.complete_wire_frame_length(buffer)
      if length == nil then break end
      if length > 9031 then pdrv.fail("evo.frame-capacity", {bytes=length}) end
      if #buffer < length then break end
      local frame = buffer:sub(1,length);buffer=buffer:sub(length+1)
      accept_response(frame,io)
    end
    if #buffer > 9031 then pdrv.fail("evo.frame-capacity", {bytes=#buffer}) end
  end,
  cleanup=function(outcome,io) if outcome.outcome~="completed" then close(io) end end,
  capture=function(_,io)
    io.request({kind="deadline-arm",milliseconds=30000})
    begin_response(256,200000,20000,true)
    for index=1,#SCREEN_REQUEST do
      wanted_write=SCREEN_REQUEST[index]
      io.request({kind="write-via",value=pdrv.bytes(wanted_write)})
    end
    wanted_write=nil
    local reply=io.request({kind="message-wait",mailboxes=array({"reply"}),timers=array({})})
    if reply~="message:reply:complete" then pdrv.fail("evo.screen-incomplete", {}) end
    local frames=completed;completed=nil
    local image=Screen.screen_bmp(table.concat(frames))
    for offset=1,#image,16384 do
      io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(image:sub(offset,offset+16383))})
    end
    return io.resultDestination
  end,
}
