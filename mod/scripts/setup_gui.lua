local config = require("scripts.config")

local gui = {}
local prefix = "wde_setup_"
local dimensions = { "frequency", "size", "richness" }
local presets = { "wave-defense", "freeplay", "custom" }
local area_modes = { "difficulty", "custom" }
local changing_settings = false

local function saved_players()
  storage.wde_setup_gui = storage.wde_setup_gui or { players = {} }
  return storage.wde_setup_gui.players
end

local function valid(element)
  return element and element.valid
end

local function caption_is(element, key)
  local caption = element.caption
  return type(caption) == "table" and caption[1] == key
end

-- Vanilla elements have no names. Match their owner, caption and hierarchy;
-- never claim another mod's setup window or controls.
local function find_native(player)
  for _, frame in pairs(player.gui.screen.children) do
    if
      frame.type == "frame"
      and frame.get_mod() == nil
      and frame.name == ""
      and caption_is(frame, "setup-frame")
      and frame.visible
    then
      local found = { frame = frame }
      local function visit(parent)
        for _, child in pairs(parent.children) do
          if child.get_mod() == nil then
            if child.type == "minimap" then
              found.minimap = child
            elseif child.type == "button" and caption_is(child, "start-round") then
              found.start = child
            elseif child.type == "textfield" then
              for _, sibling in pairs(child.parent.children) do
                if
                  sibling.type == "label" and caption_is(sibling, "gui-map-generator.map-seed")
                then
                  found.seed = child
                end
              end
            end
            visit(child)
          end
        end
      end
      visit(frame)
      local minimap, start = found.minimap, found.start
      if
        minimap
        and start
        and minimap.parent.type == "flow"
        and minimap.parent.parent.type == "frame"
        and minimap.parent.parent.parent == frame
        and start.parent.parent == frame
      then
        found.inner = minimap.parent
        return found
      end
    end
  end
end

local function index_of(values, value)
  for index, candidate in ipairs(values) do
    if candidate == value then
      return index
    end
  end
  return 1
end

local function percent_text(value)
  return string.format("%.10g", value)
end

local function layout(player)
  local width = math.floor(player.display_resolution.width / player.display_scale)
  local height = math.floor(player.display_resolution.height / player.display_scale)
  local stacked = width < 1050
  local available_height = math.max(280, height - 260)
  local controls = stacked and math.max(300, math.min(792, width - 80)) or 792
  local panel_height = stacked and math.floor(available_height * 0.58)
    or math.min(620, available_height)
  local preview = stacked
      and math.max(120, math.min(width - 100, available_height - panel_height - 12))
    or math.max(160, math.min(500, width - controls - 100, available_height))
  return {
    controls = controls,
    preview = preview,
    height = panel_height,
    stacked = stacked,
  }
end

local function label(parent, key, style)
  return parent.add({ type = "label", caption = { "wde-setup." .. key }, style = style })
end

local function add_number(parent, saved, setting, minimum, maximum, tags, slider_width)
  local flow = parent.add({ type = "flow", direction = "horizontal" })
  flow.style.vertical_align = "center"
  flow.style.horizontal_spacing = 8
  flow.style.minimal_height = 36
  local slider = flow.add({
    type = "slider",
    name = prefix .. setting .. "_slider",
    minimum_value = minimum,
    maximum_value = maximum,
    value = minimum,
    value_step = 1,
    discrete_values = true,
    tags = tags,
  })
  slider.style.width = slider_width
  local field = flow.add({
    type = "textfield",
    name = prefix .. setting .. "_field",
    text = tostring(minimum),
    numeric = true,
    allow_decimal = true,
    allow_negative = false,
    style = "short_number_textfield",
    tags = tags,
  })
  field.style.width = 60
  field.tooltip = { "wde-setup.percentage-range", minimum, maximum }
  flow.add({ type = "label", caption = "%" }).style.width = 16
  saved.numbers[setting] = {
    slider = slider,
    field = field,
    minimum = minimum,
    maximum = maximum,
    resource = tags.resource,
    dimension = tags.dimension,
  }
end

