import {
  BUILD_STRING_RANGE,
  REGISTERS,
  decodeAscii,
  describeBatteryCurrent,
  describeBatteryType,
  formatValue,
  type RegisterDef,
} from '../registers';

interface Props {
  registers: Map<number, number>;
  connected: boolean;
}

function Tile({ def, registers }: { def: RegisterDef; registers: Map<number, number> }) {
  const raw = registers.get(def.addr);
  return (
    <div className="tile">
      <div className="label">
        {def.label}
        {def.confidence !== 'high' && (
          <span className={`badge ${def.confidence}`}>{def.confidence} confidence</span>
        )}
      </div>
      <div className="value">
        {formatValue(def, raw)}
        {def.unit && <span className="unit">{def.unit}</span>}
      </div>
      <div className="hint">
        <span className="mono">0x{def.addr.toString(16).padStart(4, '0')}</span>
        {raw !== undefined && <> · raw {raw}</>}
      </div>
      {def.note && <div className="hint">{def.note}</div>}
    </div>
  );
}

export default function Dashboard({ registers, connected }: Props) {
  const live = REGISTERS.filter((r) => r.kind === 'live');
  const info = REGISTERS.filter((r) => r.kind === 'info');
  const build = decodeAscii(registers, BUILD_STRING_RANGE.addr, BUILD_STRING_RANGE.count);

  const battery = describeBatteryType(registers.get(0x1002));
  const boost = registers.get(0x1007);
  const float = registers.get(0x1008);
  const current = describeBatteryCurrent(registers.get(0x0501));
  const mains = registers.get(0x061f);

  const idle = connected && current?.direction === 'idle' && !mains;

  return (
    <>
      {connected && battery && !battery.lithium && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            !
          </span>
          <div className="body">
            <strong>Charge profile is set to {battery.code} — a lead-acid profile.</strong>{' '}
            {boost !== undefined && float !== undefined && (
              <>
                Charging stops at {(boost * 0.4).toFixed(1)} V and then floats at{' '}
                {(float * 0.4).toFixed(1)} V.{' '}
              </>
            )}
            On a 16S LiFePO4 bank the float is the problem — holding 3.45 V/cell
            indefinitely is hard on the cells. <strong>L16</strong> is the matching
            lithium profile. Change it on the LCD, not here.
          </div>
        </div>
      )}

      {idle && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            !
          </span>
          <div className="body">
            <strong>Inverter appears idle.</strong> Almost every telemetry register reads
            zero when the unit is neither charging nor inverting, so most of this page will
            stay blank until there is PV input or a load. That is expected, not a fault.
          </div>
        </div>
      )}

      {current && (
        <div className="tiles">
          <div className="tile">
            <div className="label">Battery</div>
            <div className="value">
              {current.magnitude.toFixed(1)}
              <span className="unit">A</span>
            </div>
            <div className="hint">
              {current.direction}
              {mains ? ' · mains present' : ' · off-grid'}
            </div>
          </div>
        </div>
      )}

      <div className="tiles">
        {live.map((def) => (
          <Tile key={def.key} def={def} registers={registers} />
        ))}
      </div>

      <section>
        <h2>Device</h2>
        <p className="desc">
          Identity read from the inverter. The firmware build date is stored as ASCII, one
          character per register from <span className="mono">0x0418</span>.
        </p>
        <table className="raw">
          <tbody>
            {info.map((def) => (
              <tr key={def.key}>
                <td>{def.label}</td>
                <td>
                  {formatValue(def, registers.get(def.addr))} {def.unit}
                </td>
              </tr>
            ))}
            <tr>
              <td>Battery type</td>
              <td>
                {battery ? (
                  <>
                    <span className="mono">{battery.code}</span> — {battery.label}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
            <tr>
              <td>Charge stops at</td>
              <td>{boost !== undefined ? `${(boost * 0.4).toFixed(1)} V` : '—'}</td>
            </tr>
            <tr>
              <td>Then floats at</td>
              <td>{float !== undefined ? `${(float * 0.4).toFixed(1)} V` : '—'}</td>
            </tr>
            <tr>
              <td>Firmware build</td>
              <td className="mono">{build || '—'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>What is not here yet</h2>
        <p className="desc">
          Battery voltage and current, PV voltage and AC input voltage are all identified,
          verified against the battery pack's own readout across a known step change.
          Still missing: <strong>PV current</strong>, <strong>load power</strong> and{' '}
          <strong>output power</strong>.
        </p>
        <p className="desc">
          <span className="mono">0x0502</span> is likely the inverter's{' '}
          <strong>own</strong> state-of-charge estimate. With no BMS link it can only infer
          SOC from voltage, so it will disagree with the battery pack, which counts
          coulombs — the two are different quantities, not a contradiction. It stays within
          45–100, caps at exactly 100, and correlates 0.47 with battery voltage: too loose
          for a raw voltage lookup, about right for a smoothed one.
        </p>
        <p className="desc">
          <span className="mono">0x0510</span> is the strongest unidentified signal —
          correlating 0.84 with battery voltage across 517 samples.{' '}
          <span className="mono">0x0509</span> matched it exactly across one charge step but
          diverges over longer windows, so they are not the same quantity.
        </p>
        <p className="desc">
          The way to name them is a step change in <strong>load</strong> rather than
          charge: start logging in the Raw registers tab, switch something substantial on,
          and diff across the boundary. Anything tracking load power has to move sharply
          there; anything that does not, is not it.
        </p>
      </section>
    </>
  );
}
