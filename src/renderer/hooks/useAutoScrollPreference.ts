import { useCallback, useState } from "react";

export const AUTO_SCROLL_STORAGE_KEY = "snow.chat.autoScroll";

// 默认开启，仅显式记录为 "false" 时关闭
const readAutoScrollPreference = (): boolean => {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    return window.localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

const writeAutoScrollPreference = (enabled: boolean): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      AUTO_SCROLL_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // Ignore storage access errors. Preference still works for current session.
  }
};

export const useAutoScrollPreference = (): {
  autoScrollEnabled: boolean;
  setAutoScrollEnabled: (enabled: boolean) => void;
} => {
  const [autoScrollEnabled, setAutoScrollEnabledState] = useState(
    readAutoScrollPreference,
  );

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    writeAutoScrollPreference(enabled);
    setAutoScrollEnabledState(enabled);
  }, []);

  return {
    autoScrollEnabled,
    setAutoScrollEnabled,
  };
};
