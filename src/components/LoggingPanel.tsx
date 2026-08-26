import { useEffect, useState } from 'react';

import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { loggingStatus, startLogging, stopLogging, type LoggingStatus } from '../api';

const INTERVAL_KEY = 'ampinvt-ui.log-interval';
const ENABLED_KEY = 'ampinvt-ui.log-enabled';

export const DEFAULT_INTERVAL = 10;

export function loadLogEnabled(): boolean {
  return localStorage.getItem(ENABLED_KEY) !== 'false';
}

export function loadLogInterval(): number {
  const raw = Number(localStorage.getItem(INTERVAL_KEY));
  return Number.isFinite(raw) && raw >= 2 ? raw : DEFAULT_INTERVAL;
}

interface Props {
  connected: boolean;
}

export default function LoggingPanel({ connected }: Props) {
  const [status, setStatus] = useState<LoggingStatus | null>(null);
  const [enabled, setEnabled] = useState(loadLogEnabled);
  const [interval, setIntervalSecs] = useState(loadLogInterval);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      void loggingStatus().then(setStatus).catch(() => undefined);
    }, 2000);
    void loggingStatus().then(setStatus).catch(() => undefined);
    return () => clearInterval(id);
  }, []);

  const toggle = async () => {
    setError(null);
    try {
      const next = !status?.running;
      localStorage.setItem(ENABLED_KEY, String(next));
      setEnabled(next);
      setStatus(next ? await startLogging(interval) : await stopLogging());
    } catch (err) {
      setError(String(err));
    }
  };

  const running = Boolean(status?.running);

  return (
    <section>
      <h2>Register logging</h2>
      <p className="desc">
        Writes <strong>every readable register</strong> — all 13 blocks, not just the ones
        with known meanings — as JSON Lines. The unnamed registers are the whole reason to
        log: identifying them means catching one move in step with something we can already
        name, like PV coming up at dawn.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`status ${running ? 'good' : 'idle'}`}>
          <span className="dot" aria-hidden="true" />
          {running ? 'Logging' : 'Stopped'}
        </span>
        <button className={running ? '' : 'primary'} onClick={() => void toggle()} disabled={!connected}>
          {running ? 'Stop logging' : 'Start logging'}
        </button>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          every
          <input
            type="number"
            min={2}
            max={3600}
            step={1}
            value={interval}
            disabled={running}
            style={{ width: 72 }}
            onChange={(e) => {
              const next = Math.max(2, Number(e.target.value) || DEFAULT_INTERVAL);
              setIntervalSecs(next);
              localStorage.setItem(INTERVAL_KEY, String(next));
            }}
          />
          seconds
        </label>
        {status && <span className="subtitle">{status.records.toLocaleString()} records</span>}
      </div>

      {status?.path && (
        <p className="desc" style={{ marginTop: 12 }}>
          <span className="mono">{status.path}</span>{' '}
          <button onClick={() => void revealItemInDir(status.path!).catch(() => undefined)}>
            Show file
          </button>
        </p>
      )}

      {!enabled && !running && (
        <p className="desc">
          Logging is disabled and will not start automatically on connect.
        </p>
      )}

      {(error || status?.last_error) && (
        <p className="desc err">{error ?? status?.last_error}</p>
      )}

      <p className="desc" style={{ marginTop: 12 }}>
        One record per sweep:{' '}
        <span className="mono">{'{"t":"2026-08-26T21:45:00Z","regs":{"1280":518,…}}'}</span>
        <br />
        Timestamps are UTC ISO-8601 so they can be re-bucketed losslessly; keys are decimal
        register addresses.
      </p>
    </section>
  );
}
