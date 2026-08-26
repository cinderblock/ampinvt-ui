import { useState } from 'react';

import { writeRegister, type WriteReport } from '../api';
import { useSafety } from '../safety';
import {
  REGISTERS,
  formatValue,
  isLithiumBatteryType,
  toDisplay,
  toRaw,
  type RegisterDef,
} from '../registers';

interface Props {
  registers: Map<number, number>;
  connected: boolean;
  onWritten: () => void;
}

interface Group {
  title: string;
  desc: string;
  keys: string[];
  /** Setup groups are hidden behind the second gate. */
  setup?: boolean;
}

const GROUPS: Group[] = [
  {
    title: 'Charge current limits',
    desc: 'Keep these at or below the battery bank rating — 30 A per pack for the OGRPHY 100 Ah packs.',
    keys: ['maxChargeCurrent', 'acChargeCurrent', 'pvChargeCurrent'],
  },
  {
    title: 'Charge cutoff voltages',
    desc: 'Charging stops when the pack reaches the boost voltage and the taper current falls away. Every value here should sit well below the BMS overvoltage trip of 60 V.',
    keys: ['constantChargeVoltage', 'boostVoltage', 'floatVoltage', 'equalizationVoltage'],
  },
  {
    title: 'Discharge cutoff voltages',
    desc: 'These must all stay ABOVE the pack BMS low-voltage cutoff of 43.2 V, so the inverter backs off before the battery disconnects itself.',
    keys: [
      'underVoltageAlarm',
      'overDischargeVoltage',
      'dischargeLimitVoltage',
      'batteryToMains',
      'mainsToBattery',
      'recoveryA',
      'recoveryB',
      'overDischargeDelay',
    ],
  },
  {
    title: 'State-of-charge thresholds',
    desc: 'Inert on this system: every one of these requires a working BMS link, which the OGRPHY packs do not provide.',
    keys: ['cutoffDischargeSoc', 'dischargeAlarmSoc', 'switchToMainsSoc', 'cutoffChargeSoc'],
  },
  {
    title: 'Battery definition',
    desc: 'Changing the battery type makes the inverter rewrite its whole charge profile. Everything in the two voltage sections above will move.',
    keys: ['batteryType'],
    setup: true,
  },
  {
    title: 'Output (read-only here)',
    desc: 'Deliberately not writable from this app — changing them affects every connected load.',
    keys: ['acOutputVoltage', 'outputFrequency'],
  },
];

