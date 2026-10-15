import { app } from "electron";
import type { BrowserWindow } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DetachedPanelWindowSize {
  width: number;
  height: number;
}

const DEFAULT_DETACHED_PANEL_WINDOW_SIZE: DetachedPanelWindowSize = {
  width: 980,
  height: 680,
};

const SAVE_DEBOUNCE_MS = 500;

/** 独立窗口尺寸单独落盘，不与主窗口的 window-state.json 共用。 */
const getStatePath = (): string =>
  join(app.getPath("userData"), "detached-panel-window-state.json");

/** 内存中的最近尺寸：启动时异步读取，窗口创建时同步取用。 */
let rememberedSize: DetachedPanelWindowSize = {
  ...DEFAULT_DETACHED_PANEL_WINDOW_SIZE,
};
let saveTimer: NodeJS.Timeout | null = null;

const isValidSize = (value: unknown): value is DetachedPanelWindowSize => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const size = value as Partial<DetachedPanelWindowSize>;
  return (
    typeof size.width === "number" &&
    typeof size.height === "number" &&
    size.width > 0 &&
    size.height > 0
  );
};

/** 应用启动时调用：读取上次记住的尺寸；文件缺失或损坏时保持默认值。 */
export const initDetachedPanelWindowState = async (): Promise<void> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(getStatePath(), "utf-8"));
    if (isValidSize(parsed)) {
      rememberedSize = {
        width: Math.round(parsed.width),
        height: Math.round(parsed.height),
      };
    }
  } catch {
    // 文件不存在或内容损坏时沿用默认尺寸。
  }
};

export const getRememberedDetachedPanelSize = (): DetachedPanelWindowSize =>
  rememberedSize;

const persistSize = (): void => {
  writeFile(getStatePath(), JSON.stringify(rememberedSize), "utf-8").catch(
    (error) => {
      console.warn("Failed to persist detached panel window size:", error);
    },
  );
};

/**
 * 记录独立窗口尺寸：resize 时防抖落盘，关闭时传 flush 立即落盘。
 * 使用 normal bounds，最大化状态下不记录最大化尺寸。
 */
export const trackDetachedPanelWindowSize = (
  win: BrowserWindow,
  flush: boolean,
): void => {
  if (win.isDestroyed()) {
    return;
  }
  const { width, height } = win.getNormalBounds();
  rememberedSize = { width, height };

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (flush) {
    persistSize();
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistSize();
  }, SAVE_DEBOUNCE_MS);
};
