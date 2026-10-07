import { useEffect, useSyncExternalStore } from "react";

export type BusySendBehavior = "queue" | "steer";
export const BUSY_SEND_BEHAVIOR_SETTING = "chat_busy_send_behavior";

type BusySendSnapshot = {
  behavior: BusySendBehavior;
  ready: boolean;
  saving: boolean;
  error: "load" | "save" | null;
};

let snapshot: BusySendSnapshot = {
  behavior: "steer",
  ready: false,
  saving: false,
  error: null,
};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = (next: BusySendSnapshot): void => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = (): BusySendSnapshot => snapshot;

const load = (): Promise<void> => {
  if (!loading) {
    loading = (async () => {
      try {
        const value = await window.snow.getSystemSettingValue(
          BUSY_SEND_BEHAVIOR_SETTING,
        );
        publish({
          ...snapshot,
          behavior: value === "queue" ? "queue" : "steer",
          ready: true,
          error: null,
        });
      } catch {
        publish({ ...snapshot, ready: true, error: "load" });
      }
    })();
  }
  return loading;
};

/** Persist before publishing: failed writes never change the effective behavior.
 * The shared external store synchronizes every mounted input immediately. */
const setBusySendBehavior = async (
  behavior: BusySendBehavior,
): Promise<void> => {
  await load();
  if (snapshot.saving) return;
  publish({ ...snapshot, saving: true, error: null });
  try {
    await window.snow.setSystemSetting(
      "繁忙时的发送行为",
      BUSY_SEND_BEHAVIOR_SETTING,
      behavior,
    );
    publish({ ...snapshot, behavior, saving: false, error: null });
  } catch {
    publish({ ...snapshot, saving: false, error: "save" });
  }
};

export const useBusySendBehavior = () => {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    void load();
  }, []);
  return { ...state, setBusySendBehavior };
};
