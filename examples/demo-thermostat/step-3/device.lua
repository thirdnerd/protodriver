-- Step 3: read_status is real; set_target remains an explicit placeholder.
local array = pdrv.array
local lock = array({"protocol"})
local direct_io = array({"channel.read", "channel.write", "timer"})
local operation_io = array({"channel.read", "channel.write", "timer", "operation.deadline"})
local temperature = {kind="integer", widthBits=16, signed=true, minimum=500, maximum=3500,
  unit={kind="fixed", id="centidegree-celsius"}}
local availability = {modes=array({"thermostat"}), profiles=array({"serial"})}

local function line(io, request)
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
    if value < 32 or value > 126 then pdrv.fail("demo-thermostat.non-ascii-reply", {}) end
    if count == 65 then pdrv.fail("demo-thermostat.line-too-long", {}) end
    parts[count] = byte
  end
end

local function integer(text, minimum, maximum)
  if not text:match("^%d+$") then return nil end
  local value = tonumber(text)
  if not value or tostring(value) ~= text or value < minimum or value > maximum then return nil end
  return value
end

return {
  apiVersion="device/v2", id="demobench-thermostat", displayName="DemoBench thermostat",
  modes=array({"thermostat"}), profiles=array({"serial"}),
  connectionProfiles={serial={modes=array({"thermostat"}),
    acquisitionFilters=array({{transport="serial", vendorId=0x1209, productId=0xd001}}),
    transport={kind="serial", baudRate=9600, dataBits=8, parity="none", stopBits=1,
      flowControl="none"},
    channels=array({{id="main", protocolDuplex="half-duplex"}}),
    lifecycle={openingDrainQuietMs=0, postTerminationSilence={minimumMs=0,
      afterAbnormalTermination=false, afterModeExit=false}}}},
  entry={binding="identify", locks=lock, requires=direct_io},
  operations=array({
    {id="read_status", title="Read status", binding="read_status", arguments={},
      result={kind="value", type={kind="record", fields={
        sequence={kind="integer", widthBits=32, signed=true, minimum=1, maximum=2147483647},
        temperature_centi_c=temperature, target_centi_c=temperature,
        heater={kind="enum", members=array({"on", "off"})}}}},
      risk="read-only", repeatability="safe-to-repeat", locks=lock,
      availability=availability, requires=operation_io},
    {id="set_target", title="Set target", binding="not_implemented",
      arguments={target_centi_c=temperature},
      result={kind="value", type={kind="record", fields={target_centi_c=temperature}}},
      risk="destructive", repeatability="not-repeatable", locks=lock,
      availability=availability, requires=array({})},
  }),
}, {
  identify=function(_, io)
    if line(io, "ID?") ~= "ID DEMOBENCH-THERMOSTAT 1" then
      pdrv.fail("demo-thermostat.identity-mismatch", {})
    end
  end,
  read_status=function(_, io)
    io.request({kind="deadline-arm", milliseconds=400})
    local response = line(io, "STATUS?")
    local sequence, current, target, heater = response:match(
      "^STATUS (%d+) (%d+) (%d+) (%a+)$")
    sequence = sequence and integer(sequence, 1, 2147483647)
    current = current and integer(current, 500, 3500)
    target = target and integer(target, 500, 3500)
    if not (sequence and current and target and heater == (current < target and "on" or "off")) then
      pdrv.fail("demo-thermostat.malformed-status", {reply=response})
    end
    return {sequence=sequence, temperature_centi_c=current,
      target_centi_c=target, heater=heater}
  end,
  not_implemented=function() pdrv.fail("demo-thermostat.not-implemented", {}) end,
}
