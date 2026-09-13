-- TI-Nspire USB module for device information and screenshot capture.
local array = pdrv.array
local direct = array({"channel.read", "channel.write", "timer"})

local ASSIGN_ADDRESS = "\x64\x00\x40\x03\x64\x01\x40\x03\x13\x43\x00\x01\xfb\x64\x01\xff\x00"
local buffer, active, completed_name, completed_screen, wanted_write = "", nil, nil, nil, nil
local request_sequence, consecutive_unknown = 1, 0
local idle_address_settled_at = nil
local idle_owner = {kind="idle", login=false, disconnect=false, address=false}

local function fail(code, details) pdrv.fail("ti-nspire." .. code, details or {}) end
local function bytes(value) return pdrv.bytes(value) end

local function navnet_checksum(value)
  local checksum = 0
  for index = 1, #value do
    local byte = value:byte(index)
    local first = (byte << 8) | (checksum >> 8)
    checksum = checksum & 0xff
    local second = ((((checksum & 0x0f) << 4) ~ checksum) << 8) & 0xffff
    local third = second >> 5
    checksum = ((third >> 7) ~ first ~ second ~ third) & 0xffff
  end
  return checksum
end

local function wire_frame(payload)
  local decoded_length = #payload - 13
  if decoded_length < 1 or decoded_length > 254 then fail("outbound-frame-length", {bytes=#payload}) end
  return "\x54\xfd" .. payload:sub(1, 10) .. string.char(decoded_length) .. payload:sub(11)
end

local function projected(frame)
  return frame:sub(3, 12) .. frame:sub(14)
end

local function close(io)
  local grant = io.request({kind="connection-grant"})
  io.request({kind="connection-close", connection=grant:match("^([^|]+)")})
end

local function direct_write(io, payload)
  io.request({kind="write", value=bytes(wire_frame(payload))})
end

local function allocate_sequence()
  if request_sequence > 255 then fail("request-sequence-exhausted") end
  local value = request_sequence
  request_sequence = request_sequence + 1
  return value
end

local function information_request()
  local sequence = allocate_sequence()
  return string.char(
    0x64, 0x00, 0x83, 0x04, 0x64, 0x01, 0x40, 0x20,
    0x02, 0x00, 0x00, sequence, (sequence + 4) % 256, 0x02
  )
end

local function screenshot_request()
  local sequence = allocate_sequence()
  return string.char(
    0x64, 0x00, 0x80, 0x06, 0x64, 0x01, 0x40, 0x24,
    0x00, 0x00, 0x00, sequence, (sequence + 5) % 256, 0x00
  )
end

local function validate_checksums(frame, stem)
  local observed_data = (frame:byte(11) << 8) | frame:byte(12)
  local expected_data = navnet_checksum(frame:sub(17))
  if observed_data ~= expected_data then
    fail(stem .. "-data-checksum", {observed=observed_data, expected=expected_data})
  end
  local header = 0
  for index = 1, 15 do header = header + frame:byte(index) end
  header = header & 0xff
  if frame:byte(16) ~= header then
    fail(stem .. "-header-checksum", {observed=frame:byte(16), expected=header})
  end
end

local function acknowledgement(frame)
  local service_high, service_low = frame:byte(5, 6)
  local host_high, host_low = frame:byte(9, 10)
  local acknowledged = string.char(host_high, host_low)
  local data_checksum = navnet_checksum(acknowledged)
  local sequence = frame:byte(15)
  local prefix = string.char(
    0x64, 0x00, 0x00, 0xff, 0x64, 0x01, service_high, service_low,
    (data_checksum >> 8) & 0xff, data_checksum & 0xff, 0x0a, sequence
  )
  local header_checksum = 0x54 + 0xfd + 0x02
  for index = 1, #prefix do header_checksum = header_checksum + prefix:byte(index) end
  return prefix .. string.char(header_checksum & 0xff) .. acknowledged
end

local function service_unavailable(frame)
  local source_high, source_low = frame:byte(5, 6)
  local sequence = frame:byte(15)
  return string.char(
    0x64, 0x00, 0x00, 0xd3, 0x64, 0x01, source_high, source_low, 0x50, 0x40,
    0x0a, sequence, (source_low + sequence + 9) % 256, 0x40, 0x50
  )
end

local function disconnect_acknowledgement(frame)
  local service_high, service_low = frame:byte(17, 18)
  local sequence = frame:byte(15)
  return string.char(
    0x64, 0x00, 0x00, 0xff, 0x64, 0x01, service_high, service_low, 0x50, 0x40,
    0x0a, sequence, (service_high + service_low + sequence + 181) % 256, 0x40, 0x50
  )
end

local function classify(frame)
  local payload = projected(frame)
  if payload == "\x00\x00\x40\x03\x00\x00\x40\x03\xec\x0f\x00\x01\xd5\x0f\xec" then
    return "address-request"
  end
  if #payload == 15 and payload:sub(1, 6) == "\x64\x01\x00\xff\x64\x00"
      and payload:sub(11, 11) == "\x0a" then
    return "reception-acknowledgement"
  end
  if #payload == 19 and payload:sub(1, 2) == "\x64\x01"
      and payload:sub(5, 11) == "\x64\x00\x40\x50\x39\x76\x00"
      and payload:sub(14, 19) == "\x02\x00\x00\x00\x00\x00" then
    return "login-request"
  end
  if #payload == 15 and payload:sub(1, 8) == "\x64\x01\x40\xde\x64\x00\x40\x50"
      and payload:sub(11, 11) == "\x00" then
    return "disconnect"
  end
  if frame:sub(5, 6) == "\x40\x20" then return "device-information" end
  if frame:sub(5, 6) == "\x40\x24" then return "screenshot" end
  return "unknown"
end

local function handle_event(kind, frame, io)
  local owner = active or idle_owner
  if kind == "reception-acknowledgement" then return end
  if kind == "login-request" then
    if owner.kind ~= "probe" and owner.kind ~= "screenshot" then return end
    if owner.login then return end
    direct_write(io, service_unavailable(frame)); owner.login = true; return
  end
  if kind == "disconnect" then
    if owner.kind ~= "probe" and owner.kind ~= "information" and owner.kind ~= "screenshot" and owner.kind ~= "idle" then return end
    if owner.disconnect then return end
    direct_write(io, disconnect_acknowledgement(frame)); owner.disconnect = true; return
  end
  if kind == "address-request" then
    if owner.kind ~= "probe" and owner.kind ~= "information" and owner.kind ~= "screenshot" and owner.kind ~= "idle" then return end
    if active ~= nil and owner.address then return end
    if active == nil then
      local now = io.request({kind="clock-observe"}).elapsedUs
      if idle_address_settled_at ~= nil and now - idle_address_settled_at < 152000 then return end
    end
    direct_write(io, ASSIGN_ADDRESS)
    request_sequence = 1
    if active == nil then idle_address_settled_at = io.request({kind="clock-observe"}).elapsedUs end
    if active ~= nil then owner.address = true end
  end
end

local function accept_information(frame, io)
  if #frame ~= 27 then fail("information-operation-frame-length", {observed=#frame}) end
  local payload = projected(frame)
  if payload:sub(1, 11) ~= "\x64\x01\x40\x20\x64\x00\x83\x04\x38\x5a\x00"
      or payload:sub(14, 14) ~= "\x02" or payload:sub(24, 24) ~= "\x00" then
    fail("information-layout")
  end
  validate_checksums(frame, "information")
  if active == nil or (active.kind ~= "probe" and active.kind ~= "information") then
    fail("unowned-device-information")
  end
  if active.complete then fail("information-extra-response") end
  direct_write(io, acknowledgement(frame))
  completed_name = payload:sub(15, 23)
  active.complete = true
  if active.kind == "information" then
    io.request({kind="message-send", mailbox="reply", value="information"})
  end
end

local function validate_screenshot_header(logical)
  if #logical < 14 then return nil end
  local compressed = ((logical:byte(1) << 24) | (logical:byte(2) << 16)
    | (logical:byte(3) << 8) | logical:byte(4))
  if compressed < 600 or compressed > 76800 then
    fail("screenshot-compressed-length", {observed=compressed})
  end
  if logical:sub(5, 14) ~= "\x00\x00\x00\x00\x01\x40\x00\xf0\x04\x00" then
    fail("screenshot-logical-header")
  end
  return compressed + 14
end

local function accept_screenshot(frame, io)
  if active == nil or active.kind ~= "screenshot" then fail("unowned-screenshot") end
  validate_checksums(frame, "screenshot")
  local marker = frame:byte(17)
  if marker ~= 1 and marker ~= 2 then fail("screenshot-member-marker", {observed=marker}) end
  if (active.members == 0 and marker ~= 1) or (active.members > 0 and marker ~= 2) then
    fail("screenshot-member-order", {member=active.members + 1, marker=marker})
  end
  local content = frame:sub(18)
  if #content < 1 then fail("screenshot-empty-non-final-segment") end
  local logical = active.logical .. content
  local expected = active.expected or validate_screenshot_header(logical)
  if expected ~= nil and #logical > expected then
    fail("screenshot-trailing-transaction-residue", {expected=expected, observed=#logical})
  end
  direct_write(io, acknowledgement(frame))
  active.logical, active.expected, active.members = logical, expected, active.members + 1
  if expected ~= nil and #logical == expected then
    completed_screen = logical:sub(15)
    io.request({kind="message-send", mailbox="reply", value="screenshot-complete"})
  else
    io.request({kind="message-send", mailbox="reply", value="screenshot-member"})
  end
end

local function accept_frame(frame, io)
  local kind = classify(frame)
  if kind == "unknown" then
    consecutive_unknown = consecutive_unknown + 1
    if consecutive_unknown >= 2 then fail("unknown-message-bound", {observed=consecutive_unknown}) end
    return
  end
  consecutive_unknown = 0
  if kind == "device-information" then accept_information(frame, io)
  elseif kind == "screenshot" then accept_screenshot(frame, io)
  else handle_event(kind, frame, io) end
end

local function take_frame()
  while true do
    local sync = buffer:find("\x54\xfd", 1, true)
    if sync == nil then
      if buffer:sub(-1) == "\x54" then buffer = "\x54" else buffer = "" end
      return nil
    end
    if sync > 1 then buffer = buffer:sub(sync) end
    if #buffer < 13 then return nil end
    local decoded = buffer:byte(13)
    if decoded < 1 or decoded > 254 or decoded + 16 > 270 then
      buffer = buffer:sub(2)
    else
      local extent = decoded + 16
      if #buffer < extent then return nil end
      local frame = buffer:sub(1, extent)
      buffer = buffer:sub(extent + 1)
      return frame
    end
  end
end

local function entry_frame(io, timer)
  while true do
    local frame = take_frame()
    if frame ~= nil then return frame end
    local missing = 1
    if #buffer >= 13 and buffer:sub(1, 2) == "\x54\xfd" then
      missing = math.min(256, buffer:byte(13) + 16 - #buffer)
    elseif #buffer > 0 then
      missing = math.min(256, 13 - #buffer)
    end
    local value = io.request({kind="wait-fill", count=math.max(1, missing), timers=array({timer})})
    if value:sub(1, 8) ~= "receive:" then fail("entry-timeout") end
    buffer = buffer .. value:sub(9)
  end
end

local function le16(value) return string.char(value & 0xff, (value >> 8) & 0xff) end
local function le32(value)
  return string.char(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
end
local pixel_lut = {}
for value = 0, 255 do
  local high, low = ((value >> 4) & 0x0f) * 17, (value & 0x0f) * 17
  pixel_lut[value] = string.char(high, high, high, low, low, low)
end

local function decode_screen(compressed)
  local output, input_offset, output_bytes = {}, 1, 0
  while input_offset <= #compressed do
    local control = compressed:byte(input_offset); input_offset = input_offset + 1
    if control >= 0x80 then
      local count = math.min(128, 0x101 - control)
      if input_offset + count - 1 > #compressed or output_bytes + count > 38400 then
        fail("screenshot-rle-literal-bound")
      end
      output[#output + 1] = compressed:sub(input_offset, input_offset + count - 1)
      input_offset = input_offset + count; output_bytes = output_bytes + count
    else
      local count = control + 1
      if input_offset > #compressed or output_bytes + count > 38400 then
        fail("screenshot-rle-repeat-bound")
      end
      output[#output + 1] = string.rep(string.char(compressed:byte(input_offset)), count)
      input_offset = input_offset + 1; output_bytes = output_bytes + count
    end
  end
  if output_bytes ~= 38400 then fail("screenshot-decoded-length", {observed=output_bytes}) end
  return table.concat(output)
end

local function write_bmp(io, compressed)
  local packed = decode_screen(compressed)
  local pixel_bytes = 230400
  local header = table.concat({"BM", le32(54 + pixel_bytes), le32(0), le32(54),
    le32(40), le32(320), le32(-240), le16(1), le16(24),
    le32(0), le32(pixel_bytes), le32(0), le32(0), le32(0), le32(0)})
  io.request({kind="resource-write", resource=io.resultDestination, value=bytes(header)})
  local chunks, chunk_bytes = {}, 0
  for index = 1, #packed do
    local pixels = pixel_lut[packed:byte(index)]
    chunks[#chunks + 1] = pixels; chunk_bytes = chunk_bytes + 6
    if chunk_bytes >= 16380 then
      io.request({kind="resource-write", resource=io.resultDestination, value=bytes(table.concat(chunks))})
      chunks, chunk_bytes = {}, 0
    end
  end
  if chunk_bytes > 0 then
    io.request({kind="resource-write", resource=io.resultDestination, value=bytes(table.concat(chunks))})
  end
end

local information_result = {kind="value", type={kind="record",
  fields={name={kind="bytes", minimumLength=9, maximumLength=9}},
  fieldLabels={name="Handheld name"}}}
local screenshot_result = {kind="file", direction="out",
  content="Current 320 by 240 4-bit grayscale display", mediaType="image/bmp",
  suggestedExtension="bmp", minimumBytes=230454, maximumBytes=230454}
local function operation(id, title, description, result, binding)
  return {id=id, title=title, description=description, binding=binding, arguments={}, result=result,
    risk="read-only", repeatability="safe-to-repeat", locks=array({"protocol"}), writeVia="receiver",
    requires=array({"channel.write-via", "mailbox", "timer", "operation.deadline"}),
    cleanup={binding="cleanup", requires=array({"connection.lifecycle"}),
      maximumMilliseconds=50, maximumLuaFuel=10000, maximumWork=100000},
    availability={modes=array({"device_information"}), profiles=array({"usb"})}}
end

return {
  apiVersion="device/v2", id="ti-nspire-handheld", displayName="TI-Nspire Handheld",
  description="Read device information and capture the display through measured NavNet exchanges.",
  modes=array({"device_information"}),
  modePresentation={device_information={label="Handheld services",
    description="Assign the retained addresses, maintain measured login and disconnect events, then expose bounded read-only device-information and screenshot operations."}},
  profiles=array({"usb"}), mailboxes=array({"reply"}), invalidation="invalidated",
  connectionProfiles={usb={modes=array({"device_information"}),
    acquisitionFilters=array({{transport="usb", vendorId=1105, productId=57362, usbClass=255}}),
    requiredProductName="TI-Nspire(tm) Handheld",
    transport={kind="usb", configurationValue=1, interfaceNumber=0, alternateSetting=0,
      channels=array({{id="main",
        input={endpointNumber=1, transferType="bulk", maximumPacketBytes={full=64}},
        output={endpointNumber=1, transferType="bulk", maximumPacketBytes={full=64}}}})}},
  },
  entry={binding="entry", locks=array({"protocol"}), requires=direct, handoffTo="receiver"},
  handlers=array({{id="receiver", binding="receive", acceptHandoff="accept", authorizeWrite="authorize",
    event={kind="channel-input", channelId="main"}, maximumConcurrent=4, locks=array({"parser"}),
    requires=array({"channel.input", "channel.write", "mailbox", "clock.observe"})}}),
  operations=array({
    operation("read-device-information", "Read device information",
      "Read the handheld name through the measured device-information service.", information_result, "read_information"),
    operation("capture_screenshot", "Capture screenshot",
      "Read the current display and return a BMP image that can be saved and opened directly.", screenshot_result, "capture_screenshot"),
  }),
}, {
  invalidated=function()
    buffer, active, completed_name, completed_screen, wanted_write = "", nil, nil, nil, nil
    request_sequence, consecutive_unknown, idle_address_settled_at = 1, 0, nil
    idle_owner = {kind="idle", login=false, disconnect=false, address=false}
  end,
  entry=function(context, io)
    if context.modeId ~= "device_information" or context.profileId ~= "usb" then fail("entry-context") end
    buffer, active, completed_name, completed_screen, wanted_write = "", nil, nil, nil, nil
    request_sequence, consecutive_unknown, idle_address_settled_at = 1, 0, nil
    idle_owner = {kind="idle", login=false, disconnect=false, address=false}
    local ok, failure = pcall(function()
      direct_write(io, ASSIGN_ADDRESS); request_sequence = 1
      active = {kind="probe", login=false, disconnect=false, address=false, complete=false}
      local timer = io.request({kind="timer-arm", milliseconds=500})
      direct_write(io, information_request())
      while not active.complete do
        accept_frame(entry_frame(io, timer), io)
      end
      io.request({kind="timer-cancel", timer=timer})
      active, completed_name = nil, nil
      idle_owner = {kind="idle", login=false, disconnect=false, address=false}
      if #buffer ~= 0 then fail("entry-parser-residue", {bytes=#buffer}) end
      if io.request({kind="entry-handoff", parser="empty", timers="none"}) ~= "accepted" then fail("entry-handoff") end
    end)
    if not ok then close(io); error(failure) end
  end,
  accept=function(offer) return {accepted=offer.parser=="empty" and offer.timers=="none"} end,
  authorize=function(request)
    return {accepted=active~=nil and request.operation~=nil and request.bytes==wanted_write}
  end,
  receive=function(args, io)
    buffer = buffer .. args.input
    while true do
      local frame = take_frame()
      if frame == nil then break end
      accept_frame(frame, io)
    end
    if #buffer > 270 then fail("parser-capacity", {bytes=#buffer}) end
  end,
  cleanup=function(outcome, io)
    wanted_write = nil
    if outcome.outcome ~= "completed" then close(io) end
  end,
  read_information=function(_, io)
    io.request({kind="deadline-arm", milliseconds=500})
    active = {kind="information", login=false, disconnect=false, address=false, complete=false}
    completed_name = nil
    wanted_write = wire_frame(information_request())
    io.request({kind="write-via", value=bytes(wanted_write)}); wanted_write = nil
    local timer = io.request({kind="timer-arm", milliseconds=500})
    local reply = io.request({kind="message-wait", mailboxes=array({"reply"}), timers=array({timer})})
    if reply ~= "message:reply:information" or completed_name == nil then fail("information-timeout") end
    io.request({kind="timer-cancel", timer=timer})
    local name = completed_name
    active, completed_name = nil, nil
    idle_owner = {kind="idle", login=false, disconnect=false, address=false}
    return {name=bytes(name)}
  end,
  capture_screenshot=function(_, io)
    io.request({kind="deadline-arm", milliseconds=31000})
    active = {kind="screenshot", login=false, disconnect=false, address=false,
      members=0, logical="", expected=nil}
    completed_screen = nil
    wanted_write = wire_frame(screenshot_request())
    io.request({kind="write-via", value=bytes(wanted_write)}); wanted_write = nil
    local aggregate, inter = nil, nil
    while completed_screen == nil do
      local timers = {}
      if aggregate ~= nil then timers[#timers + 1] = aggregate end
      if inter ~= nil then timers[#timers + 1] = inter end
      local reply = io.request({kind="message-wait", mailboxes=array({"reply"}), timers=array(timers)})
      if reply == "message:reply:screenshot-member" then
        if aggregate == nil then aggregate = io.request({kind="timer-arm", milliseconds=30000}) end
        if inter ~= nil then io.request({kind="timer-cancel", timer=inter}) end
        inter = io.request({kind="timer-arm", milliseconds=1000})
      elseif reply ~= "message:reply:screenshot-complete" then
        if aggregate ~= nil and reply == "timer:" .. aggregate then fail("screenshot-reassembly-timeout") end
        fail("screenshot-inter-segment-timeout")
      end
    end
    if inter ~= nil then io.request({kind="timer-cancel", timer=inter}) end
    if aggregate ~= nil then io.request({kind="timer-cancel", timer=aggregate}) end
    local compressed = completed_screen
    active, completed_screen = nil, nil
    idle_owner = {kind="idle", login=false, disconnect=false, address=false}
    write_bmp(io, compressed)
    return io.resultDestination
  end,
}
