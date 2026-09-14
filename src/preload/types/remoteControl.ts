export type RemoteControlPairingState = {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  configuredPort: number;
  pairingUrls: string[];
  generation: number;
  wan: {
    enabled: boolean;
    localPort: number;
    publicOrigin: string;
    pairingUrl: string;
    pairingExpiresAt: number | null;
  };
};

export type RemoteAttachmentContext = {
  directoryId: string | null;
  conversationId: string | null;
};

export type ResolvedRemoteAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  path?: string;
};

export type RemoteTunnelConfigInput = {
  enabled: boolean;
  autoConnect: boolean;
  serverAddr: string;
  serverPort: number;
  /** FRP 隧道远端端口（服务器 allowPorts 与 Caddy 反代目标）；缺省 18080。 */
  remotePort?: number;
  publicOrigin: string;
  tlsServerName: string;
  token?: string;
  caCertificate?: string;
};

export type RemoteTunnelImportResult = {
  canceled: boolean;
  status: RemoteTunnelStatus | null;
};

export type RemoteServerDeployInput = {
  serverIp: string;
  rootDomain: string;
  sshPort: number;
  sshUsername: string;
  authMethod: "password" | "privateKey";
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** frps 控制端口（bindPort）；缺省 7000。 */
  frpBindPort?: number;
  /** FRP 隧道远端端口（allowPorts 与 Caddy 反代目标）；缺省 18080。 */
  frpRemotePort?: number;
};

export type RemoteServerDnsRecord = {
  host: "snow" | "frp";
  name: string;
  expectedValue: string;
  resolvedValues: string[];
  ready: boolean;
};

export type RemoteServerDnsCheck = {
  ready: boolean;
  records: RemoteServerDnsRecord[];
};

export type RemoteServerDeployProgress = {
  stage:
    | "checking_dns"
    | "connecting_ssh"
    | "checking_server"
    | "uploading"
    | "installing"
    | "importing"
    | "verifying"
    | "completed";
  message: string;
};

export type RemoteServerDeployResult = {
  dns: RemoteServerDnsCheck;
  tunnel: RemoteTunnelStatus;
};

export type RemoteTunnelStatus = {
  config: {
    configured: boolean;
    enabled: boolean;
    autoConnect: boolean;
    serverAddr: string;
    serverPort: number;
    remotePort: number;
    publicOrigin: string;
    tlsServerName: string;
    hasToken: boolean;
    hasCaCertificate: boolean;
    secureStorageAvailable: boolean;
  };
  stage:
    | "stopped"
    | "starting"
    | "connecting"
    | "online"
    | "reconnecting"
    | "failed";
  listenerPort: number;
  attempt: number;
  nextRetryAt: number | null;
  endpoint: {
    stage: "unchecked" | "checking" | "reachable" | "failed";
    checkedAt: number | null;
  };
  error: { code: string; message: string } | null;
};
