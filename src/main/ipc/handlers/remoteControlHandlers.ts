import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { getMainWindow } from "../../app/mainWindow";
import {
  getRemoteControlPairingState,
  rotateRemoteControlToken,
} from "../../remoteControl/remoteControlServer";
import {
  resolveRemoteAttachments,
  type RemoteAttachmentContext,
} from "../../remoteControl/remoteAttachmentStore";
import { remoteTunnelManager } from "../../remoteControl/remoteTunnelManager";
import {
  cancelRemoteServerDeployment,
  checkRemoteServerDns,
  deployRemoteServer,
} from "../../remoteControl/remoteServerDeployer";
import type { RemoteServerDeployInput } from "../../remoteControl/remoteServerDeploymentSchema";
import {
  parseRemoteTunnelImportBundle,
  type RemoteTunnelConfigInput,
} from "../../remoteControl/remoteTunnelSchema";

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
      return resolveRemoteAttachments(ids, context, generation);
    },
  );
};