local function build(player, native, previous, sizes)
  if previous and valid(previous.body) then
    previous.body.destroy()
  end
  local saved = {
    native = native,
    invalid = previous and previous.invalid or {},
    typed = previous and previous.typed or {},
    numbers = {},
    checks = {},
    sizes = sizes,
  }
  local body = native.inner.add({
    type = "flow",
    name = prefix .. "body",
    direction = "vertical",
  })
  body.style.vertical_spacing = 12
  saved.body = body
  local content = body.add({
    type = "flow",
    direction = sizes.stacked and "vertical" or "horizontal",
  })
  if sizes.stacked then
    content.style.vertical_spacing = 12
  else
    content.style.horizontal_spacing = 12
  end
  content.style.vertical_align = "top"
  local panel = content.add({
    type = "scroll-pane",
    name = prefix .. "controls",
    horizontal_scroll_policy = "auto",
    vertical_scroll_policy = "auto",
  })
  panel.style.width = sizes.controls
  panel.style.height = sizes.height
  panel.style.padding = 16
  local controls = panel.add({ type = "flow", direction = "vertical" })
  controls.style.vertical_spacing = 10
  label(controls, "resources", "caption_label")
  local preset_flow = controls.add({ type = "flow", direction = "horizontal" })
  preset_flow.style.vertical_align = "center"
  preset_flow.style.horizontal_spacing = 12
  label(preset_flow, "preset")
  saved.preset = preset_flow.add({
    type = "drop-down",
    name = prefix .. "preset",
    tags = { kind = "preset" },
    items = { { "wde-setup.wave-defense" }, { "wde-setup.freeplay" }, { "wde-setup.custom" } },
  })
  saved.preset.style.width = 220
  local resource_table = controls.add({ type = "table", column_count = 4 })
  resource_table.style.horizontal_spacing = 12
  resource_table.style.vertical_spacing = 12
  label(resource_table, "resource")
  for _, dimension in ipairs(dimensions) do
    label(resource_table, dimension)
  end
  -- Fixed cell sizes prevent labels, slider handles and percentage fields from
  -- colliding. Narrow windows scroll these columns instead of squeezing them.
  local slider_width = 80
  for _, resource in ipairs(config.resource_names) do
    local row = resource_table.add({ type = "flow", direction = "horizontal" })
    row.style.width = 176
    row.style.minimal_height = 36
    row.style.vertical_align = "center"
    row.style.horizontal_spacing = 8
    local icon =
      row.add({ type = "sprite", sprite = "entity/" .. resource, resize_to_sprite = false })
    icon.style.width = 24
    icon.style.height = 24
    saved.checks[resource] = row.add({
      type = "checkbox",
      name = prefix .. resource .. "_enabled",
      state = true,
      caption = { "entity-name." .. resource },
      tooltip = { "wde-setup.resource-enabled" },
      tags = { kind = "enabled", resource = resource },
    })
    for _, dimension in ipairs(dimensions) do
      local setting = "wde-" .. resource .. "-" .. dimension
      add_number(
        resource_table,
        saved,
        setting,
        1,
        600,
        { kind = "resource", resource = resource, dimension = dimension, setting = setting },
        slider_width
      )
    end
  end
  controls.add({ type = "line" }).style.horizontally_stretchable = true
  label(controls, "starting-area", "caption_label")
  local area_flow = controls.add({ type = "flow", direction = "horizontal" })
  area_flow.style.vertical_align = "center"
  saved.area_mode = area_flow.add({
    type = "drop-down",
    name = prefix .. "area_mode",
    tags = { kind = "area-mode" },
    items = { { "wde-setup.follow-difficulty" }, { "wde-setup.custom" } },
  })
  saved.area_mode.style.width = 220
  local area_value_flow = controls.add({ type = "flow", direction = "horizontal" })
  area_value_flow.style.vertical_align = "center"
  area_value_flow.style.horizontal_spacing = 12
  label(area_value_flow, "size")
  add_number(
    area_value_flow,
    saved,
    "wde-starting-area-size",
    100,
    300,
    { kind = "area-size", setting = "wde-starting-area-size" },
    200
  )
  saved.area_hint = label(controls, "difficulty-area")
  saved.area_hint.style.single_line = false
  saved.area_hint.style.maximal_width = sizes.controls - 40
  saved.read_only = label(controls, "read-only")
  saved.read_only.style.single_line = false
  saved.read_only.style.maximal_width = sizes.controls - 40
  saved.validation = label(controls, "invalid-values")
  saved.validation.style.single_line = false
  saved.validation.style.maximal_width = sizes.controls - 40
  saved.validation.style.font_color = { 1, 0.45, 0.35 }
  saved.discard = controls.add({
    type = "button",
    name = prefix .. "discard_invalid",
    caption = { "wde-setup.discard-invalid" },
    tags = { kind = "discard" },
  })
  -- Keep the regeneration instruction visible even when resource rows scroll.
  saved.notice = label(body, "preview-current")
  saved.notice.style.single_line = false
  saved.notice.style.maximal_width = sizes.stacked and sizes.controls - 32
    or sizes.controls + sizes.preview - 20
  saved.notice.style.left_margin = 16
  saved.notice.style.bottom_margin = 8
  local preview = content.add({
    type = "minimap",
    name = prefix .. "preview",
    surface_index = native.minimap.surface_index,
    position = native.minimap.position,
    force = player.force.name,
    zoom = native.minimap.zoom * sizes.preview / math.max(1, native.minimap.style.natural_width),
  })
  preview.style.width = sizes.preview
  preview.style.height = sizes.preview
  saved.preview = preview
  native.minimap.visible = false
  if native.seed then
    native.seed.tooltip = { "wde-setup.seed-help" }
  end
  native.frame.force_auto_center()
  return saved
