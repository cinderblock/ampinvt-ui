import { useState } from 'react';

import { writeRegister, type WriteReport } from '../api';
import { REGISTERS, formatValue, toDisplay, toRaw, type RegisterDef } from '../registers';

interface Props {
  registers: Map<number, number>;
  connected: boolean;
  onWritten: () => void;
}

const GROUPS: { title: string; desc: string; keys: string[] }[] = [
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
    title: 'Output (read-only here)',
    desc: 'Deliberately not writable from this app — changing them affects every connected load.',
    keys: ['acOutputVoltage', 'outputFrequency'],
  },
];

function Row({
  def,
  registers,
  unlocked,
  onWritten,
}: {
  def: RegisterDef;
  registers: Map<number, number>;
  unlocked: boolean;
  onWritten: () => void;
}) {
  const raw = registers.get(def.addr);
  const [draft, setDraft] = useState<string>('');
  const [pending, setPending] = useState(false);
  const [report, setReport] = useState<WriteReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const editable = unlocked && def.writable && raw !== undefined;
  const parsed = draft === '' ? undefined : Number(draft);
  const valid =
    parsed !== undefined &&
    Number.isFinite(parsed) &&
    (def.min === undefined || parsed >= def.min) &&
    (def.max === undefined || parsed <= def.max);
  const nextRaw = valid ? toRaw(def, parsed) : undefined;
  const changed = nextRaw !== undefined && raw !== undefined && nextRaw !== raw;

  const apply = async () => {
    if (nextRaw === undefined || raw === undefined) return;
    setPending(true);
    setError(null);
    try {
      const result = await writeRegister(def.addr, nextRaw, raw);
      setReport(result);
      setDraft('');
      setConfirming(false);
      onWritten();
    } catch (err) {
      setError(String(err));
      setConfirming(false);
    } finally {
      setPending(false);
    }
  };

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
          {def.min !== undefined && def.max !== undefined && (
            <>
              {' '}
              · range {def.min}–{def.max}
              {def.unit}
            </>
          )}
        </div>
        {def.note && <div className="note">{def.note}</div>}
        {report && (
          <div className="note">
            {report.ok ? '✓ ' : '✕ '}
            wrote {toDisplay(def, report.written).toFixed(def.decimals)}
            {def.unit}; device now reads{' '}
            {toDisplay(def, report.readback).toFixed(def.decimals)}
            {def.unit}
          </div>
        )}
        {error && <div className="note err">{error}</div>}
        {confirming && nextRaw !== undefined && raw !== undefined && (
          <div className="note">
            Change <strong>{def.label}</strong> from{' '}
            <strong>
              {toDisplay(def, raw).toFixed(def.decimals)}
              {def.unit}
            </strong>{' '}
            to{' '}
            <strong>
              {toDisplay(def, nextRaw).toFixed(def.decimals)}
              {def.unit}
            </strong>
            ?{' '}
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
        {formatValue(def, raw)}
        {def.unit && <span className="unit"> {def.unit}</span>}
      </div>

      <div>
        {def.writable ? (
          <div style={{ display: 'flex', gap: 6 }}>
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
  const [unlocked, setUnlocked] = useState(false);
  const byKey = new Map(REGISTERS.map((r) => [r.key, r]));

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
              map is inferred rather than documented — confirm the change on the inverter's
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
              onClick={() => setUnlocked((v) => !v)}
              disabled={!connected}
            >
              {unlocked ? 'Lock writes' : 'Unlock writes'}
            </button>
          </div>
        </div>
      </div>

      {GROUPS.map((group) => (
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
                unlocked={unlocked}
                onWritten={onWritten}
              />
            ))}
        </section>
      ))}
    </>
  );
}
