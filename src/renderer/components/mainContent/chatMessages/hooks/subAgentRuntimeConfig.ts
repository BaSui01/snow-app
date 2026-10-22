import type {
  ApiConfigRecord,
  SubAgentConfigRecord,
  SubAgentUnavailableTool,
} from "../../../../../preload";
import {
  getResponsesFastModeFromConfig,
  resolveEffectiveThinkingValue,
} from "../../chatInput/configThinking";

export type SubAgentRuntimeConfig = {
  agentId: string;
  agentName: string;
  apiSource: "parent" | "agent";
  apiProfile: string;
  model: string;
  /** Inherited from the parent conversation's captured request. Undefined =
   *  let the selected profile use its own default. An explicit tier is kept. */
  responsesFastMode?: string;
  /** Effective thinking snapshot captured at sub-agent creation. Inherited
   *  from the parent run's per-send override when that tier is supported by
   *  the resolved profile's request method; otherwise the resolved profile's
   *  own configured value. Not a Profile write. */
  effectiveThinkingStrength: string;
  /** Effective Fast Mode snapshot captured at sub-agent creation. */
  effectiveResponsesFastMode: string;
  systemPrompt: string;
  toolsJson: string;
  /** 激活时诊断出的不可用白名单工具（回传主控并写入子代理提示词）。 */
  unavailableTools?: SubAgentUnavailableTool[];
};

/** 子代理提示词中的不可用工具说明；无不可用工具时返回空串。 */
export const buildUnavailableToolsPrompt = (
  tools: readonly SubAgentUnavailableTool[] | undefined,
): string =>
  tools?.length
    ? `## Unavailable Configured Tools\nThe following tools from your configuration are unavailable in this run and are NOT in your tool list. Do not try to call them; work with the tools you actually have, and mention the gap in your final summary if it blocks the task:\n${tools
        .map((tool) => `- ${tool.name} (${tool.reason})`)
        .join("\n")}`
    : "";

export type ResolveSubAgentRuntimeConfigInput = {
  config: SubAgentConfigRecord;
  apiConfigs: readonly ApiConfigRecord[];
  parentApiProfile?: string;
  parentModel?: string;
  /** Thinking strength captured by the parent run (conversation-level choice).
   *  An unsupported tier falls back to the resolved profile default. */
  parentThinkingStrength?: string | null;
  /** Effective Fast Mode captured by the parent run; an explicit tier is meaningful. */
  parentResponsesFastMode?: string | null;
};

const normalizeNonEmpty = (value: string | undefined): string =>
  value?.trim() ?? "";

const BUILTIN_GENERAL_AGENT_ID = "agent_general";

export const parseSubAgentTools = (toolsJson: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolsJson);
  } catch {
    throw new Error("Sub-agent toolsJson must be valid JSON");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((tool) => typeof tool !== "string" || !tool.trim())
  ) {
    throw new Error(
      "Sub-agent toolsJson must be an array of non-empty strings",
    );
  }

  return Array.from(new Set(parsed.map((tool) => tool.trim())));
};

export const resolveSubAgentRuntimeConfig = ({
  config,
  apiConfigs,
  parentApiProfile,
  parentModel,
  parentThinkingStrength,
  parentResponsesFastMode,
}: ResolveSubAgentRuntimeConfigInput): SubAgentRuntimeConfig => {
  const agentId = normalizeNonEmpty(config.agentId);
  const agentName = normalizeNonEmpty(config.name);
  if (!agentId || !agentName) {
    throw new Error("Sub-agent configuration requires a valid id and name");
  }

  const configuredTools = parseSubAgentTools(config.toolsJson);
  // 通配符仅限内置 agent_general（与 Rust 存储层保存校验一致）。
  if (agentId !== BUILTIN_GENERAL_AGENT_ID && configuredTools.includes("*")) {
    throw new Error(
      "Only the built-in agent_general may use the wildcard tool configuration",
    );
  }
  const configuredProfile = normalizeNonEmpty(config.configProfile);
  const inheritedProfile = normalizeNonEmpty(parentApiProfile);
  const apiSource = configuredProfile ? "agent" : "parent";
  const requestedProfile = configuredProfile || inheritedProfile;
  const apiConfig = requestedProfile
    ? apiConfigs.find((item) => item.profileName.trim() === requestedProfile)
    : apiConfigs.find((item) => item.isActive);

  if (!apiConfig) {
    if (configuredProfile) {
      throw new Error(
        `Sub-agent API profile is unavailable: ${configuredProfile}`,
      );
    }
    if (inheritedProfile) {
      throw new Error(`Parent API profile is unavailable: ${inheritedProfile}`);
    }
    throw new Error("No active API profile is available for the sub-agent");
  }

  const apiProfile = normalizeNonEmpty(apiConfig.profileName);
  if (!apiProfile) {
    throw new Error("Sub-agent API profile name is empty");
  }

  const configuredModel = normalizeNonEmpty(config.model);
  const inheritedModel = normalizeNonEmpty(parentModel);
  const model =
    apiSource === "agent"
      ? configuredModel || normalizeNonEmpty(apiConfig.advancedModel)
      : inheritedModel || normalizeNonEmpty(apiConfig.advancedModel);
  if (!model) {
    throw new Error(`No model is configured for API profile: ${apiProfile}`);
  }

  // 思考强度：优先沿用父会话（主流程）本次发送的显式选择——用户可能已在
  // 输入区把思考强度改成与 Profile 默认不同的档位，派生的子代理应保持一致；
  // 该档位不被解析后 Profile 的请求方法支持时，回落 Profile 自身配置值。
  const effectiveThinkingStrength = resolveEffectiveThinkingValue(
    apiConfig,
    parentThinkingStrength,
  );
  // Resolve effective values exactly once when this sub-agent runtime is built.
  // These are request snapshots, never mutations of the API Profile.
  const effectiveResponsesFastMode =
    parentResponsesFastMode ?? getResponsesFastModeFromConfig(apiConfig);

  return {
    agentId,
    agentName,
    apiSource,
    apiProfile,
    model,
    responsesFastMode: parentResponsesFastMode ?? undefined,
    effectiveThinkingStrength,
    effectiveResponsesFastMode,
    systemPrompt: config.systemPrompt.trim(),
    toolsJson: config.toolsJson,
  };
};
