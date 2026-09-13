import {
  Copy,
  FileUp,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  Smartphone,
  Unplug,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteControlPairingState,
  RemoteServerDeployInput,
  RemoteServerDeployProgress,
  RemoteServerDnsCheck,
  RemoteTunnelConfigInput,
  RemoteTunnelStatus,
} from "../../../preload";

type RemoteControlSettingsPanelProps = {
  onClose?: () => void;
};

export function RemoteControlSettingsPanel({
  onClose,
}: RemoteControlSettingsPanelProps): React.JSX.Element {
  const [state, setState] = useState<RemoteControlPairingState | null>(null);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [wanQrDataUrl, setWanQrDataUrl] = useState("");
  const [tunnel, setTunnel] = useState<RemoteTunnelStatus | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    autoConnect: true,
    serverAddr: "",
    serverPort: "7000",
    publicOrigin: "",
    tlsServerName: "",
    token: "",
    caCertificate: "",
  });
  const formInitialized = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dnsCheck, setDnsCheck] = useState<RemoteServerDnsCheck | null>(null);
  const [deployProgress, setDeployProgress] =
    useState<RemoteServerDeployProgress | null>(null);
  const [deploymentActive, setDeploymentActive] = useState(false);
  const [deployForm, setDeployForm] = useState({
    serverIp: "",
    rootDomain: "",
    sshPort: "22",
    sshUsername: "root",
    authMethod: "password" as "password" | "privateKey",
    password: "",
    privateKeyPath: "",
    passphrase: "",
  });

  const applyState = useCallback((next: RemoteControlPairingState): void => {
    setState(next);
    setSelectedUrl((current) =>
      next.pairingUrls.includes(current)
        ? current
        : (next.pairingUrls[0] ?? ""),
    );
  }, []);

  const applyTunnel = useCallback((next: RemoteTunnelStatus): void => {
    setTunnel(next);
    if (!formInitialized.current) {
      formInitialized.current = true;
      setForm((current) => ({
        ...current,
        enabled: next.config.enabled,
        autoConnect: next.config.autoConnect,
        serverAddr: next.config.serverAddr,
        serverPort: String(next.config.serverPort),
        publicOrigin: next.config.publicOrigin,
        tlsServerName: next.config.tlsServerName,
      }));
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const [pairing, tunnelStatus] = await Promise.all([
        window.snow.getRemoteControlPairingState(),
        window.snow.getRemoteTunnelStatus(),
      ]);
      applyState(pairing);
      applyTunnel(tunnelStatus);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "无法读取手机远控状态",
      );
    } finally {
      setBusy(false);
    }
  }, [applyState, applyTunnel]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.snow.onRemoteControlServerDeployProgress((progress) => {
        setDeployProgress(progress);
        setMessage(progress.message);
      }),
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([
        window.snow.getRemoteControlPairingState(),
        window.snow.getRemoteTunnelStatus(),
      ]).then(([pairing, tunnelStatus]) => {
        applyState(pairing);
        applyTunnel(tunnelStatus);
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [applyState, applyTunnel]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedUrl) {
      setQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(selectedUrl, {
      width: 260,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111318", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setQrDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedUrl]);

  useEffect(() => {
    let cancelled = false;
    const url = state?.wan.pairingUrl ?? "";
    if (!url) {
      setWanQrDataUrl("");
      return;
    }
    void QRCode.toDataURL(url, {
      width: 260,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#111318", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setWanQrDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [state?.wan.pairingUrl]);

  const rotate = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      applyState(await window.snow.rotateRemoteControlToken());
      setMessage("配对凭据已轮换，旧手机连接已失效");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "轮换失败");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!selectedUrl) return;
    try {
      await window.snow.writeClipboardText(selectedUrl);
      setMessage("配对地址已复制");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复制失败");
    }
  };

  const normalizedRootDomain = deployForm.rootDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.$/, "");

  const checkDns = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.snow.checkRemoteServerDns({
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
      });
      setDnsCheck(result);
      setMessage(
        result.ready
          ? "两条 DNS 解析均已生效，可以开始自动部署"
          : "DNS 尚未生效，请核对下方两条 A 记录后稍等几分钟再检测",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "DNS 检测失败");
    } finally {
      setBusy(false);
    }
  };

  const selectPrivateKey = async (): Promise<void> => {
    const path = await window.snow.sshSelectPrivateKey("选择服务器 SSH 私钥");
    if (path) {
      setDeployForm((current) => ({ ...current, privateKeyPath: path }));
    }
  };

  const deployServer = async (): Promise<void> => {
    setBusy(true);
    setDeploymentActive(true);
    setMessage("");
    setDeployProgress({ stage: "checking_dns", message: "正在开始部署" });
    try {
      const input: RemoteServerDeployInput = {
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
        sshPort: Number(deployForm.sshPort),
        sshUsername: deployForm.sshUsername,
        authMethod: deployForm.authMethod,
        ...(deployForm.authMethod === "password"
          ? { password: deployForm.password }
          : {
              privateKeyPath: deployForm.privateKeyPath,
              ...(deployForm.passphrase
                ? { passphrase: deployForm.passphrase }
                : {}),
            }),
      };
      const result = await window.snow.deployRemoteControlServer(input);
      setDnsCheck(result.dns);
      formInitialized.current = false;
      applyTunnel(result.tunnel);
      applyState(await window.snow.getRemoteControlPairingState());
      setMessage(
        "部署成功。请关闭手机 Wi-Fi，用蜂窝网络扫描下方公网二维码验收",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "服务器自动部署失败");
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setDeployForm((current) => ({
        ...current,
        password: "",
        passphrase: "",
      }));
      setDeploymentActive(false);
      setBusy(false);
    }
  };

  const cancelDeployment = async (): Promise<void> => {
    if (await window.snow.cancelRemoteControlServerDeployment()) {
      setMessage("正在取消部署；服务器上的当前安装命令可能需要片刻才能停止");
    }
  };

  const saveAndConnect = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const input: RemoteTunnelConfigInput = {
        enabled: form.enabled,
        autoConnect: form.autoConnect,
        serverAddr: form.serverAddr,
        serverPort: Number(form.serverPort),
        publicOrigin: form.publicOrigin,
        tlsServerName: form.tlsServerName,
        ...(form.token.trim() ? { token: form.token } : {}),
        ...(form.caCertificate.trim()
          ? { caCertificate: form.caCertificate }
          : {}),
      };
      let next = await window.snow.saveRemoteTunnelConfig(input);
      if (input.enabled) {
        next = await window.snow.connectRemoteTunnel();
      } else {
        next = await window.snow.disconnectRemoteTunnel();
      }
      setForm((current) => ({ ...current, token: "", caCertificate: "" }));
      applyTunnel(next);
      applyState(await window.snow.getRemoteControlPairingState());
      setMessage(
        input.enabled
          ? "配置已加密保存，正在验证公网入口"
          : "公网远控已关闭，局域网远控保持可用",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存或连接失败");
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      applyTunnel(await window.snow.disconnectRemoteTunnel());
      applyState(await window.snow.getRemoteControlPairingState());
      setMessage("公网隧道已断开，局域网远控保持可用");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "断开失败");
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const result = await window.snow.importRemoteTunnelConfig();
      if (result.canceled || !result.status) return;
      formInitialized.current = false;
      applyTunnel(result.status);
      applyState(await window.snow.getRemoteControlPairingState());
      setMessage(
        "配置包已校验并加密保存，Snow 正在连接。导入包含 FRP 凭据，请从下载目录安全删除。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入配置包失败");
    } finally {
      setBusy(false);
    }
  };

  const tunnelStageLabel: Record<RemoteTunnelStatus["stage"], string> = {
    stopped: "已关闭",
    starting: "正在启动本机入口",
    connecting: "隧道已启动，正在检查 HTTPS",
    online: "公网入口可用",
    reconnecting: "网络中断，正在重连",
    failed: "连接失败",
  };

  return (
    <div
      className="api-settings-page remote-control-settings-page"
      role="region"
    >
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>手机远控</strong>
          <span className="settings-item-description">
            同一局域网内，用手机浏览器连接这台 Snow。
          </span>
        </div>
        {onClose ? (
          <button
            className="icon-btn ghost"
            type="button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        ) : null}
      </div>

      <div className="remote-pairing-layout">
        <section className="remote-pairing-qr" aria-label="配对二维码">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="Snow 手机远控配对二维码" />
          ) : (
            <Smartphone size={44} />
          )}
          <span
            className={`remote-service-status ${state?.running ? "running" : ""}`}
          >
            {state?.running ? `正在监听 ${state.port}` : "服务未运行"}
          </span>
        </section>

        <section className="remote-pairing-details">
          <label htmlFor="remote-pairing-address">局域网地址</label>
          <select
            id="remote-pairing-address"
            value={selectedUrl}
            onChange={(event) => setSelectedUrl(event.target.value)}
            disabled={busy || !state?.running}
          >
            {(state?.pairingUrls ?? []).map((url) => (
              <option key={url} value={url}>
                {url.replace(/([?&]token=)[^&]+/, "$1••••••••")}
              </option>
            ))}
          </select>
          <div className="remote-pairing-actions">
            <button
              type="button"
              className="nav-item"
              onClick={() => void copy()}
              disabled={!selectedUrl || busy}
            >
              <Copy size={15} />
              <span>复制地址</span>
            </button>
            <button
              type="button"
              className="nav-item"
              onClick={() => void rotate()}
              disabled={!state?.running || busy}
            >
              <RotateCcw size={15} />
              <span>轮换凭据</span>
            </button>
            <button
              type="button"
              className="icon-btn ghost"
              onClick={() => void load()}
              disabled={busy}
              aria-label="刷新"
            >
              <RefreshCw size={15} className={busy ? "spin" : ""} />
            </button>
          </div>
          <p className="remote-pairing-note">
            轮换后，已配对手机及尚未发送的附件会立即失效。
          </p>
          {message ? (
            <div className="remote-pairing-message" role="status">
              {message}
            </div>
          ) : null}
        </section>
      </div>

      <div className="remote-tunnel-card">
        <div className="remote-tunnel-heading">
          <Server size={18} />
          <div>
            <strong>自建服务器公网连接</strong>
            <p>
              安装包已内置并校验
              frpc；部署失败时不会保存凭据，验证成功后才会在本机加密保存。
            </p>
          </div>
          <span
            className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
          >
            {tunnel ? tunnelStageLabel[tunnel.stage] : "读取中"}
          </span>
        </div>

        <div className="remote-tunnel-status-grid">
          <span>本机 WAN</span>
          <strong>
            {tunnel?.listenerPort
              ? `127.0.0.1:${tunnel.listenerPort}`
              : "未监听"}
          </strong>
          <span>FRP 隧道</span>
          <strong>{tunnel ? tunnelStageLabel[tunnel.stage] : "未知"}</strong>
          <span>HTTPS 探测</span>
          <strong>
            {tunnel?.endpoint.stage === "reachable"
              ? "已通过"
              : (tunnel?.endpoint.stage ?? "未检查")}
          </strong>
        </div>

        {!tunnel?.config.secureStorageAvailable ? (
          <div className="remote-pairing-message error" role="alert">
            系统安全存储不可用。为避免明文保存凭据，公网远控已禁用。
          </div>
        ) : null}

        <details className="remote-tunnel-guide" open>
          <summary>第一次公网部署（共 4 步，Snow 负责安装）</summary>
          <div className="remote-tunnel-guide-content">
            <div className="remote-tunnel-guide-callout">
              <strong>只在同一 Wi-Fi 使用时，不需要服务器。</strong>
              <span>
                直接扫描上方局域网二维码即可；下面的公网配置可以保持关闭。
              </span>
            </div>

            <section className="remote-deploy-step">
              <h4>
                <b>1</b> 购买前确认：只需要服务器和域名
              </h4>
              <ul>
                <li>
                  <strong>Linux 公网服务器：</strong>任意厂商，Ubuntu
                  22.04/24.04、 x86_64、独立公网 IPv4、长期运行；至少 1 核 1
                  GB。不要买抢占式、 竞价、Windows、数据库、GPU 或预装面板套餐。
                </li>
                <li>
                  <strong>一个付费域名：</strong>
                  任意注册商和后缀均可。不需要购买 SSL
                  证书、CDN、云解析高级版、建站或企业邮箱。
                </li>
                <li>
                  <strong>服务器登录凭据：</strong>root 密码或 SSH
                  私钥。它不是云厂商
                  账号密码；服务器没有初始密码时，在服务器控制台点“设置/重置密码”。
                </li>
              </ul>
            </section>

            <section className="remote-deploy-step">
              <h4>
                <b>2</b> 先去两个控制台完成这些设置
              </h4>
              <p>
                <strong>域名控制台 → DNS/域名解析 → 添加记录：</strong>
              </p>
              <div
                className="remote-deploy-table"
                role="table"
                aria-label="DNS 记录"
              >
                <strong>类型</strong>
                <strong>主机记录</strong>
                <strong>记录值</strong>
                <code>A</code>
                <code>snow</code>
                <code>{deployForm.serverIp.trim() || "服务器公网 IP"}</code>
                <code>A</code>
                <code>frp</code>
                <code>{deployForm.serverIp.trim() || "服务器公网 IP"}</code>
              </div>
              <small>
                主机记录只填 <code>snow</code> 和 <code>frp</code>
                ，不要填写完整域名； 线路和 TTL 保持默认。
                {normalizedRootDomain
                  ? ` 保存后会得到 snow.${normalizedRootDomain} 和 frp.${normalizedRootDomain}。`
                  : ""}
              </small>
              <p>
                <strong>服务器控制台 → 防火墙/安全组 → 添加入站规则：</strong>
              </p>
              <div className="remote-deploy-ports">
                <code>TCP 22</code>
                <span>Snow 登录服务器</span>
                <code>TCP 80</code>
                <span>自动申请 HTTPS 证书</span>
                <code>TCP 443</code>
                <span>手机 HTTPS 访问</span>
                <code>TCP 7000</code>
                <span>Snow 桌面隧道</span>
              </div>
              <div className="remote-tunnel-guide-callout warning">
                <strong>不要开放 TCP 18080。</strong>
                <span>它只能在服务器内部使用，Snow 部署结束时会自动检查。</span>
              </div>
            </section>

            <section className="remote-deploy-step">
              <h4>
                <b>3</b> 再填写 Snow 连接信息
              </h4>
              <div className="remote-simple-deploy-form">
                <label>
                  服务器公网 IP
                  <small>
                    服务器详情页中的“公网 IP / 公网 IPv4”，不是私有 IP。
                  </small>
                  <input
                    value={deployForm.serverIp}
                    placeholder="例如 42.194.128.147"
                    onChange={(event) => {
                      setDnsCheck(null);
                      setDeployForm((current) => ({
                        ...current,
                        serverIp: event.target.value,
                      }));
                    }}
                    spellCheck={false}
                  />
                </label>
                <label>
                  你的根域名
                  <small>
                    填写买到的域名，如 example.com；不要加 snow、https 或路径。
                  </small>
                  <input
                    value={deployForm.rootDomain}
                    placeholder="例如 example.com"
                    onChange={(event) => {
                      setDnsCheck(null);
                      setDeployForm((current) => ({
                        ...current,
                        rootDomain: event.target.value,
                      }));
                    }}
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH 用户名
                  <small>
                    Ubuntu 密码登录通常填 root；云厂商一键登录显示的 admin
                    不一定能用。
                  </small>
                  <input
                    value={deployForm.sshUsername}
                    onChange={(event) =>
                      setDeployForm((current) => ({
                        ...current,
                        sshUsername: event.target.value,
                      }))
                    }
                    spellCheck={false}
                  />
                </label>
                <label>
                  SSH 端口
                  <small>
                    服务器远程连接页面显示的端口，未修改时通常是 22。
                  </small>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={deployForm.sshPort}
                    onChange={(event) =>
                      setDeployForm((current) => ({
                        ...current,
                        sshPort: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  登录方式
                  <small>新手建议使用在服务器控制台设置的 SSH 密码。</small>
                  <select
                    value={deployForm.authMethod}
                    onChange={(event) =>
                      setDeployForm((current) => ({
                        ...current,
                        authMethod: event.target.value as
                          "password" | "privateKey",
                      }))
                    }
                  >
                    <option value="password">SSH 密码</option>
                    <option value="privateKey">SSH 私钥</option>
                  </select>
                </label>
                {deployForm.authMethod === "password" ? (
                  <label>
                    SSH 密码
                    <small>
                      服务器 root 密码，不是阿里云/腾讯云等网站的登录密码。
                    </small>
                    <input
                      type="password"
                      value={deployForm.password}
                      onChange={(event) =>
                        setDeployForm((current) => ({
                          ...current,
                          password: event.target.value,
                        }))
                      }
                      autoComplete="new-password"
                      placeholder="只在本次部署期间保存在内存中"
                    />
                  </label>
                ) : (
                  <>
                    <label className="remote-simple-deploy-key">
                      SSH 私钥文件
                      <small>
                        选择创建服务器或绑定密钥对时下载到本机的私钥文件。
                      </small>
                      <span>
                        <input
                          value={deployForm.privateKeyPath}
                          readOnly
                          placeholder="请选择私钥文件"
                        />
                        <button
                          type="button"
                          className="nav-item"
                          onClick={() => void selectPrivateKey()}
                          disabled={busy}
                        >
                          选择
                        </button>
                      </span>
                    </label>
                    <label>
                      私钥密码（没有可留空）
                      <input
                        type="password"
                        value={deployForm.passphrase}
                        onChange={(event) =>
                          setDeployForm((current) => ({
                            ...current,
                            passphrase: event.target.value,
                          }))
                        }
                        autoComplete="new-password"
                      />
                    </label>
                  </>
                )}
              </div>
            </section>

            <section className="remote-deploy-step">
              <h4>
                <b>4</b> 检测成功后再自动部署
              </h4>
              <p>
                先点“检测 DNS”。两行均为 ✓ 后，再点“自动部署并连接”；之后
                FRP、Caddy、token、CA、证书和配置导入都由 Snow 处理。
              </p>

              {dnsCheck ? (
                <div className="remote-dns-check-results">
                  {dnsCheck.records.map((record) => (
                    <span key={record.host}>
                      {record.ready ? "✓" : "×"} {record.name} →{" "}
                      {record.expectedValue}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="remote-pairing-actions">
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => void checkDns()}
                  disabled={busy}
                >
                  <RefreshCw size={15} className={busy ? "spin" : ""} />
                  <span>检测 DNS</span>
                </button>
                <button
                  type="button"
                  className="nav-item remote-import-primary"
                  onClick={() => void deployServer()}
                  disabled={busy || !tunnel?.config.secureStorageAvailable}
                >
                  <Server size={15} />
                  <span>自动部署并连接</span>
                </button>
                {deploymentActive ? (
                  <button
                    type="button"
                    className="nav-item"
                    onClick={() => void cancelDeployment()}
                  >
                    取消部署
                  </button>
                ) : null}
              </div>
              {deployProgress ? (
                <div className="remote-deploy-progress" role="status">
                  <RefreshCw
                    size={15}
                    className={
                      deployProgress.stage === "completed" ? "" : "spin"
                    }
                  />
                  <span>{deployProgress.message}</span>
                </div>
              ) : null}
            </section>
          </div>
        </details>

        <details className="remote-tunnel-guide remote-tunnel-advanced">
          <summary>高级设置（仅供懂技术的人手动配置）</summary>
          <div className="remote-tunnel-guide-content">
            <button
              type="button"
              className="nav-item"
              onClick={() => void importConfig()}
              disabled={busy || !tunnel?.config.secureStorageAvailable}
            >
              <FileUp size={15} />
              <span>导入已有配置包</span>
            </button>
            <div className="remote-tunnel-form">
              <label className="remote-tunnel-check">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                启用公网远控
              </label>
              <label className="remote-tunnel-check">
                <input
                  type="checkbox"
                  checked={form.autoConnect}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      autoConnect: event.target.checked,
                    }))
                  }
                />
                Snow 启动后自动连接
              </label>

              <label>
                FRP 服务器地址
                <input
                  value={form.serverAddr}
                  placeholder="frp.example.com"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      serverAddr: event.target.value,
                    }))
                  }
                  spellCheck={false}
                />
              </label>
              <label>
                FRP 端口
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={form.serverPort}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      serverPort: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                手机 HTTPS 地址
                <input
                  value={form.publicOrigin}
                  placeholder="https://snow.example.com"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      publicOrigin: event.target.value,
                    }))
                  }
                  spellCheck={false}
                />
              </label>
              <label>
                FRP TLS 服务器名称
                <input
                  value={form.tlsServerName}
                  placeholder="frp.example.com"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      tlsServerName: event.target.value,
                    }))
                  }
                  spellCheck={false}
                />
              </label>
              <label>
                FRP 凭据
                <input
                  type="password"
                  value={form.token}
                  placeholder={
                    tunnel?.config.hasToken
                      ? "已加密保存；留空保持不变"
                      : "至少 32 个字符"
                  }
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      token: event.target.value,
                    }))
                  }
                  autoComplete="new-password"
                />
              </label>
              <label className="remote-tunnel-ca">
                FRP CA 证书（PEM）
                <textarea
                  value={form.caCertificate}
                  placeholder={
                    tunnel?.config.hasCaCertificate
                      ? "证书已加密保存；留空保持不变"
                      : "-----BEGIN CERTIFICATE-----"
                  }
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      caCertificate: event.target.value,
                    }))
                  }
                  spellCheck={false}
                />
              </label>
            </div>

            <div className="remote-pairing-actions">
              <button
                type="button"
                className="nav-item"
                onClick={() => void saveAndConnect()}
                disabled={busy || !tunnel?.config.secureStorageAvailable}
              >
                <Power size={15} />
                <span>{form.enabled ? "保存并连接" : "保存并关闭公网"}</span>
              </button>
              <button
                type="button"
                className="nav-item"
                onClick={() => void disconnect()}
                disabled={busy || tunnel?.stage === "stopped"}
              >
                <Unplug size={15} />
                <span>仅断开本次连接</span>
              </button>
            </div>
            <div className="remote-tunnel-guide-callout warning">
              <strong>“仅断开”不会撤销手机登录。</strong>
              <span>
                手机丢失或链接泄露时，请使用页面上方的“轮换凭据”，让旧手机连接立即失效。
              </span>
            </div>
          </div>
        </details>
        {tunnel?.error ? (
          <div className="remote-pairing-message error" role="alert">
            {tunnel.error.message}
          </div>
        ) : null}
      </div>

      {state?.wan.enabled ? (
        <div className="remote-pairing-layout">
          <section className="remote-pairing-qr" aria-label="公网配对二维码">
            {wanQrDataUrl ? (
              <img src={wanQrDataUrl} alt="Snow 公网远控配对二维码" />
            ) : (
              <Smartphone size={44} />
            )}
            <span
              className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
            >
              {tunnel?.stage === "online" ? "公网入口已验证" : "公网入口待验证"}
            </span>
          </section>
          <section className="remote-pairing-details">
            <label>自建服务器</label>
            <div className="remote-pairing-message">
              {state.wan.publicOrigin}
            </div>
            <p className="remote-pairing-note">
              本机隧道端口 {state.wan.localPort}
              。二维码五分钟内有效且只能使用一次。
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
