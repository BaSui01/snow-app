/**
 * 宠物窗口专用 preload（独立于主窗口 window.snow，保持轻量）。
 *
 * 暴露 window.petBridge：
 * - getConfig: 拉取宠物配置（设置 + 激活宠物清单）
 * - onConfigChanged / onActivityChanged: 订阅主进程广播
 * - showContextMenu: 请求主进程弹出宠物右键菜单（菜单项在主进程构建）
 *
 * 窗口拖拽由 CSS `-webkit-app-region: drag` 交给操作系统，无需桥接。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { PetActivityState, PetWindowConfig } from "./types/pets";

const petBridge = {
  getConfig: (): Promise<PetWindowConfig | null> =>
    ipcRenderer.invoke("pets:get-config"),
  /** 拉取当前 AI 活动状态（补偿先启动会话再唤醒宠物时丢失的广播）。 */
  getActivity: (): Promise<PetActivityState> =>
    ipcRenderer.invoke("pets:get-activity"),
  /** 请求主进程弹出宠物右键菜单（无返回值，菜单点击在 main 侧处理）。 */
  showContextMenu: (): void => {
    ipcRenderer.send("pets:show-context-menu");
  },
  onConfigChanged: (
    callback: (config: PetWindowConfig) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      config: PetWindowConfig,
    ): void => {
      callback(config);
    };
    ipcRenderer.on("pets:config-changed", handler);
    return () => {
      ipcRenderer.removeListener("pets:config-changed", handler);
    };
  },
  onActivityChanged: (
    callback: (state: PetActivityState) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      state: PetActivityState,
    ): void => {
      callback(state);
    };
    ipcRenderer.on("pets:activity-changed", handler);
    return () => {
      ipcRenderer.removeListener("pets:activity-changed", handler);
    };
  },
  onDragStateChanged: (
    callback: (state: "running-right" | "running-left" | null) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      state: "running-right" | "running-left" | null,
    ): void => {
      callback(state);
    };
    ipcRenderer.on("pets:drag-state", handler);
    return () => {
      ipcRenderer.removeListener("pets:drag-state", handler);
    };
  },
};

contextBridge.exposeInMainWorld("petBridge", petBridge);

export type PetBridge = typeof petBridge;
