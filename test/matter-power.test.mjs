// Integration tests for the Matter power outlet. Runs the built plugin (dist/)
// against a fake ADCP projector over real TCP, Homebridge's real HAP and
// PlatformAccessory, and an in-memory stand-in for api.matter that mimics
// Homebridge 2.4's OnOff behavior (handler first; state changes only on success).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

const require = createRequire(import.meta.url);
const hap = require('@homebridge/hap-nodejs');
const { PlatformAccessory } = await import(new URL('../node_modules/homebridge/dist/platformAccessory.js', import.meta.url));
const { SonyADCPPlatform } = require('../dist/platform.js');

const PASSWORD = 'test-password';

// ---- fake projector ------------------------------------------------------
function fakeProjector({ password = PASSWORD } = {}) {
  const dev = {
    power: 'standby',
    input: 'hdmi1',
    commands: [],
    reject: new Set(), // commands answered with err_inactive
    silent: false, // accept connections but never answer (timeout)
    serial: null, // serialnum reply (null: err_cmd)
  };
  const server = net.createServer((sock) => {
    if (dev.silent) return;
    const nonce = crypto.randomBytes(8).toString('hex');
    let authed = !password;
    sock.write((password ? nonce : 'NOKEY') + '\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!authed) {
          const ok = line === crypto.createHash('sha256').update(nonce + password).digest('hex');
          sock.write(ok ? 'OK\r\n' : 'err_auth\r\n');
          authed = ok;
          continue;
        }
        dev.commands.push(line);
        sock.write(reply(line) + '\r\n');
      }
    });
    sock.on('error', () => {});
  });
  const reply = (cmd) => {
    if (dev.reject.has(cmd)) return 'err_inactive';
    if (cmd === 'power_status ?') return `"${dev.power}"`;
    if (cmd === 'input ?') return `"${dev.input}"`;
    if (cmd === 'power "on"') { dev.power = 'startup'; return 'ok'; }
    if (cmd === 'power "off"') { dev.power = 'cooling1'; return 'ok'; }
    if (cmd === 'serialnum ?' && dev.serial) return `"${dev.serial}"`;
    if (/^(modelname|serialnum|version) \?$/.test(cmd)) return 'err_cmd';
    return 'err_cmd';
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    dev.port = server.address().port;
    dev.close = () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    resolve(dev);
  }));
}

// ---- api.matter stand-in -------------------------------------------------
function fakeMatter() {
  const m = {
    registered: new Map(), // uuid -> { accessory, clusters }
    registerCalls: 0,
    updates: [],
    unregistered: [],
    deviceTypes: { OnOffOutlet: { name: 'OnOffPlugInUnit', deviceType: 266 } },
    clusterNames: { OnOff: 'onOff', BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation' },
    async registerPlatformAccessories(_p, _n, accs) {
      m.registerCalls++;
      for (const a of accs) {
        const prev = m.registered.get(a.UUID);
        m.registered.set(a.UUID, {
          accessory: a,
          // cache-restored endpoints keep their state (as Homebridge does)
          clusters: prev?.clusters ?? {
            ...structuredClone(a.clusters),
            bridgedDeviceBasicInformation: { reachable: true },
          },
        });
      }
    },
    async unregisterPlatformAccessories(_p, _n, accs) { m.unregistered.push(...accs.map((a) => a.UUID)); },
    async getAccessoryState(uuid, cluster) { return m.registered.get(uuid)?.clusters[cluster]; },
    async updateAccessoryState(uuid, cluster, attrs) {
      m.updates.push({ uuid, cluster, attrs });
      Object.assign(m.registered.get(uuid).clusters[cluster], attrs);
    },
    // What HomebridgeOnOffServer (on top of matter.js OnOffServer) does for a
    // controller command: run the plugin handler, then commit; matter.js implements
    // toggle as this.on()/this.off(), which re-enters the on/off path.
    async command(uuid, name) {
      const r = m.registered.get(uuid);
      await r.accessory.handlers.onOff[name]();
      if (name === 'toggle') return m.command(uuid, r.clusters.onOff.onOff ? 'off' : 'on');
      r.clusters.onOff.onOff = name === 'on';
    },
  };
  return m;
}

function fakeApi(apiOpts = {}) {
  const { matterEnabled = true } = apiOpts;
  const api = new EventEmitter();
  api.hap = hap;
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => os.tmpdir() };
  api.external = [];
  api.publishExternalAccessories = (_p, accs) => api.external.push(...accs);
  api.registerPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  api.isMatterEnabled = () => matterEnabled;
  api.serverVersion = apiOpts.serverVersion ?? '2.4.0';
  // Same semantics as Homebridge's API.versionGreaterOrEqual for plain x.y.z.
  api.versionGreaterOrEqual = (v) => {
    const [a, b] = [api.serverVersion, v].map((x) => x.split('-')[0].split('.').map(Number));
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return !api.serverVersion.includes('-');
  };
  api.matter = matterEnabled ? fakeMatter() : undefined;
  return api;
}

