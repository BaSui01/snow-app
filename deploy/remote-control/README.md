# Snow App 自建公网远控模板

> English version: [README_EN.md](README_EN.md)

这套模板把手机 HTTPS 请求转发到桌面 Snow 的专用 WAN listener。公网入口只使用 SSH2 反向隧道（进程内实现，不启动外置隧道子进程）：

```text
手机 -> HTTPS :443 -> Caddy -> 127.0.0.1:<回环端口，默认 18080>
     -> SSH2 反向隧道（桌面端主动发起出站 SSH；服务器端由专用受限 sshd 提供）
     -> 桌面 WAN listener
```

VPS 只做转发，不运行 Agent、不保存 Snow 会话，也不持有手机配对凭据。VPS 能看到 TLS 终止后的流量（Caddy 在 VPS 上终止 HTTPS），因此是分段加密，不是手机到桌面的端到端加密。只应使用你自己信任和管理的 VPS。

## 零基础用户先看这里

如果手机与电脑总在同一 Wi-Fi，完全不需要买服务器，直接扫描 Snow 设置页上方的局域网二维码。

需要在蜂窝网络或外地访问时，用户只购买两样东西，**厂商不限**：

1. 一台长期运行的付费“轻量应用服务器”或普通 VPS：Ubuntu 22+、Debian 11+、Fedora 44+、CentOS Stream/RHEL/Rocky/AlmaLinux 9+，仅 x86_64/amd64、至少 1 核 1GB、20GB 硬盘，并明确包含独立公网 IPv4。购买包月或包年实例，不要购买抢占式、竞价、Windows、数据库、GPU、预装面板、自定义 Alpine 镜像或需要另一台设备保活的套餐。
2. 一个自己长期持有的付费域名：注册商和后缀不限，推荐 `.com` 等常见后缀。不需要购买 SSL 证书、CDN、云解析高级版、企业邮箱或建站套餐。

购买完成后，只需在云控制台手工完成两项厂商相关操作：

1. 添加一条 A 记录：`snow` 指向服务器公网 IPv4；
2. 在安全组或云防火墙中放行 TCP `22`、`80`、`443` 与 SSH2 隧道端口（默认 `7001`，可在 Snow 部署表单修改），不要开放回环隧道端口（默认 `18080`，同样可配置）。

然后进入 Snow“设置 → 手机远控 → 第一次配置”，填写公网 IP、根域名、SSH 登录方式与隧道端口，点击“检测 DNS”和“自动部署并连接”。Snow 的内置部署器会从安装包固定位置读取脚本，通过 SSH 安装受限 sshd 与 Caddy、生成专用密钥、在内存中导入配置并完成安全检查。这个过程不调用聊天 AI，不扫描磁盘，也不消耗模型 token。用户不需要理解或填写 Caddy、PEM、TLS 名称等参数。

密码和私钥口令只用于本次 SSH 连接，不写入远控配置。`AI_DEPLOYMENT_PROMPT.md` 与英文版 `AI_DEPLOYMENT_PROMPT_EN.md` 仅保留给高级运维场景，不是普通用户的推荐路径。

部署结束后，关闭手机 Wi-Fi，用蜂窝网络完成真实公网验收。懂技术的用户可继续阅读下面的手动说明；普通用户到这里即可停止。

## 固定版本与端口

- Caddy `2.11.3`；下载文件、资产名与 SHA-256 在 `versions.json`。`install-ssh2.sh` 内置同一版本与校验值。
- VPS 防火墙只允许 TCP `22`、`80`、`443` 与 SSH2 隧道端口（默认 `7001`）。隧道回环端口（默认 `18080`）必须保持外部不可达。
- Caddy 从 `127.0.0.1:<回环端口>`（默认 `18080`）读取隧道流量；受限 sshd 的 `PermitListen` 也固定为 `127.0.0.1`。
- `install-ssh2.sh` 的提示文本支持中英双语：默认英文，可用 `--lang zh-CN`、`SNOW_LANG=zh-CN` 或 UTF-8 的中文 `LC_ALL`/`LC_MESSAGES`/`LANG` 输出中文；非 UTF-8 的中文 locale 回落英文。参数名、退出码与配置路径不受语言影响。
- 模板不启用任何隧道 Web 管理面板。

## 使用流程

