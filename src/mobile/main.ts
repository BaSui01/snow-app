import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { fetchState, isUnauthorizedError, pair } from "./api";
import { initComposer, renderComposer, syncSessionContext } from "./composer";
import { initControls, renderControls } from "./controls";
import { $, escapeHtml } from "./dom";
import { sessionContextKey } from "./format";
import { initI18n, t } from "./i18n";
import { hydrateIcons, iconMarkup } from "./icons";
import { initInteractions, renderInteractions } from "./interactions";
import { showNotice } from "./notice";
import { initOverlays } from "./overlays";
import { closeRemotePanels, initPanels, renderPanels } from "./panels";
import { initPending, renderPending } from "./pending";
import { applyAccentColor, initTheme } from "./theme";
import { initThreads, renderThreads } from "./threads";
import { initTimeline, renderTimeline } from "./timeline";
import { initTodos, renderTodos } from "./todos";
import { initTopbar, renderTopbar } from "./topbar";
import type { AppContext } from "./types";

/**
 * Mobile 远控页入口：装配各功能模块，维护 /api/state 轮询与整体渲染。
 *
 * 渲染策略与旧版一致：
 * - 每轮快照都刷新廉价区域（顶栏、chips、面板列表、会话列表、交互卡片）；
 * - 消息区通过签名比较跳过无变化的整段重建，并维护自动跟随与「回到底部」按钮；
 * - 失败时展示离线占位，401 提示重新配对。
 */
let currentState: SnowRemoteState | null = null;
let lastSignature = "";
let requestGeneration = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const buildSignature = (next: SnowRemoteState): string =>
  next.activeConversationId +
  "|" +
  next.isStreaming +
  "|" +
  next.messages
    .map(
      (message) =>
        message.id +
        ":" +
        message.status +
        ":" +
        message.content.length +
        ":" +
        (message.thinking || "").length +
        ":" +
        (message.toolCalls || [])
          .map(
            (tool) =>
              tool.interactionId +
              ":" +
              tool.status +
              ":" +
              (tool.result || "").length +
              ":" +
              (tool.streamingStdout || "").length,
          )
          .join(","),
    )
    .join("|");

const render = (next: SnowRemoteState): void => {
  applyAccentColor(next.theme?.accentColor);
  renderTopbar(next);
  renderControls(next);
  renderComposer(next);
  renderPending(next);
  renderTodos(next);
  renderPanels(next);
  renderThreads(next);
  renderInteractions(next);
  const signature = buildSignature(next);
  if (signature !== lastSignature) {
    const isFirstRender = lastSignature === "";
    lastSignature = signature;
    renderTimeline(next, isFirstRender);
  }
};

const offlineHtml = (message: string): string =>
  `<div class="empty"><div><div class="empty-mark">${iconMarkup("wifi-off")}</div><strong>${escapeHtml(message)}</strong><span>${t("remote.empty.offline.hint")}</span></div></div>`;

const refresh = async (silent?: boolean): Promise<void> => {
  const generation = ++requestGeneration;
  try {
    const next = await fetchState();
    if (generation !== requestGeneration) return;
    syncSessionContext(sessionContextKey(next));
    currentState = next;
    render(next);
  } catch (error) {
    if (generation !== requestGeneration) return;
    closeRemotePanels();
    const unauthorized = isUnauthorizedError(error);
    const message = unauthorized
      ? t("remote.error.unauthorized")
      : (error as Error).message || t("remote.error.offline");
    $("statusDot").className = "status-dot offline";
    $("threadTitle").textContent = unauthorized
      ? t("remote.empty.unauthorized.title")
      : t("remote.empty.failed.title");
    $("runBadge").textContent = t("remote.badge.offline");
    $("messages").innerHTML = offlineHtml(message);
    if (!silent) showNotice(message, true);
  }
};

const schedule = (): void => {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(
    async () => {
      await refresh(true);
      schedule();
    },
    document.hidden ? 5000 : 1000,
  );
};

const pairFromFragment = async (): Promise<void> => {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = params.get("pair");
  if (!code) return;
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) {
    throw new Error(t("remote.pair.invalidCode"));
  }
  history.replaceState(null, "", location.pathname);
  await pair(code);
};

const runPairing = (): Promise<void> =>
  pairFromFragment()
    .catch((error) => {
      showNotice((error as Error).message, true);
    })
    .then(() => refresh(false));

const ctx: AppContext = {
  refresh,
  getState: () => currentState,
  invalidateTimeline: () => {
    lastSignature = "";
  },
};

// ── 启动装配 ──────────────────────────────────────────────────────────────
// 注意：initI18n 会移除 <html data-i18n-pending>，在此之前样式表一直隐藏
// body，避免默认语言文案的闪烁；整个装配是同步的，不会出现半初始化截图。

hydrateIcons();
initI18n();
initTheme();
initOverlays();
initPanels(ctx);
initTopbar(ctx);
initThreads(ctx);
initInteractions(ctx);
initTimeline();
initComposer(ctx);
initPending(ctx);
initTodos(ctx);
initControls(ctx);
renderControls(null);
renderComposer(null);

window.addEventListener("hashchange", () => {
  void runPairing();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh(true);
  schedule();
});
window.addEventListener("pageshow", () => {
  void refresh(true);
});
window.addEventListener("focus", () => {
  void refresh(true);
});
const viewport = window.visualViewport;
if (viewport) {
  viewport.addEventListener("resize", () => {
    document.documentElement.style.setProperty(
      "--keyboard-offset",
      Math.max(0, window.innerHeight - viewport.height) + "px",
    );
  });
}

if (location.search) {
  history.replaceState(null, "", location.pathname + location.hash);
}
void runPairing().finally(schedule);
