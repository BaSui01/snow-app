import type { DragEvent } from "react";

/**
 * 浏览器标签页拖拽到聊天输入框的共享工具。
 *
 * 右侧面板外层 browser tab（RightPanel）与浏览器内部标签页
 * （BrowserPanelContent）共用同一套 web-tag 拖拽协议，保证
 * 聊天输入框（ChatInputView.handleDrop）只需解析一种结构。
 */

/** web-tag 拖拽数据的 type 标识（与 ChatInputView.handleDrop 的解析约定一致） */
export const WEB_TAG_DRAG_TYPE = "web-tag";

export type WebTagDragPayload = {
  type: typeof WEB_TAG_DRAG_TYPE;
  url: string;
  title?: string;
  /** 浏览器实例 id（可选）：携带后输入框可向该实例请求三层网页快照 */
  instanceId?: string;
  /** 浏览器实例内层标签页 id（可选）：外层 RightPanel tab 拖拽时缺省 */
  tabId?: string;
};

/** setWebTagDragData 的可选扩展参数（F4 网页快照的定位信息）。 */
export type WebTagDragExtra = {
  instanceId?: string;
  tabId?: string;
};

/**
 * 将浏览器标签页引用写入拖拽数据（web-tag 协议）。
 * @param event dragstart 事件
 * @param url   标签页当前 URL（实时值，如 addressInput || src）
 * @param title 页面标题（可为空串，chip 将回退显示域名）
 * @param extra 可选：浏览器实例 id / 内层标签页 id（F4 快照请求的定位信息）
 * @returns 是否成功写入；url 为空时返回 false，调用方应 preventDefault 取消拖拽
 */
export const setWebTagDragData = (
  event: DragEvent<HTMLElement>,
  url: string,
  title: string,
  extra?: WebTagDragExtra
): boolean => {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return false;
  }
  const payload: WebTagDragPayload = {
    type: WEB_TAG_DRAG_TYPE,
    url: trimmedUrl,
    title: title.trim() || undefined,
    ...(extra?.instanceId ? { instanceId: extra.instanceId } : {}),
    ...(extra?.tabId ? { tabId: extra.tabId } : {}),
  };
  event.dataTransfer.setData("application/json", JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
  return true;
};
