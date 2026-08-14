// 中文发行说明获取。
//
// 发布流程（scripts/generate-latest-json.cjs）从 RELEASE_NOTES_ZH.md 提取
// 当前版本的中文翻译，生成 latest-zh.json 并随 GitHub Release 上传：
//
//   {
//     "version": "0.2.2",
//     "releaseNotesZh": "# ...markdown..."
//   }
//
// 应用检测到新版本后在此拉取中文翻译写入更新状态；拉取失败或版本不匹配
// 时静默置为 null，更新弹窗自动回退显示英文原文（GitHub 发行页不受影响）。

import { app, net } from "electron";
import { snowLog } from "../../utils/snowLogger";
import { setUpdateStatus } from "./updateStatus";

// 中文翻译清单地址。默认指向 GitHub Releases 的 latest 资源，
// 可通过环境变量 SNOW_ZH_NOTES_URL 覆盖（用于测试自建服务端）。
const ZH_NOTES_URL =
  process.env.SNOW_ZH_NOTES_URL ??
  "https://github.com/MayDay-wpf/snow-app/releases/latest/download/latest-zh.json";

// 请求超时（毫秒）
const FETCH_TIMEOUT_MS = 10 * 1000;

// 缓存有效期：避免检查更新/下载时重复请求
const CACHE_TTL_MS = 60 * 60 * 1000;

interface ZhNotesManifest {
  version?: string;
  releaseNotesZh?: string | null;
}

// 内存缓存：版本 + 翻译 + 获取时间
let cached: { version: string; notes: string | null; fetchedAt: number } | null =
  null;

const fetchZhManifest = async (): Promise<ZhNotesManifest | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(ZH_NOTES_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": `Snow-App/${app.getVersion()} Snow App Updater`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ZhNotesManifest;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * 拉取指定版本的中文发行说明并写入更新状态（异步、失败静默）。
 * 命中缓存时直接复用；无翻译时置为 null，UI 只显示英文原文。
 */
export const loadZhReleaseNotes = async (version: string): Promise<void> => {
  const now = Date.now();
  if (cached && cached.version === version && now - cached.fetchedAt < CACHE_TTL_MS) {
    setUpdateStatus({ releaseNotesZh: cached.notes });
    return;
  }

  const manifest = await fetchZhManifest();
  let notes: string | null = null;
  if (
    manifest &&
    manifest.version === version &&
    typeof manifest.releaseNotesZh === "string" &&
    manifest.releaseNotesZh.trim()
  ) {
    notes = manifest.releaseNotesZh.trim();
  }

  cached = { version, notes, fetchedAt: now };
  setUpdateStatus({ releaseNotesZh: notes });

  if (!notes) {
    snowLog.info({
      module: "updater/zh-notes",
      func: "loadZhReleaseNotes",
      message: `No Chinese release notes for ${version}`,
    });
  }
};
