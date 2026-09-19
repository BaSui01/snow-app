/** 可迁移的存储位置种类：checkpoint（检查点）| upload（上传图片） */
export type StorageLocationKind = "checkpoint" | "upload";

/** 各存储位置路径信息 */
export type StorageLocations = {
  /** 运行数据库文件绝对路径（~/.snowapp/snowapp.db 或自定义） */
  databasePath: string;
  /** 归档数据库文件绝对路径（~/.snowapp/archive.db，存放归档会话） */
  archiveDbPath: string;
  /** 检查点自定义保存目录（空字符串表示使用默认目录） */
  checkpointDir: string;
  /** 上传图片自定义保存目录（空字符串表示使用默认目录） */
  uploadDir: string;
  /** 检查点根目录绝对路径（优先自定义，回退默认） */
  checkpointRoot: string;
  /** 上传图片根目录绝对路径（优先自定义，回退默认） */
  uploadRoot: string;
};

/** 存储目录迁移进度 */
export type StorageMigrationProgress = {
  copied: number;
  total: number;
  done: boolean;
};

/** 可修复的数据库种类：runtime（运行库）| archive（归档库） */
export type DatabaseKind = "runtime" | "archive";

/** 数据库修复结果 */
export type DatabaseRepairResult = {
  /** 是否实际执行了数据恢复（true=检测到损坏并已恢复；false=数据库完好，仅完成压缩） */
  repaired: boolean;
  /** 修复过程描述（英文，供日志与诊断） */
  message: string;
};

/** 数据库空间优化结果 */
export type DatabaseOptimizeResult = {
  /** 本次 VACUUM + WAL 截断释放的磁盘字节数（无可回收空间时为 0） */
  bytesFreed: number;
};

/** 进程内存整理结果 */
export type MemoryOptimizeResult = {
  /** 本次优化前的常驻内存（字节；含 GC 前的测量值） */
  bytesBefore: number;
  /** 本次优化后的常驻内存（字节） */
  bytesAfter: number;
};

/** 数据清理：可清理的分类 id（与 Rust 侧 cleanup 服务一一对应） */
export type CleanupCategoryId =
  | "checkpoints"
  | "upload"
  | "imageLibrary"
  | "backgrounds"
  | "pets"
  | "browserState"
  | "appLogs";

/** 数据清理：单个时间档位（早于 N 天）可清理的数据量 */
export type CleanupAgeBucket = {
  days: number;
  files: number;
  bytes: number;
};

/** 数据清理：单个分类的扫描结果 */
export type CleanupCategoryStats = {
  id: CleanupCategoryId;
  files: number;
  bytes: number;
  /** 与请求的 daysList 顺序一致：早于各天数档位可清理的数据量 */
  ageBuckets: CleanupAgeBucket[];
};

/** 数据清理：一次扫描的完整结果 */
export type CleanupScanResult = {
  categories: CleanupCategoryStats[];
  totalFiles: number;
  totalBytes: number;
};

/** 数据清理：删除结果 */
export type CleanupDeleteResult = {
  deletedFiles: number;
  deletedBytes: number;
  /** 被整体移除的顶层条目数（文件或目录） */
  removedTargets: number;
  /** 删除失败的信息（最多 20 条） */
  errors: string[];
};
