local byteString={kind="bytes",maximumLength=64.0}
local number={kind="integer",widthBits=16.0,signed=false}
local operations={}
local invalidatedGeneration
for _,id in ipairs({"file","resource","wrong-id","too-short","too-long","zero","forget","advance","wrong-state","cycle","advance-day","unaged-zero","unaged-forget"}) do
  local output=id=="file" or id=="resource" or id=="wrong-id" or id=="too-short" or id=="too-long"
  local result=output and {kind=id=="file" and "file" or "resource",direction="out",content="Measured binary sample",
    mediaType="application/octet-stream",minimumBytes=3.0,maximumBytes=3.0} or {kind="none"}
  if id=="file" then result.suggestedExtension="bin" end
  operations[#operations+1]={id=id,title=id,binding=id,arguments=output and {payload=byteString} or {},result=result,
    risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"channel","state"}),
    availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}
end
local function output(args,io)
  io.request({kind="resource-write",resource=io.resultDestination,value=args.payload})
  return io.resultDestination
end
local function publish(io,quality,value) io.request({kind="state-publish",cell="reading",quality=quality,value=value}) end
return {apiVersion="device/v2",id="authored-k-fixture",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array(operations),
  entry={binding="entry",locks=pdrv.array({"channel"}),requires=pdrv.array({"channel.write"})},invalidation="invalidated",
  state={reading={type=number,freshForMs=10.0,refresh="zero"},boot={type={kind="boolean"},freshForMs=pdrv.null}}}, {
  entry=function(args,io)
    io.request({kind="write",value="ENTRY"})
    io.request({kind="state-publish",cell="boot",quality="valid",value=true})
  end,
  invalidated=function(generation) invalidatedGeneration=generation end,
  file=output,resource=output,["too-long"]=output,
  ["wrong-id"]=function(args,io) output(args,io); return "invented-output" end,
  ["too-short"]=function(args,io) return io.resultDestination end,
  zero=function(args,io) publish(io,"valid",0) end,
  forget=function(args,io) publish(io,"unknown",pdrv.null) end,
  advance=function(args,io) io.request({kind="write",value="ADVANCE"}) end,
  ["advance-day"]=function(args,io) io.request({kind="write",value="ADVANCE-DAY"}) end,
  ["unaged-zero"]=function(args,io) io.request({kind="state-publish",cell="boot",quality="valid",value=true}) end,
  ["unaged-forget"]=function(args,io) io.request({kind="state-publish",cell="boot",quality="unknown",value=pdrv.null}) end,
  ["wrong-state"]=function(args,io) publish(io,"valid","zero") end,
  cycle=function(args,io)
    local grant=io.request({kind="connection-grant"})
    io.request({kind="connection-close",connection=grant:match("^([^|]+)")})
    if not invalidatedGeneration then error("invalidation binding was not delivered") end
    io.request({kind="connection-reacquire"})
  end,
}
