-- D1-CHAN serial module for device/status queries and channel configuration.
local wire = require("channel-wire.lua")
local layout = require("channel-layout.lua")
local array = pdrv.array
local protocol_locks = array({ "protocol" })
local operation_requirements =
  array({ "channel.read", "channel.write", "timer", "connection.lifecycle", "operation.deadline" })
local cleanup_requirements = array({ "channel.read", "channel.write", "timer", "connection.lifecycle" })
local protocol_ready, connection_disturbed = false, false
local failure_before_write = false
local function publish(io, cell, value)
  io.request({ kind = "state-publish", cell = cell, quality = "valid", value = value })
end
local function fault(io, code)
  protocol_ready = false
  publish(io, "protocol_fault", code)
end
local function restore(io, ordinary)
  wire.replace(io)
  wire.enter(io, ordinary)
  protocol_ready = true
  connection_disturbed = false
end
local function reenter(_, io)
  wire.recover(io)
  protocol_ready = true
end
local function guarded(body)
  return function(args, io, context)
    if not protocol_ready then
      pdrv.fail("device-1.recovery-required", {})
    end
    failure_before_write = false
    local ok, result = pcall(body, args, io)
    if ok then
      return result
    end
    local code = tostring(result)
    if not code:match("^device%-1%.") then
      code = "device-1.operation-failed"
    end
    if failure_before_write then
      pdrv.fail(code, { recovered = false })
    end
    fault(io, code)
    -- Recovery settles readiness, NEVER retries the failed/destructive command.
    if not connection_disturbed then
      local recovered = pcall(wire.recover, io)
      if recovered then
        protocol_ready = true
      end
    end
    pdrv.fail(code, { recovered = protocol_ready })
  end
end
local tag_fields = {}
for index = 0, 14 do
  tag_fields["tag" .. index] = { kind = "bytes", minimumLength = 1, maximumLength = 1 }
end
local sector_bytes = { kind = "bytes", minimumLength = 4096, maximumLength = 4096 }
local function channel_result_type(includes_write_count)
  local fields = {
    sectorBase = { kind = "integer", widthBits = 32, signed = false, maximum = 0xffffff },
    raw = sector_bytes,
    tags = { kind = "record", fields = tag_fields },
    channels = { kind = "array", minimumLength = 250, maximumLength = 250, item = layout.rowType },
  }
  if includes_write_count then
    fields.writeTransactions = { kind = "integer", widthBits = 32, signed = false, minimum = 64, maximum = 64 }
  end
  return { kind = "record", fields = fields }
end
local function operation(id, binding, result, arguments, destructive, restart)
  return {
    id = id,
    title = id,
    binding = binding,
    arguments = arguments or {},
    result = { kind = "value", type = result },
    risk = destructive and "destructive" or "read-only",
    repeatability = destructive and "not-repeatable" or "safe-to-repeat",
    locks = protocol_locks,
    requires = operation_requirements,
    availability = { modes = array({ "transfer" }), profiles = array({ "serial" }) },
    reentry = { binding = "reenter", requires = operation_requirements },
    cleanup = restart and {
      binding = "cleanup",
      requires = cleanup_requirements,
      maximumMilliseconds = 4900,
      maximumLuaFuel = 100000,
      maximumWork = 1000000,
    } or nil,
  }