function Row({
  def,
  registers,
  enabled,
  onWritten,
}: {
  def: RegisterDef;
  registers: Map<number, number>;
  enabled: boolean;
  onWritten: () => void;
}) {
  const raw = registers.get(def.addr);
  const [draft, setDraft] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<WriteReport | null>(null);
  const [cascadeBefore, setCascadeBefore] = useState<Map<number, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { beginWrite, endWrite } = useSafety();

  const editable = enabled && def.writable && raw !== undefined;
  const isEnum = Boolean(def.options);

  const parsed = draft === '' ? undefined : Number(draft);
  const valid =
    parsed !== undefined &&
    Number.isFinite(parsed) &&
    (isEnum ||
      ((def.min === undefined || parsed >= def.min) &&
        (def.max === undefined || parsed <= def.max)));
  const nextRaw = valid ? (isEnum ? parsed : toRaw(def, parsed)) : undefined;
  const changed = nextRaw !== undefined && raw !== undefined && nextRaw !== raw;

  const chosen = isEnum ? def.options?.find((o) => o.value === nextRaw) : undefined;
  const currentOption = isEnum ? def.options?.find((o) => o.value === raw) : undefined;

  const show = (value: number) =>
    isEnum
      ? def.options?.find((o) => o.value === value)?.code ?? String(value)
      : `${toDisplay(def, value).toFixed(def.decimals)}${def.unit ?? ''}`;

  const apply = async () => {
    if (nextRaw === undefined || raw === undefined) return;
    setPending(true);
    setError(null);
    beginWrite();
    if (def.cascades) {
      setCascadeBefore(new Map(def.cascades.map((a) => [a, registers.get(a) ?? -1])));
    }
    try {
      const result = await writeRegister(def.addr, nextRaw, raw);
      setReport(result);
      setDraft('');
      setConfirming(false);
      onWritten();
    } catch (err) {
      setError(String(err));
      setConfirming(false);
      setCascadeBefore(null);
    } finally {
      setPending(false);
      endWrite();
    }
  };

  const cascadeRows = (def.cascades ?? [])
    .map((addr) => {
      const before = cascadeBefore?.get(addr);
      const now = registers.get(addr);
      if (before === undefined || now === undefined || before === now) return null;
      const other = REGISTERS.find((r) => r.addr === addr);
      const label = other?.label ?? `0x${addr.toString(16).padStart(4, '0')}`;
      const fmt = (v: number) =>
        other ? `${toDisplay(other, v).toFixed(other.decimals)}${other.unit ?? ''}` : String(v);
      return `${label} ${fmt(before)} → ${fmt(now)}`;
    })
    .filter((line): line is string => Boolean(line));

  return (
    <div className="setting">
      <div>
        <div className="name">
          {def.label}
          {def.confidence !== 'high' && (
            <span className={`badge ${def.confidence}`}>{def.confidence} confidence</span>
          )}
        </div>
        <div className="meta">
          {def.setting && <>{def.setting} · </>}
          <span className="mono">0x{def.addr.toString(16).padStart(4, '0')}</span>
          {raw !== undefined && <> · raw {raw}</>}
          {!isEnum && def.min !== undefined && def.max !== undefined && (
            <>
              {' '}
              · range {def.min}–{def.max}
              {def.unit}
            </>
          )}
        </div>
        {def.note && <div className="note">{def.note}</div>}

        {chosen?.warn && changed && <div className="note err">{chosen.warn}</div>}

        {report && (
          <div className="note">
            {report.ok ? '✓ ' : '✕ '}
            wrote {show(report.written)}; device now reads {show(report.readback)}
            {cascadeRows.length > 0 && (
              <>
                <br />
                Charge profile rewritten by the inverter: {cascadeRows.join(' · ')}
              </>
            )}
          </div>
        )}
        {error && <div className="note err">{error}</div>}

        {confirming && nextRaw !== undefined && raw !== undefined && (
          <div className="note">
            Change <strong>{def.label}</strong> from <strong>{show(raw)}</strong> to{' '}
            <strong>{show(nextRaw)}</strong>?{' '}
            {def.cascades && <>The inverter will rewrite the charge voltages to match. </>}
            <button className="danger" onClick={() => void apply()} disabled={pending}>
              {pending ? 'Writing…' : 'Confirm write'}
            </button>{' '}
            <button onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="current">
        {isEnum ? (
          <span className="mono">{currentOption?.code ?? (raw ?? '—')}</span>
        ) : (
          <>
            {formatValue(def, raw)}
            {def.unit && <span className="unit"> {def.unit}</span>}
          </>
        )}
      </div>

      <div>
        {def.writable ? (
          <div style={{ display: 'flex', gap: 6 }}>
            {isEnum ? (
              <select
                value={draft === '' ? String(raw ?? '') : draft}
                disabled={!editable || pending}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setConfirming(false);
                  setReport(null);
                }}
              >
                {def.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.code} — {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                value={draft}
                placeholder={raw !== undefined ? toDisplay(def, raw).toFixed(def.decimals) : ''}
                min={def.min}
                max={def.max}
                step={def.step}
                disabled={!editable || pending}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setConfirming(false);
                  setReport(null);
                }}
              />
            )}
            <button
              disabled={!editable || !changed || pending || confirming}
              onClick={() => setConfirming(true)}
            >
              Apply
            </button>
          </div>
        ) : (
          <span className="subtitle">read-only</span>
        )}
      </div>
    </div>
  );
}

