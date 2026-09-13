-- Qualified device-2 operation/state device/v2 module.
local array = pdrv.array
local modes, profiles = array({"interactive", "silent"}), array({"serial"})
local empty, protocol = array({}), array({"protocol"})
local interactive, buffer, skip_lf, draining = false, "", false, false
local route, echo, unknown_total, unknown_run = nil, nil, 0, 0
local recovery_phase, recovery_failed, stage_limit = nil, false, nil
local flush_epoch = 0
-- The bounded 10..5000 domain fits signed Lua integers. Unsigned ABI wrappers
-- are opaque crossing values, not numbers on which protocol code can operate.
local rate_type = {kind="integer", widthBits=16, signed=true, minimum=10, maximum=5000,
  unit={kind="fixed", id="millisecond"}}
local error_type = {kind="record", fields={
  code={kind="integer", widthBits=16, signed=true}, detail={kind="string", maximumLength=47}}}
local function record(fields) return {kind="value", type={kind="record", fields=fields}} end
local function operation(id, title, arguments, result, risk, repeatability)
  return {id=id, title=title, binding=id, arguments=arguments, result=result,
    risk=risk, repeatability=repeatability, locks=protocol, writeVia="receiver",
    availability={modes=modes, profiles=profiles}, requires=array({"channel.write-via", "mailbox", "timer", "operation.deadline"})}
end
local poll = {kind="poll", mode="interactive", operation="get_rate", intervalMs=5000,
  failureBackoffMs=30000, suspendWhileLocksHeld=protocol}
local description = {
  apiVersion="device/v2", id="device-2-authored", modes=modes, profiles=profiles,
  connectionProfiles={serial={modes=modes,
    acquisitionFilters=array({{transport="serial",vendorId=1155,productId=14155}}),
    transport={kind="serial",baudRate=115200,dataBits=8,parity="none",stopBits=1,flowControl="none"},
    channels=array({{id="main",protocolDuplex="full-duplex"}}),
    lifecycle={openingDrainQuietMs=0,postTerminationSilence={minimumMs=0,afterAbnormalTermination=false,afterModeExit=false}}}},
  entry={binding="enter", locks=protocol, requires=array({"channel.read", "channel.write", "timer"}), handoffTo="receiver"},
  handlers=array({{id="receiver", binding="on_input", acceptHandoff="accept_handoff", authorizeWrite="authorize_write",
    event={kind="channel-input", channelId="main"}, maximumConcurrent=4, locks=array({"parser"}),
    requires=array({"channel.input", "mailbox"})}}),
  mailboxes=array({"reply"}),
  state={
    protocol_fault={type={kind="record",fields={
      reason={kind="enum",members=array({"consecutive-unknown-message-bound"})},
      consecutive={kind="integer",widthBits=16,signed=true,minimum=4,maximum=4}}},freshForMs=pdrv.null},
    recovery={type={kind="record",fields={
      phase={kind="enum",members=array({"flush","sync","entry","ready","failed"})},
      discarded={kind="integer",widthBits=32,signed=true,minimum=0,maximum=2048}}},freshForMs=pdrv.null},
    -- A snapshot holds only the latest occurrence. Mandatory capture records
    -- every accepted publication in order, beside the original native bytes.
    unknown_line={type={kind="record",fields={
      count={kind="integer",widthBits=32,signed=true,minimum=1,maximum=2147483647},
      line={kind="string",maximumLength=95}}},freshForMs=pdrv.null},
    sample_rate_ms={type=rate_type, freshForMs=5500, refresh=poll},
    sample_rate_is_slowest={type={kind="boolean"}, freshForMs=pdrv.null, dependsOn=array({"sample_rate_ms"})},
    alarm_channel={type={kind="enum", members=array({"CH1", "CH2"})}, freshForMs=pdrv.null},
    alarm_level={type={kind="enum", members=array({"HIGH", "LOW"})}, freshForMs=pdrv.null},
  },
  operations=array({
    operation("get_device_info", "Get device information", {}, record({identity={kind="string", maximumLength=20}}), "read-only", "safe-to-repeat"),
    operation("get_rate", "Get sample rate", {}, record({milliseconds=rate_type}), "read-only", "safe-to-repeat"),
    operation("set_rate", "Set sample rate", {rate=rate_type}, record({applied={kind="boolean"}}), "changes-state", "safe-to-repeat"),
    operation("query_errors", "Drain error history", {}, record({errors={kind="array", maximumLength=8, item=error_type}}), "destructive", "not-repeatable"),
    operation("recover", "Flush, synchronize and re-establish", {}, record({
      recovered={kind="boolean"},discarded={kind="integer",widthBits=32,signed=true,minimum=0,maximum=2048}}), "changes-state", "not-repeatable"),
  }),
}
local function arm(io, milliseconds) return {id=io.request({kind="timer-arm", milliseconds=milliseconds}),live=true} end
local function cancel(io, timer)
  if timer.live then io.request({kind="timer-cancel", timer=timer.id});timer.live=false end
