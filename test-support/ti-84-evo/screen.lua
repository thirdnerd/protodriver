-- TI-84 Evo screenshot decode adapted for the v2 streamed file-result owner.
local C, E = require("cbor.lua"), require("evo.lua")
local WIDTH, HEIGHT, OCTETS = 320, 240, 320*240*2

local function transactions(stream)
  if #stream==0 then pdrv.fail("evo.empty-stream",{}) end
  local list,current,at={},nil,1
  while at+4<=#stream do
    local frame,after=E.read_frame_at(stream,at);at=after
    local command=frame.command
    if command~="Y" then
      if command=="S" then
        if current then pdrv.fail("evo.incomplete-transaction",{expected=current.phase,observed="S"}) end
        current={path="",declared=nil,parts={},phase="F",data_frames=0}
      elseif not current then
        pdrv.fail("evo.frame-outside-transaction",{observed=command})
      end
    end
    if current and command~="S" and command~="Y" then
      local expected=current.phase
      local allowed=command==expected or (expected=="D" and command=="Z" and current.data_frames>0)
      if not allowed then pdrv.fail("evo.transaction-order",{expected=expected,observed=command}) end
      local lead=frame.form=="long" and E.LEAD_OCTETS or 0
      if command=="F" then current.path=E.decode_body(frame.raw,lead);current.phase="A"
      elseif command=="A" then current.declared=E.declared_length(frame.raw);current.phase="D"
      elseif command=="D" then current.parts[#current.parts+1]=E.decode_body(frame.raw,lead);current.data_frames=current.data_frames+1
      elseif command=="Z" then
        if current.data_frames==0 then pdrv.fail("evo.transaction-order",{expected="D",observed="Z"}) end
        current.phase="B"
      elseif command=="B" then list[#list+1]=current;current=nil end
    end
  end
  if at<=#stream then pdrv.fail("evo.frame-truncated",{at=at,length=#stream}) end
  if current then pdrv.fail("evo.incomplete-transaction",{expected=current.phase}) end
  return list
end

local function payload(transaction)
  local value=table.concat(transaction.parts)
  if transaction.declared and transaction.declared~=0 and #value~=transaction.declared then
    pdrv.fail("evo.declared-length-mismatch",{path=transaction.path,declared=transaction.declared,decoded=#value})
  end
  return value
end

local function screen_record(stream)
  for _,transaction in ipairs(transactions(stream)) do
    if #transaction.parts>0 then
      local value=payload(transaction);local initial=value:byte(1)
      if initial and initial>=0xa0 and initial<=0xbf then
        local record=C.decode_typed(value)
        if type(record)=="table" then
          for _,key in ipairs({"width","height","bpp","data"}) do
            if record[key]==nil then pdrv.fail("evo.screen-record-missing-key",{key=key}) end
          end
          return record
        end
      end
    end
  end
  pdrv.fail("evo.no-such-response",{want="width,height,bpp,data"})
end

local function screen(stream)
  local record=screen_record(stream)
  if record.width~=WIDTH or record.height~=HEIGHT then pdrv.fail("evo.screen-unexpected-geometry",{width=record.width,height=record.height}) end
  if record.bpp~=16 then pdrv.fail("evo.screen-unexpected-depth",{bpp=record.bpp}) end
  if type(record.data)~="table" or record.data.kind~="bytes" or type(record.data.value)~="string" then
    pdrv.fail("evo.screen-missing-data",{observed=type(record.data)})
  end
  if #record.data.value~=OCTETS then pdrv.fail("evo.screen-length",{expected=OCTETS,observed=#record.data.value}) end
  return record.data.value
end

local function le16(value) return string.pack("<I2",value&0xffff) end
local function le32(value) return string.pack("<I4",value&0xffffffff) end
local function screen_bmp(stream)
  local pixels=screen(stream)
  return table.concat({"BM",le32(66+OCTETS),le32(0),le32(66),le32(40),le32(WIDTH),le32(-HEIGHT),
    le16(1),le16(16),le32(3),le32(OCTETS),le32(2835),le32(2835),le32(0),le32(0),
    le32(0xf800),le32(0x07e0),le32(0x001f),pixels})
end
return {screen_bmp=screen_bmp}
