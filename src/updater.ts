import { useCallback, useEffect, useRef, useState } from 'react';

import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

const PREFS_KEY = 'ampinvt-ui.update-prefs';

export interface UpdatePrefs {
  /** Install automatically once an update is available and the app has gone idle. */
  autoInstall: boolean;
  /** How long the app must be idle before an automatic install may start. */
  idleMinutes: number;
}

export const DEFAULT_PREFS: UpdatePrefs = { autoInstall: false, idleMinutes: 5 };

export function loadPrefs(): UpdatePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UpdatePrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: UpdatePrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export type Phase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'uptodate'
  | 'error';

/** How often to ask GitHub whether there is a newer release. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** How often to re-evaluate whether the idle+safe conditions are met. */
const TICK_MS = 15 * 1000;

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'focus'];

interface Options {
  prefs: UpdatePrefs;
  /**
   * True when an unattended relaunch must not happen — writes unlocked, or a
   * write in flight. Manual installs ignore this; the user chose those.
   */
  interruptUnsafe: boolean;
}

export function useUpdater({ prefs, interruptUnsafe }: Options) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const lastActivity = useRef(Date.now());
  /** Latched so an auto-install can never be started twice. */
  const installing = useRef(false);

  useEffect(() => {
    const bump = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, bump, { passive: true }));
    return () =>
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, bump));
  }, []);

  const doCheck = useCallback(async () => {
    if (installing.current) return;
    setPhase('checking');
    setError(null);
    try {
      const found = await check();
      setLastChecked(new Date());
      if (found) {
        setUpdate(found);
        setPhase('available');
      } else {
        setUpdate(null);
        setPhase('uptodate');
      }
    } catch (err) {
      // `check()` throws in `tauri dev` because there is no signed bundle to
      // compare against. That is expected, not a fault worth alarming about.
      setError(String(err));
      setPhase('error');
    }
  }, []);

  const install = useCallback(async () => {
    if (!update || installing.current) return;
    installing.current = true;
    try {
      setPhase('downloading');
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
          setProgress(0);
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          setProgress(total > 0 ? received / total : null);
        } else if (event.event === 'Finished') {
          setProgress(1);
          setPhase('installing');
        }
      });
      await relaunch();
    } catch (err) {
      setError(String(err));
      setPhase('error');
      installing.current = false;
    }
  }, [update]);

  // Periodic check.
  useEffect(() => {
    void doCheck();
    const id = setInterval(() => void doCheck(), CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [doCheck]);

  // Automatic install, once available AND idle AND safe to interrupt.
  useEffect(() => {
    if (!prefs.autoInstall) return undefined;
    const id = setInterval(() => {
      if (phase !== 'available' || !update || installing.current) return;
      if (interruptUnsafe) return;
      const idleMs = Date.now() - lastActivity.current;
      if (idleMs >= prefs.idleMinutes * 60 * 1000) void install();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [prefs.autoInstall, prefs.idleMinutes, phase, update, interruptUnsafe, install]);

  const idleSeconds = () => Math.floor((Date.now() - lastActivity.current) / 1000);

  return { phase, update, error, progress, lastChecked, check: doCheck, install, idleSeconds };
}
