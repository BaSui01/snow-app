export type RemoteControlPairingState = {
  running: boolean;
  host: string;
  port: number;
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
