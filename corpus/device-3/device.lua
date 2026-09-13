-- Device-3 revision-1 application protocol over serial and USB.
-- The public surface provides device information, diagnostics, and image writes;
-- explicit tooling can also invoke the private read_target verification binding.
-- All nine response selectors share the correlation policy below.
local array = pdrv.array
local buffers, entered, transaction, expected = {}, false, 0, nil
local active_id, active_cookie, active_generation
local read_reply
-- Device response bounds exclude the selected path's delivery allowance.
local delivery_allowance = 0
local response_channel = "main"
local function deadline_ms(ms)
  return ms + delivery_allowance
end
-- CRC32C uses the reflected Castagnoli polynomial. Build the lookup table once
-- while the module is admitted so each frame can process four octets at a time.
local crc32c_table = {}
for octet = 0, 255 do
  local remainder = octet
  for _ = 1, 8 do
    remainder = (remainder >> 1) ~ ((remainder & 1) == 1 and 0x82f63b78 or 0)
  end
  crc32c_table[octet] = remainder
end
local function pack_le16(value)
  return string.pack("<I2", value & 0xffff)
end
local function pack_le32(value)
  return string.pack("<I4", value & 0xffffffff)
end
local function unpack_le16(bytes, offset)
  local value = string.unpack("<I2", bytes, offset)
  return value
end
local function unpack_le32(bytes, offset)
  local value = string.unpack("<I4", bytes, offset)
  return value
end
local function unsigned_32(value)
  return value < 0 and value + 4294967296.0 or value
end
local function encode_hex(bytes)
  return (bytes:gsub(".", function(octet)
    return string.format("%02x", octet:byte())
  end))
end
local function decode_hex(text)
  return (text:gsub("..", function(pair)
    return string.char(tonumber(pair, 16))
  end))
end
local function crc32c(bytes)
  local remainder, byte_at = 0xffffffff, string.byte
  local complete_octets = #bytes - (#bytes % 4)
  for offset = 1, complete_octets, 4 do
    local first, second, third, fourth = byte_at(bytes, offset, offset + 3)
    remainder = (remainder >> 8) ~ crc32c_table[(remainder ~ first) & 255]
    remainder = (remainder >> 8) ~ crc32c_table[(remainder ~ second) & 255]
    remainder = (remainder >> 8) ~ crc32c_table[(remainder ~ third) & 255]
    remainder = (remainder >> 8) ~ crc32c_table[(remainder ~ fourth) & 255]
  end
  for offset = complete_octets + 1, #bytes do
    remainder = (remainder >> 8) ~ crc32c_table[(remainder ~ byte_at(bytes, offset)) & 255]
  end
  return remainder ~ 0xffffffff
