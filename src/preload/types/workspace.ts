export type WorkspaceDirectoryKind = "local" | "ssh";

export type WorkspaceDirectoryInput = {
  directoryId: string;
  name: string;
  path: string;
  kind: WorkspaceDirectoryKind;
  isActive: boolean;
  sortOrder: number;
  source: string;
};

export type WorkspaceDirectoryRecord = WorkspaceDirectoryInput & {
  id: string;
  updatedAt: string;
  /** 最近一次校验得到的路径状态；unknown 表示尚未校验过。 */
  pathState: string;
  /** 最近一次确认存在时的绝对路径（路径失效后用于提示与重新定位）。 */
  lastKnownPath: string;
};

/** 目录路径健康状态：ok/remote 可用，其余表示路径已不可达。 */
export type WorkspaceDirectoryPathState =
  | "unknown"
  | "ok"
  | "missing"
  | "mismatch"
  | "offline"
  | "permission_error"
  | "remote";

export type WorkspaceDirectoryVerifyReport = {
  directoryId: string;
  path: string;
  kind: string;
  state: WorkspaceDirectoryPathState | string;
  lastKnownPath: string;
};

/** 项目位置迁移记录：用于查看历史并撤销。 */
export type WorkspaceRelinkRecord = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  movedBy: string;
  createdAt: string;
  undoneAt?: string | null;
};

export type WorkspaceRelinkReport = {
  relinkId: string;
  oldDirectoryId: string;
  newDirectoryId: string;
  oldPath: string;
  newPath: string;
  dryRun: boolean;
  merged: boolean;
  conversations: number;
  archivedConversations: number;
  memories: number;
  memos: number;
  scheduledTasks: number;
  collectionsTouched: number;
  settingsKeysMoved: number;
  pathsRewritten: number;
  checkpointsRewritten: number;
  codebaseReindexRequired: boolean;
  archiveUpdated: boolean;
  notes: string[];
};

export type WorkspaceRelinkResult = {
  report: WorkspaceRelinkReport;
  directories: WorkspaceDirectoryRecord[];
};

/** 项目合集 / 关联项目组：收纳项目的纯元数据容器（不对应磁盘目录）。 */
export type ProjectCollectionRecord = {
  id: string;
  collectionId: string;
  name: string;
  /** 合集统一识别色（#rrggbb）：关联项目组的圆点标识色 */
  color: string;
  sortOrder: number;
  /** 收纳的项目 directory_id 列表（按加入顺序） */
  memberDirectoryIds: string[];
  /** 参与关联项目组的成员子集：断连的成员只留在合集里 */
  linkedDirectoryIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

/** 正文文件路径引用的解析结果（磁盘上真实存在的条目）。 */
export type ResolvedFileLink = {
  path: string;
  isDirectory: boolean;
};

export type FailedWorkspaceDelete = {
  path: string;
  error: string;
};

/** 批量删除结果：deleted 为成功删除的路径，failed 为失败的条目及原因。 */
export type BatchWorkspaceDeleteResult = {
  deleted: string[];
  failed: FailedWorkspaceDelete[];
};

export type FailedWorkspaceCopy = {
  source: string;
  error: string;
};

/** 本地复制结果：copied 为落盘后的条目（另存时名称可能变化），failed 为失败的源文件。 */
export type BatchWorkspaceCopyResult = {
  copied: DirectoryEntry[];
  failed: FailedWorkspaceCopy[];
};

export type FileSearchResult = {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
};

/** 自然语言文件搜索 agent 的进度回调数据（每次工具调用一条）。 */
import type { SshFileVersion } from "./ssh";

export type FileSearchAgentProgress = {
  round: number;
  tool: string;
  argsJson: string;
  resultPreview: string;
};

/** `git clone` 的实时进度：一条 stderr 进度行 + 解析出的百分比。 */
export type GitCloneProgress = {
  line: string;
  percent: number | null;
};

export type FileContentResult = {
  content: string;
  isBinary: boolean;
  isImage: boolean;
  isSvg: boolean;
  mimeType: string;
  encoding: string;
  size: number;
  /** Present only for remote SSH reads and used as the save CAS token. */
  remoteVersion?: SshFileVersion;
};

export type PreviewColumn = {
  name: string;
  dataType: string;
  notNull: boolean;
  primaryKey: boolean;
};

export type PreviewTable = {
  name: string;
  kind: "table" | "view";
  columns: PreviewColumn[];
};

/** 合并区域：坐标相对于 PreviewGrid.rows（已裁剪到可见窗口）。 */
export type PreviewMerge = {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
};

export type PreviewGrid = {
  name: string;
  /** 数据库列名；工作表为空数组（按列号生成 A/B/C 表头）。 */
  headers: string[];
  /** 数据区左上角在表内的绝对行/列（0 起）。 */
  rowOffset: number;
  columnOffset: number;
  rows: (string | null)[][];
  /** 工作表数据区总行数；数据库不统计，固定为 -1。 */
  totalRows: number;
  totalColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  /** 本次读取的行数上限（工作表 500，数据表 200）。 */
  rowLimit: number;
  merges: PreviewMerge[];
};

export type PreviewSlide = {
  index: number;
  title: string;
  blocks: string[];
  hidden: boolean;
};

export type FilePreviewKind = "spreadsheet" | "database" | "slides" | "docx";

/** 不可预览的原因枚举（渲染层据此本地化，不解析原始错误文本）。 */
export type FilePreviewReason =
  | "not_found"
  | "unsupported"
  | "too_large"
  | "format_mismatch"
  | "parse_failed"
  | "read_failed";

/**
 * 文件查看器结构化预览的判别式结果：
 * ready = 已生成结构化预览（或 DOCX 原始字节）；
 * unavailable = 不可预览（reason + 原始 detail）；
 * passthrough = 不属于结构化预览范围，继续走 readFileContent。
 */
export type FilePreviewResult = {
  status: "ready" | "unavailable" | "passthrough";
  kind: FilePreviewKind | "";
  reason: FilePreviewReason | "";
  detail: string;
  /** 文件头前 16 字节十六进制（format_mismatch 时提供）。 */
  signature: string;
  size: number;
  /** too_large 时对应的上限字节数。 */
  limit: number;
  /** 可切换到「抽取文本」视图。 */
  textAvailable: boolean;
  sheets: string[];
  tables: PreviewTable[];
  truncatedTables: boolean;
  grid?: PreviewGrid | null;
  gridError: string;
  slides: PreviewSlide[];
  truncatedSlides: boolean;
  /** SQLite 存在未合并的 -wal 文件。 */
  walPending: boolean;
  data?: Uint8Array | null;
};

/**
 * 从外部拖入编辑区的文件解析结果。
 *
 * path 为磁盘绝对路径（由 webUtils.getPathForFile 解析），
 * isDirectory 标记该路径是否为目录（由主进程 fs.stat 查询）。
 * 用于在渲染层统一生成文件 chip 或图片 chip。
 */
export type DroppedPathEntry = {
  path: string;
  isDirectory: boolean;
};
