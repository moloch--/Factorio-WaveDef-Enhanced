// Real-engine tests for debounced preview regeneration. The local player save is
// copied before the enhanced scenario wrapper is installed into its control.lua.
// No original save or release source is changed by this test adapter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FactorioServer, root, runRoot } from './test-wave-defense.mjs';

const fixture = process.env.WDE_GUI_SAVE || path.join(root, '.dev', 'gui-e2e', 'user-data', 'saves', '_autosave1.zip');
if (!existsSync(fixture)) {
  if (process.env.WDE_GUI_SAVE) throw new Error(`Configured WDE_GUI_SAVE does not exist: ${fixture}`);
  console.log('SKIP automatic preview engine tests: set WDE_GUI_SAVE to a local Wave Defense save containing a player.');
  process.exit(0);
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const originalHash = hash(fixture);
const server = new FactorioServer('preview-refresh');
const copiedSave = path.join(server.directory, 'user-data', 'saves', 'preview-fixture.zip');
copyFileSync(fixture, copiedSave);
const scenarioSource = path.join(server.directory, 'fixture-control.lua');
writeFileSync(scenarioSource, readFileSync(path.join(root, 'mod', 'scenarios', 'wave-defense-enhanced', 'control.lua'), 'utf8') + `
require("event_handler").add_lib({
  add_remote_interface = function()
    remote.add_interface("wde_test_native", {
      event = function(event)
        local before=storage.wave_defense.surface.index
        generic_gui_event(event)
        -- The fixture's existing player is disconnected on this headless server.
        -- Emulate vanilla's connected-player refresh after its real GUI action.
        if storage.wave_defense.surface.index~=before then refresh_preview_gui(game.players[1]) end
      end,
    })
  end,
})
`);
const patchArchiveScript = path.join(server.directory, 'patch-fixture.ps1');
writeFileSync(patchArchiveScript, `param([string]$SavePath,[string]$SourcePath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($SavePath,[IO.Compression.ZipArchiveMode]::Update)
try {
  $entries=@($archive.Entries | Where-Object { $_.FullName -match '^[^/]+/control\\.lua$' })
  if ($entries.Count -ne 1) { throw 'Expected exactly one root scenario control.lua in the copied fixture.' }
  $entryName=$entries[0].FullName
  $entries[0].Delete()
  $entry=$archive.CreateEntry($entryName)
  $writer=New-Object IO.StreamWriter($entry.Open(),(New-Object Text.UTF8Encoding($false)))
  try { $writer.Write([IO.File]::ReadAllText($SourcePath)) } finally { $writer.Dispose() }
} finally { $archive.Dispose() }
`);
const patched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', patchArchiveScript, copiedSave, scenarioSource], { encoding: 'utf8', windowsHide: true });
if (patched.status !== 0) throw new Error(`Could not prepare disposable player fixture: ${patched.stderr || patched.error}`);

// The override supplies a real saved LuaPlayer to production's timer without a
// graphical client. All events and map creation still use production code.
appendFileSync(path.join(server.stagedMod, 'control.lua'), `
local test_gui = require("scripts.setup_gui")
local function test_players()
  if storage.wde_test_disconnected then return {} end
  return {game.players[1]}
end
gui_context.players=test_players
local test_context={
  active=function() return remote.call("wave_defense_enhanced","get_status").active_scenario end,
  status=function() return remote.call("wave_defense_enhanced","get_status") end,
  players=test_players,
}
local function refresh() test_gui.refresh_player(game.players[1],test_context) end
remote.add_interface("wde_test_preview", {
  refresh=refresh,
  reset=function()
    storage.wde_test_disconnected=nil
    game.players[1].admin=true
    test_gui.cancel_preview()
    test_gui.remove_player(1)
  end,
  snapshot=function()
    local saved=storage.wde_setup_gui and storage.wde_setup_gui.players[1]
    local result={tick=game.tick,status=test_context.status(),queue=storage.wde_setup_gui and storage.wde_setup_gui.refresh,bridge=remote.call("wave_defense_enhanced_preview","get_state")}
    if saved and saved.body.valid then
      result.start_enabled=saved.native.start.enabled
      result.surface=saved.preview.surface_index
      result.invalid=saved.invalid
      result.validation_visible=saved.validation.visible
      result.seed=saved.native.seed and saved.native.seed.text
      result.numbers={}
      for name,pair in pairs(saved.numbers) do result.numbers[name]=pair.field.text end
    end
    return result
  end,
  event=function(kind,key,value)
    local saved=storage.wde_setup_gui.players[1]
    local element,event_name,native
    if kind=="field" then element=saved.numbers[key].field; element.text=value; event_name=defines.events.on_gui_text_changed
    elseif kind=="slider" then element=saved.numbers[key].slider; element.slider_value=value; event_name=defines.events.on_gui_value_changed
    elseif kind=="enabled" then element=saved.checks[key]; element.state=value; event_name=defines.events.on_gui_checked_state_changed
    elseif kind=="preset" then element=saved.preset; element.selected_index=value; event_name=defines.events.on_gui_selection_state_changed
    elseif kind=="area-mode" then element=saved.area_mode; element.selected_index=value; event_name=defines.events.on_gui_selection_state_changed
    elseif kind=="discard" then element=saved.discard; event_name=defines.events.on_gui_click
    elseif kind=="seed" or kind=="confirm-seed" then
      element=saved.native.seed; element.text=value; native=true
      event_name=kind=="seed" and defines.events.on_gui_text_changed or defines.events.on_gui_confirmed
    elseif kind=="infinite" or kind=="difficulty" or kind=="shuffle" then
      local function visit(parent)
        for _,child in pairs(parent.children) do
          if child.get_mod()==nil then
            if (kind=="infinite" and child.type=="checkbox") or (kind=="difficulty" and child.type=="drop-down") or (kind=="shuffle" and child.type=="sprite-button" and child.sprite=="utility/shuffle") then element=child; return end
            visit(child)
            if element then return end
          end
        end
      end
      visit(saved.native.frame)
      assert(element,"Native control missing: "..kind)
      native=true
      if kind=="infinite" then element.state=value; event_name=defines.events.on_gui_checked_state_changed
      elseif kind=="difficulty" then element.selected_index=value; event_name=defines.events.on_gui_selection_state_changed
      else event_name=defines.events.on_gui_click end
    else error("Unknown preview test event: "..kind) end
    local event={player_index=1,name=event_name,element=element}
    if native then remote.call("wde_test_native","event",event) end
    local handled=test_gui.handle_event(event,test_context)
    refresh()
    return {handled=handled}
  end,
  setting_event=function(name,value)
    settings.global[name]={value=value}
    -- The runtime-settings dialog includes the editing player's identity.
    script.get_event_handler(defines.events.on_runtime_mod_setting_changed)({name=defines.events.on_runtime_mod_setting_changed,setting=name,player_index=1,tick=game.tick})
    refresh()
  end,
  lifecycle=function(name)
    script.get_event_handler(defines.events[name])({name=defines.events[name],player_index=1,tick=game.tick})
  end,
  disconnect=function(value) storage.wde_test_disconnected=value end,
})
`);

const results = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const literal = (value) => value === undefined ? 'nil' : JSON.stringify(value);
const snapshot = () => server.evaluate('remote.call("wde_test_preview","snapshot")');
const event = (kind, key, value) => server.evaluate(`remote.call("wde_test_preview","event",${literal(kind)},${literal(key)},${literal(value)})`);
async function refresh() {
  await server.command('/c remote.call("wde_test_preview","refresh")');
  return snapshot();
}
async function advance(ticks) {
  assert.ok(Number.isInteger(ticks) && ticks >= 0);
  if (!ticks) return snapshot();
  const before = await snapshot();
  const target = before.tick + ticks;
  await server.command(`/c game.ticks_to_run=${ticks}`);
  const deadline = Date.now() + 30_000;
  let actual;
  do {
    actual = await snapshot();
    if (actual.tick === target) return actual;
    assert.ok(actual.tick < target, `Paused tick advance overshot ${target}: ${actual.tick}`);
    if (Date.now() > deadline) throw new Error(`Timed out advancing simulation to ${target}`);
    await delay(20);
  } while (true);
}
async function flush() {
  const current = await snapshot();
  assert.ok(current.queue, 'a preview refresh is queued');
  // game.tick is the next simulation tick after ticks_to_run is exhausted.
  // Include its event as well as the five-tick scheduler's rounding interval.
  return advance(Math.max(0, current.queue.due_tick - current.tick) + 5);
}
async function reset() {
  await server.command('/c remote.call("wde_test_preview","reset"); storage.wave_defense.state=2; storage.wave_defense.wave_tick=nil; storage.wave_defense.spawn_tick=nil');
  await server.settings({
    'wde-resource-preset': 'wave-defense', 'wde-starting-area-mode': 'difficulty',
    'wde-water-amount': 100, 'wde-starting-area-size': 175,
    'wde-tree-coverage': 100, 'wde-cliff-density': 100,
    ...Object.fromEntries(['iron-ore', 'copper-ore', 'coal', 'stone', 'uranium-ore', 'crude-oil'].map((resource) => [`wde-${resource}-enabled`, true])),
  });
  await server.generate();
  await server.command('/c gui_init(game.players[1])');
  await refresh();
  await server.command('/c remote.call("wde_test_preview","reset"); remote.call("wde_test_preview","refresh")');
  return snapshot();
}
async function check(name, body) {
  const started = Date.now();
  try {
    const before = await reset();
    await body(before);
    results.push({ name, passed: true, milliseconds: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    try { console.error(`Preview failure snapshot: ${JSON.stringify(await snapshot())}`); } catch {}
    results.push({ name, passed: false, milliseconds: Date.now() - started, error: String(error) });
    throw error;
  } finally {
    writeFileSync(path.join(runRoot, 'preview-results.json'), JSON.stringify({ fixture, results }, null, 2));
  }
}

try {
  console.log(`Automatic preview integration profiles: ${runRoot}`);
  await server.start(copiedSave);
  const players = await server.evaluate('{count=#game.players,level=script.level}');
  assert.ok(players.count > 0, 'WDE_GUI_SAVE must contain an existing player');
  assert.equal(players.level.mod_name, 'base');
  assert.equal(players.level.level_name, 'wave-defense');

  await check('a fresh Enhanced scenario activates the mod and exposes the preview bridge', async () => {
    const fresh = new FactorioServer('preview-fresh-scenario', true, 'wave-defense-enhanced/wave-defense-enhanced');
    try {
      await fresh.start();
      const initial = await fresh.evaluate('{level=script.level,status=remote.call("wave_defense_enhanced","get_status"),bridge=remote.call("wave_defense_enhanced_preview","get_state")}');
      assert.equal(initial.level.mod_name, 'wave-defense-enhanced');
      assert.equal(initial.level.level_name, 'wave-defense-enhanced');
      assert.equal(initial.status.active_scenario, true);
      await fresh.settings({ 'wde-water-amount': 125 });
      await fresh.command('/c storage.wave_defense.state=2; create_battle_surface(42)');
      const actual = await fresh.evaluate('{status=remote.call("wave_defense_enhanced","get_status"),bridge=remote.call("wave_defense_enhanced_preview","get_state")}');
      assert.equal(actual.status.applied.options.water_amount, 1.25);
      assert.equal(actual.status.applied.seed, 42);
      assert.equal(actual.status.pending, false);
      assert.equal(actual.bridge.in_preview, true);
      assert.equal(actual.bridge.surface_index, actual.status.applied.surface_index);
    } finally {
      await fresh.stop();
    }
  });

  await check('water slider bursts apply once after the last input and retain the current seed', async (before) => {
    for (const water of [125, 150, 175, 200]) {
      await event('slider', 'wde-water-amount', water);
      const pending = await snapshot();
      assert.equal(pending.queue.due_tick, pending.tick + 60);
      assert.equal(pending.status.generation_count, before.status.generation_count);
      assert.equal(pending.start_enabled, false);
      await advance(20);
    }
    let actual = await advance(39);
    assert.equal(actual.status.generation_count, before.status.generation_count, '59 ticks after the last edit is still pending');
    actual = await advance(6);
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.seed, before.status.applied.seed);
    assert.equal(actual.status.applied.options.water_amount, 2);
    assert.equal(actual.status.pending, false);
    assert.equal(actual.start_enabled, true);
    assert.equal(actual.queue, undefined);
    assert.equal(actual.surface, actual.status.applied.surface_index);
    assert.equal((await advance(120)).status.generation_count, actual.status.generation_count, 'idle timer does not regenerate again');
  });

  await check('terrain, resource, preset, checkbox and starting-area edits share one debounce window', async (before) => {
    for (const [kind, key, value] of [
      ['preset', undefined, 2], ['field', 'wde-iron-ore-richness', '225'],
      ['slider', 'wde-tree-coverage', 250], ['field', 'wde-cliff-density', '75'],
      ['enabled', 'coal', false], ['area-mode', undefined, 2], ['slider', 'wde-starting-area-size', 250],
      ['slider', 'wde-water-amount', 125], ['field', 'wde-tree-coverage', '175.5'],
    ]) {
      await event(kind, key, value);
      const pending = await snapshot();
      assert.equal(pending.queue.due_tick, pending.tick + 60);
      assert.equal(pending.status.generation_count, before.status.generation_count);
      await advance(10);
    }
    let actual = await advance(49);
    assert.equal(actual.status.generation_count, before.status.generation_count, 'interleaved controls wait for the last edit');
    actual = await advance(6);
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.preset, 'custom');
    assert.equal(actual.status.applied.options.resources['iron-ore'].richness, 2.25);
    assert.equal(actual.status.applied.options.resources.coal.enabled, false);
    assert.equal(actual.status.applied.starting_area, 2.5);
    assert.equal(actual.status.applied.options.water_amount, 1.25);
    assert.equal(actual.status.applied.options.tree_coverage, 1.755);
    assert.equal(actual.status.applied.options.cliff_density, 0.75);
    assert.equal(actual.start_enabled, true);
    assert.equal((await advance(120)).status.generation_count, actual.status.generation_count);
  });

  for (const [setting, option] of [
    ['wde-water-amount', 'water_amount'],
    ['wde-tree-coverage', 'tree_coverage'],
    ['wde-cliff-density', 'cliff_density'],
  ]) {
    await check(`invalid ${option} input postpones generation until repaired`, async (before) => {
      await event('field', setting, '200');
      await advance(40);
      await event('field', setting, '');
      let actual = await advance(120);
      assert.equal(actual.status.generation_count, before.status.generation_count);
      assert.equal(actual.start_enabled, false);
      assert.equal(actual.validation_visible, true);
      assert.equal(actual.numbers[setting], '');
      assert.equal(actual.status.next_options[option], 2);
      await event('field', setting, '250');
      actual = await advance(59);
      assert.equal(actual.status.generation_count, before.status.generation_count);
      actual = await advance(6);
      assert.equal(actual.status.generation_count, before.status.generation_count + 1);
      assert.equal(actual.status.applied.options[option], 2.5);
      assert.equal(actual.start_enabled, true);
    });
  }

  await check('discarding invalid input schedules the committed setting', async (before) => {
    await event('field', 'wde-water-amount', '225');
    await event('field', 'wde-water-amount', '601');
    await advance(70);
    await event('discard');
    const actual = await flush();
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.water_amount, 2.25);
    assert.equal(actual.validation_visible, false);
  });

  await check('reverting to the applied configuration cancels unnecessary work', async (before) => {
    await event('slider', 'wde-water-amount', 200);
    await event('slider', 'wde-tree-coverage', 0);
    await event('slider', 'wde-cliff-density', 600);
    await advance(20);
    await event('slider', 'wde-water-amount', 100);
    await event('slider', 'wde-tree-coverage', 100);
    await event('slider', 'wde-cliff-density', 100);
    const actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.status.pending, false);
    assert.equal(actual.start_enabled, true);
    assert.equal(actual.queue, undefined);
  });

  await check('tree and cliff defaults restore through the shared automatic preview', async (before) => {
    await event('slider', 'wde-tree-coverage', 0);
    await event('slider', 'wde-cliff-density', 600);
    const changed = await flush();
    assert.equal(changed.status.generation_count, before.status.generation_count + 1);
    assert.equal(changed.status.applied.options.tree_coverage, 0);
    assert.equal(changed.status.applied.options.cliff_density, 6);
    await event('field', 'wde-tree-coverage', '100');
    await advance(20);
    await event('slider', 'wde-cliff-density', 100);
    const restored = await flush();
    assert.equal(restored.status.generation_count, changed.status.generation_count + 1);
    assert.equal(restored.status.applied.seed, before.status.applied.seed);
    assert.deepEqual(restored.status.applied.options, before.status.applied.options);
    assert.equal(restored.numbers['wde-tree-coverage'], '100');
    assert.equal(restored.numbers['wde-cliff-density'], '100');
    assert.equal(restored.status.pending, false);
    assert.equal(restored.start_enabled, true);
    assert.equal(restored.queue, undefined);
  });

  await check('native seed typing uses the same debounce and applies the final seed', async (before) => {
    for (const seed of ['4', '42', '4242']) {
      await event('seed', undefined, seed);
      assert.equal((await snapshot()).start_enabled, false);
      await advance(20);
    }
    let actual = await advance(39);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    actual = await advance(6);
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.seed, 4242);
    assert.equal(actual.seed, '4242');
    assert.equal(actual.start_enabled, true);
  });

  await check('invalid seed blocks pending option changes until repaired', async (before) => {
    await event('slider', 'wde-water-amount', 175);
    await event('seed', undefined, '');
    let actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.start_enabled, false);
    await event('seed', undefined, '4294967295');
    actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    await event('seed', undefined, '987654321');
    actual = await flush();
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.seed, 987654321);
    assert.equal(actual.status.applied.options.water_amount, 1.75);
    assert.equal(actual.start_enabled, true);
  });

  await check('runtime mod-setting dialog changes regenerate automatically', async (before) => {
    await server.command('/c remote.call("wde_test_preview","setting_event","wde-water-amount",225)');
    await server.command('/c remote.call("wde_test_preview","setting_event","wde-tree-coverage",175)');
    await server.command('/c remote.call("wde_test_preview","setting_event","wde-cliff-density",50)');
    let actual = await advance(59);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.start_enabled, false);
    actual = await advance(6);
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.water_amount, 2.25);
    assert.equal(actual.status.applied.options.tree_coverage, 1.75);
    assert.equal(actual.status.applied.options.cliff_density, 0.5);
  });

  for (const [kind, value] of [['confirm-seed', '123456'], ['shuffle', undefined], ['difficulty', 1], ['infinite', true]]) {
    await check(`native ${kind} regeneration supersedes the queued preview`, async (before) => {
      await event('slider', 'wde-water-amount', 125);
      await advance(30);
      await event(kind, undefined, value);
      let actual = await snapshot();
      assert.equal(actual.status.generation_count, before.status.generation_count + 1);
      assert.equal(actual.status.applied.options.water_amount, 1.25);
      if (kind === 'confirm-seed') assert.equal(actual.status.applied.seed, 123456);
      actual = await advance(120);
      assert.equal(actual.status.generation_count, before.status.generation_count + 1);
      assert.equal(actual.queue, undefined);
      assert.equal(actual.start_enabled, true);
    });
  }

  await check('a queued refresh survives saving and reloading with its remaining delay', async (before) => {
    await event('slider', 'wde-water-amount', 275);
    await event('slider', 'wde-tree-coverage', 225);
    await event('slider', 'wde-cliff-density', 150);
    await advance(25);
    const pending = await snapshot();
    const save = path.join(server.directory, 'user-data', 'saves', 'preview-pending.zip');
    const outputStart = server.output.length;
    await server.command('/server-save preview-pending');
    const deadline = Date.now() + 30_000;
    while (!existsSync(save) || !server.output.slice(outputStart).includes('Saving finished')) {
      if (Date.now() > deadline) throw new Error('Pending-preview save did not finish');
      await delay(50);
    }
    await server.stop('before-preview-reload');
    await server.start(save);
    const restored = await snapshot();
    assert.deepEqual(restored.queue, pending.queue);
    assert.equal(restored.status.generation_count, before.status.generation_count);
    const actual = await flush();
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.water_amount, 2.75);
    assert.equal(actual.status.applied.options.tree_coverage, 2.25);
    assert.equal(actual.status.applied.options.cliff_density, 1.5);
    assert.equal(actual.start_enabled, true);
  });

  await check('disconnecting cancels regeneration and reconnecting resumes pending changes', async (before) => {
    await event('slider', 'wde-water-amount', 150);
    await server.command('/c remote.call("wde_test_preview","disconnect",true)');
    let actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.queue, undefined);
    await server.command('/c remote.call("wde_test_preview","disconnect",false); remote.call("wde_test_preview","lifecycle","on_player_joined_game")');
    actual = await advance(59);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    actual = await flush();
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.water_amount, 1.5);
    assert.equal(actual.start_enabled, true);
  });

  await check('demotion cancels regeneration and promotion resumes pending changes', async (before) => {
    await event('slider', 'wde-water-amount', 150);
    await server.command('/c game.players[1].admin=false');
    let actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.queue, undefined);
    await server.command('/c game.players[1].admin=true; remote.call("wde_test_preview","lifecycle","on_player_promoted")');
    actual = await advance(59);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    actual = await flush();
    assert.equal(actual.status.generation_count, before.status.generation_count + 1);
    assert.equal(actual.status.applied.options.water_amount, 1.5);
    assert.equal(actual.start_enabled, true);
  });

  await check('an active round cannot be regenerated by a queued preview', async (before) => {
    await event('slider', 'wde-water-amount', 150);
    await server.command('/c start_round()');
    const actual = await advance(120);
    assert.equal(actual.status.generation_count, before.status.generation_count);
    assert.equal(actual.bridge.in_preview, false);
    assert.equal(actual.queue, undefined);
  });

  assert.equal(hash(fixture), originalHash, 'the original local player save is untouched');
  console.log(`Passed ${results.length} automatic preview engine checks. Logs: ${runRoot}`);
} finally {
  await server.stop();
}
