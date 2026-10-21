import { app, session, type Session } from "electron";
import type { NativeBridge } from "../native/types";

/**
 * 内置浏览器 User-Agent：对齐本机真实浏览器。
 *
 * Electron 默认 UA 夹带应用名与 Electron/x.y.z 等非标准 token，部分站点据此
 * 判定为非标准客户端（下发移动版页面、拦截或要求更换浏览器）。这里改为与本机
 * 真实浏览器一致的标准 UA：
 *
 *   1. 启动即应用：用内核自身的 Chromium 主版本生成标准 Chrome UA（兜底）；
 *   2. Rust 探测到本机 Chromium 系浏览器（Chrome > Edge > Chromium）后，
 *      换成该浏览器的主版本（Chromium UA 精简规则：次版本号固定为 0.0.0），
 *      Edge 额外追加 Edg/ token。
 *
 * 作用于全部会话（defaultSession 及后续创建的分区，如智能体隔离分区），
 * 设备模拟自带的 UA 仍在 webContents 层覆盖，互不影响。
 */

const trackedSessions = new Set<Session>();
let currentUserAgent = "";

/** 平台段沿用 Electron 默认 UA（与 Chromium 一致的精简平台标识）。 */
const buildUserAgent = (major: string, edge: boolean): string => {
  const platform =
    /\(([^)]+)\)/.exec(app.userAgentFallback)?.[1] ??
    "Windows NT 10.0; Win64; x64";
  const version = `${major}.0.0.0`;
  const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  return edge ? `${userAgent} Edg/${version}` : userAgent;
};

const applyUserAgent = (userAgent: string): void => {
  currentUserAgent = userAgent;
  for (const target of trackedSessions) {
    target.setUserAgent(userAgent);
  }
};

/** 初始化（app ready 后调用）：立即应用兜底 UA，并接管后续创建的会话。 */
export const initBrowserUserAgent = (): void => {
  trackedSessions.add(session.defaultSession);
  app.on("session-created", (created) => {
    trackedSessions.add(created);
    created.setUserAgent(currentUserAgent);
  });
  applyUserAgent(buildUserAgent(process.versions.chrome.split(".")[0], false));
};

/** 按本机真实浏览器版本刷新 UA（未探测到 Chromium 系浏览器时保持兜底值）。 */
export const syncLocalBrowserUserAgent = async (
  native: NativeBridge,
): Promise<void> => {
  const local = await native.detectLocalBrowserVersion();
  if (!local) {
    return;
  }
  applyUserAgent(
    buildUserAgent(local.version.split(".")[0], local.id === "edge"),
  );
};
