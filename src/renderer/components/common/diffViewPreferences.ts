import { useSyncExternalStore } from "react";

import type { DiffViewModePreference } from "./GitDiffView";

const VIEW_MODE_STORAGE_KEY = "git-diff-mode";
const WRAP_STORAGE_KEY = "git-diff-wrap";

const readStoredViewMode = (): DiffViewModePreference => {
  try {
    const value = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return value === "unified" || value === "split" ? value : "auto";
  } catch {
    return "auto";
  }
};

/** 自动换行偏好：未设置时默认关闭（长行横向滚动）。 */
const readStoredWrapLines = (): boolean => {
  try {
    return window.localStorage.getItem(WRAP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
};

// 渲染进程内共享的 diff 显示偏好：右侧面板与会话内 diff 一致，实时同步。
let viewMode: DiffViewModePreference = readStoredViewMode();
let wrapLines: boolean = readStoredWrapLines();

const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getViewMode = (): DiffViewModePreference => viewMode;

const getWrapLines = (): boolean => wrapLines;

export const setDiffViewMode = (mode: DiffViewModePreference): void => {
  if (mode === viewMode) {
    return;
  }
  viewMode = mode;
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 忽略存储访问错误，仅当前会话生效。
  }
  emit();
};

export const setDiffWrapLines = (value: boolean): void => {
  if (value === wrapLines) {
    return;
  }
  wrapLines = value;
  try {
    window.localStorage.setItem(WRAP_STORAGE_KEY, value ? "on" : "off");
  } catch {
    // 忽略存储访问错误，仅当前会话生效。
  }
  emit();
};

export const useDiffViewMode = (): DiffViewModePreference =>
  useSyncExternalStore(subscribe, getViewMode, getViewMode);

export const useDiffWrapLines = (): boolean =>
  useSyncExternalStore(subscribe, getWrapLines, getWrapLines);
