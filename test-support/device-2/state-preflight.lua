-- State-shape diagnostic, NOT the migrated four-operation device-2 module.
local timeless = pdrv.null
local modes, profiles = pdrv.array({"interactive"}), pdrv.array({"serial"})
local channel = {kind="enum",members=pdrv.array({"CH1","CH2"})}
local level = {kind="enum",members=pdrv.array({"HIGH","LOW"})}
return {
  apiVersion="device/v2",id="device-2-state-preflight",modes=modes,profiles=profiles,
  state={
    sample_rate_ms={type={kind="integer",widthBits=16,signed=false,minimum=10,maximum=5000},freshForMs=5500},
    alarm_channel={type=channel,freshForMs=timeless},
    alarm_level={type=level,freshForMs=timeless},
    sample_rate_is_slowest={type={kind="boolean"},freshForMs=timeless},
  },
  operations=pdrv.array({{
    id="publish",title="Observe state expiry",binding="publish",arguments={channel=channel,level=level},
    result={kind="none"},risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({}),
    availability={modes=modes,profiles=profiles},requires=pdrv.array({}),
  },{
    id="barrier",title="Settle earlier state work",binding="barrier",arguments={},
    result={kind="none"},risk="read-only",repeatability="safe-to-repeat",locks=pdrv.array({}),
    availability={modes=modes,profiles=profiles},requires=pdrv.array({}),
  }}),
}, {
  barrier=function() end,
  publish=function(args,io)
    io.request({kind="state-publish",cell="alarm_channel",quality="valid",value=args.channel})
    io.request({kind="state-publish",cell="alarm_level",quality="valid",value=args.level})
    io.request({kind="state-publish",cell="sample_rate_ms",quality="valid",value=100})
    io.request({kind="state-publish",cell="sample_rate_is_slowest",quality="valid",value=false})
  end,
}