end
local ping = operation("ping", "ping", {
  kind = "record",
  fields = {
    address = { kind = "integer", widthBits = 8, signed = true },
    length = {
      kind = "integer",
      widthBits = 8,
      signed = true,
    },
  },
})
ping.releaseAfterIdleMs = 30000
return {
  apiVersion = "device/v2",
  id = "d1-chan",
  modes = array({ "transfer" }),
  profiles = array({ "serial" }),
  connectionProfiles = {
    serial = {
      modes = array({ "transfer" }),
      acquisitionFilters = array({ { transport = "serial", vendorId = 0x1a86, productId = 0x7523 } }),
      transport = {
        kind = "serial",
        baudRate = 57600,
        dataBits = 8,
        parity = "none",
        stopBits = 1,
        flowControl = "none",
      },
      channels = array({ { id = "main", protocolDuplex = "half-duplex" } }),
      lifecycle = {
        openingDrainQuietMs = 300,
        postTerminationSilence = { minimumMs = 3000, afterAbnormalTermination = true, afterModeExit = true },
      },
    },
  },
  entry = {
    binding = "enter",
    locks = protocol_locks,
    requires = array({ "channel.read", "channel.write", "timer" }),
  },
  invalidation = "invalidated",
  state = {
    device_identity = { type = { kind = "string" }, freshForMs = pdrv.null },
    firmware_version = { type = { kind = "string" }, freshForMs = pdrv.null },
    status_raw = { type = { kind = "bytes", minimumLength = 2, maximumLength = 2 }, freshForMs = pdrv.null },
    protocol_fault = { type = { kind = "string" }, freshForMs = pdrv.null },
  },
  maintenance = array({
    {
      kind = "poll",
      mode = "transfer",
      operation = "ping",
      intervalMs = 200,
      failureBackoffMs = 200,
      maximumInterTransactionGapMs = 300,
      suspendWhileLocksHeld = protocol_locks,
      timing = { kind = "idle-reset", activity = "foreground-lifecycle" },
    },
  }),
  operations = array({
    operation("get_device_info", "info", {
      kind = "record",
      fields = {
        identity = { kind = "string" },
        firmware = { kind = "string" },
        maximumReadLength = { kind = "integer", widthBits = 8, signed = true },
        maximumWriteLength = { kind = "integer", widthBits = 8, signed = true },
      },
    }, {}, false, true),
    operation("get_status", "status", {
      kind = "record",
      fields = {
        raw = { kind = "bytes", minimumLength = 2, maximumLength = 2 },
        observedDuringProbe = {
          kind = "boolean",
        },
      },
    }, {}, false, true),
    ping,
    operation("read_channel_configuration", "read", channel_result_type(false)),
    operation("write_channel_configuration", "write", channel_result_type(true), {
      channelIndex = { kind = "integer", widthBits = 16, signed = true, minimum = 0, maximum = 249 },
      expectedCurrent = { kind = "byte-source", minimumBytes = 4096, maximumBytes = 4096 },
      edits = layout.editType,
    }, true),
  }),
}, {
  enter = function(_, io)
    wire.enter(io, false)
    protocol_ready = true
  end,
  invalidated = function()
    protocol_ready = false
  end,
  reenter = reenter,
  cleanup = function(_, io)
    if connection_disturbed then
      restore(io, false)
    end
  end,
  ping = guarded(function(_, io)
    wire.read(io, 0, 0)
    return { address = 0, length = 0 }
  end),
  info = guarded(function(_, io)
    connection_disturbed = true
    wire.replace(io)
    wire.exchange(io, "PSEARCH", "\x06P13GMRS", true)
    wire.exchange(io, "SYSINFO", "\x06", true)
    local reply = wire.exchange(io, "\x56\0\0\0\x01", { prefix = "\x56", header = 3, maximum = 10 }, true)
    wire.exchange(io, "\x06", "\x06", true)
    if reply:sub(1, 3) ~= "\x56\x01\x0a" or reply:sub(4) ~= "V06.03.009" then
      error("device-1.firmware-mismatch", 0)
    end
    wire.delay(io, 600)
    restore(io, true)
    publish(io, "device_identity", "P13GMRS")
    publish(io, "firmware_version", "V06.03.009")
    return { identity = "P13GMRS", firmware = "V06.03.009", maximumReadLength = 64, maximumWriteLength = 64 }
  end),
  status = guarded(function(_, io)
    connection_disturbed = true
    wire.replace(io)
    wire.exchange(io, "PSEARCH", "\x06P13GMRS", true)
    local raw = wire.exchange(io, "PASSSTA", 3, true)
    if raw:sub(1, 1) ~= "P" then
      error("device-1.unknown-message", 0)
    end
    raw = raw:sub(2)
    restore(io, true)
    publish(io, "status_raw", pdrv.bytes(raw))
    return { raw = pdrv.bytes(raw), observedDuringProbe = false }
  end),
  read = guarded(function(_, io)
    local base, observed, raw = wire.selected(io)
    return { sectorBase = base, raw = pdrv.bytes(raw), tags = observed, channels = layout.decode_sector(raw) }
  end),
  write = guarded(function(args, io)
    local base, observed, raw = wire.selected(io)
    -- The complete sector must decode and match the caller's expected bytes
    -- before the first of the protocol's 64 irreversible writes is issued.
    failure_before_write = true
    layout.decode_sector(raw)
    local edited = layout.edit(raw, args.channelIndex, args.edits)
    if args.expectedCurrent ~= pdrv.bytes(raw) then
      error("device-1.expected-current-mismatch", 0)
    end
    failure_before_write = false
    for offset = 0, 4095, 64 do
      wire.exchange(
        io,
        "W" .. wire.header(base + offset, 64) .. edited:sub(offset + 1, offset + 64),
        "\x06",
        true
      )
    end
    local verified = wire.sector(io, base)
    if verified ~= edited then
      error("device-1.channel-write-verification-mismatch", 0)
    end
    return {
      sectorBase = base,
      raw = pdrv.bytes(edited),
      tags = observed,
      channels = layout.decode_sector(verified),
      writeTransactions = 64,
    }
  end),
}
