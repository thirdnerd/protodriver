-- C1 authority probe, deliberately not a device protocol.
-- D5: each 300,000-addition body fits 1M Lua fuel; two bodies cannot share
-- that allowance and both finish. Single-sided arms qualify the prefix.
local selected = "accept"
local empty = pdrv.array({})
local modes, profiles = pdrv.array({"interactive","silent"}), pdrv.array({"serial"})
local offers = 0
return {
  apiVersion="device/v2", id="entry-handoff-probe", modes=modes, profiles=profiles,
  entry={binding="enter",locks=pdrv.array({"protocol"}),requires=pdrv.array({"channel.read","channel.write"}),handoffTo="receiver"},
  handlers=pdrv.array({{id="receiver",binding="input",acceptHandoff="accept",
    event={kind="channel-input",channelId="main"},maximumConcurrent=8,
    locks=pdrv.array({"protocol"}),requires=pdrv.array({"channel.input","channel.write","mailbox"})}}),
  mailboxes=pdrv.array({"reply"}),
  operations=pdrv.array({{id="collect",title="Collect real input",binding="collect",arguments={},
    result={kind="value",type={kind="string"}},risk="read-only",repeatability="not-repeatable",
    locks=empty,availability={modes=modes,profiles=profiles},requires=pdrv.array({"mailbox"})}}),
}, {
  enter=function(args,io)
    io.request({kind="write",value=args.modeId=="interactive" and "\r\n" or "*IDN?\r\n"})
    assert(io.request({kind="read",maximum=1})=="R")
    io.request({kind="reschedule"}) -- explicitly NOT a surrender
    if selected=="return" then return end
    if selected=="fuel-vm" or selected=="fuel-entry" or selected=="fuel-input" then local n=0;for i=1,300000 do n=n+i end;assert(n==45000150000) end
    if selected=="unsupported" then
      assert(io.request({kind="entry-handoff",parser="partial",timers="none"})=="refused")
    end
    if selected=="timer" then
      local timer=io.request({kind="timer-arm",milliseconds=100})
      assert(io.request({kind="entry-handoff",parser="empty",timers="none"})=="refused")
      io.request({kind="timer-cancel",timer=timer})
    end
    local answer=io.request({kind="entry-handoff",parser="empty",timers="none"})
    if selected=="refuse" or selected=="invalid" then
      assert(answer=="refused")
      assert(io.request({kind="read",maximum=1})=="L")
      answer=io.request({kind="entry-handoff",parser="empty",timers="none"})
    end
    if selected=="capacity" then
      assert(answer=="refused")
      assert(io.request({kind="read",maximum=4})=="LEFT")
      answer=io.request({kind="entry-handoff",parser="empty",timers="none"})
    end
    assert(answer=="accepted")
    if selected=="stale-write" then io.request({kind="write",value="UNAUTHORIZED"}) end
    if selected=="stale-read" then io.request({kind="read",maximum=1}) end
  end,
  accept=function(offer,io)
    assert(offer.parser=="empty" and offer.timers=="none" and offer.recipient=="receiver")
    assert(not pcall(function() offer.owner="forged" end))
    offers=offers+1
    if selected=="fuel-vm" or selected=="fuel-recipient" then local n=0;for i=1,300000 do n=n+i end;assert(n==45000150000) end
    if selected=="fuel" then for i=1,20000 do io.request({kind="reschedule"}) end end
    if selected=="invalid" and offers==1 then return {accepted="yes"} end
    return {accepted=selected~="refuse" or offers>1}
  end,
  input=function(args,io)
    if selected=="fuel-input" or selected=="fuel-input-only" then local n=0;for i=1,300000 do n=n+i end;assert(n==45000150000) end
    io.request({kind="write",value="H:"..args.input})
    io.request({kind="message-send",mailbox="reply",value=args.input})
  end,
  collect=function(args,io)
    return io.request({kind="message-wait",mailboxes=pdrv.array({"reply"}),timers=empty})
  end,
}