end
local function encode_frame(message)
  local crc_subject = "\1" .. pack_le16(#message) .. message
  return "\xa5\x5a\xd3" .. crc_subject .. pack_le32(crc32c(crc_subject))
end
local router_begin, router_consume, router_done
local function feed(channel, bytes, deliver, io)
  -- Independent USB endpoints are independent framed streams. Parser suffixes
  -- remain with this owner through foreground cancellation and ABORT cleanup.
  local buffered = (buffers[channel] or "") .. bytes
  local consumed = 0
  while #buffered >= 6 do
    if
      buffered:sub(1, 4) ~= "\xa5\x5a\xd3\1"
      or unpack_le16(buffered, 5) < 4
      or unpack_le16(buffered, 5) > 2048
    then
      buffered = buffered:sub(2)
      consumed = consumed + 1
    else
      local frame_length = unpack_le16(buffered, 5) + 10
      if #buffered < frame_length then
        break
      end
      -- A false candidate may contain a complete real frame. Discard only
      -- its first sync octet; skipping the declared length would lose that frame.
      if crc32c(buffered:sub(4, frame_length - 4)) ~= unpack_le32(buffered, frame_length - 3) then
        buffered = buffered:sub(2)
        consumed = consumed + 1
      else
        local message = buffered:sub(7, frame_length - 4)
        buffered = buffered:sub(frame_length + 1)
        -- Receipt is a consumed wire range, not a new physical input event.
        if io then
          io.request({ kind = "input-consume", length = consumed + frame_length })
          router_consume(channel, consumed + frame_length)
        end
        consumed = 0
        deliver(message)
      end
    end
  end
  if io and consumed > 0 then
    io.request({ kind = "input-consume", length = consumed })
    router_consume(channel, consumed)
  end
  assert(#buffered <= 2058, "device-3.parser-capacity")
  buffers[channel] = buffered
end
local status_names = {
  "ok",
  "unsupported",
  "invalid-field",
  "invalid-state",
  "busy",
  "range",
  "out-of-window",
  "overlap",
  "data-conflict",
  "active-mismatch",
  "cookie-mismatch",
  "incomplete",
  "digest-mismatch",
  "flash-failure",
  "revision-conflict",
}
local response_names = {
  [1] = "identify",
  [2] = "get-diagnostics",
  [0x20] = "set-usb-identity",
  [0x30] = "bulk-query",
  [0x31] = "bulk-begin",
  [0x32] = "bulk-data",
  [0x33] = "bulk-finalize",
  [0x34] = "bulk-abort",
  [0x35] = "bulk-read",
}
local function require_zeroes(message, first, last)
  assert(message:sub(first, last) == string.rep("\0", last - first + 1), "device-3.reserved-field")
end
local function validate_message(message)
  assert(#message >= 4, "device-3.message-header")
  local kind, opcode = message:byte(1, 2)
  if kind == 3 then
    assert(unpack_le16(message, 3) == 0, "device-3.notification-transaction")
    if opcode == 0x80 then
      assert(#message == 32, "device-3.telemetry-layout")
      return "telemetry"
    end
    if opcode == 0x81 then
      assert(#message == 28, "device-3.window-layout")
      require_zeroes(message, 27, 28)
      return "bulk-window-ack"
    end
    assert(opcode == 0x82 and #message == 16 and message:byte(5) <= 1, "device-3.identity-pending-layout")
    require_zeroes(message, 6, 6)
    return "identity-pending"
  end
  local name, status = response_names[opcode], message:byte(5)
  assert(kind == 2 and name and status and status <= 14, "device-3.response-header")
  if status ~= 0 then
    assert(#message == 5, "device-3.error-layout")
    return opcode >= 0x30 and name .. "-error" or name
  end
  if opcode == 1 then
    assert(
      #message == 31 and message:byte(6) == 1 and message:byte(7) == 0x41 and message:byte(8) <= 1,
      "device-3.identify-layout"
    )
  elseif opcode == 2 then
    assert(#message == 37, "device-3.diagnostics-layout")
  elseif opcode == 0x20 or opcode == 0x34 then
    assert(#message == 5, "device-3.empty-response-layout")
  elseif opcode == 0x30 then
    assert(#message == 117 and message:byte(6) == 0 and message:byte(7) <= 4, "device-3.query-layout")
    require_zeroes(message, 115, 117)
  elseif opcode == 0x31 then
    assert(#message == 25, "device-3.begin-layout")
    require_zeroes(message, 23, 25)
  elseif opcode == 0x33 then
    assert(#message == 81, "device-3.finalize-layout")
  elseif opcode == 0x35 then
    assert(
      #message >= 12 and #message <= 1035 and unpack_le16(message, 10) == #message - 11,
      "device-3.read-layout"
    )
  else
    error("device-3.DATA-has-no-success-reply")
  end
  -- Flags preserve undeclared wire bits; queue counts and geometry are reported
  -- integers here. Transfer meaning/range checks belong to the conversation.
  return name
end
-- Native expiry receipts end after copying immutable evidence;
-- copied history ends only after its original input interval is retired.
local issued, archived, issued_count, archived_count, late = {}, {}, 0, 0, 0
local live_tokens = {}
local router_error, router_writing, router_preparing, resume_correlations
local history_root, dirty_head, dirty_tail
local source_ranges, interpreting = {}, nil
-- Expired reservations are indexed by their issuance sequence. The AVL tree's
-- `last` value lets an input observation skip subtrees that cannot be dirtied.
local function tree_height(node)
  return node and node.height or 0
end
local function update_tree_node(node)
  node.height = 1 + math.max(tree_height(node.left), tree_height(node.right))
  node.last = math.max(node.expired.sequence, node.left and node.left.last or 0, node.right and node.right.last or 0)
  return node
end
local function rotate_left(node)
  local replacement = node.right
  node.right = replacement.left
  replacement.left = update_tree_node(node)
  return update_tree_node(replacement)
end
local function rotate_right(node)
  local replacement = node.left
  node.left = replacement.right
  replacement.right = update_tree_node(node)
  return update_tree_node(replacement)
end
local function balance_tree(node)
  update_tree_node(node)
  if tree_height(node.left) - tree_height(node.right) > 1 then
    if tree_height(node.left.right) > tree_height(node.left.left) then
      node.left = rotate_left(node.left)
    end
    return rotate_right(node)
  end
  if tree_height(node.right) - tree_height(node.left) > 1 then
    if tree_height(node.right.left) > tree_height(node.right.right) then
      node.right = rotate_right(node.right)
    end
    return rotate_left(node)
  end
  return node
end
local function insert_history(node, reservation)
  if not node then
    return update_tree_node(reservation)
  end
  if reservation.issued < node.issued then
    node.left = insert_history(node.left, reservation)
  else
    node.right = insert_history(node.right, reservation)
  end
  return balance_tree(node)
end
local function remove_history(node, reservation)
  if reservation.issued < node.issued then
    node.left = remove_history(node.left, reservation)
  elseif reservation.issued > node.issued then
    node.right = remove_history(node.right, reservation)
  else
    if not node.left then
      return node.right
    end
    if not node.right then
      return node.left
    end
    local successor = node.right
    while successor.left do
      successor = successor.left
    end
    node.right = remove_history(node.right, successor)
    successor.left = node.left
    successor.right = node.right
    node = successor
  end
  return balance_tree(node)
end
local function remove_from_dirty_queue(reservation)
  if not reservation.dirty then
    return
  end
  if reservation.dirty_prev then
    reservation.dirty_prev.dirty_next = reservation.dirty_next
  else
    dirty_head = reservation.dirty_next
  end
  if reservation.dirty_next then
    reservation.dirty_next.dirty_prev = reservation.dirty_prev
  else
    dirty_tail = reservation.dirty_prev
  end
  reservation.dirty = false
  reservation.dirty_prev = nil
  reservation.dirty_next = nil
end
local function add_to_dirty_queue(reservation)
  if reservation.dirty then
    return
  end
  reservation.dirty = true
  reservation.dirty_prev = dirty_tail
  if dirty_tail then
    dirty_tail.dirty_next = reservation
  else
    dirty_head = reservation
  end
  dirty_tail = reservation
end
local function mark_changed_history(node, sequence)
  if not node or node.last <= sequence then
    return
  end
  mark_changed_history(node.left, sequence)
  if node.issued <= sequence then
    if sequence < node.expired.sequence then
      add_to_dirty_queue(node)
    end
    mark_changed_history(node.right, sequence)
  end
end
local function forget_history(reservation)
  history_root = remove_history(history_root, reservation)
  remove_from_dirty_queue(reservation)
  if reservation.newer then
    reservation.newer.previous = reservation.previous
  else
    archived[reservation.token] = reservation.previous
  end
  if reservation.previous then
    reservation.previous.newer = reservation.newer
  end
  reservation.left = nil
  reservation.right = nil
  reservation.previous = nil
  reservation.newer = nil
  archived_count = archived_count - 1
end
-- Handler ranges retain original observations through fragmentation. An
-- entry prefix is older than every post-entry issuance: entry failure ends
-- establishment, and a successful entry releases its IDENTIFY reservation.
-- Its scalar gap cannot dirty a later interval and is not a claimed sequence.
router_begin = function(channel, bytes, sequence)
  local range_queue = source_ranges[channel]
  if not range_queue then
    range_queue = { gap = #(buffers[channel] or "") }
    source_ranges[channel] = range_queue
  end
  local range = { sequence = sequence, bytes = bytes }
  if range_queue.tail then
    range_queue.tail.next = range
  else
    range_queue.head = range
  end
  range_queue.tail = range
  interpreting = { channel = channel, sources = { sequence }, seen = { [sequence] = true } }
  mark_changed_history(history_root, sequence)
end
router_consume = function(channel, bytes)
  if not interpreting then
    return
  end
  local range_queue = assert(source_ranges[channel])
  local gap = math.min(range_queue.gap, bytes)
  range_queue.gap = range_queue.gap - gap
  bytes = bytes - gap
  while bytes > 0 do
    local range = assert(range_queue.head)
    local count = math.min(bytes, range.bytes)
    bytes = bytes - count
    range.bytes = range.bytes - count
    if not interpreting.seen[range.sequence] then
      interpreting.seen[range.sequence] = true
      interpreting.sources[#interpreting.sources + 1] = range.sequence
    end
    mark_changed_history(history_root, range.sequence)
    if range.bytes == 0 then
      range_queue.head = range.next
      range.next = nil
      if not range_queue.head then
        range_queue.tail = nil
      end
    end
  end
end
router_done = function()
  -- Last non-yielding work before return. The host ends interpretation at
  -- terminal dispatch, before another activation can sample the next cut.
  for _, sequence in ipairs(interpreting.sources) do
    mark_changed_history(history_root, sequence)
  end
  interpreting = nil
end
local function router_release(io, transaction_id)
  local reservation = issued[transaction_id]
  if not reservation then
    return
  end
  issued[transaction_id] = nil
  issued_count = issued_count - 1
  for index, live_transaction in ipairs(live_tokens) do
    if live_transaction == transaction_id then
      table.remove(live_tokens, index)
      break
    end
  end
  io.request({ kind = "expiry-release", expiry = reservation.expiry })
end
local function router_reconcile(io)
  -- Only the live/unexpired set is scanned, never the growing archive on
  -- every message. Foreign notifications never enter this lookup at all.
  local tokens = {}
  for index, transaction_id in ipairs(live_tokens) do
    tokens[index] = transaction_id
  end
  for _, transaction_id in ipairs(tokens) do
    local reservation = issued[transaction_id]
    if reservation then
      local expiry = io.request({ kind = "expiry-read", expiry = reservation.expiry })
      if issued[transaction_id] == reservation and expiry.status == "expired" then
        reservation.expired = expiry
        reservation.previous = archived[transaction_id]
        archived[transaction_id] = reservation
        archived_count = archived_count + 1
        issued[transaction_id] = nil
        issued_count = issued_count - 1
        if reservation.previous then
          reservation.previous.newer = reservation
        end
        history_root = insert_history(history_root, reservation)
        add_to_dirty_queue(reservation)
        for index, live_transaction in ipairs(live_tokens) do
          if live_transaction == transaction_id then
            table.remove(live_tokens, index)
            break
          end
        end
        io.request({ kind = "expiry-release", expiry = reservation.expiry })
        reservation.expiry = nil
      end
    end
  end
  -- Only the queue present at this legal reconciliation turn. Changes during
  -- a yielding query can enqueue a later turn, never an inline polling loop.
  local stop = dirty_tail
  while stop and dirty_head do
    local reservation = dirty_head
    remove_from_dirty_queue(reservation)
    local retirement = io.request({
      kind = "input-retirement",
      basisId = reservation.expired.basisId,
      generation = reservation.expired.generation,
      fromSequence = reservation.issued,
      beforeSequence = reservation.expired.sequence,
    })
    if retirement.retired then
      forget_history(reservation)
    end
    if reservation == stop then
      break
    end
  end
end
local function router_finish(io, transaction_id, success)
  if success then
    router_release(io, transaction_id)
  else
    local reservation = issued[transaction_id]
    if reservation then
      io.request({ kind = "expiry-start", expiry = reservation.expiry })
    end
  end
end
local function router_data_failure(io)
  if not router_error then
    return
  end
  local rejection = router_error
  router_error = nil
  router_finish(io, rejection.token, false)
  pdrv.fail("device-3.data-rejected", { status = status_names[rejection.status + 1] })
end
local function router_reserve(io, opcode)
  router_data_failure(io)
  router_reconcile(io)
  -- A classified stop can retain all eight DATA reservations until QUERY proves
  -- that the old device window is quiet. Admit only that one resume control
  -- transaction above the DATA window; ordinary ninth reservations still fail.
  if issued_count >= 8 and not (resume_correlations and opcode ~= 0x32 and issued_count == 8) then
    pdrv.fail("device-3.correlation-capacity", {})
  end
  assert(response_names[opcode], "device-3.command-route")
  repeat
    transaction = transaction % 65535 + 1
  until not issued[transaction]
  local expiry = io.request({ kind = "expiry-reserve", milliseconds = 240001 })
  -- Returning the ID and storing it are one Lua turn. Keep it reachable by
  -- cleanup BEFORE the next yield; no protocol write has been requested yet.
  -- This cannot recover an ID whose reserve completion never reached Lua.
  router_preparing = expiry
  local observation = io.request({ kind = "clock-observe" })
  issued[transaction] = { token = transaction, opcode = opcode, expiry = expiry, issued = observation.sequence }
  issued_count = issued_count + 1
  live_tokens[#live_tokens + 1] = transaction
  router_preparing = nil
end
local function router_resume_begin()
  assert(not resume_correlations, "device-3.resume-correlation-state")
  for _, transaction_id in ipairs(live_tokens) do
    assert(issued[transaction_id] and issued[transaction_id].opcode == 0x32, "device-3.resume-correlation-kind")
  end
  resume_correlations = true
end
local function router_resume_quiet(io)
  router_data_failure(io)
  local tokens = {}
  for index, transaction_id in ipairs(live_tokens) do
    tokens[index] = transaction_id
  end
  for _, transaction_id in ipairs(tokens) do
    local reservation = issued[transaction_id]
    assert(not reservation or reservation.opcode == 0x32, "device-3.resume-correlation-kind")
    if reservation then
      router_release(io, transaction_id)
    end
  end
  resume_correlations = false
end
local function router_accept(message, io, sequence)
  local transaction_id, opcode = unpack_le16(message, 3), message:byte(2)
  local reservation = issued[transaction_id]
  if reservation and sequence and sequence < reservation.issued then
    reservation = nil
  end
  if not reservation then
    reservation = archived[transaction_id]
    while reservation and sequence and sequence < reservation.issued do
      reservation = reservation.previous
    end
  end
  if not reservation or reservation.opcode ~= opcode then
    pdrv.fail("device-3.unknown-correlation", {})
  end
  local expiry = reservation.expired or io.request({ kind = "expiry-read", expiry = reservation.expiry })
  if expiry.status == "reserved" then
    if opcode == 0x32 then
      router_error = { token = transaction_id, status = message:byte(5) }
    else
      router_release(io, transaction_id)
    end
    return true
  end
  if expiry.status == "armed" or (sequence and sequence < expiry.sequence) then
    late = late + 1
    return false
  end
  pdrv.fail("device-3.unknown-correlation", {})
end
local function router_cleanup(args, io)
  local preparing = router_preparing
  router_preparing = nil
  if preparing then
    io.request({ kind = "expiry-release", expiry = preparing })
  end
  -- A rejected write accepted no bytes, so release its reservation immediately.
  -- Cancellation or partial acceptance retains it under the original terminal TTL.
  if args.code == "retained.write-rejected" and router_writing then
    router_release(io, router_writing)
  end
  router_writing = nil
  router_error = nil
  resume_correlations = false
end
local function accept(message, deliver, channel, io, sequence)
  validate_message(message)
  if message:byte(1) == 3 then
    if message:byte(2) == 0x81 then
      deliver(message)
    end
  else
    -- Always-event selectors precede the role test. A USB event endpoint is
    -- not a second response stream, even when opcode and transaction match.
    -- The declaration faults at its first unknown message; ignoring is wrong.
    if channel ~= response_channel then
      pdrv.fail("device-3.event-only-response", {})
    end
    if not router_accept(message, io, sequence) then
      return
    end
    deliver(message)
  end
end
local function next_frame(io, timer, resumable_timeout)
  if entered then
    local event =
      io.request({ kind = "message-wait", mailboxes = array({ "response" }), timers = array({ timer }) })
    if event:sub(1, 17) ~= "message:response:" then
      if resumable_timeout then
        io.request({ kind = "transfer-resume-required", name = "device-3.response-timeout", details = {} })
        error("device-3.resume-disposition-returned")
      end
      pdrv.fail("device-3.response-timeout", {})
    end
    if event:sub(18) == "read" then
      local message = read_reply
      read_reply = nil
      assert(message, "device-3.read-custody")
      return message
    end
    return decode_hex(event:sub(18))
  end
  local ready
  while not ready do
    -- Stop exactly at the entry response, leaving unread suffixes with the
    -- native reader; returning from entry does not itself transfer parser state.
    local event = io.request({ kind = "wait-any", maximum = 1, timers = array({ timer }) })
    if event:sub(1, 8) ~= "receive:" then
      pdrv.fail("device-3.entry-timeout", {})
    end
    local channel = io.request({ kind = "input-channel" })
    feed(channel, event:sub(9), function(message)
      accept(message, function(response_message)
        ready = response_message
      end, channel, io)
    end, io)
  end
  return ready
end
local function send(io, opcode, payload, offset, length)
  router_reserve(io, opcode)
  expected = encode_frame("\1" .. string.char(opcode) .. pack_le16(transaction) .. payload)
  router_writing = transaction
  if length then
    io.request({
      kind = "transfer-write",
      offset = offset,
      payloadOffset = 20,
      length = length,
      value = pdrv.bytes(expected),
    })
  else
    io.request({ kind = entered and "write-via" or "write", value = pdrv.bytes(expected) })
  end
  router_writing = nil
  expected = nil
  return transaction
end
local function response(io, opcode, payload, expected_size, timeout_ms, entry_identity)
  local timer = io.request({ kind = "timer-arm", milliseconds = deadline_ms(timeout_ms) })
  local transaction_id = send(io, opcode, payload)
  while true do
    local message = next_frame(io, timer)
    if message:byte(1) == 2 and unpack_le16(message, 3) == transaction_id then
      assert(message:byte(2) == opcode, "device-3.response-opcode")
      if opcode == 1 then
        local status = message:byte(5)
        if status ~= 0 then
          if not entry_identity then
            pdrv.fail("device-3.identify-rejected", { status = status })
          end
        end
      else
        if message:byte(5) ~= 0 then
          pdrv.fail(
            "device-3.command-rejected",
            { command = response_names[opcode], status = status_names[message:byte(5) + 1] }
          )
        end
        if #message ~= expected_size then
          pdrv.fail("device-3.response-size", {})
        end
      end
      io.request({ kind = "timer-cancel", timer = timer })
      return message
    end
    -- A cancelled request may already have a queued response. It belongs to
    -- its old transaction, never to this ABORT or a later foreground request.
  end
end
local function report(io, committed_offset, volatile_offset, buffered_count)
  io.request({
    kind = "transfer-report",
    cookie = active_cookie,
    generation = active_generation,
    committed = committed_offset,
    volatile = volatile_offset,
    buffered = buffered_count,
  })
end
local function window(io, timeout_ms, shared_timer)
  router_data_failure(io)
  local timer = shared_timer or io.request({ kind = "timer-arm", milliseconds = deadline_ms(timeout_ms) })
  while true do
    local message = next_frame(io, timer, true)
    if message:byte(1) == 2 then
      if message:byte(2) == 0x32 then
        router_data_failure(io)
      end
      pdrv.fail("device-3.unexpected-response", {})
    end
    if message:byte(2) == 0x81 then
      -- Both fields bind progress to this transfer, including ordinary ACKs.
      -- BEGIN may create a new generation; matching resume does not. The old
      -- offset-only carrier is not authority to settle from a foreign report.
      if
        not (unpack_le32(message, 5) == active_id and unsigned_32(unpack_le32(message, 9)) == active_generation)
      then
        pdrv.fail("device-3.window-identity", {})
      end
      if not shared_timer then
        io.request({ kind = "timer-cancel", timer = timer })
      end
      return unpack_le32(message, 13), unpack_le32(message, 17), message:byte(25)
    end
  end
end
local function transfer(args, io, resuming)
  local opened = io.request({ kind = "transfer-open" })
  local digest, saved, saved_cookie, saved_generation = opened:match("^[^|]+|([^|]+)|([^|]+)|([^|]*)|([^|]*)|")
  assert(digest, "device-3.open-result")
  if resuming then
    router_resume_begin()
  end
  -- A classified transfer timeout means flash may still be busy. The resume
  -- QUERY is part of transfer reconciliation and uses the transfer response
  -- bound; ordinary QUERY/command paths retain their short response bound.
  local query_response = response(io, 0x30, "\0", 117, resuming and 2501 or 102)
  -- The declared source/target domains are constants, not QUERY geometry.
  -- Only the quiescent QUERY/report prefix authorizes a resume cursor; BEGIN's
  -- reported offset is not a binding and cannot skip fresh source bytes.
  active_cookie = encode_hex(query_response:sub(102, 113))
  local committed = 0
  if resuming then
    active_id, active_generation = unpack_le32(query_response, 18), unsigned_32(unpack_le32(query_response, 22))
    if not (active_cookie == saved_cookie and active_generation == tonumber(saved_generation)) then
      pdrv.fail("device-3.resume-identity", {})
    end
    if
      not (unpack_le32(query_response, 26) == args.length and encode_hex(query_response:sub(38, 69)) == digest)
    then
      pdrv.fail("device-3.resume-subject", {})
    end
    local committed_offset, volatile_offset, buffered_count =
      unpack_le32(query_response, 30), unpack_le32(query_response, 34), query_response:byte(114)
    if committed_offset ~= volatile_offset or buffered_count ~= 0 then
      -- One overall rollback bound, not a fresh 2001 ms for each old report.
      local timer = io.request({ kind = "timer-arm", milliseconds = deadline_ms(2001) })
      repeat
        committed_offset, volatile_offset, buffered_count = window(io, 2001, timer)
      until committed_offset == volatile_offset and buffered_count == 0
      io.request({ kind = "timer-cancel", timer = timer })
    end
    assert(committed_offset == volatile_offset and buffered_count == 0, "device-3.resume-not-quiet")
    router_resume_quiet(io)
    report(io, committed_offset, volatile_offset, buffered_count)
    committed = committed_offset
  end
  local begin_response = response(
    io,
    0x31,
    string.rep("\0", 4) .. pack_le32(args.length) .. decode_hex(digest) .. decode_hex(active_cookie),
    25,
    1501
  )
  local transfer_id = unpack_le32(begin_response, 6)
  local transfer_generation = unsigned_32(unpack_le32(begin_response, 10))
  if resuming and not (transfer_id == active_id and transfer_generation == active_generation) then
    pdrv.fail("device-3.resume-BEGIN-identity", {})
  end
  active_id, active_generation = transfer_id, transfer_generation
  report(io, committed, committed, 0)
  local next_offset, pending, observations = committed, {}, 0
  while committed < args.length do
    while #pending < 8 and next_offset < args.length do
      local parts, payload_length = {}, 0
      while payload_length < math.min(768, args.length - next_offset) do
        local part = io.request({
          kind = "source-read",
          source = args.image,
          maximum = math.min(256, 768 - payload_length, args.length - next_offset - payload_length),
        })
        assert(#part > 0, "device-3.source-ended")
        parts[#parts + 1] = part
        payload_length = payload_length + #part
      end
      local deadline = io.request({ kind = "deadline-arm", milliseconds = deadline_ms(2501) })
      local transaction_id = send(
        io,
        0x32,
        pack_le32(transfer_id) .. pack_le32(next_offset) .. pack_le16(payload_length) .. table.concat(parts),
        next_offset,
        payload_length
      )
      io.request({ kind = "deadline-disarm", deadline = deadline })
      next_offset = next_offset + payload_length
      pending[#pending + 1] = { last = next_offset, token = transaction_id }
    end
    observations = observations + 1
    if observations > 3243 then
      pdrv.fail("device-3.observation-bound", {})
    end
    local committed_offset, volatile_offset, buffered_count = window(io, 2501)
    if not (committed_offset >= committed and committed_offset <= next_offset) then
      pdrv.fail("device-3.durable-prefix", {})
    end
    -- A DATA acceptance is not durable settlement. A sector commit can split
    -- one 768-byte DATA range; never discard that range's uncommitted tail.
    report(io, committed_offset, volatile_offset, buffered_count)
    committed = committed_offset
    while pending[1] and pending[1].last <= committed do
      router_finish(io, pending[1].token, true)
      table.remove(pending, 1)
    end
  end
  io.request({ kind = "transfer-finalize" })
  local final = response(io, 0x33, pack_le32(transfer_id), 81, 240001)
  if
    not (
      unpack_le32(final, 6) == transfer_id
      and unsigned_32(unpack_le32(final, 10)) == transfer_generation
      and unpack_le32(final, 14) == args.length
    )
  then
    pdrv.fail("device-3.final-identity", {})
  end
  io.request({
    kind = "transfer-verify",
    source = encode_hex(final:sub(18, 49)),
    target = encode_hex(final:sub(50, 81)),
  })
  active_id = nil
end
local function unpack_u64_decimal(bytes, offset)
  -- Exact decimal accumulation, not a round trip through a binary64 number.
  local digits = { 0 }
  for byte_offset = offset + 7, offset, -1 do
    local carry = bytes:byte(byte_offset)
    for digit_index = 1, #digits do
      local accumulated = digits[digit_index] * 256 + carry
      digits[digit_index] = accumulated % 10
      carry = accumulated // 10
    end
    while carry > 0 do
      digits[#digits + 1] = carry % 10
      carry = carry // 10
    end
  end
  local decimal = {}
  for digit_index = #digits, 1, -1 do
    decimal[#decimal + 1] = tostring(digits[digit_index])
  end
  return pdrv.integer(table.concat(decimal))
end
local modes, profiles, locks = array({ "application" }), array({ "serial", "usb" }), array({ "protocol" })
local function unsigned_integer(bits)
  return { kind = "integer", widthBits = bits, signed = false }
end
local function field(type_definition)
  return type_definition
end
local counters = {
  "crcFailures",
  "lengthFailures",
  "revisionFailures",
  "uartOverruns",
  "usbOutOverruns",
  "droppedSerialNotifications",
  "droppedUsbNotifications",
  "flashFailures",
}
local flags =
  { "serial", "usb", "telemetry", "bulk-read", "bulk-write-resume", "usb-identity-change", "settings-record" }
local titles =
  { get_device_info = "Get device information", get_diagnostics = "Get diagnostics", write_image = "Write image" }
local descriptions = {
  get_device_info = "Read hardware model, active USB identity, firmware version, device serial, and advertised capabilities.",
  get_diagnostics = "Read accumulated framing, transport-overrun, notification-drop, and flash-failure counters.",
  write_image = "Write a source image to the persistent bulk target through its durable journal, then verify the source and target digests. Beginning a different image invalidates any previously valid image.",
}
local counter_fields = {}
for _, name in ipairs(counters) do
  counter_fields[name] = field(unsigned_integer(32))
end
local function operation(id, result)
  return {
    id = id,
    title = titles[id] or id,
    description = descriptions[id],
    binding = id,
    arguments = {},
    result = result,
    risk = "read-only",
    repeatability = "safe-to-repeat",
    locks = locks,
    writeVia = "receiver",
    requires = array({
      "channel.write-via",
      "mailbox",
      "timer",
      "clock.observe",
      "expiry.observe",
      "input.retirement",
    }),
    cleanup = {
      binding = "router_cleanup",
      requires = array({ "expiry.observe" }),
      maximumMilliseconds = 50,
      maximumWork = 100000,
      maximumLuaFuel = 100000,
    },
    availability = { modes = modes, profiles = profiles },
  }
end
local device_information_operation = operation("get_device_info", {
  kind = "value",
  type = {
    kind = "record",
    fields = {
      hardwareModel = field({ kind = "enum", members = array({ "daisy-seed-1.2" }) }),
      usbIdentity = field({ kind = "enum", members = array({ "normal", "service" }) }),
      firmwareMajor = field(unsigned_integer(8)),
      firmwareMinor = field(unsigned_integer(8)),
      firmwarePatch = field(unsigned_integer(8)),
      deviceSerial = field(unsigned_integer(64)),
      capabilities = field({ kind = "flags", members = array(flags) }),
    },
    fieldLabels = {
      capabilities = "Capabilities",
      deviceSerial = "Device serial",
      firmwareMajor = "Firmware major",
      firmwareMinor = "Firmware minor",
      firmwarePatch = "Firmware patch",
      hardwareModel = "Hardware model",
      usbIdentity = "USB identity",
    },
  },
})
-- The read_target binding is available only to explicit tooling and is not
-- part of the three-operation public surface.
local read_target_operation = operation("read_target", {
  kind = "file",
  direction = "out",
  content = "Raw target domain including header and erased suffix",
  mediaType = "application/octet-stream",
  suggestedExtension = "bin",
  minimumBytes = 1,
  maximumBytes = 2097152,
  streamed = { subject = "target", offset = { argument = "targetOffset" }, length = { argument = "length" } },
})
read_target_operation.arguments = {
  targetOffset = { kind = "integer", widthBits = 32, signed = true, minimum = 0, maximum = 2097151 },
  length = { kind = "integer", widthBits = 32, signed = true, minimum = 1, maximum = 2097152 },
}
local set_usb_identity_operation = operation("set_usb_identity", { kind = "none" })
set_usb_identity_operation.risk = "destructive"
set_usb_identity_operation.repeatability = "not-repeatable"
set_usb_identity_operation.arguments = {
  identity = { kind = "enum", members = array({ "normal", "service" }) },
  detachDelayMs = { kind = "integer", widthBits = 16, signed = true, minimum = 250, maximum = 5000 },
}
local write_image_operation = operation("write_image", { kind = "none" })
write_image_operation.risk = "destructive"
write_image_operation.repeatability = "not-repeatable"
write_image_operation.arguments = {
  image = {
    kind = "stream-source",
    minimumBytes = 1,
    maximumBytes = 2097088,
    label = "Source image",
    description = "The image bytes to write. The source identity is bound to its SHA-256 digest for resume.",
  },
  length = {
    kind = "integer",
    widthBits = 32,
    signed = true,
    minimum = 1,
    maximum = 2097088,
    label = "Image length",
    description = "Number of source-image bytes to write to the target.",
  },
}
write_image_operation.arguments.length.unit = { kind = "fixed", id = "byte" }
write_image_operation.requires = array({
  "channel.write-via",
  "mailbox",
  "timer",
  "operation.deadline",
  "transfer.checkpoint",
  "clock.observe",
  "expiry.observe",
  "input.retirement",
})
write_image_operation.transfer = {
  segmented = true,
  sourceArgument = "image",
  sourceRange = { offset = 0, length = { argument = "length" } },
  maximumCarrierBytes = 792,
  targetOffset = 64,
  targetLength = 2097152,
  resumeBinding = "resume",
  finalization = "repeatable",
}
write_image_operation.cleanup = {
  binding = "abort",
  writeVia = "receiver",
  requires = array({
    "channel.write-via",
    "mailbox",
    "timer",
    "transfer.cleanup",
    "clock.observe",
    "expiry.observe",
    "input.retirement",
  }),
  maximumMilliseconds = 535,
  maximumLuaFuel = 100000,
  maximumWork = 1000000,
}
return {
  apiVersion = "device/v2",
  id = "device-3-authored",
  displayName = "D3LINK",
  description = "Inspect a D3LINK implementation and access its persistent bulk-image target over serial or USB. The declared image write is implemented by the Daisy Seed; the retained Teensy implementation reports it unsupported.",
  modes = modes,
  modePresentation = {
    application = {
      label = "Application protocol",
      description = "Use the revision-1 application protocol over serial or USB. Telemetry and bulk progress notifications may arrive without a request.",
    },
  },
  profiles = profiles,
  mailboxes = array({ "response" }),
  connectionProfiles = {
    serial = {
      modes = modes,
      acquisitionFilters = array({ { transport = "serial", vendorId = 1027, productId = 24592 } }),
      transport = {
        kind = "serial",
        baudRate = 921600,
        dataBits = 8,
        parity = "none",
        stopBits = 1,
        flowControl = "none",
      },
      channels = array({ { id = "main", protocolDuplex = "full-duplex" } }),
      lifecycle = {
        openingDrainQuietMs = 0,
        postTerminationSilence = { minimumMs = 0, afterAbnormalTermination = false, afterModeExit = false },
      },
    },
    usb = {
      modes = modes,
      acquisitionFilters = array({
        { transport = "usb", vendorId = 5824, productId = 1235, usbClass = 255 },
        { transport = "usb", vendorId = 5824, productId = 1236, usbClass = 255 },
      }),
      transport = {
        kind = "usb",
        configurationValue = 1,
        interfaceNumber = 0,
        alternateSetting = 0,
        channels = array({
          {
            id = "requests",
            input = pdrv.null,
            output = {
              endpointNumber = 1,
              transferType = "bulk",
              maximumPacketBytes = { full = 64, high = 512 },
            },
          },
          {
            id = "responses",
            input = {
              endpointNumber = 1,
              transferType = "bulk",
              maximumPacketBytes = { full = 64, high = 512 },
            },
            output = pdrv.null,
          },
          {
            id = "events",
            input = {
              endpointNumber = 2,
              transferType = "interrupt",
              maximumPacketBytes = {
                full = 64,
                high = 64,
              },
            },
            output = pdrv.null,
          },
        }),
      },
    },
  },
  channelRoles = {
    serial = { request = "main", response = "main", event = "main" },
    usb = { request = "requests", response = "responses", event = "events" },
  },
  entry = {
    binding = "enter",
    locks = locks,
    requires = array({
      "channel.read",
      "channel.write",
      "timer",
      "clock.observe",
      "expiry.observe",
      "input.retirement",
    }),
    handoffTo = "receiver",
    inputEvidence = "consumed-ranges",
  },
  handlers = array({
    {
      id = "receiver",
      binding = "receive",
      acceptHandoff = "handoff",
      authorizeWrite = "authorize",
      inputEvidence = "consumed-ranges",
      event = { kind = "channel-input", channelId = "main" },
      maximumConcurrent = 4,
      locks = array({ "parser" }),
      requires = array({ "channel.input", "mailbox", "clock.observe", "expiry.observe" }),
    },
  }),
  operations = array({
    device_information_operation,
    operation("get_diagnostics", {
      kind = "value",
      type = {
        kind = "record",
        fields = counter_fields,
        fieldLabels = {
          crcFailures = "CRC failures",
          droppedSerialNotifications = "Dropped serial notifications",
          droppedUsbNotifications = "Dropped USB notifications",
          flashFailures = "Flash failures",
          lengthFailures = "Length failures",
          revisionFailures = "Revision failures",
          uartOverruns = "UART overruns",
          usbOutOverruns = "USB OUT overruns",
        },
      },
    }),
    write_image_operation,
  }),
}, {
  enter = function(context, io)
    assert(context.profileId == "serial" or context.profileId == "usb", "device-3.profile")
    delivery_allowance = context.profileId == "serial" and 34 or 0
    response_channel = context.profileId == "serial" and "main" or "responses"
    entered = false
    buffers = {}
    expected = nil
    active_id = nil
    transaction = 0
    read_reply = nil
    issued = {}
    archived = {}
    live_tokens = {}
    issued_count = 0
    archived_count = 0
    late = 0
    router_error = nil
    router_writing = nil
    router_preparing = nil
    resume_correlations = false
    history_root = nil
    dirty_head = nil
    dirty_tail = nil
    source_ranges = {}
    interpreting = nil
    -- Session establishment requires the IDENTIFY selector, not status OK.
    -- Its public information command separately requires OK. Geometry fields
    -- are reported integers, not identity constants; do not tighten them here.
    response(io, 1, "", 31, 101, true)
    -- Prefixes stay in this shared parser; the broker transfers their byte
    -- custody, not a second delivery. Neither stream has to become silent.
    assert(io.request({ kind = "entry-handoff", parser = "retained-prefixes", timers = "none" }) == "accepted")
    entered = true
  end,
  handoff = function(offer)
    if offer.parser ~= "retained-prefixes" or offer.timers ~= "none" then
      return { accepted = false }
    end
    local lengths = {}
    for _, prefix in ipairs(offer.prefixes) do
      lengths[prefix.channelId] = prefix["end"] - prefix.start
    end
    for _, channel in ipairs({ "main", "responses", "events" }) do
      if (lengths[channel] or 0) ~= #(buffers[channel] or "") then
        return { accepted = false }
      end
    end
    return { accepted = true }
  end,
  authorize = function(request)
    return {
      accepted = expected ~= nil
        and request.bytes == expected
        and (
          request.origin == "operation"
          or (request.origin == "cleanup" and request.cleanupOf ~= "" and request.operation == "write_image")
        ),
    }
  end,
  receive = function(args, io)
    router_begin(args.channelId or "main", #args.input, args.observation.sequence)
    feed(args.channelId or "main", args.input, function(message)
      accept(message, function(response_message)
        if response_message:byte(1) == 2 and response_message:byte(2) == 0x35 and #response_message > 128 then
          -- The 256-byte mailbox carries notice, not a second copy of a 1035-byte
          -- reply. The shared parser owns one reply until its serialized reader
          -- takes it; consumption evidence moves with the single notice.
          assert(not read_reply, "device-3.read-overlap")
          read_reply = response_message
          io.request({ kind = "message-send", mailbox = "response", value = "read" })
        else
          io.request({ kind = "message-send", mailbox = "response", value = encode_hex(response_message) })
        end
      end, args.channelId or "main", io, args.observation.sequence)
    end, io)
    router_done()
  end,
  get_device_info = function(_, io)
    local message = response(io, 1, "", 31, 101)
    local capabilities = {}
    for index = 1, #flags do
      if (unpack_le32(message, 28) & (1 << (index - 1))) ~= 0 then
        capabilities[#capabilities + 1] = flags[index]
      end
    end
    return {
      hardwareModel = "daisy-seed-1.2",
      usbIdentity = message:byte(8) == 0 and "normal" or "service",
      firmwareMajor = message:byte(9),
      firmwareMinor = message:byte(10),
      firmwarePatch = message:byte(11),
      deviceSerial = unpack_u64_decimal(message, 16),
      capabilities = array(capabilities),
    }
  end,
  set_usb_identity = function(args, io)
    local selected
    if args.identity == "normal" then
      selected = 0
    elseif args.identity == "service" then
      selected = 1
    else
      pdrv.fail("device-3.identity-selection", {})
    end
    response(io, 0x20, string.char(selected, 0) .. pack_le16(args.detachDelayMs), 5, 101)
    return nil
  end,
  get_diagnostics = function(_, io)
    local message = response(io, 2, "", 37, 101)
    local result = {}
    for index, name in ipairs(counters) do
      result[name] = unsigned_32(unpack_le32(message, 2 + 4 * index))
    end
    return result
  end,
  read_target = function(args, io)
    if args.targetOffset + args.length > 2097152 then
      pdrv.fail("device-3.target-range", {})
    end
    local offset, remaining = args.targetOffset, args.length
    while remaining > 0 do
      local length = math.min(1024, remaining)
      local message = response(
        io,
        0x35,
        string.rep("\0", 4) .. pack_le32(offset) .. pack_le16(length) .. "\0\0",
        11 + length,
        112
      )
      if not (unpack_le32(message, 6) == offset and unpack_le16(message, 10) == length) then
        pdrv.fail("device-3.read-range", {})
      end
      -- Device READ replies carry 1024 octets; destination crossings have their
      -- own bounded lifetime. Neither grants a whole-target Lua buffer.
      for chunk_offset = 12, #message, 256 do
        io.request({
          kind = "resource-write",
          resource = io.resultDestination,
          value = pdrv.bytes(message:sub(chunk_offset, chunk_offset + 255)),
        })
      end
      offset = offset + length
      remaining = remaining - length
    end
    return io.resultDestination
  end,
  write_image = function(args, io)
    return transfer(args, io, false)
  end,
  resume = function(args, io)
    return transfer(args, io, true)
  end,
  router_cleanup = router_cleanup,
  abort = function(args, io)
    router_cleanup(args, io)
    -- A later operation can be cancelled in host prehash before Lua starts.
    -- Its cleanup must not inherit this terminated operation's device ID.
    if args.outcome ~= "cancelled" then
      active_id = nil
      return
    end
    if not active_id then
      return
    end
    response(io, 0x34, pack_le32(active_id), 5, 501)
    io.request({ kind = "transfer-retire", cookie = active_cookie, generation = active_generation })
    active_id = nil
  end,
}
