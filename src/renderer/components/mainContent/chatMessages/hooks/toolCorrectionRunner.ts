/**
 * 工具失败纠错的执行器无关入口：主会话、子代理与 Workflow 节点共用。
 *
 * 各执行链路只需提供「如何授权 / 如何重新执行 / 如何刷新卡片」，
 * 开关判断、失败识别、纠错循环与落库（纠错树 + 修正参数）统一在此完成。
 */

import { isValidToolName } from "../utils/conversationHelpers";
import type {
  ToolCallInfo,
  ToolCorrectionState,
} from "../utils/conversationTypes";
import { ensureToolCorrectionPreference } from "../utils/toolCorrectionPreference";
import {
  detectToolFailure,
  isNonCorrectableToolFailure,
  isToolCorrectionEligible,
  runToolCorrection,
  serializeToolCorrectionState,
  type ToolCorrectionSuccess,
  type ToolCorrectionToolDefinition,
} from "./toolCorrection";

export type ToolDefinitionLookup = (
  toolName: string,
) => Promise<ToolCorrectionToolDefinition | null>;

/**
 * 工具 schema 惰性查询：只有失败的调用需要 schema，多数回合从不失败，
 * 因此首次纠错时才拉取一次工具列表并在该查询器生命周期内复用。
 */
export const createToolDefinitionLookup = (): ToolDefinitionLookup => {
  let definitionsPromise: Promise<
    Map<string, ToolCorrectionToolDefinition>
  > | null = null;
  return async (toolName) => {
    if (!definitionsPromise) {
      definitionsPromise = window.snow
        .listMcpTools()
        .then(
          (tools) =>
            new Map(
              tools.map(
                (tool) =>
                  [
                    tool.name,
                    {
                      description: tool.description,
                      inputSchemaJson: tool.inputSchemaJson,
                    },
                  ] as const,
              ),
            ),
        )
        .catch(() => new Map<string, ToolCorrectionToolDefinition>());
    }
    const definitions = await definitionsPromise;
    return definitions.get(toolName) ?? null;
  };
};

/**
 * 把纠错进度映射到工具卡片：成功时替换为修正后的参数与结果；
 * `settle` 为 true 时纠错失败恢复原始结果（调用方之后不再结算卡片），
 * 否则保持运行态，由调用方随后的常规结算写入最终结果。
 */
export const applyToolCorrectionToCall = (
  call: ToolCallInfo,
  correction: ToolCorrectionState,
  settle: boolean,
  originalResult: string,
): ToolCallInfo => {
  const succeeded = correction.attempts.find(
    (attempt) => attempt.status === "succeeded",
  );
  if (succeeded?.result !== undefined) {
    return {
      ...call,
      arguments: succeeded.arguments,
      result: succeeded.result,
      status: "completed",
      correction,
      streamingStdout: undefined,
      streamingStderr: undefined,
    };
  }
  if (settle) {
    return {
      ...call,
      result: originalResult,
      status: "completed",
      correction,
      streamingStdout: undefined,
      streamingStderr: undefined,
    };
  }
  return {
    ...call,
    status: "running",
    result: undefined,
    correction,
    streamingStdout: undefined,
    streamingStderr: undefined,
  };
};

export type FailedToolCorrectionOptions = {
  toolCall: ToolCallInfo;
  failedResult: string;
  /** 纠错请求使用该档案的基础模型；省略时由后端使用全局激活档案。 */
  apiProfile?: string;
  /** 已持久化的会话 ID；未落库的会话传 undefined（不写库）。 */
  conversationId?: string;
  /** 本轮助手响应 ID：与 callId 一起定位已存的工具调用。 */
  responseId?: string;
  getToolDefinition: ToolDefinitionLookup;
  /** 修正后的调用必须重新授权；入参是带独立 interactionId 的授权用调用。 */
  authorize: (authorizationCall: ToolCallInfo) => Promise<boolean>;
  execute: (argumentsJson: string) => Promise<string>;
  onUpdate: (correction: ToolCorrectionState) => void;
  isCancelled: () => boolean;
};

/**
 * 失败工具纠错入口：仅对可纠错的普通工具、在开关开启时触发，最多 3 次。
 * 成功返回修正后的参数与结果（并已把修正参数写回库中的工具调用，让下一轮
 * 请求看到它）；不可纠错或纠错失败返回 null，调用方继续使用原始错误。
 */
export const correctFailedToolCall = async (
  options: FailedToolCorrectionOptions,
): Promise<ToolCorrectionSuccess | null> => {
  const { toolCall, failedResult, conversationId, responseId } = options;
  if (
    !isToolCorrectionEligible(toolCall.name) ||
    !isValidToolName(toolCall.name) ||
    !(await ensureToolCorrectionPreference())
  ) {
    return null;
  }
  const failure = detectToolFailure(failedResult);
  if (!failure || isNonCorrectableToolFailure(failure)) {
    return null;
  }

  const callId = toolCall.callId;
  const persistTarget =
    conversationId && responseId && callId
      ? { conversationId, responseId, callId }
      : null;

  const outcome = await runToolCorrection({
    toolName: toolCall.name,
    originalArguments: toolCall.arguments,
    failedResult,
    apiProfile: options.apiProfile,
    conversationId,
    getToolDefinition: () => options.getToolDefinition(toolCall.name),
    requestCorrection: (request) => window.snow.correctToolCall(request),
    authorize: (argumentsJson, attempt) =>
      options.authorize({
        ...toolCall,
        arguments: argumentsJson,
        interactionId: `${toolCall.interactionId}-correction-${attempt}`,
        status: "pending",
        result: undefined,
        correction: undefined,
      }),
    execute: (argumentsJson) => options.execute(argumentsJson),
    onUpdate: (correction) => {
      options.onUpdate(correction);
      // 纠错树落库：应用重启后历史消息重建时仍能展开（审计）。
      if (persistTarget) {
        void window.snow
          .updateToolCallCorrection(
            persistTarget.conversationId,
            persistTarget.responseId,
            persistTarget.callId,
            serializeToolCorrectionState(correction),
          )
          .catch(() => undefined);
      }
    },
    isCancelled: options.isCancelled,
  });

  if (outcome && persistTarget) {
    await window.snow
      .updateToolCallArguments(
        persistTarget.conversationId,
        persistTarget.responseId,
        persistTarget.callId,
        outcome.arguments,
      )
      .catch(() => undefined);
  }
  return outcome;
};
