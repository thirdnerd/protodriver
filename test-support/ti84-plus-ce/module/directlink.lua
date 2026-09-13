-- CE's retained DirectLink subset, not a general calculator protocol helper.
local M = {}
local function u32(s) return string.unpack(">I4", s) end
local function fail(reason, details)
  details = details or {}
  details.reason = reason
  pdrv.fail("ti84-plus-ce.directlink", details)
end
local function arm(io, ms) return io.request({kind="timer-arm",milliseconds=ms}) end
local function cancel(io, timer)
  if timer then io.request({kind="timer-cancel",timer=timer}) end
end
local function write(io, s) io.request({kind="write",value=pdrv.bytes(s)}) end
local ack = "\x00\x00\x00\x02\x05\xe0\x00"
local function kind(logical)
  if #logical == 5 and logical:byte(1) == 2 then return "buffer" end
  if #logical == 10 and logical:sub(1,6) == "\x00\x00\x00\x04\x00\x12" then return "mode" end
  if #logical == 10 and logical:sub(1,6) == "\x00\x00\x00\x04\xbb\x00" then return "delay" end
  if #logical == 153613 and logical:sub(1,13) == "\x00\x02\x58\x07\x00\x08\x00\x01\x00\x22\x00\x00\x00" then return "screen" end
  fail("unknown-logical-message", {bytes=#logical})
end

-- Entry reads directly under C1; the session parser uses its handler mailbox.
-- This coroutine survives partial assemblies so its timers keep their owner.
function M.parse(io, read, available, deliver)
  local whole, segment, parts, expected, size, count
  local function exact(n)
    local pieces, got = {}, 0
    while got < n do
      local timers = {}
      if whole then timers[#timers+1] = whole end
      if segment then timers[#timers+1] = segment end
      local bytes = read(math.min(256,n-got), timers)
      pieces[#pieces+1], got = bytes, got + #bytes
    end
    return table.concat(pieces)
  end
  while available() or parts do
    local length = u32(exact(4))
    if length > 1023 then fail("raw-frame-bound", {payloadBytes=length}) end
    local raw = exact(length+1)
    local marker, body, logical = raw:byte(1), raw:sub(2), nil
    -- Always-events bypass the active assembler, preserving its deadlines.
    if raw == "\x05\xe0\x00" then
    elseif marker == 4 and #body == 10 and body:sub(1,6) == "\x00\x00\x00\x04\xbb\x00" then
      write(io, ack)
    elseif marker == 3 or marker == 4 then
      if not parts then
        if #body < 6 then fail("initial-header-short", {bytes=#body}) end
        expected = u32(body) + 6
        if expected > 153613 then fail("logical-length-bound", {bytes=expected}) end
        parts, size, count = {}, 0, 0
      end
      if marker == 3 and #body < 64 then fail("continuation-short", {bytes=#body}) end
      size, count = size + #body, count + 1
      if size > expected or count > 2401 then
        fail("reassembly-bound", {bytes=size,segments=count,expectedBytes=expected})
      end
      parts[#parts+1] = body
      if marker == 4 then
        if size ~= expected then fail("final-length-mismatch", {bytes=size,expectedBytes=expected}) end
        logical = table.concat(parts)
        cancel(io, segment); cancel(io, whole)
        parts, segment, whole = nil, nil, nil
      else
        if not whole then whole = arm(io, 30000) end
        cancel(io, segment); segment = arm(io, 1000)
      end
      -- Validate first; even the final member ACK precedes publication.
      write(io, ack)
    elseif parts then fail("assembly-member-kind", {marker=marker})
    elseif marker == 2 and #raw == 5 then logical = raw
    else fail("unknown-raw-message", {marker=marker,bytes=#raw}) end
    if logical and deliver(kind(logical),logical) then return end
  end
end

function M.exchange(io, request, wanted, timeout)
  local command = arm(io, timeout)
  write(io, request)
  local answer
  M.parse(io,function(n,timers)
    timers[#timers+1] = command
    local result = io.request({kind="wait-fill",count=n,timers=pdrv.array(timers)})
    if result:sub(1,8) ~= "receive:" then fail("receive-deadline", {expected=wanted}) end
    return result:sub(9)
  end,function() return true end,function(name,packet)
    if name == wanted then answer=packet; return true end
    fail("unexpected-response", {expected=wanted,observed=name})
  end)
  cancel(io,command)
  return answer
end
return M