end

local function sync_number(saved, setting, value, enabled)
  local pair = saved.numbers[setting]
  pair.slider.enabled = enabled
  pair.field.enabled = enabled
  pair.slider.slider_value = value
  local invalid = saved.invalid[setting]
  pair.field.style = invalid and "invalid_value_short_number_textfield" or "short_number_textfield"
  pair.field.style.width = 60
  -- Keep an unfinished invalid field visible; it never changes shared settings.
  local typed = saved.typed[setting]
  if typed and math.abs(typed.value - value) > 0.0000001 then
    saved.typed[setting] = nil
    typed = nil
  end
  -- Retain e.g. "125." while typing the next digit. The valid number is already
  -- committed; this text is presentation only, not a delayed settings draft.
  local text = invalid or (typed and typed.text) or percent_text(value)
  if pair.field.text ~= text then
    pair.field.text = text
  end
  pair.field.tooltip = invalid and { "wde-setup.invalid-range", pair.minimum, pair.maximum }
    or { "wde-setup.percentage-range", pair.minimum, pair.maximum }
end

local function sync(player, saved, current)
  local options = current.next_options
  saved.preset.selected_index = index_of(presets, options.preset)
  saved.preset.enabled = player.admin
  saved.area_mode.selected_index = index_of(area_modes, options.starting_area_mode)
  saved.area_mode.enabled = player.admin
  for _, resource in ipairs(config.resource_names) do
    local resolved = options.resources[resource]
    saved.checks[resource].state = resolved.enabled
    saved.checks[resource].enabled = player.admin
    for _, dimension in ipairs(dimensions) do
      sync_number(
        saved,
        "wde-" .. resource .. "-" .. dimension,
        resolved[dimension] * 100,
        player.admin and resolved.enabled
      )
    end
  end
  sync_number(
    saved,
    "wde-starting-area-size",
    settings.global["wde-starting-area-size"].value,
    player.admin and options.starting_area_mode == "custom"
  )
  saved.area_hint.visible = options.starting_area_mode == "difficulty"
  saved.read_only.visible = not player.admin
  local invalid = next(saved.invalid) ~= nil
  saved.validation.visible = invalid
  saved.discard.visible = invalid and player.admin
  saved.notice.caption = current.pending and { "wde-setup.preview-pending" }
    or { "wde-setup.preview-current" }
  saved.notice.style.font_color = current.pending and { 1, 0.8, 0.3 } or { 0.7, 0.85, 0.7 }
  saved.native.start.enabled = player.admin and not current.pending and not invalid
  saved.native.start.tooltip = current.pending and { "wde-setup.preview-pending" }
    or invalid and { "wde-setup.invalid-values" }
    or { "wde-setup.start-ready" }
end

