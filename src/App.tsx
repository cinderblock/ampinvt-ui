import { useCallback, useEffect, useRef, useState } from 'react';

import './styles.css';
import { POLL_BLOCKS } from './registers';
import { readBlocks, toRegisterMap, type BlockResult } from './api';
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

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const results = await readBlocks(POLL_BLOCKS);
      setBlocks(results);
      setRegisters(toRegisterMap(results));
      setLastRead(new Date());
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!connected) return undefined;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [connected, poll]);

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
        <Settings registers={registers} connected={connected} onWritten={() => void poll()} />
      )}
      {tab === 'raw' && <RawExplorer blocks={blocks} />}
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
