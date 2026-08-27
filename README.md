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
| **Inter-frame gap** | **50 ms — mandatory, see below** |
| Poll rate | live blocks 1 Hz, settings 15 s |

### Frames get lost, so reads retry

Forensics on a real stall found **95 of 179 sweeps dropped at least one block**, climbing
in frequency for twenty minutes before the link failed completely — while the inverter was
charging hard at 20 A. Readings were rock steady throughout; there was no drift, the link
simply shed frames until it shed all of them.

Reads therefore retry up to three times. **Modbus exceptions are not retried** — an
exception is the device answering correctly to say an address does not exist, and it will
say so just as firmly the second time.

Ground offset is *not* the cause: the host is a laptop, galvanically floating, so a USB
isolator would change nothing. The leading candidate is EMI coupled into the cable from a
converter switching kilowatts a metre away, with MCU starvation under load and thermal
drift as alternatives. All three are transient, which is what makes retrying effective.

Worth doing physically: ferrite chokes on the USB cable, keep it away from battery and AC
runs, and use the shortest cable that reaches.

### The inter-frame gap is not optional

Modbus RTU only requires 3.5 character times between frames — about 3.65 ms at
9600 8N1. **This inverter needs roughly ten times that.** Measured on a real unit,
reading `0x1000` thirty times per step:

| gap | result |
|---|---|
| 10 ms | 15/30 |
| 15 ms | 19/30 |
| 20 ms | 21/30 |
| 25 ms | 29/30 |
| **30 ms** | **30/30** |
| 60 ms | 30/30 |

Below the threshold it answers roughly **every other request** — a burst with no gap
scores exactly 13/25, a perfect alternating pattern. It is not mis-framing; it is slow
to re-arm its receiver.

The app enforces 50 ms, measured from the end of the previous exchange, on every path
including failures. A sustained 90-second run at the app's real duty cycle loses zero
frames. Removing or shrinking this will produce intermittent, confusing timeouts that
look like a hardware fault.

## Unattended operation

The app is built to be left running on a machine nobody is sitting at:

- **Connect on startup** — on by default. Reconnects to the port used last time,
  falling back to whatever identifies as the inverter's CH340, then the first
  serial port. Remembering the last port matters when more than one serial device
  is present, so a reboot cannot attach to the wrong one. Toggle is next to the
  Connect button.
- **Logging starts automatically** when connected, unless turned off.
- **One log file per UTC day, never deleted.**
- **Failed sweeps are recorded**, not skipped — see below.
- **The port reopens itself** after three consecutive failures.

### Recovering from a USB drop

If the adapter is unplugged and replugged, the app reopens the port on its own. Two
distinct failures are handled, and the second is easy to miss:

1. **Stale handle, same port.** Reopening the remembered path fixes it.
2. **The device came back on a different COM number.** Windows renumbers whenever the
   adapter is plugged into another socket. Pinning the remembered path would fail
   forever, so recovery falls back to hunting the CH340 by VID/PID (`1A86:7523`) and
   adopts whatever port it now occupies, remembering the new number.

Recovery is driven from **both** the logger and the UI poller, deliberately — if it lived
only in the logger it would silently not exist whenever logging was switched off.

What it cannot fix is an inverter that is powered but mute. That is the point of logging
failures: a reopen that succeeds and still reads nothing tells you the link is fine and
the device is not, which is a different fault with a different cause.

### Failure records

A sweep that returns no data writes a record rather than nothing at all:

```json
{"t":"2026-08-27T04:12:05Z","ok":false,"failed":13,"blocks":13,"err":"0x0500: no reply (timeout)"}
```

Without these a mute device produced *no records*, which is indistinguishable from the app
never having run — no timestamp, no reason, nothing to correlate against.

`tools/outages.py` separates the two failure modes, because they have different causes:
a run of failure records means the device was mute while the app polled; a gap with no
records at all means the app was not running or the machine slept.

## Installing

Grab the `.exe` installer from the [latest release](https://github.com/cinderblock/ampinvt-ui/releases/latest).
After that the app updates itself — see below.

## Running from source

```sh
bun install
bun run tauri dev
```

Note that update checks **fail under `tauri dev`**. There is no signed bundle to compare
against outside a real install, so the Updates tab reports an error there. That is
expected.

## Updates

The app checks GitHub Releases on launch and every six hours, and verifies the release
signature before installing anything. The release body is rendered as markdown in the
Updates tab; raw HTML in a release body is ignored, and links open in the system browser
rather than navigating the app window.

**Automatic installation is opt-in and off by default.** When enabled, an available
update installs itself once the app has been idle for a configurable period (default
5 minutes, measured from the last mouse/keyboard/focus event).

It will **not** install automatically while:

- writes are unlocked, or
- a guarded write is in flight

Installing requires a restart, and restarting mid-configuration of a 5 kW converter is
not acceptable. Those conditions are surfaced in the Updates tab when they hold off an
install. Manual "Install and restart" ignores them — that is an explicit choice.

## Releasing

Releases are built and published **exclusively from CI** — see
[`.github/workflows/release.yml`](.github/workflows/release.yml). CI gives a reproducible
build from a clean checkout, an auditable record tied to a commit, and keeps the signing
key in repo secrets rather than on a workstation.

To cut a release: bump `version` in `src-tauri/tauri.conf.json`, commit, then

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The workflow refuses to build if the tag and the config version disagree. It can also be
run manually via `workflow_dispatch`.

Required repo secrets:

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign key the updater verifies against |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty for a `--ci`-generated key |

The matching **public** key is committed in `src-tauri/tauri.conf.json`. Losing the
private key means installed clients can no longer verify updates from a new key — keep a
backup.

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

## How registers get identified

By correlating a log against a known physical change. The strongest evidence so far came
from unplugging a wall charger while logging: charge current dropped from 19.78 A to
0.53 A in one minute, with the battery pack's own readout photographed at both moments.
Diffing the log across that step gave four identifications at once:

| Register | before (20 A wall) | after (0.5 A solar) | pack readout |
|---|---|---|---|
| `0x0500` | 543 → 54.3 V | 537 → **53.7 V** | 54.06 / **53.69 V** |
| `0x0501` | 65341 → **−19.5 A** | 65524 → **−1.2 A** | 19.78 / 0.53 A |
| `0x061f` | 1076 → **107.6 V** | **0** | wall unplugged |
| `0x0507` | 757 → 75.7 V | 1157 → **115.7 V** | PV ~120 V |

`0x061f` collapsing to zero exactly when mains went away is unambiguous. `0x0507` *rising*
when charging stopped is physically right — with the pack near full the MPPT backs off and
the array drifts toward open-circuit.

`tools/step_diff.py` and `tools/analyze_log.py` automate this: log across a state change,
then diff or rank by correlation.

### Still unidentified

PV current, load power and output power. Two registers are known-but-unnamed:

- **`0x0502`** — moves with charge activity but is *not* SOC; it read 85 then 79 while the
  pack held 92%.
- **`0x0509` / `0x0510`** — track each other exactly, and rose 90 → 150 as charging
  *stopped*, which rules out PV current.

## Register map

See [`src/registers.ts`](src/registers.ts) for the full annotated map. Highlights:

| Register | Setting | Meaning | Scale |
|---|---|---|---|
| `0x0500` | — | Battery voltage (live) | ÷10 |
| `0x0501` | — | Battery current (live), **signed**, −ve = charging | ÷10 A |
| `0x0507` | — | PV voltage (live) | ÷10 V |
| `0x061f` | — | AC input voltage (live), 0 with no mains | ÷10 V |
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
