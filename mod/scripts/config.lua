local config = {}

config.resource_names = { "iron-ore", "copper-ore", "coal", "stone", "uranium-ore", "crude-oil" }
config.terrain_controls = {
  { name = "water-amount", option = "water_amount" },
  { name = "tree-coverage", option = "tree_coverage" },
  { name = "cliff-density", option = "cliff_density" },
}
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

  -- Omit default overrides so older applied snapshots still compare equal
  -- and the scenario's original terrain settings remain untouched at 100%.
  for _, control in ipairs(config.terrain_controls) do
    local value = percentage(global_settings, "wde-" .. control.name, 100, 0, 600)
    if value ~= 1 then
      options[control.option] = value
    end
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

  if options.tree_coverage ~= nil then
    local trees = result.autoplace_controls.trees or {}
    trees.size = (trees.size or 1) * options.tree_coverage
    result.autoplace_controls.trees = trees
  end

  if options.cliff_density ~= nil then
    local cliffs = result.cliff_settings or {}
    -- Richness fills gaps along the existing elevation contours. Keep their
    -- spacing and starting elevation intact while changing cliff density.
    cliffs.richness = (cliffs.richness or 1) * options.cliff_density
    result.cliff_settings = cliffs
  end

  if options.water_amount ~= nil then
    local expressions = result.property_expression_names or {}
    -- Retain the scenario's island/infinite generator underneath the water
    -- adjustment. The wrapper leaves the central spawn dry when adding water.
    expressions.wde_original_elevation = expressions.elevation or "elevation_nauvis"
    expressions.wde_water_amount = tostring(options.water_amount)
    expressions.elevation = "wde_water_elevation"
    result.property_expression_names = expressions
  end

  return result
end

return config
