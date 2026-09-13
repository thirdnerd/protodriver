return {
  apiVersion="device/v2",id="vm-diagnostics",modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"}),
  operations=pdrv.array({{id="run",title="Run",binding="run",
    arguments={case={kind="enum",members=pdrv.array({"fuel","allocation","named","program","host"})}},
    result={kind="value",type={kind="string"}},risk="changes-state",repeatability="not-repeatable",
    locks=pdrv.array({"channel"}),availability={modes=pdrv.array({"main"}),profiles=pdrv.array({"serial"})},requires=pdrv.array({})}})
}, {run=function(args,io)
  if args.case=="fuel" then
    pcall(function() while true do end end)
  elseif args.case=="allocation" then
    pcall(function() return string.rep("x",33554432) end)
  elseif args.case=="named" then
    pdrv.fail("fuel-exhausted",{origin="author"})
  elseif args.case=="program" then
    error("lua-vm.resource.fuel-exhausted: misleading author prose")
  else
    io.request({kind="write",value="HOST-FAULT"})
  end
  return "caught-and-continued"
end}
