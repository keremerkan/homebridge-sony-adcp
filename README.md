# homebridge-sony-adcp

A [Homebridge](https://homebridge.io) plugin that exposes a **Sony projector** (VPL‑XW / VW series) to Apple HomeKit as a **Television** accessory. You choose whether the TV's inputs are the projector's **HDMI sources** or its **picture modes**; the other group can appear as a set of switches on a companion tile.

- **Power** ↔ HomeKit power (`Active`)
- **TV inputs** ↔ HDMI sources (HDMI 1/2/…) **or** picture modes (Cinema Film 1/2, Reference, Game, …), your choice
- **Companion switches** ↔ a radio group (mutually exclusive, reflects the active selection) for whichever group isn't the input list

Control is over Sony's **ADCP** (Advanced Display Control Protocol) — a text protocol over TCP, default port `53595`. The plugin talks straight to the projector on your LAN.

## Projector setup (required)

On the projector, enable the ADCP service:

1. **[Advanced Settings] → [ADCP] → [Start ADCP Service] = On**
2. **[Requires Authentication]** — Off is simplest. If you leave it On, the password is the projector's **web administrator password**; set it in this plugin's `password` field.
3. Leave **[Port No.]** at `53595` unless you changed it.
4. Optionally restrict **[Host address list]** to your Homebridge server's IP.

> **Standby/power‑on note:** to turn the projector **on** from HomeKit, the projector must keep its network alive while in standby. If power‑on over IP doesn't work, check the projector's standby/network‑standby setting and enable network control in standby.

> **Power is controlled only by the TV power button.** Selecting an input or mode never powers the projector on — it applies in whatever state the projector is in. HDMI input selection works even in standby; picture modes require the projector on with a live input signal, so selecting one while off (or with no source) logs the reason and reverts the control to its previous state.

## Configuration

Use the Homebridge UI (recommended), or add a platform block to `config.json`:

**Minimal config** — just the host gives you a standard TV with HDMI inputs and no companion tile:

```json
{
  "platform": "SonyADCPProjector",
  "name": "Projector",
  "host": "192.168.1.50"
}
```

**Fuller example** — named HDMI inputs plus an opt-in companion tile of picture-mode switches:

```json
{
  "platform": "SonyADCPProjector",
  "name": "Projector",
  "host": "192.168.1.50",

  "hdmiInputs": [
    { "input": "hdmi1", "name": "Apple TV" },
    { "input": "hdmi2", "name": "PS5" }
  ],

  "companionSwitches": "pictureModes",
  "pictureModes": [
    { "mode": "cinema_film1", "name": "Cinema Film 1" },
    { "mode": "game",         "name": "Game" },
    { "mode": "user3",        "name": "IMAX Enhanced" }
  ]
}
```

### Inputs vs. switches

| Option | Values | Meaning |
|---|---|---|
| `inputSource` | `hdmiInputs` (default) · `pictureModes` | What the Television tile's input picker selects. |
| `companionSwitches` | `none` (default) · `pictureModes` · `hdmiInputs` · `auto` | Expose a group as a radio set of switches on a separate companion tile. `auto` = whichever group isn't the TV input list. |
| `companionName` | string | Optional name for the companion tile (defaults to `<Name> Picture Modes` / `<Name> Inputs`). |

By default you get the standard model — **HDMI sources as the TV inputs, no companion tile**. To also control picture modes, set `companionSwitches: "pictureModes"` (a companion tile of mode switches). To instead make picture modes the TV input list, set `inputSource: "pictureModes"` (see the caveat below).

`pictureModes` and `hdmiInputs` are both add/remove lists. If `pictureModes` is omitted, a default set is used (Cinema Film 1/2, Reference, TV, Game); if `hdmiInputs` is omitted, it defaults to HDMI 1 + HDMI 2.

### ⚠️ Important: which group should be the TV inputs?

**A HomeKit TV input picker can only correctly represent values you've actually exposed**, because its `ActiveIdentifier` has no clean "none" and can't show an off-list value. If the projector is switched (e.g. with the **physical remote**) to an input/mode you did **not** add to the list, the tile just shows **"On"** instead of the input name until it's back on a value you exposed. It's a HomeKit limitation, not a bug — and it applies to **whichever group is the TV inputs**:

- **HDMI inputs:** if you expose only some of the projector's HDMI ports — common when everything is routed through an AVR into a single port — switching the projector to an unexposed port shows "On".
- **Picture modes:** there are 10+ and you'll usually expose only a few, so if the projector is on an unexposed one, the tile will show "On".

**So expose every value you might actually switch to.** For HDMI that's all the projector's physical ports (the default lists HDMI 1 + HDMI 2) — keep them all and the tile stays correct even if you normally use just one. For picture modes, list the ones you use.

**Recommendation:** the most robust setup is **HDMI sources as the TV inputs** (list all ports) with **picture modes as companion switches** (`companionSwitches: "pictureModes"`) — switches handle the off-list case gracefully (they simply go dark, no ambiguous "On"). A single-accessory setup (picture modes as the TV inputs) is fully supported too; just expose the modes you use and know that others show "On".

### Available picture-mode values

The picture-mode field is a **dropdown** of the common VPL‑XW values plus a **"Custom…"** option — pick Custom and a text box appears for any `picture_mode` value, so the plugin works on any Sony ADCP projector. The projector is the validator — a value it doesn't support is logged and reverted at runtime, never silently wrong. (ADCP has no "list capabilities" query, so the dropdown can't be auto-discovered from the device.)

Dropdown picture-mode values (VPL‑XW): `cinema_film1`, `cinema_film2`, `cinema_digital`, `reference`, `tv`, `photo`, `game`, `brt_cinema`, `brt_tv`, `user1`, `user2`, `user3`. HDMI ports: `hdmi1`–`hdmi4` (other inputs: enter via the JSON config editor).

Which modes exist depends on the model and how its User slots are configured. Notes from the VPL‑XW5100:

- The **User 1** slot may report as the bare value `user` — the plugin treats `user` and `user1` as the same input.
- **User 2** may not exist on a given unit (selecting it returns an error).
- **IMAX Enhanced** has no dedicated ADCP command; on units where it's assigned to the **User 3** slot, select it via the `user3` value.

The **Television** is published as an **external accessory** (HomeKit requires it) — it bridges through Homebridge with no separate pairing and appears as its own TV tile; you can rename/reorder/hide its inputs in the Home app, and show/hide choices persist. The **companion switch tile** is a normal **bridged** accessory, so it appears and disappears automatically when you change `inputSource`/`companionSwitches` — no manual cleanup or leftover "No Response" tiles.

## Development

Written in TypeScript; the published package ships compiled JavaScript in `dist/` and has **no runtime dependencies** (only Node's built-in `net`/`crypto`/`fs`).

```bash
npm install      # dev toolchain (TypeScript, types)
npm run build    # compile src/*.ts -> dist/
npm run watch    # recompile on change
```

## License

MIT
