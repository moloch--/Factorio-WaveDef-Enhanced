local config = {}

config.resource_names = { "iron-ore", "copper-ore", "coal", "stone", "uranium-ore", "crude-oil" }
config.wave_defense_defaults = {
  ["iron-ore"] = { frequency = 1, size = 2, richness = 2 },
  ["copper-ore"] = { frequency = 1, size = 2, richness = 2 },
  coal = { frequency = 1, size = 2, richness = 2 },
  stone = { frequency = 1, size = 2, richness = 2 },
  ["uranium-ore"] = { frequency = 3, size = 0.5, richness = 2 },
  ["crude-oil"] = { frequency = 2, size = 2, richness = 2 },
}

local dimensions = { "frequency", "size", "richness" }

local function clone(value)
  if type(value) ~= "table" then
    return value
  end

  local result = {}
  for key, child in pairs(value) do
    result[key] = clone(child)
  end
  return result
end

local function setting_value(global_settings, name, default)
  local setting = global_settings and global_settings[name]
  if type(setting) == "table" then
    setting = setting.value
  end
  if type(setting) ~= type(default) then
    return default
  end
  return setting
end

local function percentage(global_settings, name, default, minimum, maximum)
  local value = setting_value(global_settings, name, default)
  if value ~= value or value == math.huge or value == -math.huge then
    value = default
  end
  return math.max(minimum, math.min(maximum, value)) / 100
end

-- Accepts settings.global or a plain table of setting values; no runtime globals are used.
function config.read(global_settings)
  local preset = setting_value(global_settings, "wde-resource-preset", "wave-defense")
  if preset ~= "wave-defense" and preset ~= "freeplay" and preset ~= "custom" then
    preset = "wave-defense"
  end

  local area_mode = setting_value(global_settings, "wde-starting-area-mode", "difficulty")
  if area_mode ~= "difficulty" and area_mode ~= "custom" then
    area_mode = "difficulty"
  end

  local options = {
    preset = preset,
    starting_area_mode = area_mode,
    resources = {},
  }

  if area_mode == "custom" then
    options.starting_area = percentage(global_settings, "wde-starting-area-size", 175, 100, 300)
  end

  for _, name in ipairs(config.resource_names) do
    local resource = {
      enabled = setting_value(global_settings, "wde-" .. name .. "-enabled", true),
    }
    for _, dimension in ipairs(dimensions) do
      local default = config.wave_defense_defaults[name][dimension]
      if preset == "freeplay" then
        resource[dimension] = 1
      elseif preset == "custom" then
        resource[dimension] =
          percentage(global_settings, "wde-" .. name .. "-" .. dimension, default * 100, 1, 600)
      else
        resource[dimension] = default
      end
    end
    options.resources[name] = resource
  end

  return options
end

-- Produces a fresh map-settings table without changing unrelated controls or fields.
function config.apply(map_gen_settings, options)
  local result = clone(map_gen_settings or {})
  result.autoplace_controls = result.autoplace_controls or {}

  for _, name in ipairs(config.resource_names) do
    local resource = options.resources[name]
    local control = result.autoplace_controls[name] or {}
    for _, dimension in ipairs(dimensions) do
      control[dimension] = resource.enabled and resource[dimension] or 0
    end
    result.autoplace_controls[name] = control
  end

  if options.starting_area ~= nil then
    result.starting_area = options.starting_area
  end

  return result
end

return config
