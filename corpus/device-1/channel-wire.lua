-- Device-1 exchange-directed framing. A rejected variable response is ONE octet.
local M = {}
local array = pdrv.array
local function fail(code)
  error(code, 0)
end
local function receive(io, timer, count)
  local result = io.request({ kind = "wait-fill", count = count, timers = array({ timer.id }) })
  if result:sub(1, 8) ~= "receive:" then
    timer.live = false
    fail("device-1.response-timeout")
  end
  return result:sub(9)
end
function M.delay(io, ms)
  local timer = io.request({ kind = "timer-arm", milliseconds = ms })
  io.request({ kind = "wait-any", maximum = 0, timers = array({ timer }) })
end
-- Entry/cleanup have no operation-deadline authority. Their enclosing host
-- scope is bounded separately; ordinary writes additionally revoke at 300 ms.
function M.exchange(io, request, shape, ordinary)
  local timer = { id = io.request({ kind = "timer-arm", milliseconds = 300 }), live = true }
  local deadline = ordinary and io.request({ kind = "deadline-arm", milliseconds = 300 })
  io.request({ kind = "write", value = pdrv.bytes(request) })
  if deadline then
    io.request({ kind = "deadline-disarm", deadline = deadline })
  end
  local ok, reply = pcall(function()
    if type(shape) == "string" then
      local raw = receive(io, timer, #shape)
      if raw == "\0" then
        fail("device-1.device-rejected")
      end
      if raw ~= shape then
        fail("device-1.unknown-message")
      end
      return raw
    end
    if type(shape) == "number" then
      return receive(io, timer, shape)
    end
    local prefix = receive(io, timer, 1)
    if prefix == "\0" then
      fail("device-1.device-rejected")
    end
    if prefix ~= shape.prefix then
      fail("device-1.unknown-message")
    end
    local header = prefix .. receive(io, timer, shape.header - 1)
    local length = header:byte(shape.header)
    if length > shape.maximum then
      fail("device-1.frame-bound")
    end
    return header .. (length > 0 and receive(io, timer, length) or "")
  end)
  if timer.live then
    io.request({ kind = "timer-cancel", timer = timer.id })
  end
  if not ok then
    fail(reply)
  end
  return reply
end
function M.enter(io, ordinary)
  M.exchange(io, "PSEARCH", "\x06P13GMRS", ordinary)
  M.exchange(io, "P13GMRS", "\x06", ordinary)
  M.exchange(io, "\x02", string.rep("\xff", 8), ordinary)
  M.exchange(io, "\x06", "\x06", ordinary)
end
function M.replace(io)
  local grant = io.request({ kind = "connection-grant" })
  io.request({ kind = "connection-close", connection = grant:match("^([^|]+)") })
  io.request({ kind = "connection-reacquire" })
end
function M.recover(io)
  local deadline = io.request({ kind = "deadline-arm", milliseconds = 3500 })
  M.replace(io)
  io.request({ kind = "deadline-disarm", deadline = deadline })
  deadline = io.request({ kind = "deadline-arm", milliseconds = 1300 })
  M.enter(io, true)
  io.request({ kind = "deadline-disarm", deadline = deadline })
end
function M.header(address, length)
  return string.char(address % 256, (address // 256) % 256, (address // 65536) % 256, length)
end
function M.read(io, address, length)
  local suffix = M.header(address, length)
  local raw = M.exchange(io, "R" .. suffix, { prefix = "W", header = 5, maximum = 64 }, true)
  if raw:sub(2, 5) ~= suffix then
    fail("device-1.response-correlation")
  end
  -- Receipt of data is not settlement: its confirming ACK must be answered.
  M.exchange(io, "\x06", "\x06", true)
  return raw:sub(6)
end
function M.sector(io, base)
  local chunks = {}
  for offset = 0, 4095, 64 do
    chunks[#chunks + 1] = M.read(io, base + offset, 64)
  end
  return table.concat(chunks)
end
function M.selected(io)
  -- Exactly one of the fifteen tag octets must select the sector that follows;
  -- no tag and multiple tags are both unsafe write targets.
  local base, tags = nil, {}
  for index = 0, 14 do
    local tag = M.read(io, 0x1fff + index * 0x1000, 1)
    tags["tag" .. index] = pdrv.bytes(tag)
    if tag == "\x16" then
      if base then
        fail("device-1.ambiguous-sector")
      end
      base = 0x1000 + index * 0x1000
    end
  end
  if not base then
    fail("device-1.missing-sector")
  end
  return base, tags, M.sector(io, base)
end
return M
