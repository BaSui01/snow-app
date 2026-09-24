import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SETTING_CODE,
  TERMINAL_SETTING_NAME,
} from "../../sidebar/terminalSettings/terminalSettingsConstants";
import { readTerminalSettingsJson } from "../../sidebar/terminalSettings/terminalSettingsUtils";
import { notifyTerminalSettingsChanged } from "../useTerminalSettings";

const WHEEL_STEP_DELTA = 50;
const WHEEL_STEP_INTERVAL_MS = 80;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 120;
const PERSIST_DELAY_MS = 400;

let targetFontSize: number | null = null;
let unsavedFontSize = false;
let lastSettingFontSize: number | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

export const clampTerminalFontSize = (value: number): number =>
  Math.min(
    TERMINAL_FONT_SIZE_MAX,
    Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
  );

export function resolveTerminalFontSize(settingFontSize: number): number {
  const clamped = clampTerminalFontSize(settingFontSize);
  const previousSetting = lastSettingFontSize;
  lastSettingFontSize = clamped;

  if (targetFontSize === null) {
    targetFontSize = clamped;
    unsavedFontSize = false;
    return clamped;
  }
  if (clamped === targetFontSize) {
    unsavedFontSize = false;
    return clamped;
  }
  if (previousSetting === clamped || unsavedFontSize) {
    return targetFontSize;
  }
  targetFontSize = clamped;
  return clamped;
}

const persistTargetFontSize = (): void => {
  persistTimer = null;
  const fontSize = targetFontSize;
  if (fontSize === null || !unsavedFontSize) {
    return;
  }
  persistChain = persistChain
    .then(async (): Promise<void> => {
      const value = await window.snow.getSystemSettingValue(
        TERMINAL_SETTING_CODE,
      );
      const settings = readTerminalSettingsJson(value);
      if (settings.fontSize !== fontSize) {
        await window.snow.setSystemSetting(
          TERMINAL_SETTING_NAME,
          TERMINAL_SETTING_CODE,
          JSON.stringify({ ...settings, fontSize }),
        );
        notifyTerminalSettingsChanged();
      }
      if (targetFontSize === fontSize) {
        unsavedFontSize = false;
      }
    })
    .catch(() => {
      unsavedFontSize = false;
    });
};

export function stepTerminalFontSize(
  delta: number,
  settingFontSize: number,
): number | null {
  if (delta === 0) {
    return null;
  }
  const base = resolveTerminalFontSize(settingFontSize);
  const next = clampTerminalFontSize(base + delta);
  if (next === base) {
    return null;
  }
  targetFontSize = next;
  unsavedFontSize = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(persistTargetFontSize, PERSIST_DELAY_MS);
  return next;
}

export function createTerminalFontWheelStepper(
  onStep: (delta: number) => void,
): (event: WheelEvent) => void {
  let accumulated = 0;
  let lastStepAt = 0;

  return (event: WheelEvent): void => {
    accumulated +=
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * LINE_DELTA_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * PAGE_DELTA_PX
          : event.deltaY;

    if (Math.abs(accumulated) < WHEEL_STEP_DELTA) {
      return;
    }
    const now = Date.now();
    if (now - lastStepAt < WHEEL_STEP_INTERVAL_MS) {
      accumulated = 0;
      return;
    }
    lastStepAt = now;
    const delta = accumulated < 0 ? 1 : -1;
    accumulated = 0;
    onStep(delta);
  };
}
