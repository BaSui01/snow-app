import { isIP } from "node:net";
import { connect as connectTls } from "node:tls";

const PROBE_TIMEOUT_MS = 10_000;

export type RemoteTunnelProbeTarget = {
  serverAddr: string;
  serverPort: number;
  tlsServerName: string;
  caCertificate: string;
};

const describeProbeError = (
  target: RemoteTunnelProbeTarget,
  error: NodeJS.ErrnoException,
): string => {
  const endpoint = `${target.serverAddr}:${target.serverPort}`;
  switch (error.code) {
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return `${endpoint} 返回的证书不受信任：该端口不是由本次部署生成的 FRP 服务端证书，可能被其他服务或中间设备占用；请确认 frp 域名解析到本机、端口与 snow-frps.service 一致`;
    case "CERT_HAS_EXPIRED":
    case "CERT_NOT_YET_VALID":
      return `${endpoint} 返回的证书时间无效：请先校准服务器时间（NTP）再重新部署`;
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return `${endpoint} 返回的证书域名与 TLS 服务器名称 ${target.tlsServerName} 不一致：请确认 frp 域名解析与证书一致`;
    case "ECONNREFUSED":
      return `${endpoint} 拒绝连接：snow-frps.service 未运行或控制端口不一致`;
    case "ECONNRESET":
      return `${endpoint} 在 TLS 握手期间被重置：连接可能被防火墙或中间设备拦截`;
    case "ETIMEDOUT":
      return `连接 ${endpoint} 超时：请确认安全组或云防火墙已放行该端口`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `无法解析 ${target.serverAddr}：请检查 DNS 解析后重试`;
    default:
      return `${endpoint} TLS 握手失败：${error.message}`;
  }
};

export const probeRemoteTunnelTls = (
  target: RemoteTunnelProbeTarget,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connectTls(
      {
        host: target.serverAddr,
        port: target.serverPort,
        ca: target.caCertificate,
        ...(isIP(target.tlsServerName) === 0
          ? { servername: target.tlsServerName }
          : {}),
        rejectUnauthorized: true,
        timeout: PROBE_TIMEOUT_MS,
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.once("timeout", () => {
      socket.destroy();
      reject(
        new Error(
          `连接 ${target.serverAddr}:${target.serverPort} 在 ${PROBE_TIMEOUT_MS / 1_000} 秒内未完成 TLS 握手：请确认该端口已放行且 snow-frps.service 正在运行`,
        ),
      );
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      reject(new Error(describeProbeError(target, error)));
    });
  });
