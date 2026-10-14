import type { DetachedPanelRuntimeMirror } from "../../shared/detachedPanel";
import { runtimeSnapshot, type RuntimeSnapshot } from "./runtimeSnapshot";

/**
 * 独立面板窗口的运行时快照镜像。
 *
 * 插件面板读取的会话、项目、输入区等实时状态由主窗口的 App 级组件写入
 * （PluginRuntimeBridge / ChatInputView / MainSidebarContent），独立窗口没有这些组件，
 * 快照在那边始终为空。因此主窗口把除 panels 外的字段推送给主进程，由主进程转发给所有
 * 独立面板窗口；独立窗口只应用镜像，不回推，避免循环。
 * panels 由各窗口自己的 RightPanel 维护，不参与镜像。
 */

const MIRRORED_KEYS: readonly Exclude<keyof RuntimeSnapshot, "panels">[] = [
  "activeDirectory",
  "conversation",
  "chatInput",
  "streamingSessions",
  "activeSessionDirectoryIds",
  "workspaceRevision",
  "memoriesRevision",
  "scheduledTasksRevision",
  "conversationListRevision",
  "pluginsRevision",
];

const pickMirror = (snapshot: RuntimeSnapshot): DetachedPanelRuntimeMirror => {
  const mirror: DetachedPanelRuntimeMirror = {};
  for (const key of MIRRORED_KEYS) {
    mirror[key] = snapshot[key];
  }
  return mirror;
};

/**
 * 主窗口：订阅运行时快照，镜像字段的引用发生变化时推送给主进程。
 * 启动时先推送一次当前状态。返回取消订阅函数。
 */
export const startPluginRuntimeMirrorPublisher = (): (() => void) => {
  let previous: DetachedPanelRuntimeMirror | null = null;
  const publish = (snapshot: RuntimeSnapshot): void => {
    const next = pickMirror(snapshot);
    if (
      previous &&
      MIRRORED_KEYS.every((key) => previous?.[key] === next[key])
    ) {
      return;
    }
    previous = next;
    void window.snow.publishDetachedRuntimeMirror(next).catch(() => undefined);
  };
  publish(runtimeSnapshot.get());
  return runtimeSnapshot.subscribe(publish);
};

/**
 * 独立面板窗口：应用主窗口推送的镜像。只覆盖镜像字段，不影响本窗口的 panels。
 */
export const applyPluginRuntimeMirror = (
  mirror: DetachedPanelRuntimeMirror,
): void => {
  runtimeSnapshot.patch(mirror as Partial<RuntimeSnapshot>);
};
