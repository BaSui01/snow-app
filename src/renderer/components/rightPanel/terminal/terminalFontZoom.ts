import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_SETTING_CODE,
  TERMINAL_SETTING_NAME,
} from "../../sidebar/terminalSettings/terminalSettingsConstants";
import { readTerminalSettingsJson } from "../../sidebar/terminalSettings/terminalSettingsUtils";
import { notifyTerminalSettingsChanged } from "../useTerminalSettings";

/** 一格滚轮折算的累加距离（像素模式 deltaY ≈ 100 / 行模式 6 行 / 页模式 1 页） */
const WHEEL_STEP_PX = 100;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 120;
/** 每帧最多推进的字号档数：滚轮再快也逐帧铺开，避免整屏跳变 */
const MAX_STEPS_PER_FRAME = 1;
const PERSIST_DELAY_MS = 400;

let targetFontSize: number | null = null;
let unsavedFontSize = false;
let lastSettingFontSize: number | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

const clampTerminalFontSize = (value: number): number =>
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

function stepTerminalFontSize(
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

const normalizeWheelDelta = (event: WheelEvent): number =>
  event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * LINE_DELTA_PX
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * PAGE_DELTA_PX
      : event.deltaY;

export type TerminalFontZoom = {
  /** ctrl/cmd + 滚轮：累积滚轮距离，按帧推进字号 */
  handleWheel: (event: WheelEvent) => void;
  /** 键盘阶梯缩放（ctrl/cmd + = / -） */
  zoomBy: (delta: number) => void;
  /** 停止未完成的推进（终端销毁时调用） */
  dispose: () => void;
};

/**
 * 滚轮缩放控制器：滚轮距离先累积，再在每帧里消费固定步长——一次都不丢弃，
 * 快速滚动铺成连续的逐帧小步，慢速滚动（触控板）也能及时跟上。
 */
export function createTerminalFontZoom(
  getSettingFontSize: () => number,
  applyFontSize: (fontSize: number) => void,
): TerminalFontZoom {
  /** 尚未消费的滚轮距离（px，正数 = 放大） */
  let pending = 0;
  let rafId: number | null = null;

  const step = (delta: number): number | null => {
    const next = stepTerminalFontSize(delta, getSettingFontSize());
    if (next !== null) {
      applyFontSize(next);
    }
    return next;
  };

  const flush = (): void => {
    rafId = null;
    const steps =
      pending > 0
        ? Math.floor(pending / WHEEL_STEP_PX)
        : Math.ceil(pending / WHEEL_STEP_PX);
    if (steps === 0) {
      return;
    }
    const applied = Math.max(
      -MAX_STEPS_PER_FRAME,
      Math.min(MAX_STEPS_PER_FRAME, steps),
    );
    pending -= applied * WHEEL_STEP_PX;
    if (step(applied) === null) {
      // 已到字号上下限：丢弃积压，避免后续帧空转
      pending = 0;
      return;
    }
    if (Math.abs(pending) >= WHEEL_STEP_PX) {
      rafId = requestAnimationFrame(flush);
    }
  };

  return {
    handleWheel: (event) => {
      pending -= normalizeWheelDelta(event);
      if (rafId === null) {
        rafId = requestAnimationFrame(flush);
      }
    },
    zoomBy: (delta) => {
      step(delta);
    },
    dispose: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pending = 0;
    },
  };
}
