import {
  callSnow,
  l10n,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireBoolean,
  requireNumber,
  requireRecord,
  requireString,
  requireStringArray,
} from "../helpers";
import type { PluginWriteActionDefinition } from "../types";

const GLOBAL_PROJECT_SCOPES = new Set(["global", "project"]);

export const CONFIG_WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  {
    domain: "apiProfiles",
    action: "upsert",
    scope: "apiKeys",
    summary: l10n("Save an API profile", "保存 API 档案", "儲存 API 檔案"),
    invoke: async ({ params }) => {
      const config = requireRecord(params, "config");
      return await callSnow("upsertApiConfig", config);
    },
  },
  {
    domain: "apiProfiles",
    action: "remove",
    scope: "apiKeys",
    summary: l10n("Delete an API profile", "删除 API 档案", "刪除 API 檔案"),
    invoke: async ({ params }) => {
      const profileName = requireString(params, "profileName");
      return await callSnow("deleteApiConfig", profileName);
    },
  },
  {
    domain: "apiProfiles",
    action: "reorder",
    scope: "apiKeys",
    summary: l10n(
      "Reorder API profiles",
      "调整 API 档案顺序",
      "調整 API 檔案順序",
    ),
    invoke: async ({ params }) => {
      const orderedProfileNames = requireStringArray(
        params,
        "orderedProfileNames",
      );
      return await callSnow("reorderApiConfigs", orderedProfileNames);
    },
  },

  {
    domain: "systemPrompts",
    action: "upsert",
    scope: "systemPrompts",
    summary: l10n("Save a system prompt", "保存系统提示词", "儲存系統提示詞"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      await callSnow("upsertSystemPrompt", item);
      return item;
    },
  },
  {
    domain: "systemPrompts",
    action: "remove",
    scope: "systemPrompts",
    summary: l10n("Delete a system prompt", "删除系统提示词", "刪除系統提示詞"),
    invoke: async ({ params }) => {
      const promptId = requireString(params, "promptId");
      await callSnow("deleteSystemPrompt", promptId);
      return { promptId };
    },
  },

  {
    domain: "customHeaders",
    action: "upsert",
    scope: "customHeaders",
    summary: l10n("Save a header scheme", "保存请求头方案", "儲存請求標頭方案"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      return await callSnow("upsertCustomHeaderScheme", item);
    },
  },
  {
    domain: "customHeaders",
    action: "remove",
    scope: "customHeaders",
    summary: l10n(
      "Delete a header scheme",
      "删除请求头方案",
      "刪除請求標頭方案",
    ),
    invoke: async ({ params }) => {
      const schemeId = requireString(params, "schemeId");
      return await callSnow("deleteCustomHeaderScheme", schemeId);
    },
  },

  {
    domain: "customCommands",
    action: "upsert",
    scope: null,
    summary: l10n("Save a custom command", "保存自定义命令", "儲存自訂命令"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      await callSnow("upsertCustomCommand", item);
      return item;
    },
  },
  {
    domain: "customCommands",
    action: "remove",
    scope: null,
    summary: l10n("Delete a custom command", "删除自定义命令", "刪除自訂命令"),
    invoke: async ({ params }) => {
      const commandId = requireString(params, "commandId");
      await callSnow("deleteCustomCommand", commandId);
      return { commandId };
    },
  },

  {
    domain: "mcp",
    action: "upsert",
    scope: "mcpSecrets",
    summary: l10n("Save an MCP server", "保存 MCP 服务器", "儲存 MCP 伺服器"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      return await callSnow("upsertMcpServerConfig", item);
    },
  },
  {
    domain: "mcp",
    action: "remove",
    scope: "mcpSecrets",
    summary: l10n("Delete an MCP server", "删除 MCP 服务器", "刪除 MCP 伺服器"),
    invoke: async ({ params }) => {
      const serverId = requireString(params, "serverId");
      return await callSnow("deleteMcpServerConfig", serverId);
    },
  },
  {
    domain: "mcp",
    action: "upsertProject",
    scope: "mcpSecrets",
    summary: l10n(
      "Save a project MCP server",
      "保存项目 MCP 服务器",
      "儲存專案 MCP 伺服器",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const item = requireRecord(params, "item");
      return await callSnow("upsertProjectMcpServerConfig", projectId, item);
    },
  },
  {
    domain: "mcp",
    action: "removeProject",
    scope: "mcpSecrets",
    summary: l10n(
      "Delete a project MCP server",
      "删除项目 MCP 服务器",
      "刪除專案 MCP 伺服器",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const serverId = requireString(params, "serverId");
      return await callSnow(
        "deleteProjectMcpServerConfig",
        projectId,
        serverId,
      );
    },
  },
  {
    domain: "mcp",
    action: "setToolEnabled",
    scope: "mcpSecrets",
    summary: l10n(
      "Enable or disable an MCP tool",
      "启用或停用 MCP 工具",
      "啟用或停用 MCP 工具",
    ),
    invoke: async ({ params }) => {
      const toolName = requireString(params, "toolName");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setMcpToolEnabled", toolName, enabled);
      return { toolName, enabled };
    },
  },
  {
    domain: "mcp",
    action: "setToolsEnabled",
    scope: "mcpSecrets",
    summary: l10n(
      "Enable or disable MCP tools",
      "批量启停 MCP 工具",
      "批次啟停 MCP 工具",
    ),
    invoke: async ({ params }) => {
      const toolNames = requireStringArray(params, "toolNames");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setMcpToolsEnabled", toolNames, enabled);
      return { toolNames, enabled };
    },
  },
  {
    domain: "mcp",
    action: "setProjectServerEnabled",
    scope: "mcpSecrets",
    summary: l10n(
      "Enable or disable a project MCP server",
      "启用或停用项目 MCP 服务器",
      "啟用或停用專案 MCP 伺服器",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const serverId = requireString(params, "serverId");
      const enabled = requireBoolean(params, "enabled");
      await callSnow(
        "setMcpProjectServerEnabled",
        projectId,
        serverId,
        enabled,
      );
      return { projectId, serverId, enabled };
    },
  },
  {
    domain: "mcp",
    action: "setProjectToolEnabled",
    scope: "mcpSecrets",
    summary: l10n(
      "Enable or disable a project MCP tool",
      "启用或停用项目 MCP 工具",
      "啟用或停用專案 MCP 工具",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const toolName = requireString(params, "toolName");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setMcpProjectToolEnabled", projectId, toolName, enabled);
      return { projectId, toolName, enabled };
    },
  },

  {
    domain: "lsp",
    action: "upsert",
    scope: null,
    summary: l10n("Save an LSP server", "保存 LSP 服务器", "儲存 LSP 伺服器"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      return await callSnow("upsertLspServerConfig", item);
    },
  },
  {
    domain: "lsp",
    action: "remove",
    scope: null,
    summary: l10n("Delete an LSP server", "删除 LSP 服务器", "刪除 LSP 伺服器"),
    invoke: async ({ params }) => {
      const lang = requireString(params, "lang");
      return await callSnow("deleteLspServerConfig", lang);
    },
  },
  {
    domain: "lsp",
    action: "upsertProject",
    scope: null,
    summary: l10n(
      "Save a project LSP server",
      "保存项目 LSP 服务器",
      "儲存專案 LSP 伺服器",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const item = requireRecord(params, "item");
      return await callSnow("upsertProjectLspServerConfig", projectId, item);
    },
  },
  {
    domain: "lsp",
    action: "removeProject",
    scope: null,
    summary: l10n(
      "Delete a project LSP server",
      "删除项目 LSP 服务器",
      "刪除專案 LSP 伺服器",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const lang = requireString(params, "lang");
      return await callSnow("deleteProjectLspServerConfig", projectId, lang);
    },
  },

  {
    domain: "subAgents",
    action: "upsert",
    scope: "subAgents",
    summary: l10n("Save a sub-agent", "保存子代理", "儲存子代理"),
    invoke: async ({ params }) => {
      const projectId = optionalString(params, "projectId");
      const item = requireRecord(params, "item");
      return await callSnow("upsertSubAgentConfig", projectId, item);
    },
  },
  {
    domain: "subAgents",
    action: "remove",
    scope: "subAgents",
    summary: l10n("Delete a sub-agent", "删除子代理", "刪除子代理"),
    invoke: async ({ params }) => {
      const agentId = requireString(params, "agentId");
      const projectId = optionalString(params, "projectId");
      return await callSnow("deleteSubAgentConfig", agentId, projectId);
    },
  },

  {
    domain: "hooks",
    action: "upsert",
    scope: null,
    summary: l10n("Save a hook config", "保存 Hook 配置", "儲存 Hook 設定"),
    invoke: async ({ params }) => {
      const item = requireRecord(params, "item");
      await callSnow("upsertHookConfig", item);
      return item;
    },
  },
  {
    domain: "hooks",
    action: "remove",
    scope: null,
    summary: l10n("Delete a hook config", "删除 Hook 配置", "刪除 Hook 設定"),
    invoke: async ({ params }) => {
      const hookType = requireString(params, "hookType");
      const scope = requireString(params, "scope");
      if (!GLOBAL_PROJECT_SCOPES.has(scope)) {
        throw new Error("Parameter 'scope' must be 'global' or 'project'");
      }
      const projectId = optionalString(params, "projectId");
      await callSnow("deleteHookConfig", hookType, scope, projectId);
      return { hookType, scope, projectId };
    },
  },

  {
    domain: "skills",
    action: "setEnabled",
    scope: null,
    summary: l10n(
      "Enable or disable a skill",
      "启用或停用技能",
      "啟用或停用技能",
    ),
    invoke: async ({ params }) => {
      const projectId = optionalString(params, "projectId");
      const skillId = requireString(params, "skillId");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setSkillEnabled", projectId, skillId, enabled);
      return { projectId, skillId, enabled };
    },
  },
  {
    domain: "skills",
    action: "setProjectEnabled",
    scope: null,
    summary: l10n(
      "Enable or disable a project skill",
      "启用或停用项目技能",
      "啟用或停用專案技能",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const skillId = requireString(params, "skillId");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setProjectSkillEnabled", projectId, skillId, enabled);
      return { projectId, skillId, enabled };
    },
  },
  {
    domain: "skills",
    action: "installGithub",
    scope: null,
    summary: l10n(
      "Install a skill from GitHub",
      "从 GitHub 安装技能",
      "從 GitHub 安裝技能",
    ),
    invoke: async ({ params }) => {
      const url = requireString(params, "url");
      const location = requireString(params, "location");
      if (!GLOBAL_PROJECT_SCOPES.has(location)) {
        throw new Error("Parameter 'location' must be 'global' or 'project'");
      }
      const projectId = optionalString(params, "projectId");
      return await callSnow("installSkillFromGithub", url, location, projectId);
    },
  },
  {
    domain: "skills",
    action: "uninstallGithub",
    scope: null,
    summary: l10n(
      "Uninstall a GitHub skill",
      "卸载 GitHub 技能",
      "解除安裝 GitHub 技能",
    ),
    invoke: async ({ params }) => {
      const skillId = requireString(params, "skillId");
      const projectId = optionalString(params, "projectId");
      return await callSnow("uninstallGithubSkill", skillId, projectId);
    },
  },

  {
    domain: "userscripts",
    action: "create",
    scope: "userscripts",
    summary: l10n("Create a userscript", "新建用户脚本", "新增使用者腳本"),
    invoke: async ({ params }) => {
      const raw = requireString(params, "raw");
      return await callSnow("createUserscript", raw);
    },
  },
  {
    domain: "userscripts",
    action: "update",
    scope: "userscripts",
    summary: l10n("Update a userscript", "更新用户脚本", "更新使用者腳本"),
    invoke: async ({ params }) => {
      const scriptId = requireString(params, "scriptId");
      const raw = requireString(params, "raw");
      return await callSnow("updateUserscript", scriptId, raw);
    },
  },
  {
    domain: "userscripts",
    action: "remove",
    scope: "userscripts",
    summary: l10n("Delete a userscript", "删除用户脚本", "刪除使用者腳本"),
    invoke: async ({ params }) => {
      const scriptId = requireString(params, "scriptId");
      await callSnow("deleteUserscript", scriptId);
      return { scriptId };
    },
  },
  {
    domain: "userscripts",
    action: "setEnabled",
    scope: "userscripts",
    summary: l10n(
      "Enable or disable a userscript",
      "启用或停用用户脚本",
      "啟用或停用使用者腳本",
    ),
    invoke: async ({ params }) => {
      const scriptId = requireString(params, "scriptId");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setUserscriptEnabled", scriptId, enabled);
      return { scriptId, enabled };
    },
  },
  {
    domain: "userscripts",
    action: "install",
    scope: "userscripts",
    summary: l10n("Install a userscript", "安装用户脚本", "安裝使用者腳本"),
    invoke: async ({ params }) => {
      const codeUrl = requireString(params, "codeUrl");
      return await callSnow("installUserscript", codeUrl);
    },
  },

  {
    domain: "appSettings",
    action: "setLiteMode",
    scope: null,
    summary: l10n("Set the lite mode", "设置精简模式", "設定精簡模式"),
    invoke: async ({ params }) => {
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setLiteMode", enabled);
      return { enabled };
    },
  },
  {
    domain: "appSettings",
    action: "setAutoFormat",
    scope: null,
    summary: l10n("Set the auto format", "设置自动格式化", "設定自動格式化"),
    invoke: async ({ params }) => {
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setAutoFormat", enabled);
      return { enabled };
    },
  },
  {
    domain: "appSettings",
    action: "setImageLibraryDir",
    scope: null,
    summary: l10n(
      "Set the image library directory",
      "设置图库保存目录",
      "設定圖庫儲存目錄",
    ),
    invoke: async ({ params }) => {
      const dir = optionalString(params, "dir") ?? "";
      await callSnow("setImageLibraryDir", dir);
      return { dir };
    },
  },
  {
    domain: "appSettings",
    action: "setSystemSetting",
    scope: null,
    summary: l10n("Write a system setting", "写入系统设置", "寫入系統設定"),
    invoke: async ({ params }) => {
      const settingName = requireString(params, "settingName");
      const settingCode = requireString(params, "settingCode");
      const settingValue = optionalString(params, "settingValue") ?? "";
      await callSnow(
        "setSystemSetting",
        settingName,
        settingCode,
        settingValue,
      );
      return { settingName, settingCode, settingValue };
    },
  },

  {
    domain: "theme",
    action: "setSettings",
    scope: "privacyConfig",
    summary: l10n("Save the theme settings", "保存主题设置", "儲存主題設定"),
    invoke: async ({ params }) => {
      const settings = requireRecord(params, "settings");
      await callSnow("setThemeSettings", settings);
      return settings;
    },
  },
  {
    domain: "theme",
    action: "setBackgroundColor",
    scope: "privacyConfig",
    summary: l10n(
      "Set the theme background",
      "设置主题背景色",
      "設定主題背景色",
    ),
    invoke: async ({ params }) => {
      const color = requireString(params, "color");
      await callSnow("setThemeBackgroundColor", color);
      return { color };
    },
  },

  {
    domain: "keyboardShortcuts",
    action: "set",
    scope: null,
    summary: l10n(
      "Save keyboard shortcuts",
      "保存快捷键设置",
      "儲存快速鍵設定",
    ),
    invoke: async ({ params }) => {
      const settings = requireRecord(params, "settings");
      await callSnow("setKeyboardShortcutsSettings", settings);
      return settings;
    },
  },

  {
    domain: "privacy",
    action: "set",
    scope: "privacyConfig",
    summary: l10n("Save the privacy settings", "保存隐私设置", "儲存隱私設定"),
    invoke: async ({ params }) => {
      const settings = requireRecord(params, "settings");
      await callSnow("setPrivacySettings", settings);
      return settings;
    },
  },

  {
    domain: "personalization",
    action: "saveRole",
    scope: "personalization",
    summary: l10n(
      "Save the global role",
      "保存全局角色规则",
      "儲存全域角色規則",
    ),
    invoke: async ({ params }) => {
      const content = requireString(params, "content");
      await callSnow("saveGlobalRole", content);
      return { content };
    },
  },

  {
    domain: "codebase",
    action: "setProjectEnabled",
    scope: null,
    summary: l10n(
      "Enable or disable project indexing",
      "启用或停用项目索引",
      "啟用或停用專案索引",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setCodebaseProjectEnabled", projectId, enabled);
      return { projectId, enabled };
    },
  },
  {
    domain: "codebase",
    action: "setProjectAgentReview",
    scope: null,
    summary: l10n(
      "Set the project agent review",
      "设置项目代理复核",
      "設定專案代理複核",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const flag = requireBoolean(params, "flag");
      await callSnow("setCodebaseProjectAgentReview", projectId, flag);
      return { projectId, flag };
    },
  },
  {
    domain: "codebase",
    action: "setProjectReranking",
    scope: null,
    summary: l10n(
      "Set the project reranking",
      "设置项目重排序",
      "設定專案重排序",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const flag = requireBoolean(params, "flag");
      await callSnow("setCodebaseProjectReranking", projectId, flag);
      return { projectId, flag };
    },
  },
  {
    domain: "codebase",
    action: "startIndex",
    scope: null,
    summary: l10n(
      "Start indexing a project",
      "开始建立项目索引",
      "開始建立專案索引",
    ),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      const sessionId = requireString(params, "sessionId");
      await callSnow("startCodebaseEmbedding", projectId, sessionId);
      return { projectId, sessionId };
    },
  },
  {
    domain: "codebase",
    action: "pauseIndex",
    scope: null,
    summary: l10n("Pause an index session", "暂停索引会话", "暫停索引工作階段"),
    invoke: async ({ params }) => {
      const sessionId = requireString(params, "sessionId");
      return await callSnow("pauseCodebaseEmbedding", sessionId);
    },
  },
  {
    domain: "codebase",
    action: "resumeIndex",
    scope: null,
    summary: l10n(
      "Resume an index session",
      "恢复索引会话",
      "恢復索引工作階段",
    ),
    invoke: async ({ params }) => {
      const sessionId = requireString(params, "sessionId");
      return await callSnow("resumeCodebaseEmbedding", sessionId);
    },
  },
  {
    domain: "codebase",
    action: "cancelIndex",
    scope: null,
    summary: l10n(
      "Cancel an index session",
      "取消索引会话",
      "取消索引工作階段",
    ),
    invoke: async ({ params }) => {
      const sessionId = requireString(params, "sessionId");
      return await callSnow("cancelCodebaseEmbedding", sessionId);
    },
  },
  {
    domain: "codebase",
    action: "clearIndex",
    scope: null,
    summary: l10n("Clear a project index", "清空项目索引", "清空專案索引"),
    invoke: async ({ params }) => {
      const projectId = requireString(params, "projectId");
      await callSnow("clearCodebaseIndex", projectId);
      return { projectId };
    },
  },

  {
    domain: "usage",
    action: "removeRecords",
    scope: "usage",
    summary: l10n("Delete usage records", "删除用量记录", "刪除用量記錄"),
    invoke: async ({ params }) => {
      const since = optionalString(params, "since") ?? "";
      const until = optionalString(params, "until") ?? "";
      return await callSnow("deleteUsageRecords", since, until);
    },
  },

  {
    domain: "logs",
    action: "clear",
    scope: "logs",
    summary: l10n("Clear the application logs", "清空应用日志", "清空應用日誌"),
    invoke: async () => await callSnow("clearAppLogs"),
  },

  {
    domain: "pets",
    action: "installZip",
    scope: null,
    summary: l10n(
      "Install a pet from a zip",
      "从压缩包安装宠物",
      "從壓縮檔安裝寵物",
    ),
    invoke: async () => await callSnow("installPetFromZip"),
  },
  {
    domain: "pets",
    action: "uninstall",
    scope: null,
    summary: l10n("Uninstall a pet", "卸载宠物", "解除安裝寵物"),
    invoke: async ({ params }) => {
      const petId = requireString(params, "petId");
      await callSnow("uninstallPet", petId);
      return { petId };
    },
  },
  {
    domain: "pets",
    action: "setEnabled",
    scope: null,
    summary: l10n("Show or hide the pet", "显示或收起宠物", "顯示或收起寵物"),
    invoke: async ({ params }) => {
      const enabled = requireBoolean(params, "enabled");
      return await callSnow("setPetEnabled", enabled);
    },
  },
  {
    domain: "pets",
    action: "setActive",
    scope: null,
    summary: l10n("Select the active pet", "选择激活的宠物", "選擇啟用的寵物"),
    invoke: async ({ params }) => {
      const petId = requireString(params, "petId");
      return await callSnow("setActivePet", petId);
    },
  },
  {
    domain: "pets",
    action: "setScale",
    scope: null,
    summary: l10n("Set the pet scale", "设置宠物缩放", "設定寵物縮放"),
    invoke: async ({ params }) => {
      const scale = requireNumber(params, "scale");
      return await callSnow("setPetScale", scale);
    },
  },

  {
    domain: "requests",
    action: "setLogging",
    scope: null,
    summary: l10n(
      "Enable or disable request logging",
      "启用或停用请求日志",
      "啟用或停用請求日誌",
    ),
    invoke: async ({ params }) => {
      const enabled = requireBoolean(params, "enabled");
      await callSnow("setRequestLogging", enabled);
      return { enabled };
    },
  },
  {
    domain: "requests",
    action: "setExpiry",
    scope: null,
    summary: l10n(
      "Set the request logging expiry",
      "设置请求日志到期时间",
      "設定請求日誌到期時間",
    ),
    invoke: async ({ params }) => {
      const expiresAtMs = requireNumber(params, "expiresAtMs");
      await callSnow("setRequestLoggingExpiry", expiresAtMs);
      return { expiresAtMs };
    },
  },

  {
    domain: "conversationSettings",
    action: "setModes",
    scope: "conversations",
    summary: l10n(
      "Update conversation modes",
      "更新会话模式",
      "更新工作階段模式",
    ),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const planMode = optionalBoolean(params, "planMode") ?? null;
      const goalMode = optionalBoolean(params, "goalMode") ?? null;
      const worktreeMode = optionalBoolean(params, "worktreeMode") ?? null;
      const workflowMode = optionalBoolean(params, "workflowMode") ?? null;
      const goalModeTokenBudget =
        optionalNumber(params, "goalModeTokenBudget") ?? null;
      await callSnow(
        "setConversationModes",
        conversationId,
        planMode,
        goalMode,
        worktreeMode,
        workflowMode,
        goalModeTokenBudget,
      );
      return {
        conversationId,
        planMode,
        goalMode,
        worktreeMode,
        workflowMode,
        goalModeTokenBudget,
      };
    },
  },
  {
    domain: "conversationSettings",
    action: "setRuntime",
    scope: "conversations",
    summary: l10n(
      "Update conversation runtime config",
      "更新会话运行时设置",
      "更新工作階段執行設定",
    ),
    invoke: async ({ params }) => {
      const conversationId = requireString(params, "conversationId");
      const thinkingStrength =
        optionalString(params, "thinkingStrength") ?? null;
      const responsesFastMode =
        optionalBoolean(params, "responsesFastMode") ?? null;
      await callSnow(
        "setConversationRuntimeConfig",
        conversationId,
        thinkingStrength,
        responsesFastMode,
      );
      return { conversationId, thinkingStrength, responsesFastMode };
    },
  },
];
