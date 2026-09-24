import { useSyncExternalStore } from "react";

const MESSAGE_TIME_SETTING_NAME = "消息创建时间显示";
const MESSAGE_TIME_SETTING_CODE = "chat_message_time_visible";

let visible = false;
let loaded = false;
let loadPromise: Promise<void> | null = null;

const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const persist = (next: boolean): void => {
  void window.snow
    .setSystemSetting(
      MESSAGE_TIME_SETTING_NAME,
      MESSAGE_TIME_SETTING_CODE,
      next ? "1" : "0",
    )
    .catch(() => {});
};

export const getMessageTimeVisible = (): boolean => visible;

export const setMessageTimeVisible = (next: boolean): void => {
  if (visible === next) {
    return;
  }
  visible = next;
  persist(next);
  notify();
};

export const toggleMessageTimeVisible = (): void => {
  setMessageTimeVisible(!visible);
};

export const ensureMessageTimeVisibilityLoaded = (): Promise<void> => {
  if (loaded) {
    return Promise.resolve();
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = window.snow
    .getSystemSettingValue(MESSAGE_TIME_SETTING_CODE)
    .then((raw) => {
      loaded = true;
      const text = raw?.trim() ?? "";
      if (text === "") {
        return;
      }
      const next = text === "1" || text === "true";
      if (next !== visible) {
        visible = next;
        notify();
      }
    })
    .catch(() => {
      loaded = true;
    });
  return loadPromise;
};

export const subscribeMessageTimeVisible = (
  listener: () => void,
): (() => void) => {
  void ensureMessageTimeVisibilityLoaded();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useMessageTimeVisible = (): boolean =>
  useSyncExternalStore(
    subscribeMessageTimeVisible,
    getMessageTimeVisible,
    getMessageTimeVisible,
  );
