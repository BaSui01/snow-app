import {
  CircleDot,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Hash,
  MessageSquareText,
  Tag,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  GitBranch as GitBranchType,
  GitCommitFile,
  GitFileStatus,
  GitLogEntry,
  GitWorktreeInfo,
} from "../../../../preload";
import { useI18n } from "../../../i18n";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import type { OpenDiffTabCallback } from "../types";
import { BRANCHES_CHANGED, useBranchManagement } from "./useBranchManagement";

type GitGraphProps = {
  repoPath: string;
  /** 当前分支名（来自 git status）：切换分支时提交图整体重载，因为图谱只
   *  包含当前分支可达的提交，增量合并无法移除旧分支独有的提交。 */
  branch?: string | null;
  /** Worktrees whose branches/HEADs should be identified in the graph. */
  worktrees?: GitWorktreeInfo[];
  /** Bump to force a full reload of the history from the first page. */
  refreshKey?: number;
  /** Opens a commit file's diff in a new right-panel tab. */
  onOpenInTab?: OpenDiffTabCallback;
};

/** 将提交文件（GitCommitFile）转换为 DiffTab 所需的 GitFileStatus 形状。 */
const toGitFileStatus = (file: GitCommitFile): GitFileStatus => ({
  path: file.path,
  oldPath: null,
  indexStatus: "",
  workdirStatus: "",
  status: file.status,
});

/** 图片文件直接渲染图片而非文本 diff（文本 diff 会因二进制 --text
 *  重试产生巨大乱码 patch 而卡死）。 */
const isImageFile = (path: string): boolean =>
  /\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|avif)$/i.test(path);

// --- Types ---

interface GraphRow {
  commit: GitLogEntry;
  dotLane: number;
  topLines: number[];
  topColors: string[];
  bottomLines: number[];
  bottomColors: string[];
  curves: { from: number; to: number; color: string }[];
  merges: { from: number; color: string }[];
}

// --- Constants ---

const PAGE_SIZE = 50;
/** 增量刷新最多向前扫描的提交数；超过（新提交过多）则退回整体重载。 */
const INCREMENTAL_MAX_COMMITS = 200;
const LANE_WIDTH = 20;
const ROW_HEIGHT = 28;
const DOT_RADIUS = 4;
const LINE_WIDTH = 2;

const LANE_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
];

// --- Ordering ---

/**
 * Reorders commits so the first-parent chain is laid out first.
 *
 * `git log` guarantees children appear before parents, but its default
 * date ordering can still list a merge's SECOND-parent branch before the
 * first parent's continuation (side branches are often newer). The
 * incremental lane algorithm assigns lanes as rows are consumed, so such
 * a side branch colonizes the early lanes; when the mainline later
 * reaches the same commits it bends into a side lane and the main axis
 * ends up red instead of blue.
 *
 * This is Kahn's topological sort with a LIFO worklist: children always
 * precede parents, and among the ready commits the one that became ready
 * most recently wins — i.e. "keep following the first parent before
 * backtracking into side branches". The newest tip pops first, so the
 * whole main axis lands in lane 0 (blue) and branches fill the remaining
 * lanes.
 */
function reorderFirstParentFirst(commits: GitLogEntry[]): GitLogEntry[] {
  if (commits.length < 2) {
    return commits;
  }

  const byHash = new Map<string, GitLogEntry>();
  const childCount = new Map<string, number>();
  for (const commit of commits) {
    byHash.set(commit.hash, commit);
    childCount.set(commit.hash, 0);
  }
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (byHash.has(parent)) {
        childCount.set(parent, childCount.get(parent)! + 1);
      }
    }
  }

  const stack: GitLogEntry[] = [];
  for (let i = commits.length - 1; i >= 0; i--) {
    if (childCount.get(commits[i].hash) === 0) {
      stack.push(commits[i]);
    }
  }

  const ordered: GitLogEntry[] = [];
  while (stack.length > 0) {
    const commit = stack.pop()!;
    ordered.push(commit);
    for (let i = commit.parents.length - 1; i >= 0; i--) {
      const remaining = childCount.get(commit.parents[i]);
      if (remaining === undefined) continue;
      if (remaining === 1) {
        stack.push(byHash.get(commit.parents[i])!);
      }
      childCount.set(commit.parents[i], remaining - 1);
    }
  }
  return ordered;
}

// --- Lane computation ---

function computeGraph(
  commits: GitLogEntry[],
  worktreeEdgeColors: Map<string, string>,
): {
  rows: GraphRow[];
  maxLanes: number;
} {
  const hashToLane = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const laneColors: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const commitByHash = new Map(commits.map((c) => [c.hash, c]));
  const mainline = new Set<string>();
  for (
    let cur: GitLogEntry | undefined = commits[0];
    cur;
    cur = cur.parents[0] ? commitByHash.get(cur.parents[0]) : undefined
  ) {
    mainline.add(cur.hash);
  }

  for (const commit of commits) {
    let dotLane: number;
    if (hashToLane.has(commit.hash)) {
      dotLane = hashToLane.get(commit.hash)!;
      hashToLane.delete(commit.hash);
    } else {
      const freeLane = lanes.indexOf(null);
      dotLane = freeLane !== -1 ? freeLane : lanes.length;
      if (dotLane >= lanes.length) {
        lanes.push(null);
        laneColors.push(null);
      }
    }

    // 其他车道上同样指向本提交的线条：本行的顶部竖线由大半径弯弧取代，
    // 弧线在整行高度内平滑汇入圆点。
    const merges: { from: number; color: string }[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i !== dotLane && lanes[i] === commit.hash) {
        merges.push({
          from: i,
          color: laneColors[i] ?? LANE_COLORS[i % LANE_COLORS.length],
        });
      }
    }
    const mergeLanes = new Set(merges.map((merge) => merge.from));

    const topLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null && !mergeLanes.has(i)) topLines.push(i);
    }
    const topColors = laneColors.map(
      (color, lane) => color ?? LANE_COLORS[lane % LANE_COLORS.length],
    );

    // 本提交所在线条的颜色：继续向前延伸的第一父边沿用它，让一条分支从
    // 分叉点到汇合点保持同色。
    const lineColor = topColors[dotLane];

    lanes[dotLane] = null;
    laneColors[dotLane] = null;
    for (const lane of mergeLanes) {
      lanes[lane] = null;
      laneColors[lane] = null;
    }
    const curves: { from: number; to: number; color: string }[] = [];

    for (let p = 0; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      const isFirstParent = p === 0;
      const worktreeColor = worktreeEdgeColors.get(
        `${commit.hash}\0${parentHash}`,
      );

      if (hashToLane.has(parentHash)) {
        const parentLane = hashToLane.get(parentHash)!;
        if (isFirstParent) {
          // 第一父提交已停在别的车道上：本线沿用当前车道继续指向它，到
          // 父提交所在行再弯入圆点；主线提交让父提交的圆点回到主线车道。
          lanes[dotLane] = parentHash;
          laneColors[dotLane] = worktreeColor ?? lineColor;
          if (mainline.has(commit.hash)) {
            hashToLane.set(parentHash, dotLane);
          }
          continue;
        }
        const edgeColor =
          worktreeColor ?? LANE_COLORS[parentLane % LANE_COLORS.length];
        laneColors[parentLane] = edgeColor;
        if (parentLane !== dotLane) {
          curves.push({ from: dotLane, to: parentLane, color: edgeColor });
        }
        continue;
      }

      let parentLane: number;
      if (isFirstParent) {
        parentLane = dotLane;
      } else {
        const freeLane = lanes.indexOf(null);
        parentLane = freeLane !== -1 ? freeLane : lanes.length;
        if (parentLane >= lanes.length) {
          lanes.push(null);
          laneColors.push(null);
        }
      }
      hashToLane.set(parentHash, parentLane);
      const edgeColor =
        worktreeColor ?? LANE_COLORS[parentLane % LANE_COLORS.length];
      lanes[parentLane] = parentHash;
      laneColors[parentLane] = edgeColor;
      if (parentLane !== dotLane) {
        curves.push({ from: dotLane, to: parentLane, color: edgeColor });
      }
    }

    const bottomLines: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] !== null) bottomLines.push(i);
    }
    const bottomColors = laneColors.map(
      (color, lane) => color ?? LANE_COLORS[lane % LANE_COLORS.length],
    );

    rows.push({
      commit,
      dotLane,
      topLines,
      topColors,
      bottomLines,
      bottomColors,
      curves,
      merges,
    });
  }

  return { rows, maxLanes: lanes.length };
}

