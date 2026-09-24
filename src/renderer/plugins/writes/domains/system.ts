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
