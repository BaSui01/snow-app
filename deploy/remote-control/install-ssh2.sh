#!/usr/bin/env bash
# Snow 远控 SSH2 隧道服务器端安装脚本。
# 支持 x86_64 的 Ubuntu 22+、Debian 11+（apt）与 Fedora 44+、CentOS/RHEL/Rocky/AlmaLinux 9+（dnf/yum）系统。
# 默认动作：安装或更新专用 snow-tunnel-sshd 隧道服务，绝不修改系统自带 sshd 的配置与服务。
# --switch-upstream <port>：只把 Caddy 的回环上游切到 127.0.0.1:<port>，执行完即退出。
set -Eeuo pipefail

CADDY_VERSION="2.11.3"
CADDY_SHA256="3894577b14657feab3624d782f64175050211e52a228a6f57b4f24f4b0d970f3"
PUBLIC_DOMAIN=""
ACME_EMAIL=""
TUNNEL_PORT="7001"
REMOTE_PORT="18080"
PUBKEY_FILE=""
SWITCH_UPSTREAM_PORT=""

TUNNEL_SERVICE="snow-tunnel-sshd.service"
CADDY_SERVICE="snow-caddy.service"
TUNNEL_CONF_DIR=/etc/snow-remote
TUNNEL_SSH_DIR=/etc/snow-remote/ssh
TUNNEL_HOST_KEY=/etc/snow-remote/ssh/ssh_host_ed25519_key
TUNNEL_HOST_KEY_PUB=/etc/snow-remote/ssh/ssh_host_ed25519_key.pub
SSHD_CONFIG=/etc/snow-remote/sshd_config
AUTHORIZED_KEYS=/etc/snow-remote/ssh/authorized_keys
TUNNEL_UNIT=/etc/systemd/system/snow-tunnel-sshd.service
CADDY_UNIT=/etc/systemd/system/snow-caddy.service
CADDYFILE=/etc/caddy/Caddyfile
SERVER_METADATA=/root/snow-remote-ssh2.json

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
    "en:usage") text="Usage: sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 --remote-port 18080 --pubkey-file /tmp/snow.pub [--email you@example.com] [--lang en|zh-CN]\n       sudo bash install-ssh2.sh --switch-upstream 18080 --public-domain snow.example.com [--lang en|zh-CN]" ;;
    "zh-CN:usage") text="用法: sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 --remote-port 18080 --pubkey-file /tmp/snow.pub [--email you@example.com] [--lang en|zh-CN]\n       sudo bash install-ssh2.sh --switch-upstream 18080 --public-domain snow.example.com [--lang en|zh-CN]" ;;
    "en:unknown_option") text="Unknown option: %s" ;;
    "zh-CN:unknown_option") text="未知参数: %s" ;;
    "en:need_root") text="Run this script with sudo." ;;
    "zh-CN:need_root") text="请使用 sudo 运行此脚本。" ;;
    "en:need_x86_64") text="This script currently supports only x86_64 (amd64) servers." ;;
    "zh-CN:need_x86_64") text="此脚本目前只支持 x86_64（amd64）架构的服务器。" ;;
    "en:no_package_manager") text="No supported package manager found (apt-get, dnf or yum is required)." ;;
    "zh-CN:no_package_manager") text="未检测到受支持的包管理器（需要 apt-get、dnf 或 yum）。" ;;
    "en:need_systemd") text="systemd 232 or newer is required." ;;
    "zh-CN:need_systemd") text="需要 systemd 232 及以上版本。" ;;
    "en:invalid_domain") text="Invalid domain or email format." ;;
    "zh-CN:invalid_domain") text="域名或邮箱格式无效。" ;;
    "en:missing_domain") text="The install action requires --public-domain." ;;
    "zh-CN:missing_domain") text="安装动作必须提供 --public-domain。" ;;
    "en:missing_pubkey_file") text="Public key file not found: %s" ;;
    "zh-CN:missing_pubkey_file") text="公钥文件不存在: %s" ;;
    "en:invalid_pubkey_file") text="The first line of %s is not a supported public key (expected ssh-ed25519 AAAA...)." ;;
    "zh-CN:invalid_pubkey_file") text="%s 的第一行不是受支持的公钥（应形如 ssh-ed25519 AAAA...）。" ;;
    "en:invalid_port") text="Tunnel and upstream ports must be integers between 1 and 65535." ;;
    "zh-CN:invalid_port") text="隧道端口与上游端口必须是 1 到 65535 的整数。" ;;
    "en:same_port") text="The tunnel port and the loopback forward port must differ." ;;
    "zh-CN:same_port") text="隧道端口与回环转发端口不能相同。" ;;
    "en:reserved_port") text="Ports must not be 80 or 443 (Caddy needs them for HTTPS)." ;;
    "zh-CN:reserved_port") text="端口不能使用 80 或 443（Caddy 需要该端口提供 HTTPS）。" ;;
    "en:installing_packages") text="Installing required system packages." ;;
    "zh-CN:installing_packages") text="正在安装所需系统包。" ;;
    "en:sshd_missing") text="sshd was not found even after installing openssh-server." ;;
    "zh-CN:sshd_missing") text="安装 openssh-server 后仍未找到 sshd。" ;;
    "en:generating_host_key") text="Generating the dedicated tunnel host key." ;;
    "zh-CN:generating_host_key") text="正在生成专用隧道主机密钥。" ;;
    "en:reuse_host_key") text="Reusing the existing tunnel host key; its fingerprint stays stable." ;;
    "zh-CN:reuse_host_key") text="复用现有隧道主机密钥，指纹保持不变。" ;;
    "en:restart_tunnel") text="Tunnel configuration changed; restarting snow-tunnel-sshd.service." ;;
    "zh-CN:restart_tunnel") text="隧道配置已变化，重启 snow-tunnel-sshd.service。" ;;
    "en:sshd_test_failed") text="sshd -t rejected /etc/snow-remote/sshd_config; the service was not started." ;;
    "zh-CN:sshd_test_failed") text="sshd -t 校验 /etc/snow-remote/sshd_config 失败，未启动服务。" ;;
    "en:sshd_effective_mismatch") text="The effective tunnel configuration is missing: %s" ;;
    "zh-CN:sshd_effective_mismatch") text="生效的隧道配置中缺少: %s" ;;
    "en:fallback_netstat") text="ss is not available; falling back to netstat for the tunnel listener check." ;;
    "zh-CN:fallback_netstat") text="系统缺少 ss，改用 netstat 校验隧道端口监听。" ;;
    "en:no_listen_tool") text="Neither ss nor netstat is available; the tunnel listener could not be verified." ;;
    "zh-CN:no_listen_tool") text="系统没有 ss 也没有 netstat，无法校验隧道端口监听状态。" ;;
    "en:tunnel_inactive") text="snow-tunnel-sshd.service is not running; tunnel port %s is likely already in use or the configuration was rejected." ;;
    "zh-CN:tunnel_inactive") text="snow-tunnel-sshd.service 未能正常运行；隧道端口 %s 很可能已被占用或配置被拒绝。" ;;
    "en:tunnel_port_missing") text="Tunnel port %s is not listening; free the port or change it, then deploy again." ;;
    "zh-CN:tunnel_port_missing") text="隧道端口 %s 没有监听：请释放被占用的端口或更换端口后重新部署。" ;;
    "en:no_listener") text="No process is listening on %s." ;;
    "zh-CN:no_listener") text="当前没有进程监听 %s。" ;;
    "en:account_unlocked") text="Cleared the locked state of the snow-tunnel account so public key authentication works." ;;
    "zh-CN:account_unlocked") text="已解除 snow-tunnel 账户的锁定状态，公钥认证可用。" ;;
    "en:account_unlock_failed") text="Failed to clear the locked state of the snow-tunnel account." ;;
    "zh-CN:account_unlock_failed") text="无法解除 snow-tunnel 账户的锁定状态。" ;;
    "en:account_locked") text="The snow-tunnel account is locked in /etc/shadow; public key authentication would be rejected." ;;
    "zh-CN:account_locked") text="snow-tunnel 账户在 /etc/shadow 中处于锁定状态，公钥认证会被拒绝。" ;;
    "en:authorized_keys_unreadable") text="The snow-tunnel account cannot read %s; public key authentication would be rejected." ;;
    "zh-CN:authorized_keys_unreadable") text="snow-tunnel 账户无法读取 %s，公钥认证会被拒绝。" ;;
    "en:selfcheck_ok") text="Self-check passed: the snow-tunnel account is unlocked and can read its authorized key." ;;
    "zh-CN:selfcheck_ok") text="自检通过：snow-tunnel 账户未锁定，且可以读取授权公钥。" ;;
    "en:selfcheck_skipped") text="runuser is unavailable; the authorized-key readability self-check was skipped." ;;
    "zh-CN:selfcheck_skipped") text="系统缺少 runuser，已跳过授权公钥可读性自检。" ;;
    "en:selinux_warn") text="SELinux is enabled but the port label could not be configured; add tcp %s to ssh_port_t if the tunnel fails to start." ;;
    "zh-CN:selinux_warn") text="SELinux 已启用但端口标签未能配置；若隧道启动失败，请为 tcp %s 添加 ssh_port_t 标签。" ;;
    "en:caddy_enable_failed") text="snow-caddy.service exists but could not be started; check DNS and certificate state." ;;
    "zh-CN:caddy_enable_failed") text="snow-caddy.service 已存在但未能启动；请检查 DNS 与证书状态。" ;;
    "en:caddy_missing") text="The Caddy binary was not found (expected /usr/local/bin/caddy)." ;;
    "zh-CN:caddy_missing") text="未找到 Caddy 二进制（预期路径 /usr/local/bin/caddy）。" ;;
    "en:downloading_caddy") text="Downloading Caddy %s." ;;
    "zh-CN:downloading_caddy") text="正在下载 Caddy %s。" ;;
    "en:reuse_caddy") text="Caddy %s is already installed; reusing the existing binary." ;;
    "zh-CN:reuse_caddy") text="已安装 Caddy %s，复用现有二进制。" ;;
    "en:caddyfile_created") text="Created a new Snow-managed Caddy site for %s." ;;
    "zh-CN:caddyfile_created") text="已为 %s 创建新的 Snow 管理站点。" ;;
    "en:caddy_inactive") text="snow-caddy.service is not running." ;;
    "zh-CN:caddy_inactive") text="snow-caddy.service 未能正常运行。" ;;
    "en:caddy_validate_failed") text="caddy validate rejected the new configuration; the previous Caddyfile was restored." ;;
    "zh-CN:caddy_validate_failed") text="caddy validate 校验新配置失败，已恢复原 Caddyfile。" ;;
    "en:caddy_reload_failed") text="snow-caddy.service did not stay active after the upstream switch; the previous Caddyfile was restored." ;;
    "zh-CN:caddy_reload_failed") text="切换上游后 snow-caddy.service 未能保持运行，已恢复原 Caddyfile。" ;;
    "en:switch_verify_failed") text="The new upstream 127.0.0.1:%s is not in the Caddyfile after the switch; the previous Caddyfile was restored." ;;
    "zh-CN:switch_verify_failed") text="切换后 Caddyfile 中未找到新上游 127.0.0.1:%s，已恢复原 Caddyfile。" ;;
    "en:switch_no_change") text="Caddy already proxies 127.0.0.1:%s; nothing to change." ;;
    "zh-CN:switch_no_change") text="Caddy 上游已是 127.0.0.1:%s，无需变更。" ;;
    "en:switch_applied") text="Caddy upstream switched to 127.0.0.1:%s." ;;
    "zh-CN:switch_applied") text="Caddy 上游已切换为 127.0.0.1:%s。" ;;
    "en:caddyfile_foreign") text="/etc/caddy/Caddyfile is not a Snow-managed site; automatic upstream switching stopped." ;;
    "zh-CN:caddyfile_foreign") text="/etc/caddy/Caddyfile 不是 Snow 管理的站点，停止自动切换上游。" ;;
    "en:caddyfile_ambiguous") text="Multiple reverse_proxy directives found in /etc/caddy/Caddyfile; refusing to switch automatically." ;;
    "zh-CN:caddyfile_ambiguous") text="/etc/caddy/Caddyfile 中存在多个 reverse_proxy，无法安全自动切换。" ;;
    "en:switch_missing_domain") text="/etc/caddy/Caddyfile does not exist; --public-domain is required to create the site." ;;
    "zh-CN:switch_missing_domain") text="/etc/caddy/Caddyfile 不存在；创建站点时必须提供 --public-domain。" ;;
    "en:done_title") text="Snow remote-control SSH2 tunnel server deployment finished." ;;
    "zh-CN:done_title") text="Snow 远控 SSH2 隧道服务器端部署完成。" ;;
    "en:done_firewall") text="1. In the cloud firewall or security group allow only TCP 22, 80, 443 and %s." ;;
    "zh-CN:done_firewall") text="1. 云防火墙/安全组仅放行 TCP 22、80、443、%s。" ;;
    "en:done_private") text="2. Never expose the loopback forward port %s; it must stay reachable only through 127.0.0.1." ;;
    "zh-CN:done_private") text="2. 不要对公网开放回环转发端口 %s，它只应通过 127.0.0.1 访问。" ;;
    "en:done_service") text="3. snow-tunnel-sshd.service is ready." ;;
    "zh-CN:done_service") text="3. snow-tunnel-sshd.service 隧道服务已就绪。" ;;
    "en:done_metadata") text="4. Server metadata for the desktop deployer: %s" ;;
    "zh-CN:done_metadata") text="4. 供桌面部署器读取的服务器元数据：%s" ;;
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
    --email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --tunnel-port) TUNNEL_PORT="${2:-}"; shift 2 ;;
    --remote-port) REMOTE_PORT="${2:-}"; shift 2 ;;
    --pubkey-file) PUBKEY_FILE="${2:-}"; shift 2 ;;
    --switch-upstream) SWITCH_UPSTREAM_PORT="${2:-}"; shift 2 ;;
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
PACKAGE_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PACKAGE_MANAGER="apt-get"
elif command -v dnf >/dev/null 2>&1; then
  PACKAGE_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
  PACKAGE_MANAGER="yum"
