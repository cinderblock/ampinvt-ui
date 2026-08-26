/**
 * AMPINVT TEL-series register map (TEL-48502M100 / M-TEL-5KW-120V).
 *
 * THIS FILE IS THE ONLY DEVICE-SPECIFIC PART OF THE APP. The Rust side is
 * generic Modbus RTU. Supporting another inverter should mean adding another
 * map here, not touching the transport.
 *
 * Everything below was measured against a real unit over USB (CH340, COM3) on
 * 2026-08-26 — the vendor publishes no protocol documentation. Read the
 * `confidence` field as literally as it is written:
 *
 *   high   — value matches a documented manual default, and the surrounding
 *            registers corroborate it.
 *   medium — value matches a documented default, but another setting shares
 *            that default so the assignment could be swapped with a sibling.
 *   low    — decoded shape only; meaning is a guess.
 *
 * The only mapping confirmed by an actual round trip is 0x1103 (AC charge
 * current): written 400 -> 150 and read back, with no other register in the
 * block changing.
 */

export type Confidence = 'high' | 'medium' | 'low';
export type Kind = 'live' | 'setting' | 'info';

/**
 * Write tiers.
 *
 * `normal`  — operational settings: currents, thresholds, cutoff voltages.
 *             Gated behind the ordinary write unlock.
 * `setup`   — parameters that redefine the battery itself. Changing one of
 *             these makes the inverter rewrite a whole group of other
 *             registers, so it gets its own stricter gate.
 */
export type Tier = 'normal' | 'setup';

export interface EnumOption {
  value: number;
  code: string;
  label: string;
  /** Shown prominently when this option is selected but not yet committed. */
  warn?: string;
}

export interface RegisterDef {
  key: string;
  addr: number;
  label: string;
  kind: Kind;
  /** display value = raw * scale */
  scale: number;
  decimals: number;
  unit?: string;
  confidence: Confidence;
  writable?: boolean;
  tier?: Tier;
  /** Present for enumerated registers — renders a picker instead of a number. */
  options?: EnumOption[];
  /**
   * Registers the device rewrites as a side effect of changing this one.
   * The UI reports what actually moved after the write.
   */
  cascades?: number[];
  /** Bounds in DISPLAY units, taken from the manual's stated setting ranges. */
  min?: number;
  max?: number;
  step?: number;
  /** The LCD menu parameter number, where identified. */
  setting?: string;
  note?: string;
}

/**
 * Voltage SETTINGS are stored as 12 V-equivalent tenths: actual volts = raw * 0.4.
 * Confirmed by ten independent matches against documented defaults.
 * Live voltage READINGS use plain tenths (raw / 10) — do not confuse the two.
 */
export const SETTING_VOLT = 0.4;
export const LIVE_VOLT = 0.1;
export const TENTHS = 0.1;

/**
 * [08] battery type, at 0x1002. Index order follows the manual's option list.
 *
 * Index 3 = GEL is corroborated rather than assumed from position: the manual
 * documents GEL as constant-charge 56.8 V / float 55.2 V, and a unit reading 3
 * here also reads 142 (56.8 V) at 0x1007 and 138 (55.2 V) at 0x1008 — an exact
 * match on both values.
 *
 * Declared before REGISTERS because the register table references it during
 * module initialisation.
 */
export const BATTERY_TYPE_OPTIONS: EnumOption[] = [
  {
    value: 0,
    code: 'USE',
    label: 'User-defined',
    warn:
      'User-defined makes equalization effective, and equalization defaults to ENABLED. ' +
      'Equalizing a LiFePO4 pack is harmful. Prefer L16 for a 16S lithium bank.',
  },
  { value: 1, code: 'SLd', label: 'Sealed lead-acid — 57.6 V charge / 55.2 V float' },
  { value: 2, code: 'FLd', label: 'Flooded lead-acid — 58.4 V charge / 55.2 V float' },
  { value: 3, code: 'GEL', label: 'GEL lead-acid — 56.8 V charge / 55.2 V float' },
  { value: 4, code: 'L14', label: 'LiFePO4 14 cells — 49.6 V charge' },
  { value: 5, code: 'L15', label: 'LiFePO4 15 cells — 53.2 V charge' },
  { value: 6, code: 'L16', label: 'LiFePO4 16 cells — 56.8 V charge' },
  { value: 7, code: 'N13', label: 'Ternary lithium 13 cells — 53.2 V charge' },
  { value: 8, code: 'N14', label: 'Ternary lithium 14 cells — 57.6 V charge' },
];

