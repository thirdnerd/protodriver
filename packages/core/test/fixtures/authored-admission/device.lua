local integer={kind="integer",widthBits=16.0,signed=false,minimum=0.0,maximum=5000.0,unit={kind="fixed",id="millivolt"}}
local record={kind="record",fields={
  status={kind="enum",members=pdrv.array({"ready","busy"})},
  readings={kind="array",minimumLength=1.0,maximumLength=2.0,item={kind="record",fields={voltage=integer}}},
  detail={kind="variant",variants={ok={kind="record",fields={verified={kind="boolean"}}}}}
}}
local operations={}
for _,id in ipairs({"record","wrong-result","static-control","dynamic-control","invalid-control","none"}) do
  operations[#operations+1]={id=id,title=id,binding=id,
    arguments=id=="record" and {voltage=integer} or {},
    result=id=="none" and {kind="none"} or {kind="value",type=(id=="record" or id=="wrong-result") and record or {kind="string"}},
    risk="changes-state",repeatability="not-repeatable",locks=pdrv.array({"channel"}),
    availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},
    requires=pdrv.array(id=="static-control" and {"usb.control"} or {})}
end
local function result(voltage)
  return {status="ready",readings=pdrv.array({{voltage=voltage}}),detail=pdrv.variant("ok",{verified=true})}
end
return {apiVersion="device/v2",id="authored-admission-fixture",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),operations=pdrv.array(operations)}, {
  record=function(args,io) io.request({kind="write",value="VISIBLE"}); return result(args.voltage) end,
  ["wrong-result"]=function(args,io) io.request({kind="write",value="VISIBLE"}); return result("not-an-integer") end,
  ["static-control"]=function(args,io) io.request({kind="write",value="MUST-NOT-START"}); return "started" end,
  ["dynamic-control"]=function(args,io) return io.request({kind="control",setup={direction="device-to-host",requestType="vendor",recipient="device",request=1.0,value=0.0,index=0.0,length=2.0},payload=pdrv.array({})}) end,
  ["invalid-control"]=function(args,io) return io.request({kind="control",setup={direction="invalid",requestType="vendor",recipient="device",request=1.0,value=0.0,index=0.0,length=2.0},payload=pdrv.array({})}) end,
  none=function(args,io) io.request({kind="write",value="NO-RESULT"}) end,
}
