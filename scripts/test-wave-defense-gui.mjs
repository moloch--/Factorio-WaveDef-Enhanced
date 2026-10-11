// Engine tests for the setup GUI, using an existing local save with a real player.
// Factorio has no runtime create_player API. No private save is checked into Git.
// Set WDE_GUI_SAVE to a Wave Defense save; otherwise the local graphical-test
// autosave is used when present. Missing fixtures produce an explicit skip.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FactorioServer, root, runRoot } from './test-wave-defense.mjs';

const fixture = process.env.WDE_GUI_SAVE || path.join(root, '.dev', 'gui-e2e', 'user-data', 'saves', '_autosave1.zip');
if (!existsSync(fixture)) {
  if (process.env.WDE_GUI_SAVE) throw new Error(`Configured WDE_GUI_SAVE does not exist: ${fixture}`);
  console.log('SKIP setup GUI engine tests: set WDE_GUI_SAVE to a local Wave Defense save containing a player.');
  process.exit(0);
}

const server = new FactorioServer('setup-gui');
const results = [];
// This adapter exists only in the disposable staged copy. It drives real engine
// LuaGuiElements and the unmodified production handlers for the saved player.
// Explicit refresh_player calls emulate connected-player refreshes while that
// real player is disconnected from this headless test server.
appendFileSync(path.join(server.stagedMod, 'control.lua'), `
local test_gui = require("scripts.setup_gui")
local test_context = {
  active = function() return remote.call("wave_defense_enhanced", "get_status").active_scenario end,
  status = function() return remote.call("wave_defense_enhanced", "get_status") end,
}
local function test_refresh()
  test_gui.refresh_player(game.players[1], test_context)
end
remote.add_interface("wde_test_gui", {
  refresh = test_refresh,
  layout = function(width, height)
    local player=game.players[1]
    local proxy=setmetatable({display_resolution={width=width,height=height},display_scale=1}, {
      __index=function(_,key) return player[key] end,
    })
    test_gui.refresh_player(proxy,test_context)
    local saved=storage.wde_setup_gui.players[player.index]
    local content=saved.preview.parent
    local panel=content.wde_setup_controls
    local result={
      body_valid=saved.body.valid,content_direction=content.direction,
      notice_outside_scroll=saved.notice.parent==saved.body,
      panel_width=panel.style.maximal_width,panel_height=panel.style.maximal_height,
      preview_width=saved.preview.style.maximal_width,preview_height=saved.preview.style.maximal_height,
      horizontal_scroll=panel.horizontal_scroll_policy,
      content_spacing=content.direction=="vertical" and content.style.vertical_spacing or content.style.horizontal_spacing,
      icons={},
    }
    for resource,checkbox in pairs(saved.checks) do
      for _,child in pairs(checkbox.parent.children) do
        if child.type=="sprite" then
          result.icons[resource]={fixed=not child.resize_to_sprite,width=child.style.maximal_width,height=child.style.maximal_height,row_width=checkbox.parent.style.maximal_width}
        end
      end
    end
    return result
  end,
  snapshot = function()
    local player = game.players[1]
    local saved = storage.wde_setup_gui and storage.wde_setup_gui.players[player.index]
    if not saved then return {present=false,admin=player.admin} end
    local result = {
      present=saved.body.valid,body_index=saved.body.index,admin=player.admin,
      start_enabled=saved.native.start.valid and saved.native.start.enabled,
      native_map_visible=saved.native.minimap.visible,
      preview_surface=saved.preview.surface_index,
      preset=saved.preset.selected_index,preset_enabled=saved.preset.enabled,
      area_mode=saved.area_mode.selected_index,
      invalid=saved.invalid,validation_visible=saved.validation.visible,
      checks={},numbers={},status=test_context.status(),
    }
    for name,element in pairs(saved.checks) do result.checks[name]={state=element.state,enabled=element.enabled} end
    for name,pair in pairs(saved.numbers) do
      result.numbers[name]={text=pair.field.text,value=pair.slider.slider_value,enabled=pair.field.enabled}
    end
    return result
  end,
  event = function(kind, key, value, force_enabled)
    local saved = storage.wde_setup_gui.players[1]
    local element, event_name
    if kind=="preset" then element=saved.preset; element.selected_index=value; event_name=defines.events.on_gui_selection_state_changed
    elseif kind=="area-mode" then element=saved.area_mode; element.selected_index=value; event_name=defines.events.on_gui_selection_state_changed
    elseif kind=="enabled" then element=saved.checks[key]; element.state=value; event_name=defines.events.on_gui_checked_state_changed
    elseif kind=="field" then element=saved.numbers[key].field; element.text=value; event_name=defines.events.on_gui_text_changed
    elseif kind=="slider" then element=saved.numbers[key].slider; element.slider_value=value; event_name=defines.events.on_gui_value_changed
    elseif kind=="discard" then element=saved.discard; event_name=defines.events.on_gui_click
    else error("Unknown GUI test event") end
    if force_enabled then element.enabled=true end
    local handled=test_gui.handle_event({player_index=1,name=event_name,element=element},test_context)
    test_refresh()
    return {handled=handled}
  end,
  inactive = function()
    local saved=storage.wde_setup_gui.players[1]
    local before=settings.global["wde-resource-preset"].value
    saved.preset.selected_index=2
    local handled=test_gui.handle_event({player_index=1,name=defines.events.on_gui_selection_state_changed,element=saved.preset},{active=function() return false end,status=test_context.status})
    return {handled=handled,before=before,after=settings.global["wde-resource-preset"].value}
  end,
  remove = function() test_gui.remove_player(1) end,
})
`);

