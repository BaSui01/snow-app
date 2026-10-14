/**
 * 绘图工作台共享类型（单一事实来源）。
 *
 * 工作台的画布、图库历史、灯箱与单张保存链路都传递同一批图片数据，若各子组件
 * 各自声明一份结构相似但字段可选性不同的类型，函数参数的双变检查会互相不兼容
 * （典型的 `string | undefined` 与 `string` 冲突）。因此这里集中定义唯一的
 * 记录 / 画廊项类型，父组件与子组件一律引用本模块。
 */

import type { GeneratedImage } from "../mainContent/chatMessages/toolCalls/imagegenUtils";

/** 图库历史记录（与 `listImageLibrary` 返回的记录同构）。 */
export type DrawingLibraryRecord = {
  id: string;
  relativePath: string;
  mimeType: string;
  prompt: string;
  createdAt: string;
};

/**
 * 画廊 / 灯箱统一展示项：本地图（data / 图库 path）+ 远程 URL。
 * `record` 为图库来源信息（生成结果已落盘时提供），灯箱据此展示提示词与时间。
 */
export type DrawingGalleryItem = {
  key: string;
  src: string;
  /** 本地图片路径（image/... 图库路径、upload/... 或绝对路径）：经 IPC 解析展示。 */
  path?: string;
  image?: GeneratedImage;
  record?: DrawingLibraryRecord;
  remoteUrl?: string;
};

/** 流式预览图项（imagegen `partial_image` chunk）。 */
export type StreamingImageItem = {
  index: number;
  mimeType: string;
  data: string;
};