export const REGISTERS: RegisterDef[] = [
  // ---------------------------------------------------------------- live ----
  {
    key: 'batteryVoltage',
    addr: 0x0500,
    label: 'Battery voltage',
    kind: 'live',
    scale: LIVE_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
  },
  {
    key: 'liveCurrent',
    addr: 0x0501,
    label: 'Current',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'low',
    note: 'Fluctuates ±1 at idle. Sign and direction unconfirmed.',
  },
  {
    key: 'live0502',
    addr: 0x0502,
    label: 'Unidentified (0x0502)',
    kind: 'live',
    scale: 1,
    decimals: 0,
    confidence: 'low',
  },
  {
    key: 'runtimeCounter',
    addr: 0x0612,
    label: 'Runtime counter',
    kind: 'live',
    scale: 1,
    decimals: 0,
    confidence: 'low',
    note: 'Climbs monotonically. Units unknown.',
  },

  // ------------------------------------------------------------- charging ---
  {
    key: 'maxChargeCurrent',
    addr: 0x1003,
    label: 'Max charging current',
    kind: 'setting',
    setting: '[07]',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'high',
    writable: true,
    min: 0,
    max: 100,
    step: 0.1,
  },
  {
    key: 'acChargeCurrent',
    addr: 0x1103,
    label: 'AC charging current',
    kind: 'setting',
    setting: '[28]',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'high',
    writable: true,
    min: 0,
    max: 40,
    step: 0.1,
    note: 'The one mapping confirmed by a verified round-trip write.',
  },
  {
    key: 'pvChargeCurrent',
    addr: 0x1106,
    label: 'Max PV charging current',
    kind: 'setting',
    setting: '[36]',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'medium',
    writable: true,
    min: 0,
    max: 100,
    step: 0.1,
  },

  // ------------------------------------------------- charge cutoff voltage --
  {
    key: 'constantChargeVoltage',
    addr: 0x1006,
    label: 'Constant-charge voltage',
    kind: 'setting',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 48,
    max: 58.4,
    step: 0.4,
  },
  {
    key: 'boostVoltage',
    addr: 0x1007,
    label: 'Boost (absorption) voltage',
    kind: 'setting',
    setting: '[09]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 48,
    max: 58.4,
    step: 0.4,
  },
  {
    key: 'floatVoltage',
    addr: 0x1008,
    label: 'Float voltage',
    kind: 'setting',
    setting: '[11]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 48,
    max: 58.4,
    step: 0.4,
  },
  {
    key: 'equalizationVoltage',
    addr: 0x101f,
    label: 'Equalization voltage',
    kind: 'setting',
    setting: '[17]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'medium',
    writable: true,
    min: 48,
    max: 58,
    step: 0.4,
    note: 'Lead-acid only. Equalization must stay disabled on LiFePO4.',
  },

  // ------------------------------------------------ discharge cutoff volts --
  {
    key: 'recoveryA',
    addr: 0x1009,
    label: 'Recovery point A',
    kind: 'setting',
    setting: '[35] or [37]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'medium',
    writable: true,
    min: 44.4,
    max: 57.2,
    step: 0.4,
    note: 'Ambiguous with Recovery point B — both default to 52.0 V. Change one on the LCD to tell them apart.',
  },
  {
    key: 'recoveryB',
    addr: 0x100a,
    label: 'Recovery point B',
    kind: 'setting',
    setting: '[35] or [37]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'medium',
    writable: true,
    min: 44.4,
    max: 57.2,
    step: 0.4,
    note: 'Ambiguous with Recovery point A — see that entry.',
  },
  {
    key: 'underVoltageAlarm',
    addr: 0x100b,
    label: 'Under-voltage alarm',
    kind: 'setting',
    setting: '[14]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 40,
    max: 54,
    step: 0.4,
  },
  {
    key: 'overDischargeVoltage',
    addr: 0x100c,
    label: 'Over-discharge voltage',
    kind: 'setting',
    setting: '[12]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 40,
    max: 52,
    step: 0.4,
  },
  {
    key: 'dischargeLimitVoltage',
    addr: 0x100d,
    label: 'Discharge limit voltage',
    kind: 'setting',
    setting: '[15]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 40,
    max: 52,
    step: 0.4,
  },
  {
    key: 'batteryToMains',
    addr: 0x1018,
    label: 'Battery → Mains switchover',
    kind: 'setting',
    setting: '[04]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 40,
    max: 57.2,
    step: 0.4,
  },
  {
    key: 'mainsToBattery',
    addr: 0x1019,
    label: 'Mains → Battery switchover',
    kind: 'setting',
    setting: '[05]',
    scale: SETTING_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    writable: true,
    min: 52.4,
    max: 60,
    step: 0.4,
  },

  // ------------------------------------------------------------ SOC / misc --
  {
    key: 'cutoffDischargeSoc',
    addr: 0x1017,
    label: 'Cut-off discharge SOC',
    kind: 'setting',
    setting: '[59]',
    scale: 1,
    decimals: 0,
    unit: '%',
    confidence: 'medium',
    writable: true,
    min: 0,
    max: 100,
    step: 1,
    note: 'Only effective with a BMS link, which these battery packs do not provide.',
  },
  {
    key: 'dischargeAlarmSoc',
    addr: 0x101c,
    label: 'Discharge alarm SOC',
    kind: 'setting',
    setting: '[58]',
    scale: 1,
    decimals: 0,
    unit: '%',
    confidence: 'high',
    writable: true,
    min: 0,
    max: 100,
    step: 1,
    note: 'Only effective with a BMS link.',
  },
  {
    key: 'switchToMainsSoc',
    addr: 0x101d,
    label: 'Switch-to-mains SOC',
    kind: 'setting',
    setting: '[61]',
    scale: 1,
    decimals: 0,
    unit: '%',
    confidence: 'high',
    writable: true,
    min: 0,
    max: 100,
    step: 1,
    note: 'Only effective with a BMS link.',
  },
  {
    key: 'cutoffChargeSoc',
    addr: 0x101e,
    label: 'Cut-off charge SOC',
    kind: 'setting',
    setting: '[60]',
    scale: 1,
    decimals: 0,
    unit: '%',
    confidence: 'medium',
    writable: true,
    min: 0,
    max: 100,
    step: 1,
    note: 'Only effective with a BMS link.',
  },
  {
    key: 'overDischargeDelay',
    addr: 0x100e,
    label: 'Over-discharge delay',
    kind: 'setting',
    setting: '[13]',
    scale: 1,
    decimals: 0,
    unit: 's',
    confidence: 'medium',
    writable: true,
    min: 5,
    max: 55,
    step: 5,
  },
  {
    key: 'acOutputVoltage',
    addr: 0x1010,
    label: 'AC output rated voltage',
    kind: 'setting',
    setting: '[38]',
    scale: 1,
    decimals: 0,
    unit: 'V',
    confidence: 'medium',
    writable: false,
    note: 'Read-only here on purpose — changing output voltage affects every load.',
  },
  {
    key: 'outputFrequency',
    addr: 0x1012,
    label: 'Output frequency',
    kind: 'setting',
    setting: '[02]',
    scale: 1,
    decimals: 0,
    unit: 'Hz',
    confidence: 'high',
    writable: false,
    note: 'Read-only here on purpose.',
  },

  // ------------------------------------------------------------------ info --
  {
    key: 'systemVoltage',
    addr: 0x1001,
    label: 'System voltage rating',
    kind: 'info',
    scale: 1,
    decimals: 0,
    unit: 'V',
    confidence: 'high',
  },
  {
    key: 'batteryType',
    addr: 0x1002,
    label: 'Battery type',
    kind: 'setting',
    setting: '[08]',
    scale: 1,
    decimals: 0,
    confidence: 'high',
    writable: true,
    tier: 'setup',
    options: BATTERY_TYPE_OPTIONS,
    cascades: [0x1006, 0x1007, 0x1008],
    note:
      'Selecting a type makes the inverter rewrite the charge profile — constant-charge, ' +
      'boost and float voltages all move. The app reports exactly what changed afterwards.',
  },
];