end
local function assert(value, message)
  if not value then pdrv.fail("device-2.response", {message=message or "unexpected protocol response"}) end
  return value
end
local function identity(line)
  local tail=line:match("^D2%-LABS,D2%-MON,(.+)$")
  assert(tail and #tail<=20, "invalid identity response")
  return {identity=tail}
end
local function error_line(line)
  local body=line:sub(1,4)=="ERR " and line:sub(5) or line
  local code,detail=body:match('^([+-]?%d+),"([^"]*)"$')
  if not code then return end
  code=tonumber(code)
  if code < -32768 or code > 32767 or #detail>47 then return end
  return {code=code, detail=detail}
end
local function known_response(line)
  if line=="OK" or line=="END" then return true end
  local tail=line:match("^D2%-LABS,D2%-MON,(.*)$")
  if tail then return #tail<=20 end
  local rate=line:match("^%d+$") and #line<=4 and tonumber(line)
  return rate and rate>=10 and rate<=5000
end
local function alarm(line, io)
  local channel,level,number,unit=line:match("^[Aa][Ll][Aa][Rr][Mm] ([Cc][Hh][12]) ([A-Za-z]+) ([+-]?[%d.eE+-]+)%s*([mV]+)$")
  if not channel or (unit~="mV" and unit~="V") or not tonumber(number) then return false end
  level=level:upper(); if level~="HIGH" and level~="LOW" then return false end
  if interactive then
    io.request({kind="state-publish", cell="alarm_channel", quality="valid", value=channel:upper()})
    io.request({kind="state-publish", cell="alarm_level", quality="valid", value=level})
  end
  return true
end
local function frame(chunk, deliver)
  -- Native reads are not lines. Keep a partial line, and swallow LF after CR
  -- even when the pair straddles input activations.
  for i=1,#chunk do
    local c=chunk:sub(i,i)
    if skip_lf and c=="\n" then skip_lf=false
    elseif c=="\r" or c=="\n" then
      local line=buffer; buffer=""; skip_lf=c=="\r"
      if deliver(line)==false then return end
    else
      skip_lf=false; assert(c:byte()<128, "non-ASCII line")
      buffer=buffer..c; assert(#buffer<=95, "line exceeds 95 octets")
    end
  end
end
local function reply(io, timer)
  local timers={timer.id};if stage_limit then timers[#timers+1]=stage_limit.id end
  local answer=io.request({kind="message-wait", mailboxes=array({"reply"}), timers=array(timers)})
  if answer=="timer:"..timer.id then timer.live=false end
  if stage_limit and answer=="timer:"..stage_limit.id then stage_limit.live=false end
  assert(answer:sub(1,14)=="message:reply:", "response deadline")
  return answer:sub(15)
end
local function command(io, request, milliseconds, consume)
  assert(not recovery_failed or recovery_phase,"recovery required")
  -- Whole exchange, including an unresolved native write. Expiry revokes this
  -- operation; it cannot enter the pcall cleanup below and transmit again.
  local deadline=io.request({kind="deadline-arm",milliseconds=milliseconds})
  local timer=arm(io, milliseconds)
  local ok,value=pcall(function()
    assert(io.request({kind="write-via", value=request.."\r\n"})=="accepted-by-platform")
    if interactive then assert(reply(io,timer)==request, "exact echo mismatch") end
    return consume(function() return reply(io,timer) end)
  end)
  cancel(io,timer); draining=false;route=nil;echo=nil
  io.request({kind="deadline-disarm",deadline=deadline})
  if not ok then error(value) end
  return value
end
local function invalidate_knowledge(io)
  for _,cell in ipairs({"sample_rate_ms","alarm_channel","alarm_level"}) do
    io.request({kind="state-publish",cell=cell,quality="unknown",value=pdrv.null})
  end
end
local function recover(io)
  -- One explicit attempt. Never reissue the failed/destructive command.
  local discarded=0
  local function status(phase)
    recovery_phase=phase
    io.request({kind="state-publish",cell="recovery",quality="valid",value={phase=phase,discarded=discarded}})
  end
  recovery_failed=true;stage_limit=nil;route=nil;echo=nil;draining=false;buffer="";skip_lf=false
  flush_epoch=0
  -- Recovery invalidates device knowledge, not merely the framing buffer.
  -- The derived rate predicate inherits unknown from its rate basis.
  invalidate_knowledge(io)
  status("flush")
  local total,quiet,seen=arm(io,500),arm(io,20),flush_epoch
  local ok,value=pcall(function()
    while true do
      local got=io.request({kind="message-wait",mailboxes=array({"reply"}),timers=array({total.id,quiet.id})})
      if got=="timer:"..total.id then total.live=false;assert(false,"flush exceeded 500 ms") end
      if got=="timer:"..quiet.id then
        quiet.live=false
        -- Input can be observed by the owner before its mailbox send is
        -- accepted. An older quiet timer must not erase that intervening work.
        if flush_epoch==seen then break end
      else
        cancel(io,quiet)
        local n=got:match("^message:reply:flushed:(%d+)$")
        if n then
          local next_count=discarded+tonumber(n)
          assert(next_count<=2048,"flush exceeded 2048 octets")
          discarded=next_count;status("flush")
        end
      end
      seen=flush_epoch
      quiet=arm(io,20)
    end
    cancel(io,total)
    status("sync")
    command(io,"*IDN?",500,function(next_line) return identity(next_line()) end)
    status("entry");stage_limit=arm(io,interactive and 1100 or 600)
    local entry_deadline=io.request({kind="deadline-arm",milliseconds=interactive and 1100 or 600})
    if interactive then command(io,"",500,function(next_line) assert(next_line()=="OK","re-entry requires OK") end) end
    command(io,"*IDN?",500,function(next_line) return identity(next_line()) end)
    cancel(io,stage_limit);stage_limit=nil
    unknown_run=0;status("ready")
    io.request({kind="deadline-disarm",deadline=entry_deadline})
    io.request({kind="state-publish",cell="protocol_fault",quality="unknown",value=pdrv.null})
    recovery_failed=false
    return {recovered=true,discarded=discarded}
  end)
  cancel(io,total);cancel(io,quiet)
  if stage_limit then cancel(io,stage_limit);stage_limit=nil end
  if not ok then status("failed") end
  recovery_phase=nil;route=nil;echo=nil;draining=false
  if not ok then error(value) end
  return value
end
return description, {
  enter=function(selection,io)
    -- Echo is reset-scoped. Reopening a port does NOT reset this choice.
    interactive=selection.modeId=="interactive"
    local function exchange(request, expected)
      local timer,lines=arm(io,500),{}
      io.request({kind="write", value=request.."\r\n"})
      while #lines<#expected do
        local got=io.request({kind="wait-fill", count=1, timers=array({timer.id})})
        assert(got:sub(1,8)=="receive:", "entry deadline")
        frame(got:sub(9),function(line) if not alarm(line,io) then lines[#lines+1]=line end end)
      end
      -- Consume the LF paired with the last CR before offering empty parser state.
      if skip_lf then
        local got=io.request({kind="wait-fill", count=1, timers=array({timer.id})})
        assert(got=="receive:\n", "entry CRLF expected");skip_lf=false
      end
      cancel(io,timer)
      for i,want in ipairs(expected) do if want=="identity" then identity(lines[i]) else assert(lines[i]==want) end end
    end
    if interactive then exchange("", {"", "OK"}) end
    exchange("*IDN?", interactive and {"*IDN?", "identity"} or {"identity"})
    assert(io.request({kind="entry-handoff", parser="empty", timers="none"})=="accepted")
  end,
  accept_handoff=function(offer) return {accepted=offer.parser=="empty" and offer.timers=="none"} end,
  authorize_write=function(request)
    local op,wire=request.operation,request.bytes
    local approved=(op=="get_device_info" and wire=="*IDN?\r\n")
      or (op=="get_rate" and wire=="CONF:RATE?\r\n")
      or (op=="query_errors" and wire=="SYST:ERR:ALL?\r\n")
      or (op=="set_rate" and wire:match("^CONF:RATE %d+\r\n$"))
    -- An incomplete old line is not a safe boundary for the next request.
    if op=="recover" then approved=(recovery_phase=="sync" and wire=="*IDN?\r\n")
      or (recovery_phase=="entry" and (wire=="*IDN?\r\n" or (interactive and wire=="\r\n"))) end
    approved=not not (approved and buffer=="" and (not recovery_failed or op=="recover"))
    if approved then draining=op=="query_errors";route=op;echo=interactive and wire:sub(1,-3) or nil end
    return {accepted=approved}
  end,
  on_input=function(args,io)
    if recovery_phase=="flush" then
      flush_epoch=flush_epoch+1
      io.request({kind="message-send",mailbox="reply",value="flushed:"..tostring(#args.input)});return
    end
    -- A policy fault quarantines input until explicit recovery. No handler
    -- failure, connection turnover, automatic retry, or saved host handle.
    if recovery_failed and not recovery_phase then return end
    frame(args.input,function(line)
      if alarm(line,io) then unknown_run=0;return end
      -- History errors belong to the destructive drain; elsewhere they are
      -- uncorrelated events, not replies to whichever command happens to wait.
      if error_line(line) and not draining then unknown_run=0;return end
      if not route then
        -- Never enqueue idle input as the next command's answer. This is an
        -- authored occurrence record, not a host diagnostic code or device state.
        assert(known_response(line),"no matching response layout")
        assert(unknown_total<2147483647,"unknown occurrence counter exhausted")
        unknown_total=unknown_total+1;unknown_run=unknown_run+1
        if unknown_run==4 then recovery_failed=true end
        io.request({kind="state-publish",cell="unknown_line",quality="valid",value={count=unknown_total,line=line}})
        if unknown_run==4 then
          -- This is a complete, recognized line, not lost framing. Latch the
          -- protocol condition; pdrv.fail would destroy the recovery context.
          io.request({kind="state-publish",cell="protocol_fault",quality="valid",
            value={reason="consecutive-unknown-message-bound",consecutive=unknown_run}})
          invalidate_knowledge(io)
          return false -- quarantine this native delivery's remaining suffix too
        end
        return
      end
      unknown_run=0
      if echo then echo=nil
      elseif not draining or line=="END" then route=nil;draining=false end
      io.request({kind="message-send", mailbox="reply", value=line})
    end)
  end,
  recover=function(args,io) return recover(io) end,
  get_device_info=function(args,io)
    return command(io,"*IDN?",500,function(next_line) return identity(next_line()) end)
  end,
  get_rate=function(args,io)
    local value=command(io,"CONF:RATE?",500,function(next_line)
      local text=next_line();assert(text:match("^%d+$") and #text<=4,"rate spelling")
      local n=tonumber(text);assert(n>=10 and n<=5000,"rate range");return n
    end)
    if interactive then
      io.request({kind="state-publish", cell="sample_rate_ms", quality="valid", value=value})
      -- Host inherits validity from this basis; two effects never share a clock.
      io.request({kind="state-publish", cell="sample_rate_is_slowest", value=value==5000})
    end
    return {milliseconds=value}
  end,
  set_rate=function(args,io)
    return command(io,"CONF:RATE "..tostring(args.rate),500,function(next_line)
      assert(next_line()=="OK","setter requires OK");return {applied=true}
    end)
  end,
  query_errors=function(args,io)
    -- END, not an initial count, ends this destructive/non-repeatable drain.
    -- A ninth data line can be real if errors arrive during the drain; refuse
    -- it at the declared bound instead of retrying a partially consumed history.
    return command(io,"SYST:ERR:ALL?",1000,function(next_line)
      local errors,octets={},0
      for count=1,9 do
        local line=next_line();octets=octets+#line;assert(octets<=763,"history byte bound")
        if line=="END" then return {errors=array(errors)} end
        local parsed=error_line(line);assert(parsed,"invalid history entry")
        errors[#errors+1]=parsed
      end
      pdrv.fail("device-2.history-bound", {message="history line bound: END not reached"})
    end)
  end,
}