const log = Object.assign(() => {}, {
  lines: [],
  info(m) { log.lines.push(['info', m]); },
  warn(m) { log.lines.push(['warn', m]); },
  error(m) { log.lines.push(['error', m]); },
  debug() {},
});

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function launch(dev, config = {}, apiOpts = {}, cachedMatter = []) {
  const api = fakeApi(apiOpts);
  const platform = new SonyADCPPlatform(log, {
    platform: 'SonyADCPProjector', name: 'Sony VPL-XW5000', host: '127.0.0.1', port: dev.port,
    password: PASSWORD, timeout: 2, pollInterval: 3600, matterPower: true, matterPowerName: 'Projector Power',
    ...config,
  }, api);
  for (const c of cachedMatter) platform.configureMatterAccessory(c);
  api.emit('didFinishLaunching');
  await settle(300); // start(): publish + first tick
  const tv = api.external[0]?.getService(hap.Service.Television);
  const outletUuid = api.matter && [...api.matter.registered.keys()][0];
  const outlet = () => api.matter.registered.get(outletUuid).clusters;
  const stop = () => api.emit('shutdown');
  return { api, platform, tv, outletUuid, outlet, stop };
}

// ---- tests ---------------------------------------------------------------

test('publishes one OnOffOutlet with a stable UUID; HAP TV UUID unchanged', async () => {
  const dev = await fakeProjector();
  const a = await launch(dev);
  const b = await launch(dev);
  try {
    assert.equal(a.api.matter.registered.size, 1);
    const { accessory } = a.api.matter.registered.get(a.outletUuid);
    assert.equal(accessory.deviceType.name, 'OnOffPlugInUnit');
    assert.equal(accessory.displayName, 'Projector Power');
    assert.equal(a.outletUuid, b.outletUuid, 'Matter UUID stable across restarts');
    assert.equal(a.outletUuid, hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:matter-power'));
    assert.equal(a.api.external[0].UUID, hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:tv'), 'TV UUID as in v1.0.7');
    assert.notEqual(a.outletUuid, a.api.external[0].UUID);
  } finally { a.stop(); b.stop(); await dev.close(); }
});

test('Matter on/off send explicit ADCP commands and update HomeKit', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.commands.length = 0;
    await t.api.matter.command(t.outletUuid, 'on');
    assert.deepEqual(dev.commands, ['power "on"']);
    assert.equal(t.outlet().onOff.onOff, true);
    assert.equal(t.tv.getCharacteristic(hap.Characteristic.Active).value, 1);

    dev.power = 'on';
    dev.commands.length = 0;
    await t.api.matter.command(t.outletUuid, 'off');
    assert.deepEqual(dev.commands, ['power "off"']);
    assert.equal(t.outlet().onOff.onOff, false);
    assert.equal(t.tv.getCharacteristic(hap.Characteristic.Active).value, 0);
  } finally { t.stop(); await dev.close(); }
});