local function refresh_player(player, current)
  local players = saved_players()
  local native = find_native(player)
  local saved = players[player.index]
  if native then
    local sizes = layout(player)
    if
      not saved
      or not valid(saved.body)
      or saved.native.frame ~= native.frame
      or saved.sizes.controls ~= sizes.controls
      or saved.sizes.preview ~= sizes.preview
      or saved.sizes.height ~= sizes.height
      or saved.sizes.stacked ~= sizes.stacked
    then
      saved = build(player, native, saved, sizes)
      players[player.index] = saved
    end
    sync(player, saved, current)
  elseif saved then
    if valid(saved.body) then
      saved.body.destroy()
    end
    players[player.index] = nil
  end
end

function gui.refresh_player(player, context)
  if changing_settings or not context.active() or not (player and player.valid) then
    return
  end
  refresh_player(player, context.status())
end

function gui.refresh_all(context)
  if changing_settings or not context.active() then
    return
  end
  local current = context.status()
  for _, player in pairs(game.connected_players) do
    refresh_player(player, current)
  end
end

local function disable_starts()
  changing_settings = true
  for _, saved in pairs(saved_players()) do
    if valid(saved.native.start) then
      saved.native.start.enabled = false
    end
  end
end

local function set_setting(name, value)
  if settings.global[name].value ~= value then
    settings.global[name] = { value = value }
  end
end

local function seed_custom(options)
  if options.preset == "custom" then
    return
  end
  for _, resource in ipairs(config.resource_names) do
    for _, dimension in ipairs(dimensions) do
      set_setting(
        "wde-" .. resource .. "-" .. dimension,
        options.resources[resource][dimension] * 100
      )
    end
  end
  set_setting("wde-resource-preset", "custom")
end

function gui.handle_event(event, context)
  if not context.active() then
    return false
  end
  local element = event.element
  if
    not valid(element)
    or element.get_mod() ~= script.mod_name
    or element.name:sub(1, #prefix) ~= prefix
  then
    -- Vanilla handles its events first and may have destroyed every descendant.
    gui.refresh_all(context)
    return false
  end
  local player = game.get_player(event.player_index)
  local saved = saved_players()[event.player_index]
  if not player or not player.admin or not saved or not element.enabled then
    gui.refresh_all(context)
    return false
  end
  local tags = element.tags
  local kind = tags.kind
  local options = context.status().next_options
  if kind == "resource" or kind == "area-size" then
    local pair = saved.numbers[tags.setting]
    if not pair or (element ~= pair.slider and element ~= pair.field) then
      return false
    end
    if
      event.name ~= defines.events.on_gui_value_changed
      and event.name ~= defines.events.on_gui_text_changed
      and event.name ~= defines.events.on_gui_confirmed
    then
      return false
    end
    local value = element.type == "slider" and element.slider_value or tonumber(element.text)
    if not value or value ~= value or value < pair.minimum or value > pair.maximum then
      saved.invalid[tags.setting] = element.text
      gui.refresh_all(context)
      return true
    end
    saved.invalid[tags.setting] = nil
    saved.typed[tags.setting] = event.name == defines.events.on_gui_text_changed
        and { text = element.text, value = value }
      or nil
    disable_starts()
    if kind == "resource" then
      seed_custom(options)
    end
    set_setting(tags.setting, value)
  elseif kind == "enabled" and event.name == defines.events.on_gui_checked_state_changed then
    if saved.checks[tags.resource] ~= element then
      return false
    end
    disable_starts()
    set_setting("wde-" .. tags.resource .. "-enabled", element.state)
  elseif kind == "preset" and event.name == defines.events.on_gui_selection_state_changed then
    local preset = presets[element.selected_index]
    if not preset then
      return false
    end
    disable_starts()
    if preset == "custom" then
      seed_custom(options)
    else
      set_setting("wde-resource-preset", preset)
    end
    saved.invalid = {}
    saved.typed = {}
  elseif kind == "area-mode" and event.name == defines.events.on_gui_selection_state_changed then
    local mode = area_modes[element.selected_index]
    if not mode then
      return false
    end
    disable_starts()
    set_setting("wde-starting-area-mode", mode)
  elseif kind == "discard" and event.name == defines.events.on_gui_click then
    saved.invalid = {}
  else
    return false
  end
  changing_settings = false
  gui.refresh_all(context)
  return true
end

function gui.remove_player(index)
  if storage.wde_setup_gui then
    local saved = storage.wde_setup_gui.players[index]
    if saved and valid(saved.body) then
      saved.body.destroy()
    end
    storage.wde_setup_gui.players[index] = nil
  end
end

return gui
