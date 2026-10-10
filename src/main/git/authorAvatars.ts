import { net } from "electron";
import { app } from "electron";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

/**
 * GitHub 提交作者头像反查。
 *
 * 存在动机：按邮箱静态推导头像（noreply → GitHub、QQ → QQ 头像、其余 → Gravatar）
 * 覆盖不了既未注册 Gravatar、邮箱里也不含 GitHub login 的作者（典型如 Gmail），
 * 这类作者只能退到几何图案。GitHub API 是唯一可靠的补充来源：`GET
 * /repos/{owner}/{repo}/commits` 的 `author.avatar_url` 返回 GitHub 依据提交
 * 邮箱关联到的账号头像（前提是该提交已推送到远端）。
 *
 * 认证：优先 `GITHUB_TOKEN`，其次 `GH_TOKEN`（gh CLI 登录后写入的环境变量），与
 * `native/src/mcp/servers/skills_installer/github.rs` 的既有惯例一致。带 token 时
 * 限流为 5000 次/小时，匿名仅 60 次/小时。token 只在本模块使用，绝不下发渲染进程。
 *
 * 隐私：请求中只包含仓库名（公开信息）与已推送提交的作者邮箱——这些邮箱本就公开
 * 存在于提交历史里，因此不构成额外泄露。
 */

/** GitHub REST API 基址。 */
const GITHUB_API = "https://api.github.com";

/** 作者头像缓存有效期：换头像频率极低，7 天足够。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 单仓库最多翻页数（每页 100 条提交）。头像只用于悬停卡片，无需回溯全部历史。 */
const MAX_PAGES = 3;

/** 单次 API 请求超时，避免网络异常时悬停卡片长时间等待。 */
const REQUEST_TIMEOUT_MS = 8000;

/** 命中限流后的暂停时长上限，防止把「重置时间」算成极远的未来。 */
const MAX_RATE_LIMIT_PAUSE_MS = 60 * 60 * 1000;

/** 邮箱 → 头像地址 的映射（仅包含反查成功的项）。 */
export type AuthorAvatarMap = Record<string, string>;

type ParsedRemote = { owner: string; repo: string };

type RepoCache = {
  updatedAt: number;
  /** 已确认「查不到账号」的邮箱，避免每次悬停都重复翻页。 */
  authors: AuthorAvatarMap;
  misses: string[];
};

type CacheFile = {
  repos: Record<string, RepoCache>;
};

/** 缓存文件路径（userData 下，与 window-state.json 等既有惯例一致）。 */
const cacheFilePath = (): string =>
  join(app.getPath("userData"), "git-author-avatars.json");

let memoryCache: CacheFile | null = null;

/** 进行中的仓库请求，避免同一仓库被并发重复拉取。 */
const inFlight = new Map<string, Promise<AuthorAvatarMap>>();

/** 限流暂停：仓库键或 "*"（全局限流）→ 可再次请求的时间戳。 */
const pausedUntil = new Map<string, number>();

const readToken = (): string | null => {
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
};

/**
 * 解析 GitHub 远端地址为 owner/repo。支持 https / ssh / scp 三种写法，非 GitHub
 * 远端返回 null（GitLab、Gitee 等没有等价的反查接口，交由静态推导兜底）。
 */
const parseGithubRemote = (remoteUrl: string | null): ParsedRemote | null => {
  const trimmed = remoteUrl?.trim() ?? "";
  if (!trimmed) return null;

  let host: string;
  let path: string;
  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    // scp 形式：git@github.com:owner/repo.git
    const match = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
    if (!match) return null;
    host = match[1].toLowerCase();
    path = match[2];
  }

  if (host.replace(/^www\./, "") !== "github.com") return null;

  const segments = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  return { owner, repo };
};

/** 读取磁盘缓存（首次访问时载入内存；损坏的缓存按空处理）。 */
const loadCache = async (): Promise<CacheFile> => {
  if (memoryCache) return memoryCache;
  try {
    const raw = await readFile(cacheFilePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    memoryCache =
      parsed && typeof parsed === "object" && parsed.repos
        ? parsed
        : { repos: {} };
  } catch {
    // 首次运行或文件损坏：从空缓存开始。
    memoryCache = { repos: {} };
  }
  return memoryCache;
};

/** 写回磁盘缓存；失败只影响下次命中，不向上抛。 */
const saveCache = async (cache: CacheFile): Promise<void> => {
  try {
    const file = cacheFilePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache), "utf8");
  } catch {
    // 忽略：缓存是纯优化。
  }
};