export default function Settings({ registers, connected, onWritten }: Props) {
  // Write-unlock lives in shared state so the auto-updater can refuse to
  // relaunch the app while settings are unlocked.
  const { writesUnlocked: unlocked, setWritesUnlocked: setUnlocked } = useSafety();
  const [setupMode, setSetupMode] = useState(false);
  const [armingSetup, setArmingSetup] = useState(false);
  const byKey = new Map(REGISTERS.map((r) => [r.key, r]));

  const lockEverything = () => {
    setUnlocked(false);
    setSetupMode(false);
    setArmingSetup(false);
  };

  const batteryRaw = registers.get(0x1002);
  const lithium = isLithiumBatteryType(batteryRaw);

  return (
    <>
      <div className={`banner ${unlocked ? 'critical' : ''}`}>
        <span className="icon" aria-hidden="true">
          {unlocked ? '⚠' : '🔒'}
        </span>
        <div className="body">
          {unlocked ? (
            <>
              <strong>Writes are unlocked.</strong> Every write is guarded: the value you
              see must still match what the device holds, or it is refused. Most of this
              map is inferred rather than documented — confirm changes on the inverter's
              LCD afterwards.
            </>
          ) : (
            <>
              <strong>Read-only.</strong> Unlock to change settings. This is a 5 kW power
              converter attached to a large battery; the lock is here on purpose.
            </>
          )}
          <div style={{ marginTop: 8 }}>
            <button
              className={unlocked ? '' : 'danger'}
              onClick={() => (unlocked ? lockEverything() : setUnlocked(true))}
              disabled={!connected}
            >
              {unlocked ? 'Lock writes' : 'Unlock writes'}
            </button>
          </div>
        </div>
      </div>

      {GROUPS.filter((g) => !g.setup).map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <p className="desc">{group.desc}</p>
          {group.keys
            .map((key) => byKey.get(key))
            .filter((def): def is RegisterDef => Boolean(def))
            .map((def) => (
              <Row
                key={def.key}
                def={def}
                registers={registers}
                enabled={unlocked}
                onWritten={onWritten}
              />
            ))}
        </section>
      ))}

      {/* ------------------------------------------------------ setup tier -- */}
      <div className={`banner ${setupMode ? 'critical' : ''}`}>
        <span className="icon" aria-hidden="true">
          {setupMode ? '⚠' : '🔧'}
        </span>
        <div className="body">
          <strong>Setup mode{setupMode ? ' is active' : ''}.</strong> Battery-defining
          parameters live behind this second gate because changing one makes the inverter
          rewrite a whole group of other registers at once. Ordinary settings do not need
          it.
          {!unlocked && (
            <>
              {' '}
              Unlock writes first.
            </>
          )}
          {armingSetup && (
            <div style={{ marginTop: 8 }}>
              Enabling setup mode allows changing the battery type. The inverter will
              immediately rewrite its constant-charge, boost and float voltages to that
              profile's defaults, discarding any values you have tuned. Continue?{' '}
              <button className="danger" onClick={() => { setSetupMode(true); setArmingSetup(false); }}>
                Enable setup mode
              </button>{' '}
              <button onClick={() => setArmingSetup(false)}>Cancel</button>
            </div>
          )}
          {!armingSetup && (
            <div style={{ marginTop: 8 }}>
              <button
                className={setupMode ? '' : 'danger'}
                disabled={!unlocked || !connected}
                onClick={() => (setupMode ? setSetupMode(false) : setArmingSetup(true))}
              >
                {setupMode ? 'Leave setup mode' : 'Enter setup mode'}
              </button>
            </div>
          )}
        </div>
      </div>

      {batteryRaw !== undefined && !lithium && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            !
          </span>
          <div className="body">
            A <strong>lead-acid profile</strong> is selected. For a 16-cell LiFePO4 bank,{' '}
            <strong>L16</strong> is the match. Avoid <strong>USE</strong> — it makes
            equalization effective and equalization defaults to enabled, which is harmful
            to lithium.
          </div>
        </div>
      )}

      {GROUPS.filter((g) => g.setup).map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <p className="desc">{group.desc}</p>
          {group.keys
            .map((key) => byKey.get(key))
            .filter((def): def is RegisterDef => Boolean(def))
            .map((def) => (
              <Row
                key={def.key}
                def={def}
                registers={registers}
                enabled={unlocked && setupMode}
                onWritten={onWritten}
              />
            ))}
        </section>
      ))}
    </>
  );
}
