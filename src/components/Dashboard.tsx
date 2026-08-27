import {
  BATTERY_CURRENT,
  BUILD_STRING_RANGE,
  REGISTERS,
  decodeAscii,
  describeBatteryType,
  describeFlow,
  formatValue,
  type RegisterDef,
} from '../registers';

interface Props {
  registers: Map<number, number>;
  connected: boolean;
}

function Tile({ def, registers }: { def: RegisterDef; registers: Map<number, number> }) {
  const raw = registers.get(def.addr);
  const flow = describeFlow(def, raw);
  return (
    <div className={flow ? `tile flow-${flow.direction}` : 'tile'}>
      <div className="label">
        {def.label}
        {def.confidence !== 'high' && (
          <span className={`badge ${def.confidence}`}>{def.confidence} confidence</span>
        )}
      </div>
      <div className="value">
        {flow ? flow.magnitude.toFixed(def.decimals) : formatValue(def, raw)}
        {def.unit && <span className="unit">{def.unit}</span>}
      </div>
      {flow && (
        <div className="direction">
          <span aria-hidden="true">{flow.arrow}</span>
          {flow.label}
        </div>
      )}
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
  const current = describeFlow(BATTERY_CURRENT, registers.get(BATTERY_CURRENT.addr));
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
            <strong>Inverter appears idle.</strong> Telemetry reads zero until there is PV
            input or a load — expected, not a fault.
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
          Battery voltage and current, PV voltage, AC input voltage, PV input power and
          total input power are all identified against real operating data. Still missing:{' '}
          <strong>load power</strong> and <strong>output power</strong>.
        </p>
        <p className="desc">
          Those two need a step change in <strong>load</strong> rather than charge — every
          step so far has been charge-side, which is exactly why only charge-side registers
          have names. Start logging, switch something substantial on, and diff across the
          boundary with <span className="mono">tools/step_diff.py</span>.
        </p>
      </section>
    </>
  );
}
