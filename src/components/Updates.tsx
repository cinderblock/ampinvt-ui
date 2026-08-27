import { useSafety } from '../safety';
import { savePrefs, type Phase, type UpdatePrefs } from '../updater';
import ReleaseNotes from './ReleaseNotes';

interface Props {
  prefs: UpdatePrefs;
  onPrefsChange: (prefs: UpdatePrefs) => void;
  phase: Phase;
  version?: string;
  currentVersion?: string;
  notes?: string;
  error: string | null;
  progress: number | null;
  lastChecked: Date | null;
  onCheck: () => void;
  onInstall: () => void;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: 'Not checked yet',
  checking: 'Checking for updates…',
  available: 'Update available',
  downloading: 'Downloading…',
  installing: 'Installing — the app will restart',
  uptodate: 'Up to date',
  error: 'Could not check',
};

export default function Updates({
  prefs,
  onPrefsChange,
  phase,
  version,
  currentVersion,
  notes,
  error,
  progress,
  lastChecked,
  onCheck,
  onInstall,
}: Props) {
  const { interruptUnsafe, writesUnlocked, writesInFlight } = useSafety();

  const update = (next: Partial<UpdatePrefs>) => {
    const merged = { ...prefs, ...next };
    savePrefs(merged);
    onPrefsChange(merged);
  };

  const status =
    phase === 'available' ? 'warning' : phase === 'error' ? 'critical' : phase === 'uptodate' ? 'good' : 'idle';

  return (
    <>
      <section>
        <h2>Updates</h2>
        <p className="desc">
          Releases are published from CI and signed; the app verifies the signature before
          installing anything.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={`status ${status}`}>
            <span className="dot" aria-hidden="true" />
            {PHASE_TEXT[phase]}
          </span>
          <button onClick={onCheck} disabled={phase === 'checking' || phase === 'downloading'}>
            Check now
          </button>
          {phase === 'available' && (
            <button className="primary" onClick={onInstall}>
              Install and restart
            </button>
          )}
          {lastChecked && (
            <span className="subtitle">
              last checked {lastChecked.toLocaleTimeString(undefined, { hour12: false })}
            </span>
          )}
        </div>

        {progress !== null && phase === 'downloading' && (
          <p className="desc" style={{ marginTop: 10 }}>
            {Math.round(progress * 100)}% downloaded
          </p>
        )}

        {/*
          Show the installed version unconditionally. Previously it only
          appeared when an update was pending, which meant the one moment it
          could not be checked was straight after an install.
        */}
        <p className="desc" style={{ marginTop: 10 }}>
          Installed <span className="mono">{currentVersion ?? 'unknown'}</span>
          {version && (
            <>
              {' → available '}
              <span className="mono">{version}</span>
            </>
          )}
        </p>

        {notes && notes.trim() && (
          <div className="notes-panel">
            <div className="notes-title">
              Release notes{version ? <span className="mono"> {version}</span> : null}
            </div>
            <ReleaseNotes markdown={notes} />
          </div>
        )}

        {error && phase === 'error' && (
          <p className="desc err" style={{ marginTop: 10 }}>
            {error}
            <br />
            This is expected under <span className="mono">tauri dev</span> — there is no
            signed bundle to compare against outside a real install.
          </p>
        )}
      </section>

      <section>
        <h2>Automatic installation</h2>
        <p className="desc">
          Off by default. When on, an available update installs itself once the app has
          been idle for the chosen period — and only when it is safe to restart.
        </p>

        <div className="setting">
          <div>
            <div className="name">Install updates automatically when idle</div>
            <div className="note">
              The app restarts to finish installing. It will never do that on its own while
              writes are unlocked or a write is in flight — those are deliberately treated
              as "do not interrupt".
            </div>
          </div>
          <div className="current" />
          <div>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={prefs.autoInstall}
                onChange={(e) => update({ autoInstall: e.target.checked })}
              />
              {prefs.autoInstall ? 'On' : 'Off'}
            </label>
          </div>
        </div>

        <div className="setting">
          <div>
            <div className="name">Idle period before installing</div>
            <div className="note">
              Measured from the last mouse, keyboard or focus event in this window.
            </div>
          </div>
          <div className="current" />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={prefs.idleMinutes}
              disabled={!prefs.autoInstall}
              onChange={(e) => update({ idleMinutes: Math.max(1, Number(e.target.value) || 1) })}
            />
            <span className="subtitle">minutes</span>
          </div>
        </div>

        {prefs.autoInstall && interruptUnsafe && (
          <div className="banner" style={{ marginTop: 14, marginBottom: 0 }}>
            <span className="icon" aria-hidden="true">
              !
            </span>
            <div className="body">
              <strong>Automatic install is currently held off.</strong>{' '}
              {writesInFlight > 0
                ? 'A write is in flight.'
                : writesUnlocked
                  ? 'Writes are unlocked — lock them to allow an unattended restart.'
                  : ''}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
