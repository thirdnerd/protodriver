-- C2 exact-byte, request-triggered authority control (not a device module).
-- D5: one 300,000-addition body fits; foreground plus authorizer must share
-- the 1M Lua account. Single-sided positive arms guard against early refusal.
local selected = "accept"
local empty=pdrv.array({})
local modes,profiles=pdrv.array({"interactive","silent"}),pdrv.array({"serial"})
local requests={}
-- Each arm performs 31,024 real byte comparisons. Two arms exceed the
-- 50,000 grant without counting any host boundary work; either fits alone.
local function nativeWork(io)
  local a=pdrv.bytes(string.rep("x",1024));local b=pdrv.bytes(string.rep("x",1024))
  assert(a==b);io.request({kind="reschedule"}) -- completed 1024-octet prefix
  a=pdrv.bytes(string.rep("y",30000));b=pdrv.bytes(string.rep("y",30000))
  assert(a==b)
end
return {
  apiVersion="device/v2",id="write-relay-control",modes=modes,profiles=profiles,
  entry={binding="enter",locks=pdrv.array({"protocol"}),requires=empty,handoffTo="receiver"},
  handlers=pdrv.array({{id="receiver",binding="input",acceptHandoff="acceptHandoff",authorizeWrite="authorizeWrite",
    event={kind="channel-input",channelId="main"},maximumConcurrent=8,locks=empty,
    requires=pdrv.array({"channel.input","mailbox"})}}),
  mailboxes=pdrv.array({"reply","alarm"}),
  operations=pdrv.array({{id="command",title="Command",binding="command",arguments={},
    result={kind="value",type={kind="string"}},risk="read-only",repeatability="not-repeatable",
    writeVia="receiver",locks=pdrv.array({"protocol"}),availability={modes=modes,profiles=profiles},
    requires=pdrv.array({"channel.write-via","mailbox"})},
    {id="alarm",title="Observe alarm",binding="alarm",arguments={},result={kind="value",type={kind="string"}},
    risk="read-only",repeatability="not-repeatable",locks=empty,availability={modes=modes,profiles=profiles},requires=pdrv.array({"mailbox"})}}),
}, {
  enter=function(args,io) assert(io.request({kind="entry-handoff",parser="empty",timers="none"})=="accepted") end,
  acceptHandoff=function() return {accepted=true} end,
  authorizeWrite=function(request,io)
    assert(request.operation=="command" and request.channelId=="main")
    assert(type(request.operationId)=="string" and type(request.ownerId)=="string")
    assert(not requests[request.requestId]);requests[request.requestId]=true
    assert(not pcall(function()request.bytes="REWRITTEN" end))
    if selected=="invalid" then return {accepted="yes"} end
    if selected=="rewrite" then return {accepted=true,bytes="UNAUTHORIZED"} end
    if selected=="throw" then error("refused") end
    if selected=="unrelated" then io.request({kind="write",value="UNAUTHORIZED"}) end
    if selected=="fuel" then for i=1,20000 do io.request({kind="reschedule"}) end end
    if selected=="work-both" or selected=="work-owner" then nativeWork(io) end
    if selected=="lua-both" or selected=="lua-owner" then local n=0;for i=1,300000 do n=n+i end;assert(n==45000150000) end
    io.request({kind="reschedule"})
    return {accepted=request.bytes=="QUERY\r\n" or request.bytes==string.char(0,255,128)}
  end,
  input=function(args,io) io.request({kind="message-send",mailbox=args.input=="ALARM" and "alarm" or "reply",value=args.input}) end,
  command=function(args,io)
    if selected=="work-both" or selected=="work-operation" then nativeWork(io) end
    if selected=="lua-both" or selected=="lua-operation" then local n=0;for i=1,300000 do n=n+i end;assert(n==45000150000) end
    local bytes=selected=="refuse" and "UNAUTHORIZED" or "QUERY\r\n"
    if selected=="binary" then bytes=pdrv.bytes(string.char(0,255,128)) end
    io.request({kind=selected=="raw" and "write" or "write-via",value=bytes})
    if selected=="twice" then io.request({kind="write-via",value="QUERY\r\n"}) end
    if selected=="replay" then io.request({kind="write-via",value="UNAUTHORIZED"}) end
    return io.request({kind="message-wait",mailboxes=pdrv.array({"reply"}),timers=empty})
  end,
  alarm=function(args,io) return io.request({kind="message-wait",mailboxes=pdrv.array({"alarm"}),timers=empty}) end,
}
