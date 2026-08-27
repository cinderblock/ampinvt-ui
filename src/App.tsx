import { useCallback, useEffect, useRef, useState } from 'react';

import './styles.css';
import { FAST_BLOCKS, POLL_BLOCKS, SLOW_BLOCKS } from './registers';
import { readBlocks, startLogging, toRegisterMap, type BlockResult } from './api';
import LoggingPanel, { loadLogEnabled, loadLogInterval } from './components/LoggingPanel';
import { SafetyProvider, useSafety } from './safety';
import { loadPrefs, useUpdater, type UpdatePrefs } from './updater';
import ConnectionBar from './components/ConnectionBar';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import RawExplorer from './components/RawExplorer';
import Updates from './components/Updates';

type Tab = 'dashboard' | 'settings' | 'raw' | 'updates';

/**
 * The inverter's bus does not like being polled hard. One second is the
 * documented ceiling and there is no reason to go faster — nothing on this
 * device changes quickly.
 */
const POLL_MS = 1000;
/** Ceiling for the failure back-off. */
const MAX_POLL_MS = 15000;
/** Settings and identity barely move; a write re-reads them immediately anyway. */
const SLOW_POLL_MS = 15000;

function Shell() {
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [registers, setRegisters] = useState<Map<number, number>>(new Map());
  const [blocks, setBlocks] = useState<BlockResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<Date | null>(null);
  const [prefs, setPrefs] = useState<UpdatePrefs>(() => loadPrefs());

  const { interruptUnsafe } = useSafety();
  const updater = useUpdater({ prefs, interruptUnsafe });

  /** Guards against overlapping polls when a read runs long. */
  const inFlight = useRef(false);

  const failedBlocks = blocks.filter((b) => b.error !== null);

  /** Consecutive fully-failed polls, used to back off. */
  const failStreak = useRef(0);
  const [pollMs, setPollMs] = useState(POLL_MS);

  const poll = useCallback(async (which: { addr: number; count: number }[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const results = await readBlocks(which);
      // Merge rather than replace: a fast poll must not blank the settings
      // that only the slow poll refreshes.
      setBlocks((prev) => {
        const merged = new Map(prev.map((b) => [b.addr, b]));
        results.forEach((b) => merged.set(b.addr, b));
        return [...merged.values()].sort((a, b) => a.addr - b.addr);
      });
      setRegisters((prev) => {
        const merged = new Map(prev);
        for (const [addr, value] of toRegisterMap(results)) merged.set(addr, value);
        return merged;
      });
      setLastRead(new Date());
      setError(null);

      // Hammering a device that is not answering just burns the serial port
      // and fills the log with timeouts. Back off, then recover immediately
      // once a single block reads cleanly again.
      const allFailed = results.every((r) => r.error !== null);
      failStreak.current = allFailed ? failStreak.current + 1 : 0;
      setPollMs(
        failStreak.current === 0
          ? POLL_MS
          : Math.min(POLL_MS * 2 ** Math.min(failStreak.current, 4), MAX_POLL_MS),
      );
    } catch (err) {
      setError(String(err));
      failStreak.current += 1;
      setPollMs(Math.min(POLL_MS * 2 ** Math.min(failStreak.current, 4), MAX_POLL_MS));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!connected) return undefined;
    // First read covers everything so settings populate immediately.
    void poll(POLL_BLOCKS);
    const fast = setInterval(() => void poll(FAST_BLOCKS), pollMs);
    const slow = setInterval(() => void poll(SLOW_BLOCKS), SLOW_POLL_MS);
    return () => {
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [connected, poll, pollMs]);

  // Logging is on by default: the data is only capturable while the event is
  // happening, and a missed solar ramp cannot be recovered later.
  useEffect(() => {
    if (!connected || !loadLogEnabled()) return;
    void startLogging(loadLogInterval()).catch(() => undefined);
  }, [connected]);

  return (
    <div className="app">
      <header className="bar">
        <div>
          <h1>AMPINVT Inverter</h1>
          <div className="subtitle">TEL-48502M100 · Modbus RTU 9600 8N1 · slave 1</div>
        </div>
        <div className="spacer" />
        <ConnectionBar
          connected={connected}
          onConnectedChange={(next) => {
            setConnected(next);
            if (!next) {
              setRegisters(new Map());
              setBlocks([]);
              setLastRead(null);
            }
          }}
          lastRead={lastRead}
        />
      </header>

      {updater.phase === 'available' && tab !== 'updates' && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            ↑
          </span>
          <div className="body">
            <strong>Version {updater.update?.version} is available.</strong>{' '}
            <button onClick={() => setTab('updates')}>Show</button>{' '}
            <button className="primary" onClick={() => void updater.install()}>
              Install and restart
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="banner critical">
          <span className="icon" aria-hidden="true">
            ✕
          </span>
          <div className="body">
            <strong>Read failed.</strong> {error}
          </div>
        </div>
      )}

      {/*
        Per-block failures used to render as "—" and nothing else, which is
        indistinguishable from "no data yet" — a total read failure could look
        like an empty screen with no error at all. Surface them.
      */}
      {failedBlocks.length > 0 && (
        <div className="banner critical">
          <span className="icon" aria-hidden="true">
            ✕
          </span>
          <div className="body">
            <strong>
              {failedBlocks.length === blocks.length
                ? 'Every register block failed to read.'
                : `${failedBlocks.length} of ${blocks.length} register blocks failed to read.`}
            </strong>{' '}
            Values shown as <span className="mono">—</span> are missing, not zero.
            <br />
            {failedBlocks.map((b) => (
              <span key={b.addr} className="mono" style={{ marginRight: 12 }}>
                0x{b.addr.toString(16).padStart(4, '0')}: {b.error}
              </span>
            ))}
          </div>
        </div>
      )}

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'dashboard'} onClick={() => setTab('dashboard')}>
          Dashboard
        </button>
        <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>
          Settings
        </button>
        <button role="tab" aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>
          Raw registers
        </button>
        <button role="tab" aria-selected={tab === 'updates'} onClick={() => setTab('updates')}>
          Updates
          {updater.phase === 'available' && ' •'}
        </button>
      </nav>

      {!connected && tab !== 'updates' && (
        <div className="banner">
          <span className="icon" aria-hidden="true">
            !
          </span>
          <div className="body">
            <strong>Not connected.</strong> Pick the serial port above and connect. The
            inverter shows up as a CH340 (USB <span className="mono">1A86:7523</span>).
          </div>
        </div>
      )}

      {tab === 'dashboard' && <Dashboard registers={registers} connected={connected} />}
      {tab === 'settings' && (
        <Settings
          registers={registers}
          connected={connected}
          // A write lands in the slow blocks, so re-read those rather than
          // waiting up to 15s for the next slow tick.
          onWritten={() => void poll(SLOW_BLOCKS)}
        />
      )}
      {tab === 'raw' && (
        <>
          <LoggingPanel connected={connected} />
          <RawExplorer blocks={blocks} />
        </>
      )}
      {tab === 'updates' && (
        <Updates
          prefs={prefs}
          onPrefsChange={setPrefs}
          phase={updater.phase}
          version={updater.update?.version}
          currentVersion={updater.update?.currentVersion}
          notes={updater.update?.body}
          error={updater.error}
          progress={updater.progress}
          lastChecked={updater.lastChecked}
          onCheck={() => void updater.check()}
          onInstall={() => void updater.install()}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <SafetyProvider>
      <Shell />
    </SafetyProvider>
  );
}
