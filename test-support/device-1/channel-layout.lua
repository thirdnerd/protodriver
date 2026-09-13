-- Device-1's stored channel record. Protocol transport is deliberately absent.
-- Reserved octets remain in sourcePayload; decoding is not permission to edit them.
local M={}
local function record(fields) return {kind="record",fields=fields} end
local function integer(bits,maximum) return {kind="integer",widthBits=bits,signed=false,minimum=0,maximum=maximum} end
local function enum(values) return {kind="enum",members=pdrv.array(values)} end
local empty=record({})
local frequency={kind="variant",variants={value=record({value=integer(32,999999990)}),erased=empty}}
local tone={kind="variant",variants={none=empty,
  ctcss=record({tenthsHz=record({kind=enum({"value"}),value=integer(16,2541)})}),
  dcs=record({code=integer(16,0x999),reserved=integer(8,0),polarity=enum({"normal","inverted"}),marker=enum({"dcs"})})}}
local bandwidth={"narrow","wide","unassigned-10","unassigned-11"}
local power={"low","medium","high","unassigned-11"}
local ptt={"off","bot","eot","both"}
M.rowType=record({index=integer(8,249),offsetBytes=integer(16,4032),
  sourcePayload={kind="bytes",minimumLength=16,maximumLength=16},fields=record({
    receiveFrequency=frequency,transmitFrequency=frequency,receiveTone=tone,transmitTone=tone,
    busyChannelLock={kind="boolean"},pttId=enum(ptt),bandwidth=enum(bandwidth),power=enum(power),
    signallingGroup=integer(8,15),frequencyHopping={kind="boolean"},scanAdd={kind="boolean"}})})