/** Codes 4-8 are the lithium profiles; 0-3 are lead-acid or user-defined. */
export function isLithiumBatteryType(raw: number | undefined): boolean {
  return raw !== undefined && raw >= 4 && raw <= 8;
}

export function describeBatteryType(raw: number | undefined) {
  if (raw === undefined) return undefined;
  const option = BATTERY_TYPE_OPTIONS.find((o) => o.value === raw);
  if (!option) return undefined;
  return { ...option, lithium: isLithiumBatteryType(raw) };
}

/** Blocks the poller reads each cycle. Everything above must fall inside one. */
export const POLL_BLOCKS: { addr: number; count: number }[] = [
  { addr: 0x0400, count: 32 }, // identity / firmware build string
  { addr: 0x0500, count: 32 }, // live telemetry
  { addr: 0x0600, count: 32 }, // counters
  { addr: 0x1000, count: 32 }, // settings
  { addr: 0x1100, count: 32 }, // settings (AC / PV currents)
];

/** All blocks known to exist, for the raw explorer view. */
export const KNOWN_BLOCKS = [
  0x0400, 0x0500, 0x0600, 0x0700, 0x0800, 0x0900, 0x0a00, 0x1000, 0x1100,
  0x1200, 0x1800, 0x2000, 0x2100,
];

/** 0x0418.. holds the firmware build date as ASCII, one character per register. */
export const BUILD_STRING_RANGE = { addr: 0x0418, count: 8 };

export function decodeAscii(values: Map<number, number>, addr: number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) {
    const code = values.get(addr + i);
    if (code === undefined || code === 0) break;
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out.trim();
}

export function toDisplay(def: RegisterDef, raw: number): number {
  return raw * def.scale;
}

export function toRaw(def: RegisterDef, display: number): number {
  return Math.round(display / def.scale);
}

export function formatValue(def: RegisterDef, raw: number | undefined): string {
  if (raw === undefined) return '—';
  const value = toDisplay(def, raw);
  return value.toFixed(def.decimals);
}
