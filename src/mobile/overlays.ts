import { $ } from "./dom";

/**
 * 浮层基础设施：远程面板、会话列表、动作面板与图片灯箱共用一套
 * 「打开前压历史栈、返回键逐层关闭」的机制。
 */
let overlayHistoryActive = false;
let overlayTrigger: HTMLElement | null = null;

export const isActionSheetOpen = (): boolean =>
  $("actionSheet").classList.contains("open");

export const setActionSheetOpen = (open: boolean): void => {
  $("actionOverlay").classList.toggle("open", open);
  $("actionSheet").classList.toggle("open", open);
  $("plusButton").setAttribute("aria-expanded", String(open));
};

/** 关闭所有浮层（不改动 history，供打开新浮层前调用）。 */
export const hideOverlays = (): void => {
  setActionSheetOpen(false);
  $("remotePanelScrim").classList.remove("open");
  document
    .querySelectorAll(".remote-panel")
    .forEach((panel) => panel.classList.remove("open"));
  $("scrim").classList.remove("open");
  $("threadSheet").classList.remove("open");
  $("imageLightbox").classList.remove("open");
  $("lightboxImage").removeAttribute("src");
};

/** 压入一条历史记录，保证返回键 / 手势能逐层关闭浮层。 */
export const beginOverlay = (): void => {
  if (!overlayHistoryActive) {
    history.pushState({ snowRemoteOverlay: true }, "");
    overlayHistoryActive = true;
  }
};

/**
 * 记录关闭浮层后需要恢复焦点的触发元素。
 * 显式传入时直接使用；否则沿用仍挂载在页面上的旧元素，
 * 或退回到当前的 document.activeElement。
 */
export const rememberOverlayTrigger = (explicit?: HTMLElement | null): void => {
  if (explicit) {
    overlayTrigger = explicit;
    return;
  }
  overlayTrigger =
    overlayTrigger && overlayTrigger.isConnected
      ? overlayTrigger
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
};

export const closeOverlays = (fromHistory: boolean): void => {
  hideOverlays();
  if (overlayHistoryActive) {
    overlayHistoryActive = false;
    const state = history.state as { snowRemoteOverlay?: boolean } | null;
    if (!fromHistory && state && state.snowRemoteOverlay) history.back();
  }
  const trigger = overlayTrigger;
  overlayTrigger = null;
  if (trigger && trigger.isConnected) trigger.focus();
};

/** 打开图片灯箱（消息内图片点击）。 */
export const openImageLightbox = (src: string): void => {
  hideOverlays();
  beginOverlay();
  $<HTMLImageElement>("lightboxImage").src = src;
  $("imageLightbox").classList.add("open");
};

export const initOverlays = (): void => {
  $("closeImageLightbox").onclick = () => {
    closeOverlays(false);
  };
  $("imageLightbox").onclick = (event) => {
    if (event.target === $("imageLightbox")) closeOverlays(false);
  };
  window.addEventListener("popstate", () => {
    closeOverlays(true);
  });
};
