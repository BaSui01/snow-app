import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useI18n } from "../../i18n";
import { getFileTypeIcon } from "../../utils/fileIcons";
import { localizeSshError } from "../../utils/sshErrorMessages";
import type {
  DirectoryEntry,
  FileSearchResult,
  SshConnectionStatus,
} from "../../../preload";
import { ExplorerEntryContextMenu } from "../sidebar/ExplorerEntryContextMenu";
// 快速编辑弹窗按需加载（与右侧面板的 FileViewerContent 共用 chunk），
// 避免把 highlight.js 等编辑器依赖打包进主包。
const FileEditModal = lazy(() =>
  import("../sidebar/FileEditModal").then((m) => ({
    default: m.FileEditModal,
  })),
);
import type { FileTag } from "../mainContent/chatInput/fileTagUtils";
import { INSERT_FILE_TAGS_EVENT } from "../mainContent/chatInput/fileTagUtils";
import { buildSshConnectParams } from "../sidebar/personalization/roleFileUtils";
import { explorerPlacementStore } from "../common/explorerPlacementStore";
import { rightPanelEvents } from "./rightPanelEvents";
import { SshTransfersPanel } from "./SshTransfersPanel";

type ProjectExplorerContentProps = {
  /** 绑定的工作区目录 id；切换项目时由宿主面板更新，驱动列表重新加载。 */
  directoryId: string | null;
  onOpenFile?: (
    filePath: string,
    fileName: string,
    isSsh: boolean,
    sshSessionId: string | null,
    focusLine: number | undefined,
    sshWorkspaceRoot: string | undefined,
    sshWorkspaceId: string | undefined,
  ) => void;
  /** 在指定路径打开终端（本地路径或 ssh:// 路径）。 */
  onOpenTerminal?: (cwd?: string) => void;
  /** 内嵌侧栏时的返回入口；右侧面板 tab 不传（tab 自带关闭按钮）。 */
  onBack?: () => void;
};

type TreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  children?: TreeNode[];
  loaded?: boolean;
  loading?: boolean;
  stale?: boolean;
  error?: string;
};

type FlatNode = {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
};

type ExplorerEntryContextMenuState = {
  name: string;
  path: string;
  isDirectory: boolean;
  position: { x: number; y: number };
  /** 当前选中条目数；>1 时右键菜单切换为批量操作模式。 */
  selectedCount: number;
};

const flattenTree = (
  nodes: TreeNode[],
  expandedPaths: Set<string>,
  depth = 0,
): FlatNode[] => {
  const result: FlatNode[] = [];

  for (const node of nodes) {
    const isExpanded = expandedPaths.has(node.path);
    result.push({
      node,
      depth,
      hasChildren: node.isDirectory,
      isExpanded,
    });

    if (isExpanded && node.children) {
      result.push(...flattenTree(node.children, expandedPaths, depth + 1));
    }
  }

  return result;
};

// 行高需与 styles.css 中 .explorer-tree-row 的 height 保持一致；
// 目录行以「层级 × 行高」作为吸顶偏移，行高必须固定。
const EXPLORER_ROW_HEIGHT = 24;

const removeNodeByPath = (nodes: TreeNode[], targetPath: string): TreeNode[] =>
  nodes
    .filter((node) => node.path !== targetPath)
    .map((node) =>
      node.children
        ? { ...node, children: removeNodeByPath(node.children, targetPath) }
        : node,
    );

const replacePathPrefix = (
  nodes: TreeNode[],
  oldPrefix: string,
  newPrefix: string,
): TreeNode[] =>
  nodes.map((node) => {
    const updated: TreeNode = {
      ...node,
      path: newPrefix + node.path.substring(oldPrefix.length),
    };
    if (node.children) {
      updated.children = replacePathPrefix(node.children, oldPrefix, newPrefix);
    }
    return updated;
  });

const renameNodeByPath = (
  nodes: TreeNode[],
  oldPath: string,
  newPath: string,
  newName: string,
): TreeNode[] =>
  nodes.map((node) => {
    if (node.path === oldPath) {
      const updated: TreeNode = { ...node, name: newName, path: newPath };
      if (node.children) {
        updated.children = replacePathPrefix(node.children, oldPath, newPath);
      }
      return updated;
    }
    if (node.children) {
      return {
        ...node,
        children: renameNodeByPath(node.children, oldPath, newPath, newName),
      };
    }
    return node;
  });

const getFileIcon = (
  node: TreeNode,
  isExpanded: boolean,
): React.JSX.Element => {
  return getFileTypeIcon(node.name, node.isDirectory, isExpanded, {
    className: "tree-icon",
    size: 14,
  });
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const toTreeNodes = (entries: DirectoryEntry[]): TreeNode[] =>
  entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    isDirectory: entry.isDirectory,
    size: entry.size,
    loaded: !entry.isDirectory,
    loading: false,
  }));

// A refresh only replaces the directory listing. Loaded descendants remain
// attached so a reconnect can restore every visible branch without flicker.
const mergeTreeNodes = (
  freshNodes: TreeNode[],
  previousNodes: TreeNode[],
): TreeNode[] =>
  freshNodes.map((node) => {
    const previous = previousNodes.find((item) => item.path === node.path);
    return previous?.children
      ? {
          ...node,
          children: previous.children,
          loaded: previous.loaded,
          stale: previous.stale,
          error: previous.error,
        }
      : node;
  });

// 仅外部（系统）文件拖入参与上传：内部拖动（树条目 / 搜索结果）携带
// application/json，必须完全不拦截，保护现有拖出 / 拖到聊天输入框 / 终端行为。
const isExternalFileDrag = (event: React.DragEvent): boolean => {
  const types = Array.from(event.dataTransfer.types);
  return types.includes("Files") && !types.includes("application/json");
};

// 在树中按路径查找节点（任意深度）；不存在返回 null。
const findTreeNode = (
  nodes: TreeNode[],
  targetPath: string,
): TreeNode | null => {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }
    if (node.children) {
      const found = findTreeNode(node.children, targetPath);
      if (found) {
        return found;
      }
    }
  }
  return null;
};

// 目录内容失效：清空 children 并复位加载标记，使下一次 loadChildren 真正
// 重新读取 SFTP，而不是经 mergeTreeNodes 复用旧缓存。
const invalidateTreeNode = (
  nodes: TreeNode[],
  targetPath: string,
): TreeNode[] =>
  nodes.map((node) => {
    if (node.path === targetPath) {
      return {
        ...node,
        children: undefined,
        loaded: false,
        loading: false,
        error: undefined,
      };
    }
    if (node.children) {
      return {
        ...node,
        children: invalidateTreeNode(node.children, targetPath),
      };
    }
    return node;
  });

