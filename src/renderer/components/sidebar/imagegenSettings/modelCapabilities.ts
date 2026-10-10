import { IMAGE_GEN_TEMPLATES } from "./constants";
import type { ImageGenProvider } from "./types";

/**
 * 单个生图模型的能力描述（默认参数 + 支持范围），用于在用户选择/输入
 * 模型 ID 后自动带出「默认尺寸 / 默认质量 / 默认思考强度 / 支持宽高比 /
 * 支持分辨率 / 支持思考强度」等字段。
 *
 * 数据来源：
 * 1. 由 IMAGE_GEN_TEMPLATES 派生（模板本身就是权威的官方能力快照，避免
 *    能力库与模板两份数据不同步）；
 * 2. EXTRA_MODEL_CAPABILITIES 补充模板未覆盖的主流模型。
 */
export type ImageGenModelCapability = {
  /** 匹配片段（小写）：模型 ID 包含该片段即命中，取最长命中项。 */
  match: string;
  /** 能力来源展示名（用于提示「已套用 xx 能力」）。 */
  label: string;
  /** 协议归属（决定联网搜索等协议级能力）。 */
  provider: ImageGenProvider;
  defaultSize: string;
  defaultQuality: string;
  defaultThinking: string;
  supportedRatios: string;
  supportedResolutions: string;
  supportedThinking: string;
  /** 是否支持联网搜索（仅 Gemini 原生协议的 google_search grounding 生效）。 */
  webSearch: boolean;
};

/** 由预设模板派生的能力表（模板即官方能力快照）。 */
const TEMPLATE_CAPABILITIES: ImageGenModelCapability[] =
  IMAGE_GEN_TEMPLATES.map((template) => ({
    match: template.model.toLowerCase(),
    label: template.name,
    provider: template.provider,
    defaultSize: template.defaultSize ?? "",
    defaultQuality: template.defaultQuality ?? "",
    defaultThinking: template.defaultThinking ?? "",
    supportedRatios: template.supportedRatios ?? "",
    supportedResolutions: template.supportedResolutions ?? "",
    supportedThinking: template.supportedThinking ?? "",
    webSearch: template.webSearch ?? false,
  }));

/**
 * 模板未覆盖的主流模型能力补充表。
 * 只登记公开且稳定的能力，未收录的模型返回 null（面板不自动填充）。
 */
