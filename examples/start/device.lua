-- This source set is ready for packaging and generated help. It is not a
-- physical-device driver yet: it contains no acquisition or protocol facts.
local array = pdrv.array

-- PLACEHOLDER: replace these three identifiers with names for your device,
-- mode and connection profile before adding device-specific behavior.
local device_id = "replace-with-device-id"
local mode_id = "replace-with-mode-id"
local profile_id = "replace-with-profile-id"

local declaration = {
  apiVersion = "device/v2",
  id = device_id,
  displayName = "Blank device starting point",
  modes = array({mode_id}),
  profiles = array({profile_id}),

  -- PLACEHOLDER BOUNDARY: there is deliberately no connectionProfiles record.
  -- Before any hardware run, add one using only your device's measured
  -- acquisition identifiers, serial settings or USB interface/endpoints.
  -- Do not copy those values from a worked example as if they were defaults.
  operations = array({
    {
      id = "draft_operation",
      title = "Draft operation",
      description = "Declaration-only starting point; no device protocol is implemented.",
      binding = "not_implemented",
      arguments = {},
      result = {kind = "none"},
      risk = "read-only",
      repeatability = "safe-to-repeat",
      locks = array({}),
      availability = {
        modes = array({mode_id}),
        profiles = array({profile_id}),
      },
      requires = array({}),
    },
  }),
}

local bindings = {
  not_implemented = function()
    -- This explicit failure prevents the blank shape from claiming a device
    -- result if a host embedding supplies acquisition despite the omission above.
    pdrv.fail("blank.protocol-not-implemented", {})
  end,
}

return declaration, bindings
