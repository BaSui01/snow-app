import { useCallback, useEffect, useState } from "react";
import type { AppLockState } from "../../preload";

export type AppLockController = {
  state: AppLockState | null;
  loading: boolean;
  locked: boolean;
  refresh: () => Promise<AppLockState | null>;
  lockNow: () => Promise<void>;
  markUnlocked: () => void;
};

let cachedState: AppLockState | null = null;
let inflightState: Promise<AppLockState | null> | null = null;

const loadAppLockState = (): Promise<AppLockState | null> => {
  if (!inflightState) {
    inflightState = window.snow
      .getAppLockState()
      .then((next) => {
        cachedState = next;
        return next;
      })
      .catch(() => null)
      .finally(() => {
        inflightState = null;
      });
  }
  return inflightState;
};

export const useAppLock = (): AppLockController => {
  const [state, setState] = useState<AppLockState | null>(cachedState);
  const [loading, setLoading] = useState(cachedState === null);

  const refresh = useCallback(async (): Promise<AppLockState | null> => {
    const next = await loadAppLockState();
    if (next) {
      setState(next);
    }
    setLoading(false);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.snow.onAppLockLocked(() => {
      void refresh();
    });
    return () => {
      unsubscribe();
    };
  }, [refresh]);

  const lockNow = useCallback(async (): Promise<void> => {
    await window.snow.lockApp();
    if (cachedState) {
      cachedState = { ...cachedState, locked: true };
    }
    setState((previous) =>
      previous ? { ...previous, locked: true } : previous,
    );
  }, []);

  const markUnlocked = useCallback((): void => {
    if (cachedState) {
      cachedState = { ...cachedState, locked: false };
    }
    setState((previous) =>
      previous ? { ...previous, locked: false } : previous,
    );
  }, []);

  return {
    state,
    loading,
    locked: state?.locked === true,
    refresh,
    lockNow,
    markUnlocked,
  };
};
