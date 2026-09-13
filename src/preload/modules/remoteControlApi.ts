import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  RemoteAttachmentContext,
  RemoteControlPairingState,
  RemoteTunnelConfigInput,
  RemoteTunnelImportResult,
  RemoteTunnelStatus,
  RemoteServerDeployInput,
  RemoteServerDeployProgress,
  RemoteServerDeployResult,
  RemoteServerDnsCheck,
  ResolvedRemoteAttachment,
} from "../types/remoteControl";

export const remoteControlApi = {
  getRemoteControlPairingState: (): Promise<RemoteControlPairingState> =>
    ipcRenderer.invoke("remote-control:pairing-state"),
  rotateRemoteControlToken: (): Promise<RemoteControlPairingState> =>
    ipcRenderer.invoke("remote-control:rotate-token"),
  getRemoteTunnelStatus: (): Promise<RemoteTunnelStatus> =>
    ipcRenderer.invoke("remote-control:tunnel-status"),
  saveRemoteTunnelConfig: (
    input: RemoteTunnelConfigInput,
  ): Promise<RemoteTunnelStatus> =>
    ipcRenderer.invoke("remote-control:tunnel-save", input),
  connectRemoteTunnel: (): Promise<RemoteTunnelStatus> =>
    ipcRenderer.invoke("remote-control:tunnel-connect"),
  disconnectRemoteTunnel: (): Promise<RemoteTunnelStatus> =>
    ipcRenderer.invoke("remote-control:tunnel-disconnect"),
  importRemoteTunnelConfig: (): Promise<RemoteTunnelImportResult> =>
    ipcRenderer.invoke("remote-control:tunnel-import"),
  checkRemoteServerDns: (input: {
    serverIp: string;
    rootDomain: string;
  }): Promise<RemoteServerDnsCheck> =>
    ipcRenderer.invoke("remote-control:server-check-dns", input),
  deployRemoteControlServer: (
    input: RemoteServerDeployInput,
  ): Promise<RemoteServerDeployResult> =>
    ipcRenderer.invoke("remote-control:server-deploy", input),
  cancelRemoteControlServerDeployment: (): Promise<boolean> =>
    ipcRenderer.invoke("remote-control:server-deploy-cancel"),
  onRemoteControlServerDeployProgress: (
    callback: (progress: RemoteServerDeployProgress) => void,
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      progress: RemoteServerDeployProgress,
    ): void => callback(progress);
    ipcRenderer.on("remote-control:server-deploy-progress", handler);
    return () =>
      ipcRenderer.removeListener("remote-control:server-deploy-progress", handler);
  },
  resolveRemoteAttachments: (
    ids: string[],
    context: RemoteAttachmentContext,
    generation: number,
  ): Promise<ResolvedRemoteAttachment[]> =>
    ipcRenderer.invoke(
      "remote-control:resolve-attachments",
      ids,
      context,
      generation,
    ),
};
