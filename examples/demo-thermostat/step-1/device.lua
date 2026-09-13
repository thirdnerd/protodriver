-- Step 1: a public description, not a working thermostat driver.
local array = pdrv.array
local availability = {modes=array({"thermostat"}), profiles=array({"serial"})}
local temperature = {kind="integer", widthBits=16, signed=true, minimum=500, maximum=3500,
  unit={kind="fixed", id="centidegree-celsius"}}

return {
  apiVersion="device/v2", id="demobench-thermostat", displayName="DemoBench thermostat",
  modes=array({"thermostat"}), profiles=array({"serial"}),
  connectionProfiles={serial={modes=array({"thermostat"}),
    acquisitionFilters=array({{transport="serial", vendorId=0x1209, productId=0xd001}}),
    transport={kind="serial", baudRate=9600, dataBits=8, parity="none", stopBits=1,
      flowControl="none"},
    channels=array({{id="main", protocolDuplex="half-duplex"}}),
    lifecycle={openingDrainQuietMs=0, postTerminationSilence={minimumMs=0,
      afterAbnormalTermination=false, afterModeExit=false}}}},
  operations=array({
    {id="read_status", title="Read status", binding="not_implemented", arguments={},
      result={kind="value", type={kind="record", fields={
        sequence={kind="integer", widthBits=32, signed=true, minimum=1, maximum=2147483647},
        temperature_centi_c=temperature, target_centi_c=temperature,
        heater={kind="enum", members=array({"on", "off"})}}}},
      risk="read-only", repeatability="safe-to-repeat", locks=array({"protocol"}),
      availability=availability, requires=array({})},
    {id="set_target", title="Set target", binding="not_implemented",
      arguments={target_centi_c=temperature},
      result={kind="value", type={kind="record", fields={target_centi_c=temperature}}},
      risk="destructive", repeatability="not-repeatable", locks=array({"protocol"}),
      availability=availability, requires=array({})},
  }),
}, {
  not_implemented=function()
    pdrv.fail("demo-thermostat.not-implemented", {})
  end,
}
