/**
 * 宠物窗口专用 preload（独立于主窗口 window.snow，保持轻量）。
 *
 * 暴露 window.petBridge：
 * - getConfig / onConfigChanged: 宠物配置（设置 + 激活宠物清单 + 窗口形态 +
 *   聊天上下文 + 界面文案）
 * - onActivityChanged: 订阅 AI 活动状态广播
 * - showContextMenu: 请求主进程弹出宠物右键菜单（菜单项在主进程构建）
 * - setMode: 精灵 ↔ 聊天形态切换（窗口尺寸由主进程调整）
 * - sendChat / abortChat / onChatChunk / onChatTool: 宠物聊天（btw 式旁路会话）
 * - dragStart / dragMove / dragEnd: 渲染层自绘窗口拖拽
 *   （不再使用 CSS app-region，否则 Windows 上双击被系统标题栏吞掉）
 * - hasClipboardContent / runEditCommand: 输入框统一右键菜单所需的编辑命令
 *   （与主窗口 window.snow 同名同语义，主进程侧共用同一组 IPC 通道）
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SnowEditCommand } from "./modules/systemApi";
import type {
  PetActivityState,
  PetChatChunkPayload,
  PetChatHistoryMessage,
  PetChatResult,
  PetChatToolPayload,
  PetWindowConfig,
  PetWindowMode,
} from "./types/pets";

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
  /** 切换宠物窗口形态：双击宠物进入聊天，关闭聊天回到精灵。 */
  setMode: (mode: PetWindowMode): Promise<PetWindowMode> =>
    ipcRenderer.invoke("pets:set-mode", mode),
  /**
   * 宠物聊天：返回最终结果，流式增量通过 onChatChunk 送达。
   * history 为本次提问之前的对话（宠物窗口内存态），主进程据此让宠物
   * 记得自己刚才说过什么；只传正文，不含任何主会话内容。
   */
  sendChat: (
    requestId: string,
    text: string,
    history: PetChatHistoryMessage[],
  ): Promise<PetChatResult> =>
    ipcRenderer.invoke("pets:chat-send", { requestId, text, history }),
  /** 中止一次在途宠物聊天。 */
  abortChat: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke("pets:chat-abort", requestId),
  onChatChunk: (
    callback: (payload: PetChatChunkPayload) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: PetChatChunkPayload,
    ): void => {
      callback(payload);
    };
    ipcRenderer.on("pets:chat-chunk", handler);
    return () => {
      ipcRenderer.removeListener("pets:chat-chunk", handler);
    };
  },
  /** 订阅宠物聊天的工具活动（联网搜索 / 文件搜索 / 文件阅读）。 */
  onChatTool: (
    callback: (payload: PetChatToolPayload) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: PetChatToolPayload,
    ): void => {
      callback(payload);
    };
    ipcRenderer.on("pets:chat-tool", handler);
    return () => {
      ipcRenderer.removeListener("pets:chat-tool", handler);
    };
  },
  /** 拖拽开始：主进程记录窗口起始位置。 */
  dragStart: (): void => {
    ipcRenderer.send("pets:drag-start");
  },
  /** 拖拽中：dx/dy 为相对拖拽起点的屏幕位移（像素）。 */
  dragMove: (dx: number, dy: number): void => {
    ipcRenderer.send("pets:drag-move", { dx, dy });
  },
  dragEnd: (): void => {
    ipcRenderer.send("pets:drag-end");
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
  /** 剪贴板是否还有可粘贴的内容：编辑区右键菜单据此自动禁用「粘贴」。 */
  hasClipboardContent: (): Promise<boolean> =>
    ipcRenderer.invoke("clipboard:has-content"),
  /** 执行编辑命令（剪切 / 复制 / 粘贴 / 全选），由主进程作用于本窗口。 */
  runEditCommand: (command: SnowEditCommand): Promise<void> =>
    ipcRenderer.invoke("edit:command", command),
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
