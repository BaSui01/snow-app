#!/usr/bin/env bash
# Snow 远控服务器端安装脚本。
# 支持 x86_64 的 Debian/Ubuntu（apt）与 CentOS/RHEL/Rocky/AlmaLinux（dnf/yum）系统。
set -Eeuo pipefail

FRP_VERSION="0.71.0"
FRP_SHA256="84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716"
CADDY_VERSION="2.11.3"
CADDY_SHA256="3894577b14657feab3624d782f64175050211e52a228a6f57b4f24f4b0d970f3"
PUBLIC_DOMAIN=""
FRP_DOMAIN=""
ACME_EMAIL=""
FRP_BIND_PORT="7000"
FRP_REMOTE_PORT="18080"

normalize_lang() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  value="${value%%.*}"
  case "$value" in
    zh|zh_*|zh-*) printf 'zh-CN' ;;
    *) printf 'en' ;;
  esac
}

detect_lang() {
  local value="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
  local lowered
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lowered" == zh* && "$lowered" == *.* && "$lowered" != *utf* ]]; then
    printf 'en'
  else
    normalize_lang "$value"
  fi
}

msg() {
  local key="$1"
  shift
  local text
  case "${LANG_CODE}:${key}" in
    "en:usage") text="Usage: sudo bash install-linux.sh --public-domain snow.example.com --frp-domain frp.example.com [--email you@example.com] [--frp-bind-port 7000] [--frp-remote-port 18080] [--lang en|zh-CN]" ;;
    "zh-CN:usage") text="用法: sudo bash install-linux.sh --public-domain snow.example.com --frp-domain frp.example.com [--email you@example.com] [--frp-bind-port 7000] [--frp-remote-port 18080] [--lang en|zh-CN]" ;;
    "en:unknown_option") text="Unknown option: %s" ;;
    "zh-CN:unknown_option") text="未知参数: %s" ;;
    "en:need_root") text="Run this script with sudo." ;;
    "zh-CN:need_root") text="请使用 sudo 运行此脚本。" ;;
    "en:need_x86_64") text="This script currently supports only x86_64 (amd64) servers." ;;
    "zh-CN:need_x86_64") text="此脚本目前只支持 x86_64（amd64）架构的服务器。" ;;
    "en:no_package_manager") text="No supported package manager found (apt-get, dnf or yum is required)." ;;
    "zh-CN:no_package_manager") text="未检测到受支持的包管理器（需要 apt-get、dnf 或 yum）。" ;;
    "en:need_systemd") text="systemd 232 or newer is required (CentOS/RHEL 8+, Debian 10+, Ubuntu 20.04+)." ;;
    "zh-CN:need_systemd") text="需要 systemd 232 及以上版本（CentOS/RHEL 8+、Debian 10+、Ubuntu 20.04+）。" ;;
    "en:invalid_domain") text="Invalid domain or email format." ;;
    "zh-CN:invalid_domain") text="域名或邮箱格式无效。" ;;
    "en:invalid_port") text="FRP ports must be integers between 1 and 65535." ;;
    "zh-CN:invalid_port") text="FRP 端口必须是 1 到 65535 的整数。" ;;
    "en:same_port") text="The FRP control port and the FRP tunnel port must differ." ;;
    "zh-CN:same_port") text="FRP 控制端口与隧道端口不能相同。" ;;
    "en:reserved_port") text="FRP ports cannot be 80 or 443 (Caddy needs them for HTTPS)." ;;
    "zh-CN:reserved_port") text="FRP 端口不能使用 80 或 443（Caddy 需要该端口提供 HTTPS）。" ;;
    "en:downloading_frps") text="Downloading FRP %s." ;;
    "zh-CN:downloading_frps") text="正在下载 FRP %s。" ;;
    "en:reuse_frps") text="FRP %s is already installed; reusing the existing binary." ;;
    "zh-CN:reuse_frps") text="已安装 FRP %s，复用现有二进制。" ;;
    "en:downloading_caddy") text="Downloading Caddy %s." ;;
    "zh-CN:downloading_caddy") text="正在下载 Caddy %s。" ;;
    "en:reuse_caddy") text="Caddy %s is already installed; reusing the existing binary." ;;
    "zh-CN:reuse_caddy") text="已安装 Caddy %s，复用现有二进制。" ;;
    "en:cert_mismatch") text="The existing FRP certificate does not match --frp-domain; the script stopped to avoid rotating the CA unexpectedly." ;;
    "zh-CN:cert_mismatch") text="现有 FRP 证书与 --frp-domain 不一致。为避免意外轮换 CA，脚本已停止。" ;;
    "en:restart_frps") text="FRP configuration or version changed; restarting snow-frps.service." ;;
    "zh-CN:restart_frps") text="FRP 配置或版本已变化，重启 snow-frps.service。" ;;
    "en:restart_caddy") text="Caddy configuration or version changed; restarting snow-caddy.service." ;;
    "zh-CN:restart_caddy") text="Caddy 配置或版本已变化，重启 snow-caddy.service。" ;;
    "en:frps_inactive") text="snow-frps.service is not running; the FRP control port %s is likely already taken by another service on this server." ;;
    "zh-CN:frps_inactive") text="snow-frps.service 未能正常运行；FRP 控制端口 %s 很可能已被服务器上其他服务占用。" ;;
    "en:no_listener") text="No process is listening on %s." ;;
    "zh-CN:no_listener") text="当前没有进程监听 %s。" ;;
    "en:bind_port_missing") text="FRP control port %s is not listening; change the port or free it, then deploy again." ;;
    "zh-CN:bind_port_missing") text="FRP 控制端口 %s 没有监听：请更换端口或释放被占用的端口后重新部署。" ;;
    "en:caddy_inactive") text="snow-caddy.service is not running." ;;
    "zh-CN:caddy_inactive") text="snow-caddy.service 未能正常运行。" ;;
    "en:done_title") text="Snow remote-control server deployment finished." ;;
    "zh-CN:done_title") text="Snow 远控服务器端部署完成。" ;;
    "en:done_firewall") text="1. In the cloud firewall or security group allow only TCP 22, 80, 443 and %s; do not expose %s." ;;
    "zh-CN:done_firewall") text="1. 云防火墙/安全组仅放行 TCP 22、80、443、%s；不要开放 %s。" ;;
    "en:done_bundle") text="2. Download %s privately to Windows; never paste it into chats or public tickets." ;;
    "zh-CN:done_bundle") text="2. 将 %s 私密下载到 Windows，切勿粘贴到聊天或公开工单。" ;;
    "en:done_import") text="3. Snow -> Settings -> Mobile remote control -> Import server configuration bundle." ;;
    "zh-CN:done_import") text="3. Snow → 设置 → 手机远控 → 导入服务器配置包。" ;;
    "en:done_cellular") text="4. Turn off Wi-Fi on the phone and finish acceptance testing over the cellular network." ;;
    "zh-CN:done_cellular") text="4. 手机关闭 Wi-Fi，用蜂窝网络完成最终验收。" ;;
    *) text="$key" ;;
  esac
  printf -- "${text}\n" "$@"
}

