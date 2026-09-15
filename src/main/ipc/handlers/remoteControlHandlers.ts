import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getMainWindow } from "../../app/mainWindow";
import {
  getRemoteControlPairingState,
  rotateRemoteControlToken,
} from "../../remoteControl/remoteControlServer";
import {
  applyRemoteControlEnabled,
  applyRemoteControlFixedToken,
  applyRemoteControlPort,
} from "../../remoteControl/remoteControlLifecycle";
import type { RemoteAttachmentContext } from "../../../preload/types/remoteControl";
import { remoteTunnelManager } from "../../remoteControl/remoteTunnelManager";
import { native } from "../../native/nativeBridge";
import {
  cancelRemoteServerDeployment,
  checkRemoteServerDns,
  deployRemoteServer,
} from "../../remoteControl/remoteServerDeployer";
import type { RemoteServerDeployInput } from "../../remoteControl/remoteServerDeploymentSchema";
import {
  createRemoteTunnelBundle,
  parseRemoteTunnelImportBundle,
  type RemoteTunnelConfigInput,
} from "../../remoteControl/remoteTunnelSchema";
import { loadStoredRemoteTunnelConfig } from "../../remoteControl/remoteTunnelConfig";

const assertMainFrame = (event: IpcMainInvokeEvent): void => {
  const mainWindow = getMainWindow();
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Remote control IPC is restricted to the Snow main frame");
  }
};

const isContext = (value: unknown): value is RemoteAttachmentContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Record<string, unknown>;
  return (
    (context.directoryId === null || typeof context.directoryId === "string") &&
    (context.conversationId === null ||
      typeof context.conversationId === "string")
  );
};

export const registerRemoteControlHandlers = (): void => {
  ipcMain.handle("remote-control:pairing-state", (event) => {
    assertMainFrame(event);
    return getRemoteControlPairingState();
  });
  ipcMain.handle("remote-control:rotate-token", async (event) => {
    assertMainFrame(event);
    return rotateRemoteControlToken();
  });
  ipcMain.handle(
    "remote-control:set-enabled",
    async (event, enabled: unknown) => {
      assertMainFrame(event);
      if (typeof enabled !== "boolean") {
        throw new Error("Invalid remote control enabled flag");
      }
      return applyRemoteControlEnabled(enabled);
    },
  );
  ipcMain.handle("remote-control:set-port", async (event, port: unknown) => {
    assertMainFrame(event);
    if (typeof port !== "number" || !Number.isInteger(port)) {
      throw new Error("Invalid remote control port");
    }
    return applyRemoteControlPort(port);
  });
  ipcMain.handle(
    "remote-control:set-fixed-token",
    async (event, kind: unknown, token: unknown) => {
      assertMainFrame(event);
      if (kind !== "lan" && kind !== "wan") {
        throw new Error("Invalid remote control token kind");
      }
      if (token !== null && typeof token !== "string") {
        throw new Error("Invalid remote control token");
      }
      return applyRemoteControlFixedToken(kind, token);
    },
  );
  ipcMain.handle("remote-control:tunnel-status", (event) => {
    assertMainFrame(event);
    return remoteTunnelManager.getStatus();
  });
  ipcMain.handle(
    "remote-control:tunnel-save",
    async (event, input: RemoteTunnelConfigInput) => {
      assertMainFrame(event);
      return remoteTunnelManager.save(input);
    },
  );
  ipcMain.handle("remote-control:tunnel-connect", async (event) => {
    assertMainFrame(event);
    return remoteTunnelManager.connect();
  });
  ipcMain.handle("remote-control:tunnel-disconnect", async (event) => {
    assertMainFrame(event);
    return remoteTunnelManager.disconnect();
  });
  ipcMain.handle("remote-control:tunnel-remove", async (event) => {
    assertMainFrame(event);
    return remoteTunnelManager.remove();
  });
  ipcMain.handle("remote-control:tunnel-import", async (event) => {
    assertMainFrame(event);
    const mainWindow = getMainWindow();
    if (!mainWindow) throw new Error("Snow 主窗口不可用");
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "导入 Snow 公网远控配置包",
      properties: ["openFile"],
      filters: [{ name: "Snow 远控配置", extensions: ["json"] }],
    });
    if (selection.canceled || selection.filePaths.length !== 1) {
      return { canceled: true, status: null };
    }
    const bytes = await readFile(selection.filePaths[0]);
    if (bytes.length > 96 * 1024) {
      throw new Error("Snow 公网远控配置包不能超过 96 KiB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Snow 公网远控配置包不是有效的 JSON");
    }
    const input = parseRemoteTunnelImportBundle(parsed);
    await remoteTunnelManager.save(input);
    return { canceled: false, status: await remoteTunnelManager.connect() };
  });
  ipcMain.handle("remote-control:tunnel-export", async (event) => {
    assertMainFrame(event);
    const mainWindow = getMainWindow();
    if (!mainWindow) throw new Error("Snow 主窗口不可用");
    const config = loadStoredRemoteTunnelConfig();
    if (!config) throw new Error("本机还没有可导出的公网配置");
    const host = new URL(config.publicOrigin).hostname;
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: "导出 Snow 公网远控配置包",
      defaultPath: join(
        app.getPath("downloads"),
        `snow-remote-client-${host}.json`,
      ),
      filters: [{ name: "Snow 远控配置", extensions: ["json"] }],
    });
    if (selection.canceled || !selection.filePath) {
      return { canceled: true, path: null };
    }
    const bytes = JSON.stringify(createRemoteTunnelBundle(config), null, 2);
    await writeFile(selection.filePath, bytes, { mode: 0o600 });
    return { canceled: false, path: selection.filePath };
  });
  ipcMain.handle(
    "remote-control:server-check-dns",
    async (event, input: { serverIp: string; rootDomain: string }) => {
      assertMainFrame(event);
      return checkRemoteServerDns(input);
    },
  );
  ipcMain.handle(
    "remote-control:server-deploy",
    async (event, input: RemoteServerDeployInput) => {
      assertMainFrame(event);
      return deployRemoteServer(input, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("remote-control:server-deploy-progress", progress);
        }
      });
    },
  );
  ipcMain.handle("remote-control:server-deploy-cancel", (event) => {
    assertMainFrame(event);
    return cancelRemoteServerDeployment();
  });
  ipcMain.handle(
    "remote-control:resolve-attachments",
    async (event, ids: unknown, context: unknown, generation: unknown) => {
      assertMainFrame(event);
      if (
        !Array.isArray(ids) ||
        ids.length > 4 ||
        !ids.every((id) => typeof id === "string" && id.length <= 200) ||
        !isContext(context) ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation)
      ) {
        throw new Error("Invalid remote attachment request");
      }
      return native.resolveRemoteAttachments(
        ids,
        {
          // 原生侧的 Option<String> 只接受 undefined（null 会被类型转换拒绝）；
          // 渲染进程未选择会话 / 工作区时传的是 null，这里统一归一化。
          directoryId: context.directoryId ?? undefined,
          conversationId: context.conversationId ?? undefined,
        },
        generation,
      );
    },
  );
};
