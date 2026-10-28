import { rightPanelEvents } from "../components/rightPanel/rightPanelEvents";
import { localFileUrlToPath } from "./localFileUrl";

/** Conservative native Chromium MIME families; unknown formats stay in the editor. */
const MIME_EXTENSIONS: ReadonlyArray<readonly [string, string]> = [
  ["text/html", "html htm"],
  ["application/pdf", "pdf"],
  ["image/svg+xml", "svg"],
  ["image/png", "png"],
  ["image/jpeg", "jpg jpeg jfif"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
  ["image/x-icon", "ico"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg oga opus"],
  ["audio/wav", "wav"],
  ["audio/flac", "flac"],
  ["video/mp4", "mp4 m4v"],
  ["video/webm", "webm"],
  ["video/ogg", "ogv"],
  ["text/plain", "txt text log"],
  ["text/css", "css"],
  ["text/javascript", "js mjs"],
  ["application/json", "json"],
  ["application/xml", "xml"],
];
const mimeByExtension = new Map(
  MIME_EXTENSIONS.flatMap(([mime, extensions]) =>
    extensions.split(" ").map((extension) => [extension, mime] as const),
  ),
);

export const getBrowserFileMimeType = (path: string): string | undefined =>
  mimeByExtension.get(path.match(/\.([^./\\]+)$/)?.[1].toLowerCase() ?? "");

/** 本地 PDF：交给内置浏览器自带的查看器渲染，文件阅读器不再解析 PDF。 */
export const isPdfFilePath = (path: string): boolean =>
  getBrowserFileMimeType(path) === "application/pdf";

/** No remote authorities, device paths, or implicit resolution against the app URL. */
export const localPathToFileUrl = (path: string): string | undefined => {
  if (!path || /[\u0000-\u001f]/.test(path) || /^[\\/]{2}/.test(path)) return;
  const normalized = path.replace(/\\/g, "/");
  const windows = /^[a-z]:\//i.test(normalized);
  if (!windows && !normalized.startsWith("/")) return;
  const segments = normalized
    .split("/")
    .map((segment, index) =>
      windows && index === 0 ? segment : encodeURIComponent(segment),
    );
  return new URL(`file://${windows ? "/" : ""}${segments.join("/")}`).href;
};

export const openBrowserFile = (path: string, isSsh = false): boolean => {
  if (isSsh || !getBrowserFileMimeType(path)) return false;
  const url = localPathToFileUrl(path);
  if (!url) return false;
  rightPanelEvents.emit("open-browser-tab", { url });
  return true;
};

export const isFileLinkHref = (href: string): boolean => {
  if (!href || href.length > 4096 || href.startsWith("#")) return false;
  if (/^file:/i.test(href)) return localFileUrlToPath(href) !== undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    return /^ssh:\/\//i.test(href);
  }
  return /[\\/]/.test(href) || /\.[a-z0-9]{1,12}(?:#L\d+)?$/i.test(href);
};
