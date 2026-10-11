local config = require("scripts.config")

local prototypes = {
  {
    type = "string-setting",
    name = "wde-resource-preset",
    setting_type = "runtime-global",
    default_value = "wave-defense",
    allowed_values = { "wave-defense", "freeplay", "custom" },
    order = "a[resources]-a[preset]",
  },
  {
    type = "string-setting",
    name = "wde-starting-area-mode",
    setting_type = "runtime-global",
    default_value = "difficulty",
    allowed_values = { "difficulty", "custom" },
    order = "b[starting-area]-a[mode]",
  },
  {
    type = "double-setting",
    name = "wde-starting-area-size",
    setting_type = "runtime-global",
    default_value = 175,
    minimum_value = 100,
    maximum_value = 300,
    order = "b[starting-area]-b[size]",
  },
}

local dimensions = { "frequency", "size", "richness" }
for index, name in ipairs(config.resource_names) do
  local order = "a[resources]-b[" .. index .. "-" .. name .. "]-"
  prototypes[#prototypes + 1] = {
    type = "bool-setting",
    name = "wde-" .. name .. "-enabled",
    setting_type = "runtime-global",
    default_value = true,
    order = order .. "a[enabled]",
  }

  for dimension_index, dimension in ipairs(dimensions) do
    prototypes[#prototypes + 1] = {
      type = "double-setting",
      name = "wde-" .. name .. "-" .. dimension,
      setting_type = "runtime-global",
      default_value = config.wave_defense_defaults[name][dimension] * 100,
      minimum_value = 1,
      maximum_value = 600,
      order = order .. "b[" .. dimension_index .. "-" .. dimension .. "]",
    }
  end
end

data:extend(prototypes)
