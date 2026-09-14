import {
  Copy,
  FileUp,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
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
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { CustomSelect, type CustomSelectOption } from "../common/CustomSelect";

type RemoteControlSettingsPanelProps = {
  onClose?: () => void;
};

export function RemoteControlSettingsPanel({
  onClose,
}: RemoteControlSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const authMethodOptions: CustomSelectOption[] = [
    {
      value: "password",
      label: t("remoteControl.authPassword", { defaultValue: "SSH 密码" }),
    },
    {
      value: "privateKey",
      label: t("remoteControl.authPrivateKey", { defaultValue: "SSH 私钥" }),
    },
  ];
  const [state, setState] = useState<RemoteControlPairingState | null>(null);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [portDraft, setPortDraft] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [wanQrDataUrl, setWanQrDataUrl] = useState("");
  const [tunnel, setTunnel] = useState<RemoteTunnelStatus | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    autoConnect: true,
    serverAddr: "",
    serverPort: "7000",
    remotePort: "18080",
    publicOrigin: "",
    tlsServerName: "",
    token: "",
    caCertificate: "",
  });
  const formInitialized = useRef(false);
  const deployCancelRequested = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    tone: "success" | "error" | "info" | "warning";
  } | null>(null);
  const dismissNotice = useCallback((): void => setNotice(null), []);
  const [dnsCheck, setDnsCheck] = useState<RemoteServerDnsCheck | null>(null);
  const [deployProgress, setDeployProgress] =
    useState<RemoteServerDeployProgress | null>(null);
  const [deploymentActive, setDeploymentActive] = useState(false);
  const [deployForm, setDeployForm] = useState({
    serverIp: "",
    rootDomain: "",
    sshPort: "22",
    sshUsername: "root",
    frpBindPort: "7000",
    frpRemotePort: "18080",
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
        remotePort: String(next.config.remotePort),
        publicOrigin: next.config.publicOrigin,
        tlsServerName: next.config.tlsServerName,
      }));
    }
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const [pairing, tunnelStatus] = await Promise.all([
        window.snow.getRemoteControlPairingState(),
        window.snow.getRemoteTunnelStatus(),
      ]);
      applyState(pairing);
      applyTunnel(tunnelStatus);
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeLoadFailed", {
                defaultValue: "无法读取手机远控状态",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [applyState, applyTunnel, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 配置端口变化（首次加载 / 保存成功）时同步输入框；轮询返回同值不打断编辑。 */
  const configuredPort = state?.configuredPort;
  useEffect(() => {
    if (configuredPort !== undefined) {
      setPortDraft(String(configuredPort));
    }
  }, [configuredPort]);

  useEffect(
    () =>
      window.snow.onRemoteControlServerDeployProgress((progress) => {
        setDeployProgress(progress);
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
      width: 520,
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
      width: 520,
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
    setNotice(null);
    try {
      applyState(await window.snow.rotateRemoteControlToken());
      setNotice({
        message: t("remoteControl.noticeRotated", {
          defaultValue: "配对凭据已更换，旧手机连接已失效",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeRotateFailed", {
                defaultValue: "更换失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!selectedUrl) return;
    try {
      await window.snow.writeClipboardText(selectedUrl);
      setNotice({
        message: t("remoteControl.noticeCopied", {
          defaultValue: "配对地址已复制",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeCopyFailed", { defaultValue: "复制失败" }),
        tone: "error",
      });
    }
  };

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyState(await window.snow.setRemoteControlEnabled(next));
      applyTunnel(await window.snow.getRemoteTunnelStatus());
      setNotice({
        message: next
          ? t("remoteControl.noticeEnabled", { defaultValue: "手机远控已开启" })
          : t("remoteControl.noticeDisabled", {
              defaultValue: "手机远控已关闭",
            }),
        tone: next ? "success" : "info",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeToggleFailed", {
                defaultValue: "切换手机远控失败",
              }),
        tone: "error",
      });
      applyState(await window.snow.getRemoteControlPairingState());
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  const savePort = async (): Promise<void> => {
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setNotice({
        message: t("remoteControl.errorInvalidPort", {
          defaultValue: "端口必须是 1 到 65535 的整数",
        }),
        tone: "error",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const wasRunning = state?.running ?? false;
      applyState(await window.snow.setRemoteControlPort(port));
      setNotice({
        message: wasRunning
          ? t("remoteControl.noticePortSavedRunning", {
              values: { port },
              defaultValue:
                "端口已保存为 {{port}}，服务已按新端口重启；已配对手机需要重新扫码",
            })
          : t("remoteControl.noticePortSavedIdle", {
              values: { port },
              defaultValue: "端口已保存为 {{port}}，开启远控后生效",
            }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticePortFailed", {
                defaultValue: "端口设置失败",
              }),
        tone: "error",
      });
      applyState(await window.snow.getRemoteControlPairingState());
    } finally {
      setBusy(false);
    }
  };

  const normalizedRootDomain = deployForm.rootDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.$/, "");

  const checkDns = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.snow.checkRemoteServerDns({
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
      });
      setDnsCheck(result);
      setNotice({
        message: result.ready
          ? t("remoteControl.noticeDnsReady", {
              defaultValue: "两条 DNS 解析均已生效，可以开始自动部署",
            })
          : t("remoteControl.noticeDnsPending", {
              defaultValue:
                "DNS 尚未生效，请核对下方两条 A 记录后稍等几分钟再检测",
            }),
        tone: result.ready ? "success" : "warning",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeDnsFailed", {
                defaultValue: "DNS 检测失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const selectPrivateKey = async (): Promise<void> => {
    const path = await window.snow.sshSelectPrivateKey(
      t("remoteControl.privateKeyDialogTitle", {
        defaultValue: "选择服务器 SSH 私钥",
      }),
    );
    if (path) {
      setDeployForm((current) => ({ ...current, privateKeyPath: path }));
    }
  };

  const deployServer = async (): Promise<void> => {
    setBusy(true);
    setDeploymentActive(true);
    setNotice(null);
    deployCancelRequested.current = false;
    setDeployProgress({
      stage: "checking_dns",
      message: t("remoteControl.deployStarting", {
        defaultValue: "正在开始部署",
      }),
    });
    try {
      const input: RemoteServerDeployInput = {
        serverIp: deployForm.serverIp,
        rootDomain: deployForm.rootDomain,
        sshPort: Number(deployForm.sshPort),
        sshUsername: deployForm.sshUsername,
        authMethod: deployForm.authMethod,
        frpBindPort: Number(deployForm.frpBindPort),
        frpRemotePort: Number(deployForm.frpRemotePort),
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
      setNotice({
        message: t("remoteControl.noticeDeploySuccess", {
          defaultValue:
            "部署成功。请关闭手机 Wi-Fi，用蜂窝网络扫描下方公网二维码验收",
        }),
        tone: "success",
      });
    } catch (error) {
      setDeployProgress(null);
      if (deployCancelRequested.current) {
        setNotice({
          message: t("remoteControl.noticeDeployCanceled", {
            defaultValue: "部署已取消",
          }),
          tone: "info",
        });
      } else {
        setNotice({
          message:
            error instanceof Error
              ? error.message
              : t("remoteControl.noticeDeployFailed", {
                  defaultValue: "服务器自动部署失败",
                }),
          tone: "error",
        });
      }
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      deployCancelRequested.current = false;
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
      deployCancelRequested.current = true;
      setNotice({
        message: t("remoteControl.noticeCancelingDeploy", {
          defaultValue:
            "正在取消部署；服务器上的当前安装命令可能需要片刻才能停止",
        }),
        tone: "info",
      });
    }
  };

  const saveAndConnect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const input: RemoteTunnelConfigInput = {
        enabled: form.enabled,
        autoConnect: form.autoConnect,
        serverAddr: form.serverAddr,
        serverPort: Number(form.serverPort),
        remotePort: Number(form.remotePort),
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
      setNotice({
        message: input.enabled
          ? t("remoteControl.noticeTunnelSaved", {
              defaultValue: "配置已加密保存，正在验证公网入口",
            })
          : t("remoteControl.noticeTunnelDisabled", {
              defaultValue: "公网远控已关闭，局域网远控保持可用",
            }),
        tone: input.enabled ? "info" : "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeTunnelSaveFailed", {
                defaultValue: "保存或连接失败",
              }),
        tone: "error",
      });
      applyTunnel(await window.snow.getRemoteTunnelStatus());
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      applyTunnel(await window.snow.disconnectRemoteTunnel());
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: t("remoteControl.noticeTunnelDisconnected", {
          defaultValue: "公网隧道已断开，局域网远控保持可用",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeDisconnectFailed", {
                defaultValue: "断开失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const importConfig = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.snow.importRemoteTunnelConfig();
      if (result.canceled || !result.status) return;
      formInitialized.current = false;
      applyTunnel(result.status);
      applyState(await window.snow.getRemoteControlPairingState());
      setNotice({
        message: t("remoteControl.noticeImported", {
          defaultValue:
            "配置包已校验并加密保存，Snow 正在连接。导入包含 FRP 凭据，请从下载目录安全删除。",
        }),
        tone: "success",
      });
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("remoteControl.noticeImportFailed", {
                defaultValue: "导入配置包失败",
              }),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const tunnelStageLabel: Record<RemoteTunnelStatus["stage"], string> = {
    stopped: t("remoteControl.tunnelStageStopped", { defaultValue: "已关闭" }),
    starting: t("remoteControl.tunnelStageStarting", {
      defaultValue: "正在启动本机入口",
    }),
    connecting: t("remoteControl.tunnelStageConnecting", {
      defaultValue: "隧道已启动，正在检查 HTTPS",
    }),
    online: t("remoteControl.tunnelStageOnline", {
      defaultValue: "公网入口可用",
    }),
    reconnecting: t("remoteControl.tunnelStageReconnecting", {
      defaultValue: "网络中断，正在重连",
    }),
    failed: t("remoteControl.tunnelStageFailed", { defaultValue: "连接失败" }),
  };

  const endpointStageLabel: Record<
    RemoteTunnelStatus["endpoint"]["stage"],
    string
  > = {
    unchecked: t("remoteControl.endpointUnchecked", { defaultValue: "未检查" }),
    checking: t("remoteControl.endpointChecking", { defaultValue: "正在检查" }),
    reachable: t("remoteControl.endpointReachable", { defaultValue: "已通过" }),
    failed: t("remoteControl.endpointFailed", { defaultValue: "未通过" }),
  };

  return (
    <div
      className="api-settings-page remote-control-settings-page"
      role="region"
    >
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.remoteControl", { defaultValue: "手机远控" })}
          </strong>
          <span className="settings-item-description">
            {t("remoteControl.subtitle", {
              defaultValue: "同一局域网内，用手机浏览器连接这台 Snow。",
            })}
          </span>
        </div>
        {onClose ? (
          <button
            className="icon-btn ghost"
            type="button"
            onClick={onClose}
            aria-label={t("common.close", { defaultValue: "关闭" })}
          >
            <X size={17} />
          </button>
        ) : null}
      </div>

      <div className="remote-master-toggle">
        <div>
          <strong>
            {t("remoteControl.enableTitle", { defaultValue: "启用手机远控" })}
          </strong>
          <p>
            {t("remoteControl.enableDescription", {
              defaultValue:
                "关闭时不会监听端口或连接隧道；开启状态在重启后保持。",
            })}
          </p>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={state?.enabled ?? false}
            disabled={busy || !state}
            onChange={(event) => void toggleEnabled(event.target.checked)}
            hidden
          />
          <span className="toggle-slider" aria-hidden="true" />
        </label>
      </div>

      <div className="remote-port-setting">
        <div>
          <strong>
            {t("remoteControl.portLabel", { defaultValue: "局域网监听端口" })}
          </strong>
          <p>
            {t("remoteControl.portDescription", {
              defaultValue:
                "手机通过该端口访问本机，默认 8788；修改后服务会自动重启。",
            })}
          </p>
        </div>
        <div className="remote-port-input">
          <input
            type="number"
            min="1"
            max="65535"
            value={portDraft}
            onChange={(event) => setPortDraft(event.target.value)}
            disabled={busy || !state}
            spellCheck={false}
            aria-label={t("remoteControl.portLabel", {
              defaultValue: "局域网监听端口",
            })}
          />
          <button
            type="button"
            className="api-settings-action-btn primary"
            onClick={() => void savePort()}
            disabled={
              busy ||
              !state ||
              portDraft.trim() === String(state.configuredPort)
            }
          >
            <Save size={15} strokeWidth={1.9} />
            <span>
              {t("remoteControl.savePort", { defaultValue: "保存端口" })}
            </span>
          </button>
        </div>
      </div>

      {state?.enabled ? (
        <>
          <div className="remote-pairing-layout">
            <section
              className="remote-pairing-qr"
              aria-label={t("remoteControl.lanQrAria", {
                defaultValue: "配对二维码",
              })}
            >
              <div className="remote-qr-card">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={t("remoteControl.lanQrAlt", {
                      defaultValue: "Snow 手机远控配对二维码",
                    })}
                  />
                ) : (
                  <Smartphone size={44} />
                )}
              </div>
              <span
                className={`remote-service-status ${state?.running ? "running" : ""}`}
              >
                {state?.running
                  ? t("remoteControl.listeningOn", {
                      values: { port: state.port },
                      defaultValue: "正在监听 {{port}}",
                    })
                  : t("remoteControl.serviceNotRunning", {
                      defaultValue: "服务未运行",
                    })}
              </span>
            </section>

            <section className="remote-pairing-details">
              <label>
                {t("remoteControl.lanAddress", { defaultValue: "局域网地址" })}
              </label>
              <CustomSelect
                value={selectedUrl}
                options={(state?.pairingUrls ?? []).map((url) => ({
                  value: url,
                  label: url.replace(/([?&]token=)[^&]+/, "$1••••••••"),
                }))}
                onChange={(value) => setSelectedUrl(value)}
                disabled={busy || !state?.running}
              />
              <div className="remote-pairing-actions">
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => void copy()}
                  disabled={!selectedUrl || busy}
                >
                  <Copy size={15} />
                  <span>
                    {t("remoteControl.copyAddress", {
                      defaultValue: "复制地址",
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => void rotate()}
                  disabled={!state?.running || busy}
                >
                  <RotateCcw size={15} />
                  <span>
                    {t("remoteControl.rotateCredentials", {
                      defaultValue: "更换凭据",
                    })}
                  </span>
                </button>
              </div>
              <p className="remote-pairing-note">
                {t("remoteControl.rotateNote", {
                  defaultValue:
                    "更换后，已配对手机及尚未发送的附件会立即失效。",
                })}
              </p>
            </section>
          </div>

          <div className="remote-tunnel-card">
            <div className="remote-tunnel-heading">
              <Server size={18} />
              <div>
                <strong>
                  {t("remoteControl.tunnelTitle", {
                    defaultValue: "自建服务器公网连接",
                  })}
                </strong>
                <p>
                  {t("remoteControl.tunnelDescription", {
                    defaultValue:
                      "安装包已内置并校验 frpc；部署失败时不会保存凭据，验证成功后才会在本机加密保存。",
                  })}
                </p>
              </div>
              <span
                className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
              >
                {tunnel
                  ? tunnelStageLabel[tunnel.stage]
                  : t("remoteControl.statusLoading", {
                      defaultValue: "读取中",
                    })}
              </span>
            </div>

            <div className="remote-tunnel-status-grid">
              <span>
                {t("remoteControl.localWan", { defaultValue: "本机 WAN" })}
              </span>
              <strong>
                {tunnel?.listenerPort
                  ? `127.0.0.1:${tunnel.listenerPort}`
                  : t("remoteControl.notListening", { defaultValue: "未监听" })}
              </strong>
              <span>
                {t("remoteControl.frpTunnel", { defaultValue: "FRP 隧道" })}
              </span>
              <strong>
                {tunnel
                  ? tunnelStageLabel[tunnel.stage]
                  : t("remoteControl.statusUnknown", { defaultValue: "未知" })}
              </strong>
              <span>
                {t("remoteControl.httpsProbe", { defaultValue: "HTTPS 探测" })}
              </span>
              <strong>
                {tunnel
                  ? endpointStageLabel[tunnel.endpoint.stage]
                  : endpointStageLabel.unchecked}
              </strong>
            </div>

            {!tunnel?.config.secureStorageAvailable ? (
              <div className="remote-pairing-message error" role="alert">
                {t("remoteControl.secureStorageUnavailable", {
                  defaultValue:
                    "系统安全存储不可用。为避免明文保存凭据，公网远控已禁用。",
                })}
              </div>
            ) : null}

            <details className="remote-tunnel-guide" open>
              <summary>
                {t("remoteControl.guideSummary", {
                  defaultValue: "第一次公网部署（共 4 步，Snow 负责安装）",
                })}
              </summary>
              <div className="remote-tunnel-guide-content">
                <div className="remote-tunnel-guide-callout">
                  <strong>
                    {t("remoteControl.guideCalloutTitle", {
                      defaultValue: "只在同一 Wi-Fi 使用时，不需要服务器。",
                    })}
                  </strong>
                  <span>
                    {t("remoteControl.guideCalloutText", {
                      defaultValue:
                        "直接扫描上方局域网二维码即可；下面的公网配置可以保持关闭。",
                    })}
                  </span>
                </div>

                <section className="remote-deploy-step">
                  <h4>
                    <b>1</b>{" "}
                    {t("remoteControl.step1Title", {
                      defaultValue: "购买前确认：只需要服务器和域名",
                    })}
                  </h4>
                  <ul>
                    <li>
                      <strong>
                        {t("remoteControl.step1ServerLabel", {
                          defaultValue: "Linux 公网服务器：",
                        })}
                      </strong>
                      {t("remoteControl.step1ServerText", {
                        defaultValue:
                          "任意厂商，Ubuntu 22.04/24.04、Debian 11+、CentOS Stream/Rocky/AlmaLinux 8+ 等常见发行版、x86_64、独立公网 IPv4、长期运行；至少 1 核 1 GB。不要买抢占式、竞价、Windows、数据库、GPU 或预装面板套餐。",
                      })}
                    </li>
                    <li>
                      <strong>
                        {t("remoteControl.step1DomainLabel", {
                          defaultValue: "一个付费域名：",
                        })}
                      </strong>
                      {t("remoteControl.step1DomainText", {
                        defaultValue:
                          "任意注册商和后缀均可。不需要购买 SSL 证书、CDN、云解析高级版、建站或企业邮箱。",
                      })}
                    </li>
                    <li>
                      <strong>
                        {t("remoteControl.step1CredentialLabel", {
                          defaultValue: "服务器登录凭据：",
                        })}
                      </strong>
                      {t("remoteControl.step1CredentialText", {
                        defaultValue:
                          "root 密码或 SSH 私钥。它不是云厂商账号密码；服务器没有初始密码时，在服务器控制台点“设置/重置密码”。",
                      })}
                    </li>
                  </ul>
                </section>

                <section className="remote-deploy-step">
                  <h4>
                    <b>2</b>{" "}
                    {t("remoteControl.step2Title", {
                      defaultValue: "先去两个控制台完成这些设置",
                    })}
                  </h4>
                  <p>
                    <strong>
                      {t("remoteControl.step2DnsLabel", {
                        defaultValue: "域名控制台 → DNS/域名解析 → 添加记录：",
                      })}
                    </strong>
                  </p>
                  <div
                    className="remote-deploy-table"
                    role="table"
                    aria-label={t("remoteControl.dnsTableAria", {
                      defaultValue: "DNS 记录",
                    })}
                  >
                    <strong>
                      {t("remoteControl.dnsType", { defaultValue: "类型" })}
                    </strong>
                    <strong>
                      {t("remoteControl.dnsHost", { defaultValue: "主机记录" })}
                    </strong>
                    <strong>
                      {t("remoteControl.dnsValue", { defaultValue: "记录值" })}
                    </strong>
                    <code>A</code>
                    <code>snow</code>
                    <code>
                      {deployForm.serverIp.trim() ||
                        t("remoteControl.serverIpLabel", {
                          defaultValue: "服务器公网 IP",
                        })}
                    </code>
                    <code>A</code>
                    <code>frp</code>
                    <code>
                      {deployForm.serverIp.trim() ||
                        t("remoteControl.serverIpLabel", {
                          defaultValue: "服务器公网 IP",
                        })}
                    </code>
                  </div>
                  <small>
                    {t("remoteControl.step2DnsHintPrefix", {
                      defaultValue: "主机记录只填",
                    })}{" "}
                    <code>snow</code>{" "}
                    {t("remoteControl.step2DnsHintAnd", { defaultValue: "和" })}{" "}
                    <code>frp</code>
                    {t("remoteControl.step2DnsHintSuffix", {
                      defaultValue: "，不要填写完整域名；线路和 TTL 保持默认。",
                    })}
                    {normalizedRootDomain
                      ? ` ${t("remoteControl.step2DnsHintDomains", {
                          values: { rootDomain: normalizedRootDomain },
                          defaultValue:
                            "保存后会得到 snow.{{rootDomain}} 和 frp.{{rootDomain}}。",
                        })}`
                      : ""}
                  </small>
                  <p>
                    <strong>
                      {t("remoteControl.step2FirewallLabel", {
                        defaultValue:
                          "服务器控制台 → 防火墙/安全组 → 添加入站规则：",
                      })}
                    </strong>
                  </p>
                  <div className="remote-deploy-ports">
                    <code>TCP 22</code>
                    <span>
                      {t("remoteControl.portPurposeSsh", {
                        defaultValue: "Snow 登录服务器",
                      })}
                    </span>
                    <code>TCP 80</code>
                    <span>
                      {t("remoteControl.portPurposeAcme", {
                        defaultValue: "自动申请 HTTPS 证书",
                      })}
                    </span>
                    <code>TCP 443</code>
                    <span>
                      {t("remoteControl.portPurposeHttps", {
                        defaultValue: "手机 HTTPS 访问",
                      })}
                    </span>
                    <code>TCP {deployForm.frpBindPort.trim() || "7000"}</code>
                    <span>
                      {t("remoteControl.portPurposeTunnel", {
                        defaultValue: "Snow 桌面隧道",
                      })}
                    </span>
                  </div>
                  <div className="remote-tunnel-guide-callout warning">
                    <strong>
                      {t("remoteControl.step2ClosedPortWarning", {
                        values: {
                          port: deployForm.frpRemotePort.trim() || "18080",
                        },
                        defaultValue: "不要开放 TCP {{port}}。",
                      })}
                    </strong>
                    <span>
                      {t("remoteControl.step2ClosedPortText", {
                        defaultValue:
                          "它只能在服务器内部使用，Snow 部署结束时会自动检查。",
                      })}
                    </span>
                  </div>
                </section>

                <section className="remote-deploy-step">
                  <h4>
                    <b>3</b>{" "}
                    {t("remoteControl.step3Title", {
                      defaultValue: "再填写 Snow 连接信息",
                    })}
                  </h4>
                  <div className="remote-simple-deploy-form">
                    <label>
                      {t("remoteControl.serverIpLabel", {
                        defaultValue: "服务器公网 IP",
                      })}
                      <small>
                        {t("remoteControl.serverIpHint", {
                          defaultValue:
                            "服务器详情页中的“公网 IP / 公网 IPv4”，不是私有 IP。",
                        })}
                      </small>
                      <input
                        value={deployForm.serverIp}
                        placeholder={t("remoteControl.serverIpExample", {
                          defaultValue: "例如 42.194.128.147",
                        })}
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
                      {t("remoteControl.rootDomainLabel", {
                        defaultValue: "你的根域名",
                      })}
                      <small>
                        {t("remoteControl.rootDomainHint", {
                          defaultValue:
                            "填写买到的域名，如 example.com；不要加 snow、https 或路径。",
                        })}
                      </small>
                      <input
                        value={deployForm.rootDomain}
                        placeholder={t("remoteControl.rootDomainExample", {
                          defaultValue: "例如 example.com",
                        })}
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
                      {t("remoteControl.sshUsername", {
                        defaultValue: "SSH 用户名",
                      })}
                      <small>
                        {t("remoteControl.sshUsernameHint", {
                          defaultValue:
                            "Ubuntu/Debian、CentOS/RHEL 系密码登录通常填 root；云厂商一键登录显示的 admin 不一定能用。",
                        })}
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
                      {t("remoteControl.sshPort", { defaultValue: "SSH 端口" })}
                      <small>
                        {t("remoteControl.sshPortHint", {
                          defaultValue:
                            "服务器远程连接页面显示的端口，未修改时通常是 22。",
                        })}
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
                      {t("remoteControl.frpBindPort", {
                        defaultValue: "FRP 控制端口",
                      })}
                      <small>
                        {t("remoteControl.frpBindPortHint", {
                          defaultValue:
                            "服务器 frps 的控制端口，会写入客户端配置包；未修改时通常是 7000。",
                        })}
                      </small>
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={deployForm.frpBindPort}
                        onChange={(event) =>
                          setDeployForm((current) => ({
                            ...current,
                            frpBindPort: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      {t("remoteControl.frpRemotePort", {
                        defaultValue: "FRP 隧道端口",
                      })}
                      <small>
                        {t("remoteControl.frpRemotePortHint", {
                          defaultValue:
                            "服务器内部隧道端口，只由 Caddy 使用；无需在安全组放行。",
                        })}
                      </small>
                      <input
                        type="number"
                        min="1"
                        max="65535"
                        value={deployForm.frpRemotePort}
                        onChange={(event) =>
                          setDeployForm((current) => ({
                            ...current,
                            frpRemotePort: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      {t("remoteControl.authMethod", {
                        defaultValue: "登录方式",
                      })}
                      <small>
                        {t("remoteControl.authMethodHint", {
                          defaultValue:
                            "新手建议使用在服务器控制台设置的 SSH 密码。",
                        })}
                      </small>
                      <CustomSelect
                        value={deployForm.authMethod}
                        options={authMethodOptions}
                        onChange={(value) =>
                          setDeployForm((current) => ({
                            ...current,
                            authMethod: value as "password" | "privateKey",
                          }))
                        }
                      />
                    </label>
                    {deployForm.authMethod === "password" ? (
                      <label>
                        {t("remoteControl.authPassword", {
                          defaultValue: "SSH 密码",
                        })}
                        <small>
                          {t("remoteControl.sshPasswordHint", {
                            defaultValue:
                              "服务器 root 密码，不是阿里云/腾讯云等网站的登录密码。",
                          })}
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
                          placeholder={t(
                            "remoteControl.sshPasswordPlaceholder",
                            {
                              defaultValue: "只在本次部署期间保存在内存中",
                            },
                          )}
                        />
                      </label>
                    ) : (
                      <>
                        <label className="remote-simple-deploy-key">
                          {t("remoteControl.sshKeyFile", {
                            defaultValue: "SSH 私钥文件",
                          })}
                          <small>
                            {t("remoteControl.sshKeyFileHint", {
                              defaultValue:
                                "选择创建服务器或绑定密钥对时下载到本机的私钥文件。",
                            })}
                          </small>
                          <span>
                            <input
                              value={deployForm.privateKeyPath}
                              readOnly
                              placeholder={t(
                                "remoteControl.sshKeyFilePlaceholder",
                                { defaultValue: "请选择私钥文件" },
                              )}
                            />
                            <button
                              type="button"
                              className="nav-item"
                              onClick={() => void selectPrivateKey()}
                              disabled={busy}
                            >
                              {t("remoteControl.selectFile", {
                                defaultValue: "选择",
                              })}
                            </button>
                          </span>
                        </label>
                        <label>
                          {t("remoteControl.passphrase", {
                            defaultValue: "私钥密码（没有可留空）",
                          })}
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
                    <b>4</b>{" "}
                    {t("remoteControl.step4Title", {
                      defaultValue: "检测成功后再自动部署",
                    })}
                  </h4>
                  <p>
                    {t("remoteControl.step4Text", {
                      defaultValue:
                        "先点“检测 DNS”。两行均为 ✓ 后，再点“自动部署并连接”；之后 FRP、Caddy、token、CA、证书和配置导入都由 Snow 处理。",
                    })}
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
                      <span>
                        {t("remoteControl.checkDns", {
                          defaultValue: "检测 DNS",
                        })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="nav-item remote-import-primary"
                      onClick={() => void deployServer()}
                      disabled={busy || !tunnel?.config.secureStorageAvailable}
                    >
                      <Server size={15} />
                      <span>
                        {t("remoteControl.deployConnect", {
                          defaultValue: "自动部署并连接",
                        })}
                      </span>
                    </button>
                    {deploymentActive ? (
                      <button
                        type="button"
                        className="nav-item"
                        onClick={() => void cancelDeployment()}
                      >
                        {t("remoteControl.cancelDeploy", {
                          defaultValue: "取消部署",
                        })}
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
                      <span>
                        {t(
                          `remoteControl.deployStage.${deployProgress.stage}`,
                          {
                            defaultValue: deployProgress.message,
                          },
                        )}
                      </span>
                    </div>
                  ) : null}
                </section>
              </div>
            </details>

            <details className="remote-tunnel-guide">
              <summary>
                {t("remoteControl.advancedSettings", {
                  defaultValue: "高级设置",
                })}
              </summary>
              <div className="remote-tunnel-guide-content">
                <button
                  type="button"
                  className="nav-item"
                  onClick={() => void importConfig()}
                  disabled={busy || !tunnel?.config.secureStorageAvailable}
                >
                  <FileUp size={15} />
                  <span>
                    {t("remoteControl.importBundle", {
                      defaultValue: "导入已有配置包",
                    })}
                  </span>
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
                    {t("remoteControl.tunnelEnabled", {
                      defaultValue: "启用公网远控",
                    })}
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
                    {t("remoteControl.tunnelAutoConnect", {
                      defaultValue: "Snow 启动后自动连接",
                    })}
                  </label>

                  <label>
                    {t("remoteControl.frpServerAddr", {
                      defaultValue: "FRP 服务器地址",
                    })}
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
                    {t("remoteControl.frpServerPort", {
                      defaultValue: "FRP 端口",
                    })}
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
                    {t("remoteControl.frpRemotePort", {
                      defaultValue: "FRP 隧道端口",
                    })}
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={form.remotePort}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          remotePort: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    {t("remoteControl.publicOrigin", {
                      defaultValue: "手机 HTTPS 地址",
                    })}
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
                    {t("remoteControl.tlsServerName", {
                      defaultValue: "FRP TLS 服务器名称",
                    })}
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
                    {t("remoteControl.frpToken", { defaultValue: "FRP 凭据" })}
                    <input
                      type="password"
                      value={form.token}
                      placeholder={
                        tunnel?.config.hasToken
                          ? t("remoteControl.tokenPlaceholderSaved", {
                              defaultValue: "已加密保存；留空保持不变",
                            })
                          : t("remoteControl.tokenPlaceholderNew", {
                              defaultValue: "至少 32 个字符",
                            })
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
                    {t("remoteControl.frpCa", {
                      defaultValue: "FRP CA 证书（PEM）",
                    })}
                    <textarea
                      value={form.caCertificate}
                      placeholder={
                        tunnel?.config.hasCaCertificate
                          ? t("remoteControl.caPlaceholderSaved", {
                              defaultValue: "证书已加密保存；留空保持不变",
                            })
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
                    <span>
                      {form.enabled
                        ? t("remoteControl.saveAndConnect", {
                            defaultValue: "保存并连接",
                          })
                        : t("remoteControl.saveAndDisable", {
                            defaultValue: "保存并关闭公网",
                          })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="nav-item"
                    onClick={() => void disconnect()}
                    disabled={busy || tunnel?.stage === "stopped"}
                  >
                    <Unplug size={15} />
                    <span>
                      {t("remoteControl.disconnectOnce", {
                        defaultValue: "仅断开本次连接",
                      })}
                    </span>
                  </button>
                </div>
                <div className="remote-tunnel-guide-callout warning">
                  <strong>
                    {t("remoteControl.disconnectWarningTitle", {
                      defaultValue: "“仅断开”不会撤销手机登录。",
                    })}
                  </strong>
                  <span>
                    {t("remoteControl.disconnectWarningText", {
                      defaultValue:
                        "手机丢失或链接泄露时，请使用页面上方的“更换凭据”，让旧手机连接立即失效。",
                    })}
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
              <section
                className="remote-pairing-qr"
                aria-label={t("remoteControl.wanQrAria", {
                  defaultValue: "公网配对二维码",
                })}
              >
                <div className="remote-qr-card">
                  {wanQrDataUrl ? (
                    <img
                      src={wanQrDataUrl}
                      alt={t("remoteControl.wanQrAlt", {
                        defaultValue: "Snow 公网远控配对二维码",
                      })}
                    />
                  ) : (
                    <Smartphone size={44} />
                  )}
                </div>
                <span
                  className={`remote-service-status ${tunnel?.stage === "online" ? "running" : ""}`}
                >
                  {tunnel?.stage === "online"
                    ? t("remoteControl.wanVerified", {
                        defaultValue: "公网入口已验证",
                      })
                    : t("remoteControl.wanPending", {
                        defaultValue: "公网入口待验证",
                      })}
                </span>
              </section>
              <section className="remote-pairing-details">
                <label>
                  {t("remoteControl.selfHostedServer", {
                    defaultValue: "自建服务器",
                  })}
                </label>
                <div className="remote-pairing-message">
                  {state.wan.publicOrigin}
                </div>
                <p className="remote-pairing-note">
                  {t("remoteControl.wanNote", {
                    values: { port: state.wan.localPort },
                    defaultValue:
                      "本机隧道端口 {{port}}。二维码五分钟内有效且只能使用一次。",
                  })}
                </p>
              </section>
            </div>
          ) : null}
        </>
      ) : null}

      <AutoDismissNotice
        message={notice?.message ?? ""}
        tone={notice?.tone ?? "info"}
        onDismiss={dismissNotice}
      />
    </div>
  );
}
