-- Qualified Device-3 migration source. The public surface stays at the three
-- product operations; private bindings retain the qualification-only read path.
-- F81: the shared nine-selector correlation policy is inline and authoritative.
-- Private qualification bindings are inline; tools only expose them on demand.
local a=pdrv.array
local buffers,entered,transaction,expected={},false,0,nil
local active_id,active_cookie,active_generation
local read_reply
-- Device response bounds exclude the selected path's delivery allowance.
local delivery_allowance=0
local response_channel="main"
local function deadline_ms(ms)return ms+delivery_allowance end
local lut={}
for i=0,255 do local c=i;for _=1,8 do c=(c>>1)~((c&1)==1 and 0x82f63b78 or 0) end;lut[i]=c end
local function le16(n)return string.char(n&255,(n>>8)&255)end
local function le32(n)return le16(n&65535)..le16((n>>16)&65535)end
local function u16(s,i)return s:byte(i)+s:byte(i+1)*256 end
local function u32(s,i)return u16(s,i)+u16(s,i+2)*65536 end
local function unsigned(n)return n<0 and n+4294967296.0 or n end
local function hex(s)return(s:gsub(".",function(c)return string.format("%02x",c:byte())end))end
local function unhex(s)return(s:gsub("..",function(c)return string.char(tonumber(c,16))end))end
local function crc(s)
  local c,byte=0xffffffff,string.byte
  local full=#s-(#s%4)
  for i=1,full,4 do
    local b0,b1,b2,b3=byte(s,i,i+3)
    c=(c>>8)~lut[(c~b0)&255];c=(c>>8)~lut[(c~b1)&255]
    c=(c>>8)~lut[(c~b2)&255];c=(c>>8)~lut[(c~b3)&255]
  end
  for i=full+1,#s do c=(c>>8)~lut[(c~byte(s,i))&255] end
  return c~0xffffffff
