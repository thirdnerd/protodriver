-- TI-84 Evo Kermit framing for the screenshot resource exchange.
local M={LEAD_OCTETS=3,LONG_FORM_BASE=95}
local SOH,CR,ESC,RUN=0x01,0x0d,0x23,0x7e
local SELF={[0x23]=true,[0x7e]=true,[0xa3]=true,[0xfe]=true}

function M.escaped_octet(octet) if SELF[octet] then return octet end;return octet~0x40 end

function M.decode_body(raw,lead)
  local out,n,i={},#raw,lead+1
  while i<=n do
    local j=string.find(raw,"[\35\126]",i)
    if j==nil then out[#out+1]=raw:sub(i);break end
    if j>i then out[#out+1]=raw:sub(i,j-1) end
    local marker=raw:byte(j)
    if marker==RUN and j+2<=n then
      local count=raw:byte(j+1)-0x20;local value
      if raw:byte(j+2)==ESC and j+3<=n then value=M.escaped_octet(raw:byte(j+3));i=j+4
      else value=raw:byte(j+2);i=j+3 end
      if count<1 then pdrv.fail("evo.run-count-invalid",{at=j,count=count}) end
      out[#out+1]=string.rep(string.char(value),count)
    elseif marker==ESC and j+1<=n then
      out[#out+1]=string.char(M.escaped_octet(raw:byte(j+1)));i=j+2
    else pdrv.fail("evo.truncated-code",{at=j,marker=marker,length=n}) end
  end
  return table.concat(out)
end

function M.declared_length(raw)
  if #raw<8 or raw:sub(1,5)~='""B81' then pdrv.fail("evo.a-frame-unparseable",{length=#raw}) end
  local digits=raw:byte(6)-0x20;local text=raw:sub(7,6+digits)
  if #text~=digits or text:match("^%d+$")==nil or raw:sub(7+digits)~="@ " then
    pdrv.fail("evo.a-frame-unparseable",{digits=digits})
  end
  return tonumber(text)
end

function M.octet_sum(text)
  local total,index=0,1
  while index+7<=#text do local a,b,c,d,e,f,g,h=text:byte(index,index+7);total=total+a+b+c+d+e+f+g+h;index=index+8 end
  while index<=#text do total=total+text:byte(index);index=index+1 end
  return total
end

function M.checksum(len,sequence,command,body)
  local x=(len+sequence+command+M.octet_sum(body))&0xff
  return 0x20+(((x&0x3f)+(x>>6))&0x3f)
end

function M.wire_frame_length(prefix)
  if #prefix<2 then return nil end
  if prefix:byte(1)~=SOH then pdrv.fail("evo.frame-missing-soh",{at=1,observed=prefix:byte(1)}) end
  local len=prefix:byte(2)
  if len==0x20 then
    if #prefix<6 then return nil end
    local count=(prefix:byte(5)-0x20)*M.LONG_FORM_BASE+(prefix:byte(6)-0x20)
    if count<1 then pdrv.fail("evo.frame-length-invalid",{at=1,count=count}) end
    return count+8
  end
  if len<0x23 then pdrv.fail("evo.frame-length-reserved",{at=1,value=len}) end
  return len-0x23+6
end

function M.complete_wire_frame_length(prefix) return M.wire_frame_length(prefix) end

function M.read_frame_at(stream,at)
  if at+4>#stream then pdrv.fail("evo.frame-truncated",{at=at,length=#stream}) end
  if stream:byte(at)~=SOH then pdrv.fail("evo.frame-missing-soh",{at=at,observed=stream:byte(at)}) end
  local len=stream:byte(at+1);local frame={sequence=stream:byte(at+2),command=stream:sub(at+3,at+3)}
  local last,after
  if len==0x20 then
    if at+5>#stream then pdrv.fail("evo.frame-truncated",{at=at,length=#stream}) end
    local count=(stream:byte(at+4)-0x20)*M.LONG_FORM_BASE+(stream:byte(at+5)-0x20)
    if count<1 then pdrv.fail("evo.frame-length-invalid",{at=at,count=count}) end
    frame.form="long";last=at+count+5
    if last+2>#stream then pdrv.fail("evo.frame-truncated",{at=at,want=last+2,length=#stream}) end
    if stream:byte(last+2)~=CR then pdrv.fail("evo.frame-length-disagrees-with-terminator",{at=at,declared=count,at_terminator=stream:byte(last+2)}) end
    frame.checksum=stream:byte(last+1);after=last+3
  elseif len>=0x23 then
    last=at+3+(len-0x23)
    if last+2>#stream then pdrv.fail("evo.frame-truncated",{at=at,want=last+1,length=#stream}) end
    frame.form="definite";frame.checksum=stream:byte(last+1)
    if stream:byte(last+2)~=CR then pdrv.fail("evo.frame-missing-terminator",{at=at,at_terminator=stream:byte(last+2)}) end
    after=last+3
  else pdrv.fail("evo.frame-length-reserved",{at=at,value=len}) end
  frame.raw=stream:sub(at+4,last)
  local expected=M.checksum(len,frame.sequence,stream:byte(at+3),frame.raw)
  if expected~=frame.checksum then pdrv.fail("evo.frame-checksum",{at=at,expected=expected,observed=frame.checksum}) end
  return frame,after
end

function M.read_frame(frame)
  local read,after=M.read_frame_at(frame,1)
  if after~=#frame+1 then pdrv.fail("evo.frame-trailing-octets",{consumed=after-1,length=#frame}) end
  return read
end

function M.acknowledgement(frame)
  local read=M.read_frame(frame);local body=""
  if read.command=="S" or read.command=="F" then body=read.raw elseif read.command=="A" then body="Y" end
  local len=0x23+#body
  if len>0x7e then pdrv.fail("evo.acknowledgement-too-long",{bytes=#body}) end
  local command=string.byte("Y");local checksum=M.checksum(len,read.sequence,command,body)
  return string.char(SOH,len,read.sequence,command)..body..string.char(checksum,CR)
end

return M