async function gui() {
  return server.evaluate('remote.call("wde_test_gui","snapshot")');
}
async function event(kind, key, value, forceEnabled = false) {
  const literal = (item) => item === undefined ? 'nil' : JSON.stringify(item);
  return server.evaluate(`remote.call("wde_test_gui","event",${literal(kind)},${literal(key)},${literal(value)},${forceEnabled})`);
}
async function refresh() {
  await server.command('/c remote.call("wde_test_gui","refresh")');
  return gui();
}
async function regenerate() {
  await server.generate();
  return refresh();
}
async function check(name, body) {
  const started = Date.now();
  try {
    await body();
    results.push({ name, passed: true, milliseconds: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, milliseconds: Date.now() - started, error: String(error) });
    throw error;
  } finally {
    writeFileSync(path.join(runRoot, 'gui-results.json'), JSON.stringify({ fixture, results }, null, 2));
  }
}

try {
  console.log(`GUI integration profiles: ${runRoot}`);
  await server.start(fixture);
  const players = await server.evaluate('{count=#game.players,level=script.level}');
  assert.ok(players.count > 0, 'WDE_GUI_SAVE must contain an existing player');
  assert.equal(players.level.mod_name, 'base');
  assert.equal(players.level.level_name, 'wave-defense');
  const initial = { 'wde-resource-preset': 'wave-defense', 'wde-starting-area-mode': 'difficulty' };
  for (const resource of ['iron-ore', 'copper-ore', 'coal', 'stone', 'uranium-ore', 'crude-oil']) {
    initial[`wde-${resource}-enabled`] = true;
    // Deliberately stale stored custom numbers catch incorrect preset seeding.
    for (const dimension of ['frequency', 'size', 'richness']) initial[`wde-${resource}-${dimension}`] = 583;
  }
  await server.settings(initial);
  await server.command('/c local p=game.players[1]; p.admin=true; storage.wave_defense.state=2; storage.wave_defense.wave_tick=nil; storage.wave_defense.spawn_tick=nil; gui_init(p)');
  await regenerate();

  await check('setup controls attach to the real native preview and show resolved defaults', async () => {
    const actual = await gui();
    assert.equal(actual.present, true);
    assert.equal(actual.native_map_visible, false);
    assert.equal(actual.start_enabled, true);
    assert.equal(actual.preset, 1);
    assert.equal(Object.keys(actual.checks).length, 6);
    assert.equal(Object.keys(actual.numbers).length, 19);
    assert.equal(actual.numbers['wde-iron-ore-richness'].text, '200');
    assert.equal(actual.numbers['wde-crude-oil-frequency'].text, '200');
    assert.equal(actual.numbers['wde-uranium-ore-size'].text, '50');
  });
  await check('narrow and wide layouts create valid engine controls with visible regeneration notice', async () => {
    // A proxy overrides only display dimensions. GuiElements, settings, handlers,
    // ownership and player identity still come from the real saved engine player.
    for (const [width, height, direction] of [[900, 720, 'vertical'], [1280, 720, 'horizontal']]) {
      const actual = await server.evaluate(`remote.call("wde_test_gui","layout",${width},${height})`);
      assert.equal(actual.body_valid, true);
      assert.equal(actual.content_direction, direction);
      assert.equal(actual.notice_outside_scroll, true, 'regeneration notice must remain outside the scrolling resource panel');
      assert.equal(actual.horizontal_scroll, 'auto', 'narrow resource columns must be scrollable rather than compressed');
      assert.ok(actual.panel_width > 0 && actual.panel_height > 0 && actual.preview_width > 0 && actual.preview_height > 0);
      if (direction === 'vertical') {
        assert.ok(Math.max(actual.panel_width, actual.preview_width) < width, 'stacked content fits viewport width');
        assert.ok(actual.panel_height + actual.preview_height + actual.content_spacing < height, 'stacked content leaves space for native controls');
      } else {
        assert.ok(actual.panel_width + actual.preview_width + actual.content_spacing < width, 'side-by-side content fits viewport width');
        assert.ok(Math.max(actual.panel_height, actual.preview_height) < height, 'content fits viewport height');
      }
      assert.equal(Object.keys(actual.icons).length, 6);
      for (const icon of Object.values(actual.icons)) {
        assert.equal(icon.fixed, true, 'resource sprites must respect layout size instead of intrinsic sprite dimensions');
        assert.ok(icon.width > 0 && icon.height > 0 && icon.width < icon.row_width, 'resource icon leaves room for its checkbox and label');
      }
    }
    await refresh();
  });
  await check('editing a default-preset value seeds all custom controls from visible values', async () => {
    await event('field', 'wde-iron-ore-richness', '425');
    const actual = await gui();
    assert.equal(actual.preset, 3);
    assert.equal(actual.numbers['wde-iron-ore-richness'].text, '425');
    assert.equal(actual.numbers['wde-copper-ore-richness'].text, '200');
    assert.equal(actual.numbers['wde-uranium-ore-size'].text, '50');
    assert.equal(actual.numbers['wde-crude-oil-frequency'].text, '200');
    assert.equal(actual.start_enabled, false);
    assert.equal(actual.status.pending, true);
  });
  await check('switching Freeplay to Custom preserves Freeplay visible values', async () => {
    await event('preset', undefined, 2);
    await event('preset', undefined, 3);
    const actual = await gui();
    assert.equal(actual.preset, 3);
    for (const [name, number] of Object.entries(actual.numbers)) {
      if (name !== 'wde-starting-area-size') assert.equal(number.text, '100');
    }
    await regenerate();
    assert.equal((await gui()).start_enabled, true);
  });
  await check('invalid numeric input blocks Start without changing shared settings', async () => {
    for (const value of ['', '601']) {
      await event('field', 'wde-iron-ore-richness', value);
      const actual = await gui();
      assert.equal(actual.numbers['wde-iron-ore-richness'].text, value);
      assert.equal(actual.start_enabled, false);
      assert.equal(actual.validation_visible, true);
      assert.equal(actual.status.next_options.resources['iron-ore'].richness, 1);
    }
    await server.command('/c refresh_preview_gui(game.players[1])');
    const rebuilt = await refresh();
    assert.equal(rebuilt.numbers['wde-iron-ore-richness'].text, '601');
    assert.equal(rebuilt.start_enabled, false);
    assert.equal(rebuilt.validation_visible, true);
    await event('discard');
    const actual = await gui();
    assert.equal(actual.numbers['wde-iron-ore-richness'].text, '100');
    assert.equal(actual.validation_visible, false);
    assert.equal(actual.start_enabled, true);
  });
  await check('decimal entry survives periodic refresh without losing the unfinished decimal point', async () => {
    await event('field', 'wde-iron-ore-richness', '125.');
    let actual = await refresh();
    assert.equal(actual.numbers['wde-iron-ore-richness'].text, '125.');
    assert.equal(actual.status.next_options.resources['iron-ore'].richness, 1.25);
    await event('field', 'wde-iron-ore-richness', '125.5');
    actual = await refresh();
    assert.equal(actual.numbers['wde-iron-ore-richness'].text, '125.5');
    assert.equal(actual.status.next_options.resources['iron-ore'].richness, 1.255);
    await event('field', 'wde-iron-ore-richness', '100');
    assert.equal((await gui()).start_enabled, true);
  });
  await check('checkboxes and area controls remain pending until native regeneration', async () => {
    await event('enabled', 'coal', false);
    await event('area-mode', undefined, 2);
    await event('slider', 'wde-starting-area-size', 250);
    let actual = await gui();
    assert.equal(actual.checks.coal.state, false);
    assert.equal(actual.numbers['wde-coal-frequency'].enabled, false);
    assert.equal(actual.numbers['wde-starting-area-size'].text, '250');
    assert.equal(actual.start_enabled, false);
    assert.equal(actual.status.applied.starting_area, 1.75);
    assert.equal(actual.status.next_options.starting_area, 2.5);
    actual = await regenerate();
    assert.equal(actual.status.applied.starting_area, 2.5);
    assert.equal(actual.status.pending, false);
    assert.equal(actual.start_enabled, true);
  });
  await check('native preview rebuild restores controls and pending Start guard', async () => {
    await event('field', 'wde-iron-ore-size', '180');
    const before = await gui();
    await server.command('/c refresh_preview_gui(game.players[1])');
    const after = await refresh();
    assert.notEqual(after.body_index, before.body_index);
    assert.equal(after.present, true);
    assert.equal(after.numbers['wde-iron-ore-size'].text, '180');
    assert.equal(after.start_enabled, false);
  });
  await check('non-admin events cannot change settings even if a control is forcibly enabled', async () => {
    await server.command('/c game.players[1].admin=false');
    const before = await refresh();
    assert.equal(before.preset_enabled, false);
    assert.equal(before.start_enabled, false);
    const result = await event('preset', undefined, 1, true);
    const after = await gui();
    assert.equal(result.handled, false);
    assert.deepEqual(after.status.next_options, before.status.next_options);
    assert.equal(after.preset_enabled, false);
    await server.command('/c game.players[1].admin=true');
    await refresh();
  });
  await check('inactive scenario context ignores setup events and player cleanup removes owned UI', async () => {
    const result = await server.evaluate('remote.call("wde_test_gui","inactive")');
    assert.equal(result.handled, false);
    assert.equal(result.after, result.before);
    await server.command('/c remote.call("wde_test_gui","remove")');
    assert.equal((await gui()).present, false);
    assert.equal((await refresh()).present, true);
  });
  console.log(`Passed ${results.length} setup GUI engine checks. Logs: ${runRoot}`);
} finally {
  await server.stop();
}
