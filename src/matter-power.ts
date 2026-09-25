import type { API, Logging, MatterAccessory } from 'homebridge' with { 'resolution-mode': 'import' };

import { PLUGIN_NAME, PLATFORM_NAME } from './settings';

// BridgedDeviceBasicInformation.NodeLabel is limited to 32 bytes by the Matter spec;
// a longer label makes matter.js reject the whole endpoint.
const NODE_LABEL_MAX_BYTES = 32;
// Bridged registration is refused while the bridge's Matter node is still starting
// (transient); retry a few times instead of silently running without the outlet.
const REGISTER_RETRIES = 5;
const REGISTER_RETRY_MS = 5000;

export interface MatterPowerOptions {
  host: string;
  name: string;
  // Sends an explicit power on/off and resolves only once the projector accepted it;
  // rejects otherwise (the rejection becomes a Matter failure status).
  setPower: (on: boolean) => Promise<void>;
}

/**
 * Exposes projector power as a Matter On/Off Plug-in Unit on the bridge's Matter
 * aggregator, so controllers without HomeKit Television support (e.g. Alexa) get a
 * plain on/off device. It owns no ADCP connection or timer of its own: commands go
 * through the platform's setPower, and the platform's poll pushes state in via sync().
 */
export class MatterPowerOutlet {
  readonly uuid: string;
  private registered = false;

  constructor(
    private readonly log: Logging,
    private readonly api: API,
    private readonly opts: MatterPowerOptions,
  ) {
    // Derived from the host only (like the TV's UUID), so it — and therefore the
    // Matter endpoint id — is stable across restarts and renames.
    this.uuid = api.hap.uuid.generate(`${PLUGIN_NAME}:${opts.host}:matter-power`);
  }

  async register(): Promise<void> {
    const matter = this.api.matter!;
    const accessory: MatterAccessory = {
      UUID: this.uuid,
      displayName: nodeLabel(this.opts.name, this.log),
      deviceType: matter.deviceTypes.OnOffOutlet,
      manufacturer: 'Sony',
      model: 'VPL (ADCP) Power',
      serialNumber: `${this.opts.host}:power`,
      context: {},
      // Off until the first successful poll; a cache-restored endpoint keeps its last state.
      clusters: { onOff: { onOff: false } },
      handlers: {
        onOff: {
          on: () => this.opts.setPower(true),
          off: () => this.opts.setPower(false),
          // matter.js resolves Toggle into this.on()/this.off() from the current Matter
          // state, which runs the explicit handlers above; sending anything here too
          // would issue the power command twice. (A handler must exist regardless.)
          toggle: async () => { /* handled by on/off */ },
        },
      },
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.registered = true;
        this.log.info(`Published Matter power outlet "${accessory.displayName}".`);
        return;
      } catch (e) {
        if (attempt >= REGISTER_RETRIES) {
          this.log.error(`Matter power outlet registration failed: ${(e as Error).message}`);
          return;
        }
        this.log.debug(`Matter power outlet registration deferred (${(e as Error).message}); retrying.`);
        await new Promise((r) => setTimeout(r, REGISTER_RETRY_MS));
      }
    }
  }

  /**
   * Reconcile Matter with the projector's confirmed state. Compares against what the
   * Matter endpoint currently holds rather than a remembered value, so an update lost
   * to a registration race (updates are fire-and-forget) is simply re-sent next poll.
   * `on` is null while the power state is still unknown (no successful poll yet).
   * Must not be called while a Matter command handler is running.
   */
  async sync(on: boolean | null, reachable: boolean): Promise<void> {
    if (!this.registered) return;
    const matter = this.api.matter!;
    try {
      const onOff = await matter.getAccessoryState(this.uuid, matter.clusterNames.OnOff);
      if (!onOff) return; // endpoint not live yet
      if (on !== null && onOff.onOff !== on) {
        await matter.updateAccessoryState(this.uuid, matter.clusterNames.OnOff, { onOff: on });
      }
      const info = await matter.getAccessoryState(this.uuid, matter.clusterNames.BridgedDeviceBasicInformation);
      if (info && info.reachable !== reachable) {
        await matter.updateAccessoryState(this.uuid, matter.clusterNames.BridgedDeviceBasicInformation, { reachable });
      }
    } catch (e) {
      this.log.debug(`Matter power sync failed: ${(e as Error).message}`);
    }
  }
}

// Trim a label to the NodeLabel byte limit on a character boundary.
function nodeLabel(name: string, log: Logging): string {
  if (Buffer.byteLength(name, 'utf8') <= NODE_LABEL_MAX_BYTES) return name;
  let out = name;
  while (Buffer.byteLength(out, 'utf8') > NODE_LABEL_MAX_BYTES) out = Array.from(out).slice(0, -1).join('');
  log.warn(`Matter power outlet name "${name}" exceeds ${NODE_LABEL_MAX_BYTES} bytes — using "${out}".`);
  return out;
}
