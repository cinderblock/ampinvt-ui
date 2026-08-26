# ampinvt-ui

A small desktop app for monitoring and configuring an **AMPINVT TEL-series** off-grid
solar inverter over its USB serial port.

Built for a `TEL-48502M100` (5000 W, 48 V → 120 V, 100 A MPPT), sold as
*"AMPINVT Solar Inverter 5000 Watt 48V to 120V"*. Tauri v2 + React + a hand-rolled
Modbus RTU implementation.

> **The vendor publishes no protocol documentation.** Everything this app knows was
> reverse-engineered against a physical unit. Read [Confidence](#confidence) before
> changing anything.

## Why this is not a generic Modbus tool

A generic Modbus client would show you `0x1103 = 150` and leave you none the wiser. The
value here is entirely in the decoding:

- the address space is **sparse and 256-aligned** — only 13 blocks of 256 exist
- **only function `0x03`** is implemented; `0x04` (input registers) is silent everywhere
- voltage *settings* are stored as **12 V-equivalent tenths** — actual volts = `raw × 0.4`
- voltage *readings* are plain tenths — `raw ÷ 10`. Mixing these up is the easiest
  mistake to make.

That knowledge lives in exactly one file, [`src/registers.ts`](src/registers.ts). The
Rust side ([`src-tauri/src/modbus.rs`](src-tauri/src/modbus.rs)) is plain, device-agnostic
Modbus RTU. Adding a second inverter should be a new map, not a rewrite.

## Link parameters

| | |
|---|---|
| Transport | USB serial, CH340 (`1A86:7523`) |
| Baud / framing | 9600 8N1 |
| Slave address | 1 |
| Read | function `0x03` |
| Write | function `0x06` |
| Poll rate | 1 Hz — the bus does not like being pushed harder |

## Running it

```sh
bun install
bun run tauri dev
```

Release build:

```sh
bun run tauri build
```

## Safety model

This talks to a 5 kW power converter attached to a large lithium battery. The app is
built so that a mistake in the reverse-engineered map is an error message rather than
damage:

1. **Read-only by default.** Writes require an explicit unlock, per session.
2. **Guarded writes.** Every write sends the value the UI last read as `expect`. The
   backend re-reads first and refuses if the device disagrees. If the map is wrong, or
   something else changed the setting, the write fails instead of landing.
3. **Verified writes.** After writing, the register is read back and the app reports
   what the device *actually* holds, not what was requested.
4. **Confirmation step** showing old → new in real units before anything is sent.
5. **Output voltage and frequency are deliberately not writable** from this app.

Do not add a code path that bypasses the `expect` guard.

### Write tiers

Settings are split into two tiers, because they are not equally consequential.

| Tier | Gate | Contents |
|---|---|---|
| `normal` | Unlock writes | Currents, cutoff voltages, SOC thresholds |
| `setup` | Unlock writes **and** Setup mode | Battery type |

**Setup mode** is a second, separately-armed gate with its own confirmation step. It
exists because a `setup` register does not change one value — changing the battery type
makes the inverter immediately rewrite its constant-charge, boost and float voltages to
that profile's defaults, discarding anything tuned by hand.

Registers that cascade declare it (`cascades: [...]` in the map). After such a write the
app diffs those registers and reports what the inverter actually rewrote, for example:

```
✓ wrote L16; device now reads L16
Charge profile rewritten by the inverter: Float voltage 55.2V → 54.4V
```

Leaving setup mode is one click; locking writes exits setup mode too.

## Confidence

Each register carries a confidence level, shown in the UI:

| Level | Meaning |
|---|---|
| **high** | Matches a documented manual default, corroborated by neighbouring registers |
| **medium** | Matches a documented default, but a sibling setting shares that default — the assignment could be swapped |
| **low** | Shape decoded only; meaning is a guess |

Only one mapping has been confirmed by an actual round trip: `0x1103`
(AC charging current), written `400 → 150` with no other register in the block changing.

**Two known ambiguities.** `0x1009` and `0x100a` both hold 130 (52.0 V) because settings
`[35]` and `[37]` share that default; which is which is unresolved. Change one on the
inverter's LCD and see which register moves — that technique settles any `medium` entry.

## What is not implemented yet

PV voltage, PV current, load power and output power are **not identified**. Every
candidate register read zero while the test unit sat idle, making them indistinguishable
from genuinely unused ones. Finding them needs a live diff taken while the inverter is
actually charging or under load. The **Raw registers** tab exists for exactly this: watch
it across a state change and note what moves.

## Register map

See [`src/registers.ts`](src/registers.ts) for the full annotated map. Highlights:

| Register | Setting | Meaning | Scale |
|---|---|---|---|
| `0x0500` | — | Battery voltage (live) | ÷10 |
| `0x1003` | `[07]` | Max charging current | ÷10 A |
| `0x1007` | `[09]` | Boost / absorption voltage | ×0.4 V |
| `0x1008` | `[11]` | Float voltage | ×0.4 V |
| `0x100b` | `[14]` | Under-voltage alarm | ×0.4 V |
| `0x100c` | `[12]` | Over-discharge voltage | ×0.4 V |
| `0x100d` | `[15]` | Discharge limit voltage | ×0.4 V |
| `0x1018` | `[04]` | Battery → Mains switchover | ×0.4 V |
| `0x1019` | `[05]` | Mains → Battery switchover | ×0.4 V |
| `0x1103` | `[28]` | AC charging current | ÷10 A |
| `0x1106` | `[36]` | Max PV charging current | ÷10 A |
| `0x0418`+ | — | Firmware build date, ASCII one char per register | — |

## Hardware note

The inverter's USB port is a device-side CH340. On the test system it enumerated fine on
a Windows PC but **repeatedly failed to enumerate on a Home Assistant Green**, logging
`Cannot enable. Maybe the USB cable is bad?` and taking the rest of the USB bus down with
it. That points at VBUS back-feed and/or a ground-potential difference between the
inverter (bonded to the battery bank) and the host. A **USB isolator** is the fix; a
mains-earthed laptop happens to dodge the problem.

## Licence

MIT
