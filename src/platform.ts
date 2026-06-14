import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  API, APIEvent, Categories, Characteristic, CharacteristicValue,
  DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';

import { AdcpClient } from './adcp-client';
import {
  PLUGIN_NAME, PLATFORM_NAME, KNOWN_MODES, DEFAULT_MODES, MODE_ALIASES, DEFAULT_HDMI_INPUTS,
  ModeDef, HdmiDef,
} from './settings';

// ADCP error replies are `err_*` (err_cmd, err_inactive, err_option, err_val, …).
const isErr = (reply: string): boolean => /^err/i.test(reply);

type ChannelKind = 'pictureModes' | 'hdmiInputs';
type Role = 'input' | 'switch';

interface ChannelItem {
  token: string;
  name: string;
}

interface Channel {
  kind: ChannelKind;
  items: ChannelItem[];
  tokens: Set<string>;
  readCmd: string;
  writeCmd: (token: string) => string;
  normalize: (reported: string) => string;
}

interface ProjectorConfig extends PlatformConfig {
  host?: string;
  port?: number;
  password?: string;
  timeout?: number;
  pollInterval?: number;
  inputSource?: string;
  companionSwitches?: string;
  companionName?: string;
  pictureModes?: Array<{ mode?: string; customMode?: string; name?: string }>;
  hdmiInputs?: Array<{ input?: string; name?: string }>;
}

/**
 * Both "picture modes" and "HDMI inputs" are selector channels: a list of
 * options where exactly one is active, read/written over ADCP. One channel
 * drives the Television's input list (`inputSource`); the other can be exposed
 * as a radio group of switches on a companion accessory (`companionSwitches`).
 */
export class SonyADCPPlatform implements DynamicPlatformPlugin {
  private readonly config: ProjectorConfig;

  private name!: string;
  private client!: AdcpClient;
  private pollMs!: number;
  private channels!: Record<ChannelKind, Channel>;
  private inputSource!: ChannelKind;
  private inputChannel!: Channel;
  private switchChannel: Channel | null = null;
  private persistPath!: string;
  private visibility: Record<string, number> = {};

  private readonly tokenToId = new Map<string, number>();
  private readonly idToToken = new Map<number, string>();
  private readonly switchServices = new Map<string, Service>();
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  private readonly state: { power: boolean; identifier: number; switchActive: string | null } =
    { power: false, identifier: 1, switchActive: null };

  // Set in _start once the running HAP and accessory exist.
  private Char!: typeof Characteristic;
  private infoService!: Service;
  private tv!: Service;

  // Poll/transition bookkeeping (lazily set).
  private _timer?: NodeJS.Timeout;
  private _ticking = false;
  private _pictureInactiveLogged = false;
  private _lastStablePower = false;
  private _prevPower?: string;
  private _warmFrom: string | null = null;
  private _warmStart: number | null = null;
  private _powerCmdAt: number | null = null;
  private _powerCmdTarget = false;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.config = (config || {}) as ProjectorConfig;

    if (!this.config.host) {
      this.log.error('Missing "host" in config — the platform is disabled.');
      return;
    }

    this.name = this.config.name || 'Projector';
    this.client = new AdcpClient({
      host: this.config.host,
      port: this.config.port || 53595,
      password: this.config.password || '',
      timeout: Math.max(2, this.config.timeout || 5) * 1000,
    });
    this.pollMs = Math.max(2, this.config.pollInterval || 5) * 1000;

    // --- channels ---
    const modes = this.resolveModes(this.config.pictureModes);
    const hdmi = this.resolveHdmi(this.config.hdmiInputs);
    this.channels = {
      pictureModes: this.makeChannel('pictureModes', modes),
      hdmiInputs: this.makeChannel('hdmiInputs', hdmi.map((h) => ({ token: h.input, name: h.name }))),
    };

