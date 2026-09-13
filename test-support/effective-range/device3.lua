-- Fresh D3LINK transfer continuation, not a completed corpus migration.
-- Resume, cleanup, entry, public read operations and idle telemetry remain
-- outside this probe. It must not be used as a completed author-cost numerator.
local a=pdrv.array
local crc_table={}
for i=0,255 do
  local c=i
  for bit=1,8 do c=(c>>1)~((c&1)==1 and 0x82f63b78 or 0) end
  crc_table[i]=c
end
local function le16(n) return string.char(n&255,(n>>8)&255) end
local function le32(n) return le16(n&65535)..le16((n>>16)&65535) end
local function u16(s,i) local l,h=s:byte(i,i+1);return l+h*256 end
local function u32(s,i) return u16(s,i)+u16(s,i+2)*65536 end
local function crc(s)
  local c=0xffffffff
  local lookup,byte=crc_table,string.byte
  local full=#s-(#s%4)
  for i=1,full,4 do
    local b0,b1,b2,b3=byte(s,i,i+3)
    c=(c>>8)~lookup[(c~b0)&255]
    c=(c>>8)~lookup[(c~b1)&255]
    c=(c>>8)~lookup[(c~b2)&255]
    c=(c>>8)~lookup[(c~b3)&255]
  end
  for i=full+1,#s do c=(c>>8)~lookup[(c~byte(s,i))&255] end
  return c~0xffffffff
