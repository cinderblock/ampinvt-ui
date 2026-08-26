import { useEffect, useState } from 'react';

import { connect, disconnect, listPorts, type PortInfo } from '../api';

interface Props {
  connected: boolean;
  onConnectedChange: (connected: boolean) => void;
  lastRead: Date | null;
}

const BAUD = 9600;
const SLAVE = 1;

/** Timestamps are shown in local time; the underlying Date stays absolute. */
function formatLocal(when: Date): string {
  return when.toLocaleTimeString(undefined, { hour12: false });
}

export default function ConnectionBar({ connected, onConnectedChange, lastRead }: Props) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const found = await listPorts();
      setPorts(found);
      setError(null);
      if (!selected) {
        // Default to the CH340 when we can see one.
        const guess = found.find((p) => p.likely_inverter) ?? found[0];
        if (guess) setSelected(guess.path);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (connected) {
        await disconnect();
        onConnectedChange(false);
      } else {
        await connect(selected, BAUD, SLAVE);
        onConnectedChange(true);
      }
    } catch (err) {
      setError(String(err));
      onConnectedChange(false);
    } finally {
      setBusy(false);
    }
  };

  const state = connected ? 'good' : 'idle';
  const label = connected ? 'Connected' : 'Disconnected';

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      {!connected && (
        <>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || ports.length === 0}
          >
            {ports.length === 0 && <option value="">No serial ports found</option>}
            {ports.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label}
                {p.likely_inverter ? '  — likely the inverter' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => void refresh()} disabled={busy}>
            Rescan
          </button>
        </>
      )}

      <button className={connected ? '' : 'primary'} onClick={() => void toggle()} disabled={busy || (!connected && !selected)}>
        {connected ? 'Disconnect' : 'Connect'}
      </button>

      <span className={`status ${state}`}>
        <span className="dot" aria-hidden="true" />
        {label}
      </span>

      {lastRead && <span className="subtitle">last read {formatLocal(lastRead)}</span>}

      {error && <span className="err">{error}</span>}
    </div>
  );
}