const EXTRA_MODEL_CAPABILITIES: ImageGenModelCapability[] = [
  // --- OpenAI gpt-image 2.5 通用（sunburst / flare 之外的 2.5 命名） ---
  {
    match: "gpt-image-2.5",
    label: "GPT Image 2.5",
    provider: "openai",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    defaultThinking: "medium",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 21:9, 5:4, 4:5",
    supportedResolutions: "1K (1792x1008), 2K (2560x1440), 4K (3840x2160)",
    supportedThinking: "low, medium, high",
    webSearch: false,
  },
  // --- OpenAI gpt-image 1.x / 经典系列 ---
  {
    match: "gpt-image-1.5",
    label: "GPT Image 1.5",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "high",
    defaultThinking: "",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "gpt-image-1-mini",
    label: "GPT Image 1 Mini",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "medium",
    defaultThinking: "",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "gpt-image-1",
    label: "GPT Image 1",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "high",
    defaultThinking: "",
    supportedRatios: "1:1, 3:2, 2:3",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "chatgpt-image-latest",
    label: "ChatGPT Image (latest)",
    provider: "openai",
    defaultSize: "1792x1008",
    defaultQuality: "high",
    defaultThinking: "medium",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 21:9, 5:4, 4:5",
    supportedResolutions: "1K (1792x1008), 2K (2560x1440), 4K (3840x2160)",
    supportedThinking: "low, medium, high",
    webSearch: false,
  },
  {
    match: "dall-e-2",
    label: "DALL·E 2",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "standard",
    defaultThinking: "",
    supportedRatios: "1:1",
    supportedResolutions: "256x256, 512x512, 1024x1024",
    supportedThinking: "",
    webSearch: false,
  },
  // --- 国产 / 开源主流 ---
  {
    match: "qwen-image-2.1-turbo",
    label: "Qwen Image 2.1 Turbo",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    defaultThinking: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1280x720, 720x1280",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "wanx2.1-t2i-turbo",
    label: "Wanx 2.1 Turbo",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    defaultThinking: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1280x720, 720x1280",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "flux-1.1-ultra",
    label: "FLUX 1.1 Ultra",
    provider: "openai",
    defaultSize: "1536x1024",
    defaultQuality: "",
    defaultThinking: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9",
    supportedResolutions: "1024x1024, 1536x1024, 1024x1536, 2048x2048",
    supportedThinking: "",
    webSearch: false,
  },
  {
    match: "cogview-4",
    label: "CogView-4 (智谱最新)",
    provider: "openai",
    defaultSize: "1024x1024",
    defaultQuality: "",
    defaultThinking: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 21:9",
    supportedResolutions:
      "1024x1024, 768x1344 (9:16), 1344x768 (16:9), 864x1152 (3:4), 1152x864 (4:3), 1440x720 (2:1)",
    supportedThinking: "",
    webSearch: false,
  },
  // --- Gemini 预览版 / 旧版（复用对应正式版能力） ---
  {
    match: "gemini-3.1-flash-image-preview",
    label: "Nano Banana 2 (Preview)",
    provider: "gemini",
    defaultSize: "16:9@2K",
    defaultThinking: "minimal",
    defaultQuality: "",
    supportedRatios:
      "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 1:4, 1:8, 4:1, 8:1",
    supportedResolutions: "512px, 1K, 2K, 4K (支持 16:9@2K 组合语法)",
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "gemini-3-pro-image-preview",
    label: "Nano Banana Pro (Preview)",
    provider: "gemini",
    defaultSize: "16:9@2K",
    defaultThinking: "high",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K, 2K, 4K (支持 16:9@2K 组合语法)",
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "gemini-3.1-flash-lite-image",
    label: "Nano Banana 2 Lite",
    provider: "gemini",
    defaultSize: "16:9@1K",
    defaultThinking: "minimal",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9",
    supportedResolutions: "1K",
    supportedThinking: "minimal, high",
    webSearch: true,
  },
  {
    match: "imagen",
    label: "Imagen (Google)",
    provider: "gemini",
    defaultSize: "1024x1024",
    defaultThinking: "",
    defaultQuality: "",
    supportedRatios: "1:1, 16:9, 9:16, 4:3, 3:4",
    supportedResolutions: "1024x1024, 1408x768, 768x1408",
    supportedThinking: "",
    webSearch: false,
  },
];

/** 全部能力项（模板派生 + 补充表）。 */
export const MODEL_CAPABILITIES: ImageGenModelCapability[] = [
  ...TEMPLATE_CAPABILITIES,
  ...EXTRA_MODEL_CAPABILITIES,
];

/**
 * 按模型 ID 解析能力：子串匹配 + **最长命中**（与 Rust 侧
 * `find_model_config` 的匹配策略一致），保证 `gpt-image-2.5-sunburst`
 * 不会被更短的 `gpt-image-2.5` / `gpt-image-2` 抢先命中。
 *
 * 未收录的模型返回 null（面板不自动填充，保留用户手填内容）。
 */
export const resolveModelCapability = (
  modelId: string,
): ImageGenModelCapability | null => {
  const id = modelId.trim().toLowerCase();
  if (!id) {
    return null;
  }
  let best: ImageGenModelCapability | null = null;
  for (const capability of MODEL_CAPABILITIES) {
    if (!capability.match || !id.includes(capability.match)) {
      continue;
    }
    if (!best || capability.match.length > best.match.length) {
      best = capability;
    }
  }
  return best;
};

/**
 * 判断模型 ID 是否属于 Gemini 生图家族（Nano Banana / Imagen）。
 * 用于「联网搜索」等仅 Gemini 原生协议支持的能力提示。
 */
export const isGeminiFamilyModel = (modelId: string): boolean => {
  const id = modelId.trim().toLowerCase();
  if (!id) {
    return false;
  }
  return (
    id.includes("gemini") ||
    id.includes("banana") ||
    id.includes("imagen") ||
    id.includes("flash-image") ||
    id.includes("pro-image") ||
    id.includes("lite-image")
  );
};
