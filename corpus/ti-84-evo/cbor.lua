-- Bounded RFC 8949 subset used by TI-84 Evo resource responses.
local M={}
local function unsigned(bytes,at,count)
  local value=0
  for index=at,at+count-1 do
    local octet=bytes:byte(index);if octet==nil then pdrv.fail("cbor.truncated",{at=index,length=#bytes}) end
    value=value*256+octet
  end
  return value
end
local function read(bytes,at,wrap)
  if at>#bytes then pdrv.fail("cbor.truncated",{at=at,length=#bytes}) end
  local initial=bytes:byte(at);local major=initial//32;local minor=initial%32;local cursor=at+1
  local argument,indefinite=minor,false
  if minor==24 then argument=unsigned(bytes,cursor,1);cursor=cursor+1
  elseif minor==25 then argument=unsigned(bytes,cursor,2);cursor=cursor+2
  elseif minor==26 then argument=unsigned(bytes,cursor,4);cursor=cursor+4
  elseif minor==27 then argument=unsigned(bytes,cursor,8);cursor=cursor+8
  elseif minor==31 then indefinite=true
  elseif minor>27 then pdrv.fail("cbor.reserved-additional-information",{value=minor,at=at}) end
  if indefinite and (major<2 or major>5) then
    pdrv.fail("cbor.indefinite-not-supported",{major=major,at=at})
  end
  if major==0 then return argument,cursor end
  if major==1 then return -1-argument,cursor end
  if major==2 or major==3 then
    local joined
    if indefinite then
      local parts={}
      while true do
        if cursor>#bytes then pdrv.fail("cbor.truncated",{at=cursor,length=#bytes}) end
        if bytes:byte(cursor)==0xff then cursor=cursor+1;break end
        local chunk_initial=bytes:byte(cursor)
        if chunk_initial//32~=major or chunk_initial%32==31 then
          pdrv.fail("cbor.invalid-string-chunk",{at=cursor,major=chunk_initial//32})
        end
        local chunk;chunk,cursor=read(bytes,cursor,false)
        parts[#parts+1]=chunk
      end
      joined=table.concat(parts)
    else
      joined=bytes:sub(cursor,cursor+argument-1)
      if #joined~=argument then pdrv.fail("cbor.truncated-string",{want=argument,got=#joined}) end
      cursor=cursor+argument
    end
    if major==2 and wrap==true then return pdrv.bytes(joined),cursor end
    if major==2 and wrap=="typed" then return {kind="bytes",value=joined},cursor end
    return joined,cursor
  end
  if major==4 then
    local items={}
    if indefinite then
      while true do
        if cursor>#bytes then pdrv.fail("cbor.truncated",{at=cursor,length=#bytes}) end
        if bytes:byte(cursor)==0xff then cursor=cursor+1;break end
        local item;item,cursor=read(bytes,cursor,wrap);items[#items+1]=item
      end
    else for _=1,argument do local item;item,cursor=read(bytes,cursor,wrap);items[#items+1]=item end end
    if wrap==true then return pdrv.array(items),cursor end;return items,cursor
  end
  if major==5 then
    local record={}
    local function entry()
      local key,value;key,cursor=read(bytes,cursor,false);value,cursor=read(bytes,cursor,wrap)
      if type(key)~="string" then pdrv.fail("cbor.non-text-map-key",{at=cursor}) end
      record[key]=value
    end
    if indefinite then
      while true do
        if cursor>#bytes then pdrv.fail("cbor.truncated",{at=cursor,length=#bytes}) end
        if bytes:byte(cursor)==0xff then cursor=cursor+1;break end
        entry()
      end
    else for _=1,argument do entry() end end
    return record,cursor
  end
  if major==7 then
    if minor==20 then return false,cursor end;if minor==21 then return true,cursor end;if minor==22 then return pdrv.null,cursor end
    pdrv.fail("cbor.unsupported-simple-value",{value=minor,at=at})
  end
  pdrv.fail("cbor.unsupported-major-type",{major=major,at=at})
end
local function whole(bytes,wrap)
  local value,after=read(bytes,1,wrap)
  if after~=#bytes+1 then pdrv.fail("cbor.trailing-octets",{consumed=after-1,length=#bytes}) end
  return value
end
function M.decode(bytes) return whole(bytes,true) end
function M.decode_native(bytes) return whole(bytes,false) end
function M.decode_typed(bytes) return whole(bytes,"typed") end
function M.decode_prefix(bytes) local value,after=read(bytes,1,true);return value,after-1 end
return M
