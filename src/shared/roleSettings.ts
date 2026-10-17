/**
 * ROLE 规则开关：`<scope>/.snow/settings.json` 中 `role` 对象的读写。
 *
 * 与 native/src/prompt/common.rs 的解析约定保持一致（兼容 Snow CLI）：
 * - `role.includeGlobalRules`：项目是否加载全局规则，缺省为 true（仅项目作用域使用）；
 * - `role.overrideRoleIds`：列表包含 ROLE.md 的角色 id（`active`）时，ROLE 规则覆盖
 *   内置系统提示词，且不再叠加 API 档案配置的系统提示词。
 */
export type RoleSettings = {
  includeGlobalRules: boolean;
  overrideBuiltinPrompt: boolean;
};

/** ROLE.md 在 `overrideRoleIds` 中对应的角色 id（ROLE-<id>.md 使用自身 id）。 */
const ACTIVE_ROLE_ID = "active";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOverrideRoleIds = (role: Record<string, unknown>): string[] =>
  Array.isArray(role.overrideRoleIds)
    ? role.overrideRoleIds.filter((id): id is string => typeof id === "string")
    : [];

/** 解析 settings.json 内容；空内容返回默认值，非法 JSON 抛出异常。 */
export const parseRoleSettings = (content: string): RoleSettings => {
  const settings: unknown = content.trim() ? JSON.parse(content) : {};
  const role =
    isRecord(settings) && isRecord(settings.role) ? settings.role : {};
  return {
    includeGlobalRules:
      typeof role.includeGlobalRules === "boolean"
        ? role.includeGlobalRules
        : true,
    overrideBuiltinPrompt: readOverrideRoleIds(role).includes(ACTIVE_ROLE_ID),
  };
};

/** 在保留其余字段的前提下写入指定开关，返回新的 settings.json 文本。 */
export const writeRoleSettings = (
  content: string,
  patch: Partial<RoleSettings>,
): string => {
  const parsed: unknown = content.trim() ? JSON.parse(content) : {};
  const settings = isRecord(parsed) ? parsed : {};
  const role: Record<string, unknown> = isRecord(settings.role)
    ? { ...settings.role }
    : {};

  if (patch.includeGlobalRules !== undefined) {
    role.includeGlobalRules = patch.includeGlobalRules;
  }
  if (patch.overrideBuiltinPrompt !== undefined) {
    const otherIds = readOverrideRoleIds(role).filter(
      (id) => id !== ACTIVE_ROLE_ID,
    );
    role.overrideRoleIds = patch.overrideBuiltinPrompt
      ? [...otherIds, ACTIVE_ROLE_ID]
      : otherIds;
  }

  return `${JSON.stringify({ ...settings, role }, null, 2)}\n`;
};
