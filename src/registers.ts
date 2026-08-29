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
export type Kind = 'live' | 'counter' | 'setting' | 'info';

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

/**
 * Direction names for a signed register whose sign is a direction of flow.
 * Negative is *into* the thing being measured, positive is out of it.
 */
export interface FlowLabels {
  in: string;
  out: string;
  idle: string;
}

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
  /**
   * Interpret the raw 16-bit value as signed. Battery current is stored this
   * way — 0xFF39 is -199, i.e. 19.9 A *into* the battery. Reading it unsigned
   * displays a nonsensical 6533.7 A.
   */
  signed?: boolean;
  /**
   * Present when the sign means a direction rather than a smaller number. The
   * UI then shows the magnitude and names the direction in colour, so a minus
   * sign never reaches the screen.
   */
  flow?: FlowLabels;
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
  /*
   * Negative is current INTO the battery. Verified against the pack's own
   * readout: raw 65341 (-19.5 A) while the pack reported 19.78 A charging, and
   * 65524 (-1.2 A) a minute later when the pack read 0.53 A.
   */
  {
    key: 'batteryCurrent',
    addr: 0x0501,
    label: 'Battery current',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    signed: true,
    flow: { in: 'Charging', out: 'Discharging', idle: 'Idle' },
    confidence: 'high',
  },
  {
    key: 'pvCurrent',
    addr: 0x0508,
    label: 'PV input current',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'high',
    /*
     * 0x0508 = 10 * (pvW / pvV) with slope 9.998, intercept 0.05, r² = 1.000
     * over 5,069 samples — and 0x0509 is literally pvV * 0x0508 / 100, so the
     * power register is computed from this one.
     */
  },
  {
    key: 'pvVoltage',
    addr: 0x0507,
    label: 'PV voltage',
    kind: 'live',
    scale: LIVE_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    // 75.7 V while bulk charging, 115.7 V a minute later with the pack near full.
    note: 'Rises toward open-circuit as charge demand falls.',
  },
  {
    key: 'acInputVoltage',
    addr: 0x061f,
    label: 'AC input voltage',
    kind: 'live',
    scale: LIVE_VOLT,
    decimals: 1,
    unit: 'V',
    confidence: 'high',
    // Went 107.6 V -> 0 the moment the wall charger was unplugged.
    note: 'Reads 0 with no mains present.',
  },
  {
    key: 'acChargerCurrent',
    addr: 0x061e,
    label: 'AC charger current',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: 'A',
    confidence: 'high',
    /*
     * DC-side output of the mains charger. 0x061e * battV / 100 equals
     * (0x0510 - 0x0509) with slope 0.994, intercept 0.0, r² = 1.000 over 795
     * mains samples — total input power is computed from this register.
     */
    note: 'DC-side output of the mains charger. Zero without mains.',
  },
  {
    key: 'operatingMode',
    addr: 0x0600,
    label: 'Operating mode',
    kind: 'live',
    scale: 1,
    decimals: 0,
    confidence: 'medium',
    /*
     * Transitions observed over three days of logs: 5 -> 4 the moment AC
     * charging started, 4 -> 1 when the charge completed with mains still at
     * 119.4 V, 1 -> 5 when AC input dropped to 0.
     */
    note: '1 = mains bypass, 4 = AC charging, 5 = inverter (battery).',
  },
  {
    key: 'mpptTemp',
    addr: 0x0616,
    label: 'MPPT temperature',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: '°C',
    confidence: 'medium',
    note: 'Peaks with PV power, smooth cooling curve overnight.',
  },
  {
    key: 'transformerTemp',
    addr: 0x0618,
    label: 'Transformer temperature',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: '°C',
    confidence: 'low',
    // 63-66 °C even idle — consistent with the always-energized LF
    // transformer's core loss (~36 W standby).
    note: 'Hottest measured spot; warm even at idle.',
  },
  {
    key: 'inverterTemp',
    addr: 0x0619,
    label: 'Inverter temperature',
    kind: 'live',
    scale: TENTHS,
    decimals: 1,
    unit: '°C',
    confidence: 'low',
    note: 'Rises during battery-mode discharge, falls while charging.',
  },
  {
    key: 'estimatedSoc',
    addr: 0x0502,
    label: 'Estimated state of charge',
    kind: 'live',
    scale: 1,
    decimals: 0,
    unit: '%',
    confidence: 'low',
    /*
     * With no BMS link the inverter can only infer SOC from voltage, so it will
     * disagree with the pack, which counts coulombs — different quantities, not
     * a contradiction. Observed 45–100, capping at exactly 100, correlating 0.47
     * with battery voltage over 517 samples: too loose for a raw voltage lookup,
     * about right for a smoothed or load-compensated one.
     */
    note: "The inverter's own guess from voltage, not the pack's. Indicative only.",
  },
  {
    key: 'pvPower',
    addr: 0x0509,
    label: 'PV input power',
    kind: 'live',
    scale: 1,
    decimals: 0,
    unit: 'W',
    confidence: 'medium',
    /*
     * Reads 0 whenever there is no sun even while charging hard from mains, and
     * equals 0x0510 exactly when PV is the only source. That pair of regimes is
     * what separates it from total input power.
     */
    note: 'Zero at night even while mains-charging; equals total input when PV is the only source.',
  },
  {
    key: 'inputPower',
    addr: 0x0510,
    label: 'Total input power',
    kind: 'live',
    scale: 1,
    decimals: 0,
    unit: 'W',
    confidence: 'high',
    /*
     * Correlates -0.99 with battery current over 1386 records (negative because
     * charging current is negative). Fitting against battery power across both
     * operating regimes — 190 W on solar and 1086 W on mains — gives
     *
     *     0x0510 ~= 1.168 * P_battery + 36
     *
     * i.e. 86% conversion efficiency and ~36 W standby. That the residual is a
     * sensible physical constant rather than an arbitrary offset is most of the
     * argument that the unit really is watts.
     */
    note: 'PV and AC combined. Roughly battery power / 0.86 plus ~36 W standby.',
  },
  {
    key: 'loadIndicator',
    addr: 0x061c,
    label: 'Load',
    kind: 'live',
    scale: 1,
    decimals: 0,
    confidence: 'medium',
    /*
     * Identified by toggling a ~140 W load while logging. Comparing period
     * means rather than a single transition, because solar was swinging by more
     * than the load and a one-sample diff could not have separated them:
     *
     *   load off, 77 samples:  0.2
     *   load on,  25 samples: 19.5
     *   signal (delta / noise): 20.4  — next strongest register scored 2.7
     *
     * THE UNIT IS NOT ESTABLISHED. The same step showed 3.2 A leaving the
     * charge current at 54.5 V, so ~174 W DC and ~148 W AC after conversion.
     * Against 19.5 counts that is ~7.6 W per count, which is not a round
     * number in any obvious unit — so treat this as "a load is present and
     * roughly how big" until a second load of known size pins the scale.
     *
     * Best current hypothesis after three days of data: AC OUTPUT CURRENT in
     * 0.1 A RMS. 19.5 counts = 1.95 A at 120 V = 234 VA, which is that ~148 W
     * load at power factor 0.63 — normal for electronics, and it dissolves
     * the "7.6 W/count isn't round" puzzle: the count is round in amps, not
     * watts. A purely resistive load would settle it: a 120 W heater should
     * read ~10 counts if this is AC amps, ~16 if it is DC-side.
     */
    note: 'Probably AC output current in 0.1 A RMS — a resistive test load would confirm.',
  },
  /*
   * 0x0611/0x0612 are one structured uptime clock, not a runtime accumulator
   * as first guessed. Confirmed sample-by-sample over three days of logs:
   *
   *   0x0611 = (days << 8) | hours       — increments when 0x0612 wraps
   *   0x0612 = (minutes << 8) | (seconds + 80)
   *
   * The low byte spans exactly 80..139 (+1 per second), the register resets
   * every 3600 s. Phase is set at power-on, so "device midnight" — when all
   * the daily counters below reset — is the hour rollover, not calendar
   * midnight. It ran at ~11:58 UTC during the capture.
   */
  {
    key: 'uptimeDayHour',
    addr: 0x0611,
    label: 'Uptime (day·hour)',
    kind: 'info',
    scale: 1,
    decimals: 0,
    confidence: 'high',
    note: 'High byte days, low byte hours since power-on.',
  },
  {
    key: 'clockMinSec',
    addr: 0x0612,
    label: 'Clock (min·sec)',
    kind: 'info',
    scale: 1,
    decimals: 0,
    confidence: 'high',
    note: 'High byte minutes, low byte seconds + 80. Wraps hourly.',
  },

  // ------------------------------------------------------------- counters ---
  /*
   * The 0x0700 block is a statistics area the device maintains itself:
   * today/lifetime pairs for energy, amp-hours and runtime. Every "today"
   * register resets at DEVICE midnight (see the 0x0611 clock note), observed
   * directly at 2026-08-28 11:58:53Z simultaneously with the day rollover.
   * All identified by matching counter increments against energy and charge
   * integrals computed from three days of logged power and current.
   *
   * The "total" counters had only ~8 days of accumulation, matching device
   * uptime — they may clear on power-cycle rather than being lifetime.
   */
  {
    key: 'pvEnergyToday',
    addr: 0x070d,
    label: 'PV energy today',
    kind: 'counter',
    scale: 0.1,
    decimals: 1,
    unit: 'kWh',
    confidence: 'high',
    /*
     * +1 count per 99.6-101.2 measured PV watt-hours across 25+ intervals in
     * both trickle and full sun; stayed 0 through 1.29 kWh of pure AC
     * charging, so it is PV-only.
     */
  },
  {
    key: 'pvEnergyTotal',
    addr: 0x070e,
    label: 'PV energy total',
    kind: 'counter',
    scale: 0.1,
    decimals: 1,
    unit: 'kWh',
    confidence: 'high',
  },
  {
    key: 'acEnergyToday',
    addr: 0x071f,
    label: 'AC charge energy today',
    kind: 'counter',
    scale: 0.1,
    decimals: 1,
    unit: 'kWh',
    confidence: 'medium',
    // +1 per ~85 Wh of DC-side input = ~99 Wh AC-side at the established 86%
    // conversion efficiency, so this counts the AC side of the meter.
    note: 'Measured on the AC side, before conversion losses.',
  },
  {
    key: 'chargeAhToday',
    addr: 0x0710,
    label: 'Charge today',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'high',
  },
  {
    key: 'chargeAhTotal',
    addr: 0x0711,
    label: 'Charge total',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'high',
  },
  {
    key: 'dischargeAhToday',
    addr: 0x0713,
    label: 'Discharge today',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'high',
  },
  {
    key: 'dischargeAhTotal',
    addr: 0x0714,
    label: 'Discharge total',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'high',
  },
  {
    key: 'acChargerAhToday',
    addr: 0x0719,
    label: 'AC charger output today',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'medium',
    // 1.2x the battery-Ah rate during mains charge because it includes the
    // share feeding the load, not just the battery.
  },
  {
    key: 'acChargerAhTotal',
    addr: 0x071a,
    label: 'AC charger output total',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'Ah',
    confidence: 'medium',
  },
  {
    key: 'inverterHoursToday',
    addr: 0x0706,
    label: 'Inverter runtime today',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'h',
    confidence: 'medium',
    note: 'Hours running from battery. Frozen while mains is present.',
  },
  {
    key: 'inverterHoursTotal',
    addr: 0x0704,
    label: 'Inverter runtime total',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'h',
    confidence: 'medium',
  },
  {
    key: 'acChargeHoursTotal',
    addr: 0x0705,
    label: 'AC charging hours total',
    kind: 'counter',
    scale: 1,
    decimals: 0,
    unit: 'h',
    confidence: 'medium',
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
    // Read identical to 0x1007 (boost voltage) through three full days of
    // logs on the GEL profile — the two track together, at least here.
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

/**
 * The bus needs a 50ms gap between frames (see INTER_FRAME in modbus.rs), so a
 * block read costs ~120ms of bus time. Polling all five blocks every second
 * would spend 60% of the bus on data that barely changes, and starve the
 * background logger.
 *
 * So the poll is split by how fast each block actually moves.
 */

/** Live telemetry — worth reading every second. ~240ms of bus time. */
export const FAST_BLOCKS: { addr: number; count: number }[] = [
  { addr: 0x0500, count: 32 }, // live telemetry
  { addr: 0x0600, count: 32 }, // counters
];

/**
 * Settings and identity. These only change when something writes them, so a
 * slow cadence is plenty — and a write triggers an immediate re-read anyway.
 */
export const SLOW_BLOCKS: { addr: number; count: number }[] = [
  { addr: 0x0400, count: 32 }, // identity / firmware build string
  { addr: 0x0700, count: 32 }, // statistics: daily/lifetime energy, Ah, hours
  { addr: 0x1000, count: 32 }, // settings
  { addr: 0x1100, count: 32 }, // settings (AC / PV currents)
];

/** Everything the UI decodes, for the first read after connecting. */
export const POLL_BLOCKS = [...FAST_BLOCKS, ...SLOW_BLOCKS];

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

/** Reinterpret a raw 16-bit word as signed, for registers that need it. */
export function asSigned(raw: number): number {
  return raw > 32767 ? raw - 65536 : raw;
}

export function toDisplay(def: RegisterDef, raw: number): number {
  return (def.signed ? asSigned(raw) : raw) * def.scale;
}

export function toRaw(def: RegisterDef, display: number): number {
  const value = Math.round(display / def.scale);
  return def.signed && value < 0 ? value + 65536 : value;
}

export function formatValue(def: RegisterDef, raw: number | undefined): string {
  if (raw === undefined) return '—';
  return toDisplay(def, raw).toFixed(def.decimals);
}

/** Below this magnitude (display units) a flow reads as idle, not a direction. */
const FLOW_DEADBAND = 0.05;

/**
 * Battery current is signed with negative meaning charging, which is the
 * opposite of how anyone reads a dashboard. Rather than print a minus sign,
 * split it into a magnitude and a named direction the UI can colour.
 */
export function describeFlow(def: RegisterDef, raw: number | undefined) {
  if (!def.flow || raw === undefined) return undefined;
  const value = toDisplay(def, raw);
  const direction = value < -FLOW_DEADBAND ? 'in' : value > FLOW_DEADBAND ? 'out' : 'idle';
  return {
    magnitude: Math.abs(value),
    direction,
    label: def.flow[direction],
    arrow: direction === 'in' ? '↓' : direction === 'out' ? '↑' : '·',
  } as const;
}

/** The one register the dashboard reasons about beyond rendering its tile. */
export const BATTERY_CURRENT = REGISTERS.find((r) => r.key === 'batteryCurrent')!;
