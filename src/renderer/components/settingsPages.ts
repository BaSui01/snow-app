import type { MainContentView } from "./mainContent/types";

/** 设置页在 TopBar 上的标题与副标题（原面板头部文案）。 */
export type SettingsPageMeta = {
  title: { key: string; defaultValue: string };
  description: { key: string; defaultValue: string };
};

export const SETTINGS_PAGE_META: Partial<
  Record<MainContentView, SettingsPageMeta>
> = {
  "general-settings": {
    title: {
      key: "settings.generalSettings",
      defaultValue: "General settings",
    },
    description: {
      key: "settings.generalSettingsInfo",
      defaultValue: "Language, version and update management.",
    },
  },
  "api-settings": {
    title: {
      key: "settings.apiTreeTitle",
      defaultValue: "API configuration",
    },
    description: {
      key: "settings.apiSettingsInfo",
      defaultValue: "Configure providers, models, and credentials.",
    },
  },
  "imagegen-settings": {
    title: {
      key: "settings.apiTreeTitle",
      defaultValue: "API configuration",
    },
    description: {
      key: "settings.apiSettingsInfo",
      defaultValue: "Configure providers, models, and credentials.",
    },
  },
  "image-library": {
    title: { key: "settings.imageLibrary", defaultValue: "Image library" },
    description: {
      key: "settings.imageLibraryDescription",
      defaultValue:
        "Manage AI-generated images (stored on disk; deleting one also removes it from conversations)",
    },
  },
  "browser-settings": {
    title: {
      key: "settings.browserSettingsTitle",
      defaultValue: "Browser settings",
    },
    description: {
      key: "settings.browserSettingsInfo",
      defaultValue:
        "Homepage, saved passwords and importing data from other browsers.",
    },
  },
  "browser-devices": {
    title: {
      key: "settings.browserSettingsTitle",
      defaultValue: "Browser settings",
    },
    description: {
      key: "settings.browserSettingsInfo",
      defaultValue:
        "Homepage, saved passwords and importing data from other browsers.",
    },
  },
  "proxy-browser-settings": {
    title: {
      key: "settings.proxyBrowserTitle",
      defaultValue: "Proxy and search engine",
    },
    description: {
      key: "settings.proxySettingsInfo",
      defaultValue: "Configure HTTP proxy and network access.",
    },
  },
  "codebase-settings": {
    title: {
      key: "settings.codebaseTitle",
      defaultValue: "Codebase settings",
    },
    description: {
      key: "settings.codebaseSettingsInfo",
      defaultValue: "Manage indexing and workspace code search.",
    },
  },
  "git-settings": {
    title: { key: "settings.gitSettings", defaultValue: "Git settings" },
    description: {
      key: "settings.gitSettingsInfo",
      defaultValue:
        "Controls how git repositories are discovered inside a workspace directory. Changes are saved automatically.",
    },
  },
  "system-prompt-settings": {
    title: {
      key: "settings.systemPromptTitle",
      defaultValue: "System prompt",
    },
    description: {
      key: "settings.systemPromptSettingsInfo",
      defaultValue: "Customize the assistant system prompt.",
    },
  },
  "personalization-settings": {
    title: {
      key: "settings.personalizationTitle",
      defaultValue: "Personalization & Rules",
    },
    description: {
      key: "settings.personalizationSettingsInfo",
      defaultValue:
        "Manage global and project-level behavior rules for the AI assistant.",
    },
  },
  "custom-headers-settings": {
    title: {
      key: "settings.customHeadersTitle",
      defaultValue: "Custom headers",
    },
    description: {
      key: "settings.customHeadersSettingsInfo",
      defaultValue: "Add headers for API requests.",
    },
  },
  "mcp-settings": {
    title: { key: "settings.mcpTitle", defaultValue: "MCP settings" },
    description: {
      key: "settings.mcpSettingsInfo",
      defaultValue: "Configure MCP servers and tools.",
    },
  },
  "lsp-settings": {
    title: { key: "settings.lspTitle", defaultValue: "LSP settings" },
    description: {
      key: "settings.lspSettingsInfo",
      defaultValue:
        "Configure external language servers (rust-analyzer, gopls, pyright ...) for lsp-diagnostics / lsp-hover.",
    },
  },
  "skills-settings": {
    title: { key: "settings.skillsTitle", defaultValue: "Skills settings" },
    description: {
      key: "settings.skillsSettingsInfo",
      defaultValue: "View effective project and global Skills.",
    },
  },
  "sub-agent-settings": {
    title: {
      key: "settings.subAgentTitle",
      defaultValue: "Sub-agent settings",
    },
    description: {
      key: "settings.subAgentSettingsInfo",
      defaultValue: "Manage specialized AI sub-agents.",
    },
  },
  "sensitive-command-settings": {
    title: {
      key: "settings.sensitiveCommandTitle",
      defaultValue: "Sensitive commands",
    },
    description: {
      key: "settings.sensitiveCommandsInfo",
      defaultValue: "Review command approval rules.",
    },
  },
  "custom-commands-settings": {
    title: {
      key: "settings.customCommandsTitle",
      defaultValue: "Custom commands",
    },
    description: {
      key: "settings.customCommandsSettingsInfo",
      defaultValue:
        "Define slash commands that send a prompt to the AI or run a shell command.",
    },
  },
  "hooks-settings": {
    title: { key: "settings.hooksTitle", defaultValue: "Hooks settings" },
    description: {
      key: "settings.hooksSettingsInfo",
      defaultValue: "Configure lifecycle hooks and automation.",
    },
  },
  "theme-settings": {
    title: { key: "settings.themeTitle", defaultValue: "Theme settings" },
    description: {
      key: "settings.themeSettingsInfo",
      defaultValue: "Adjust appearance and color theme.",
    },
  },
  "terminal-settings": {
    title: {
      key: "settings.terminalTitle",
      defaultValue: "Terminal settings",
    },
    description: {
      key: "settings.terminalSettingsInfo",
      defaultValue: "Configure terminal shell, font, and appearance.",
    },
  },
  "keyboard-shortcuts-settings": {
    title: {
      key: "settings.keyboardShortcuts",
      defaultValue: "Keyboard shortcuts",
    },
    description: {
      key: "settings.keyboardShortcutsInfo",
      defaultValue:
        "Configure keyboard shortcuts. Each shortcut can be enabled independently and toggled to only work when the app is focused.",
    },
  },
  "pets-settings": {
    title: { key: "settings.pets", defaultValue: "Desktop pet" },
    description: {
      key: "settings.petsInfo",
      defaultValue:
        "Install Codex pet packages (.zip) and let a desktop companion react to your AI work in real time.",
    },
  },
  "privacy-settings": {
    title: { key: "settings.privacyTitle", defaultValue: "Privacy settings" },
    description: {
      key: "settings.privacySettingsInfo",
      defaultValue: "Redact sensitive data from tool results.",
    },
  },
  "remote-control-settings": {
    title: { key: "settings.remoteControl", defaultValue: "手机远控" },
    description: {
      key: "remoteControl.subtitle",
      defaultValue: "同一局域网内，用手机浏览器连接这台 Snow。",
    },
  },
  "usage-settings": {
    title: { key: "settings.usageTitle", defaultValue: "Usage statistics" },
    description: {
      key: "settings.usageSettingsInfo",
      defaultValue:
        "Track token usage across all API calls, including input, output, and cache statistics.",
    },
  },
  "system-logs": {
    title: { key: "settings.systemLogsTitle", defaultValue: "System logs" },
    description: {
      key: "settings.systemLogsInfo",
      defaultValue:
        "Unified diagnostic logs written by the main process and the renderer.",
    },
  },
};

export const getSettingsPageMeta = (
  view: MainContentView,
): SettingsPageMeta | null => SETTINGS_PAGE_META[view] ?? null;
