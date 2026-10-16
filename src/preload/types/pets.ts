/**
 * Codex 桌面宠物系统类型（渲染进程可见）。
 */

/** 宠物清单元数据（pet.json + 安装位置）。 */
export type PetManifest = {
  /** 宠物唯一标识 */
  id: string;
  /** 展示名称 */
  displayName: string;
  /** 宠物描述 */
  description: string;
  /** 精灵图文件名（相对宠物目录） */
  spritesheetFile: string;
  /** 宠物目录绝对路径 */
  dirPath: string;
  /** 精灵图绝对路径 */
  spritesheetPath: string;
  /** 来源："snow"（Snow App 安装）| "codex"（Codex App）| "petdex"（Petdex） */
  source: string;
  /** 精灵图版本：1 = 9 行标准网格，2 = 11 行（Hatch Pet v2） */
  version: number;
  /** 精灵图列数（标准为 8） */
  columns: number;
  /** 精灵图行数 */
  rows: number;
  /** 是否为应用内置宠物（内置宠物不可卸载） */
  builtin: boolean;
};

/** 桌面宠物设置。 */
export type PetSettings = {
  /** 是否唤醒宠物（显示宠物窗口） */
  enabled: boolean;
  /** 当前激活的宠物 id（null 表示未选择） */
  activePetId: string | null;
  /** 显示缩放（0.5 ~ 2） */
  scale: number;
  /** 动画播放速度倍率（0.5 ~ 2） */
  speed: number;
  /** 宠物聊天使用的 API 配置名（null = 跟随当前激活配置） */
  apiProfile: string | null;
  /** 宠物聊天使用的模型 id（null = 跟随所选配置的高级模型） */
  model: string | null;
  /**
   * 宠物聊天人设自定义：宠物 id → 人设文本。缺省（无该键或空串）时
   * 回落宠物包 pet.json 的 description。
   */
  personas: Record<string, string>;
};

/** 宠物活动状态（与 Codex 宠物状态语义一致）。 */
export type PetActivityState =
  "idle" | "busy" | "review" | "waiting" | "error" | "completed";

/** AI 回合类型：普通对话 / 代码审查（review 播放专属动画行）。 */
export type PetTurnKind = "chat" | "review";

/** 宠物窗口形态：精灵（桌面宠物）/ 聊天（双击变形后的小对话窗口）。 */
export type PetWindowMode = "sprite" | "chat";

/** 宠物聊天所依据的「当前打开的会话」；全为 null 时即纯闲聊。 */
export type PetChatContext = {
  conversationId: string | null;
  title: string | null;
  /** 会话所属项目的 directoryId：宠物工具调用的项目锚点。 */
  directoryId: string | null;
};

/** 会话里一次工具调用的单行摘要（参数 / 结果均已截断）。 */
export type PetChatToolLine = {
  name: string;
  /** 参数摘要，如 `npm run build`、`src/main/pets/petChat.ts` */
  detail: string;
  status: "pending" | "running" | "completed" | "error";
  /** 结果摘要（单行，可能为空） */
  result?: string;
};

/** 会话里的一条消息（含在途内容与工具调用）。 */
export type PetChatLiveMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  tools?: PetChatToolLine[];
};

/**
 * 当前打开会话的实时快照：渲染层节流上报，让宠物的 btw 提问能看到
 * 「正在做什么步骤、用了哪些工具、结果如何、待办进度」等真实运行信息，
 * 而不是只有落库后的对话文本。
 */
export type PetChatSnapshot = {
  conversationId: string | null;
  title: string | null;
  /** 会话所属项目的 directoryId：宠物工具调用的项目锚点。 */
  directoryId: string | null;
  workspacePath: string | null;
  model: string | null;
  status: "idle" | "streaming" | "paused";
  messages: PetChatLiveMessage[];
  /** 待办进度摘要（如 `3/7 done · in progress: ...`），无待办时 null */
  todoSummary: string | null;
  updatedAt: number;
};

/** 宠物聊天窗口界面文案（由主进程按当前语言下发）。 */
export type PetChatLabels = {
  placeholder: string;
  send: string;
  stop: string;
  newChat: string;
  close: string;
  thinking: string;
  error: string;
  hintContext: string;
  hintFree: string;
  hintTitle: string;
  /** 工具执行中的状态行文案（联网搜索 / 文件搜索 / 文件阅读） */
  toolRunning: string;
};

/** 宠物窗口启动配置。 */
export type PetWindowConfig = {
  settings: PetSettings;
  manifest: PetManifest | null;
  mode: PetWindowMode;
  chatContext: PetChatContext;
  labels: PetChatLabels;
};

/** 宠物聊天的界面消息（仅存在于宠物窗口中，不落库）。 */
export type PetChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done" | "error";
};

/** 宠物聊天流式分片事件。 */
export type PetChatChunkPayload = {
  requestId: string;
  contentDelta: string;
};

/** 宠物聊天工具活动事件（驱动「正在搜索…」状态行）。 */
export type PetChatToolPayload = {
  requestId: string;
  /** 工具全名（如 `websearch-websearch-search`）。 */
  name: string;
  /** 参数摘要（如搜索词、文件路径），可能为空。 */
  detail: string;
  status: "running" | "completed" | "error";
};

/** 宠物聊天请求结果。 */
export type PetChatResult = {
  content: string;
};

/**
 * 宠物聊天的一条既往对话（仅存在于宠物窗口内存中）。
 * 每次提问都把当前对话回传给主进程，让宠物记得自己刚才说过什么。
 */
export type PetChatHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};
