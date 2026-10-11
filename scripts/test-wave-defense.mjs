// Actual Factorio integration tests; requires Node.js and the local Factorio install.
// All console commands run in disposable, loopback-only profiles under .dev/wave-tests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localPath = path.join(root, '.dev', 'local.json');
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, 'utf8').replace(/^\uFEFF/, '')) : {};
const factorio = process.env.FACTORIO_PATH || local.factorioPath;
if (!factorio || !existsSync(factorio)) {
  throw new Error('Factorio not found. Run scripts/dev.ps1 Setup or set FACTORIO_PATH to the executable.');
}
const runRoot = path.join(root, '.dev', 'wave-tests', `${Date.now()}-${randomBytes(4).toString('hex')}`);
mkdirSync(runRoot, { recursive: true });
const resources = ['iron-ore', 'copper-ore', 'coal', 'stone', 'uranium-ore', 'crude-oil'];
const seed = 2390375328;
const results = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lua = (value) => typeof value === 'string' ? JSON.stringify(value) : String(value);

async function reservePort(protocol) {
  const socket = protocol === 'tcp' ? net.createServer() : dgram.createSocket('udp4');
  const port = await new Promise((resolve, reject) => {
    socket.once('error', reject);
    const ready = () => resolve(socket.address().port);
    if (protocol === 'tcp') socket.listen(0, '127.0.0.1', ready);
    else socket.bind(0, '127.0.0.1', ready);
  });
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function packet(id, type, message) {
  const body = Buffer.from(message, 'utf8');
  const buffer = Buffer.alloc(body.length + 14);
  buffer.writeInt32LE(body.length + 10, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  body.copy(buffer, 12);
  return buffer;
}

class FactorioServer {
  constructor(name, modEnabled = true, scenario = 'base/wave-defense') {
    this.directory = path.join(runRoot, name);
    this.scenario = scenario;
    this.modEnabled = modEnabled;
    this.sequence = 0;
    this.pending = new Map();
    this.received = Buffer.alloc(0);
    this.output = '';
    this.socket = null;
    mkdirSync(path.join(this.directory, 'mods'), { recursive: true });
    mkdirSync(path.join(this.directory, 'user-data', 'saves'), { recursive: true });
    const info = JSON.parse(readFileSync(path.join(root, 'mod', 'info.json'), 'utf8'));
    const stagedMod = path.join(this.directory, 'mods', `${info.name}_${info.version}`);
    cpSync(path.join(root, 'mod'), stagedMod, { recursive: true });
    // Factorio only allows the owning mod/player to write runtime settings. Add
    // this narrow adapter exclusively to the disposable copy, never the release.
    appendFileSync(path.join(stagedMod, 'control.lua'), '\nremote.add_interface("wde_test_settings", {set=function(values) for name,value in pairs(values) do settings.global[name]={value=value} end end})\n');
    writeFileSync(path.join(this.directory, 'mods', 'mod-list.json'), JSON.stringify({ mods: [
      { name: 'base', enabled: true },
      // Omitting installed DLC from mod-list.json enables it automatically.
      { name: 'elevated-rails', enabled: false },
      { name: 'quality', enabled: false },
      { name: 'space-age', enabled: false },
      { name: info.name, enabled: modEnabled },
    ] }, null, 2));
    const readData = path.resolve(path.dirname(factorio), '..', '..', 'data').replaceAll('\\', '/');
    const writeData = path.join(this.directory, 'user-data').replaceAll('\\', '/');
    writeFileSync(path.join(this.directory, 'config.ini'), `[path]\nread-data=${readData}\nwrite-data=${writeData}\n`);
    writeFileSync(path.join(this.directory, 'server.json'), JSON.stringify({
      name: 'Wave Defense Enhanced local tests',
      description: 'Disposable local integration profile',
      visibility: { public: false, lan: false },
      require_user_verification: false,
      allow_commands: 'true',
      auto_pause: false,
      autosave_interval: 0,
    }, null, 2));
  }

  async start(save) {
    this.output = '';
    this.received = Buffer.alloc(0);
    this.failure = null;
    const [rconPort, gamePort] = await Promise.all([reservePort('tcp'), reservePort('udp')]);
    const password = randomBytes(24).toString('hex');
    const arguments_ = [
      '--config', path.join(this.directory, 'config.ini'),
      '--mod-directory', path.join(this.directory, 'mods'),
      '--server-settings', path.join(this.directory, 'server.json'),
      '--bind', `127.0.0.1:${gamePort}`,
      '--rcon-bind', `127.0.0.1:${rconPort}`, '--rcon-password', password,
      ...(save ? ['--start-server', save] : ['--start-server-load-scenario', this.scenario]),
    ];
    this.child = spawn(factorio, arguments_, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const receiveOutput = (data) => {
      this.output += data.toString();
      if (/Exception at tick|MultiplayerManager failed:/.test(data.toString())) {
        this.rejectPending(new Error(`Factorio failed: ${data.toString()}`));
      }
    };
    this.child.stdout.on('data', receiveOutput);
    this.child.stderr.on('data', receiveOutput);
    this.child.on('error', (error) => { this.failure = error; });
    this.closed = new Promise((resolve) => this.child.once('close', (code) => {
      this.failure ||= new Error(`Factorio exited (${code}). See ${this.directory}`);
      resolve();
    }));
    const deadline = Date.now() + 120_000;
    while (!this.output.includes('Starting RCON interface')) {
      if (this.failure) throw this.failure;
      if (Date.now() > deadline) throw new Error(`Factorio startup timed out. See ${this.directory}`);
      await delay(100);
    }
    this.socket = net.createConnection({ host: '127.0.0.1', port: rconPort });
    this.socket.on('error', (error) => this.rejectPending(error));
    this.socket.on('close', () => this.rejectPending(new Error('RCON closed')));
    this.socket.on('data', (data) => this.onData(data));
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    await this.request(3, password);
    // A consistent frozen simulation allows snapshots before enemies consume ammunition.
    await this.command('/c game.tick_paused = true');
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {
      if (request.barrierFor) continue;
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  onData(data) {
    this.received = Buffer.concat([this.received, data]);
    while (this.received.length >= 4) {
      const length = this.received.readInt32LE(0);
      if (length < 10 || length > 16 * 1024 * 1024) {
        this.rejectPending(new Error('Invalid RCON packet size'));
        this.socket.destroy();
        return;
      }
      if (this.received.length < length + 4) return;
      const id = this.received.readInt32LE(4);
      const type = this.received.readInt32LE(8);
      const body = this.received.subarray(12, length + 2).toString('utf8');
      this.received = this.received.subarray(length + 4);
      if (id === -1) {
        this.rejectPending(new Error('RCON authentication failed'));
        continue;
      }
      const request = this.pending.get(id);
      if (request?.barrierFor) {
        const command = this.pending.get(request.barrierFor);
        this.pending.delete(id);
        if (command) {
          clearTimeout(command.timer);
          this.pending.delete(request.barrierFor);
          command.resolve(command.body);
        }
        continue;
      }
      if (request?.type === 2) {
        request.body += body;
        continue;
      }
      if (request && (request.type !== 3 || type === 2)) {
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.resolve(body);
      }
    }
  }

  request(type, message) {
    const id = ++this.sequence;
    const barrierId = type === 2 ? ++this.sequence : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (barrierId) this.pending.delete(barrierId);
        reject(new Error(`RCON timed out. See ${this.directory}`));
      }, 90_000);
      this.pending.set(id, { type, resolve, reject, timer, body: '' });
      this.socket.write(packet(id, type, message));
      // Factorio may split a long response across packets. A subsequent command
      // supplies an ordered boundary rather than assuming the first packet is all.
      if (barrierId) {
        this.pending.set(barrierId, { barrierFor: id });
        this.socket.write(packet(barrierId, 2, '/silent-command rcon.print("WDE_RCON_END")'));
      }
    });
  }

  async command(command) {
    const logStart = this.output.length;
    const response = await this.request(2, command);
    const errorText = response + this.output.slice(logStart);
    if (/Cannot execute command|Unknown command|Error while running|Error: /i.test(errorText)) throw new Error(`Console command failed: ${errorText}`);
    return response;
  }

  async evaluate(expression, setup = '') {
    const response = await this.command(`/c ${setup} rcon.print('WDE_TEST_JSON:' .. helpers.table_to_json(${expression}))`);
    const json = response.split('WDE_TEST_JSON:').at(-1).trim();
    try { return JSON.parse(json); }
    catch { throw new Error(`Invalid response to integration query: ${response}`); }
  }

  async settings(values) {
    const entries = Object.entries(values).map(([name, value]) => `[${lua(name)}]=${lua(value)}`).join(',');
    await this.command(`/c remote.call("wde_test_settings","set",{${entries}})`);
  }

  async generate({ difficulty = 'normal', infinite = false, mapSeed = seed, forcePreview = true } = {}) {
    const preview = forcePreview ? '; storage.wave_defense.surface.request_to_generate_chunks({0,0},10); storage.wave_defense.surface.force_generate_chunk_requests()' : '';
    await this.command(`/c storage.wave_defense.difficulty=storage.wave_defense.config.difficulties[${lua(difficulty)}]; storage.wave_defense.config.infinite=${lua(infinite)}; create_battle_surface(${mapSeed})${preview}`);
    return this.snapshot();
  }

  async snapshot() {
    return this.evaluate('result', `
      local s=storage.wave_defense.surface
      local function hash(items)
        table.sort(items)
        local h=0
        for _,item in ipairs(items) do
          for i=1,#item do h=(h*31+string.byte(item,i))%2147483647 end
          h=(h*31+10)%2147483647
        end
        return h
      end
      local resource_names={'iron-ore','copper-ore','coal','stone','uranium-ore','crude-oil'}
      local ores={}
      for _,name in ipairs(resource_names) do
        local positions={}; local amounts={}; local amount=0
        for _,entity in pairs(s.find_entities_filtered{name=name,area={{-320,-320},{320,320}}}) do
          local p=entity.position; local key=p.x..','..p.y
          positions[#positions+1]=key; amounts[#amounts+1]=key..':'..entity.amount
          amount=amount+entity.amount
        end
        ores[name]={count=#positions,amount=amount,positions=hash(positions),amounts=hash(amounts)}
      end
      local defenses={}; local walls=0; local gates=0; local turrets=0; local ammo=0; local full_ammo=true
      local min_x=math.huge; local max_x=-math.huge; local min_y=math.huge; local max_y=-math.huge
      for _,entity in pairs(s.find_entities_filtered{name={'stone-wall','gate','gun-turret'},force='player'}) do
        local p=entity.position
        defenses[#defenses+1]=entity.name..':'..p.x..','..p.y..':'..entity.direction
        if entity.name=='gun-turret' then
          turrets=turrets+1
          local count=entity.get_inventory(defines.inventory.turret_ammo).get_item_count('firearm-magazine')
          ammo=ammo+count; full_ammo=full_ammo and count==50
        else
          if entity.name=='stone-wall' then walls=walls+1 else gates=gates+1 end
          min_x=math.min(min_x,p.x);max_x=math.max(max_x,p.x);min_y=math.min(min_y,p.y);max_y=math.max(max_y,p.y)
        end
      end
      local missing_water=0; local missing_walkable={}
      local function check_wall(x,y)
        if s.count_entities_filtered{name={'stone-wall','gate'},position={x,y},radius=0.1}>0 then return end
        local tile=s.get_tile(x,y)
        if tile.collides_with('water_tile') then missing_water=missing_water+1
        else missing_walkable[#missing_walkable+1]={x=x,y=y,tile=tile.name} end
      end
      for x=min_x,max_x do check_wall(x,min_y); check_wall(x,max_y) end
      for y=min_y+1,max_y-1 do check_wall(min_x,y); check_wall(max_x,y) end
      local result={settings=s.map_gen_settings,ores=ores,defenses={walls=walls,gates=gates,turrets=turrets,ammo=ammo,full_ammo=full_ammo,hash=hash(defenses),min_x=min_x,max_x=max_x,min_y=min_y,max_y=max_y,missing_water=missing_water,missing_walkable=missing_walkable},silo=storage.wave_defense.silo and storage.wave_defense.silo.valid or false}
    `.replaceAll('\n', ' '));
  }

  async stop(logName = 'server') {
    this.socket?.destroy();
    this.socket = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
    if (this.closed) await this.closed;
    this.rejectPending(new Error('Server stopped'));
    writeFileSync(path.join(this.directory, `${logName}.log`), this.output);
  }
}

async function check(name, body) {
  if (process.env.WDE_TEST_MATCH && !name.includes(process.env.WDE_TEST_MATCH)) return;
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    results.push({ name, passed: false, milliseconds: Date.now() - started, error: String(error) });
    writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify({ factorio, results }, null, 2));
    throw error;
  }
  results.push({ name, passed: true, milliseconds: Date.now() - started });
  writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify({ factorio, results }, null, 2));
  console.log(`PASS ${name}`);
}

