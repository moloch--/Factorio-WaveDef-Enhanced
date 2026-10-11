local config = require("scripts.config")
local setup_gui = require("scripts.setup_gui")

local function state()
  return storage.wave_defense_enhanced
end

local function initialize_storage()
  storage.wave_defense_enhanced = storage.wave_defense_enhanced or {}
  local saved = state()
  saved.schema_version = 2
  saved.generation_count = saved.generation_count or 0
  saved.notified_players = saved.notified_players or {}
  saved.wave = nil -- Retire the 0.1 scaffold's unused placeholder.
end

local function is_wave_defense()
  local level = script.level
  local interface = remote.interfaces.wave_defense
  local supported_level = (level.mod_name == "base" and level.level_name == "wave-defense")
    or (level.mod_name == script.mod_name and level.level_name == "wave-defense-enhanced")
  return supported_level
    and not level.is_simulation
    and not level.is_tutorial
    and interface ~= nil
    and interface.get_config ~= nil
    and interface.get_events ~= nil
end

local function equal(a, b)
  if type(a) ~= type(b) then
    return false
  end
  if type(a) ~= "table" then
    return a == b
  end
  for key, value in pairs(a) do
    if not equal(value, b[key]) then
      return false
    end
  end
  for key in pairs(b) do
    if a[key] == nil then
      return false
    end
  end
  return true
end

local function status()
  local saved = state()
  local options = config.read(settings.global)
  local applied = saved and saved.applied
  return {
    active_scenario = is_wave_defense(),
    applied = applied,
    pending = applied == nil or not equal(options, applied.options),
    next_options = options,
    generation_count = saved and saved.generation_count or 0,
  }
end

local gui_context = { active = is_wave_defense, status = status }

local function on_surface_created(event)
  if not is_wave_defense() then
    return
  end
  local surface = game.surfaces[event.surface_index]
  if not (surface and surface.valid and surface.name:match("^Surface %d+$")) then
    return
  end
  local original = surface.map_gen_settings
  local origin = original.starting_points and original.starting_points[1]
  if not origin or origin.x ~= 0 or origin.y ~= 0 then
    return
  end
  -- Vanilla creates the surface synchronously, then computes its perimeter and
  -- generates chunks. Never retrofit terrain or resize a live round's target area.
  for _ in surface.get_chunks() do
    log("[wave-defense-enhanced] skipped non-empty surface " .. surface.name)
    return
  end
  local options = config.read(settings.global)
  setup_gui.cancel_preview()
  surface.map_gen_settings = config.apply(original, options)
  local radius = surface.get_starting_area_radius()
  local base_radius = 32 * math.floor((radius / 32 - 1) / math.sqrt(2))
  local requested_chunk_radius
  if options.starting_area and options.starting_area > 2.25 then
    -- The stock preview charts only 320 tiles from spawn. At large custom sizes
    -- that can all lie inside the enemy-free area, leaving waves no spawners.
    -- Queue an outer margin, but do NOT force generation here: vanilla must first
    -- assign its new surface so its on_chunk_generated handler can find nests.
    requested_chunk_radius = math.ceil((radius + 128) / 32)
    surface.request_to_generate_chunks({ 0, 0 }, requested_chunk_radius)
  end
  local saved = state()
  saved.generation_count = saved.generation_count + 1
  saved.applied = {
    surface_index = surface.index,
    seed = surface.map_gen_settings.seed,
    starting_area = surface.map_gen_settings.starting_area,
    starting_area_radius = radius,
    base_radius = base_radius,
    perimeter_width = 2 * (base_radius + 5),
    requested_chunk_radius = requested_chunk_radius,
    options = options,
  }
  saved.notice_pending = false
  log(
    "[wave-defense-enhanced] applied before generation: "
      .. surface.name
      .. ", seed="
      .. saved.applied.seed
      .. ", starting_area="
      .. saved.applied.starting_area
      .. ", base_radius="
      .. base_radius
  )
end

