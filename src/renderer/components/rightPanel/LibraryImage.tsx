import { memo, useEffect, useState } from "react";
import { localImageProxyUrl } from "../../utils/imageProxyUrl";

/** 图片缓存（代理 URL / data URL）LRU 上限，避免长会话内存持续增长。 */
const IMAGE_CACHE_MAX = 300;

/** 带 LRU 上限的 Map 写入：超限时删除最旧的条目。 */
const cacheSet = <K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
): void => {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
};

/** 生成结果中图库落盘引用（image/... 前缀）的代理 URL 缓存。 */
export const libraryProxyCache = new Map<string, string>();

/** 把图库相对路径解析为可展示的代理 URL（带 LRU 缓存，避免重复构造）。 */
export const proxyForLibraryPath = (path: string): string => {
  const cached = libraryProxyCache.get(path);
  if (cached) {
    cacheSet(libraryProxyCache, path, cached, IMAGE_CACHE_MAX);
    return cached;
  }
  const url = localImageProxyUrl(path);
  cacheSet(libraryProxyCache, path, url, IMAGE_CACHE_MAX);
  return url;
};

/** 图库图片的 data URL 缓存（IPC resolveLibraryImage，删除图片时同步失效）。 */
export const libraryDataCache = new Map<string, string>();

/** 异步读取图库图片为 data URL（带 LRU 缓存；失败返回 null）。 */
export const resolveLibraryDataUrl = async (
  path: string,
): Promise<string | null> => {
  const cached = libraryDataCache.get(path);
  if (cached) {
    cacheSet(libraryDataCache, path, cached, IMAGE_CACHE_MAX);
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveLibraryImage(path);
    if (dataUrl) {
      cacheSet(libraryDataCache, path, dataUrl, IMAGE_CACHE_MAX);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 上传/任意本地路径图片的 data URL 缓存（绝对路径或 upload/...，参考图用）。 */
export const uploadDataCache = new Map<string, string>();

/** 异步读取 upload/ 相对路径或绝对路径图片为 data URL（带 LRU 缓存；失败返回 null）。 */
export const resolveUploadDataUrl = async (
  path: string,
): Promise<string | null> => {
  const cached = uploadDataCache.get(path);
  if (cached) {
    cacheSet(uploadDataCache, path, cached, IMAGE_CACHE_MAX);
    return cached;
  }
  try {
    const dataUrl = await window.snow.resolveUploadImage(path);
    if (dataUrl) {
      cacheSet(uploadDataCache, path, dataUrl, IMAGE_CACHE_MAX);
    }
    return dataUrl;
  } catch {
    return null;
  }
};

/** 图片扩展名白名单（外部文件拖入判断用）。 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif|tiff?)$/i;

/** 按扩展名推断图片 MIME（上传参考图用；服务端亦会按扩展名兜底）。 */
export const inferMimeFromPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
};

export type LibraryImageProps = {
  /** 本地图库相对路径（image/...）；提供时忽略 src。 */
  path?: string;
  /** 直接图片 src（远程代理 URL / data URL）；仅无 path 时使用。 */
  src?: string;
  alt: string;
  title?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onClick?: () => void;
};

/**
 * 图库图片渲染组件：优先使用 img-proxy:// 协议（与聊天 markdown 图片同一链路），
 * 加载失败时自动回退到 IPC 读取的 data URL（聊天生成结果图链路），保证不出现破损图。
 */
export const LibraryImage = memo(function LibraryImage({
  path,
  src,
  alt,
  title,
  className,
  loading,
  onClick,
}: LibraryImageProps): React.JSX.Element {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    const load = path.startsWith("image/")
      ? resolveLibraryDataUrl
      : resolveUploadDataUrl;
    setResolved(null);
    void load(path).then((dataUrl) => {
      if (!cancelled && dataUrl) {
        setResolved(dataUrl);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!path) {
    return (
      <img
        src={src}
        alt={alt}
        title={title}
        className={className}
        loading={loading}
        onClick={onClick}
      />
    );
  }

  const primarySrc = path.startsWith("image/")
    ? proxyForLibraryPath(path)
    : undefined;
  const effectiveSrc = primarySrc ?? resolved ?? undefined;

  return (
    <img
      src={effectiveSrc}
      alt={alt}
      title={title}
      className={className}
      loading={loading}
      onClick={onClick}
      onError={(event) => {
        if (resolved && event.currentTarget.src !== resolved) {
          event.currentTarget.src = resolved;
        }
      }}
    />
  );
});