fi
SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR==1 {print $2}')"
if [[ ! "${SYSTEMD_VERSION:-}" =~ ^[0-9]+$ ]] || (( SYSTEMD_VERSION < 232 )); then
  msg need_systemd >&2
  exit 1
fi
DOMAIN_RE='^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$'
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$'
if [[ -n "$PUBLIC_DOMAIN" && ( ! "$PUBLIC_DOMAIN" =~ $DOMAIN_RE || "$PUBLIC_DOMAIN" == *..* || "$PUBLIC_DOMAIN" == *.-* || "$PUBLIC_DOMAIN" == *-.* ) ]] || [[ -n "$ACME_EMAIL" && ! "$ACME_EMAIL" =~ $EMAIL_RE ]]; then
  msg invalid_domain >&2
  usage >&2
  exit 2
fi
PUBLIC_DOMAIN="${PUBLIC_DOMAIN,,}"

PORT_RE='^[0-9]{1,5}$'
if [[ -n "$SWITCH_UPSTREAM_PORT" ]]; then
  # 切换上游动作只需要目标端口；隧道端口与公钥由安装动作负责。
  if [[ ! "$SWITCH_UPSTREAM_PORT" =~ $PORT_RE ]]; then
    msg invalid_port >&2
    usage >&2
    exit 2
  fi
  SWITCH_UPSTREAM_PORT=$((10#$SWITCH_UPSTREAM_PORT))
  if (( SWITCH_UPSTREAM_PORT < 1 || SWITCH_UPSTREAM_PORT > 65535 )); then
    msg invalid_port >&2
    usage >&2
    exit 2
  fi
  if (( SWITCH_UPSTREAM_PORT == 80 || SWITCH_UPSTREAM_PORT == 443 )); then
    msg reserved_port >&2
    exit 2
  fi
else
  if [[ -z "$PUBLIC_DOMAIN" ]]; then
    msg missing_domain >&2
    usage >&2
    exit 2
  fi
  for PORT_VALUE in "$TUNNEL_PORT" "$REMOTE_PORT"; do
    if [[ ! "$PORT_VALUE" =~ $PORT_RE ]]; then
      msg invalid_port >&2
      usage >&2
      exit 2
    fi
  done
  TUNNEL_PORT=$((10#$TUNNEL_PORT))
  REMOTE_PORT=$((10#$REMOTE_PORT))
  if (( TUNNEL_PORT < 1 || TUNNEL_PORT > 65535 || REMOTE_PORT < 1 || REMOTE_PORT > 65535 )); then
    msg invalid_port >&2
    usage >&2
    exit 2
  fi
  if (( TUNNEL_PORT == REMOTE_PORT )); then
    msg same_port >&2
    exit 2
  fi
  if (( TUNNEL_PORT == 80 || TUNNEL_PORT == 443 || REMOTE_PORT == 80 || REMOTE_PORT == 443 )); then
    msg reserved_port >&2
    exit 2
  fi
  if [[ ! -f "$PUBKEY_FILE" ]]; then
    msg missing_pubkey_file "$PUBKEY_FILE" >&2
    exit 2
  fi
  # 只接受受支持的密钥类型；主用 ssh-ed25519，兼容 ssh-rsa 与 ecdsa-sha2-*。
  PUBKEY_LINE="$(head -n 1 "$PUBKEY_FILE" | tr -d '\r' | sed -E 's/[[:space:]]+$//')"
  PUBKEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521)[[:space:]]+AAAA[A-Za-z0-9+/]{12,}={0,3}([[:space:]]+.*)?$'
  if [[ ! "$PUBKEY_LINE" =~ $PUBKEY_RE ]]; then
    msg invalid_pubkey_file "$PUBKEY_FILE" >&2
    exit 2
  fi
fi

WORK_DIR="$(mktemp -d /tmp/snow-remote-ssh2.XXXXXX)"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

# 上次运行若被强制终止（SIGKILL 下 trap 不会执行），会留下旧的解包目录。
# 只清理超过 1 小时的，避免误删并发执行的另一个实例。
find /tmp -maxdepth 1 -type d -name 'snow-remote-ssh2.*' -mmin +60 -exec rm -rf -- {} + 2>/dev/null || true

# 检测 sshd 绝对路径：专用隧道服务只使用它自己的配置，绝不修改系统自带 sshd 的配置。
detect_sshd_binary() {
  local candidate
  for candidate in /usr/sbin/sshd /usr/local/sbin/sshd /sbin/sshd; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate="$(command -v sshd || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  return 1
}

# 解析 Caddy 二进制路径：优先使用本脚本安装的 /usr/local/bin/caddy。
resolve_caddy_binary() {
  if [[ -x /usr/local/bin/caddy ]]; then
    CADDY_BIN=/usr/local/bin/caddy
    return 0
  fi
  local found
  found="$(command -v caddy || true)"
  if [[ -n "$found" ]]; then
    CADDY_BIN="$found"
    return 0
  fi
  CADDY_BIN=""
  return 1
}

# 缺少 curl/tar 时按包管理器安装；RHEL 系镜像常预装 curl-minimal，与 curl 包冲突，故已存在 curl 时跳过。
ensure_download_tools() {
  local tool
  local missing=0
  local install_packages=()
  for tool in curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing=1
    fi
  done
  if (( missing == 0 )); then
    return 0
  fi
  if [[ -z "$PACKAGE_MANAGER" ]]; then
    msg no_package_manager >&2
    exit 1
  fi
  msg installing_packages
  if [[ "$PACKAGE_MANAGER" == "apt-get" ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl tar
  else
    install_packages=(ca-certificates tar)
    if ! command -v curl >/dev/null 2>&1; then
      install_packages+=(curl)
    fi
    "$PACKAGE_MANAGER" install -y "${install_packages[@]}"
  fi
}

# 确保 Caddy 2.11.3 可用；缺失或版本不符时按 install-linux.sh 的下载与 SHA256 校验逻辑安装。
ensure_caddy_binary() {
  if resolve_caddy_binary && "$CADDY_BIN" version 2>/dev/null | grep -qF "$CADDY_VERSION"; then
    msg reuse_caddy "$CADDY_VERSION"
    return 0
  fi
  ensure_download_tools
  msg downloading_caddy "$CADDY_VERSION"
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz" \
    --output "$WORK_DIR/caddy.tar.gz"
  echo "${CADDY_SHA256}  $WORK_DIR/caddy.tar.gz" | sha256sum --check --status
  tar -xzf "$WORK_DIR/caddy.tar.gz" -C "$WORK_DIR" caddy
  install -m 0755 "$WORK_DIR/caddy" /usr/local/bin/caddy
  CADDY_BIN=/usr/local/bin/caddy
}

ensure_caddy_account() {
  getent group caddy >/dev/null || groupadd --system caddy
  id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
  install -d -m 0750 -o caddy -g caddy /etc/caddy /var/lib/caddy
}

# 生成与 install-linux.sh 完全相同的站点模板，只有回环上游端口按本次动作取值。
write_caddy_site() {
  local upstream_port="$1"
  local caddy_email_line=""
  if [[ -n "$ACME_EMAIL" ]]; then
    caddy_email_line="email ${ACME_EMAIL}"
  fi
  cat > "$CADDYFILE" <<EOF
{
	admin off
	${caddy_email_line}
}
${PUBLIC_DOMAIN} {
	reverse_proxy 127.0.0.1:${upstream_port} {
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
  chown root:caddy "$CADDYFILE"
  chmod 0640 "$CADDYFILE"
}

# 仅在缺少 systemd 单元时按 install-linux.sh 的 snow-caddy.service 写法补齐，不覆盖已有单元。
write_caddy_unit() {
  if systemctl cat "$CADDY_SERVICE" >/dev/null 2>&1; then
    return 0
  fi
  cat > "$CADDY_UNIT" <<EOF
[Unit]
Description=Snow Remote HTTPS gateway
After=network-online.target snow-frps.service
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy
ExecStart=${CADDY_BIN} run --environ --config ${CADDYFILE} --adapter caddyfile
ExecReload=${CADDY_BIN} reload --config ${CADDYFILE} --adapter caddyfile --force
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
  chmod 0644 "$CADDY_UNIT"
}

# 默认动作：安装或更新 SSH2 隧道服务（幂等，可重复执行）。
install_tunnel_service() {
  local tool
  local need_packages=0
  local install_packages=()
  for tool in python3 curl tar ssh-keygen; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      need_packages=1
    fi
  done
  SSHD_BIN="$(detect_sshd_binary || true)"
  if [[ -z "$SSHD_BIN" ]]; then
    need_packages=1
  fi
  if (( need_packages == 1 )); then
    if [[ -z "$PACKAGE_MANAGER" ]]; then
      msg no_package_manager >&2
      exit 1
    fi
    msg installing_packages
    if [[ "$PACKAGE_MANAGER" == "apt-get" ]]; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends ca-certificates curl openssh-server python3 tar
    else
      # RHEL 系镜像常预装 curl-minimal，与 curl 包冲突：已存在 curl 时跳过安装。
      install_packages=(ca-certificates openssh-server python3 tar)
      if ! command -v curl >/dev/null 2>&1; then
        install_packages+=(curl)
      fi
      "$PACKAGE_MANAGER" install -y "${install_packages[@]}"
    fi
    SSHD_BIN="$(detect_sshd_binary || true)"
  fi
  if [[ -z "$SSHD_BIN" ]]; then
    msg sshd_missing >&2
    exit 1
  fi

  # 先记录变更前状态：只有配置内容变化或服务未运行时才重启，避免打断已建立的隧道。
  TUNNEL_ACTIVE_BEFORE=0
  if systemctl is-active --quiet "$TUNNEL_SERVICE"; then
    TUNNEL_ACTIVE_BEFORE=1
  fi
  OLD_SSHD_CONFIG_SUM=""
  OLD_AUTHORIZED_KEYS_SUM=""
  if [[ -f "$SSHD_CONFIG" ]]; then
    OLD_SSHD_CONFIG_SUM="$(sha256sum "$SSHD_CONFIG" | awk '{print $1}')"
  fi
  if [[ -f "$AUTHORIZED_KEYS" ]]; then
    OLD_AUTHORIZED_KEYS_SUM="$(sha256sum "$AUTHORIZED_KEYS" | awk '{print $1}')"
  fi

  # 专用目录与专用账户：仅用于隧道，不设置可用口令，也不给它登录 shell。
  install -d -m 0755 -o root -g root "$TUNNEL_CONF_DIR"
  # sshd 以隧道账户自身的身份打开 authorized_keys，所以该目录必须允许这个账户穿越；
  # 0700 root 会让 sshd 报 "Could not open ... authorized keys: Permission denied"。
  install -d -m 0755 -o root -g root "$TUNNEL_SSH_DIR"
  getent group snow-tunnel >/dev/null || groupadd --system snow-tunnel
  id -u snow-tunnel >/dev/null 2>&1 || useradd --system --gid snow-tunnel --home-dir /var/lib/snow-tunnel --shell /usr/sbin/nologin snow-tunnel
  # useradd 默认把 /etc/shadow 的口令字段写成 "!"（锁定）。隧道 sshd 使用 UsePAM no，
  # 此时 sshd 会自行检查锁定状态并拒绝该账户的一切认证方式（含公钥），
  # 日志表现为 "User ... not allowed because account is locked"。
  # 改为 "*"：没有可用于口令登录的口令，但账户不处于锁定状态（同 adduser --disabled-password）。
  TUNNEL_SHADOW="$(getent shadow snow-tunnel 2>/dev/null | cut -d: -f2 || true)"
  if [[ "$TUNNEL_SHADOW" == '!'* ]]; then
    if usermod -p '*' snow-tunnel; then
      msg account_unlocked
    else
      msg account_unlock_failed >&2
      exit 1
    fi
  fi

  # 主机密钥只生成一次，重复执行绝不覆盖，保证桌面端固定的指纹稳定。
  if [[ -f "$TUNNEL_HOST_KEY" ]]; then
    msg reuse_host_key
  else
    msg generating_host_key
    ssh-keygen -q -t ed25519 -N '' -f "$TUNNEL_HOST_KEY"
  fi
  chmod 0600 "$TUNNEL_HOST_KEY"
  chown root:root "$TUNNEL_HOST_KEY"
  if [[ ! -s "$TUNNEL_HOST_KEY_PUB" ]]; then
    ssh-keygen -q -y -f "$TUNNEL_HOST_KEY" > "$TUNNEL_HOST_KEY_PUB"
  fi
  chmod 0644 "$TUNNEL_HOST_KEY_PUB"
  chown root:root "$TUNNEL_HOST_KEY_PUB"

  # 授权公钥每次整体重写：只允许反向端口转发，且只允许监听指定的回环端口。
  # 0644 是必要的：sshd 以隧道账户身份读取该文件，root 独占的 0600 会导致
  # "Could not open user 'snow-tunnel' authorized keys: Permission denied"。
  # 公钥内容本身不是秘密，写入权限仍只属于 root（StrictModes 只禁止组/其他可写）。
  printf -- 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$REMOTE_PORT" "$PUBKEY_LINE" \
    | install -m 0644 -o root -g root /dev/stdin "$AUTHORIZED_KEYS"

  # 专用 sshd 配置：由 Snow 管理，请勿手动修改，每次部署都会整体重写。
  cat > "$SSHD_CONFIG" <<EOF
# 本文件由 Snow 远控部署器生成并管理，请勿手动修改。
Port ${TUNNEL_PORT}
AddressFamily inet
HostKey ${TUNNEL_HOST_KEY}
PidFile /run/snow-tunnel-sshd.pid
AuthorizedKeysFile ${AUTHORIZED_KEYS}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
UseDNS no
AllowUsers snow-tunnel
AllowTcpForwarding remote
AllowAgentForwarding no
AllowStreamLocalForwarding no
GatewayPorts no
PermitListen 127.0.0.1:${REMOTE_PORT}
PermitOpen none
PermitTunnel no
X11Forwarding no
PermitTTY no
MaxSessions 0
LoginGraceTime 30
PrintMotd no
LogLevel INFO
EOF
  chown root:root "$SSHD_CONFIG"
  chmod 0644 "$SSHD_CONFIG"

  cat > "$TUNNEL_UNIT" <<EOF
[Unit]
Description=Snow Remote SSH2 tunnel server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=${SSHD_BIN} -D -f ${SSHD_CONFIG}
Restart=on-failure
RestartSec=5s
[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$TUNNEL_UNIT"

  # 精简环境可能没有执行 systemd-tmpfiles，这里补齐 sshd 需要的特权分离目录。
  if [[ ! -d /run/sshd ]]; then
    install -d -m 0755 /run/sshd
    if command -v restorecon >/dev/null 2>&1; then
      restorecon /run/sshd >/dev/null 2>&1 || true
    fi
  fi

  # 启动前必须通过语法检查与目标用户的有效配置检查。
  if ! "$SSHD_BIN" -t -f "$SSHD_CONFIG"; then
    msg sshd_test_failed >&2
    exit 1
  fi
  EFFECTIVE_SSHD_CONFIG="$("$SSHD_BIN" -T -f "$SSHD_CONFIG" -C user=snow-tunnel,host=localhost,addr=127.0.0.1)"
  for EXPECTED_LINE in "maxsessions 0" "permitlisten 127.0.0.1:${REMOTE_PORT}" "allowtcpforwarding remote"; do
    if ! printf '%s\n' "$EFFECTIVE_SSHD_CONFIG" | grep -qxF "$EXPECTED_LINE"; then
      msg sshd_effective_mismatch "$EXPECTED_LINE" >&2
      printf '%s\n' "$EFFECTIVE_SSHD_CONFIG" | grep -E '^(maxsessions|permitlisten|allowtcpforwarding) ' >&2 || true
      exit 1
    fi
  done

  # SELinux 尽力而为：只尝试添加端口标签与目录上下文，失败仅警告。
  SELINUX_MODE=""
  if command -v getenforce >/dev/null 2>&1; then
    SELINUX_MODE="$(getenforce 2>/dev/null || true)"
  fi
  if [[ -n "$SELINUX_MODE" && "$SELINUX_MODE" != "Disabled" ]]; then
    if command -v semanage >/dev/null 2>&1; then
      if ! semanage port -a -t ssh_port_t -p tcp "$TUNNEL_PORT" >/dev/null 2>&1; then
        semanage port -m -t ssh_port_t -p tcp "$TUNNEL_PORT" >/dev/null 2>&1 || msg selinux_warn "$TUNNEL_PORT" >&2
      fi
    else
      msg selinux_warn "$TUNNEL_PORT" >&2
    fi
    if command -v restorecon >/dev/null 2>&1; then
      restorecon -R "$TUNNEL_CONF_DIR" >/dev/null 2>&1 || msg selinux_warn "$TUNNEL_PORT" >&2
    fi
  fi

  SSHD_CONFIG_SUM="$(sha256sum "$SSHD_CONFIG" | awk '{print $1}')"
  AUTHORIZED_KEYS_SUM="$(sha256sum "$AUTHORIZED_KEYS" | awk '{print $1}')"
  TUNNEL_NEEDS_RESTART=0
  if (( TUNNEL_ACTIVE_BEFORE == 0 )); then
    TUNNEL_NEEDS_RESTART=1
  elif [[ "$SSHD_CONFIG_SUM" != "$OLD_SSHD_CONFIG_SUM" || "$AUTHORIZED_KEYS_SUM" != "$OLD_AUTHORIZED_KEYS_SUM" ]]; then
    TUNNEL_NEEDS_RESTART=1
  fi
  systemctl daemon-reload
  systemctl enable --now "$TUNNEL_SERVICE"
  if (( TUNNEL_NEEDS_RESTART == 1 )); then
    msg restart_tunnel
    systemctl restart "$TUNNEL_SERVICE"
  fi
  sleep 2

  if ! systemctl is-active --quiet "$TUNNEL_SERVICE"; then
    msg tunnel_inactive "$TUNNEL_PORT" >&2
    systemctl --no-pager --full status "$TUNNEL_SERVICE" >&2 || true
    ss -ltnpH 2>/dev/null | grep -E "[:.]${TUNNEL_PORT}[[:space:]]" >&2 || msg no_listener "$TUNNEL_PORT" >&2
    exit 1
  fi
  LISTENER_CHECKED=1
  TUNNEL_LISTENING=0
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | grep -qE "[:.]${TUNNEL_PORT}[[:space:]]"; then
      TUNNEL_LISTENING=1
    fi
  elif command -v netstat >/dev/null 2>&1; then
    msg fallback_netstat >&2
    if netstat -ltn 2>/dev/null | grep -qE "[:.]${TUNNEL_PORT}[[:space:]]"; then
      TUNNEL_LISTENING=1
    fi
  else
    LISTENER_CHECKED=0
    msg no_listen_tool >&2
  fi
  if (( LISTENER_CHECKED == 1 && TUNNEL_LISTENING == 0 )); then
    msg tunnel_port_missing "$TUNNEL_PORT" >&2
    ss -ltnpH 2>/dev/null | grep -E "[:.]${TUNNEL_PORT}[[:space:]]" >&2 || msg no_listener "$TUNNEL_PORT" >&2
    systemctl --no-pager --full status "$TUNNEL_SERVICE" >&2 || true
    exit 1
  fi

  # 收尾自检：服务在运行只说明配置生效，认证本身仍可能因为账户被锁定或授权公钥不可读而失败，
  # 而这两种情况在客户端看来都只是"身份验证失败"，所以在这里提前拦下来。
  if [[ "$(getent shadow snow-tunnel 2>/dev/null | cut -d: -f2 || true)" == '!'* ]]; then
    msg account_locked >&2
    exit 1
  fi
  if command -v runuser >/dev/null 2>&1 && runuser -u snow-tunnel -- true >/dev/null 2>&1; then
    if ! runuser -u snow-tunnel -- test -r "$AUTHORIZED_KEYS" >/dev/null 2>&1; then
      msg authorized_keys_unreadable "$AUTHORIZED_KEYS" >&2
      exit 1
    fi
  else
    msg selfcheck_skipped >&2
  fi
  msg selfcheck_ok

  # 元数据只包含非敏感信息，供桌面部署器在可信连接下读取。
  TUNNEL_HOST_KEY_PUB="$TUNNEL_HOST_KEY_PUB" SERVER_METADATA="$SERVER_METADATA" PUBLIC_DOMAIN="$PUBLIC_DOMAIN" \
    TUNNEL_PORT="$TUNNEL_PORT" REMOTE_PORT="$REMOTE_PORT" CADDYFILE="$CADDYFILE" python3 <<'PY'
import base64, datetime, hashlib, json, os, re
from pathlib import Path
pub_line = Path(os.environ["TUNNEL_HOST_KEY_PUB"]).read_text(encoding="utf-8", errors="replace").splitlines()[0]
blob_b64 = pub_line.split()[1]
blob = base64.b64decode(blob_b64 + "=" * (-len(blob_b64) % 4))
caddyfile = Path(os.environ["CADDYFILE"])
caddy_present = caddyfile.is_file()
upstream_ports = []
if caddy_present:
    upstream_ports = re.findall(r"reverse_proxy\s+127\.0\.0\.1:(\d+)", caddyfile.read_text(encoding="utf-8", errors="replace"))
upstream_port = int(upstream_ports[0]) if len(upstream_ports) == 1 else None
payload = {
    "schemaVersion": 1,
    "kind": "snow-remote-ssh2-server",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "publicDomain": os.environ["PUBLIC_DOMAIN"],
    "username": "snow-tunnel",
    "tunnelPort": int(os.environ["TUNNEL_PORT"]),
    "remotePort": int(os.environ["REMOTE_PORT"]),
    "hostKeyType": "ssh-ed25519",
    "hostKeyPublicKey": blob_b64,
    "hostKeyFingerprint": hashlib.sha256(blob).hexdigest(),
    "caddy": {
        "present": caddy_present,
        "upstreamPort": upstream_port,
    },
}
Path(os.environ["SERVER_METADATA"]).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  chown root:root "$SERVER_METADATA"
  chmod 0600 "$SERVER_METADATA"

  # 已安装 Caddy 但未运行时尽力拉起；失败仅警告，绝不触碰 snow-frp 相关服务。
  if [[ -f "$CADDYFILE" ]] && systemctl cat "$CADDY_SERVICE" >/dev/null 2>&1 && ! systemctl is-active --quiet "$CADDY_SERVICE"; then
    if ! systemctl enable --now "$CADDY_SERVICE"; then
      msg caddy_enable_failed >&2
    fi
  fi

  echo
  msg done_title
  msg done_firewall "$TUNNEL_PORT"
  msg done_private "$REMOTE_PORT"
  msg done_service
  msg done_metadata "$SERVER_METADATA"
}

# 切换上游动作：只改 Caddy 的回环上游端口，成功即退出 0。
switch_caddy_upstream() {
  local target_port="$1"
  local backup_file="$WORK_DIR/Caddyfile.bak"
  local match_count
  local old_port
  local caddyfile_mode
  local caddyfile_owner
  local effective_line

  if [[ ! -f "$CADDYFILE" ]]; then
    # 没有 Caddyfile：按 install-linux.sh 的模板新建站点，再启动 Caddy。
    if [[ -z "$PUBLIC_DOMAIN" ]]; then
      msg switch_missing_domain >&2
      exit 1
    fi
    ensure_caddy_account
    ensure_caddy_binary
    write_caddy_site "$target_port"
    write_caddy_unit
    "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile
    systemctl daemon-reload
    systemctl enable --now "$CADDY_SERVICE"
    sleep 2
    if ! systemctl is-active --quiet "$CADDY_SERVICE"; then
      msg caddy_inactive >&2
      systemctl --no-pager --full status "$CADDY_SERVICE" >&2 || true
      exit 1
    fi
    msg caddyfile_created "$PUBLIC_DOMAIN"
    return 0
  fi

  match_count="$(grep -cE 'reverse_proxy[[:space:]]+127\.0\.0\.1:[0-9]+' "$CADDYFILE" || true)"
  if (( match_count == 0 )); then
    msg caddyfile_foreign >&2
    exit 1
  fi
  if (( match_count > 1 )); then
    msg caddyfile_ambiguous >&2
    exit 1
  fi
  old_port="$(grep -Eo 'reverse_proxy[[:space:]]+127\.0\.0\.1:[0-9]+' "$CADDYFILE" | head -n 1 | sed -E 's/.*:([0-9]+)$/\1/')"
  if (( old_port == target_port )); then
    msg switch_no_change "$target_port"
    return 0
  fi
  if ! resolve_caddy_binary; then
    msg caddy_missing >&2
    exit 1
  fi

  cp -p "$CADDYFILE" "$backup_file"
  caddyfile_mode="$(stat -c '%a' "$CADDYFILE")"
  caddyfile_owner="$(stat -c '%U:%G' "$CADDYFILE")"
  sed -i -E "s/reverse_proxy[[:space:]]+127\.0\.0\.1:${old_port}/reverse_proxy 127.0.0.1:${target_port}/" "$CADDYFILE"
  chown "$caddyfile_owner" "$CADDYFILE"
  chmod "$caddyfile_mode" "$CADDYFILE"

  if ! "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile; then
    cp -p "$backup_file" "$CADDYFILE"
    msg caddy_validate_failed >&2
    exit 1
  fi
  # Snow 生成的 Caddyfile 带 "admin off"，caddy reload（走管理接口）必然失败：
  # 这种情况直接 restart；只有管理接口可用的配置才走不中断的 reload。
  if grep -qE '^[[:space:]]*admin[[:space:]]+off' "$CADDYFILE"; then
    systemctl restart "$CADDY_SERVICE" || true
  elif ! systemctl reload "$CADDY_SERVICE"; then
    systemctl restart "$CADDY_SERVICE" || true
  fi
  sleep 1
  if ! systemctl is-active --quiet "$CADDY_SERVICE"; then
    cp -p "$backup_file" "$CADDYFILE"
    msg caddy_reload_failed >&2
    systemctl --no-pager --full status "$CADDY_SERVICE" >&2 || true
    # 文件已还原，尽力让 Caddy 回到切换前的上游；这里只做尽力恢复。
    systemctl reload "$CADDY_SERVICE" >/dev/null 2>&1 || systemctl restart "$CADDY_SERVICE" >/dev/null 2>&1 || true
    exit 1
  fi
  effective_line="$(grep -Eo "reverse_proxy[[:space:]]+127\.0\.0\.1:${target_port}([^0-9]|$)" "$CADDYFILE" || true)"
  if [[ -z "$effective_line" ]]; then
    cp -p "$backup_file" "$CADDYFILE"
    msg switch_verify_failed "$target_port" >&2
    exit 1
  fi
  msg switch_applied "$target_port"
}

if [[ -n "$SWITCH_UPSTREAM_PORT" ]]; then
  switch_caddy_upstream "$SWITCH_UPSTREAM_PORT"
  exit 0
fi

install_tunnel_service
