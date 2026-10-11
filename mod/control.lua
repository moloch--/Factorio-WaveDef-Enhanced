-- Persistent state is initialized only in synchronized lifecycle callbacks.
local function initialize_storage()
  storage.wave_defense_enhanced = storage.wave_defense_enhanced or {}
  local state = storage.wave_defense_enhanced

  state.schema_version = state.schema_version or 1
  state.wave = state.wave or {}
  state.wave.current = state.wave.current or 0
end

script.on_init(function()
  initialize_storage()
  log("[wave-defense-enhanced] initialized")
end)

script.on_configuration_changed(function()
  -- Preserve existing progress when this mod or the surrounding mod set changes.
  initialize_storage()
end)

commands.add_command("wde-status", { "wave-defense-enhanced.command-help" }, function(command)
  local state = storage.wave_defense_enhanced
  local message = { "wave-defense-enhanced.status", state.wave.current }

  if command.player_index then
    local player = game.get_player(command.player_index)
    if player then
      player.print(message)
    end
  else
    game.print(message)
  end
end)
