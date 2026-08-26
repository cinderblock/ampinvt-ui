import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Shared "is it safe to interrupt the app right now?" signal.
 *
 * The auto-updater relaunches the process. Doing that while the user has writes
 * unlocked — or worse, mid-write to a 5 kW converter — is not acceptable, so the
 * updater consults this before ever installing on its own. Manual installs are
 * the user's call and are not gated.
 */
interface Safety {
  writesUnlocked: boolean;
  setWritesUnlocked: (unlocked: boolean) => void;
  /** Non-zero while any guarded write is in flight. */
  writesInFlight: number;
  beginWrite: () => void;
  endWrite: () => void;
  /** True when an automatic, unattended install must not happen. */
  interruptUnsafe: boolean;
}

const SafetyContext = createContext<Safety | null>(null);

export function SafetyProvider({ children }: { children: ReactNode }) {
  const [writesUnlocked, setWritesUnlocked] = useState(false);
  const [writesInFlight, setWritesInFlight] = useState(0);
  const counter = useRef(0);

  const value = useMemo<Safety>(
    () => ({
      writesUnlocked,
      setWritesUnlocked,
      writesInFlight,
      beginWrite: () => {
        counter.current += 1;
        setWritesInFlight(counter.current);
      },
      endWrite: () => {
        counter.current = Math.max(0, counter.current - 1);
        setWritesInFlight(counter.current);
      },
      interruptUnsafe: writesUnlocked || writesInFlight > 0,
    }),
    [writesUnlocked, writesInFlight],
  );

  return <SafetyContext.Provider value={value}>{children}</SafetyContext.Provider>;
}

export function useSafety(): Safety {
  const ctx = useContext(SafetyContext);
  if (!ctx) throw new Error('useSafety must be used inside a SafetyProvider');
  return ctx;
}
