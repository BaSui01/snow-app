import type { Locale } from "../../../shared/locale";
import { runtimeSnapshot } from "../runtimeSnapshot";
import type { PluginWriteParams } from "./types";

export const l10n = (
  en: string,
  zhCN: string,
  zhTW: string,
): Record<Locale, string> => ({
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
});

const callHost = async (method: string, args: unknown[]): Promise<unknown> => {
  const api = window.snow as unknown as Record<string, unknown>;
  const fn = api[method];
  if (typeof fn !== "function") {
    throw new Error(`Host API '${method}' is unavailable`);
  }
  return await (fn as (...params: unknown[]) => unknown)(...args);
};

export const callSnow = <T = unknown>(
  method: string,
  ...args: unknown[]
): Promise<T> => callHost(method, args) as Promise<T>;

export const requireString = (
  params: PluginWriteParams,
  key: string,
): string => {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Parameter '${key}' must be a non-empty string`);
  }
  return value;
};

export const optionalString = (
  params: PluginWriteParams,
  key: string,
): string | undefined => {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Parameter '${key}' must be a string`);
  }
  return value;
};

export const requireBoolean = (
  params: PluginWriteParams,
  key: string,
): boolean => {
  const value = params[key];
  if (typeof value !== "boolean") {
    throw new Error(`Parameter '${key}' must be a boolean`);
  }
  return value;
};

export const optionalBoolean = (
  params: PluginWriteParams,
  key: string,
): boolean | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Parameter '${key}' must be a boolean`);
  }
  return value;
};

export const requireNumber = (
  params: PluginWriteParams,
  key: string,
): number => {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Parameter '${key}' must be a finite number`);
  }
  return value;
};

export const optionalNumber = (
  params: PluginWriteParams,
  key: string,
): number | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Parameter '${key}' must be a finite number`);
  }
  return value;
};

export const requireStringArray = (
  params: PluginWriteParams,
  key: string,
): string[] => {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Parameter '${key}' must be a non-empty string array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Parameter '${key}' must contain non-empty strings`);
    }
    return item;
  });
};

export const optionalStringArray = (
  params: PluginWriteParams,
  key: string,
): string[] | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Parameter '${key}' must be a string array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Parameter '${key}' must contain non-empty strings`);
    }
    return item;
  });
};

export const requireRecord = (
  params: PluginWriteParams,
  key: string,
): Record<string, unknown> => {
  const value = params[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Parameter '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
};

export const optionalRecord = (
  params: PluginWriteParams,
  key: string,
): Record<string, unknown> | undefined => {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Parameter '${key}' must be an object`);
  }
  return value as Record<string, unknown>;
};

export const bumpRevision = (
  key:
    | "workspaceRevision"
    | "memoriesRevision"
    | "scheduledTasksRevision"
    | "conversationListRevision"
    | "pluginsRevision",
): void => {
  runtimeSnapshot.bump(key);
};

export const dispatchAppEvent = (type: string, detail?: unknown): void => {
  window.dispatchEvent(new CustomEvent(type, { detail }));
};
