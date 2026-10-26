import type { SubAgentExecutionMode } from "../../../../../shared/subAgentRuns";

const SUB_AGENT_EXECUTION_MODE_SETTING = "sub_agent_execution_mode";

/** The user's default mode, used when a dispatch omits its own executionMode.
 *  Read on each dispatch so detached windows do not retain a stale default. */
export const loadSubAgentExecutionMode =
  async (): Promise<SubAgentExecutionMode> => {
    const value = await window.snow.getSystemSettingValue(
      SUB_AGENT_EXECUTION_MODE_SETTING,
    );
    if (value == null || value === "") return "sync";
    if (value === "sync" || value === "async") return value;
    throw new Error(
      "CONFIGURATION_ERROR: invalid sub-agent execution mode setting",
    );
  };

export const saveSubAgentExecutionMode = async (
  mode: SubAgentExecutionMode,
): Promise<void> => {
  if (mode !== "sync" && mode !== "async")
    throw new Error("VALIDATION_ERROR: executionMode must be sync or async");
  await window.snow.setSystemSetting(
    "Sub-agent execution mode",
    SUB_AGENT_EXECUTION_MODE_SETTING,
    mode,
  );
};