test('toggle is resolved into an explicit command', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.commands.length = 0;
    await t.api.matter.command(t.outletUuid, 'toggle');
    assert.deepEqual(dev.commands, ['power "on"']);
  } finally { t.stop(); await dev.close(); }
});

test('rejected command fails the Matter command and leaves state unchanged', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.reject.add('power "on"');
    await assert.rejects(t.api.matter.command(t.outletUuid, 'on'), /err_inactive.*standby/);
    assert.equal(t.outlet().onOff.onOff, false);
    assert.equal(t.tv.getCharacteristic(hap.Characteristic.Active).value, 0);
  } finally { t.stop(); await dev.close(); }
});

test('rejected but redundant command (already on) succeeds', async () => {
  const dev = await fakeProjector();
  dev.power = 'on';
  const t = await launch(dev);
  try {
    dev.reject.add('power "on"');
    await t.api.matter.command(t.outletUuid, 'on');
    assert.equal(t.outlet().onOff.onOff, true);
  } finally { t.stop(); await dev.close(); }
});

test('unreachable projector: command fails; outlet marked unreachable after repeated failed polls', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.silent = true;
    await assert.rejects(t.api.matter.command(t.outletUuid, 'on'), /timeout/);
    assert.equal(t.outlet().onOff.onOff, false);
    for (let i = 0; i < 3; i++) await t.platform.tick();
    await settle();
    assert.equal(t.outlet().bridgedDeviceBasicInformation.reachable, false);
    dev.silent = false;
    await t.platform.tick();
    await settle();
    assert.equal(t.outlet().bridgedDeviceBasicInformation.reachable, true);
  } finally { t.stop(); await dev.close(); }
});

test('remote / Apple Home changes are mirrored into Matter by the existing poll', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.power = 'on'; // remote control
    await t.platform.tick();
    await settle();
    assert.equal(t.outlet().onOff.onOff, true);

    dev.power = 'cooling1'; // transitional: shows target (off), like the HomeKit tile
    await t.platform.tick();
    await settle();
    assert.equal(t.outlet().onOff.onOff, false);

    dev.power = 'standby';
    await t.platform.tick();
    await settle();
    assert.equal(t.outlet().onOff.onOff, false);

    // Apple Home turns it on: Matter follows once the projector accepted the command.
    t.tv.getCharacteristic(hap.Characteristic.Active).setValue(1);
    await settle(200);
    assert.equal(t.outlet().onOff.onOff, true);
  } finally { t.stop(); await dev.close(); }
});

test('first poll after a restart mid-cool-down reports off, not on', async () => {
  const dev = await fakeProjector();
  dev.power = 'cooling1';
  const t = await launch(dev);
  try {
    await settle();
    assert.equal(t.outlet().onOff.onOff, false);
    assert.equal(t.tv.getCharacteristic(hap.Characteristic.Active).value, 0);
  } finally { t.stop(); await dev.close(); }
});

test('failed Apple Home command reverts HomeKit and never touches Matter', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.reject.add('power "on"');
    t.api.matter.updates.length = 0;
    t.tv.getCharacteristic(hap.Characteristic.Active).setValue(1);
    await settle(200);
    assert.equal(t.tv.getCharacteristic(hap.Characteristic.Active).value, 0);
    assert.equal(t.outlet().onOff.onOff, false);
    assert.deepEqual(t.api.matter.updates.filter((u) => u.cluster === 'onOff'), []);
  } finally { t.stop(); await dev.close(); }
});

test('one poll = one power_status + one input read (no duplicate polling)', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    dev.commands.length = 0;
    await t.platform.tick();
    assert.deepEqual(dev.commands, ['power_status ?', 'input ?']);
  } finally { t.stop(); await dev.close(); }
});

