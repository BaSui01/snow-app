import { rightPanelEvents } from "../../../components/rightPanel/rightPanelEvents";
import {
  PLUGIN_INSERT_INPUT_TEXT_EVENT,
  PLUGIN_OPEN_SETTINGS_EVENT,
  PLUGIN_SEND_INPUT_MESSAGE_EVENT,
} from "../../pluginEvents";
import {
  callSnow,
  dispatchAppEvent,
  l10n,
  optionalNumber,
  optionalString,
  requireRecord,
  requireString,
} from "../helpers";
import type { PluginWriteActionDefinition } from "../types";

export const SYSTEM_WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  {
    domain: "ide",
    action: "open",
    scope: null,
    summary: l10n(
      "Open a project in an external IDE",
      "在外部 IDE 中打开项目",
      "在外部 IDE 中開啟專案",
    ),
    invoke: async ({ params }) => {
      const ideId = requireString(params, "ideId");
      const projectPath = requireString(params, "projectPath");
      await callSnow("openInIde", ideId, projectPath);
      return { ideId, projectPath };
    },
  },

  {
    domain: "system",
    action: "notify",
    scope: null,
    summary: l10n("Show a system notification", "发送系统通知", "傳送系統通知"),
    invoke: async ({ params }) => {
      const options = requireRecord(params, "options");
      await callSnow("showNotification", options);
      return { notified: true };
    },
  },
  {
    domain: "system",
    action: "writeClipboardText",
    scope: null,
    summary: l10n("Write to the clipboard", "写入剪贴板文本", "寫入剪貼簿文字"),
    invoke: async ({ params }) => {
      const text = requireString(params, "text");
      await callSnow("writeClipboardText", text);
      return { length: text.length };
    },
  },
  {
    domain: "system",
    action: "showItemInFolder",
    scope: null,
    summary: l10n(
      "Reveal a file in the system file manager",
      "在文件管理器中显示文件",
      "在檔案管理員中顯示檔案",
    ),
    invoke: async ({ params }) => {
      const path = requireString(params, "path");
      await callSnow("showItemInFolder", path);
      return { path };
    },
  },
  {
    domain: "system",
    action: "openStorageDirectory",
    scope: null,
    summary: l10n("Open a storage directory", "打开存储目录", "開啟儲存目錄"),
    invoke: async ({ params }) => {
      const dirPath = requireString(params, "path");
      const result = await callSnow<string | null>(
        "openStorageDirectory",
        dirPath,
      );
      return { path: result ?? dirPath };
    },
  },

  {
    domain: "nav",
    action: "openSettings",
    scope: null,
    summary: l10n("Open a settings page", "打开设置页面", "開啟設定頁面"),
    invoke: async ({ params }) => {
      const view = optionalString(params, "view") ?? "";
      dispatchAppEvent(PLUGIN_OPEN_SETTINGS_EVENT, { view });
      return { view };
    },
  },

  {
    domain: "chatInput",
    action: "insertText",
    scope: null,
    summary: l10n(
      "Append text to the chat input",
      "向输入框追加文本",
      "向輸入框追加文字",
    ),
    invoke: async ({ params }) => {
      const text = requireString(params, "text");
      dispatchAppEvent(PLUGIN_INSERT_INPUT_TEXT_EVENT, { text });
      return { length: text.length };
    },
  },
  {
    domain: "chatInput",
    action: "sendMessage",
    scope: "conversations",
    summary: l10n(
      "Send a message to the active chat",
      "向当前会话发送消息",
      "向目前工作階段傳送訊息",
    ),
    invoke: async ({ params }) => {
      const text = requireString(params, "text");
      dispatchAppEvent(PLUGIN_SEND_INPUT_MESSAGE_EVENT, { text });
      return { length: text.length };
    },
  },

  {
    domain: "panels",
    action: "openFile",
    // UI navigation only: file contents and SSH credentials stay in the host.
    scope: null,
    summary: l10n(
      "Open a file in the built-in right-panel reader",
      "在内置右侧文件阅读器中打开文件",
      "在內建右側檔案閱讀器中開啟檔案",
    ),
    invoke: async ({ params }) => {
      const filePath = requireString(params, "filePath");
      const focusLine = optionalNumber(params, "focusLine");
      const sshWorkspacePath = optionalString(params, "sshWorkspacePath");
      const sshWorkspaceId = optionalString(params, "sshWorkspaceId");
      if (filePath.includes("\0")) {
        throw new Error(
          "Parameter 'filePath' must not contain a null character",
        );
      }
      if (
        focusLine !== undefined &&
        (!Number.isSafeInteger(focusLine) || focusLine < 1)
      ) {
        throw new Error(
          "Parameter 'focusLine' must be a positive safe integer",
        );
      }
      const isSsh = sshWorkspacePath !== undefined;
      if (isSsh) {
        // The reader resolves credentials itself; plugins cannot inject sessions.
        if (
          !/^ssh:\/\/[^/\s]+(?:\/.*)?$/.test(sshWorkspacePath) ||
          sshWorkspacePath.includes("\0")
        ) {
          throw new Error(
            "Parameter 'sshWorkspacePath' must be an SSH workspace URL",
          );
        }
        if (!filePath.startsWith("/") || filePath.startsWith("//")) {
          throw new Error(
            "SSH 'filePath' must be a remote absolute path, not an SSH URL",
          );
        }
      } else {
        if (sshWorkspaceId !== undefined) {
          throw new Error(
            "Parameter 'sshWorkspaceId' requires 'sshWorkspacePath'",
          );
        }
        if (!/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(filePath)) {
          throw new Error("Local 'filePath' must be an absolute path");
        }
      }
      rightPanelEvents.emit("open-file", {
        filePath,
        focusLine,
        isSsh,
        sshWorkspacePath,
        sshWorkspaceRoot: sshWorkspacePath,
        sshWorkspaceId,
      });
      // Event handling and file loading are asynchronous; this is not a receipt
      // for successful reading, nor does it expose file data to the plugin.
      return { requested: true, filePath, isSsh };
    },
  },

  {
    domain: "panels",
    action: "openFileDiff",
    // In-memory, read-only preview only: no disk access or command execution.
    scope: null,
    summary: l10n(
      "Preview a supplied file diff in the built-in right panel",
      "在内置右侧面板预览提供的文件差异",
      "在內建右側面板預覽提供的檔案差異",
    ),
    invoke: async ({ params }) => {
      const filePath = requireString(params, "filePath");
      const patch = requireString(params, "patch");
      const changeType = requireString(params, "changeType");
      for (const [key, value] of Object.entries({
        filePath,
        patch,
        changeType,
      })) {
        if (value.includes("\0")) {
          throw new Error(
            `Parameter '${key}' must not contain a null character`,
          );
        }
      }
      if (
        changeType !== "added" &&
        changeType !== "modified" &&
        changeType !== "deleted"
      ) {
        throw new Error(
          "Parameter 'changeType' must be added, modified or deleted",
        );
      }
      const fileName =
        filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
      rightPanelEvents.emit("open-file-diff-preview", {
        filePath,
        fileName,
        patch,
        changeType,
      });
      // Only acknowledges dispatch, not rendering; never returns diff contents.
      return { requested: true, filePath, changeType };
    },
  },

  {
    domain: "pluginsSelf",
    action: "openPanel",
    scope: null,
    summary: l10n(
      "Open one of this plugin panels",
      "打开本插件的面板",
      "開啟此外掛的面板",
    ),
    invoke: async ({ plugin, params }) => {
      const panelId = requireString(params, "panelId");
      const panel = plugin.panels.find((item) => item.id === panelId);
      if (!panel) {
        throw new Error(
          `Panel '${panelId}' is not declared by plugin '${plugin.pluginId}'`,
        );
      }
      rightPanelEvents.emit("open-plugin-panel", {
        pluginId: plugin.pluginId,
        panelId,
        title: optionalString(params, "title") ?? panel.title.default,
      });
      return { pluginId: plugin.pluginId, panelId };
    },
  },
];
