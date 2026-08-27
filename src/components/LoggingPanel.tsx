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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Projected daily growth from what has actually been written so far, rather
 * than from a nominal record size — deltas make the real figure depend
 * entirely on how much the inverter is moving.
 */
function perDay(bytes: number, records: number, intervalSecs: number): number {
  const perRecord = bytes / records;
  return perRecord * (86400 / Math.max(1, intervalSecs));
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
        {status && (
          <span className="subtitle">
            {status.records.toLocaleString()} records
            {status.bytes > 0 && <> · {formatBytes(status.bytes)}</>}
            {status.bytes > 0 && status.records > 20 && (
              <> · ~{formatBytes(perDay(status.bytes, status.records, interval))}/day</>
            )}
          </span>
        )}
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
        Delta-encoded. A record marked <span className="mono">"full":true</span> carries
        every register; the ones after it carry only what changed, with a fresh full
        snapshot each hour so the file stays readable from its own start. Around 343 of the
        384 registers never move, so this is far smaller than it sounds — full dumps cost
        ~3.7&nbsp;kB each, roughly 32&nbsp;MB/day at a 10&nbsp;second interval.
        <br />
        Rotates at 32&nbsp;MB keeping one previous generation
        (<span className="mono">.jsonl.1</span>). Timestamps are UTC ISO-8601 so they can be
        re-bucketed losslessly; keys are decimal register addresses.
      </p>
    </section>
  );
}
