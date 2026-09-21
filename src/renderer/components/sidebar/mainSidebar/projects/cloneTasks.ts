import type { GitCloneProgress } from "../../../../../preload";

/** 克隆任务的生命周期状态。 */
export type CloneTaskStatus = "cloning" | "aborting" | "failed";

/**
 * 一次克隆任务：弹窗关闭后任务仍然存活（克隆在后台继续），
 * 由侧边栏项目区的占位条目展示进度、取消入口与失败信息。
 */
export type CloneTask = {
  streamId: string;
  /** 从仓库地址推导出的项目名（占位条目显示名）。 */
  repoName: string;
  /** 克隆的最终目录（推导值，用于 hover 提示）。 */
  targetPath: string;
  progress: GitCloneProgress | null;
  status: CloneTaskStatus;
  error: string | null;
};

/**
 * 是否是「用户中止克隆」：Rust 端返回的错误带 GIT_CLONE_CANCELLED 标记，
 * 中止属于用户主动行为，不按失败提示（弹窗回到可编辑态、占位条目直接移除）。
 */
export const isCloneCanceledError = (message: string): boolean =>
  message.includes("GIT_CLONE_CANCELLED");
