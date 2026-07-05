# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.5] - 2026-07-06

### Fixed

- `config.schema.json` now uses standard JSON Schema object-level `required` arrays instead of the non-standard per-field `"required": true` flags. No functional change — the settings UI renders and validates exactly as before.

## [1.0.4] - 2026-07-05

### Fixed

- Picture-mode and HDMI-input values from the config are validated before being sent to the projector: values containing quotes or control characters are logged and skipped instead of being interpolated into ADCP command lines. Any other value is still passed through unchanged, keeping the plugin model-agnostic.
- The host is sanitized when building the input-visibility persist filename, so path-capable characters can't alter the path. Filenames for IP addresses and hostnames are unchanged.

### Changed

- Internal: the default picture-mode set is derived from the known-modes list, so labels are single-sourced.

## [1.0.3] - 2026-06-17

### Changed

- Expanded npm keywords for discoverability (homebridge, home-automation, vpl-xw, vpl-vw). No functional changes.

## [1.0.2] - 2026-06-14

### Fixed

- Added Node.js 24 to supported `engines` (was capped at 22, causing an "unsupported Node" warning on Node 24, the current LTS). No other changes.

## [1.0.1] - 2026-06-14

### Fixed

- Documentation only — corrected "picture presets" → "picture modes" wording in the package description, config UI header, and poll-interval description. Behavior identical to 1.0.0.

## [1.0.0] - 2026-06-14

### Added

- First release. Control a Sony ADCP projector (VPL-XW / VW series) as a HomeKit **Television**:
  - **Power** via the TV tile, with warm-up/cool-down handling so the tile doesn't flicker during transitions.
  - **TV inputs** = HDMI sources **or** picture modes (your choice), with the other group available as a companion tile of radio switches.
  - Picture modes exposed via a dropdown (Cinema Film 1/2, Reference, Game, …) plus a **Custom…** option for any model.
  - Talks straight to the projector over Sony's ADCP protocol on your LAN — no cloud.
  - Publishes the projector's real model, serial, and firmware version to HomeKit.
- Written in TypeScript, zero runtime dependencies, Homebridge 1.3+ / 2.x.

[1.0.5]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.5
[1.0.4]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.4
[1.0.3]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.3
[1.0.2]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.2
[1.0.1]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.1
[1.0.0]: https://github.com/keremerkan/homebridge-sony-adcp/releases/tag/v1.0.0
