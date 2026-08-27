import { useEffect, useRef, useState } from 'react';

import { connect, disconnect, listPorts, type PortInfo } from '../api';

interface Props {
  connected: boolean;
  onConnectedChange: (connected: boolean) => void;
  lastRead: Date | null;
}

const BAUD = 9600;
const SLAVE = 1;

const AUTO_KEY = 'ampinvt-ui.auto-connect';
const PORT_KEY = 'ampinvt-ui.last-port';

export function loadAutoConnect(): boolean {
  // Default on: the common case is a machine left running to log, where nobody
  // is present to press Connect after a restart.
  return localStorage.getItem(AUTO_KEY) !== 'false';
}

/** Timestamps are shown in local time; the underlying Date stays absolute. */
function formatLocal(when: Date): string {
  return when.toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Pick the port to connect to, in order of preference: the one used last time,
 * then anything identifying as the inverter's CH340, then the first available.
 * Remembering the last port matters when more than one serial device is
 * present — otherwise a reboot could attach to the wrong one.
 */
function choosePort(ports: PortInfo[]): PortInfo | undefined {
  const remembered = localStorage.getItem(PORT_KEY);
  return (
    ports.find((p) => p.path === remembered) ??
    ports.find((p) => p.likely_inverter) ??
    ports[0]
  );
}

export default function ConnectionBar({ connected, onConnectedChange, lastRead }: Props) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoConnect, setAutoConnect] = useState(loadAutoConnect);

  /** Auto-connect is a startup action, not a policy — only ever fires once. */
  const autoTried = useRef(false);

  const refresh = async (): Promise<PortInfo[]> => {
    try {
      const found = await listPorts();
      setPorts(found);
      setError(null);
      setSelected((current) => current || choosePort(found)?.path || '');
      return found;
    } catch (err) {
      setError(String(err));
      return [];
    }
  };

  const open = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await connect(path, BAUD, SLAVE);
      localStorage.setItem(PORT_KEY, path);
      onConnectedChange(true);
    } catch (err) {
      setError(String(err));
      onConnectedChange(false);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void (async () => {
      const found = await refresh();
      if (autoTried.current || !loadAutoConnect() || connected) return;
      autoTried.current = true;
      const target = choosePort(found);
      if (target) await open(target.path);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    if (!connected) {
      await open(selected);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await disconnect();
      onConnectedChange(false);
    } catch (err) {
      setError(String(err));
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

      <button
        className={connected ? '' : 'primary'}
        onClick={() => void toggle()}
        disabled={busy || (!connected && !selected)}
      >
        {connected ? 'Disconnect' : 'Connect'}
      </button>

      <label
        style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12 }}
      >
        <input
          type="checkbox"
          checked={autoConnect}
          onChange={(e) => {
            setAutoConnect(e.target.checked);
            localStorage.setItem(AUTO_KEY, String(e.target.checked));
          }}
        />
        Connect on startup
      </label>

      <span className={`status ${state}`}>
        <span className="dot" aria-hidden="true" />
        {label}
      </span>

      {lastRead && <span className="subtitle">last read {formatLocal(lastRead)}</span>}

      {error && <span className="err">{error}</span>}
    </div>
  );
}