end
local function frame(body)
  local covered="\1"..le16(#body)..body
  return "\xa5\x5a\xd3"..covered..le32(crc(covered))
end
local function hex(s) return (s:gsub(".",function(c)return string.format("%02x",c:byte())end)) end
local function unhex(s) return (s:gsub("..",function(c)return string.char(tonumber(c,16))end)) end
local function transfer(args,io)
  local length,transaction=args.length,0
  local buffers={responses="",events=""}
  local function next_frame(timer)
    while true do
      -- USB has independently framed input streams. Never concatenate the
      -- end of endpoint 81 with the beginning of endpoint 82.
      for _,channel in ipairs({"responses","events"}) do
        local s=buffers[channel]
        while #s>=6 do
          if s:sub(1,4)~="\xa5\x5a\xd3\1" or u16(s,5)<4 or u16(s,5)>2048 then s=s:sub(2)
          else
            local n=u16(s,5)+10
            if #s<n then break end
            if crc(s:sub(4,n-4))~=u32(s,n-3) then s=s:sub(2)
            else buffers[channel]=s:sub(n+1);return s:sub(7,n-4) end
          end
        end
        buffers[channel]=s
      end
      local r=io.request({kind="wait-any",maximum=256,timers=a({timer})})
      assert(r:sub(1,8)=="receive:","device-3.response-timeout")
      local channel=io.request({kind="input-channel"})
      assert(buffers[channel],"unexpected input channel")
      buffers[channel]=buffers[channel]..r:sub(9)
      assert(#buffers[channel]<=2314,"device-3.parser-capacity")
    end
  end
  local function arm(ms) return io.request({kind="timer-arm",milliseconds=ms}) end
  local function cancel(t) io.request({kind="timer-cancel",timer=t}) end
  local function send(op,payload,source_offset,n)
    transaction=transaction%65535+1
    local bytes=frame("\1"..string.char(op)..le16(transaction)..payload)
    if n then io.request({kind="transfer-write",offset=source_offset,payloadOffset=20,length=n,value=pdrv.bytes(bytes)})
    else io.request({kind="write",value=pdrv.bytes(bytes)}) end
    return transaction
  end
  local function response(op,payload,size,ms)
    local timer=arm(ms)
    local deadline=io.request({kind="deadline-arm",milliseconds=ms})
    local tx=send(op,payload)
    while true do
      local b=next_frame(timer)
      if b:byte(1)==2 then
        assert(b:byte(2)==op and u16(b,3)==tx,"device-3.correlation")
        assert(b:byte(5)==0 and #b==size,"device-3.response")
        cancel(timer);io.request({kind="deadline-disarm",deadline=deadline});return b
      end
      assert(b:byte(1)==3 and u16(b,3)==0,"device-3.notification")
    end
  end
  local opened=io.request({kind="transfer-open"})
  local digest=assert(opened:match("^[^|]+|([^|]+)|"))
  local q=response(0x30,"\0",117,102)
  assert(u16(q,8)==4096 and u32(q,10)==2097152 and u32(q,14)==2097088,"device-3.geometry")
  local cookie=q:sub(102,113)
  local begin=response(0x31,string.rep("\0",4)..le32(length)..unhex(digest)..cookie,25,1501)
  local id,generation,committed=u32(begin,6),u32(begin,10),u32(begin,14)
  assert(committed==0,"fresh probe requires a fresh image")
  io.request({kind="transfer-report",cookie=hex(cookie),generation=generation,committed=0,volatile=0,buffered=0})
  local at,pending,observations=0,{},0
  while committed<length do
    while #pending<8 and at<length do
      local parts,n={},0
      while n<math.min(768,length-at) do
        local part=io.request({kind="source-read",source=args.image,maximum=math.min(256,768-n,length-at-n)})
        assert(#part>0,"device-3.source-ended");parts[#parts+1]=part;n=n+#part
      end
      local deadline=io.request({kind="deadline-arm",milliseconds=1001})
      send(0x32,le32(id)..le32(at)..le16(n)..table.concat(parts),at,n)
      io.request({kind="deadline-disarm",deadline=deadline})
      at=at+n;pending[#pending+1]=at
    end
    observations=observations+1;assert(observations<=3243,"device-3.observation-bound")
    local timer=arm(1001)
    while true do
      local b=next_frame(timer)
      assert(b:byte(1)==3 and u16(b,3)==0,"device-3.DATA-rejected")
      if b:byte(2)==0x81 then
        assert(#b==28 and u32(b,5)==id and u32(b,9)==generation,"device-3.window-identity")
        local c,v,count=u32(b,13),u32(b,17),b:byte(25)
        assert(c>=committed and c<=at,"device-3.durable-prefix")
        -- A commit can split DATA. Remove only ranges whose end is durable.
        -- Common source/checkpoint services independently check this horizon.
        io.request({kind="transfer-report",cookie=hex(cookie),generation=generation,committed=c,volatile=v,buffered=count})
        committed=c;while pending[1] and pending[1]<=committed do table.remove(pending,1) end
        cancel(timer);break
      end
    end
  end
  io.request({kind="transfer-finalize"})
  local final=response(0x33,le32(id),81,240001)
  assert(u32(final,6)==id and u32(final,10)==generation and u32(final,14)==length,"device-3.final-identity")
  io.request({kind="transfer-verify",source=hex(final:sub(18,49)),target=hex(final:sub(50,81))})
end
return {apiVersion="device/v2",id="device-3-fresh-transfer-probe",modes=a({"application"}),profiles=a({"usb"}),
 channelRoles={usb={request="requests",response="responses",event="events"}},operations=a({{
 id="write_image",title="Write image",binding="write_image",arguments={
 image={kind="stream-source",minimumBytes=1,maximumBytes=2097088},
 length={kind="integer",widthBits=32,signed=true,minimum=1,maximum=2097088}},
 result={kind="none"},risk="destructive",repeatability="not-repeatable",locks=a({"protocol"}),
 requires=a({"channel.read","channel.write","timer","operation.deadline","transfer.checkpoint"}),
 availability={modes=a({"application"}),profiles=a({"usb"})},
 transfer={segmented=true,sourceArgument="image",sourceRange={offset=0,length={argument="length"}},
 maximumCarrierBytes=792,targetOffset=64,targetLength=2097152,resumeBinding="resume",finalization="repeatable"}
 }})}, {write_image=transfer,resume=function()error("this fresh-transfer probe does not implement resume")end}