script.on_init(function()
  initialize_storage()
  log("[wave-defense-enhanced] initialized")
end)
script.on_configuration_changed(function()
  initialize_storage()
  setup_gui.refresh_all(gui_context)
  if status().pending then
    setup_gui.request_preview(gui_context)
  end
end)
script.on_event(defines.events.on_surface_created, on_surface_created)
script.on_event(defines.events.on_surface_deleted, function(event)
  local saved = state()
  if saved.applied and saved.applied.surface_index == event.surface_index then
    saved.applied = nil
  end
end)
script.on_event(defines.events.on_runtime_mod_setting_changed, function(event)
  if event.setting and event.setting:match("^wde%-") and is_wave_defense() then
    -- Dialog edits get one chat notice per batch. Our sliders write settings
    -- through Lua and already show pending changes inline in the setup panel.
    if event.player_index then
      state().notice_pending = true
    end
    setup_gui.refresh_all(gui_context)
    setup_gui.request_preview(gui_context, event.player_index)
  end
end)
script.on_nth_tick(5, function()
  setup_gui.update_preview(gui_context)
end)
script.on_nth_tick(30, function()
  -- Vanilla rebuilds its unnamed preview widgets after rerolls, difficulty
  -- changes, and display changes. Reattach to the new frame when necessary.
  setup_gui.refresh_all(gui_context)
  if game.tick % 60 == 0 and state().notice_pending then
    state().notice_pending = false
    if status().pending then
      game.print({ "wave-defense-enhanced.pending" })
    end
  end
end)
script.on_event(defines.events.on_player_joined_game, function(event)
  setup_gui.refresh_all(gui_context)
  if status().pending then
    setup_gui.request_preview(gui_context, event.player_index)
  end
  if not is_wave_defense() or state().notified_players[event.player_index] then
    return
  end
  local player = game.get_player(event.player_index)
  if player then
    player.print({
      remote.interfaces.wave_defense_enhanced_preview and "wave-defense-enhanced.welcome-auto"
        or "wave-defense-enhanced.welcome",
    })
    state().notified_players[event.player_index] = true
  end
end)
script.on_event(defines.events.on_player_removed, function(event)
  setup_gui.remove_player(event.player_index)
  state().notified_players[event.player_index] = nil
end)
script.on_event({
  defines.events.on_player_display_resolution_changed,
  defines.events.on_player_display_scale_changed,
  defines.events.on_player_promoted,
  defines.events.on_player_demoted,
  defines.events.on_player_changed_force,
}, function(event)
  -- These native handlers rebuild Start as enabled for admins. Restore the
  -- pending-settings guard within the same event, before another input arrives.
  setup_gui.refresh_all(gui_context)
  if event.name == defines.events.on_player_promoted and status().pending then
    setup_gui.request_preview(gui_context, event.player_index)
  end
end)
script.on_event({
  defines.events.on_gui_click,
  defines.events.on_gui_checked_state_changed,
  defines.events.on_gui_value_changed,
  defines.events.on_gui_text_changed,
  defines.events.on_gui_confirmed,
  defines.events.on_gui_selection_state_changed,
}, function(event)
  setup_gui.handle_event(event, gui_context)
end)
commands.add_command("wde-status", { "wave-defense-enhanced.command-help" }, function(command)
  local player = command.player_index and game.get_player(command.player_index)
  local function reply(message)
    if player then
      player.print(message)
    else
      rcon.print(message)
    end
  end
  local current = status()
  if not current.active_scenario then
    reply({ "wave-defense-enhanced.inactive" })
    return
  end
  if current.applied then
    local applied = current.applied
    reply({
      "wave-defense-enhanced.status",
      applied.seed,
      applied.starting_area * 100,
      applied.perimeter_width,
      { "string-mod-setting.wde-resource-preset-" .. applied.options.preset },
    })
    reply({ "wave-defense-enhanced.water-status", (applied.options.water_amount or 1) * 100 })
    reply({
      "wave-defense-enhanced.terrain-status",
      (applied.options.tree_coverage or 1) * 100,
      (applied.options.cliff_density or 1) * 100,
    })
  else
    reply({ "wave-defense-enhanced.not-applied" })
  end
  if current.pending then
    reply({ "wave-defense-enhanced.pending" })
  end
end)

-- Read-only diagnostics; scenario state and regeneration remain owned by vanilla.
remote.add_interface("wave_defense_enhanced", { get_status = status })