/** 从 API 响应里取提交项的邮箱与作者头像，形状不符时跳过。 */
const collectFromCommitItem = (item: unknown, into: AuthorAvatarMap): void => {
  if (!item || typeof item !== "object") return;
  const record = item as Record<string, unknown>;
  const author = record.author;
  if (!author || typeof author !== "object") return;

  const avatarUrl = (author as Record<string, unknown>).avatar_url;
  if (typeof avatarUrl !== "string" || !avatarUrl) return;

  const commit = record.commit;
  if (!commit || typeof commit !== "object") return;
  const commitAuthor = (commit as Record<string, unknown>).author;
  if (!commitAuthor || typeof commitAuthor !== "object") return;

  const email = (commitAuthor as Record<string, unknown>).email;
  if (typeof email !== "string" || !email.trim()) return;

  const normalized = email.trim().toLowerCase();
  // 同一邮箱出现多次时以首个为准，避免重复覆盖。
  if (!into[normalized]) {
    into[normalized] = avatarUrl;
  }
};

/** 记录限流暂停时间（响应头给出重置时刻）。 */
const noteRateLimit = (key: string, response: Response): void => {
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
  if (!Number.isFinite(reset) || reset <= 0) {
    pausedUntil.set(key, Date.now() + 60_000);
    return;
  }
  const until = reset * 1000;
  pausedUntil.set(key, Math.min(until, Date.now() + MAX_RATE_LIMIT_PAUSE_MS));
};

/**
 * 翻页拉取仓库提交，收集「目标邮箱 → 作者头像」。所有目标邮箱都命中、页数用尽或
 * 遇到限流/错误时停止；任何失败都只返回已收集到的部分（头像纯属装饰，不抛错）。
 */
const fetchAuthorAvatars = async (
  parsed: ParsedRemote,
  repoKey: string,
  wanted: Set<string>,
  token: string | null,
): Promise<AuthorAvatarMap> => {
  const found: AuthorAvatarMap = {};

  for (let page = 1; page <= MAX_PAGES; page++) {
    const paused = pausedUntil.get(repoKey) ?? pausedUntil.get("*") ?? 0;
    if (Date.now() < paused) {
      break;
    }

    const url =
      `${GITHUB_API}/repos/${parsed.owner}/${parsed.repo}` +
      `/commits?per_page=100&page=${page}`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await net.fetch(url, {
        headers,
        // 不带 Cookie，避免把本地登录态泄露给 API。
        credentials: "omit",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      break;
    }

    if (!response.ok) {
      if (response.status === 403 || response.status === 429) {
        noteRateLimit(repoKey, response);
      }
      break;
    }

    let items: unknown;
    try {
      items = await response.json();
    } catch {
      break;
    }
    if (!Array.isArray(items) || items.length === 0) {
      break;
    }

    for (const item of items) {
      collectFromCommitItem(item, found);
    }

    // 目标邮箱全部命中（或本页已不足 100 条，说明到底了）就无需继续翻页。
    if (items.length < 100) {
      break;
    }
    if ([...wanted].every((email) => found[email])) {
      break;
    }
  }

  return found;
};

/**
 * 解析一组作者邮箱的 GitHub 头像。
 *
 * @param remoteUrl 仓库远端地址（用于定位 owner/repo；非 GitHub 远端直接返回空）
 * @param emails 需要解析的邮箱（来自本地提交历史）
 * @returns 邮箱（小写）→ 头像地址；查不到的作者不出现在结果中，由调用方继续回退
 */
export const resolveGitAuthorAvatars = async (
  remoteUrl: string | null,
  emails: string[],
): Promise<AuthorAvatarMap> => {
  const parsed = parseGithubRemote(remoteUrl);
  if (!parsed) return {};

  const wanted = new Set(
    emails.map((email) => email?.trim().toLowerCase()).filter(Boolean),
  );
  if (wanted.size === 0) return {};

  const repoKey = `${parsed.owner}/${parsed.repo}`;
  const cache = await loadCache();
  const entry = cache.repos[repoKey];
  const fresh = entry ? Date.now() - entry.updatedAt < CACHE_TTL_MS : false;

  const result: AuthorAvatarMap = {};
  const pending: string[] = [];
  for (const email of wanted) {
    const cached = fresh ? entry.authors[email] : undefined;
    if (cached) {
      result[email] = cached;
    } else if (fresh && entry.misses.includes(email)) {
      // 缓存期内已确认查不到，无需再请求。
      continue;
    } else {
      pending.push(email);
    }
  }
  if (pending.length === 0) return result;

  // 同一仓库的并发请求合并为一次，避免多张卡片同时触发重复拉取。
  let running = inFlight.get(repoKey);
  if (!running) {
    running = fetchAuthorAvatars(parsed, repoKey, wanted, readToken());
    inFlight.set(repoKey, running);
    void running.finally(() => inFlight.delete(repoKey));
  }
  const fetched = await running;

  const nextEntry: RepoCache = {
    updatedAt: Date.now(),
    authors: { ...(fresh ? entry.authors : {}), ...fetched },
    misses: [
      ...new Set([
        ...(fresh ? entry.misses : []),
        ...pending.filter((email) => !fetched[email]),
      ]),
    ],
  };
  cache.repos[repoKey] = nextEntry;
  void saveCache(cache);

  for (const email of pending) {
    if (fetched[email]) {
      result[email] = fetched[email];
    }
  }
  return result;
};
