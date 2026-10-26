/** 进程内共享的 Web 搜索服务实例与命令分发。
 *
 * 搜索由 puppeteer 驱动系统浏览器执行，浏览器实例创建成本高（进程启动 +
 * DevTools 连接），因此整个主进程只保留一个服务实例：MCP 工具调用链与
 * 桌面宠物的旁路聊天共用同一个浏览器，避免各自启动一份。
 */
import type { NativeBridge, WebSearchCommand } from "../native/types";
import { WebSearchService } from "./webSearchService";

let instance: WebSearchService | null = null;

/** 取共享的 Web 搜索服务（首次调用时创建）。 */
export const getWebSearchService = (native: NativeBridge): WebSearchService => {
  if (!instance) {
    instance = new WebSearchService(native);
  }
  return instance;
};

/**
 * 应用退出时释放共享服务：关闭常驻的 headless 浏览器，
 * 避免残留 renderer / gpu 等子进程。
 */
export const disposeWebSearchService = async (): Promise<void> => {
  const service = instance;
  instance = null;
  if (service) {
    await service.dispose();
  }
};

/**
 * 执行 Rust 转发的 Web 搜索命令（puppeteer 驱动系统浏览器）。
 * 目前仅支持 websearch-search；未知操作返回错误。
 *
 * 除 query 外的参数（site / timeRange / language / engines）只做类型收敛，
 * 取值校验与规范化由 WebSearchService 负责，无法识别的值退化为默认行为。
 */
export const dispatchWebSearchCommand = async (
  native: NativeBridge,
  command: WebSearchCommand,
): Promise<string> => {
  const args = JSON.parse(command.argsJson) as {
    query?: unknown;
    maxResults?: unknown;
    site?: unknown;
    timeRange?: unknown;
    language?: unknown;
    engines?: unknown;
  };
  if (command.operation !== "websearch-search") {
    throw new Error(`Unknown web search operation: ${command.operation}`);
  }
  if (typeof args.query !== "string" || !args.query.trim()) {
    throw new Error('query is required for tool "websearch-search"');
  }
  const response = await getWebSearchService(native).search(args.query.trim(), {
    maxResults:
      typeof args.maxResults === "number" ? args.maxResults : undefined,
    site: typeof args.site === "string" ? args.site : undefined,
    timeRange: typeof args.timeRange === "string" ? args.timeRange : undefined,
    language: typeof args.language === "string" ? args.language : undefined,
    engineIds: Array.isArray(args.engines)
      ? args.engines.filter((id): id is string => typeof id === "string")
      : undefined,
  });
  return JSON.stringify(response);
};
