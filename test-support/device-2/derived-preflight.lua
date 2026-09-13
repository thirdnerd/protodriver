-- Derived-validity diagnostic, NOT a migrated device-2 driver.
local modes, profiles = pdrv.array({"interactive"}), pdrv.array({"serial"})
local rate = {kind="integer",widthBits=16,signed=false,minimum=10,maximum=5000}
local slowest
local function operation(id, arguments)
  return {id=id,title=id,binding=id,arguments=arguments,result={kind="none"},
    risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({"protocol"}),
    availability={modes=modes,profiles=profiles},requires=pdrv.array({"channel.read"})}
end
return {
  apiVersion="device/v2",id="device-2-derived-preflight",modes=modes,profiles=profiles,
  state={
    sample_rate_ms={type=rate,freshForMs=5500},
    sample_rate_is_slowest={type={kind="boolean"},freshForMs=pdrv.null,dependsOn=pdrv.array({"sample_rate_ms"})},
  },
  operations=pdrv.array({
    operation("observe",{line={kind="string",maximumLength=6},suspend={kind="boolean"}}),
    operation("mark",{quality={kind="enum",members=pdrv.array({"stale","unknown"})}}),
    operation("barrier",{}),
  }),
}, {
  observe=function(args,io)
    local milliseconds=assert(tonumber(args.line:match("^(%d+)\r\n$")))
    assert(milliseconds>=10 and milliseconds<=5000)
    io.request({kind="state-publish",cell="sample_rate_ms",quality="valid",value=milliseconds})
    -- Synthetic one-byte gate models elapsed time between ordered effects;
    -- it is not a device reply or an alarm-routing implementation.
    if args.suspend then assert(io.request({kind="read",maximum=1})=="!") end
    slowest=milliseconds==5000
    io.request({kind="state-publish",cell="sample_rate_is_slowest",value=slowest})
  end,
  mark=function(args,io)
    local value=slowest
    if args.quality=="unknown" then value=pdrv.null end
    io.request({kind="state-publish",cell="sample_rate_is_slowest",quality=args.quality,value=value})
  end,
  barrier=function() end,
}
