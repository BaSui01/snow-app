import { useSyncExternalStore } from "react";

import type { PluginRecord } from "../../preload/types/plugins";
import { parsePluginRecord } from "./manifest";
import { runtimeSnapshot } from "./runtimeSnapshot";
import type { PluginView } from "./types";

export type PluginStoreState = {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  plugins: PluginView[];
  revision: number;
};

let state: PluginStoreState = {
  status: "idle",
  error: null,
  plugins: [],
  revision: 0,
};

const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

const commit = (partial: Partial<PluginStoreState>): void => {
  state = { ...state, ...partial, revision: state.revision + 1 };
  for (const listener of listeners) {
    listener();
  }
  runtimeSnapshot.patch({ pluginsRevision: state.revision });
};

const toViews = (records: PluginRecord[]): PluginView[] =>
  records.map(parsePluginRecord);

const load = async (): Promise<void> => {
  commit({
    status: state.status === "ready" ? "ready" : "loading",
    error: null,
  });
  try {
    const records = await window.snow.listPlugins();
    commit({ status: "ready", plugins: toViews(records), error: null });
  } catch (error) {
    commit({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const pluginStore = {
  getState(): PluginStoreState {
    return state;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** 首次访问时加载插件列表（并发调用共享同一次加载）。 */
  ensureLoaded(): Promise<void> {
    if (state.status === "ready") {
      return Promise.resolve();
    }
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  },
  refresh(): Promise<void> {
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  },
  /** 弹出目录选择框并安装所选插件目录。取消返回 null。 */
  async installFromDialog(dialogTitle?: string): Promise<PluginView | null> {
    const directory = await window.snow.pickPluginDirectory(dialogTitle);
    if (!directory) {
      return null;
    }
    const record = await window.snow.installPlugin(directory);
    await pluginStore.refresh();
    return parsePluginRecord(record);
  },
  async rescan(pluginId: string): Promise<void> {
    await window.snow.rescanPlugin(pluginId);
    await pluginStore.refresh();
  },
  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    await window.snow.setPluginEnabled(pluginId, enabled);
    await pluginStore.refresh();
  },
  async uninstall(pluginId: string, deleteFiles: boolean): Promise<void> {
    await window.snow.deletePlugin(pluginId, deleteFiles);
    await pluginStore.refresh();
  },
  getById(pluginId: string): PluginView | null {
    return state.plugins.find((plugin) => plugin.pluginId === pluginId) ?? null;
  },
  /** 已启用且定义了面板的插件（Plus 菜单与面板宿主使用）。 */
  enabledPanels(): { plugin: PluginView; panelIndex: number }[] {
    const entries: { plugin: PluginView; panelIndex: number }[] = [];
    for (const plugin of state.plugins) {
      if (!plugin.enabled) {
        continue;
      }
      plugin.panels.forEach((_, panelIndex) => {
        entries.push({ plugin, panelIndex });
      });
    }
    return entries;
  },
};

export const usePluginStore = (): PluginStoreState =>
  useSyncExternalStore(
    pluginStore.subscribe,
    pluginStore.getState,
    () => state,
  );

// AI 侧（config-set / config-delete 的 plugins 作用域）安装、启停或卸载插件时，
// 渲染层无从感知列表变化；主进程广播后统一刷新，侧边栏插件徽标与插件面板同步。
if (typeof window !== "undefined" && window.snow?.onPluginsChanged) {
  window.snow.onPluginsChanged(() => {
    void pluginStore.refresh();
  });
}
