/**
 * 「在资源管理器中定位」请求：聊天正文 / 文件阅读器中点击目录路径时发出。
 * 侧栏订阅后按显示位置偏好打开资源管理器（内嵌侧栏或右侧面板 tab），
 * 资源管理器实例逐层展开到目标目录并高亮提醒一次。
 *
 * 资源管理器可能尚未挂载（懒加载 chunk、右侧面板 tab 尚未创建）或仍在加载
 * 根目录，因此保留最近一次请求供其就绪后读取；请求带有效期，过期即失效，
 * 避免很久之后打开资源管理器时被旧请求意外定位。
 */

export type ExplorerRevealRequest = {
  seq: number;
  /** 目标所属工作区目录 id */
  directoryId: string;
  /** 该工作区的根目录路径（资源管理器据此确认根目录已切换就绪） */
  rootPath: string;
  /** 目标目录的绝对路径 */
  path: string;
  createdAt: number;
};

const REQUEST_TTL_MS = 10_000;

let latestRequest: ExplorerRevealRequest | null = null;
let requestSeq = 0;
const listeners = new Set<(request: ExplorerRevealRequest) => void>();

export const explorerRevealStore = {
  request(input: {
    directoryId: string;
    rootPath: string;
    path: string;
  }): void {
    requestSeq += 1;
    const request: ExplorerRevealRequest = {
      ...input,
      seq: requestSeq,
      createdAt: Date.now(),
    };
    latestRequest = request;
    for (const listener of listeners) {
      listener(request);
    }
  },
  /** 有效期内的最近一次请求；已过期返回 null。 */
  latest(): ExplorerRevealRequest | null {
    if (
      latestRequest &&
      Date.now() - latestRequest.createdAt > REQUEST_TTL_MS
    ) {
      latestRequest = null;
    }
    return latestRequest;
  },
  subscribe(listener: (request: ExplorerRevealRequest) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** 可比较形式：统一为 / 分隔、去掉末尾分隔符；盘符路径（Windows）转小写。 */
export const normalizeComparablePath = (path: string): string => {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
};

/**
 * target 相对 root 的路径段（保留原始大小写）：就是 root 本身时返回空数组，
 * 不在 root 之内返回 null。
 */
export const relativePathSegments = (
  root: string,
  target: string,
): string[] | null => {
  const normalizedRoot = normalizeComparablePath(root);
  const normalizedTarget = normalizeComparablePath(target);
  if (normalizedTarget === normalizedRoot) {
    return [];
  }
  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return null;
  }
  return target
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .slice(normalizedRoot.length + 1)
    .split("/")
    .filter(Boolean);
};