    // Which channel is the TV input list, and which (if any) is the switch group.
    // Defaults: HDMI as the TV inputs (the standard TV model) and no companion tile
    // — the companion is opt-in via companionSwitches.
    this.inputSource = this.config.inputSource === 'pictureModes' ? 'pictureModes' : 'hdmiInputs';
    this.inputChannel = this.channels[this.inputSource];

    const comp = this.config.companionSwitches || 'none';
    let switchKind: ChannelKind | null = null;
    if (comp === 'auto') switchKind = this.inputSource === 'pictureModes' ? 'hdmiInputs' : 'pictureModes';
    else if (comp === 'pictureModes' || comp === 'hdmiInputs') switchKind = comp;
    this.switchChannel = switchKind ? this.channels[switchKind] : null;

    // input identifier maps (1-based, in configured order)
    this.inputChannel.items.forEach((it, i) => {
      this.tokenToId.set(it.token, i + 1);
      this.idToToken.set(i + 1, it.token);
    });

    // Per-input show/hide, persisted by token (external accessories don't keep
    // context across restarts, so we store it ourselves next to Homebridge's data).
    this.persistPath = join(this.api.user.storagePath(), `${PLUGIN_NAME}-${this.config.host}.json`);
    this.visibility = this.loadVisibility();

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.start().catch((e) => this.log.error(`startup failed: ${e.message}`));
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      if (this._timer) clearInterval(this._timer);
    });
  }

  // The TV is external (recreated each launch); the companion is a bridged
  // accessory, so Homebridge restores it here before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private makeChannel(kind: ChannelKind, items: ChannelItem[]): Channel {
    const aliases: Record<string, string> = kind === 'pictureModes' ? MODE_ALIASES : {};
    return {
      kind,
      items,
      tokens: new Set(items.map((it) => it.token)),
      readCmd: kind === 'pictureModes' ? 'picture_mode ?' : 'input ?',
      writeCmd: (token: string) => (kind === 'pictureModes' ? `picture_mode "${token}"` : `input "${token}"`),
      normalize: (reported: string) => aliases[reported] || reported,
    };
  }

  // Accept any value so the plugin is model-agnostic — the projector is the source
  // of truth (an unsupported value is logged + reverted at runtime by applySelection).
  // Known XW values get a friendly default label; unknown ones fall back to the value.
  private resolveModes(
    configured?: Array<{ mode?: string; customMode?: string; name?: string }>,
  ): ModeDef[] {
    if (!Array.isArray(configured) || configured.length === 0) return DEFAULT_MODES.slice();
    const out: ModeDef[] = [];
    for (const entry of configured) {
      // The dropdown's "Custom…" option stores mode='custom'; the real value is then
      // in customMode. A plain mode (dropdown pick or JSON editor) is used directly.
      const selected = entry?.mode?.trim();
      const value = selected === 'custom' ? entry?.customMode?.trim() : selected;
      if (!value) continue; // skip blank rows / Custom with no value
      const known = KNOWN_MODES.find((p) => p.token === value);
      const name = (entry?.name && String(entry.name).trim()) || known?.name || value;
      out.push({ token: value, name });
    }
    return out.length ? out : DEFAULT_MODES.slice();
  }

  private resolveHdmi(configured?: Array<{ input?: string; name?: string }>): HdmiDef[] {
    if (!Array.isArray(configured) || configured.length === 0) return DEFAULT_HDMI_INPUTS.slice();
    const out: HdmiDef[] = [];
    for (const entry of configured) {
      const input = entry?.input?.trim();
      if (!input) continue;
      out.push({ input, name: (entry.name && String(entry.name).trim()) || input.toUpperCase() });
    }
    return out.length ? out : DEFAULT_HDMI_INPUTS.slice();
  }

  private async start(): Promise<void> {
    const { Service: Svc, Characteristic: Char, uuid } = this.api.hap;
    this.Char = Char;

    // ===== Television accessory =====
    const tvUuid = uuid.generate(`${PLUGIN_NAME}:${this.config.host}:tv`);
    const tvAcc = new this.api.platformAccessory(this.name, tvUuid, Categories.TELEVISION);

    this.infoService = tvAcc.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Sony')
      .setCharacteristic(Char.Model, 'VPL (ADCP)')
      .setCharacteristic(Char.SerialNumber, this.config.host!);

    const tv = tvAcc.addService(Svc.Television, this.name);
    tv.setCharacteristic(Char.ConfiguredName, this.name);
    tv.setCharacteristic(Char.SleepDiscoveryMode, Char.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    tv.setCharacteristic(Char.Active, Char.Active.INACTIVE);
    tv.setCharacteristic(Char.ActiveIdentifier, 1);
    tv.getCharacteristic(Char.Active)
      .onGet(() => (this.state.power ? 1 : 0))
      .onSet((value: CharacteristicValue) => this.setPower(value === Char.Active.ACTIVE));
    tv.getCharacteristic(Char.ActiveIdentifier)
      .onGet(() => this.state.identifier)
      .onSet((value: CharacteristicValue) => this.setInput(value as number));

    // Input sources = the chosen channel's items.
    this.inputChannel.items.forEach((item, i) => {
      const id = i + 1;
      const hidden = this.visibility[item.token] === Char.TargetVisibilityState.HIDDEN;
      const visState = hidden ? Char.CurrentVisibilityState.HIDDEN : Char.CurrentVisibilityState.SHOWN;

      const input = tvAcc.addService(Svc.InputSource, item.token, `input-${id}`);
      input
        .setCharacteristic(Char.Identifier, id)
        .setCharacteristic(Char.ConfiguredName, item.name)
        .setCharacteristic(Char.IsConfigured, Char.IsConfigured.CONFIGURED)
        .setCharacteristic(Char.InputSourceType, Char.InputSourceType.HDMI)
        .setCharacteristic(Char.CurrentVisibilityState, visState)
        .setCharacteristic(Char.TargetVisibilityState, visState);
      input.getCharacteristic(Char.TargetVisibilityState).onSet((value: CharacteristicValue) => {
        this.visibility[item.token] = value as number;
        input.updateCharacteristic(Char.CurrentVisibilityState, value as number);
        this.saveVisibility();
      });
      tv.addLinkedService(input);
    });

    this.tv = tv;
    this.api.publishExternalAccessories(PLUGIN_NAME, [tvAcc]);
    this.log.info(`Published "${this.name}" TV — inputs: ${this.inputSource} (${this.inputChannel.items.length}).`);

    // Companion switches are a *bridged* accessory so they can be added/removed
    // cleanly when the group changes (external accessories can't be un-published).
    this.setupCompanion();

    this.refreshIdentity().catch(() => { /* best-effort */ });
    await this.tick();
    this._timer = setInterval(() => this.tick(), this.pollMs);
  }

  // Add/restore/remove the bridged companion. Its UUID is tied to the group it
  // represents, so switching pictureModes<->hdmiInputs cleanly removes the old one and adds
  // the new one; setting companionSwitches to "none" removes it entirely.
  private setupCompanion(): void {
    const { uuid } = this.api.hap;
    const desiredUuid = this.switchChannel
      ? uuid.generate(`${PLUGIN_NAME}:${this.config.host}:switches:${this.switchChannel.kind}`)
      : null;

    // Any cached companion that isn't the desired one is stale -> unregister it.
    const stale: PlatformAccessory[] = [];
    for (const [u, acc] of this.cachedAccessories) {
      if (u !== desiredUuid) stale.push(acc);
    }
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach((a) => this.cachedAccessories.delete(a.UUID));
      this.log.info(`Removed ${stale.length} stale companion accessory(ies).`);
    }

    if (!this.switchChannel) return;

    const compName = this.config.companionName
      || `${this.name} ${this.switchChannel.kind === 'pictureModes' ? 'Picture Modes' : 'Inputs'}`;
    let acc = this.cachedAccessories.get(desiredUuid!);
    const isNew = !acc;
    if (!acc) acc = new this.api.platformAccessory(compName, desiredUuid!, Categories.SWITCH);

    this.buildCompanion(acc);

    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.log.info(`Added companion "${compName}" (${this.switchChannel.items.length} ${this.switchChannel.kind} switch(es)).`);
    } else {
      this.api.updatePlatformAccessories([acc]);
      this.log.info(`Updated companion "${compName}".`);
    }
  }

  // Reconcile the companion's Switch services to the configured items (handlers are
  // never persisted, so they're (re)wired every launch; stale switches are removed).
  private buildCompanion(accessory: PlatformAccessory): void {
    const { Service: Svc, Characteristic: Char } = this.api.hap;
    const channel = this.switchChannel!;
    accessory.getService(Svc.AccessoryInformation)!
      .setCharacteristic(Char.Manufacturer, 'Sony')
      .setCharacteristic(Char.Model, 'VPL (ADCP)')
      .setCharacteristic(Char.SerialNumber, `${this.config.host}:${channel.kind}`);

    const desired = new Set(channel.items.map((it) => `sw-${it.token}`));
    for (const svc of accessory.services.filter((s) => !!s.subtype && s.subtype.startsWith('sw-') && !desired.has(s.subtype))) {
      accessory.removeService(svc);
    }

    this.switchServices.clear();
    for (const item of channel.items) {
      const subtype = `sw-${item.token}`;
      const svc = accessory.getServiceById(Svc.Switch, subtype)
        || accessory.addService(Svc.Switch, item.name, subtype);
      // Switch doesn't list ConfiguredName as a standard characteristic; declare it
      // so HomeKit gets a renamable name without HAP's "not in ... section" warning.
      if (!svc.testCharacteristic(Char.ConfiguredName)) svc.addOptionalCharacteristic(Char.ConfiguredName);
      svc.setCharacteristic(Char.ConfiguredName, item.name);
      svc.getCharacteristic(Char.On)
        .onGet(() => this.state.switchActive === item.token)
        .onSet((value: CharacteristicValue) => this.setSwitch(item.token, Boolean(value)));
      this.switchServices.set(item.token, svc);
    }
  }

  private loadVisibility(): Record<string, number> {
    try {
      const data = JSON.parse(readFileSync(this.persistPath, 'utf8'));
      return (data && typeof data.visibility === 'object' && data.visibility) || {};
    } catch {
      return {}; // missing/unreadable file -> everything shown by default
    }
  }

  private saveVisibility(): void {
    try {
      writeFileSync(this.persistPath, JSON.stringify({ visibility: this.visibility }, null, 2));
    } catch (e) {
      this.log.warn(`could not persist input visibility: ${(e as Error).message}`);
    }
  }

  private async refreshIdentity(): Promise<void> {
    try {
      const model = await this.client.send('modelname ?');
      if (model && !isErr(model)) this.infoService.updateCharacteristic(this.Char.Model, model);
      const serial = await this.client.send('serialnum ?');
      if (serial && !isErr(serial)) this.infoService.updateCharacteristic(this.Char.SerialNumber, serial);
      const version = await this.client.send('version ?');
      const fw = isErr(version) ? null : this.firmwareFromVersion(version);
      if (fw) this.infoService.updateCharacteristic(this.Char.FirmwareRevision, fw);
    } catch (e) {
      this.log.debug(`identity query failed: ${(e as Error).message}`);
    }
  }

  // `version ?` returns e.g. [{"main":"1.012"},{"laser":"21/00/00/00/00"}]; pull the
  // main firmware version for HomeKit's FirmwareRevision (must be numeric x.y[.z]).
  private firmwareFromVersion(raw: string): string | null {
    try {
      const parsed = JSON.parse(raw);
      const merged: Record<string, unknown> = Array.isArray(parsed) ? Object.assign({}, ...parsed) : parsed;
      const main = merged.main;
      if (typeof main === 'string' && /^\d+(\.\d+)*$/.test(main.trim())) return main.trim();
    } catch { /* not JSON / unexpected shape — leave FirmwareRevision unset */ }
    return null;
  }

  private async powerStatus(): Promise<string> {
    return (await this.client.send('power_status ?')).toLowerCase();
  }

  // Time how long the projector spends transitioning between its stable states
  // (standby <-> on) via the intermediate states (startup/cooling), and log it so
  // users can size the wait steps in their automations/shortcuts. Granularity is
  // the poll interval, hence "~". Catches both HomeKit- and remote-initiated power.
  private trackPowerTiming(ps: string): void {
    if (ps === this._prevPower) return;
    const prev = this._prevPower;
    this._prevPower = ps;
    if (prev === undefined) return; // first observation: establish baseline only

    const stable = (s: string): boolean => s === 'on' || s === 'standby';
    if (stable(prev) && !stable(ps)) {
      this._warmFrom = prev;
      this._warmStart = Date.now();
    } else if (stable(ps)) {
      if (this._warmStart != null && this._warmFrom && this._warmFrom !== ps) {
        const secs = ((Date.now() - this._warmStart) / 1000).toFixed(1);
        const label = ps === 'on' ? 'warm-up (standby → on)' : 'cool-down (on → standby)';
        this.log.info(`Projector ${label} took ~${secs}s.`);
      }
      this._warmStart = null;
      this._warmFrom = null;
    }
  }

  // Poll: reconcile power, the active input, and the active switch into HomeKit.
  // Re-entrancy guard: skip a tick if the previous one is still in flight.
  private async tick(): Promise<void> {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const ps = await this.powerStatus();
      this.trackPowerTiming(ps);

      // Power display. In a transitional state (startup/cooling) show the TARGET —
      // the opposite of the last stable state — so the tile doesn't flicker
      // on->off->on during the ~12s warm-up (or off->on->off during cool-down).
      let power: boolean;
      if (ps === 'on') power = true;
      else if (ps === 'standby') power = false;
      else power = !this._lastStablePower;
      if (ps === 'on' || ps === 'standby') this._lastStablePower = power;

      // Honor a just-issued power command over a stale contradicting reading during
      // the command-latency window (the projector may briefly still report standby).
      if (this._powerCmdAt != null) {
        if (power === this._powerCmdTarget || Date.now() - this._powerCmdAt > 8000) this._powerCmdAt = null;
        else power = this._powerCmdTarget;
      }

      if (power !== this.state.power) {
        this.state.power = power;
        this.tv.updateCharacteristic(this.Char.Active, power ? 1 : 0);
      }

      // Channels are read only when fully on (picture_mode needs that; HDMI input
      // is read regardless inside syncChannel).
      const on = ps === 'on';
      await this.syncChannel(this.inputChannel, 'input', on);
      if (this.switchChannel) await this.syncChannel(this.switchChannel, 'switch', on);
    } catch (e) {
      this.log.debug(`poll: ${(e as Error).message}`);
    } finally {
      this._ticking = false;
    }
  }

  // Read a channel's current value and reflect it into the matching HomeKit control.
  // HDMI inputs are readable/meaningful in any power state; picture modes are not
  // readable in standby, so when off we clear mode switches (nothing is active) and
  // leave the TV input highlight as-is (the tile shows off anyway).
  private async syncChannel(channel: Channel, role: Role, on: boolean): Promise<void> {
    if (channel.kind === 'pictureModes' && !on) {
      if (role === 'switch' && this.state.switchActive !== null) {
        this.state.switchActive = null;
        this.syncSwitches();
      }
      return;
    }
    const reported = await this.client.send(channel.readCmd);
    if (isErr(reported)) {
      if (channel.kind === 'pictureModes' && reported === 'err_inactive' && !this._pictureInactiveLogged) {
        this.log.debug('picture_mode is unreadable (projector on, no live input signal) — picture-mode state will not update until a source is active.');
        this._pictureInactiveLogged = true;
      }
      return;
    }
    if (channel.kind === 'pictureModes') this._pictureInactiveLogged = false;
    const token = channel.normalize(reported);
    const known = channel.tokens.has(token);
    if (role === 'input') {
      // If the projector is on a value we don't expose (common with picture modes, since
      // you typically expose only a few of them), show "no input selected"
      // (identifier 0 matches no InputSource) instead of a stale, wrong highlight.
      const id = known ? (this.tokenToId.get(token) ?? 0) : 0;
      if (id !== this.state.identifier) {
        this.state.identifier = id;
        this.tv.updateCharacteristic(this.Char.ActiveIdentifier, id);
      }
    } else {
      // Switch role: reflect the active mode, or clear ALL switches if the
      // projector is on a mode that isn't one of the configured switches.
      const active = known ? token : null;
      if (active !== this.state.switchActive) {
        this.state.switchActive = active;
        this.syncSwitches();
      }
    }
  }

  private syncSwitches(): void {
    for (const [token, svc] of this.switchServices) {
      svc.updateCharacteristic(this.Char.On, token === this.state.switchActive);
    }
  }

  // HomeKit -> device. Optimistic: update local state now, run protocol in background.
  private setPower(on: boolean): void {
    this.state.power = on;
    this._powerCmdAt = Date.now();
    this._powerCmdTarget = on;
    void (async () => {
      try {
        const r = await this.client.send(on ? 'power "on"' : 'power "off"');
        if (isErr(r)) this.log.warn(`power ${on ? 'on' : 'off'} -> ${r}`);
      } catch (e) {
        this.log.warn(`power ${on ? 'on' : 'off'} failed: ${(e as Error).message}`);
      }
    })();
  }

  private setInput(id: number): void {
    const token = this.idToToken.get(id);
    if (!token) return;
    const previous = this.state.identifier;
    this.state.identifier = id;
    this.applyOrRevert(this.inputChannel, token, () => {
      this.state.identifier = previous;
      this.tv.updateCharacteristic(this.Char.ActiveIdentifier, previous);
    });
  }

  // Radio-group switch: turning one on selects it and clears the rest; turning the
  // active one off is meaningless (there's always a selection) so we snap it back.
  // If the selection can't actually be applied (e.g. no signal), revert to before.
  private setSwitch(token: string, value: boolean): void {
    if (value) {
      const previous = this.state.switchActive;
      this.state.switchActive = token;
      this.syncSwitches();
      this.applyOrRevert(this.switchChannel!, token, () => {
        this.state.switchActive = previous;
        this.syncSwitches();
      });
    } else if (this.state.switchActive === token) {
      const svc = this.switchServices.get(token);
      setTimeout(() => svc && svc.updateCharacteristic(this.Char.On, true), 50);
    }
  }

  // Apply a selection in the background; if the projector rejects it (or it errors),
  // run revert() to restore the optimistic HomeKit state.
  private applyOrRevert(channel: Channel, token: string, revert: () => void): void {
    this.applySelection(channel, token)
      .then((ok) => { if (!ok) revert(); })
      .catch((e) => { this.log.warn(`set ${channel.kind} failed: ${(e as Error).message}`); revert(); });
  }

  // Apply a channel selection in the projector's CURRENT power state. It never
  // powers the projector on — only the TV power control does that. HDMI input
  // selection works even in standby; picture modes need the projector on with a
  // live signal and are rejected (err_inactive) otherwise. Returns true if applied,
  // false if the projector rejected it (the caller then reverts HomeKit state).
  private async applySelection(channel: Channel, token: string): Promise<boolean> {
    const r = await this.client.send(channel.writeCmd(token));
    if (isErr(r)) {
      const ps = await this.powerStatus();
      const reason = ps !== 'on' ? `projector status: ${ps}` : 'no live input signal';
      const noun = channel.kind === 'pictureModes' ? 'mode' : 'input';
      this.log.info(`Can't set ${noun} "${token}" (${reason}) — reverting.`);
      return false;
    }
    return true;
  }
}