test('option off (default): nothing published; a cached outlet is removed', async () => {
  const dev = await fakeProjector();
  const cachedUuid = hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:matter-power');
  const t = await launch(dev, { matterPower: undefined }, {}, [{ UUID: cachedUuid, displayName: 'x' }]);
  try {
    assert.equal(t.api.matter.registerCalls, 0);
    assert.deepEqual(t.api.matter.unregistered, [cachedUuid]);
    assert.ok(t.tv, 'HomeKit TV still published');
  } finally { t.stop(); await dev.close(); }
});

test('cached outlet is kept (re-attached) when the option stays on', async () => {
  const dev = await fakeProjector();
  const cachedUuid = hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:matter-power');
  const t = await launch(dev, {}, {}, [{ UUID: cachedUuid, displayName: 'Projector Power' }]);
  try {
    assert.deepEqual(t.api.matter.unregistered, []);
    assert.equal(t.outletUuid, cachedUuid);
  } finally { t.stop(); await dev.close(); }
});

test('Homebridge older than 2.3.0: warns, no outlet published or unregistered, TV unaffected', async () => {
  const dev = await fakeProjector();
  log.lines.length = 0;
  const cachedUuid = hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:matter-power');
  const t = await launch(dev, {}, { serverVersion: '2.2.1' }, [{ UUID: cachedUuid, displayName: 'x' }]);
  try {
    assert.ok(log.lines.some(([l, m]) => l === 'warn' && /needs Homebridge 2\.3\.0 or newer \(running 2\.2\.1\)/.test(m)));
    assert.equal(t.api.matter.registerCalls, 0);
    assert.deepEqual(t.api.matter.unregistered, [], 'cached outlet left alone');
    assert.ok(t.tv);
  } finally { t.stop(); await dev.close(); }
});

test('a new outlet gets the projector\'s serial number', async () => {
  const dev = await fakeProjector();
  dev.serial = '5000720';
  const t = await launch(dev);
  try {
    assert.equal(t.api.matter.registered.get(t.outletUuid).accessory.serialNumber, '5000720');
  } finally { t.stop(); await dev.close(); }
});

test('a cached outlet registers without waiting for the projector', async () => {
  const dev = await fakeProjector();
  dev.silent = true; // identity query would take the full timeout
  const cachedUuid = hap.uuid.generate('homebridge-sony-adcp:127.0.0.1:matter-power');
  const t = await launch(dev, {}, {}, [{ UUID: cachedUuid, displayName: 'Projector Power' }]);
  try {
    assert.equal(t.outletUuid, cachedUuid, 'registered within the start-up settle');
  } finally { t.stop(); await dev.close(); }
});

test('serial number without a projector serial: derived from the ID, not the IP address', async () => {
  const dev = await fakeProjector();
  const t = await launch(dev);
  try {
    const { accessory } = t.api.matter.registered.get(t.outletUuid);
    assert.ok(!accessory.serialNumber.includes('127.0.0.1'));
    assert.equal(accessory.serialNumber, t.outletUuid.replace(/-/g, ''));
    assert.ok(Buffer.byteLength(accessory.serialNumber) <= 32);
  } finally { t.stop(); await dev.close(); }
});

test('Matter disabled on the bridge: warns, HomeKit unaffected', async () => {
  const dev = await fakeProjector();
  log.lines.length = 0;
  const t = await launch(dev, {}, { matterEnabled: false });
  try {
    assert.ok(log.lines.some(([l, m]) => l === 'warn' && /Matter is not enabled/.test(m)));
    assert.ok(t.tv);
  } finally { t.stop(); await dev.close(); }
});

test('over-long name is trimmed to 32 bytes on a character boundary', async () => {
  const dev = await fakeProjector();
  // 31 ASCII bytes + 'é' (2 bytes): the limit falls inside the last character.
  const t = await launch(dev, { matterPowerName: 'Main Home Theater Projector Café' });
  try {
    const name = t.api.matter.registered.get(t.outletUuid).accessory.displayName;
    assert.equal(name, 'Main Home Theater Projector Caf');
    assert.ok(Buffer.byteLength(name) <= 32);
  } finally { t.stop(); await dev.close(); }
});
