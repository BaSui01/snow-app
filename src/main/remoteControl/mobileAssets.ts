import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { normalizeLocale, type Locale } from "../../shared/locale";
import { native } from "../native/nativeBridge";

/**
 * 移动端远控页面产物（out/mobile）的读取层。
 *
 * 资源由 electron-vite 的移动页构建插件产出（见 electron.vite.config.ts）：
 * - index.html 在响应时注入桌面端语言（<meta name="snow-locale">），
 *   页面据此优先按桌面语言展示，浏览器本地覆盖与 navigator.language 依次兜底；
 * - assets/* 文件名带内容哈希，配合长缓存交给手机浏览器复用。
 *
 * 这里刻意不做内存缓存：请求频率低、文件小，而 dev 下 rebuild 后必须立即
 * 读到新产物（旧哈希文件已随 emptyOutDir 删除，缓存反而会引入脏数据）。
 */

const MOBILE_DIR = join(import.meta.dirname, "../mobile");
const MOBILE_ASSETS_DIR = join(MOBILE_DIR, "assets");

/** assets 路由前缀；远控服务的 GET 路由与 WAN 预配对放行共用同一常量。 */
export const MOBILE_ASSET_PATH_PREFIX = "/assets/";

const LOCALE_PLACEHOLDER = "__SNOW_LOCALE__";
const LANGUAGE_SETTING_CODE = "language";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export type MobileAsset = {
  bytes: Buffer;
  contentType: string;
};

const tryReadFile = (absolutePath: string): Promise<Buffer | null> =>
  readFile(absolutePath).catch(() => null);

/**
 * 桌面端应用语言（系统设置 "language"）；未设置或桥不可用时返回 null。
 * 移动页语言注入与未授权配对引导页共用同一来源。
 */
export const readDesktopLocale = async (): Promise<Locale | null> => {
  try {
    return normalizeLocale(
      await native.getSystemSettingValue(LANGUAGE_SETTING_CODE),
    );
  } catch {
    return null;
  }
};

/** 页面 HTML；资源尚未构建时返回 null（远控服务据此回 503）。 */
export const readMobileIndexHtml = async (): Promise<Buffer | null> => {
  const html = await tryReadFile(join(MOBILE_DIR, "index.html"));
  if (!html) return null;
  // 未读取到桌面语言时写入 "auto"，页面会回落到浏览器语言。
  const locale = (await readDesktopLocale()) ?? "auto";
  return Buffer.from(
    html.toString("utf8").replace(LOCALE_PLACEHOLDER, locale),
    "utf8",
  );
};

/** assets 目录内的静态资源；路径越界、类型未知或文件缺失时返回 null。 */
export const readMobileAsset = async (
  pathname: string,
): Promise<MobileAsset | null> => {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(
      pathname.slice(MOBILE_ASSET_PATH_PREFIX.length),
    );
  } catch {
    return null;
  }
  const absolutePath = normalize(join(MOBILE_ASSETS_DIR, relativePath));
  if (!absolutePath.startsWith(MOBILE_ASSETS_DIR + sep)) return null;
  const contentType = ASSET_CONTENT_TYPES[extname(absolutePath).toLowerCase()];
  if (!contentType) return null;
  const bytes = await tryReadFile(absolutePath);
  if (!bytes) return null;
  return { bytes, contentType };
};
