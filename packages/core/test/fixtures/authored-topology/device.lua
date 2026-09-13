local selected="valid"
local text={kind="string"}
local operations={}
for _,id in ipairs({"wait","idle","locked","cycle","direct"}) do
  operations[#operations+1]={id=id,title=id,binding=id,arguments={},
    result=id=="wait" and {kind="value",type=text} or {kind="none"},
    risk="changes-state",repeatability="not-repeatable",locks=pdrv.array(id=="locked" and {"shared"} or {}),
    availability={modes=pdrv.array({"challenge"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}
end
local handler={id="receiver",binding="on_input",event={kind="channel-input",channelId="main"},maximumConcurrent=31.0,
  locks=pdrv.array(selected=="locks" and {"shared"} or {}),requires=pdrv.array({"channel.input","channel.write"})}
local handlers={handler}
local description={apiVersion="device/v2",id="topology-fixture",modes=pdrv.array({"challenge"}),profiles=pdrv.array({"serial"}),operations=pdrv.array(operations),
  entry={binding="entry",locks=pdrv.array({}),requires=pdrv.array({})},invalidation="invalidated",
  state={entered={type={kind="boolean"},freshForMs=10000.0}},mailboxes=pdrv.array({"reply","release"})}
local invalidatedGeneration
local exports={
  entry=function(args,io) io.request({kind="state-publish",cell="entered",quality="valid",value=true}) end,
  invalidated=function(generation) invalidatedGeneration=generation end,
  idle=function() end,
  wait=function(args,io) return io.request({kind="message-wait",mailboxes=pdrv.array({"reply"}),timers=pdrv.array({})}) end,
  locked=function(args,io) io.request({kind="message-wait",mailboxes=pdrv.array({"release"}),timers=pdrv.array({})}) end,
  cycle=function(args,io)
    local grant=io.request({kind="connection-grant"})
    io.request({kind="connection-close",connection=grant:match("^([^|]+)")})
    if not invalidatedGeneration then error("invalidation lost") end
    io.request({kind="connection-reacquire"})
  end,
  direct=function(args,io) io.request({kind="read",maximum=1}) end,
  on_input=function(args,io)
    io.request({kind="write",value="H1:"..args.input})
    if selected=="fairness" then
      io.request({kind="message-send",mailbox="reply",value=args.input})
      io.request({kind="reschedule"})
      io.request({kind="write",value="H2:"..args.input})
      return
    end
    if args.input=="hold" then io.request({kind="message-wait",mailboxes=pdrv.array({"release"}),timers=pdrv.array({})}) end
    io.request({kind="reschedule"})
    if args.input=="release" then io.request({kind="message-send",mailbox="release",value="go"})
    else io.request({kind="message-send",mailbox="reply",value=args.input}) end
    io.request({kind="write",value="H2:"..args.input})
  end,
}
if selected=="zero" then handlers={}; description.mailboxes=pdrv.array({}) end
if selected=="omitted" then handlers=nil; description.mailboxes=nil end
if selected=="unresolved" then handler.binding="missing" end
if selected=="operation-role" then handler.binding="wait" end
if selected=="entry-role" then handler.binding="entry" end
if selected=="unknown-event" then handler.event.kind="operation-end" end
if selected=="unavailable-channel" then handler.event.channelId="ungranted" end
if selected=="unavailable-capability" then handler.requires=pdrv.array({"usb.control"}) end
if selected=="over-reservation" then handler.maximumConcurrent=32.0 end
if selected=="one-slot" then handler.maximumConcurrent=1.0 end
if selected=="duplicate-binding" or selected=="duplicate-consumer" or selected=="duplicate-id" then
  handlers[2]={id=selected=="duplicate-id" and "receiver" or "other",binding=selected=="duplicate-binding" and "on_input" or "other_input",
    event={kind="channel-input",channelId=selected=="duplicate-consumer" and "main" or "other"},maximumConcurrent=1.0,locks=pdrv.array({}),requires=pdrv.array({})}
  exports.other_input=exports.on_input
end
if selected=="too-many" then
  handlers={}
  for i=1,65 do
    local id="handler"..i
    handlers[i]={id=id,binding=id,event={kind="channel-input",channelId="channel"..i},maximumConcurrent=1.0,locks=pdrv.array({}),requires=pdrv.array({})}
    exports[id]=exports.on_input
  end
end
if handlers then description.handlers=pdrv.array(handlers) end
return description,exports
