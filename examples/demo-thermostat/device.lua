-- DemoBench's complete protocol is in PROTOCOL.md. This module knows only
-- serial requests and replies; the host, not this file, chooses the port.
local array = pdrv.array
local protocol_lock = array({"protocol"})
local direct_io = array({"channel.read", "channel.write", "timer"})
local operation_io = array({"channel.read", "channel.write", "timer", "operation.deadline"})
local temperature = {kind="integer", widthBits=16, signed=true, minimum=500, maximum=3500,
  unit={kind="fixed", id="centidegree-celsius"}}

-- A serial read is not a line read. Assemble one byte at a time, refusing
-- silence, non-ASCII bytes, and a line that exceeds the protocol's bound.
local function exchange(io, request)
  local timer = io.request({kind="timer-arm", milliseconds=300})
  io.request({kind="write", value=pdrv.bytes(request .. "\r")})
  local parts = {}
  for count=1,65 do
    local received = io.request({kind="wait-fill", count=1, timers=array({timer})})
    if received:sub(1,8) ~= "receive:" then
      pdrv.fail("demo-thermostat.response-timeout", {request=request})
    end
    local byte = received:sub(9)
    if byte == "\r" then
      io.request({kind="timer-cancel", timer=timer})
      return table.concat(parts)
    end
    local value = byte:byte()
    if value < 32 or value > 126 then
      pdrv.fail("demo-thermostat.non-ascii-reply", {})
    end
    if count == 65 then pdrv.fail("demo-thermostat.line-too-long", {}) end
    parts[count] = byte
  end
end

local function canonical_integer(text, minimum, maximum)
  if not text:match("^%d+$") then return nil end
  local value = tonumber(text)
  if not value or tostring(value) ~= text or value < minimum or value > maximum then return nil end
  return value
end

local description = {
  apiVersion="device/v2", id="demobench-thermostat", displayName="DemoBench thermostat",
  description="A small, fictional CR-framed serial thermostat.",
  modes=array({"thermostat"}), profiles=array({"serial"}),
  connectionProfiles={serial={modes=array({"thermostat"}),
    acquisitionFilters=array({{transport="serial", vendorId=0x1209, productId=0xd001}}),
    transport={kind="serial", baudRate=9600, dataBits=8, parity="none", stopBits=1,
      flowControl="none"},
    channels=array({{id="main", protocolDuplex="half-duplex"}}),
    lifecycle={openingDrainQuietMs=0, postTerminationSilence={minimumMs=0,
      afterAbnormalTermination=false, afterModeExit=false}}}},
  entry={binding="identify", locks=protocol_lock, requires=direct_io},
  operations=array({
    {id="read_status", title="Read status", binding="read_status", arguments={},
      description="Read a sequence-numbered temperature and target sample.",
      result={kind="value", type={kind="record", fields={
        sequence={kind="integer", widthBits=32, signed=true, minimum=1, maximum=2147483647},
        temperature_centi_c=temperature, target_centi_c=temperature,
        heater={kind="enum", members=array({"on", "off"})}}}},
      risk="read-only", repeatability="safe-to-repeat", locks=protocol_lock,
      availability={modes=array({"thermostat"}), profiles=array({"serial"})},
      requires=operation_io},
    {id="set_target", title="Set target", binding="set_target",
      description="Change the requested temperature; do not retry after uncertainty.",
      arguments={target_centi_c={kind="integer", widthBits=16, signed=true,
        minimum=500, maximum=3500, unit={kind="fixed", id="centidegree-celsius"}}},
      result={kind="value", type={kind="record", fields={target_centi_c=temperature}}},
      risk="destructive", repeatability="not-repeatable", locks=protocol_lock,
      availability={modes=array({"thermostat"}), profiles=array({"serial"})},
      requires=operation_io},
  }),
}

local bindings = {
  identify=function(_, io)
    -- A completed write does not identify a connected thermostat.
    if exchange(io, "ID?") ~= "ID DEMOBENCH-THERMOSTAT 1" then
      pdrv.fail("demo-thermostat.identity-mismatch", {})
    end
  end,
  read_status=function(_, io)
    io.request({kind="deadline-arm", milliseconds=400})
    local line = exchange(io, "STATUS?")
    local sequence, current, target, heater = line:match(
      "^STATUS (%d+) (%d+) (%d+) (%a+)$")
    sequence = sequence and canonical_integer(sequence, 1, 2147483647)
    current = current and canonical_integer(current, 500, 3500)
    target = target and canonical_integer(target, 500, 3500)
    if not (sequence and current and target and heater == (current < target and "on" or "off")) then
      pdrv.fail("demo-thermostat.malformed-status", {reply=line})
    end
    return {sequence=sequence, temperature_centi_c=current,
      target_centi_c=target, heater=heater}
  end,
  set_target=function(args, io)
    io.request({kind="deadline-arm", milliseconds=400})
    local requested = args.target_centi_c
    local reply = exchange(io, "SET " .. tostring(requested))
    if reply == "ERR RANGE" then
      pdrv.fail("demo-thermostat.range-refused", {target_centi_c=requested})
    end
    local applied = reply:match("^SET%-OK ([0-9]+)$")
    applied = applied and canonical_integer(applied, 500, 3500)
    if applied ~= requested then
      pdrv.fail("demo-thermostat.set-ack-mismatch", {reply=reply})
    end
    return {target_centi_c=applied}
  end,
}

return description, bindings
