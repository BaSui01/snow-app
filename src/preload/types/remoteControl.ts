export type RemoteFixedTokenKind = "lan" | "wan";

export type RemoteControlPairingState = {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  configuredPort: number;
  pairingUrls: string[];
  generation: number;
  /** 当前局域网令牌（服务未运行时为空串）。 */
  token: string;
  /** 局域网令牌是否为用户固定值；否则是本次启动生成的随机令牌。 */
  tokenPinned: boolean;
  /** 系统安全存储是否可用（固定令牌需要）。 */
  tokenStorageAvailable: boolean;
  wan: {
    enabled: boolean;
    localPort: number;
    publicOrigin: string;
    pairingUrl: string;
    /** 当前生效的公网令牌；公网入口未连接时为已保存值。 */
    token: string;
    /** 公网令牌是否为已保存值；否则为本次连接生成的随机令牌。 */
    tokenPinned: boolean;
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

/** 活动传输类型：FRP（现有方案）或 SSH2（进程内反向隧道）。 */
export type RemoteTransportKind = "frp" | "ssh2";

export type FrpTransportConfigInput = {
  serverAddr: string;
  serverPort: number;
  /** FRP 隧道远端端口（服务器 allowPorts 与 Caddy 反代目标）；缺省 18080。 */
  remotePort?: number;
  tlsServerName: string;
  token?: string;
  caCertificate?: string;
};

export type Ssh2TransportConfigInput = {
  serverAddr: string;
  serverPort: number;
  username: string;
  /** SSH2 隧道回环端口（PermitListen 与 Caddy 反代目标）；缺省 18080。 */
  remotePort?: number;
  hostKeyType: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  /** 缺省时沿用已存私钥；配置包导入不携带私钥。 */
  privateKey?: string;
};

export type RemoteTunnelConfigInput = {
  enabled: boolean;
  autoConnect: boolean;
  /** 本次保存 / 启用的活动传输。 */
  transport: RemoteTransportKind;
  publicOrigin: string;
  frp?: FrpTransportConfigInput;
  ssh2?: Ssh2TransportConfigInput;
};

export type RemoteTunnelImportResult = {
  canceled: boolean;
  status: RemoteTunnelStatus | null;
};

export type RemoteTunnelExportResult = {
  canceled: boolean;
  path: string | null;
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
  /** 隧道类型：缺省 frp 保持旧行为；ssh2 使用进程内反向隧道。 */
  transport?: "frp" | "ssh2";
  /** SSH2 隧道服务端口（专用 snow-tunnel-sshd 实例）；缺省 7001。 */
  ssh2TunnelPort?: number;
  /** SSH2 隧道回环端口（PermitListen 与 Caddy 反代目标）；缺省 18080。 */
  ssh2RemotePort?: number;
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
    activeTransport: RemoteTransportKind;
    publicOrigin: string;
    secureStorageAvailable: boolean;
    frp: {
      configured: boolean;
      serverAddr: string;
      serverPort: number;
      remotePort: number;
      tlsServerName: string;
      hasToken: boolean;
      hasCaCertificate: boolean;
    };
    ssh2: {
      configured: boolean;
      serverAddr: string;
      serverPort: number;
      username: string;
      remotePort: number;
      hostKeyType: string;
      hostKeyPublicKey: string;
      hostKeyFingerprint: string;
      hasPrivateKey: boolean;
      /** 缺少本机私钥（如导入的配置包）：需要重新部署授权后才能连接。 */
      needsAuthorization: boolean;
    };
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
  frpc: { present: boolean; dir: string };
};
