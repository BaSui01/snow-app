import { useEffect, useState } from "react";
import type { TerminalSettings } from "../../../preload";
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_SETTING_CODE,
} from "../sidebar/terminalSettings/terminalSettingsConstants";
import { readTerminalSettingsJson } from "../sidebar/terminalSettings/terminalSettingsUtils";

const TERMINAL_SETTINGS_CHANGED_EVENT = "terminal-settings-changed";

/**
 * Loads terminal settings from the system settings store and keeps them
 * in sync when settings are saved in TerminalSettingsPanel.
 *
 * Other components can dispatch the `terminal-settings-changed` window event
 * (e.g. after saving) so every running terminal picks up the new values.
 */
export function useTerminalSettings(): TerminalSettings {
  const [settings, setSettings] = useState<TerminalSettings>(
    DEFAULT_TERMINAL_SETTINGS,
  );

  useEffect(() => {
    let disposed = false;

    const loadSettings = async () => {
      try {
        const value = await window.snow.getSystemSettingValue(
          TERMINAL_SETTING_CODE,
        );
        if (!disposed) {
          setSettings(readTerminalSettingsJson(value));
        }
      } catch {
        if (!disposed) {
          setSettings(DEFAULT_TERMINAL_SETTINGS);
        }
      }
    };

    void loadSettings();

    const handleChange = () => void loadSettings();
    window.addEventListener(
      TERMINAL_SETTINGS_CHANGED_EVENT,
      handleChange as EventListener,
    );

    return () => {
      disposed = true;
      window.removeEventListener(
        TERMINAL_SETTINGS_CHANGED_EVENT,
        handleChange as EventListener,
      );
    };
  }, []);

  return settings;
}

/**
 * Notify all terminal instances that settings have changed so they can
 * reload from the store.
 */
export function notifyTerminalSettingsChanged(): void {
  window.dispatchEvent(new Event(TERMINAL_SETTINGS_CHANGED_EVENT));
}

export function subscribeTerminalSettingsChanged(
  listener: () => void,
): () => void {
  const handler = (): void => listener();
  window.addEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, handler);
  return () =>
    window.removeEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, handler);
}