local function bcd(raw)
  local result=0
  for i=#raw,1,-1 do
    local byte=string.byte(raw,i)
    if byte%16>9 or byte//16>9 then error("protocol.layout.invalid-bcd-digit",0) end
    result=result*100+(byte//16)*10+byte%16
  end
  return result
end
local function decode_frequency(raw)
  if raw=="\xff\xff\xff\xff" then return pdrv.variant("erased",{}) end
  return pdrv.variant("value",{value=bcd(raw)*10})
end
local function decode_tone(raw)
  local word=string.byte(raw,1)+256*string.byte(raw,2)
  if word==0xffff then return pdrv.variant("none",{}) end
  if word & 0x8000 ~= 0 then
    local code=word & 0xfff
    if word & 0x3000 ~= 0 or code%16>9 or (code>>4)%16>9 or (code>>8)%16>9 then
      error("device-1.invalid-dcs",0)
    end
    -- The predecessor exposes packed decimal digits, not their decimal integer.
    return pdrv.variant("dcs",{code=code,reserved=0,polarity=word&0x4000==0 and "normal" or "inverted",marker="dcs"})
  end
  local tenths=bcd(raw)
  if tenths<670 or tenths>2541 then error("device-1.invalid-ctcss",0) end
  return pdrv.variant("ctcss",{tenthsHz={kind="value",value=tenths}})
end
function M.decode(raw,index)
  if #raw~=16 or index<0 or index>249 then error("device-1.record-bounds",0) end
  local settings,flags=string.byte(raw,14,15)
  return {index=index,offsetBytes=48+index*16,sourcePayload=pdrv.bytes(raw),fields={
    receiveFrequency=decode_frequency(string.sub(raw,1,4)),transmitFrequency=decode_frequency(string.sub(raw,5,8)),
    receiveTone=decode_tone(string.sub(raw,10,11)),transmitTone=decode_tone(string.sub(raw,12,13)),
    busyChannelLock=settings&0x40~=0,pttId=ptt[((settings>>4)&3)+1],bandwidth=bandwidth[((settings>>2)&3)+1],
    power=power[(settings&3)+1],signallingGroup=flags>>4,frequencyHopping=flags&2~=0,scanAdd=flags&1~=0}}
end
function M.decode_sector(raw)
  if #raw~=4096 then error("device-1.sector-bounds",0) end
  local rows={}
  for index=0,249 do rows[#rows+1]=M.decode(string.sub(raw,49+index*16,64+index*16),index) end
  return pdrv.array(rows)
end

-- Each of the ten public edits is explicit keep/set; absent intent never means zero.
local function inputInteger(maximum) return {kind="integer",widthBits=32,signed=true,minimum=0,maximum=maximum} end
local inputFrequency={kind="variant",variants={value=inputInteger(999999990),erased=empty}}
local inputTone={kind="variant",variants={none=empty,ctcss=inputInteger(2541),
  dcs=record({code=inputInteger(0x999),polarity=enum({"normal","inverted"})})}}
local editable={receiveFrequency=inputFrequency,transmitFrequency=inputFrequency,
  receiveTone=inputTone,transmitTone=inputTone,busyChannelLock={kind="boolean"},pttId=enum(ptt),
  bandwidth=enum({"narrow","wide"}),power=enum({"low","medium","high"}),
  signallingGroup={kind="integer",widthBits=8,signed=true,minimum=1,maximum=15},scanAdd={kind="boolean"}}
M.editType=record({})
for name,t in pdrv.record_fields(editable) do M.editType.fields[name]={kind="variant",variants={keep=empty,set=t}} end
local function encode_bcd(n,count)
  local out={}
  for i=1,count do local v=n%100;out[i]=string.char((v//10)*16+v%10);n=n//100 end
  if n~=0 then error("device-1.edit-range",0) end
  return table.concat(out)
end
local function encode_frequency(v)
  if v.tag=="erased" then return string.rep("\xff",4) end
  if v.value%10~=0 then error("device-1.inexact-frequency",0) end
  return encode_bcd(v.value//10,4)
end
local function encode_tone(v)
  if v.tag=="none" then return "\xff\xff" end
  if v.tag=="ctcss" then
    if v.value<670 then error("device-1.invalid-ctcss",0) end
    return encode_bcd(v.value,2)
  end
  local code=v.value.code
  if code%16>9 or (code>>4)%16>9 or (code>>8)%16>9 then error("device-1.invalid-dcs",0) end
  local word=code|0x8000|(v.value.polarity=="inverted" and 0x4000 or 0)
  return string.char(word%256,word//256)
end
local function ordinal(list,value)
  for i,v in ipairs(list) do if v==value then return i-1 end end
  error("device-1.edit-member",0)
end
function M.edit(raw,index,edits)
  local first=49+index*16
  local bytes={string.byte(raw,first,first+15)}
  local function patch(at,value) for i=1,#value do bytes[at+i-1]=string.byte(value,i) end end
  for name,e in pdrv.record_fields(edits) do if e.tag=="set" then
    local v=e.value
    if name=="receiveFrequency" or name=="transmitFrequency" then patch(name=="receiveFrequency" and 1 or 5,encode_frequency(v))
    elseif name=="receiveTone" or name=="transmitTone" then patch(name=="receiveTone" and 10 or 12,encode_tone(v))
    elseif name=="busyChannelLock" then bytes[14]=(bytes[14]&0xbf)|(v and 0x40 or 0)
    elseif name=="pttId" then bytes[14]=(bytes[14]&0xcf)|(ordinal(ptt,v)<<4)
    elseif name=="bandwidth" then bytes[14]=(bytes[14]&0xf3)|(ordinal(bandwidth,v)<<2)
    elseif name=="power" then bytes[14]=(bytes[14]&0xfc)|ordinal(power,v)
    elseif name=="signallingGroup" then bytes[15]=(bytes[15]&0x0f)|(v<<4)
    elseif name=="scanAdd" then bytes[15]=(bytes[15]&0xfe)|(v and 1 or 0) end
  end end
  local encoded=string.char(table.unpack(bytes))
  M.decode(encoded,index) -- Validate the complete changed record before any write.
  return string.sub(raw,1,first-1)..encoded..string.sub(raw,first+16)
end
return M
