-- TI-84 Plus CE USB module for read-only screenshot capture.
local Link, Bmp = require("directlink.lua"), require("bmp.lua")
local array = pdrv.array
local direct = array({"channel.read","channel.write","timer"})
local screen_request = "\x00\x00\x00\x0a\x04\x00\x00\x00\x04\x00\x07\x00\x01\x00\x22"
local running, queued, wanted, screen = false, 0, nil, nil
local inbox, needed, signalled = {}, nil, false
local function close(io)
  local grant = io.request({kind="connection-grant"})
  io.request({kind="connection-close",connection=grant:match("^([^|]+)")})
end
local function guarded(io, fn)
  local ok, result = pcall(fn)
  if not ok then close(io); error(result) end
  return result
end

return {
  apiVersion="device/v2", id="ti84-plus-ce",
  modes=array({"screenshot"}), profiles=array({"usb"}),
  connectionProfiles={usb={modes=array({"screenshot"}),
    acquisitionFilters=array({{transport="usb",vendorId=1105,productId=57352,usbClass=255}}),
    requiredProductName="TI-84 Plus CE",
    transport={kind="usb",configurationValue="preserve-active",interfaceNumber=0,alternateSetting=0,
      channels=array({{id="main",input={endpointNumber=1,transferType="bulk",maximumPacketBytes={full=64}},
        output={endpointNumber=2,transferType="bulk",maximumPacketBytes={full=64}}}})}}},
  entry={binding="entry",locks=array({"operation"}),requires=direct,handoffTo="receiver"},
  invalidation="invalidated", mailboxes=array({"ingress","reply"}),
  handlers=array({{id="receiver",binding="input",acceptHandoff="accept",authorizeWrite="authorize",
    event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=array({}),
    requires=array({"channel.input","channel.write","mailbox","timer"})}}),
  operations=array({{
    id="capture_screenshot",title="Capture screenshot",binding="capture",arguments={},
    risk="read-only",repeatability="safe-to-repeat",locks=array({"operation"}),
    availability={modes=array({"screenshot"}),profiles=array({"usb"})},writeVia="receiver",
    requires=array({"channel.write-via","mailbox","operation.deadline"}),
    cleanup={binding="cleanup",requires=array({"connection.lifecycle"}),
      maximumMilliseconds=50,maximumLuaFuel=10000,maximumWork=100000},
    result={kind="file",direction="out",content="Current display, 320 by 240 RGB565",
      mediaType="image/bmp",suggestedExtension="bmp",minimumBytes=153666,maximumBytes=153666},
  }}),
}, {
  invalidated=function() running,queued,wanted,screen=false,0,nil,nil;inbox,needed,signalled={},nil,false end,
  entry=function(_,io)
    guarded(io,function()
      Link.exchange(io,"\x00\x00\x00\x04\x01\x00\x00\x04\x00","buffer",1000)
      Link.exchange(io,"\x00\x00\x00\x10\x04\x00\x00\x00\x0a\x00\x01\x00\x03\x00\x01\x00\x00\x00\x00\x07\xd0","mode",1000)
      io.request({kind="entry-handoff",parser="empty",timers="none"})
    end)
  end,
  accept=function() return {accepted=true} end,
  authorize=function(request)
    return {accepted=wanted=="screen" and request.operation=="capture_screenshot"
      and request.bytes==screen_request}
  end,
  input=function(args,io)
    -- One parser coroutine retains partial framing/assembly and its timers.
    -- Other activations forward bounded ranges, never parse concurrently.
    -- Coalesce only the parser's requested byte count, not an invented frame
    -- size. One-byte native fragmentation must not wake the parser once per
    -- byte. Chunks append once and concatenate once, without growing-prefix
    -- copies; all of this private state remains under the VM resident bound.
    if running then
      inbox[#inbox+1]=args.input;queued=queued+#args.input
      if needed and queued>=needed and not signalled then
        signalled=true;io.request({kind="message-send",mailbox="ingress",value="ready"})
      end
      return
    end
    running=true
    local buffer=args.input
    Link.parse(io,function(n,timers)
      if #buffer==0 then
        needed=n
        if queued<n then
          local value=io.request({kind="message-wait",mailboxes=array({"ingress"}),timers=array(timers)})
          if value~="message:ingress:ready" then error("CE assembly deadline: "..value) end
        end
        needed=nil;signalled=false
        buffer=table.concat(inbox);inbox={};queued=0
      end
      local bytes=buffer:sub(1,n);buffer=buffer:sub(#bytes+1);return bytes
    end,function() return #buffer>0 or queued>0 end,function(name,packet)
      if name~=wanted then error("CE unsolicited response: "..name) end
      screen=packet;wanted=nil
      io.request({kind="message-send",mailbox="reply",value=name})
    end)
    running=false
  end,
  cleanup=function(outcome,io)
    -- CE has no recovery routine. Cancellation cannot run ordinary pcall;
    -- its prepaid terminal binding closes the tainted generation instead.
    if outcome.outcome~="completed" then close(io) end
  end,
  capture=function(_,io)
    io.request({kind="deadline-arm",milliseconds=31000})
    wanted="screen"
    io.request({kind="write-via",value=pdrv.bytes(screen_request)})
    local reply=io.request({kind="message-wait",mailboxes=array({"reply"}),timers=array({})})
    if reply~="message:reply:screen" then error("CE missing screen") end
    local packet=screen;screen=nil
    -- CE screen replies use a zero nominal 16-bit length; the validated outer
    -- virtual length bounds the framebuffer instead.
    local image=Bmp.image(packet:sub(14))
    for offset=1,#image,16384 do
      io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(image:sub(offset,offset+16383))})
    end
    return io.resultDestination
  end,
}