export function ProjectExplorerContent({
  directoryId,
  onOpenFile,
  onOpenTerminal,
  onBack,
}: ProjectExplorerContentProps): React.JSX.Element {
  const { t } = useI18n();
  const [placement, setPlacement] = useState(() =>
    explorerPlacementStore.get(),
  );

  useEffect(() => explorerPlacementStore.subscribe(setPlacement), []);

  // 记录当前展示的目录：切换显示位置时两侧保持同一个项目。
  useEffect(() => {
    explorerPlacementStore.rememberDirectoryId(directoryId ?? "");
  }, [directoryId]);

  /** 本地化错误文案；SSH 错误映射为 i18n 主文案，原始原因拼入括号。 */
  const toExplorerErrorMessage = useCallback(
    (err: unknown): string => {
      const localized = localizeSshError(err, t);
      return localized.detail
        ? `${localized.message} (${localized.detail})`
        : localized.message;
    },
    [t],
  );

  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootName, setRootName] = useState("");
  const [isSsh, setIsSsh] = useState(false);
  const sshProfileIdRef = useRef<string | null>(null);
  const sshGenerationRef = useRef(0);
  const [sshConnectionStatus, setSshConnectionStatus] =
    useState<SshConnectionStatus | null>(null);
  // SSH 工作区根目录的远端路径（ssh:// URL 解析结果）：拖入上传目标与
  // 上传完成后的目录刷新比对都基于它。
  const [rootRemotePath, setRootRemotePath] = useState<string | null>(null);
  // 上传文件选择框 / 传输批次创建进行中：短暂禁用按钮，防止连点产生重复批次。
  const [isStartingUpload, setIsStartingUpload] = useState(false);
  // 外部文件拖入高亮：树容器（工作区根目录）与目录行分别记录。
  const [isTreeDropTarget, setIsTreeDropTarget] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 多选集合：path -> 选中。支持 ctrl/cmd 点选切换、shift 范围选择。
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  // shift 范围选择锚点：最近一次普通/ctrl 点击（或右键）的路径。
  const selectionAnchorRef = useRef<string | null>(null);
  // 双击检测时间戳：双击序列中的第二次单击跳过"打开文件"，交由
  // onDoubleClick 打开快速编辑弹窗，避免重复打开右侧文件 tab。
  const lastRowClickRef = useRef(0);
  // 双击文件时打开的快速编辑弹窗。
  const [editingEntry, setEditingEntry] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [entryContextMenu, setEntryContextMenu] =
    useState<ExplorerEntryContextMenuState | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const treeStateRef = useRef<TreeNode[]>([]);
  const rootPathRef = useRef<string | null>(null);
  const rootLoadRequestRef = useRef(0);
  const expandedPathsRef = useRef<Set<string>>(new Set());
  const loadChildrenRef = useRef<
    ((parentPath: string) => Promise<void>) | null
  >(null);
  // 已触发过目录刷新的上传任务：同一任务的成功事件只刷新一次。
  const refreshedUploadTasksRef = useRef<Set<string>>(new Set());

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  // 搜索结果行多选状态：path -> 选中的行号集合。
  // 支持跨文件累加，拖拽时按文件聚合为多个 FileTag。
  const [selectedLines, setSelectedLines] = useState<Map<string, Set<number>>>(
    new Map(),
  );
  // shift 范围选择锚点：上次点击（非 shift）的文件路径与行号。
  const lineSelectAnchorRef = useRef<{ path: string; line: number } | null>(
    null,
  );

  const loadRootDirectory = useCallback(async (): Promise<void> => {
    const request = rootLoadRequestRef.current + 1;
    rootLoadRequestRef.current = request;
    const isCurrentRequest = (): boolean =>
      rootLoadRequestRef.current === request;

    if (!directoryId) {
      setError(
        t("sidebar.explorerNoActiveDirectory", {
          defaultValue: "No active workspace directory",
        }),
      );
      setTree([]);
      setRootPath(null);
      setRootRemotePath(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const directories = await window.snow.listWorkspaceDirectories();
      if (!isCurrentRequest()) return;
      const targetDir = directories.find(
        (directory) => directory.directoryId === directoryId,
      );

      if (!targetDir) {
        setError(
          t("sidebar.explorerNoActiveDirectory", {
            defaultValue: "No active workspace directory",
          }),
        );
        setTree([]);
        setRootPath(null);
        setRootRemotePath(null);
        return;
      }

      const sameRoot = rootPathRef.current === targetDir.path;
      if (!sameRoot) {
        setTree([]);
        setExpandedPaths(new Set());
      }
      setRootPath(targetDir.path);
      rootPathRef.current = targetDir.path;
      setRootName(targetDir.name);

      const sshDir = targetDir.path.startsWith("ssh://");
      setIsSsh(sshDir);
      let entries: DirectoryEntry[];

      if (sshDir) {
        const parsed = await window.snow.sshParseUrl(targetDir.path);
        if (!isCurrentRequest()) return;
        // 记录根目录的裸远端路径：上传目标拼接与传输完成刷新都依赖它。
        setRootRemotePath(parsed.remotePath);
        let profile = sshProfileIdRef.current
          ? await window.snow.sshGetProfileConnection(sshProfileIdRef.current)
          : null;

        if (!sameRoot || !profile) {
          const params = await buildSshConnectParams(targetDir.path);
          if (!params) {
            throw new Error(
              "SSH credentials are unavailable for this workspace",
            );
          }
          const nextProfile = await window.snow.sshConnectProfile(params);
          if (!isCurrentRequest()) {
            window.snow
              .sshReleaseProfile(nextProfile.profileId)
              .catch(() => undefined);
            return;
          }
          const previousProfileId = sshProfileIdRef.current;
          sshProfileIdRef.current = nextProfile.profileId;
          sshGenerationRef.current = nextProfile.generation;
          setSshConnectionStatus(nextProfile.status);
          profile = nextProfile;
          if (previousProfileId) {
            void window.snow.sshReleaseProfile(previousProfileId);
          }
        }

        if (profile.generation > sshGenerationRef.current) {
          sshGenerationRef.current = profile.generation;
        }
        if (profile.status !== "connected") {
          throw new Error(profile.lastError ?? "SSH profile is reconnecting");
        }

        entries = await window.snow.sshListDirectory(
          profile.profileId,
          parsed.remotePath,
        );
      } else {
        if (sshProfileIdRef.current) {
          void window.snow.sshReleaseProfile(sshProfileIdRef.current);
          sshProfileIdRef.current = null;
        }
        setSshConnectionStatus(null);
        setRootRemotePath(null);
        entries = await window.snow.readDirectoryEntries(targetDir.path);
      }

      if (!isCurrentRequest()) return;
      const nodes = toTreeNodes(entries);
      setTree((previous) =>
        sameRoot ? mergeTreeNodes(nodes, previous) : nodes,
      );
      setIsStale(false);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setIsStale(true);
      setError(
        loadError instanceof Error
          ? toExplorerErrorMessage(loadError)
          : t("sidebar.explorerLoadError", {
              defaultValue: "Failed to load directory contents",
            }),
      );
    } finally {
      if (isCurrentRequest()) {
        setIsLoading(false);
      }
    }
  }, [directoryId, t]);

  useEffect(() => {
    void loadRootDirectory();
  }, [loadRootDirectory]);

  const handleToggle = useCallback(
    async (nodePath: string): Promise<void> => {
      const isCurrentlyExpanded = expandedPaths.has(nodePath);

      if (isCurrentlyExpanded) {
        setExpandedPaths((prev) => {
          const next = new Set(prev);
          next.delete(nodePath);
          return next;
        });
        return;
      }

      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(nodePath);
        return next;
      });

      const findAndUpdateNode = (
        nodes: TreeNode[],
        targetPath: string,
      ): TreeNode[] => {
        return nodes.map((node) => {
          if (node.path === targetPath) {
            if ((node.loaded && !node.error) || node.loading) {
              return node;
            }

            void loadChildrenRef.current?.(node.path);
            return { ...node, loading: true };
          }

          if (node.children) {
            return {
              ...node,
              children: findAndUpdateNode(node.children, targetPath),
            };
          }

          return node;
        });
      };

      setTree((prev) => findAndUpdateNode(prev, nodePath));
    },
    [expandedPaths],
  );

  const loadChildren = useCallback(
    async (parentPath: string): Promise<void> => {
      const requestGeneration = sshGenerationRef.current;
      try {
        let entries: DirectoryEntry[];
        if (isSsh) {
          if (!sshProfileIdRef.current) {
            throw new Error("SSH profile is not connected");
          }
          const sshEntries = await window.snow.sshListDirectory(
            sshProfileIdRef.current,
            parentPath,
          );
          entries = sshEntries;
        } else {
          entries = await window.snow.readDirectoryEntries(parentPath);
        }
        // A result from an earlier transport generation may be valid SFTP
        // data but belongs to an obsolete connection; never let it overwrite
        // data restored after reconnect.
        if (isSsh && requestGeneration !== sshGenerationRef.current) {
          return;
        }
        const childNodes = toTreeNodes(entries);

        setTree((prev) => {
          const updateNode = (nodes: TreeNode[]): TreeNode[] => {
            return nodes.map((node) => {
              if (node.path === parentPath) {
                return {
                  ...node,
                  children: mergeTreeNodes(childNodes, node.children ?? []),
                  loaded: true,
                  loading: false,
                  stale: false,
                  error: undefined,
                };
              }

              if (node.children) {
                return {
                  ...node,
                  children: updateNode(node.children),
                };
              }

              return node;
            });
          };

          return updateNode(prev);
        });
      } catch (loadError) {
        setTree((prev) => {
          const markError = (nodes: TreeNode[]): TreeNode[] => {
            return nodes.map((node) => {
              if (node.path === parentPath) {
                // Preserve the last successful children. A failed directory
                // listing must never be rendered as a successful empty one.
                return {
                  ...node,
                  loading: false,
                  stale: true,
                  error:
                    loadError instanceof Error
                      ? loadError.message
                      : "Failed to load directory",
                };
              }

              if (node.children) {
                return {
                  ...node,
                  children: markError(node.children),
                };
              }

              return node;
            });
          };

          return markError(prev);
        });
      }
    },
    [isSsh],
  );

  // Keep loadChildrenRef in sync so handleToggle always calls the latest
  // profile-aware loader.
  useEffect(() => {
    loadChildrenRef.current = loadChildren;
  }, [loadChildren]);

  const handleRefresh = useCallback((): void => {
    setExpandedPaths(new Set());
    // SSH 目录无文件监听：刷新时清空缓存树，否则旧子目录
    // 会经 mergeTreeNodes 被当作有效数据保留，重新展开不重新读取
    setTree([]);
    void loadRootDirectory();
  }, [loadRootDirectory]);

  // 切换显示位置：移到右侧面板时直接请求打开对应的资源管理器 tab；移回侧栏
  // 由 Sidebar 订阅该偏好后切到资源管理器视图。
  const handleTogglePlacement = useCallback((): void => {
    const next = placement === "sidebar" ? "right-panel" : "sidebar";
    explorerPlacementStore.set(next);
    if (next === "right-panel") {
      rightPanelEvents.emit("open-explorer", {
        directoryId: directoryId ?? "",
      });
    }
  }, [placement, directoryId]);

  // SSH 条目的路径是裸远程路径（如 /opt/app），终端只识别 ssh:// 形式；
  // 拼上工作区的 authority（ssh://user@host:port）后再交给 onOpenTerminal。
  const handleEntryOpenTerminal = useCallback(
    (cwd: string): void => {
      const authority = rootPath?.match(/^ssh:\/\/[^/]+/)?.[0];
      onOpenTerminal?.(isSsh && authority ? `${authority}${cwd}` : cwd);
    },
    [isSsh, rootPath, onOpenTerminal],
  );

  const handleEntryContextMenu = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      entry: { name: string; path: string; isDirectory: boolean },
    ): void => {
      event.preventDefault();
      // 右键多选区域中的条目时保留整个选中集合；右键未选中条目则单选它。
      const selectedCount = selectedPaths.has(entry.path)
        ? selectedPaths.size
        : 1;
      setSelectedPaths((prev) =>
        selectedCount > 1 ? prev : new Set([entry.path]),
      );
      selectionAnchorRef.current = entry.path;
      setEntryContextMenu({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        position: { x: event.clientX, y: event.clientY },
        selectedCount,
      });
    },
    [selectedPaths],
  );

  const handleRenameEntry = useCallback(
    async (entryPath: string, newName: string): Promise<void> => {
      if (!rootPath) {
        return;
      }

      setError(null);
      try {
        if (isSsh && sshProfileIdRef.current) {
          await window.snow.sshRenameEntry(
            sshProfileIdRef.current,
            entryPath,
            newName,
          );
        } else {
          await window.snow.renameWorkspaceEntry(rootPath, entryPath, newName);
        }

        const lastSep = Math.max(
          entryPath.lastIndexOf("/"),
          entryPath.lastIndexOf("\\"),
        );
        const newPath =
          lastSep >= 0
            ? entryPath.substring(0, lastSep + 1) + newName
            : newName;

        setTree((prev) => renameNodeByPath(prev, entryPath, newPath, newName));

        setExpandedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (p === entryPath) {
              next.add(newPath);
            } else if (
              p.startsWith(entryPath + "/") ||
              p.startsWith(entryPath + "\\")
            ) {
              next.add(newPath + p.substring(entryPath.length));
            } else {
              next.add(p);
            }
          }
          return next;
        });

        // 选中集合同步：被重命名条目及其子路径的选中状态跟随迁移。
        setSelectedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (p === entryPath) {
              next.add(newPath);
            } else if (
              p.startsWith(entryPath + "/") ||
              p.startsWith(entryPath + "\\")
            ) {
              next.add(newPath + p.substring(entryPath.length));
            } else {
              next.add(p);
            }
          }
          return next;
        });
        // shift 锚点同步迁移，避免锚点失效导致后续范围选择降级。
        const anchor = selectionAnchorRef.current;
        if (
          anchor !== null &&
          (anchor === entryPath ||
            anchor.startsWith(entryPath + "/") ||
            anchor.startsWith(entryPath + "\\"))
        ) {
          selectionAnchorRef.current =
            anchor === entryPath
              ? newPath
              : newPath + anchor.substring(entryPath.length);
        }
      } catch (operationError) {
        setError(
          operationError instanceof Error
            ? toExplorerErrorMessage(operationError)
            : t("sidebar.explorerRenameError", {
                defaultValue: "Failed to rename workspace entry",
              }),
        );
        throw operationError;
      }
    },
    [isSsh, rootPath, t],
  );

  const handleDeleteEntry = useCallback(
    async (entryPath: string): Promise<void> => {
      if (!rootPath) {
        return;
      }

      setError(null);
      try {
        if (isSsh && sshProfileIdRef.current) {
          await window.snow.sshDeleteEntry(sshProfileIdRef.current, entryPath);
        } else {
          await window.snow.deleteWorkspaceEntry(rootPath, entryPath);
        }

        setTree((prev) => removeNodeByPath(prev, entryPath));

        setExpandedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (
              p === entryPath ||
              p.startsWith(entryPath + "/") ||
              p.startsWith(entryPath + "\\")
            ) {
              continue;
            }
            next.add(p);
          }
          return next;
        });

        // 从选中集合移除被删除条目及其子路径；shift 锚点若被删除则清空。
        setSelectedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            if (
              p !== entryPath &&
              !p.startsWith(entryPath + "/") &&
              !p.startsWith(entryPath + "\\")
            ) {
              next.add(p);
            }
          }
          return next;
        });
        if (
          selectionAnchorRef.current === entryPath ||
          (selectionAnchorRef.current?.startsWith(entryPath + "/") ?? false) ||
          (selectionAnchorRef.current?.startsWith(entryPath + "\\") ?? false)
        ) {
          selectionAnchorRef.current = null;
        }
      } catch (operationError) {
        setError(
          operationError instanceof Error
            ? toExplorerErrorMessage(operationError)
            : t("sidebar.explorerDeleteError", {
                defaultValue: "Failed to delete workspace entry",
              }),
        );
        throw operationError;
      }
    },
    [isSsh, rootPath, t],
  );

  // 批量复制选中路径（换行分隔写入剪贴板）。
  const handleCopySelectedPaths = useCallback((): void => {
    if (selectedPaths.size === 0) {
      return;
    }
    void window.snow
      .writeClipboardText(Array.from(selectedPaths).join("\n"))
      .catch(() => {
        // 剪贴板写入失败时静默忽略（与单文件复制路径行为一致）。
      });
  }, [selectedPaths]);

  // 批量删除选中条目：单次 IPC 调用后端批量 API（不做 N+1 次往返），
  // 按返回结果更新树与选中集合；部分失败时在内容区提示。
  const handleDeleteSelected = useCallback(async (): Promise<void> => {
    if (!rootPath || selectedPaths.size === 0) {
      return;
    }

    setError(null);
    const paths = Array.from(selectedPaths);

    try {
      const result =
        isSsh && sshProfileIdRef.current
          ? await window.snow.sshDeleteEntries(sshProfileIdRef.current, paths)
          : await window.snow.deleteWorkspaceEntries(rootPath, paths);

      const deletedPaths = result.deleted;

      if (deletedPaths.length > 0) {
        setTree((prev) =>
          deletedPaths.reduce((acc, p) => removeNodeByPath(acc, p), prev),
        );

        setExpandedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            const isDeleted = deletedPaths.some(
              (d) => p === d || p.startsWith(d + "/") || p.startsWith(d + "\\"),
            );
            if (!isDeleted) {
              next.add(p);
            }
          }
          return next;
        });

        setSelectedPaths((prev) => {
          const next = new Set<string>();
          for (const p of prev) {
            const isDeleted = deletedPaths.some(
              (d) => p === d || p.startsWith(d + "/") || p.startsWith(d + "\\"),
            );
            if (!isDeleted) {
              next.add(p);
            }
          }
          return next;
        });

        const anchor = selectionAnchorRef.current;
        if (
          anchor !== null &&
          deletedPaths.some(
            (d) =>
              anchor === d ||
              anchor.startsWith(d + "/") ||
              anchor.startsWith(d + "\\"),
          )
        ) {
          selectionAnchorRef.current = null;
        }
      }

      if (result.failed.length > 0) {
        setError(
          t("sidebar.explorerBatchDeleteError", {
            defaultValue:
              "{{count}} item(s) failed to delete — see details in the explorer",
            values: { count: result.failed.length },
          }),
        );
        throw new Error("Batch delete had partial failures");
      }
    } catch (operationError) {
      if (
        operationError instanceof Error &&
        operationError.message === "Batch delete had partial failures"
      ) {
        throw operationError;
      }
      setError(
        operationError instanceof Error
          ? toExplorerErrorMessage(operationError)
          : t("sidebar.explorerDeleteError", {
              defaultValue: "Failed to delete workspace entry",
            }),
      );
      throw operationError;
    }
  }, [isSsh, rootPath, selectedPaths, t]);

  // ===== SSH 文件传输（上传 / 下载 / 拖入上传） =====

  /** 传输启动失败文案：本地化原始错误；空消息回退通用提示。 */
  const toTransferStartErrorMessage = useCallback(
    (err: unknown): string => {
      const localized = localizeSshError(err, t);
      return (
        localized.message ||
        t("explorer.transferStartFailed", {
          defaultValue: "Cannot start the transfer",
        })
      );
    },
    [t],
  );

  /** 上传到指定远端目录（裸远端路径）；用户取消选择时静默忽略。 */
  const handleUploadToDirectory = useCallback(
    async (remoteDirectory: string): Promise<void> => {
      if (!isSsh || !directoryId) {
        return;
      }
      try {
        const result = await window.snow.sshTransferUpload({
          workspaceId: directoryId,
          remoteDirectory,
        });
        if (result.canceled) {
          return;
        }
      } catch (uploadError) {
        setError(toTransferStartErrorMessage(uploadError));
      }
    },
    [isSsh, directoryId, toTransferStartErrorMessage],
  );

  /** 工具栏上传：目标为工作区根目录，先把 ssh:// URL 解析为裸远端路径。 */
  const handleUploadToRoot = useCallback(async (): Promise<void> => {
    if (!isSsh || !rootPath || !directoryId || isStartingUpload) {
      return;
    }
    setIsStartingUpload(true);
    try {
      const parsed = await window.snow.sshParseUrl(rootPath);
      await handleUploadToDirectory(parsed.remotePath);
    } catch (parseError) {
      setError(toTransferStartErrorMessage(parseError));
    } finally {
      setIsStartingUpload(false);
    }
  }, [
    isSsh,
    rootPath,
    directoryId,
    isStartingUpload,
    handleUploadToDirectory,
    toTransferStartErrorMessage,
  ]);

  /** 下载选中的远端条目：主进程按单文件弹保存框、多文件弹目录选择框。 */
  const handleDownloadEntries = useCallback(
    async (remotePaths: string[]): Promise<void> => {
      if (!isSsh || !directoryId || remotePaths.length === 0) {
        return;
      }
      try {
        const result = await window.snow.sshTransferDownload({
          workspaceId: directoryId,
          remotePaths,
        });
        if (result.canceled) {
          return;
        }
      } catch (downloadError) {
        setError(toTransferStartErrorMessage(downloadError));
      }
    },
    [isSsh, directoryId, toTransferStartErrorMessage],
  );

  /** 外部文件拖入上传：解析本地路径（跳过目录）后交由主进程校验并确认。 */
  const handleDropUpload = useCallback(
    async (files: File[], remoteDirectory: string): Promise<void> => {
      if (!isSsh || !directoryId || files.length === 0) {
        return;
      }
      try {
        const entries = await window.snow.resolveDroppedFiles(files);
        const localPaths = entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.path);
        // 全部为目录：上传只支持普通文件，直接忽略。
        if (localPaths.length === 0) {
          return;
        }
        const result = await window.snow.sshTransferUploadDropped({
          workspaceId: directoryId,
          remoteDirectory,
          localPaths,
        });
        if (result.canceled) {
          return;
        }
      } catch (dropError) {
        setError(toTransferStartErrorMessage(dropError));
      }
    },
    [isSsh, directoryId, toTransferStartErrorMessage],
  );

  /** 树容器拖拽悬停：目标为工作区根目录。 */
  const handleTreeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsTreeDropTarget(true);
    },
    [isSsh],
  );

  const handleTreeDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      // 进入树容器内的子元素（如目录行）时不清除，由行的高亮接管。
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setIsTreeDropTarget(false);
    },
    [isSsh],
  );

  const handleTreeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      setIsTreeDropTarget(false);
      setDropTargetPath(null);
      if (!rootRemotePath) {
        return;
      }
      void handleDropUpload(
        Array.from(event.dataTransfer.files),
        rootRemotePath,
      );
    },
    [isSsh, rootRemotePath, handleDropUpload],
  );

  /** 目录行拖拽悬停：目标为该目录的远端路径。 */
  const handleDirectoryDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, nodePath: string): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      // 阻止冒泡：高亮与投放目标都锁定到目录行，而不是树容器（根目录）。
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setIsTreeDropTarget(false);
      setDropTargetPath(nodePath);
    },
    [isSsh],
  );

  const handleDirectoryDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      // 行内元素间移动不重置高亮，真正离开整行才清除。
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
        return;
      }
      setDropTargetPath(null);
    },
    [isSsh],
  );

  const handleDirectoryDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, nodePath: string): void => {
      if (!isSsh || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setIsTreeDropTarget(false);
      setDropTargetPath(null);
      void handleDropUpload(Array.from(event.dataTransfer.files), nodePath);
    },
    [isSsh, handleDropUpload],
  );

  const handleSearchChange = useCallback((value: string): void => {
    setSearchQuery(value);

    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    const trimmed = value.trim();

    if (!trimmed) {
      setIsSearching(false);
      setSearchResults([]);
      return;
    }

    setIsSearching(true);

    const seq = ++searchSeqRef.current;

    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.snow.searchFiles(
          rootPathRef.current ?? "",
          trimmed,
        );
        // Only apply results from the latest search
        if (seq === searchSeqRef.current) {
          setSearchResults(results);
          setIsSearching(false);
        }
      } catch {
        if (seq === searchSeqRef.current) {
          setSearchResults([]);
          setIsSearching(false);
        }
      }
    }, 300);
  }, []);

  const handleClearSearch = useCallback((): void => {
    setSearchQuery("");
    setSearchResults([]);
    setIsSearching(false);
    setSelectedLines(new Map());
    lineSelectAnchorRef.current = null;
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
  }, []);

  // Cleanup search timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  const isSearchMode = searchQuery.trim().length > 0;

  const silentRefreshDirectory = useCallback(
    async (dirPath: string): Promise<void> => {
      try {
        const entries = await window.snow.readDirectoryEntries(dirPath);
        const childNodes: TreeNode[] = entries.map((entry: DirectoryEntry) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
          size: entry.size,
          loaded: !entry.isDirectory,
          loading: false,
        }));

        setTree((prev) => {
          const mergeChildren = (nodes: TreeNode[]): TreeNode[] => {
            return nodes.map((node) => {
              if (node.path === dirPath) {
                if (!node.loaded) {
                  return node;
                }

                const oldChildren = node.children ?? [];
                return {
                  ...node,
                  children: childNodes.map((child) => {
                    const existing = oldChildren.find(
                      (old) => old.path === child.path,
                    );
                    if (existing) {
                      return {
                        ...child,
                        children: existing.children,
                        loaded: existing.loaded,
                        loading: false,
                      };
                    }
                    return child;
                  }),
                  loaded: true,
                  loading: false,
                };
              }

              if (node.children) {
                return {
                  ...node,
                  children: mergeChildren(node.children),
                };
              }

              return node;
            });
          };

          return mergeChildren(prev);
        });
      } catch {
        // Silently ignore refresh errors
      }
    },
    [],
  );

  const collectLoadedPaths = useCallback(
    (nodes: TreeNode[], current: Set<string> = new Set()): Set<string> => {
      for (const node of nodes) {
        if (node.isDirectory && node.loaded) {
          current.add(node.path);
        }
        if (node.children) {
          collectLoadedPaths(node.children, current);
        }
      }
      return current;
    },
    [],
  );

  useEffect(() => {
    if (!rootPath) {
      return;
    }

    if (isSsh) {
      return;
    }

    void window.snow.startDirectoryWatch(rootPath);

    const unsubscribe = window.snow.onDirectoryChanged((_dirPath: string) => {
      const loadedPaths = collectLoadedPaths(treeStateRef.current);
      for (const path of loadedPaths) {
        void silentRefreshDirectory(path);
      }
    });

    return () => {
      unsubscribe();
      void window.snow.stopDirectoryWatch(rootPath);
    };
  }, [rootPath, isSsh, collectLoadedPaths, silentRefreshDirectory]);

  useEffect(() => {
    treeStateRef.current = tree;
  }, [tree]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    return window.snow.onSshProfileConnection((connection) => {
      if (connection.profileId !== sshProfileIdRef.current) {
        return;
      }
      setSshConnectionStatus(connection.status);
      if (
        connection.status !== "connected" ||
        connection.generation <= sshGenerationRef.current
      ) {
        return;
      }

      sshGenerationRef.current = connection.generation;
      const visiblePaths = Array.from(expandedPathsRef.current);
      void (async (): Promise<void> => {
        await loadRootDirectory();
        for (const path of visiblePaths) {
          await loadChildrenRef.current?.(path);
        }
      })();
    });
  }, [loadRootDirectory]);

  useEffect(() => {
    return () => {
      if (sshProfileIdRef.current) {
        void window.snow.sshReleaseProfile(sshProfileIdRef.current);
        sshProfileIdRef.current = null;
      }
    };
  }, []);

  // 上传成功后刷新目标目录：SSH 目录没有文件监听，必须手动失效缓存。
  // 同一任务只刷新一次；上传到根目录时整树刷新，子目录仅失效该节点并重拉。
  useEffect(() => {
    if (!isSsh || !directoryId) {
      return;
    }

    const unsubscribe = window.snow.onSshTransfersUpdated((snapshot) => {
      for (const task of snapshot.tasks) {
        if (
          task.direction !== "upload" ||
          task.workspaceId !== directoryId ||
          task.status !== "succeeded"
        ) {
          continue;
        }
        if (refreshedUploadTasksRef.current.has(task.taskId)) {
          continue;
        }
        refreshedUploadTasksRef.current.add(task.taskId);

        // 远端目录 = remotePath 去掉最后一个 "/" 之后的段。
        const lastSlash = task.remotePath.lastIndexOf("/");
        const parentDirectory =
          lastSlash <= 0 ? "/" : task.remotePath.substring(0, lastSlash);

        if (rootRemotePath && parentDirectory === rootRemotePath) {
          handleRefresh();
          continue;
        }

        // 目标目录未展开（或尚未加载）时无需处理，展开时自然读到最新内容。
        const node = findTreeNode(treeStateRef.current, parentDirectory);
        if (!node?.loaded) {
          continue;
        }
        setTree((prev) => invalidateTreeNode(prev, parentDirectory));
        void loadChildrenRef.current?.(parentDirectory);
      }
    });

    return unsubscribe;
  }, [isSsh, directoryId, rootRemotePath, handleRefresh]);

  const flatNodes = useMemo(
    () => flattenTree(tree, expandedPaths),
    [tree, expandedPaths],
  );

  // 渲染树节点：已展开的目录行包裹自己的子树容器，
  // 使该行的 sticky 生效范围正好是「自己 + 子树」——上级已吸顶的行构成整体后，
  // 下一层滚到它的层级位置即被接入，子树滚完时又自动被顶出。
  const renderNode = (node: TreeNode, depth: number): React.JSX.Element => {
    const isExpanded = expandedPaths.has(node.path);
    const isSelected = selectedPaths.has(node.path);
    const hasChildren = node.isDirectory;
    const isSticky = hasChildren && isExpanded;

    return (
      <div className="explorer-tree-node" key={node.path}>
        <div
          className={`explorer-tree-row${
            isSticky ? " explorer-tree-row--sticky" : ""
          }${isSelected ? " selected" : ""}${node.stale ? " stale" : ""}${
            dropTargetPath === node.path
              ? " explorer-tree-row--drop-target"
              : ""
          }`}
          draggable
          onDragStart={(event) => handleTreeDragStart(event, node)}
          onDragOver={
            node.isDirectory
              ? (event) => handleDirectoryDragOver(event, node.path)
              : undefined
          }
          onDragLeave={node.isDirectory ? handleDirectoryDragLeave : undefined}
          onDrop={
            node.isDirectory
              ? (event) => handleDirectoryDrop(event, node.path)
              : undefined
          }
          onClick={(event) => handleTreeRowClick(event, node, hasChildren)}
          onDoubleClick={() => {
            if (!node.isDirectory) {
              setEditingEntry({ path: node.path, name: node.name });
            }
          }}
          onContextMenu={(event) => handleEntryContextMenu(event, node)}
          style={{
            paddingLeft: `${depth * 14 + 8}px`,
            ...(isSticky
              ? {
                  top: `${depth * EXPLORER_ROW_HEIGHT}px`,
                  // 层级越浅越靠上：某一层被子树顶出时会向上滑过上层吸顶行，
                  // 必须从上层下面穿过，否则会出现「下层遮盖上层」
                  zIndex: 100 - depth,
                }
              : {}),
          }}
          title={node.path}
        >
          <span className="explorer-tree-chevron">
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : null}
          </span>
          {getFileIcon(node, isExpanded)}
          <span className="explorer-tree-label">{node.name}</span>
          {!node.isDirectory ? (
            <span className="explorer-tree-size">{formatSize(node.size)}</span>
          ) : node.loading ? (
            <Loader2 className="spin explorer-tree-loading" size={11} />
          ) : node.error ? (
            <span title={node.error}>
              <AlertCircle className="explorer-tree-error" size={11} />
            </span>
          ) : null}
        </div>
        {isSticky && node.children ? (
          <div className="explorer-tree-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  // 树行点击：ctrl/cmd 切换选中、shift 范围选择；普通点击单选并打开/展开。
  const handleTreeRowClick = useCallback(
    (
      event: React.MouseEvent<HTMLDivElement>,
      node: TreeNode,
      hasChildren: boolean,
    ): void => {
      // 让树容器获得焦点，保证 Ctrl+A 全选与键盘操作可用。
      treeRef.current?.focus();

      const isCtrl = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;

      // ctrl/cmd：切换该条目的选中状态，不打开文件、不展开目录。
      if (isCtrl) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(node.path)) {
            next.delete(node.path);
          } else {
            next.add(node.path);
          }
          return next;
        });
        selectionAnchorRef.current = node.path;
        return;
      }

      // shift：从锚点到当前条目的可见范围选择（不打开文件、不展开目录）。
      if (isShift) {
        const anchor = selectionAnchorRef.current;
        if (anchor) {
          const visiblePaths = flatNodes.map((f) => f.node.path);
          const anchorIndex = visiblePaths.indexOf(anchor);
          const currentIndex = visiblePaths.indexOf(node.path);
          if (anchorIndex >= 0 && currentIndex >= 0) {
            const from = Math.min(anchorIndex, currentIndex);
            const to = Math.max(anchorIndex, currentIndex);
            setSelectedPaths(new Set(visiblePaths.slice(from, to + 1)));
            return;
          }
        }
        // 锚点失效时降级为单选。
        setSelectedPaths(new Set([node.path]));
        selectionAnchorRef.current = node.path;
        return;
      }

      // 普通点击：单选 + 目录展开/折叠或打开文件（保持原有行为）。
      setSelectedPaths(new Set([node.path]));
      selectionAnchorRef.current = node.path;
      if (hasChildren) {
        void handleToggle(node.path);
      } else {
        // 双击序列中的第二次单击不重复打开右侧 tab，交由 onDoubleClick
        // 打开快速编辑弹窗接管。
        const now = Date.now();
        const isSecondClickOfDoubleClick = now - lastRowClickRef.current < 300;
        lastRowClickRef.current = now;
        if (!isSecondClickOfDoubleClick) {
          onOpenFile?.(
            node.path,
            node.name,
            isSsh,
            sshProfileIdRef.current,
            undefined,
            rootPath ?? undefined,
            directoryId ?? undefined,
          );
        }
      }
    },
    [flatNodes, handleToggle, onOpenFile, isSsh, rootPath, directoryId],
  );

  // 树容器键盘：Ctrl/Cmd + A 全选当前可见条目，Escape 清空选择。
  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedPaths(new Set(flatNodes.map((f) => f.node.path)));
        // 锚点重置为最后一项，便于后续 shift 继续扩展范围。
        if (flatNodes.length > 0) {
          selectionAnchorRef.current =
            flatNodes[flatNodes.length - 1].node.path;
        }
        return;
      }
      if (event.key === "Escape") {
        setSelectedPaths(new Set());
        selectionAnchorRef.current = null;
      }
    },
    [flatNodes],
  );

  // 树条目拖拽：若拖拽的是已选中的条目且存在多个选中项，则携带整个选中
  // 集合（file-tags 多文件协议）；否则仅携带该条目（保持原有单对象格式）。
  const handleTreeDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
      if (selectedPaths.has(node.path) && selectedPaths.size > 1) {
        const tags: FileTag[] = flatNodes
          .filter((f) => selectedPaths.has(f.node.path))
          .map((f) => ({
            path: f.node.path,
            name: f.node.name,
            isDirectory: f.node.isDirectory,
          }));
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({ type: "file-tags", tags }),
        );
      } else {
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({
            path: node.path,
            name: node.name,
            isDirectory: node.isDirectory,
          }),
        );
      }
      event.dataTransfer.effectAllowed = "copy";
    },
    [flatNodes, selectedPaths],
  );

  // 将当前选中行按文件聚合成 FileTag 列表。拖拽时统一发送。
  const buildSelectedFileTags = useCallback((): FileTag[] => {
    const tags: FileTag[] = [];
    for (const [filePath, lineSet] of selectedLines) {
      if (lineSet.size === 0) {
        continue;
      }
      const result = searchResults.find((r) => r.path === filePath);
      const name = result?.name ?? filePath.split(/[\\/]/).pop() ?? filePath;
      const lines = Array.from(lineSet).sort((a, b) => a - b);
      tags.push({ path: filePath, name, isDirectory: false, lines });
    }
    return tags;
  }, [searchResults, selectedLines]);

  // 右键菜单「添加到输入框」：与拖拽条目到输入框完全等效——搜索结果里已选中
  // 行号时携带行号，否则派发当前选中条目（含 ctrl/shift 多选的文件与文件夹）。
  const handleAddSelectedToInput = useCallback((): void => {
    let tags = buildSelectedFileTags();
    if (tags.length === 0) {
      const known = new Map<string, { name: string; isDirectory: boolean }>();
      const collectLoaded = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          known.set(node.path, {
            name: node.name,
            isDirectory: node.isDirectory,
          });
          if (node.children) {
            collectLoaded(node.children);
          }
        }
      };
      collectLoaded(tree);
      for (const result of searchResults) {
        if (!known.has(result.path)) {
          known.set(result.path, { name: result.name, isDirectory: false });
        }
      }
      tags = [];
      for (const path of selectedPaths) {
        const info = known.get(path);
        if (info) {
          tags.push({ path, name: info.name, isDirectory: info.isDirectory });
        }
      }
    }
    if (tags.length === 0) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent<FileTag[]>(INSERT_FILE_TAGS_EVENT, { detail: tags }),
    );
  }, [buildSelectedFileTags, searchResults, selectedPaths, tree]);

  // 点击文件名：清空行选择，打开文件（不带行号）。双击序列中的第二次
  // 点击不重复打开 tab，交由 onDoubleClick 打开快速编辑弹窗。
  const handleSearchFileNameClick = useCallback(
    (result: FileSearchResult) => {
      setSelectedPaths(new Set([result.path]));
      setSelectedLines(new Map());
      lineSelectAnchorRef.current = null;
      const now = Date.now();
      const isSecondClickOfDoubleClick = now - lastRowClickRef.current < 300;
      lastRowClickRef.current = now;
      if (!isSecondClickOfDoubleClick) {
        onOpenFile?.(
          result.path,
          result.name,
          isSsh,
          sshProfileIdRef.current,
          undefined,
          rootPath ?? undefined,
          directoryId ?? undefined,
        );
      }
    },
    [onOpenFile],
  );

  // 点击某行：普通点击选中该行并打开文件定位；ctrl/shift 进行多选。
  const handleSearchLineClick = useCallback(
    (result: FileSearchResult, line: number, event: React.MouseEvent) => {
      event.stopPropagation();

      const isCtrl = event.ctrlKey || event.metaKey;

      if (isCtrl) {
        // 切换该行选中，不打开文件。
        setSelectedLines((prev) => {
          const next = new Map(prev);
          const set = new Set(next.get(result.path) ?? []);
          if (set.has(line)) {
            set.delete(line);
          } else {
            set.add(line);
          }
          if (set.size > 0) {
            next.set(result.path, set);
          } else {
            next.delete(result.path);
          }
          return next;
        });
        lineSelectAnchorRef.current = { path: result.path, line };
        return;
      }

      if (event.shiftKey && lineSelectAnchorRef.current) {
        const anchor = lineSelectAnchorRef.current;
        // 范围选择：仅同一文件内从 anchor 到当前行。
        if (anchor.path === result.path) {
          const from = Math.min(anchor.line, line);
          const to = Math.max(anchor.line, line);
          setSelectedLines((prev) => {
            const next = new Map(prev);
            const set = new Set(next.get(result.path) ?? []);
            for (let l = from; l <= to; l++) {
              set.add(l);
            }
            next.set(result.path, set);
            return next;
          });
          return;
        }
      }

      // 普通点击：仅选中该行并打开文件定位到该行。
      const single = new Map<string, Set<number>>();
      single.set(result.path, new Set([line]));
      setSelectedLines(single);
      lineSelectAnchorRef.current = { path: result.path, line };
      setSelectedPaths(new Set([result.path]));
      onOpenFile?.(
        result.path,
        result.name,
        isSsh,
        sshProfileIdRef.current,
        line,
        rootPath ?? undefined,
        directoryId ?? undefined,
      );
    },
    [onOpenFile],
  );

  // 拖拽搜索结果（从文件名区域触发）：若有选中行则发送选中行的
  // 聚合 FileTag 列表；否则视为整个文件引用，不携带行号。
  const handleSearchResultDragStart = useCallback(
    (event: React.DragEvent, result: FileSearchResult) => {
      const selectedTags = buildSelectedFileTags();
      if (selectedTags.length > 0) {
        event.dataTransfer.setData(
          "application/json",
          JSON.stringify({ type: "file-tags", tags: selectedTags }),
        );
        event.dataTransfer.effectAllowed = "copy";
        return;
      }
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          type: "file-tags",
          tags: [{ path: result.path, name: result.name, isDirectory: false }],
        }),
      );
      event.dataTransfer.effectAllowed = "copy";
    },
    [buildSelectedFileTags],
  );

  const placementLabel =
    placement === "sidebar"
      ? t("sidebar.explorerMoveToRightPanel", {
          defaultValue: "Move to right panel",
        })
      : t("sidebar.explorerMoveToSidebar", {
          defaultValue: "Move to left panel",
        });

  const searchBarNode =
    rootPath && !isSsh ? (
      <div className="explorer-search-bar">
        <Search size={13} strokeWidth={1.8} aria-hidden="true" />
        <input
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={t("sidebar.explorerSearchPlaceholder", {
            defaultValue: "Search files and content",
          })}
          aria-label={t("sidebar.explorerSearchLabel", {
            defaultValue: "Search files",
          })}
          spellCheck={false}
        />
        {isSearching ? (
          <Loader2 className="spin" size={13} />
        ) : searchQuery ? (
          <button
            className="explorer-search-clear"
            onClick={handleClearSearch}
            type="button"
            aria-label={t("sidebar.explorerSearchClear", {
              defaultValue: "Clear search",
            })}
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
    ) : null;

  const actionButtons = (
    <>
      <button
        className="icon-btn ghost explorer-placement-btn"
        onClick={handleTogglePlacement}
        type="button"
        aria-label={placementLabel}
        title={placementLabel}
      >
        {placement === "sidebar" ? (
          <PanelRight size={14} />
        ) : (
          <PanelLeft size={14} />
        )}
      </button>
      {isSsh && rootPath && directoryId ? (
        // SSH 工作区：上传文件到根目录（主进程弹文件选择框）。
        <button
          className="icon-btn ghost explorer-upload-btn"
          onClick={() => void handleUploadToRoot()}
          type="button"
          disabled={isStartingUpload}
          aria-label={t("explorer.transferUploadRoot", {
            defaultValue: "Upload files to the workspace root",
          })}
          title={t("explorer.transferUploadRoot", {
            defaultValue: "Upload files to the workspace root",
          })}
        >
          {isStartingUpload ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <Upload size={14} />
          )}
        </button>
      ) : null}
      <button
        className="icon-btn ghost explorer-refresh-btn"
        onClick={handleRefresh}
        type="button"
        disabled={isLoading}
        aria-label={t("sidebar.explorerRefresh", {
          defaultValue: "Refresh",
        })}
      >
        {isLoading ? (
          <Loader2 className="spin" size={14} />
        ) : (
          <RefreshCw size={14} />
        )}
      </button>
    </>
  );

  return (
    <>
      {placement === "sidebar" ? (
        <div className="explorer-header">
          {onBack ? (
            <button
              className="icon-btn ghost"
              onClick={onBack}
              type="button"
              aria-label={t("sidebar.explorerBack", {
                defaultValue: "Back to main sidebar",
              })}
            >
              <ArrowLeft size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          <span className="explorer-title">
            {t("sidebar.explorerTitle", { defaultValue: "Explorer" })}
          </span>
          {actionButtons}
        </div>
      ) : (
        // 右侧面板：位置切换 / 刷新与搜索框同排，省去独立头部占用的高度。
        <div className="explorer-toolbar">
          {searchBarNode}
          {actionButtons}
        </div>
      )}

      <div className="explorer-content">
        {placement === "sidebar" ? searchBarNode : null}

        {rootPath ? (
          <div className="explorer-root-info">
            {getFileTypeIcon(rootName, true, true, { size: 13 })}
            <span className="explorer-root-name">{rootName}</span>
            <span className="explorer-root-path" title={rootPath}>
              {rootPath}
            </span>
            {isSsh && sshConnectionStatus ? (
              <span
                className={`explorer-connection-status-dot ${sshConnectionStatus}`}
                title={sshConnectionStatus}
                aria-label={sshConnectionStatus}
              />
            ) : null}
          </div>
        ) : null}

        {error ? (
          <span className={`explorer-error${isStale ? " stale" : ""}`}>
            {isStale ? <AlertCircle size={13} /> : null}
            {error}
          </span>
        ) : null}

        {isSearchMode ? (
          <div className="explorer-tree" ref={treeRef}>
            {isSearching && searchResults.length === 0 ? (
              <span className="empty-text">
                {t("sidebar.explorerSearching", {
                  defaultValue: "Searching...",
                })}
              </span>
            ) : searchResults.length === 0 ? (
              <span className="empty-text">
                {t("sidebar.explorerNoSearchResults", {
                  defaultValue: "No results found",
                })}
              </span>
            ) : (
              <>
                <span className="explorer-search-count">
                  {t("sidebar.explorerSearchResultCount", {
                    defaultValue: "{{count}} results",
                    values: { count: searchResults.length },
                  })}
                </span>
                {searchResults.map((result) => {
                  const selectedSet = selectedLines.get(result.path);
                  return (
                    <div
                      className="explorer-search-result"
                      key={result.path}
                      draggable
                      onDragStart={(event) =>
                        handleSearchResultDragStart(event, result)
                      }
                      onClick={() => handleSearchFileNameClick(result)}
                      onDoubleClick={() => {
                        setEditingEntry({
                          path: result.path,
                          name: result.name,
                        });
                      }}
                      onContextMenu={(event) =>
                        handleEntryContextMenu(event, result)
                      }
                      title={result.path}
                    >
                      {getFileTypeIcon(result.name, false, false, {
                        className: "tree-icon",
                        size: 13,
                      })}
                      <div className="explorer-search-result-info">
                        <span className="explorer-search-result-name">
                          {result.name}
                        </span>
                        <span className="explorer-search-result-path">
                          {result.relativePath}
                        </span>
                        {result.lineMatches.map((match) => {
                          const isSelected =
                            selectedSet?.has(match.line) ?? false;
                          return (
                            <span
                              className={`explorer-search-result-line${
                                isSelected ? " is-selected" : ""
                              }`}
                              key={match.line}
                              draggable
                              onDragStart={(event) =>
                                handleSearchResultDragStart(event, result)
                              }
                              onClick={(event) =>
                                handleSearchLineClick(result, match.line, event)
                              }
                              title={`${result.path}:${match.line}`}
                            >
                              <span className="explorer-search-line-number">
                                {match.line}
                              </span>
                              {match.text}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <>
            {!error && !isLoading && tree.length === 0 ? (
              <span className="empty-text">
                {t("sidebar.explorerEmpty", {
                  defaultValue: "No files to display",
                })}
              </span>
            ) : null}

            <div
              className={`explorer-tree${
                isTreeDropTarget ? " explorer-tree--drop-target" : ""
              }`}
              ref={treeRef}
              tabIndex={-1}
              onKeyDown={handleTreeKeyDown}
              onDragOver={isSsh ? handleTreeDragOver : undefined}
              onDragLeave={isSsh ? handleTreeDragLeave : undefined}
              onDrop={isSsh ? handleTreeDrop : undefined}
            >
              {tree.map((node) => renderNode(node, 0))}
            </div>
          </>
        )}
      </div>
      {entryContextMenu ? (
        <ExplorerEntryContextMenu
          entryName={entryContextMenu.name}
          entryPath={entryContextMenu.path}
          isDirectory={entryContextMenu.isDirectory}
          isSsh={isSsh}
          selectedCount={entryContextMenu.selectedCount}
          onClose={() => setEntryContextMenu(null)}
          onDelete={() => handleDeleteEntry(entryContextMenu.path)}
          onDeleteSelected={() => handleDeleteSelected()}
          onCopySelectedPaths={() => handleCopySelectedPaths()}
          onAddToInput={() => handleAddSelectedToInput()}
          onOpenTerminal={handleEntryOpenTerminal}
          onRename={(newName) =>
            handleRenameEntry(entryContextMenu.path, newName)
          }
          onDownloadToLocal={() =>
            void handleDownloadEntries([entryContextMenu.path])
          }
          onDownloadSelected={() =>
            void handleDownloadEntries(
              selectedPaths.size > 0
                ? Array.from(selectedPaths)
                : [entryContextMenu.path],
            )
          }
          onUploadToHere={() =>
            void handleUploadToDirectory(entryContextMenu.path)
          }
          position={entryContextMenu.position}
        />
      ) : null}
      <Suspense fallback={null}>
        <FileEditModal
          open={editingEntry !== null}
          filePath={editingEntry?.path ?? ""}
          fileName={editingEntry?.name ?? ""}
          isSsh={isSsh}
          sshSessionId={sshProfileIdRef.current}
          sshWorkspaceRoot={rootPath ?? undefined}
          sshWorkspaceId={directoryId ?? undefined}
          onClose={() => setEditingEntry(null)}
          onOpenTerminal={onOpenTerminal}
        />
      </Suspense>
      {/* SSH 文件传输进度 / 冲突协商：无任务时组件自渲染为 null。 */}
      <SshTransfersPanel />
    </>
  );
}