function assertDefenses(snapshot) {
  const d = snapshot.defenses;
  assert.equal(snapshot.silo, true, 'rocket silo exists');
  assert.ok(d.walls > 0 && d.gates > 0 && d.turrets > 0, 'all defense types exist');
  assert.equal(d.max_x - d.min_x, d.max_y - d.min_y, 'square perimeter');
  assert.equal(Object.keys(d.missing_walkable).length, 0, `every walkable perimeter tile has a wall or gate: ${JSON.stringify(d.missing_walkable)}`);
  assert.equal(d.walls + d.gates + d.missing_water, 2 * (d.max_x - d.min_x + d.max_y - d.min_y), 'missing perimeter defenses are only on impassable water');
  assert.equal(d.full_ammo, true, 'every turret starts with 50 magazines');
  assert.equal(d.ammo, d.turrets * 50, 'ammunition scales with turret count');
}

const vanilla = new FactorioServer('vanilla', false);
const enhanced = new FactorioServer('enhanced');
const freeplay = new FactorioServer('freeplay', true, 'base/freeplay');
try {
  console.log(`Integration profiles: ${runRoot}`);
  await vanilla.start();
  const baseline = await vanilla.generate();
  assertDefenses(baseline);
  await vanilla.stop();
  await enhanced.start();
  await check('default settings reproduce vanilla terrain and starting defenses', async () => {
    const actual = await enhanced.generate();
    assert.deepEqual(actual, baseline);
  });
  await check('default starting area follows all three difficulties', async () => {
    for (const [difficulty, expected] of [['easy', 2.25], ['normal', 1.75], ['hard', 1.5]]) {
      const actual = await enhanced.generate({ difficulty });
      assert.equal(actual.settings.starting_area, expected);
      assertDefenses(actual);
    }
  });
  await check('custom resource controls keep native values and unrelated map settings', async () => {
    const values = { 'wde-resource-preset': 'custom' };
    for (const [index, resource] of resources.entries()) {
      values[`wde-${resource}-frequency`] = 50 + index * 25;
      values[`wde-${resource}-size`] = 75 + index * 25;
      values[`wde-${resource}-richness`] = 100 + index * 50;
    }
    await enhanced.settings(values);
    const actual = await enhanced.generate();
    for (const resource of resources) {
      for (const dimension of ['frequency', 'size', 'richness']) {
        assert.equal(actual.settings.autoplace_controls[resource][dimension], values[`wde-${resource}-${dimension}`] / 100);
      }
    }
    assert.deepEqual(actual.settings.autoplace_controls['enemy-base'], baseline.settings.autoplace_controls['enemy-base']);
    assert.deepEqual(actual.settings.autoplace_controls.trees, baseline.settings.autoplace_controls.trees);
    assert.deepEqual(actual.settings.cliff_settings, baseline.settings.cliff_settings);
  });
  await check('richness changes actual ore amounts for the same seed', async () => {
    await enhanced.settings({ 'wde-resource-preset': 'custom', 'wde-iron-ore-frequency': 100, 'wde-iron-ore-size': 200, 'wde-iron-ore-richness': 100 });
    const low = await enhanced.generate();
    await enhanced.settings({ 'wde-iron-ore-richness': 400 });
    const high = await enhanced.generate();
    assert.ok(low.ores['iron-ore'].count > 0, 'seed provides actual iron ore');
    assert.ok(high.ores['iron-ore'].amount > low.ores['iron-ore'].amount * 3.5);
  });
  await check('resource enable switches suppress actual deposits with every preset', async () => {
    for (const preset of ['wave-defense', 'freeplay', 'custom']) {
      await enhanced.settings({ 'wde-resource-preset': preset, ...Object.fromEntries(resources.map((resource) => [`wde-${resource}-enabled`, false])) });
      const actual = await enhanced.generate();
      for (const resource of resources) {
        assert.equal(actual.ores[resource].count, 0, `${resource} disabled under ${preset}`);
        assert.equal(actual.settings.autoplace_controls[resource].size, 0);
      }
    }
    await enhanced.settings(Object.fromEntries(resources.map((resource) => [`wde-${resource}-enabled`, true])));
  });
  await check('freeplay resource preset is native 100 percent for all resources', async () => {
    await enhanced.settings({ 'wde-resource-preset': 'freeplay' });
    const actual = await enhanced.generate();
    for (const resource of resources) {
      assert.deepEqual(actual.settings.autoplace_controls[resource], { frequency: 1, size: 1, richness: 1 });
    }
  });
  await check('custom starting areas scale terrain-aware walls, gates, turrets and ammunition', async () => {
    await enhanced.settings({ 'wde-starting-area-mode': 'custom', 'wde-resource-preset': 'wave-defense' });
    for (const infinite of [false, true]) {
      let previous;
      for (const size of [100, 175, 300]) {
        await enhanced.settings({ 'wde-starting-area-size': size });
        const actual = await enhanced.generate({ infinite });
        assert.equal(actual.settings.starting_area, size / 100);
        assertDefenses(actual);
        if (previous) {
          assert.ok(actual.defenses.walls > previous.defenses.walls);
          assert.ok(actual.defenses.turrets > previous.defenses.turrets);
        }
        previous = actual;
      }
    }
  });
  await check('settings remain pending until regeneration, including during a round', async () => {
    await enhanced.settings({ 'wde-starting-area-size': 100 });
    const before = await enhanced.generate();
    await enhanced.command('/c start_round()');
    await enhanced.settings({ 'wde-starting-area-size': 225, 'wde-resource-preset': 'freeplay' });
    assert.deepEqual(await enhanced.snapshot(), before);
    const pending = await enhanced.evaluate('remote.call("wave_defense_enhanced","get_status")');
    assert.equal(pending.pending, true);
    assert.equal(pending.applied.starting_area, 1);
    assert.equal(pending.next_options.starting_area, 2.25);
    await enhanced.command('/c restart_round(); storage.wave_defense.surface.request_to_generate_chunks({0,0},10); storage.wave_defense.surface.force_generate_chunk_requests()');
    const restarted = await enhanced.snapshot();
    assert.equal(restarted.settings.starting_area, 2.25);
    assert.equal(restarted.settings.autoplace_controls['iron-ore'].richness, 1);
    assert.equal((await enhanced.evaluate('remote.call("wave_defense_enhanced","get_status")')).pending, false);
    assertDefenses(restarted);
  });
  await check('same seed and configuration reproduce resources and defense layout', async () => {
    const first = await enhanced.generate({ mapSeed: 123456789 });
    const second = await enhanced.generate({ mapSeed: 123456789 });
    assert.deepEqual(second, first);
  });
  await check('save/reload retains settings, surface state and regeneration behavior', async () => {
    const before = await enhanced.snapshot();
    const save = path.join(enhanced.directory, 'user-data', 'saves', 'wde-integration.zip');
    await enhanced.command('/server-save wde-integration');
    const deadline = Date.now() + 30_000;
    while (!existsSync(save) || !enhanced.output.includes('Saving finished')) {
      if (Date.now() > deadline) throw new Error('Integration save did not finish');
      await delay(100);
    }
    await enhanced.stop('before-reload');
    await enhanced.start(save);
    assert.deepEqual(await enhanced.snapshot(), before);
    const regenerated = await enhanced.generate({ mapSeed: 123456789 });
    assert.deepEqual(regenerated, before);
  });
  await check('native wave spawning finds spawners at every supported base size and map type', async () => {
    await enhanced.settings({ 'wde-starting-area-mode': 'custom', 'wde-resource-preset': 'wave-defense' });
    // A headless server has no connected players, so native wave power is zero.
    // Temporarily make one unit free in this disposable scenario. The stock loop
    // exits after that purchase, exercising real spawn/path/attack code unchanged.
    const waveEvidence = [];
    for (const infinite of [false, true]) {
      for (const { size, mapSeed } of [100, 175, 300].map((size) => ({ size, mapSeed: seed })).concat([{ size: 300, mapSeed: 123456789 }, { size: 300, mapSeed: 42 }])) {
        await enhanced.settings({ 'wde-starting-area-size': size });
        // With no rendering clients, vanilla's chart preview does not request
        // chunks. Emulate only its stock ten-chunk preview for native-sized bases.
        // Large bases must discover spawners using the product's requests alone.
        await enhanced.generate({ infinite, mapSeed, forcePreview: size <= 225 });
        const { tick: started } = await enhanced.evaluate('{tick=game.tick}');
        await enhanced.command('/c start_round(); storage.wave_defense.difficulty.unit_prices["small-biter"]=0; game.speed=16; game.tick_paused=false');
        let evidence;
        const deadline = Date.now() + 45_000;
        do {
          await delay(100);
          evidence = await enhanced.evaluate('{tick=game.tick,registered=table_size(storage.wave_defense.spawners),generated=storage.wave_defense.surface.count_entities_filtered{type="unit-spawner"}}');
          if (Date.now() > deadline) throw new Error(`Wave simulation timed out: ${JSON.stringify(evidence)}`);
        } while (evidence.tick - started < 600 || (evidence.registered === 0 && evidence.tick - started < 6000));
        await enhanced.command('/c game.tick_paused=true; for i=1,20 do spawn_units() end; storage.wave_defense.difficulty.unit_prices["small-biter"]=25');
        const attackers = await enhanced.evaluate('{units=#units,groups=table_size(groups),attack_groups=table_size(attack_groups),silo=storage.wave_defense.silo.valid}', 'local units=storage.wave_defense.surface.find_entities_filtered{type="unit",force="enemy"}; local groups={}; local attack_groups={}; for _,unit in pairs(units) do local group=unit.commandable.parent_group; if group then groups[group.unique_id]=true; local command=group.command; if command and command.commands and command.commands[3] and command.commands[3].target==storage.wave_defense.silo then attack_groups[group.unique_id]=true end end end;');
        waveEvidence.push({ size, infinite, seed: mapSeed, preview_emulated: size <= 225, ...evidence, ...attackers });
        console.log(`Wave evidence ${JSON.stringify(waveEvidence.at(-1))}`);
        writeFileSync(path.join(runRoot, 'wave-evidence.json'), JSON.stringify(waveEvidence, null, 2));
      }
    }
    for (const evidence of waveEvidence) assert.ok(evidence.registered > 0 && evidence.units > 0 && evidence.attack_groups > 0 && evidence.silo, `Wave attackers missing: ${JSON.stringify(evidence)}`);
  });
  await enhanced.stop();
  await freeplay.start();
  await check('ordinary Freeplay and similarly named surfaces keep their generation settings', async () => {
    const before = await freeplay.evaluate('game.surfaces.nauvis.map_gen_settings');
    await freeplay.settings({ 'wde-resource-preset': 'freeplay', 'wde-iron-ore-enabled': false, 'wde-starting-area-mode': 'custom', 'wde-starting-area-size': 300 });
    assert.deepEqual(await freeplay.evaluate('game.surfaces.nauvis.map_gen_settings'), before);
    const actual = await freeplay.evaluate('s.map_gen_settings', 'local s=game.create_surface("Surface 42",{seed=123,starting_area=1.25,autoplace_controls={["iron-ore"]={frequency=2,size=3,richness=4}}});');
    assert.equal(actual.starting_area, 1.25);
    assert.deepEqual(actual.autoplace_controls['iron-ore'], { frequency: 2, size: 3, richness: 4 });
  });
  writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify({ factorio, results }, null, 2));
  console.log(`Passed ${results.length} actual-game integration checks. Logs: ${runRoot}`);
} finally {
  const stopped = await Promise.allSettled([vanilla, enhanced, freeplay].map((server) => server.stop()));
  for (const result of stopped) if (result.status === 'rejected') console.error(`Cleanup failed: ${result.reason}`);
}
