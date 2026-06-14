// Plugin + platform identifiers. PLATFORM_NAME must match `platform` in config.json.
export const PLUGIN_NAME = 'homebridge-sony-adcp';
export const PLATFORM_NAME = 'SonyADCPProjector';

export interface ModeDef {
  token: string;
  name: string;
}

export interface HdmiDef {
  input: string;
  name: string;
}

// The full set of picture_mode values the VPL-XW series accepts, with default
// HomeKit labels. Verified live against a VPL-XW5100 (the web UI's own schema).
// Note: `user3` is the User 3 calibration slot; on units configured for it that
// slot holds "IMAX Enhanced" (no dedicated IMAX command exists).
export const KNOWN_MODES: ModeDef[] = [
  { token: 'cinema_film1', name: 'Cinema Film 1' },
  { token: 'cinema_film2', name: 'Cinema Film 2' },
  { token: 'cinema_digital', name: 'Cinema Digital' },
  { token: 'reference', name: 'Reference' },
  { token: 'tv', name: 'TV' },
  { token: 'photo', name: 'Photo' },
  { token: 'game', name: 'Game' },
  { token: 'brt_cinema', name: 'Bright Cinema' },
  { token: 'brt_tv', name: 'Bright TV' },
  { token: 'user1', name: 'User 1' },
  { token: 'user2', name: 'User 2' },
  { token: 'user3', name: 'User 3' },
];

// Some units report a configured-slot mode under a bare alias rather than the
// numbered value (e.g. the "User" slot reports `user` instead of `user1`).
// Maps a device-reported value -> the canonical value used in config/inputs,
// so the poll still highlights the right HomeKit input. Selection always sends
// the canonical value (the projector accepts both forms).
export const MODE_ALIASES: Record<string, string> = {
  user: 'user1',
};

// Used when the user hasn't configured a `pictureModes` list.
export const DEFAULT_MODES: ModeDef[] = [
  { token: 'cinema_film1', name: 'Cinema Film 1' },
  { token: 'cinema_film2', name: 'Cinema Film 2' },
  { token: 'reference', name: 'Reference' },
  { token: 'tv', name: 'TV' },
  { token: 'game', name: 'Game' },
];

// Used when the user hasn't configured an `hdmiInputs` list. The XW5100 has two
// HDMI ports; other models may have more (hdmi3/hdmi4) — add them in config.
export const DEFAULT_HDMI_INPUTS: HdmiDef[] = [
  { input: 'hdmi1', name: 'HDMI 1' },
  { input: 'hdmi2', name: 'HDMI 2' },
];