1. DNS 只需要 `snow` 一条 A 记录，指向服务器公网 IPv4。
2. 服务器支持范围：Ubuntu 22+、Debian 11+、Fedora 44+、CentOS Stream/RHEL/Rocky/AlmaLinux 9+，仅 x86_64/amd64，使用 root 或免密码 sudo，需 systemd。
3. 安全组放行 TCP `80`、`443` 与 SSH2 隧道端口（默认 `7001`，可在向导的“SSH2 隧道端口”字段修改）；回环转发端口（默认 `18080`）绝不能对公网开放。
4. 填写服务器公网 IP、根域名与管理员 SSH 登录方式，依次点击“检测 DNS”和“自动部署并连接”。Snow 自动完成：在本机生成专用 ed25519 密钥（只把公钥上传到服务器）；安装独立受限 sshd（`snow-tunnel-sshd.service`，专用 `snow-tunnel` 账户，绝不修改系统自带 sshd）；验证隧道转发与回环端口未暴露；切换 Caddy 上游；最后保存经系统安全存储（safeStorage）加密的配置。
5. 失败自动回滚：部署先验证候选隧道（经服务器回环端口请求 `/health`，预期未配对 `401`），再切换 Caddy 上游；任一步失败都会尽力恢复 Caddy 原上游、恢复旧设备的公钥授权、恢复本机原隧道配置；回滚失败时保留现状并提示人工恢复。
6. 私钥与配置包：本机专用私钥以 OpenSSH 格式保存在系统安全存储加密的配置中，不进入配置包导出；导入不含私钥的配置包后，需要用“自动部署并连接”重新授权此设备（面板会提示缺少隧道私钥）。
7. 密钥与信任：桌面端严格校验服务器主机公钥/指纹（部署时经可信管理连接获取并固定），指纹变化会停止连接并要求重新核对，不会自动接受新指纹。手机访问仍使用现有“公网令牌”，SSH 密钥不能替代手机令牌；手机遗失或链接泄露时轮换“公网令牌”，怀疑隧道密钥泄露时重新部署以替换服务器上授权的公钥。
8. 常见排查：
   - `systemctl status snow-tunnel-sshd.service`、`journalctl -u snow-tunnel-sshd`：查看隧道服务状态与日志；
   - `sshd -T -f /etc/snow-remote/sshd_config`：检查有效配置，应为 `maxsessions 0`、`permitlisten 127.0.0.1:<回环端口>`、`allowtcpforwarding remote`；
   - 服务器文件：`/etc/snow-remote/sshd_config`、`/etc/snow-remote/ssh/`（专用主机密钥与 `authorized_keys`）；
   - 部署器的临时脚本与元数据（`/tmp/snow-ssh2-*`、`/root/snow-remote-ssh2.json`）会在部署结束后自动清理。
9. 边界说明：隧道由桌面端主动发起出站 SSH 连接，请确保桌面网络允许该出站方向且服务器安全组放行隧道端口入站；VPS 上仍由 Caddy 终止 HTTPS，因此仍是分段加密，不是端到端加密。

### 高级手动安装（可选）

懂技术的用户也可以在服务器上手动执行本目录的 `install-ssh2.sh`（部署器执行的就是它；普通用户不需要）：

```bash
sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 \
  --remote-port 18080 --pubkey-file /tmp/snow.pub
```

- `--switch-upstream <port>`：只把 Caddy 回环上游切到 `127.0.0.1:<port>`，执行完即退出；
- `--email <addr>`（可选）：设置 Caddy 申请证书的 ACME 联系邮箱；
- `--lang zh-CN`（或 `SNOW_LANG=zh-CN`）：输出中文提示，默认英文；
- 需要先准备本机公钥文件（内容形如 `ssh-ed25519 AAAA...`）。

## 验收与故障定位

按层检查，避免把“进程存在”误认为“公网可用”：

1. Snow 设置中 WAN listener 为运行状态；
2. 设置页的“SSH2 隧道”状态已认证，主机密钥指纹与服务器一致；
3. VPS 以公网域名作为 Host 请求 `127.0.0.1:18080/health` 时返回未配对的 `401`；
4. `https://snow.example.com/` 返回配对页面；
5. 蜂窝网络手机可配对、查看状态、发送、停止和上传；
6. 轮换公网令牌后旧 Cookie 立即返回 `401`；
7. 停止 SSH2 隧道后公网入口不可用，但 LAN 入口保持工作。

主机密钥或授权错误必须视为配置故障，不应关闭验证或自动无限重试。Caddy 默认自动申请并续期站点证书；DNS、80/443 可达性和续期日志仍需由 VPS 管理员监控。

## 升级与回退

升级前查看 Caddy 官方安全公告和变更记录，更新 `versions.json` 与 `install-ssh2.sh` 中的版本、资产名和 SHA-256，并运行 `caddy validate`。先备份旧二进制；新版本完整代理链验收失败时恢复旧二进制并重启对应服务。若怀疑密钥泄露，应在 Snow 中移除公网配置并重新部署，以替换服务器上授权的公钥。