LANG_CODE="$(detect_lang)"
if [[ -n "${SNOW_LANG:-}" ]]; then
  LANG_CODE="$(normalize_lang "${SNOW_LANG}")"
fi
POSITIONAL_ARGS=("$@")
for (( LANG_ARG_INDEX = 0; LANG_ARG_INDEX < ${#POSITIONAL_ARGS[@]}; LANG_ARG_INDEX++ )); do
  if [[ "${POSITIONAL_ARGS[LANG_ARG_INDEX]}" == "--lang" && $(( LANG_ARG_INDEX + 1 )) -lt ${#POSITIONAL_ARGS[@]} ]]; then
    LANG_CODE="$(normalize_lang "${POSITIONAL_ARGS[LANG_ARG_INDEX + 1]}")"
  fi
done

usage() {
  msg usage
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-domain) PUBLIC_DOMAIN="${2:-}"; shift 2 ;;
    --frp-domain) FRP_DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --frp-bind-port) FRP_BIND_PORT="${2:-}"; shift 2 ;;
    --frp-remote-port) FRP_REMOTE_PORT="${2:-}"; shift 2 ;;
    --lang) shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) msg unknown_option "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  msg need_root >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  msg need_x86_64 >&2
  exit 1
fi
if command -v apt-get >/dev/null 2>&1; then
  PACKAGE_MANAGER="apt-get"
elif command -v dnf >/dev/null 2>&1; then
  PACKAGE_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
  PACKAGE_MANAGER="yum"
else
  msg no_package_manager >&2
  exit 1
fi
SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')"
if [[ ! "${SYSTEMD_VERSION:-}" =~ ^[0-9]+$ ]] || (( SYSTEMD_VERSION < 232 )); then
  msg need_systemd >&2
  exit 1
fi
DOMAIN_RE='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$'
if [[ ! "$PUBLIC_DOMAIN" =~ $DOMAIN_RE || ! "$FRP_DOMAIN" =~ $DOMAIN_RE || ( -n "$ACME_EMAIL" && ! "$ACME_EMAIL" =~ $EMAIL_RE ) || "$PUBLIC_DOMAIN" == *..* || "$FRP_DOMAIN" == *..* || "$PUBLIC_DOMAIN" == *.-* || "$PUBLIC_DOMAIN" == *-.* || "$FRP_DOMAIN" == *.-* || "$FRP_DOMAIN" == *-.* ]]; then
  msg invalid_domain >&2
  usage >&2
  exit 2
fi
PUBLIC_DOMAIN="${PUBLIC_DOMAIN,,}"
FRP_DOMAIN="${FRP_DOMAIN,,}"

PORT_RE='^[0-9]{1,5}$'
for FRP_PORT_VALUE in "$FRP_BIND_PORT" "$FRP_REMOTE_PORT"; do
  if [[ ! "$FRP_PORT_VALUE" =~ $PORT_RE ]]; then
    msg invalid_port >&2
    usage >&2
    exit 2
  fi
done
FRP_BIND_PORT=$((10#$FRP_BIND_PORT))
FRP_REMOTE_PORT=$((10#$FRP_REMOTE_PORT))
if (( FRP_BIND_PORT < 1 || FRP_BIND_PORT > 65535 || FRP_REMOTE_PORT < 1 || FRP_REMOTE_PORT > 65535 )); then
  msg invalid_port >&2
  usage >&2
  exit 2
fi
if (( FRP_BIND_PORT == FRP_REMOTE_PORT )); then
  msg same_port >&2
  exit 2
fi
if (( FRP_BIND_PORT == 80 || FRP_BIND_PORT == 443 || FRP_REMOTE_PORT == 80 || FRP_REMOTE_PORT == 443 )); then
  msg reserved_port >&2
  exit 2
fi

WORK_DIR="$(mktemp -d /tmp/snow-remote-install.XXXXXX)"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

FRPS_BIN=/usr/local/bin/frps
CADDY_BIN=/usr/local/bin/caddy
REUSE_FRPS=0
REUSE_CADDY=0
if [[ -x "$FRPS_BIN" ]] && "$FRPS_BIN" --version 2>/dev/null | grep -qF "$FRP_VERSION"; then
  REUSE_FRPS=1
fi
if [[ -x "$CADDY_BIN" ]] && "$CADDY_BIN" version 2>/dev/null | grep -qF "$CADDY_VERSION"; then
  REUSE_CADDY=1
fi

NEED_PACKAGES=0
for REQUIRED_TOOL in openssl python3; do
  if ! command -v "$REQUIRED_TOOL" >/dev/null 2>&1; then
    NEED_PACKAGES=1
  fi
done
if (( REUSE_FRPS == 0 || REUSE_CADDY == 0 )); then
  NEED_PACKAGES=1
fi
if (( NEED_PACKAGES == 1 )); then
  if [[ "$PACKAGE_MANAGER" == "apt-get" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl openssl python3 tar
  else
    # RHEL 系镜像常预装 curl-minimal，与 curl 包冲突：已存在 curl 时跳过安装。
    INSTALL_PACKAGES=(ca-certificates openssl python3 tar)
    if ! command -v curl >/dev/null 2>&1; then
      INSTALL_PACKAGES+=(curl)
    fi
    "$PACKAGE_MANAGER" install -y "${INSTALL_PACKAGES[@]}"
  fi
fi

if (( REUSE_FRPS == 0 )); then
  msg downloading_frps "$FRP_VERSION"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
    --output "$WORK_DIR/frp.tar.gz"
  echo "${FRP_SHA256}  $WORK_DIR/frp.tar.gz" | sha256sum --check --status
  tar -xzf "$WORK_DIR/frp.tar.gz" -C "$WORK_DIR"
  install -m 0755 "$WORK_DIR/frp_${FRP_VERSION}_linux_amd64/frps" "$FRPS_BIN"
else
  msg reuse_frps "$FRP_VERSION"
fi

if (( REUSE_CADDY == 0 )); then
  msg downloading_caddy "$CADDY_VERSION"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
    --output "$WORK_DIR/caddy.tar.gz"
  echo "${CADDY_SHA256}  $WORK_DIR/caddy.tar.gz" | sha256sum --check --status
  tar -xzf "$WORK_DIR/caddy.tar.gz" -C "$WORK_DIR" caddy
  install -m 0755 "$WORK_DIR/caddy" "$CADDY_BIN"
else
  msg reuse_caddy "$CADDY_VERSION"
fi

OLD_FRPS_SUM=""
OLD_CADDY_SUM=""
if [[ -f /etc/frp/frps.toml ]]; then
  OLD_FRPS_SUM="$(sha256sum /etc/frp/frps.toml | awk '{print $1}')"
fi
if [[ -f /etc/caddy/Caddyfile ]]; then
  OLD_CADDY_SUM="$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')"
fi

getent group snow-frp >/dev/null || groupadd --system snow-frp
id -u snow-frp >/dev/null 2>&1 || useradd --system --gid snow-frp --home-dir /var/lib/snow-frp --shell /usr/sbin/nologin snow-frp
getent group caddy >/dev/null || groupadd --system caddy
id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
install -d -m 0750 -o root -g snow-frp /etc/frp /etc/frp/tls
install -d -m 0750 -o caddy -g caddy /etc/caddy /var/lib/caddy

TOKEN_FILE=/etc/frp/snow_remote.token
if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -base64 48 > "$TOKEN_FILE"
fi
chown root:snow-frp "$TOKEN_FILE"
chmod 0640 "$TOKEN_FILE"

CA_CERT=/etc/frp/tls/frp-ca.crt
SERVER_CERT=/etc/frp/tls/frp-server.crt
SERVER_KEY=/etc/frp/tls/frp-server.key
if [[ ! -s "$CA_CERT" || ! -s "$SERVER_CERT" || ! -s "$SERVER_KEY" ]]; then
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$WORK_DIR/frp-ca.key"
  openssl req -x509 -new -sha256 -days 3650 -key "$WORK_DIR/frp-ca.key" \
    -subj "/CN=Snow Remote FRP CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$CA_CERT"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$SERVER_KEY"
  openssl req -new -sha256 -key "$SERVER_KEY" -subj "/CN=${FRP_DOMAIN}" \
    -addext "subjectAltName=DNS:${FRP_DOMAIN}" -out "$WORK_DIR/frp-server.csr"
  printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' \
    "subjectAltName=DNS:${FRP_DOMAIN}" > "$WORK_DIR/frp-server.ext"
  openssl x509 -req -sha256 -days 825 -in "$WORK_DIR/frp-server.csr" \
    -CA "$CA_CERT" -CAkey "$WORK_DIR/frp-ca.key" -CAcreateserial \
    -extfile "$WORK_DIR/frp-server.ext" -out "$SERVER_CERT"
elif ! openssl x509 -in "$SERVER_CERT" -noout -checkhost "$FRP_DOMAIN" >/dev/null 2>&1; then
  msg cert_mismatch >&2
  exit 1
fi
chown root:snow-frp "$CA_CERT" "$SERVER_CERT" "$SERVER_KEY"
chmod 0640 "$CA_CERT" "$SERVER_CERT" "$SERVER_KEY"

install -m 0640 -o root -g snow-frp /dev/stdin /etc/frp/frps.toml <<EOF
bindAddr = "0.0.0.0"
bindPort = ${FRP_BIND_PORT}
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = ${FRP_REMOTE_PORT} }]
maxPortsPerClient = 1
auth.method = "token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/frp/snow_remote.token"
transport.tls.force = true
transport.tls.certFile = "/etc/frp/tls/frp-server.crt"
transport.tls.keyFile = "/etc/frp/tls/frp-server.key"
log.to = "console"
log.level = "info"
log.disablePrintColor = true
EOF

if [[ -n "$ACME_EMAIL" ]]; then
  CADDY_EMAIL_LINE="email ${ACME_EMAIL}"
else
  CADDY_EMAIL_LINE=""
fi
cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
	${CADDY_EMAIL_LINE}
}
${PUBLIC_DOMAIN} {
	reverse_proxy 127.0.0.1:${FRP_REMOTE_PORT} {
		header_up Host ${PUBLIC_DOMAIN}
		header_up -X-Forwarded-For
		header_up -X-Forwarded-Host
		header_up -X-Forwarded-Proto
		health_uri /health
		health_status 401
		health_interval 30s
		health_timeout 3s
		health_headers {
			Host ${PUBLIC_DOMAIN}
		}
	}
}
EOF
chown root:caddy /etc/caddy/Caddyfile
chmod 0640 /etc/caddy/Caddyfile

cat > /etc/systemd/system/snow-frps.service <<'EOF'
[Unit]
Description=Snow Remote FRP server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=snow-frp
Group=snow-frp
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/frp
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/snow-caddy.service <<'EOF'
[Unit]
Description=Snow Remote HTTPS gateway
After=network-online.target snow-frps.service
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/caddy
[Install]
WantedBy=multi-user.target
EOF

FRPS_ACTIVE_BEFORE=0
CADDY_ACTIVE_BEFORE=0
if systemctl is-active --quiet snow-frps.service; then
  FRPS_ACTIVE_BEFORE=1
fi
if systemctl is-active --quiet snow-caddy.service; then
  CADDY_ACTIVE_BEFORE=1
fi
FRPS_SUM="$(sha256sum /etc/frp/frps.toml | awk '{print $1}')"
CADDY_SUM="$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')"
FRPS_NEEDS_RESTART=0
CADDY_NEEDS_RESTART=0
if (( FRPS_ACTIVE_BEFORE == 1 )); then
  if (( REUSE_FRPS == 0 )) || [[ "$FRPS_SUM" != "$OLD_FRPS_SUM" ]]; then
    FRPS_NEEDS_RESTART=1
  fi
fi
if (( CADDY_ACTIVE_BEFORE == 1 )); then
  if (( REUSE_CADDY == 0 )) || [[ "$CADDY_SUM" != "$OLD_CADDY_SUM" ]]; then
    CADDY_NEEDS_RESTART=1
  fi
fi

/usr/local/bin/frps verify -c /etc/frp/frps.toml
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable --now snow-frps.service snow-caddy.service
if (( FRPS_NEEDS_RESTART == 1 )); then
  msg restart_frps
  systemctl restart snow-frps.service
fi
if (( CADDY_NEEDS_RESTART == 1 )); then
  msg restart_caddy
  systemctl restart snow-caddy.service
fi
sleep 3

if ! systemctl is-active --quiet snow-frps.service; then
  msg frps_inactive "$FRP_BIND_PORT" >&2
  ss -ltnpH 2>/dev/null | grep -E "[:.]${FRP_BIND_PORT}[[:space:]]" >&2 || msg no_listener "$FRP_BIND_PORT" >&2
  systemctl --no-pager --full status snow-frps.service >&2 || true
  exit 1
fi
if ! ss -ltnH 2>/dev/null | grep -qE "[:.]${FRP_BIND_PORT}[[:space:]]"; then
  msg bind_port_missing "$FRP_BIND_PORT" >&2
  exit 1
fi
if ! systemctl is-active --quiet snow-caddy.service; then
  msg caddy_inactive >&2
  systemctl --no-pager --full status snow-caddy.service >&2 || true
  exit 1
fi

CLIENT_BUNDLE=/root/snow-remote-client.json
PUBLIC_DOMAIN="$PUBLIC_DOMAIN" FRP_DOMAIN="$FRP_DOMAIN" TOKEN_FILE="$TOKEN_FILE" CA_CERT="$CA_CERT" CLIENT_BUNDLE="$CLIENT_BUNDLE" FRP_BIND_PORT="$FRP_BIND_PORT" FRP_REMOTE_PORT="$FRP_REMOTE_PORT" python3 <<'PY'
import json, os
from pathlib import Path
payload = {
    "schemaVersion": 1,
    "kind": "snow-remote-client-config",
    "config": {
        "enabled": True,
        "autoConnect": True,
        "serverAddr": os.environ["FRP_DOMAIN"],
        "serverPort": int(os.environ["FRP_BIND_PORT"]),
        "remotePort": int(os.environ["FRP_REMOTE_PORT"]),
        "publicOrigin": "https://" + os.environ["PUBLIC_DOMAIN"],
        "tlsServerName": os.environ["FRP_DOMAIN"],
        "token": Path(os.environ["TOKEN_FILE"]).read_text().strip(),
        "caCertificate": Path(os.environ["CA_CERT"]).read_text(),
    },
}
Path(os.environ["CLIENT_BUNDLE"]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY
chmod 0600 "$CLIENT_BUNDLE"

echo
msg done_title
msg done_firewall "$FRP_BIND_PORT" "$FRP_REMOTE_PORT"
msg done_bundle "$CLIENT_BUNDLE"
msg done_import
msg done_cellular