// --- Helpers ---

function formatDate(dateStr: string): string {
  return dateStr.split(" ")[0];
}

function getCommitFileColor(status: string): string {
  if (status.startsWith("A")) return "git-status-add";
  if (status.startsWith("D")) return "git-status-delete";
  if (status.startsWith("R")) return "git-status-rename";
  return "git-status-modify";
}

function getCommitFileLabel(status: string): string {
  if (status.startsWith("A")) return "A";
  if (status.startsWith("D")) return "D";
  if (status.startsWith("R")) return "R";
  if (status.startsWith("C")) return "C";
  if (status.startsWith("M")) return "M";
  return status.charAt(0);
}

/** A single ref decoration attached to a commit row. */
interface ParsedRef {
  kind: "local" | "remote" | "tag";
  /** Display name: branch name, `origin/xxx` for remotes, tag name. */
  name: string;
  /** True when the checked-out HEAD points at this commit. */
  isHead: boolean;
}

const HEAD_ARROW = "HEAD -> ";
const HEADS_PREFIX = "refs/heads/";
const REMOTES_PREFIX = "refs/remotes/";
const TAGS_PREFIX = "refs/tags/";

/**
 * Parses a commit's decoration string (`%D` with `--decorate=full`, e.g.
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v1") into
 * typed refs so local branches, remote-tracking branches and tags can be
 * badged distinctly. Short-form decorations (without the refs/ prefixes)
 * are tolerated as a fallback and treated as local branches.
 */