end
local function frame(b)local c="\1"..le16(#b)..b;return "\xa5\x5a\xd3"..c..le32(crc(c))end
local router_begin,router_consume,router_done
local function feed(channel,bytes,deliver,io)
  -- Independent USB endpoints are independent framed streams. Parser suffixes
  -- remain with this owner through foreground cancellation and ABORT cleanup.
  local s=(buffers[channel] or "")..bytes
  local consumed=0
  while #s>=6 do
    if s:sub(1,4)~="\xa5\x5a\xd3\1" or u16(s,5)<4 or u16(s,5)>2048 then s=s:sub(2);consumed=consumed+1
    else
      local n=u16(s,5)+10
      if #s<n then break end
      -- A false candidate may contain a complete real frame. Discard only
      -- its first sync octet; skipping the declared length would lose that frame.
      if crc(s:sub(4,n-4))~=u32(s,n-3) then s=s:sub(2);consumed=consumed+1
      else local b=s:sub(7,n-4);s=s:sub(n+1)
        -- Receipt is a consumed wire range, not a new physical input event.
        if io then io.request({kind="input-consume",length=consumed+n});router_consume(channel,consumed+n) end
        consumed=0;deliver(b)
      end
    end
  end
  if io and consumed>0 then io.request({kind="input-consume",length=consumed});router_consume(channel,consumed) end
  assert(#s<=2058,"device-3.parser-capacity");buffers[channel]=s
end
local status_names={"ok","unsupported","invalid-field","invalid-state","busy","range","out-of-window","overlap","data-conflict","active-mismatch","cookie-mismatch","incomplete","digest-mismatch","flash-failure","revision-conflict"}
local response_names={[1]="identify",[2]="get-diagnostics",[0x20]="set-usb-identity",[0x30]="bulk-query",[0x31]="bulk-begin",[0x32]="bulk-data",[0x33]="bulk-finalize",[0x34]="bulk-abort",[0x35]="bulk-read"}
local function zeros(b,first,last)assert(b:sub(first,last)==string.rep("\0",last-first+1),"device-3.reserved-field")end
local function validate(b)
  assert(#b>=4,"device-3.message-header")
  local kind,op=b:byte(1,2)
  if kind==3 then
    assert(u16(b,3)==0,"device-3.notification-transaction")
    if op==0x80 then assert(#b==32,"device-3.telemetry-layout");return "telemetry" end
    if op==0x81 then assert(#b==28,"device-3.window-layout");zeros(b,27,28);return "bulk-window-ack" end
    assert(op==0x82 and #b==16 and b:byte(5)<=1,"device-3.identity-pending-layout")
    zeros(b,6,6);return "identity-pending"
  end
  local name,status=response_names[op],b:byte(5)
  assert(kind==2 and name and status and status<=14,"device-3.response-header")
  if status~=0 then
    assert(#b==5,"device-3.error-layout")
    return op>=0x30 and name.."-error" or name
  end
  if op==1 then assert(#b==31 and b:byte(6)==1 and b:byte(7)==0x41 and b:byte(8)<=1,"device-3.identify-layout")
  elseif op==2 then assert(#b==37,"device-3.diagnostics-layout")
  elseif op==0x20 or op==0x34 then assert(#b==5,"device-3.empty-response-layout")
  elseif op==0x30 then
    assert(#b==117 and b:byte(6)==0 and b:byte(7)<=4,"device-3.query-layout");zeros(b,115,117)
  elseif op==0x31 then assert(#b==25,"device-3.begin-layout");zeros(b,23,25)
  elseif op==0x33 then assert(#b==81,"device-3.finalize-layout")
  elseif op==0x35 then assert(#b>=12 and #b<=1035 and u16(b,10)==#b-11,"device-3.read-layout")
  else error("device-3.DATA-has-no-success-reply") end
  -- Flags preserve undeclared wire bits; queue counts and geometry are reported
  -- integers here. Transfer meaning/range checks belong to the conversation.
  return name
end
-- BEGIN shared correlation policy
-- Trial only. Native expiry receipts end after copying immutable evidence;
-- copied history ends only after its original input interval is retired.
local issued,archived,issued_count,archived_count,late={},{},0,0,0
local live_tokens={}
local router_error,router_writing,router_preparing
local history_root,dirty_head,dirty_tail
local source_ranges,interpreting={},nil
local function height(n)return n and n.height or 0 end
local function update(n)
  n.height=1+math.max(height(n.left),height(n.right))
  n.last=math.max(n.expired.sequence,n.left and n.left.last or 0,n.right and n.right.last or 0);return n
end
local function left(n)local top=n.right;n.right=top.left;top.left=update(n);return update(top)end
local function right(n)local top=n.left;n.left=top.right;top.right=update(n);return update(top)end
local function balance(n)
  update(n)
  if height(n.left)-height(n.right)>1 then
    if height(n.left.right)>height(n.left.left)then n.left=left(n.left)end;return right(n)
  end
  if height(n.right)-height(n.left)>1 then
    if height(n.right.left)>height(n.right.right)then n.right=right(n.right)end;return left(n)
  end
  return n
end
local function insert(n,r)
  if not n then return update(r)end
  if r.issued<n.issued then n.left=insert(n.left,r)else n.right=insert(n.right,r)end;return balance(n)
end
local function remove(n,r)
  if r.issued<n.issued then n.left=remove(n.left,r)
  elseif r.issued>n.issued then n.right=remove(n.right,r)
  else
    if not n.left then return n.right end;if not n.right then return n.left end
    local next=n.right;while next.left do next=next.left end
    n.right=remove(n.right,next);next.left=n.left;next.right=n.right;n=next
  end
  return balance(n)
end
local function clean(r)
  if not r.dirty then return end
  if r.dirty_prev then r.dirty_prev.dirty_next=r.dirty_next else dirty_head=r.dirty_next end
  if r.dirty_next then r.dirty_next.dirty_prev=r.dirty_prev else dirty_tail=r.dirty_prev end
  r.dirty=false;r.dirty_prev=nil;r.dirty_next=nil
end
local function dirty(r)
  if r.dirty then return end
  r.dirty=true;r.dirty_prev=dirty_tail
  if dirty_tail then dirty_tail.dirty_next=r else dirty_head=r end;dirty_tail=r
end
local function changed(n,s)
  if not n or n.last<=s then return end
  changed(n.left,s)
  if n.issued<=s then if s<n.expired.sequence then dirty(n)end;changed(n.right,s)end
end
local function forget(r)
  history_root=remove(history_root,r);clean(r)
  if r.newer then r.newer.previous=r.previous else archived[r.token]=r.previous end
  if r.previous then r.previous.newer=r.newer end
  r.left=nil;r.right=nil;r.previous=nil;r.newer=nil;archived_count=archived_count-1
end
-- Handler ranges retain original observations through fragmentation. An
-- entry prefix is older than every post-entry issuance: entry failure ends
-- establishment, and a successful entry releases its IDENTIFY reservation.
-- Its scalar gap cannot dirty a later interval and is not a claimed sequence.
router_begin=function(channel,bytes,sequence)
  local q=source_ranges[channel]
  if not q then q={gap=#(buffers[channel] or "")};source_ranges[channel]=q end
  local n={sequence=sequence,bytes=bytes}
  if q.tail then q.tail.next=n else q.head=n end;q.tail=n
  interpreting={channel=channel,sources={sequence},seen={[sequence]=true}}
  changed(history_root,sequence)
end
router_consume=function(channel,bytes)
  if not interpreting then return end
  local q=assert(source_ranges[channel]);local gap=math.min(q.gap,bytes);q.gap=q.gap-gap;bytes=bytes-gap
  while bytes>0 do
    local n=assert(q.head);local count=math.min(bytes,n.bytes);bytes=bytes-count;n.bytes=n.bytes-count
    if not interpreting.seen[n.sequence]then
      interpreting.seen[n.sequence]=true;interpreting.sources[#interpreting.sources+1]=n.sequence
    end
    changed(history_root,n.sequence)
    if n.bytes==0 then q.head=n.next;n.next=nil;if not q.head then q.tail=nil end end
  end
end
router_done=function()
  -- Last non-yielding work before return. The host ends interpretation at
  -- terminal dispatch, before another activation can sample the next cut.
  for _,sequence in ipairs(interpreting.sources)do changed(history_root,sequence)end
  interpreting=nil
end
local function router_release(io,tx)
  local r=issued[tx];if not r then return end
  issued[tx]=nil;issued_count=issued_count-1
  for i,t in ipairs(live_tokens)do if t==tx then table.remove(live_tokens,i);break end end
  io.request({kind="expiry-release",expiry=r.expiry})
end
local function router_reconcile(io)
  -- Only the live/unexpired set is scanned, never the growing archive on
  -- every message. Foreign notifications never enter this lookup at all.
  local tokens={};for i,tx in ipairs(live_tokens)do tokens[i]=tx end
  for _,tx in ipairs(tokens)do
   local r=issued[tx]
   if r then
    local e=io.request({kind="expiry-read",expiry=r.expiry})
    if issued[tx]==r and e.status=="expired" then
      r.expired=e;r.previous=archived[tx];archived[tx]=r
      archived_count=archived_count+1;issued[tx]=nil;issued_count=issued_count-1
      if r.previous then r.previous.newer=r end
      history_root=insert(history_root,r);dirty(r)
      for i,t in ipairs(live_tokens)do if t==tx then table.remove(live_tokens,i);break end end
      io.request({kind="expiry-release",expiry=r.expiry});r.expiry=nil
    end
   end
  end
  -- Only the queue present at this legal reconciliation turn. Changes during
  -- a yielding query can enqueue a later turn, never an inline polling loop.
  local stop=dirty_tail
  while stop and dirty_head do
    local r=dirty_head;clean(r)
    local o=io.request({kind="input-retirement",basisId=r.expired.basisId,generation=r.expired.generation,
      fromSequence=r.issued,beforeSequence=r.expired.sequence})
    if o.retired then forget(r)end
    if r==stop then break end
  end
end
local function router_finish(io,tx,success)
  if success then router_release(io,tx)
  else local r=issued[tx];if r then io.request({kind="expiry-start",expiry=r.expiry}) end end
end
local function router_data_failure(io)
  if not router_error then return end
  local r=router_error;router_error=nil
  router_finish(io,r.token,false)
  pdrv.fail("device-3.data-rejected",{status=status_names[r.status+1]})
end
local function router_reserve(io,op)
  router_data_failure(io);router_reconcile(io)
  if issued_count>=8 then pdrv.fail("device-3.correlation-capacity",{}) end
  assert(response_names[op],"device-3.command-route")
  repeat transaction=transaction%65535+1 until not issued[transaction]
  local expiry=io.request({kind="expiry-reserve",milliseconds=240001})
  -- Returning the ID and storing it are one Lua turn. Keep it reachable by
  -- cleanup BEFORE the next yield; no protocol write has been requested yet.
  -- This cannot recover an ID whose reserve completion never reached Lua.
  router_preparing=expiry
  local observation=io.request({kind="clock-observe"})
  issued[transaction]={token=transaction,opcode=op,expiry=expiry,issued=observation.sequence}
  issued_count=issued_count+1
  live_tokens[#live_tokens+1]=transaction
  router_preparing=nil
end
local function router_accept(b,io,sequence)
  local tx,op=u16(b,3),b:byte(2)
  local r=issued[tx]
  if r and sequence and sequence<r.issued then r=nil end
  if not r then
    r=archived[tx]
    while r and sequence and sequence<r.issued do r=r.previous end
  end
  if not r or r.opcode~=op then pdrv.fail("device-3.unknown-correlation",{}) end
  local e=r.expired or io.request({kind="expiry-read",expiry=r.expiry})
  if e.status=="reserved" then
    if op==0x32 then router_error={token=tx,status=b:byte(5)}
    else router_release(io,tx) end
    return true
  end
  if e.status=="armed" or (sequence and sequence<e.sequence) then late=late+1;return false end
  pdrv.fail("device-3.unknown-correlation",{})
end
local function router_cleanup(args,io)
  local preparing=router_preparing;router_preparing=nil
  if preparing then io.request({kind="expiry-release",expiry=preparing}) end
  -- D6 proves zero acceptance only in this case; cancellation/partial writes
  -- retain their reservation and the host starts its original terminal TTL.
  if args.code=="retained.write-rejected" and router_writing then router_release(io,router_writing) end
  router_writing=nil;router_error=nil
end
-- END shared correlation policy

local function accept(b,deliver,channel,io,sequence)
  validate(b)
  if b:byte(1)==3 then
    if b:byte(2)==0x81 then deliver(b) end
  else
    -- Always-event selectors precede the role test. A USB event endpoint is
    -- not a second response stream, even when opcode and transaction match.
    -- The declaration faults at its first unknown message; ignoring is wrong.
    if channel~=response_channel then pdrv.fail("device-3.event-only-response",{}) end
    if not router_accept(b,io,sequence) then return end
    deliver(b)
  end
end
local function next_frame(io,timer)
  if entered then
    local r=io.request({kind="message-wait",mailboxes=a({"response"}),timers=a({timer})})
    if r:sub(1,17)~="message:response:" then pdrv.fail("device-3.response-timeout",{}) end
    if r:sub(18)=="read" then local b=read_reply;read_reply=nil;assert(b,"device-3.read-custody");return b end
    return unhex(r:sub(18))
  end
  local ready
  while not ready do
    -- Stop exactly at the entry response, leaving unread suffixes with the
    -- native reader. C1 does not implicitly transfer private parser state.
    local r=io.request({kind="wait-any",maximum=1,timers=a({timer})})
    if r:sub(1,8)~="receive:" then pdrv.fail("device-3.entry-timeout",{}) end
    local channel=io.request({kind="input-channel"})
    feed(channel,r:sub(9),function(b)accept(b,function(v)ready=v end,channel,io)end,io)
  end
  return ready
end
local function send(io,op,payload,offset,n)
  router_reserve(io,op)
  expected=frame("\1"..string.char(op)..le16(transaction)..payload)
  router_writing=transaction
  if n then io.request({kind="transfer-write",offset=offset,payloadOffset=20,length=n,value=pdrv.bytes(expected)})
  else io.request({kind=entered and "write-via" or "write",value=pdrv.bytes(expected)}) end
  router_writing=nil;expected=nil;return transaction
end
local function response(io,op,payload,size,ms,entry_identity)
  local timer=io.request({kind="timer-arm",milliseconds=deadline_ms(ms)})
  local tx=send(io,op,payload)
  while true do
    local b=next_frame(io,timer)
    if b:byte(1)==2 and u16(b,3)==tx then
      assert(b:byte(2)==op,"device-3.response-opcode")
      if op==1 then
        local status=b:byte(5)
        if status~=0 then
          if not entry_identity then pdrv.fail("device-3.identify-rejected",{status=status}) end
        end
      else
        if b:byte(5)~=0 then pdrv.fail("device-3.command-rejected",{command=response_names[op],status=status_names[b:byte(5)+1]}) end
        if #b~=size then pdrv.fail("device-3.response-size",{}) end
      end
      io.request({kind="timer-cancel",timer=timer});return b
    end
    -- A cancelled request may already have a queued response. It belongs to
    -- its old transaction, never to this ABORT or a later foreground request.
  end
end
local function report(io,c,v,count)
  io.request({kind="transfer-report",cookie=active_cookie,generation=active_generation,committed=c,volatile=v,buffered=count})
end
local function window(io,ms,shared_timer)
  router_data_failure(io)
  local timer=shared_timer or io.request({kind="timer-arm",milliseconds=deadline_ms(ms)})
  while true do
    local b=next_frame(io,timer)
    if b:byte(1)==2 then
      if b:byte(2)==0x32 then router_data_failure(io) end
      pdrv.fail("device-3.unexpected-response",{})
    end
    if b:byte(2)==0x81 then
      -- Both fields bind progress to this transfer, including ordinary ACKs.
      -- BEGIN may create a new generation; matching resume does not. The old
      -- offset-only carrier is not authority to settle from a foreign report.
      if not(u32(b,5)==active_id and unsigned(u32(b,9))==active_generation) then pdrv.fail("device-3.window-identity",{}) end
      if not shared_timer then io.request({kind="timer-cancel",timer=timer}) end
      return u32(b,13),u32(b,17),b:byte(25)
    end
  end
end
local function transfer(args,io,resuming)
  local opened=io.request({kind="transfer-open"})
  local digest,saved,saved_cookie,saved_generation=opened:match("^[^|]+|([^|]+)|([^|]+)|([^|]*)|([^|]*)|")
  assert(digest,"device-3.open-result")
  local q=response(io,0x30,"\0",117,102)
  -- The declared source/target domains are constants, not QUERY geometry.
  -- Only the quiescent QUERY/report prefix authorizes a resume cursor; BEGIN's
  -- reported offset is not a binding and cannot skip fresh source bytes.
  active_cookie=hex(q:sub(102,113))
  local committed=0
  if resuming then
    active_id,active_generation=u32(q,18),unsigned(u32(q,22))
    if not(active_cookie==saved_cookie and active_generation==tonumber(saved_generation)) then pdrv.fail("device-3.resume-identity",{}) end
    if not(u32(q,26)==args.length and hex(q:sub(38,69))==digest) then pdrv.fail("device-3.resume-subject",{}) end
    local c,v,count=u32(q,30),u32(q,34),q:byte(114)
    if c~=v or count~=0 then
      -- One overall rollback bound, not a fresh 2001 ms for each old report.
      local timer=io.request({kind="timer-arm",milliseconds=deadline_ms(2001)})
      repeat c,v,count=window(io,2001,timer) until c==v and count==0
      io.request({kind="timer-cancel",timer=timer})
    end
    assert(c==v and count==0,"device-3.resume-not-quiet");report(io,c,v,count);committed=c
  end
  local b=response(io,0x31,string.rep("\0",4)..le32(args.length)..unhex(digest)..unhex(active_cookie),25,1501)
  local id,gen=u32(b,6),unsigned(u32(b,10))
  if resuming and not(id==active_id and gen==active_generation) then pdrv.fail("device-3.resume-BEGIN-identity",{}) end
  active_id,active_generation=id,gen
  report(io,committed,committed,0)
  local at,pending,observations=committed,{},0
  while committed<args.length do
    while #pending<8 and at<args.length do
      local parts,n={},0
      while n<math.min(768,args.length-at) do
        local part=io.request({kind="source-read",source=args.image,maximum=math.min(256,768-n,args.length-at-n)})
        assert(#part>0,"device-3.source-ended");parts[#parts+1]=part;n=n+#part
      end
      local deadline=io.request({kind="deadline-arm",milliseconds=deadline_ms(1001)})
      local tx=send(io,0x32,le32(id)..le32(at)..le16(n)..table.concat(parts),at,n)
      io.request({kind="deadline-disarm",deadline=deadline});at=at+n;pending[#pending+1]={last=at,token=tx}
    end
    observations=observations+1;if observations>3243 then pdrv.fail("device-3.observation-bound",{}) end
    local c,v,count=window(io,1001)
    if not(c>=committed and c<=at) then pdrv.fail("device-3.durable-prefix",{}) end
    -- A DATA acceptance is not durable settlement. A sector commit can split
    -- one 768-byte DATA range; never discard that range's uncommitted tail.
    report(io,c,v,count);committed=c
    while pending[1] and pending[1].last<=committed do router_finish(io,pending[1].token,true);table.remove(pending,1) end
  end
  io.request({kind="transfer-finalize"})
  local final=response(io,0x33,le32(id),81,240001)
  if not(u32(final,6)==id and unsigned(u32(final,10))==gen and u32(final,14)==args.length) then pdrv.fail("device-3.final-identity",{}) end
  io.request({kind="transfer-verify",source=hex(final:sub(18,49)),target=hex(final:sub(50,81))})
  active_id=nil
end
local function u64(s,i)
  -- Exact decimal accumulation, not a round trip through a binary64 number.
  local digits={0}
  for j=i+7,i,-1 do
    local carry=s:byte(j)
    for k=1,#digits do local n=digits[k]*256+carry;digits[k]=n%10;carry=n//10 end
    while carry>0 do digits[#digits+1]=carry%10;carry=carry//10 end
  end
  local out={};for k=#digits,1,-1 do out[#out+1]=tostring(digits[k]) end
  return pdrv.integer(table.concat(out))
end
local modes,profiles,locks=a({"application"}),a({"serial","usb"}),a({"protocol"})
local function int(bits)return{kind="integer",widthBits=bits,signed=false}end
local function field(t)return t end
local counters={"crcFailures","lengthFailures","revisionFailures","uartOverruns","usbOutOverruns","droppedSerialNotifications","droppedUsbNotifications","flashFailures"}
local flags={"serial","usb","telemetry","bulk-read","bulk-write-resume","usb-identity-change","settings-record"}
local titles={get_device_info="Get device information",get_diagnostics="Get diagnostics",write_image="Write image"}
local descriptions={
  get_device_info="Read hardware model, active USB identity, firmware version, device serial, and advertised capabilities.",
  get_diagnostics="Read accumulated framing, transport-overrun, notification-drop, and flash-failure counters.",
  write_image="Write a source image to the persistent bulk target through its durable journal, then verify the source and target digests. Beginning a different image invalidates any previously valid image."}
local counter_fields={};for _,name in ipairs(counters)do counter_fields[name]=field(int(32)) end
local function op(id,result)
  return{id=id,title=titles[id] or id,description=descriptions[id],binding=id,arguments={},result=result,risk="read-only",repeatability="safe-to-repeat",locks=locks,
    writeVia="receiver",requires=a({"channel.write-via","mailbox","timer","clock.observe","expiry.observe","input.retirement"}),cleanup={binding="router_cleanup",requires=a({"expiry.observe"}),maximumMilliseconds=50,maximumWork=100000,maximumLuaFuel=100000},availability={modes=modes,profiles=profiles}}
end
local info=op("get_device_info",{kind="value",type={kind="record",fields={
  hardwareModel=field({kind="enum",members=a({"daisy-seed-1.2"})}),usbIdentity=field({kind="enum",members=a({"normal","service"})}),
  firmwareMajor=field(int(8)),firmwareMinor=field(int(8)),firmwarePatch=field(int(8)),deviceSerial=field(int(64)),
  capabilities=field({kind="flags",members=a(flags)})},fieldLabels={capabilities="Capabilities",deviceSerial="Device serial",
  firmwareMajor="Firmware major",firmwareMinor="Firmware minor",firmwarePatch="Firmware patch",hardwareModel="Hardware model",usbIdentity="USB identity"}}})
-- The predecessor's separate read transfer remains a private qualification
-- binding. It is not part of the consolidated three-operation product surface.
local read=op("read_target",{kind="file",direction="out",content="Raw target domain including header and erased suffix",
  mediaType="application/octet-stream",suggestedExtension="bin",minimumBytes=1,maximumBytes=2097152,
  streamed={subject="target",offset={argument="targetOffset"},length={argument="length"}}})
read.arguments={targetOffset={kind="integer",widthBits=32,signed=true,minimum=0,maximum=2097151},
  length={kind="integer",widthBits=32,signed=true,minimum=1,maximum=2097152}}
local identity=op("set_usb_identity",{kind="none"})
identity.risk="destructive";identity.repeatability="not-repeatable"
identity.arguments={identity={kind="enum",members=a({"normal","service"})},
  detachDelayMs={kind="integer",widthBits=16,signed=true,minimum=250,maximum=5000}}
local write=op("write_image",{kind="none"})
write.risk="destructive";write.repeatability="not-repeatable"
write.arguments={image={kind="stream-source",minimumBytes=1,maximumBytes=2097088,label="Source image",
  description="The image bytes to write. The source identity is bound to its SHA-256 digest for resume."},
  length={kind="integer",widthBits=32,signed=true,minimum=1,maximum=2097088,label="Image length",
  description="Number of source-image bytes to write to the target."}}
write.arguments.length.unit={kind="fixed",id="byte"}
write.requires=a({"channel.write-via","mailbox","timer","operation.deadline","transfer.checkpoint","clock.observe","expiry.observe","input.retirement"})
write.transfer={segmented=true,sourceArgument="image",sourceRange={offset=0,length={argument="length"}},maximumCarrierBytes=792,
  targetOffset=64,targetLength=2097152,resumeBinding="resume",finalization="repeatable"}
write.cleanup={binding="abort",writeVia="receiver",requires=a({"channel.write-via","mailbox","timer","transfer.cleanup","clock.observe","expiry.observe","input.retirement"}),
  maximumMilliseconds=535,maximumLuaFuel=100000,maximumWork=1000000}
return{apiVersion="device/v2",id="device-3-authored",displayName="D3LINK",
  description="Inspect a D3LINK implementation and access its persistent bulk-image target over serial or USB. The declared image write is implemented by the Daisy Seed; the retained Teensy implementation reports it unsupported.",
  modes=modes,modePresentation={application={label="Application protocol",description="Use the revision-1 application protocol over serial or USB. Telemetry and bulk progress notifications may arrive without a request."}},
  profiles=profiles,mailboxes=a({"response"}),
  connectionProfiles={
    serial={modes=modes,acquisitionFilters=a({{transport="serial",vendorId=1027,productId=24592}}),
      transport={kind="serial",baudRate=921600,dataBits=8,parity="none",stopBits=1,flowControl="none"},
      channels=a({{id="main",protocolDuplex="full-duplex"}}),
      lifecycle={openingDrainQuietMs=0,postTerminationSilence={minimumMs=0,afterAbnormalTermination=false,afterModeExit=false}}},
    usb={modes=modes,acquisitionFilters=a({
        {transport="usb",vendorId=5824,productId=1235,usbClass=255},
        {transport="usb",vendorId=5824,productId=1236,usbClass=255}}),
      transport={kind="usb",configurationValue=1,interfaceNumber=0,alternateSetting=0,channels=a({
        {id="requests",input=pdrv.null,output={endpointNumber=1,transferType="bulk",maximumPacketBytes={full=64,high=512}}},
        {id="responses",input={endpointNumber=1,transferType="bulk",maximumPacketBytes={full=64,high=512}},output=pdrv.null},
        {id="events",input={endpointNumber=2,transferType="interrupt",maximumPacketBytes={full=64,high=64}},output=pdrv.null}})}}},
  channelRoles={serial={request="main",response="main",event="main"},usb={request="requests",response="responses",event="events"}},
  entry={binding="enter",locks=locks,requires=a({"channel.read","channel.write","timer","clock.observe","expiry.observe","input.retirement"}),handoffTo="receiver",inputEvidence="consumed-ranges"},
  handlers=a({{id="receiver",binding="receive",acceptHandoff="handoff",authorizeWrite="authorize",inputEvidence="consumed-ranges",
    event={kind="channel-input",channelId="main"},maximumConcurrent=4,locks=a({"parser"}),requires=a({"channel.input","mailbox","clock.observe","expiry.observe"})}}),
  operations=a({info,op("get_diagnostics",{kind="value",type={kind="record",fields=counter_fields,fieldLabels={
    crcFailures="CRC failures",droppedSerialNotifications="Dropped serial notifications",droppedUsbNotifications="Dropped USB notifications",
    flashFailures="Flash failures",lengthFailures="Length failures",revisionFailures="Revision failures",uartOverruns="UART overruns",usbOutOverruns="USB OUT overruns"}}}),write})},{
  enter=function(context,io)
    assert(context.profileId=="serial" or context.profileId=="usb","device-3.profile")
    delivery_allowance=context.profileId=="serial" and 34 or 0
    response_channel=context.profileId=="serial" and "main" or "responses"
    entered=false;buffers={};expected=nil;active_id=nil;transaction=0;read_reply=nil
    issued={};archived={};live_tokens={};issued_count=0;archived_count=0;late=0;router_error=nil;router_writing=nil;router_preparing=nil
    history_root=nil;dirty_head=nil;dirty_tail=nil;source_ranges={};interpreting=nil
    -- Shipped establishment requires the IDENTIFY selector, not status OK.
    -- Its public information command separately requires OK. Geometry fields
    -- are reported integers, not identity constants; do not tighten them here.
    response(io,1,"",31,101,true)
    -- Prefixes stay in this shared parser; the broker transfers their byte
    -- custody, not a second delivery. Neither stream has to become silent.
    assert(io.request({kind="entry-handoff",parser="retained-prefixes",timers="none"})=="accepted");entered=true
  end,
  handoff=function(o)
    if o.parser~="retained-prefixes" or o.timers~="none" then return{accepted=false}end
    local lengths={};for _,p in ipairs(o.prefixes)do lengths[p.channelId]=p["end"]-p.start end
    for _,ch in ipairs({"main","responses","events"})do
      if (lengths[ch] or 0)~=#(buffers[ch] or "") then return{accepted=false}end
    end
    return{accepted=true}
  end,
  authorize=function(r)return{accepted=expected~=nil and r.bytes==expected and
    (r.origin=="operation" or (r.origin=="cleanup" and r.cleanupOf~="" and r.operation=="write_image"))}end,
  receive=function(args,io)
    router_begin(args.channelId or "main",#args.input,args.observation.sequence)
    feed(args.channelId or "main",args.input,function(b)accept(b,function(v)
      if v:byte(1)==2 and v:byte(2)==0x35 and #v>128 then
        -- The 256-byte mailbox carries notice, not a second copy of a 1035-byte
        -- reply. The shared parser owns one reply until its serialized reader
        -- takes it; consumption evidence moves with the single notice.
        assert(not read_reply,"device-3.read-overlap");read_reply=v
        io.request({kind="message-send",mailbox="response",value="read"})
      else io.request({kind="message-send",mailbox="response",value=hex(v)}) end
    end,args.channelId or "main",io,args.observation.sequence)end,io)
    router_done()
  end,
  get_device_info=function(_,io)
    local b=response(io,1,"",31,101)
    local capabilities={};for i=1,#flags do if(u32(b,28)&(1<<(i-1)))~=0 then capabilities[#capabilities+1]=flags[i] end end
    return{hardwareModel="daisy-seed-1.2",usbIdentity=b:byte(8)==0 and "normal" or "service",firmwareMajor=b:byte(9),firmwareMinor=b:byte(10),
      firmwarePatch=b:byte(11),deviceSerial=u64(b,16),capabilities=a(capabilities)}
  end,
  set_usb_identity=function(args,io)
    local selected
    if args.identity=="normal" then selected=0 elseif args.identity=="service" then selected=1 else pdrv.fail("device-3.identity-selection",{}) end
    response(io,0x20,string.char(selected,0)..le16(args.detachDelayMs),5,101);return nil
  end,
  get_diagnostics=function(_,io)
    local b=response(io,2,"",37,101);local result={};for i,name in ipairs(counters)do result[name]=unsigned(u32(b,2+4*i)) end;return result
  end,
  read_target=function(args,io)
    if args.targetOffset+args.length>2097152 then pdrv.fail("device-3.target-range",{}) end
    local at,left=args.targetOffset,args.length
    while left>0 do
      local n=math.min(1024,left)
      local b=response(io,0x35,string.rep("\0",4)..le32(at)..le16(n).."\0\0",11+n,112)
      if not(u32(b,6)==at and u16(b,10)==n) then pdrv.fail("device-3.read-range",{}) end
      -- Device READ replies carry 1024 octets; destination crossings have their
      -- own bounded lifetime. Neither grants a whole-target Lua buffer.
      for i=12,#b,256 do
        io.request({kind="resource-write",resource=io.resultDestination,value=pdrv.bytes(b:sub(i,i+255))})
      end
      at=at+n;left=left-n
    end
    return io.resultDestination
  end,
  write_image=function(args,io)return transfer(args,io,false)end,
  resume=function(args,io)return transfer(args,io,true)end,
  router_cleanup=router_cleanup,
  abort=function(args,io)
    router_cleanup(args,io)
    -- A later operation can be cancelled in host prehash before Lua starts.
    -- Its cleanup must not inherit this terminated operation's device ID.
    if args.outcome~="cancelled" then active_id=nil;return end
    if not active_id then return end
    response(io,0x34,le32(active_id),5,501)
    io.request({kind="transfer-retire",cookie=active_cookie,generation=active_generation});active_id=nil
  end,
}
