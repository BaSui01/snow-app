#!/usr/bin/env bash
set -Eeuo pipefail

FRP_VERSION="0.71.0"
FRP_SHA256="84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716"
CADDY_VERSION="2.11.3"
CADDY_SHA256="3894577b14657feab3624d782f64175050211e52a228a6f57b4f24f4b0d970f3"
PUBLIC_DOMAIN=""
FRP_DOMAIN=""
ACME_EMAIL=""

usage() {
  echo "用法: sudo bash install-ubuntu.sh --public-domain snow.example.com --frp-domain frp.example.com [--email you@example.com]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-domain) PUBLIC_DOMAIN="${2:-}"; shift 2 ;;
    --frp-domain) FRP_DOMAIN="${2:-}"; shift 2 ;;
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo "请使用 sudo 运行此脚本。" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1 || [[ "$(dpkg --print-architecture 2>/dev/null || true)" != "amd64" ]]; then
  echo "此脚本只支持 Debian/Ubuntu amd64 服务器。" >&2
  exit 1
fi
DOMAIN_RE='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$'
if [[ ! "$PUBLIC_DOMAIN" =~ $DOMAIN_RE || ! "$FRP_DOMAIN" =~ $DOMAIN_RE || ( -n "$ACME_EMAIL" && ! "$ACME_EMAIL" =~ $EMAIL_RE ) || "$PUBLIC_DOMAIN" == *..* || "$FRP_DOMAIN" == *..* || "$PUBLIC_DOMAIN" == *.-* || "$PUBLIC_DOMAIN" == *-.* || "$FRP_DOMAIN" == *.-* || "$FRP_DOMAIN" == *-.* ]]; then
  echo "域名或邮箱格式无效。" >&2
  usage >&2
  exit 2
fi
PUBLIC_DOMAIN="${PUBLIC_DOMAIN,,}"
FRP_DOMAIN="${FRP_DOMAIN,,}"

WORK_DIR="$(mktemp -d /tmp/snow-remote-install.XXXXXX)"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl openssl python3 tar

curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" \
  --output "$WORK_DIR/frp.tar.gz"
echo "${FRP_SHA256}  $WORK_DIR/frp.tar.gz" | sha256sum --check --status
tar -xzf "$WORK_DIR/frp.tar.gz" -C "$WORK_DIR"
install -m 0755 "$WORK_DIR/frp_${FRP_VERSION}_linux_amd64/frps" /usr/local/bin/frps

curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
  --output "$WORK_DIR/caddy.tar.gz"
echo "${CADDY_SHA256}  $WORK_DIR/caddy.tar.gz" | sha256sum --check --status
tar -xzf "$WORK_DIR/caddy.tar.gz" -C "$WORK_DIR" caddy
install -m 0755 "$WORK_DIR/caddy" /usr/local/bin/caddy

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
  echo "现有 FRP 证书与 --frp-domain 不一致。为避免意外轮换 CA，脚本已停止。" >&2
  exit 1
fi
chown root:snow-frp "$CA_CERT" "$SERVER_CERT" "$SERVER_KEY"
chmod 0640 "$CA_CERT" "$SERVER_CERT" "$SERVER_KEY"

install -m 0640 -o root -g snow-frp /dev/stdin /etc/frp/frps.toml <<'EOF'
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = 18080 }]
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
	reverse_proxy 127.0.0.1:18080 {
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

/usr/local/bin/frps verify -c /etc/frp/frps.toml
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable --now snow-frps.service snow-caddy.service

CLIENT_BUNDLE=/root/snow-remote-client.json
PUBLIC_DOMAIN="$PUBLIC_DOMAIN" FRP_DOMAIN="$FRP_DOMAIN" TOKEN_FILE="$TOKEN_FILE" CA_CERT="$CA_CERT" CLIENT_BUNDLE="$CLIENT_BUNDLE" python3 <<'PY'
import json, os
from pathlib import Path
payload = {
    "schemaVersion": 1,
    "kind": "snow-remote-client-config",
    "config": {
        "enabled": True,
        "autoConnect": True,
        "serverAddr": os.environ["FRP_DOMAIN"],
        "serverPort": 7000,
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
echo "Snow 远控服务器端部署完成。"
echo "1. 云防火墙/安全组仅放行 TCP 22、80、443、7000；不要开放 18080。"
echo "2. 将 $CLIENT_BUNDLE 私密下载到 Windows，切勿粘贴到聊天或公开工单。"
echo "3. Snow → 设置 → 手机远控 → 导入服务器配置包。"
echo "4. 手机关闭 Wi-Fi，用蜂窝网络完成最终验收。"