function parseRefs(refs: string): ParsedRef[] {
  const parsed: ParsedRef[] = [];
  if (!refs) {
    return parsed;
  }

  for (const rawPart of refs.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    // Detached HEAD decorates as a bare "HEAD".
    if (part === "HEAD") {
      parsed.push({ kind: "local", name: "HEAD", isHead: true });
      continue;
    }

    let body = part;
    let isHead = false;
    if (part.startsWith(HEAD_ARROW)) {
      isHead = true;
      body = part.slice(HEAD_ARROW.length).trim();
    }

    if (body.startsWith(HEADS_PREFIX)) {
      parsed.push({
        kind: "local",
        name: body.slice(HEADS_PREFIX.length),
        isHead,
      });
    } else if (body.startsWith(REMOTES_PREFIX)) {
      parsed.push({
        kind: "remote",
        name: body.slice(REMOTES_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith(TAGS_PREFIX)) {
      parsed.push({
        kind: "tag",
        name: body.slice(TAGS_PREFIX.length),
        isHead: false,
      });
    } else if (body.startsWith("tag: ")) {
      parsed.push({ kind: "tag", name: body.slice(5).trim(), isHead: false });
    } else if (body) {
      parsed.push({ kind: "local", name: body, isHead });
    }
  }

  return parsed;
}

/** Stable per-worktree accent, independent of the topology lane assignment. */
function getWorktreeColor(worktree: GitWorktreeInfo): string {
  const identity =
    worktree.worktreeId || worktree.branchName || worktree.headOid;
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) {
    hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue} 78% 62%)`;
}

/** Match only true local branch refs, or detached worktrees at their HEAD commit. */
function getCommitWorktrees(
  commit: GitLogEntry,
  refs: ParsedRef[],
  worktrees: GitWorktreeInfo[],
): GitWorktreeInfo[] {
  const localBranches = new Set(
    refs
      .filter((ref) => ref.kind === "local" && ref.name !== "HEAD")
      .map((ref) => ref.name),
  );
  const oid = commit.hash.toLowerCase();
  return worktrees.filter((worktree) =>
    worktree.isDetached
      ? worktree.headOid.toLowerCase() === oid
      : !!worktree.branchName && localBranches.has(worktree.branchName),
  );
}

/**
 * Color only edges that are reachable from exactly one loaded worktree tip.
 * Shared ancestry and edges outside the loaded history retain lane colors.
 */
function getWorktreeEdgeColors(
  commits: GitLogEntry[],
  worktrees: GitWorktreeInfo[],
): Map<string, string> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const memberships = new Map<string, Set<string>>();

  for (const worktree of worktrees) {
    const tips = commits.filter(
      (commit) =>
        getCommitWorktrees(commit, parseRefs(commit.refs), [worktree]).length >
        0,
    );
    // Without every worktree tip in the loaded window, uniqueness cannot be
    // established: an unseen tip may also reach any edge we would color.
    if (tips.length === 0) return new Map();

    const visited = new Set<string>();
    const pending = tips.map((tip) => tip.hash);

    while (pending.length > 0) {
      const childHash = pending.pop()!;
      if (visited.has(childHash)) continue;
      visited.add(childHash);
      const child = byHash.get(childHash);
      if (!child) continue;

      for (const parentHash of child.parents) {
        if (!byHash.has(parentHash)) continue;
        const edgeKey = `${childHash}\0${parentHash}`;
        const edgeMembership = memberships.get(edgeKey) ?? new Set<string>();
        edgeMembership.add(worktree.worktreeId);
        memberships.set(edgeKey, edgeMembership);
        pending.push(parentHash);
      }
    }
  }

  const colors = new Map<string, string>();
  for (const [edgeKey, worktreeIds] of memberships) {
    if (worktreeIds.size !== 1) continue;
    const worktreeId = worktreeIds.values().next().value;
    const worktree = worktrees.find((item) => item.worktreeId === worktreeId);
    if (worktree) colors.set(edgeKey, getWorktreeColor(worktree));
  }
  return colors;
}

// --- Component ---

export const GitGraph = ({
  repoPath,
  branch,
  worktrees = [],
  refreshKey,
  onOpenInTab,
}: GitGraphProps): React.JSX.Element => {
  const { t } = useI18n();
  const management = useBranchManagement(repoPath, () => {});
  useEffect(() => {
    setBranchContextMenu(null);
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === repoPath) {
        void reloadFromStart(() => cancelled);
        window.snow
          .gitBranches(repoPath)
          .then((items) => {
            if (!cancelled)
              setBranchMap(new Map(items.map((item) => [item.name, item])));
          })
          .catch((cause) => {
            if (!cancelled) showActionError(String(cause));
          });
      }
    };
    let cancelled = false;
    window.addEventListener(BRANCHES_CHANGED, changed);
    return () => {
      cancelled = true;
      window.removeEventListener(BRANCHES_CHANGED, changed);
    };
  }, [repoPath]);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  // 当前选中的提交文件（hash + path），用于在文件列表中高亮。
  const [viewedCommitFile, setViewedCommitFile] = useState<{
    hash: string;
    path: string;
  } | null>(null);

  // 分支与工作树映射表（branchName -> GitBranchType）
  const [branchMap, setBranchMap] = useState<Map<string, GitBranchType>>(
    new Map(),
  );

  // 分支徽章专属菜单
  const [branchContextMenu, setBranchContextMenu] = useState<{
    x: number;
    y: number;
    ref: ParsedRef;
  } | null>(null);

  // 轻量操作反馈（如 checkout 失败的错误原因），自动淡出
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimerRef = useRef<number | null>(null);

  const showActionError = useCallback((msg: string) => {
    setActionError(msg);
    if (actionErrorTimerRef.current) {
      window.clearTimeout(actionErrorTimerRef.current);
    }
    actionErrorTimerRef.current = window.setTimeout(() => {
      setActionError(null);
    }, 4000);
  }, []);

  const normalizedRepoPath = useMemo(
    () => repoPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(),
    [repoPath],
  );

  const isOtherWorktreePath = useCallback(
    (wtPath: string | null | undefined): boolean => {
      if (!wtPath) return false;
      const normalized = wtPath
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      return normalized !== normalizedRepoPath;
    },
    [normalizedRepoPath],
  );

  const getWorktreeFolderName = useCallback((wtPath: string): string => {
    const parts = wtPath.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || wtPath;
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.snow
      .gitBranches(repoPath)
      .then((branches) => {
        if (cancelled) return;
        const map = new Map<string, GitBranchType>();
        for (const b of branches) {
          map.set(b.name, b);
        }
        setBranchMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, refreshKey]);

  const loadingRef = useRef(false);
  const loadedCountRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 已加载提交的镜像：增量刷新需要拿它取锚点，但不能把 commits 放进
  // useCallback 依赖（否则列表一变回调就重建）。
  const commitsRef = useRef<GitLogEntry[]>([]);
  // 增量前插前记录的内容高度：渲染后按高度差补偿滚动偏移，视口不跳动。
  const scrollAnchorHeightRef = useRef<number | null>(null);
  // 数据世代：整体重载（切换仓库 / 分支）时自增，让并发中的增量合并结果作废。
  const generationRef = useRef(0);

  const loadPage = useCallback(
    async (skip: number, isInitial: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;

      try {
        const entries = await window.snow.gitLog(repoPath, skip, PAGE_SIZE);
        if (entries.length < PAGE_SIZE) {
          setHasMore(false);
        }
        if (entries.length > 0) {
          if (isInitial) {
            setCommits(entries);
          } else {
            setCommits((prev) => [...prev, ...entries]);
          }
          loadedCountRef.current = skip + entries.length;
        } else {
          setHasMore(false);
        }
      } catch (err) {
        setError(String(err));
        setHasMore(false);
      } finally {
        loadingRef.current = false;
        setIsLoading(false);
      }
    },
    [repoPath],
  );

  /** 从第一页整体重载：切换仓库 / 分支，以及增量刷新找不到锚点时的兜底。 */
  const reloadFromStart = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      generationRef.current += 1;
      setCommits([]);
      setHasMore(true);
      setError(null);
      setIsLoading(true);
      setSelectedHash(null);
      setCommitFiles([]);
      setViewedCommitFile(null);
      loadedCountRef.current = 0;
      loadingRef.current = true;
      try {
        const entries = await window.snow.gitLog(repoPath, 0, PAGE_SIZE);
        if (isCancelled()) return;
        if (entries.length < PAGE_SIZE) {
          setHasMore(false);
        }
        if (entries.length > 0) {
          setCommits(entries);
          loadedCountRef.current = entries.length;
        } else {
          setHasMore(false);
        }
      } catch (err) {
        if (!isCancelled()) {
          setError(String(err));
          setHasMore(false);
        }
      } finally {
        if (!isCancelled()) {
          loadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [repoPath],
  );

  // 切换仓库或分支：清空后整体重载。分支切换必须整体重载——提交图只包含
  // 当前分支可达的提交，增量合并无法移除旧分支独有的提交。`branch` 由
  // git status 异步回报：从「未知」到已知只是首次登记（挂载与仓库切换时的
  // 首屏加载取的就是当前 HEAD 的数据），不触发重载。cancelled 标记用于
  // 抵御 React Strict Mode 的双次调用（第一次的结果被丢弃）。
  const loadedBranchRef = useRef<string | null>(null);

  // 切换仓库：上一仓库的分支记录作废，等新仓库的分支到位再比较。
  useEffect(() => {
    loadedBranchRef.current = null;
  }, [repoPath]);

  useEffect(() => {
    let cancelled = false;
    loadingRef.current = false;
    void reloadFromStart(() => cancelled);
    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [reloadFromStart]);

  useEffect(() => {
    const branchName = branch || null;
    if (branchName === null) {
      return;
    }
    const previous = loadedBranchRef.current;
    loadedBranchRef.current = branchName;
    if (previous === null || previous === branchName) {
      return;
    }

    let cancelled = false;
    loadingRef.current = false;
    void reloadFromStart(() => cancelled);
    return () => {
      cancelled = true;
      loadingRef.current = false;
    };
  }, [branch, reloadFromStart]);

  /**
   * 增量刷新：只拉取「已加载的最新提交」（锚点）之上的新提交并前插，同时用
   * 同一批数据刷新锚点及其后已加载提交的引用徽章与推送状态（推送会移动
   * origin/* 这类远端跟踪分支，并使本地提交转为已推送）。找不到锚点
   * （rebase / amend / force push 改写了历史）或新增提交超过上限时，退回整体重载。
   */
  const refreshIncrementally = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      const generation = generationRef.current;
      const loaded = commitsRef.current;
      const anchorHash = loaded[0]?.hash;
      if (!anchorHash) {
        await reloadFromStart(isCancelled);
        return;
      }

      const scanned: GitLogEntry[] = [];
      let newCount = -1;
      try {
        while (newCount === -1 && scanned.length < INCREMENTAL_MAX_COMMITS) {
          const page = await window.snow.gitLog(
            repoPath,
            scanned.length,
            PAGE_SIZE,
          );
          if (isCancelled()) return;
          if (page.length === 0) break;
          for (let i = 0; i < page.length; i++) {
            if (page[i].hash === anchorHash) {
              newCount = scanned.length;
              // 锚点及其后同页条目都是已加载提交，用最新数据刷新引用徽章与推送状态。
              for (let j = i; j < page.length; j++) {
                scanned.push(page[j]);
              }
              break;
            }
            scanned.push(page[i]);
          }
          if (newCount === -1 && page.length < PAGE_SIZE) break;
        }
      } catch {
        // 取数失败：保持现状，等下次刷新。
        return;
      }

      if (newCount === -1) {
        await reloadFromStart(isCancelled);
        return;
      }

      const freshMeta = new Map<string, { refs: string; pushed: boolean }>();
      for (let i = newCount; i < scanned.length; i++) {
        freshMeta.set(scanned[i].hash, {
          refs: scanned[i].refs,
          pushed: scanned[i].pushed,
        });
      }
      const metaChanged = loaded.some((commit) => {
        const fresh = freshMeta.get(commit.hash);
        return (
          fresh !== undefined &&
          (fresh.refs !== commit.refs || fresh.pushed !== commit.pushed)
        );
      });
      if (newCount === 0 && !metaChanged) {
        return;
      }
      // 扫描期间若发生过整体重载（切换仓库 / 分支），本次合并已失效。
      if (generationRef.current !== generation) {
        return;
      }

      if (newCount > 0) {
        scrollAnchorHeightRef.current =
          containerRef.current?.offsetHeight ?? null;
        loadedCountRef.current += newCount;
      }
      setCommits((prev) => {
        const merged = prev.map((commit) => {
          const fresh = freshMeta.get(commit.hash);
          if (fresh === undefined) {
            return commit;
          }
          return fresh.refs === commit.refs && fresh.pushed === commit.pushed
            ? commit
            : { ...commit, refs: fresh.refs, pushed: fresh.pushed };
        });
        return newCount > 0
          ? [...scanned.slice(0, newCount), ...merged]
          : merged;
      });
    },
    [repoPath, reloadFromStart],
  );

  useEffect(() => {
    commitsRef.current = commits;
  }, [commits]);

  // 外部刷新（提交 / 推送 / 拉取 / 手动刷新）：增量合并，保住滚动位置与展开
  // 的提交详情；只有历史被改写时才整体重载。
  const handledRefreshKeyRef = useRef(0);
  useEffect(() => {
    if (!refreshKey || handledRefreshKeyRef.current === refreshKey) {
      return;
    }
    handledRefreshKeyRef.current = refreshKey;
    let cancelled = false;
    void refreshIncrementally(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, refreshIncrementally]);

  // 前插补偿：用户已向下滚动时按内容高度差推回滚动位置（视口内容保持不动）；
  // 停留在顶部附近时不做补偿，让新提交直接出现在视野里。
  useLayoutEffect(() => {
    const before = scrollAnchorHeightRef.current;
    if (before === null) {
      return;
    }
    scrollAnchorHeightRef.current = null;
    const scroller = containerRef.current?.parentElement;
    if (!scroller) {
      return;
    }
    const delta = (containerRef.current?.offsetHeight ?? before) - before;
    if (delta > 0 && scroller.scrollTop > ROW_HEIGHT) {
      scroller.scrollTop += delta;
    }
  }, [commits]);

  const loadMore = useCallback(() => {
    if (loadingRef.current || !hasMore) return;
    loadPage(loadedCountRef.current, false);
  }, [hasMore, loadPage]);

  // IntersectionObserver for infinite scroll.
  // The scroll container is the panel pane (.git-panel-graph), not
  // .git-graph itself. Using viewport (null) as root works because
  // .git-graph doesn't scroll on its own — scrolling happens in the pane,
  // which moves the sentinel relative to the viewport.
  //
  // IMPORTANT: this effect must re-run after the initial loading completes,
  // because the sentinel is only rendered in the non-loading branch. During
  // the first run (isLoading=true) the sentinel is not in the DOM yet.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, isLoading, commits.length]);

  // Fetch commit files when a commit is selected.
  // NOTE: commitFiles is cleared synchronously in handleRowClick (not here)
  // to prevent stale files from the previously selected commit flashing for
  // one frame before this effect runs. useEffect fires AFTER render, so
  // clearing here would render with selectedHash=B but commitFiles=A's data.
  useEffect(() => {
    if (!selectedHash || !repoPath) return;
    let cancelled = false;
    setIsLoadingFiles(true);

    window.snow
      .gitCommitFiles(repoPath, selectedHash)
      .then((files) => {
        if (!cancelled) {
          setCommitFiles(files);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommitFiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingFiles(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedHash, repoPath]);

  const worktreeEdgeColors = useMemo(
    () => getWorktreeEdgeColors(commits, worktrees),
    [commits, worktrees],
  );
  const { rows, maxLanes } = useMemo(
    () => computeGraph(reorderFirstParentFirst(commits), worktreeEdgeColors),
    [commits, worktreeEdgeColors],
  );
  const graphWidth = Math.max(maxLanes * LANE_WIDTH, LANE_WIDTH);
  const graphWorktrees = worktrees;
  const matchedWorktreeIds = useMemo(() => {
    const matched = new Set<string>();
    for (const row of rows) {
      for (const worktree of getCommitWorktrees(
        row.commit,
        parseRefs(row.commit.refs),
        worktrees,
      )) {
        matched.add(worktree.worktreeId);
      }
    }
    return matched;
  }, [rows, worktrees]);

  const handleRowClick = (hash: string) => {
    setSelectedHash((prev) => {
      if (prev === hash) {
        // Collapsing: no need to touch commitFiles, detail unmounts.
        return null;
      }
      // Expanding a (possibly different) commit: clear stale files and enter
      // loading synchronously in the same batched render so the detail panel
      // shows the loading state immediately instead of the previous commit's
      // file list for one frame.
      setCommitFiles([]);
      setIsLoadingFiles(true);
      return hash;
    });
  };

  const handleRowDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, commit: GitLogEntry) => {
      const tag = {
        hash: commit.hash,
        shortHash: commit.shortHash,
        author: commit.author,
        date: commit.date,
        message: commit.message,
        repoPath,
      };
      event.dataTransfer.setData("application/json", JSON.stringify(tag));
      event.dataTransfer.effectAllowed = "copy";
    },
    [repoPath],
  );

  // Hover tooltip with the full commit details. Rendered in a portal with
  // fixed positioning so the scroll container (.git-control-scroll) cannot
  // clip it, and anchored to the hovered row: vertically centered on that
  // row, opening towards whichever side has room, with an arrow pointing
  // back at the row it belongs to.
  const [hoveredCommit, setHoveredCommit] = useState<GitLogEntry | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 悬停锚点：被悬停的提交行元素。
  const tooltipAnchorRef = useRef<HTMLElement | null>(null);
  // 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commit: GitLogEntry;
  } | null>(null);
  // 提交内文件右键菜单：复制文件路径（双击文件在新标签页打开 Diff）。
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    file: GitCommitFile;
  } | null>(null);

  /**
   * 面板贴着悬停行定位：纵向与行中心对齐（越界时夹紧在视口内），横向优先
   * 落在空间更大的一侧，箭头始终指向该行。位置直接写在 DOM 上（不触发重渲染）。
   */
  const positionTooltip = useCallback(() => {
    const node = tooltipRef.current;
    const anchor = tooltipAnchorRef.current;
    if (!node || !anchor) return;
    const margin = 12;
    const gap = 10;
    const rect = node.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    const maxTop = Math.max(vh - rect.height - margin, margin);
    const top = Math.min(
      Math.max(anchorCenterY - rect.height / 2, margin),
      maxTop,
    );

    // data-side 表示箭头所在的面板边缘：left 即面板贴在行的右侧。
    let arrowSide: "left" | "right" = "left";
    let left = anchorRect.right + gap;
    if (
      left + rect.width > vw - margin &&
      anchorRect.left - rect.width - gap >= margin
    ) {
      left = anchorRect.left - rect.width - gap;
      arrowSide = "right";
    }
    left = Math.max(margin, Math.min(left, vw - rect.width - margin));

    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.dataset.side = arrowSide;
    // 箭头对准行中心，同时保证完整落在面板边缘内。
    const arrowTop = Math.min(
      Math.max(anchorCenterY - top, 14),
      Math.max(rect.height - 14, 14),
    );
    node.style.setProperty("--tooltip-arrow-top", `${arrowTop}px`);
  }, []);

  // 面板可交互（提交说明可能带滚动条），所以指针离开提交行后延迟隐藏，
  // 留出移动到面板的间隙；指针进入面板即取消隐藏。
  const tooltipHideTimerRef = useRef<number | null>(null);

  const cancelHideTooltip = useCallback(() => {
    if (tooltipHideTimerRef.current !== null) {
      window.clearTimeout(tooltipHideTimerRef.current);
      tooltipHideTimerRef.current = null;
    }
  }, []);

  const showTooltip = useCallback(
    (commit: GitLogEntry, anchor: HTMLElement) => {
      cancelHideTooltip();
      tooltipAnchorRef.current = anchor;
      // Skip the re-render when hovering within the same commit.
      setHoveredCommit((prev) => (prev === commit ? prev : commit));
    },
    [cancelHideTooltip],
  );

  const hideTooltip = useCallback(() => {
    cancelHideTooltip();
    setHoveredCommit(null);
  }, [cancelHideTooltip]);

  const scheduleHideTooltip = useCallback(() => {
    cancelHideTooltip();
    tooltipHideTimerRef.current = window.setTimeout(() => {
      tooltipHideTimerRef.current = null;
      setHoveredCommit(null);
    }, 240);
  }, [cancelHideTooltip]);

  useEffect(() => cancelHideTooltip, [cancelHideTooltip]);

  // 首次定位在布局阶段完成（绘制前就位，不会闪到默认位置）。
  useLayoutEffect(() => {
    if (!hoveredCommit) return;
    positionTooltip();
  }, [hoveredCommit, positionTooltip]);

  // 面板打开期间跟随行的滚动 / 窗口尺寸变化重新定位。
  useEffect(() => {
    if (!hoveredCommit) return;
    const reposition = () => positionTooltip();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [hoveredCommit, positionTooltip]);

  /** 分支徽章专属菜单：复制分支名 / 复制工作树路径 / 切换分支。 */
  const buildBranchMenuItems = (ref: ParsedRef): ContextMenuItem[] => {
    const branchInfo = branchMap.get(ref.name);
    const isCurrent = ref.isHead || branchInfo?.isCurrent;
    const worktreePath = branchInfo?.worktreePath;
    const isOtherWorktree = isOtherWorktreePath(worktreePath);
    const worktreeFolder = worktreePath
      ? getWorktreeFolderName(worktreePath)
      : null;

    const items: ContextMenuItem[] = [
      {
        id: "copy-branch-name",
        label: t("git.copyBranchName", { defaultValue: "Copy Branch Name" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchContextMenu(null);
          void window.snow.writeClipboardText(ref.name).catch(() => {});
        },
      },
    ];

    if (worktreePath) {
      items.push({
        id: "copy-worktree-path",
        label: t("git.copyWorktreePath", {
          defaultValue: "Copy Worktree Path",
        }),
        icon: <FolderGit2 size={13} strokeWidth={1.8} />,
        onClick: () => {
          setBranchContextMenu(null);
          void window.snow.writeClipboardText(worktreePath).catch(() => {});
        },
      });
      if (worktreeFolder) {
        items.push({
          id: "copy-worktree-name",
          label: t("git.copyWorktreeName", {
            defaultValue: "Copy Worktree Name",
          }),
          icon: <FileText size={13} strokeWidth={1.8} />,
          onClick: () => {
            setBranchContextMenu(null);
            void window.snow.writeClipboardText(worktreeFolder).catch(() => {});
          },
        });
      }
    }

    if (ref.kind === "local" && ref.name !== "HEAD") {
      items.push({
        id: "checkout-branch",
        separator: true,
        label: isCurrent
          ? t("git.currentBranch", { defaultValue: "Current Branch" })
          : isOtherWorktree
            ? `${t("git.worktreeCheckedOut", { defaultValue: "Checked out in Worktree" })}: ${worktreeFolder}`
            : t("git.checkoutBranch", { defaultValue: "Checkout Branch" }),
        icon: isOtherWorktree ? (
          <FolderGit2 size={13} strokeWidth={1.8} />
        ) : (
          <GitBranch size={13} strokeWidth={1.8} />
        ),
        disabled:
          isCurrent ||
          isOtherWorktree ||
          management.busy ||
          management.sessionRunning,
        onClick: () => {
          setBranchContextMenu(null);
          if (isCurrent || isOtherWorktree) return;
          management.checkout({
            name: ref.name,
            isCurrent: Boolean(isCurrent),
            isRemote: false,
            remoteName: null,
            worktreePath,
          });
        },
      });
    }

    if (
      (ref.kind === "local" || ref.kind === "remote") &&
      ref.name !== "HEAD"
    ) {
      items.push(
        ...management.menuItems(
          {
            name: ref.name,
            isCurrent: Boolean(isCurrent),
            isRemote: ref.kind === "remote",
            remoteName: branchInfo?.remoteName ?? null,
            worktreePath,
          },
          () => setBranchContextMenu(null),
        ),
      );
    }
    return items;
  };

  /** 提交行右键菜单：复制哈希 / 提交信息，以及展开收起提交详情。 */
  const buildCommitMenuItems = (commit: GitLogEntry): ContextMenuItem[] => {
    const isExpanded = selectedHash === commit.hash;
    const commitRefs = parseRefs(commit.refs);
    const localBranchRefs = commitRefs.filter(
      (r) => r.kind === "local" && r.name !== "HEAD",
    );

    const items: ContextMenuItem[] = [];

    // Open the same branch menu instead of expanding several long menus at once.
    for (const bRef of localBranchRefs.slice(0, 3)) {
      items.push({
        id: `manage-branch:${bRef.name}`,
        label: `${t("git.manageActions")}: ${bRef.name}`,
        icon: <GitBranch size={13} />,
        onClick: () => {
          const position = contextMenu;
          setContextMenu(null);
          if (position)
            setBranchContextMenu({ x: position.x, y: position.y, ref: bRef });
        },
      });
    }

    if (items.length > 0) {
      items[items.length - 1].separator = true;
    }

    items.push(
      {
        id: "copy-full-hash",
        label: t("git.copyFullHash", { defaultValue: "Copy Full Hash" }),
        icon: <Hash size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.hash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-short-hash",
        label: t("git.copyShortHash", { defaultValue: "Copy Short Hash" }),
        icon: <Copy size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          void window.snow.writeClipboardText(commit.shortHash).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "copy-message",
        separator: true,
        label: t("git.copyCommitMessage", {
          defaultValue: "Copy Commit Message",
        }),
        icon: <MessageSquareText size={13} strokeWidth={1.8} />,
        onClick: () => {
          setContextMenu(null);
          const fullMessage = commit.body
            ? `${commit.message}\n\n${commit.body}`
            : commit.message;
          void window.snow.writeClipboardText(fullMessage).catch(() => {
            // 剪贴板写入失败时静默忽略。
          });
        },
      },
      {
        id: "toggle-detail",
        separator: true,
        label: isExpanded
          ? t("git.hideCommitDetails", {
              defaultValue: "Hide Commit Details",
            })
          : t("git.viewCommitDetails", {
              defaultValue: "View Commit Details",
            }),
        icon: isExpanded ? (
          <EyeOff size={13} strokeWidth={1.8} />
        ) : (
          <Eye size={13} strokeWidth={1.8} />
        ),
        onClick: () => {
          setContextMenu(null);
          handleRowClick(commit.hash);
        },
      },
    );

    return items;
  };

  /** 提交内文件右键菜单：复制文件路径。 */
  const buildCommitFileMenuItems = (file: GitCommitFile) => [
    {
      id: "copy-path",
      label: t("git.copyPath", { defaultValue: "Copy Path" }),
      icon: <FileText size={13} strokeWidth={1.8} />,
      onClick: () => {
        setFileContextMenu(null);
        void window.snow.writeClipboardText(file.path).catch(() => {
          // 剪贴板写入失败时静默忽略。
        });
      },
    },
  ];

  /** 在新标签页打开提交内文件 Diff：先以加载态打开标签，再异步填充结果。 */
  const openCommitFileDiffInTab = async (
    file: GitCommitFile,
    hash: string,
    parentHash: string | null,
  ): Promise<void> => {
    if (!repoPath || !onOpenInTab) {
      return;
    }
    const fileStatus = toGitFileStatus(file);
    onOpenInTab(fileStatus, null, true);
    try {
      if (isImageFile(file.path)) {
        // 图片文件：加载该提交版本与父提交版本直接渲染图片，
        // 请求文本 diff 会因二进制 --text 重试产生巨大乱码而卡死。
        const [newContent, oldContent] = await Promise.all([
          window.snow.gitFileContent(repoPath, file.path, hash),
          parentHash
            ? window.snow.gitFileContent(repoPath, file.path, parentHash)
            : Promise.resolve(null),
        ]);
        onOpenInTab(fileStatus, null, false, {
          old: oldContent,
          new: newContent,
        });
        return;
      }
      const result = await window.snow.gitCommitFileDiff(
        repoPath,
        hash,
        file.path,
      );
      onOpenInTab(fileStatus, result, false);
    } catch {
      onOpenInTab(fileStatus, null, false);
    }
  };

  /** Renders one ref badge (local / remote / tag) with its original meaning. */
  const renderRefBadge = (ref: ParsedRef, worktree?: GitWorktreeInfo) => {
    const branchInfo = branchMap.get(ref.name);
    const worktreePath = worktree?.worktreePath ?? branchInfo?.worktreePath;
    const isOtherWorktree = isOtherWorktreePath(worktreePath);
    const worktreeFolder = worktreePath
      ? getWorktreeFolderName(worktreePath)
      : null;

    let title =
      ref.kind === "remote"
        ? t("git.graphRemoteBranch", { defaultValue: "Remote branch" })
        : ref.kind === "tag"
          ? t("git.graphTag", { defaultValue: "Tag" })
          : ref.name === "HEAD"
            ? t("git.graphDetachedHead", { defaultValue: "Detached HEAD" })
            : ref.isHead
              ? t("git.graphCurrentBranch", { defaultValue: "Current branch" })
              : t("git.graphLocalBranch", { defaultValue: "Local branch" });

    if (worktree) {
      title += `\n${t("git.graphWorktreeTooltip", {
        values: {
          path: worktree.worktreePath,
          state: worktree.isDirty
            ? t("git.worktreeDirty")
            : t("git.graphWorktreeClean"),
          validity: worktree.isValid
            ? ""
            : ` · ${t("git.graphWorktreeInvalid")}`,
        },
      })}`;
    } else if (isOtherWorktree && worktreePath) {
      title += `\n${t("git.worktreeCheckedOut")}: ${worktreePath}`;
    }

    const icon =
      ref.kind === "remote" ? (
        <Cloud size={10} strokeWidth={2} />
      ) : ref.kind === "tag" ? (
        <Tag size={10} strokeWidth={2} />
      ) : ref.name === "HEAD" ? (
        <GitCommitHorizontal size={10} strokeWidth={2} />
      ) : ref.isHead ? (
        <CircleDot size={10} strokeWidth={2} />
      ) : isOtherWorktree ? (
        <FolderGit2 size={10} strokeWidth={2} />
      ) : (
        <GitBranch size={10} strokeWidth={2} />
      );

    const worktreeColor = worktree ? getWorktreeColor(worktree) : undefined;
    const displayText =
      isOtherWorktree && worktreeFolder
        ? `${ref.name} (${worktreeFolder})`
        : ref.name;

    return (
      <span
        key={`${ref.kind}/${ref.name}/${worktree?.worktreeId ?? ""}`}
        className={`git-graph-ref ${ref.kind}${isOtherWorktree ? " worktree" : ""}`}
        title={title}
        style={
          worktreeColor
            ? { color: worktreeColor, borderColor: worktreeColor }
            : undefined
        }
        onClick={(e) => {
          e.stopPropagation();
          hideTooltip();
          setContextMenu(null);
          setFileContextMenu(null);
          setBranchContextMenu({
            x: e.clientX,
            y: e.clientY,
            ref,
          });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          hideTooltip();
          setContextMenu(null);
          setFileContextMenu(null);
          setBranchContextMenu({
            x: e.clientX,
            y: e.clientY,
            ref,
          });
        }}
      >
        {worktreeColor && (
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: worktreeColor,
              flex: "0 0 auto",
            }}
          />
        )}
        {icon}
        {displayText}
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="git-graph" ref={containerRef}>
        <div className="git-graph-loading">{t("git.graphLoading")}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-graph">
        <div className="git-graph-error">{t("git.graphError")}</div>
      </div>
    );
  }

  if (commits.length === 0) {
    return (
      <div className="git-graph">
        <div className="git-graph-empty">{t("git.graphNoCommits")}</div>
      </div>
    );
  }

  return (
    <div className="git-graph" ref={containerRef}>
      {actionError && (
        <div
          className="git-graph-action-error"
          onClick={() => setActionError(null)}
          title={actionError}
        >
          <span>{actionError}</span>
        </div>
      )}
      {graphWorktrees.length > 0 && (
        <div
          role="group"
          aria-label={t("git.graphWorktreeLegend")}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 10px",
            padding: "4px 8px 8px",
          }}
        >
          <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>
            {t("git.graphWorktreeLegend")}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 2,
                backgroundColor: getWorktreeColor(graphWorktrees[0]),
              }}
            />
            {t("git.graphWorktreePathLegend")}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 2,
                background: `linear-gradient(90deg, ${LANE_COLORS.slice(0, 3).join(", ")})`,
              }}
            />
            {t("git.graphSharedAncestryLegend")}
          </span>
          {graphWorktrees.map((worktree) => {
            const color = getWorktreeColor(worktree);
            return (
              <span
                key={worktree.worktreeId}
                title={`${t("git.graphWorktreeTooltip", {
                  values: {
                    path: worktree.worktreePath,
                    state: worktree.isDirty
                      ? t("git.worktreeDirty")
                      : t("git.graphWorktreeClean"),
                    validity: worktree.isValid
                      ? ""
                      : ` · ${t("git.graphWorktreeInvalid")}`,
                  },
                })}${
                  matchedWorktreeIds.has(worktree.worktreeId)
                    ? ""
                    : `\n${t("git.graphWorktreeNotLoaded")}`
                }`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  color,
                  fontSize: 10,
                  opacity: worktree.isValid ? 1 : 0.7,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    backgroundColor: color,
                    outline: worktree.isValid
                      ? undefined
                      : "1px dashed var(--text-danger)",
                  }}
                />
                {worktree.branchName ??
                  `${t("git.graphDetachedHead")} ${worktree.headOid.slice(0, 7)}`}
                {!worktree.isValid && (
                  <span style={{ color: "var(--text-danger)" }}>
                    ({t("git.graphWorktreeInvalid")})
                  </span>
                )}
                {!matchedWorktreeIds.has(worktree.worktreeId) && (
                  <span style={{ color: "var(--text-secondary)" }}>
                    ({t("git.graphWorktreeNotLoaded")})
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}
      {rows.map((row) => {
        const dotColor = LANE_COLORS[row.dotLane % LANE_COLORS.length];
        const isSelected = selectedHash === row.commit.hash;
        // Current HEAD's halo and worktree markers are distinct from topology lane colors.
        const parsedRefs = parseRefs(row.commit.refs);
        const isHead = parsedRefs.some((ref) => ref.isHead);
        const commitWorktrees = getCommitWorktrees(
          row.commit,
          parsedRefs,
          worktrees,
        );
        const localRefWorktree = (ref: ParsedRef) =>
          ref.kind === "local" && ref.name !== "HEAD"
            ? commitWorktrees.find(
                (worktree) => worktree.branchName === ref.name,
              )
            : undefined;
        // At a branch point (curve leaving the dot), the curve leads into
        // the target lane and only reaches it at the bottom of the row.
        // If that lane had no line coming from above, drawing its vertical
        // bottom line from the dot height would make the new branch appear
        // to extend one extra segment before the curve actually joins it.
        // Skip such lines — the next row's top line continues them.
        const curveTargets = new Set(row.curves.map((c) => c.to));
        const bottomLines = row.bottomLines.filter(
          (lane) => !(curveTargets.has(lane) && !row.topLines.includes(lane)),
        );
        return (
          <div key={row.commit.hash}>
            <div
              className={`git-graph-row${isSelected ? " selected" : ""}`}
              onClick={() => handleRowClick(row.commit.hash)}
              onContextMenu={(event) => {
                event.preventDefault();
                hideTooltip();
                setBranchContextMenu(null);
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  commit: row.commit,
                });
              }}
              onMouseEnter={(event) =>
                showTooltip(row.commit, event.currentTarget)
              }
              onMouseLeave={scheduleHideTooltip}
              draggable
              onDragStart={(event) => {
                hideTooltip();
                handleRowDragStart(event, row.commit);
              }}
            >
              <svg
                className="git-graph-svg"
                width={graphWidth}
                height={ROW_HEIGHT}
              >
                {row.topLines.map((lane) => (
                  <line
                    key={`top-${lane}`}
                    x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y1={-LINE_WIDTH / 2}
                    x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y2={ROW_HEIGHT / 2}
                    stroke={row.topColors[lane]}
                    strokeWidth={LINE_WIDTH}
                  />
                ))}
                {bottomLines.map((lane) => (
                  <line
                    key={`bottom-${lane}`}
                    x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y1={ROW_HEIGHT / 2}
                    x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                    y2={ROW_HEIGHT + LINE_WIDTH / 2}
                    stroke={row.bottomColors[lane]}
                    strokeWidth={LINE_WIDTH}
                  />
                ))}
                {row.curves.map((c, i) => {
                  const fromX = c.from * LANE_WIDTH + LANE_WIDTH / 2;
                  const toX = c.to * LANE_WIDTH + LANE_WIDTH / 2;
                  const dir = toX > fromX ? 1 : -1;
                  return (
                    <path
                      key={`curve-${i}`}
                      d={`M ${fromX},${ROW_HEIGHT / 2} C ${
                        fromX + dir * (LANE_WIDTH / 2)
                      },${ROW_HEIGHT / 2} ${toX},${ROW_HEIGHT * 0.75} ${toX},${
                        ROW_HEIGHT + LINE_WIDTH / 2
                      }`}
                      fill="none"
                      stroke={c.color}
                      strokeWidth={LINE_WIDTH}
                    />
                  );
                })}
                {row.merges.map((m, i) => {
                  const fromX = m.from * LANE_WIDTH + LANE_WIDTH / 2;
                  const dotX = row.dotLane * LANE_WIDTH + LANE_WIDTH / 2;
                  const dir = fromX > dotX ? 1 : -1;
                  return (
                    <path
                      key={`merge-${i}`}
                      d={`M ${fromX},${-LINE_WIDTH / 2} C ${fromX},${
                        ROW_HEIGHT * 0.25
                      } ${dotX + dir * (LANE_WIDTH * 0.6)},${
                        ROW_HEIGHT * 0.41
                      } ${dotX},${ROW_HEIGHT / 2}`}
                      fill="none"
                      stroke={m.color}
                      strokeWidth={LINE_WIDTH}
                    />
                  );
                })}
                {isHead && (
                  <circle
                    cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
                    cy={ROW_HEIGHT / 2}
                    r={DOT_RADIUS + 3}
                    fill="none"
                    stroke="var(--accent-blue-text)"
                    strokeWidth={1.5}
                  />
                )}
                {commitWorktrees.map((worktree, index) => (
                  <circle
                    key={`worktree-${worktree.worktreeId}`}
                    cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
                    cy={ROW_HEIGHT / 2}
                    r={DOT_RADIUS + 5 + index * 3}
                    fill="none"
                    stroke={getWorktreeColor(worktree)}
                    strokeWidth={2}
                  />
                ))}
                <circle
                  cx={row.dotLane * LANE_WIDTH + LANE_WIDTH / 2}
                  cy={ROW_HEIGHT / 2}
                  r={DOT_RADIUS}
                  fill={row.commit.pushed ? dotColor : "var(--bg-primary)"}
                  stroke={row.commit.pushed ? "var(--bg-primary)" : dotColor}
                  strokeWidth={2}
                />
              </svg>
              <div className="git-graph-info">
                <span className="git-graph-message">{row.commit.message}</span>
                {(parsedRefs.length > 0 ||
                  commitWorktrees.some((worktree) => worktree.isDetached)) && (
                  <span className="git-graph-refs">
                    {parsedRefs.map((ref) =>
                      renderRefBadge(ref, localRefWorktree(ref)),
                    )}
                    {commitWorktrees
                      .filter((worktree) => worktree.isDetached)
                      .map((worktree) => {
                        const color = getWorktreeColor(worktree);
                        return (
                          <span
                            key={`detached-${worktree.worktreeId}`}
                            className="git-graph-ref local"
                            style={{ color, borderColor: color }}
                            title={`${t("git.graphDetachedHead")}\n${t(
                              "git.graphWorktreeTooltip",
                              {
                                values: {
                                  path: worktree.worktreePath,
                                  state: worktree.isDirty
                                    ? t("git.worktreeDirty")
                                    : t("git.graphWorktreeClean"),
                                  validity: worktree.isValid
                                    ? ""
                                    : ` · ${t("git.graphWorktreeInvalid")}`,
                                },
                              },
                            )}`}
                          >
                            <GitCommitHorizontal size={10} strokeWidth={2} />
                            {t("git.graphDetachedHead")}
                          </span>
                        );
                      })}
                  </span>
                )}
                <span className="git-graph-meta">
                  <span className="git-graph-author">{row.commit.author}</span>
                  <span className="git-graph-date">
                    {formatDate(row.commit.date)}
                  </span>
                </span>
              </div>
            </div>
            {isSelected && (
              <div
                className="git-graph-detail"
                style={{ paddingLeft: graphWidth + 20 }}
              >
                {/* Extend the lanes that continue below this row through the
                    expanded detail area so the graph columns stay visually
                    continuous instead of being cut off by the detail panel. */}
                <svg
                  className="git-graph-detail-lines"
                  width={graphWidth}
                  height="100%"
                >
                  {row.bottomLines.map((lane) => (
                    <line
                      key={`detail-${lane}`}
                      x1={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      y1="0%"
                      x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      y2="100%"
                      stroke={row.bottomColors[lane]}
                      strokeWidth={LINE_WIDTH}
                    />
                  ))}
                </svg>
                {row.commit.body && (
                  <div className="git-graph-detail-message-body">
                    {row.commit.body}
                  </div>
                )}
                {commitFiles.length > 0 ? (
                  <div className="git-graph-detail-files">
                    {commitFiles.map((file, i) => {
                      const isViewed =
                        viewedCommitFile?.hash === row.commit.hash &&
                        viewedCommitFile.path === file.path;
                      return (
                        <div
                          key={i}
                          className={`git-graph-detail-file${
                            isViewed ? " active" : ""
                          }`}
                          onClick={() =>
                            setViewedCommitFile({
                              hash: row.commit.hash,
                              path: file.path,
                            })
                          }
                          onDoubleClick={() => {
                            setViewedCommitFile({
                              hash: row.commit.hash,
                              path: file.path,
                            });
                            void openCommitFileDiffInTab(
                              file,
                              row.commit.hash,
                              row.commit.parents[0] ?? null,
                            );
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            hideTooltip();
                            setFileContextMenu({
                              x: event.clientX,
                              y: event.clientY,
                              file,
                            });
                          }}
                          title={t("git.viewCommitFileDiff", {
                            defaultValue: "View File Diff in This Commit",
                          })}
                        >
                          <span
                            className={`git-file-status ${getCommitFileColor(
                              file.status,
                            )}`}
                          >
                            {getCommitFileLabel(file.status)}
                          </span>
                          <span
                            className="git-graph-detail-path"
                            title={file.path}
                          >
                            {file.path}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : isLoadingFiles ? (
                  <span className="git-graph-detail-loading">
                    {t("git.graphLoading")}
                  </span>
                ) : (
                  <span className="git-graph-detail-empty">
                    {t("git.graphNoCommits")}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {/* Sentinel is always rendered so the ref can bind; visibility is
          controlled by hasMore to avoid an invisible 1px div at the end. */}
      <div
        ref={sentinelRef}
        className="git-graph-sentinel"
        style={{ display: hasMore ? "block" : "none" }}
      />
      {createPortal(
        hoveredCommit ? (
          <div
            className="git-graph-tooltip"
            ref={tooltipRef}
            onMouseEnter={cancelHideTooltip}
            onMouseLeave={scheduleHideTooltip}
          >
            <span className="git-graph-tooltip-arrow" aria-hidden="true" />
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipHash")}
              </span>
              <span className="git-graph-tooltip-value git-graph-tooltip-mono">
                {hoveredCommit.hash}
              </span>
            </div>
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipAuthor")}
              </span>
              <span className="git-graph-tooltip-value">
                {hoveredCommit.author}
                {hoveredCommit.email ? ` <${hoveredCommit.email}>` : ""}
              </span>
            </div>
            <div className="git-graph-tooltip-row">
              <span className="git-graph-tooltip-label">
                {t("git.graphTooltipDate")}
              </span>
              <span className="git-graph-tooltip-value">
                {hoveredCommit.date}
              </span>
            </div>
            {(hoveredCommit.additions > 0 || hoveredCommit.deletions > 0) && (
              <div className="git-graph-tooltip-row">
                <span className="git-graph-tooltip-label">
                  {t("git.graphTooltipStats")}
                </span>
                <span className="git-graph-tooltip-value">
                  <span className="git-graph-stats">
                    {hoveredCommit.additions > 0 && (
                      <span className="git-graph-stats-add">
                        +{hoveredCommit.additions}
                      </span>
                    )}
                    {hoveredCommit.deletions > 0 && (
                      <span className="git-graph-stats-del">
                        -{hoveredCommit.deletions}
                      </span>
                    )}
                  </span>
                </span>
              </div>
            )}
            {hoveredCommit.refs && (
              <div className="git-graph-tooltip-row">
                <span className="git-graph-tooltip-label">
                  {t("git.graphTooltipRefs")}
                </span>
                <span className="git-graph-tooltip-value">
                  {parseRefs(hoveredCommit.refs)
                    .map((ref) => ref.name)
                    .join(", ")}
                </span>
              </div>
            )}
            {getCommitWorktrees(
              hoveredCommit,
              parseRefs(hoveredCommit.refs),
              worktrees,
            ).map((worktree) => (
              <div
                className="git-graph-tooltip-row"
                key={`tooltip-worktree-${worktree.worktreeId}`}
              >
                <span className="git-graph-tooltip-label">
                  {worktree.branchName ?? t("git.graphDetachedHead")}
                </span>
                <span className="git-graph-tooltip-value">
                  {t("git.graphWorktreeTooltip", {
                    values: {
                      path: worktree.worktreePath,
                      state: worktree.isDirty
                        ? t("git.worktreeDirty")
                        : t("git.graphWorktreeClean"),
                      validity: worktree.isValid
                        ? ""
                        : ` · ${t("git.graphWorktreeInvalid")}`,
                    },
                  })}
                </span>
              </div>
            ))}
            {hoveredCommit.parents.length > 0 && (
              <div className="git-graph-tooltip-row">
                <span className="git-graph-tooltip-label">
                  {t("git.graphTooltipParents")}
                </span>
                <span className="git-graph-tooltip-value git-graph-tooltip-mono">
                  {hoveredCommit.parents.join(", ")}
                </span>
              </div>
            )}
            <div className="git-graph-tooltip-divider" />
            <div className="git-graph-tooltip-message-section">
              <div className="git-graph-tooltip-subject">
                {hoveredCommit.message}
              </div>
              {hoveredCommit.body && (
                <div className="git-graph-tooltip-body">
                  {hoveredCommit.body}
                </div>
              )}
            </div>
          </div>
        ) : null,
        document.body,
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildCommitMenuItems(contextMenu.commit)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {fileContextMenu && (
        <ContextMenu
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          items={buildCommitFileMenuItems(fileContextMenu.file)}
          onClose={() => setFileContextMenu(null)}
        />
      )}
      {management.dialog}
      {branchContextMenu && (
        <ContextMenu
          x={branchContextMenu.x}
          y={branchContextMenu.y}
          items={buildBranchMenuItems(branchContextMenu.ref)}
          onClose={() => setBranchContextMenu(null)}
        />
      )}
    </div>
  );
};
