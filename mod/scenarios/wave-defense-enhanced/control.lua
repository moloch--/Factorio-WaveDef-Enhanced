-- Keep the game's Wave Defense implementation in charge of the round, terrain,
-- and preview. Only the scenario's Lua environment can call its generator.
require("__base__/script/wave-defense/control.lua")

local function get_state()
  local saved = storage.wave_defense
  local surface = saved and saved.surface
  local valid_surface = surface and surface.valid
  return {
    in_preview = saved ~= nil and saved.state == 2,
    surface_index = valid_surface and surface.index or nil,
    seed = valid_surface and surface.map_gen_settings.seed or nil,
  }
end

local function regenerate(player_index, expected_surface_index, seed)
  if
    type(player_index) ~= "number"
    or player_index < 1
    or player_index > 4294967295
    or player_index ~= math.floor(player_index)
  then
    return false
  end
  local player = game.get_player(player_index)
  if not (player and player.valid and player.admin) then
    return false
  end
  local current = get_state()
  if
    not current.in_preview
    or current.surface_index == nil
    or current.surface_index ~= expected_surface_index
  then
    return false
  end
  if seed == nil then
    seed = current.seed
  end
  if type(seed) ~= "number" or seed < 0 or seed > 4294967294 or seed ~= math.floor(seed) then
    return false
  end
  create_battle_surface(seed)
  return true
end

require("event_handler").add_lib({
  add_remote_interface = function()
    remote.add_interface("wave_defense_enhanced_preview", {
      get_state = get_state,
      regenerate = regenerate,
    })
  end,
})
