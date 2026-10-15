# Snow App 自建公网远控模板

> English version: [README_EN.md](README_EN.md)

这套模板把手机 HTTPS 请求转发到桌面 Snow 的专用 WAN listener。Snow 支持两种隧道方式，二选一作为活动路径：

FRP（默认；本模板第 1–5 节的手动安装流程即对应此方式）：

```text
手机 -> HTTPS :443 -> Caddy -> 127.0.0.1:18080 -> frps
     -> 经认证并验证服务端证书的 FRP TLS 隧道 -> 桌面 frpc
     -> 127.0.0.1:8800 -> Snow WAN listener
```

SSH2（可选；进程内反向隧道，不启动 frpc，详见“SSH2 模式（可选）”一节）：

```text
手机 -> HTTPS :443 -> Caddy -> 127.0.0.1:<回环端口，默认 18080>
     -> SSH2 反向隧道（桌面端主动发起出站 SSH；服务器端由专用受限 sshd 提供）
     -> 桌面 WAN listener
```

VPS 只做转发，不运行 Agent、不保存 Snow 会话，也不持有手机配对凭据。两种方式下 VPS 都能看到 TLS 终止后的流量（Caddy 在 VPS 上终止 HTTPS），因此都是分段加密，不是手机到桌面的端到端加密。只应使用你自己信任和管理的 VPS。

## 零基础用户先看这里

如果手机与电脑总在同一 Wi-Fi，完全不需要买服务器，直接扫描 Snow 设置页上方的局域网二维码。

需要在蜂窝网络或外地访问时，用户只购买两样东西，**厂商不限**：

1. 一台长期运行的付费“轻量应用服务器”或普通 VPS：FRP 使用 Ubuntu 22.04/24.04、Debian 11+、CentOS Stream/RHEL/Rocky/AlmaLinux 8+；SSH2 使用 Ubuntu 22+、Debian 11+、Fedora 44+、CentOS Stream/RHEL/Rocky/AlmaLinux 9+；仅 x86_64/amd64、至少 1 核 1GB、20GB 硬盘，并明确包含独立公网 IPv4。购买包月或包年实例，不要购买抢占式、竞价、Windows、数据库、GPU、预装面板、自定义 Alpine 镜像或需要另一台设备保活的套餐。
2. 一个自己长期持有的付费域名：注册商和后缀不限，推荐 `.com` 等常见后缀。不需要购买 SSL 证书、CDN、云解析高级版、企业邮箱或建站套餐。

购买完成后，只需在云控制台手工完成两项厂商相关操作（需要的记录与端口随所选的“隧道方式”不同）：

1. 添加 A 记录，均指向服务器公网 IPv4：
   - 默认的 FRP 方式需要两条：`snow` 与 `frp`；
   - SSH2 方式只需要 `snow` 一条，不需要 `frp`；
2. 在安全组或云防火墙中放行 TCP `22`、`80`、`443` 与所选方式的隧道端口（FRP 默认 `7000`、SSH2 默认 `7001`，均可在 Snow 部署表单修改），不要开放回环隧道端口（默认 `18080`，同样可配置）。

然后进入 Snow“设置 → 手机远控 → 第一次配置”，在“隧道方式”中选择 FRP（默认）或 SSH2，填写公网 IP、根域名、SSH 登录方式以及对应端口（FRP 默认 `7000`/`18080`，SSH2 默认 `7001`/`18080`），点击“检测 DNS”和“自动部署并连接”。Snow 的内置部署器会从安装包固定位置读取脚本，通过 SSH 安装 FRP/Caddy、生成凭据、在内存中导入配置并完成安全检查。这个过程不调用聊天 AI，不扫描磁盘，也不消耗模型 token。用户不需要理解或填写 FRP、Caddy、token、CA、PEM、TLS 名称等参数。

密码和私钥口令只用于本次 SSH 连接，不写入远控配置。FRP token、CA 私钥和 `snow-remote-client.json` 内容不得粘贴到聊天中。`AI_DEPLOYMENT_PROMPT.md` 与英文版 `AI_DEPLOYMENT_PROMPT_EN.md` 仅保留给旧版本和高级运维场景，不是普通用户的推荐路径。

部署结束后，关闭手机 Wi-Fi，用蜂窝网络完成真实公网验收。懂技术的用户可继续阅读下面的手动说明；普通用户到这里即可停止。

## 固定版本与端口

- frp `0.71.0`，Caddy `2.11.3`；下载文件和 SHA-256 在 `versions.json`。
- 桌面安装包按 `resources/remote-control/frp/<platform>-<arch>` 内置 frpc：Windows x64、macOS arm64/x64、Linux x64。新增平台或架构必须同时补齐二进制、`manifest.json` 和 `package.json` 中对应平台的 `extraResources`。
- VPS 防火墙只允许 TCP `80`、`443` 与 FRP 控制端口（默认 `7000`，可用 `--frp-bind-port` 改为其他端口）。隧道端口（默认 `18080`，可用 `--frp-remote-port` 修改）必须保持外部不可达。
- Caddy 从 `127.0.0.1:<隧道端口>`（默认 `18080`）读取隧道流量；frps 的 `proxyBindAddr` 也固定为 `127.0.0.1`。
- `install-linux.sh` 的提示文本支持中英双语：默认英文，可用 `--lang zh-CN`、`SNOW_LANG=zh-CN` 或 UTF-8 的中文 `LC_ALL`/`LC_MESSAGES`/`LANG` 输出中文；非 UTF-8 的中文 locale 回落英文。参数名、退出码与配置包路径不受语言影响。
- SSH2 方式（可选）不使用 frps/frpc：隧道由 Snow 主进程内置的 `ssh2` 库建立，服务器端由独立受限的 `snow-tunnel-sshd` 提供（默认端口 `7001`），Caddy 上游仍指向 `127.0.0.1:<回环端口>`；`install-ssh2.sh` 同样支持 `--lang zh-CN`/`SNOW_LANG` 双语提示。
- 模板不启用 frps/frpc Web 管理面板。

## SSH2 模式（可选）

SSH2 是可选隧道方式：Snow 主进程用内置的 `ssh2` 库直接建立 SSH 反向 TCP 转发（进程内实现，不再启动 frpc 子进程）。安装包仍内置 frpc（供 FRP 方式使用），两种方式二选一作为活动路径，FRP 行为完全不变。

使用流程（“设置 → 手机远控 → 第一次配置”）：

1. DNS 只需要 `snow` 一条 A 记录，指向服务器公网 IPv4；不需要第二条 `frp` 记录。
2. 服务器支持范围：Ubuntu 22+、Debian 11+、Fedora 44+、CentOS Stream/RHEL/Rocky/AlmaLinux 9+，仅 x86_64/amd64，使用 root 或免密码 sudo，需 systemd。
3. 安全组放行 TCP `80`、`443` 与 SSH2 隧道端口（默认 `7001`，可在向导的“SSH2 隧道端口”字段修改）；回环转发端口（默认 `18080`）绝不能对公网开放。
4. 在“隧道方式”中选择 SSH2，填写服务器公网 IP、根域名与管理员 SSH 登录方式，依次点击“检测 DNS”和“自动部署并连接”。Snow 自动完成：在本机生成专用 ed25519 密钥（只把公钥上传到服务器）；安装独立受限 sshd（`snow-tunnel-sshd.service`，专用 `snow-tunnel` 账户，绝不修改系统自带 sshd）；验证隧道转发与回环端口未暴露；切换 Caddy 上游；最后保存经系统安全存储（safeStorage）加密的配置。
5. 端口冲突：若服务器已有 FRP 且占用了回环端口 `18080`，向导默认建议改用 `18081`；两套隧道不能同时占用同一回环端口。切换活动隧道方式需要重新运行部署并选择目标方式（FRP 的服务与凭据会保留）。
6. 失败自动回滚：部署先验证候选隧道（经服务器回环端口请求 `/health`，预期未配对 `401`），再切换 Caddy 上游；任一步失败都会尽力恢复 Caddy 原上游、恢复旧设备的公钥授权、恢复本机原隧道配置，原 FRP 方案保持可用；回滚失败时保留现状并提示人工恢复。
7. 私钥与配置包：本机专用私钥以 OpenSSH 格式保存在系统安全存储加密的配置中，不进入配置包导出；导入不含私钥的 SSH2 配置包后，需要用“自动部署并连接”重新授权此设备（面板会提示缺少隧道私钥）。
8. 密钥与信任：桌面端严格校验服务器主机公钥/指纹（部署时经可信管理连接获取并固定），指纹变化会停止连接并要求重新核对，不会自动接受新指纹。手机访问仍使用现有“公网令牌”，SSH 密钥不能替代手机令牌；手机遗失或链接泄露时轮换“公网令牌”，怀疑隧道密钥泄露时重新部署以替换服务器上授权的公钥。
9. 常见排查：
   - `systemctl status snow-tunnel-sshd.service`、`journalctl -u snow-tunnel-sshd`：查看隧道服务状态与日志；
   - `sshd -T -f /etc/snow-remote/sshd_config`：检查有效配置，应为 `maxsessions 0`、`permitlisten 127.0.0.1:<回环端口>`、`allowtcpforwarding remote`；
   - 服务器文件：`/etc/snow-remote/sshd_config`、`/etc/snow-remote/ssh/`（专用主机密钥与 `authorized_keys`）；
   - 部署器的临时脚本与元数据（`/tmp/snow-ssh2-*`、`/root/snow-remote-ssh2.json`）会在部署结束后自动清理。
10. 边界说明：SSH2 模式不承诺“不报毒”（安装包仍携带 frpc），但运行时不再启动外置 frpc 子进程；隧道由桌面端主动发起出站 SSH 连接，请确保桌面网络允许该出站方向且服务器安全组放行隧道端口入站；VPS 上仍由 Caddy 终止 HTTPS，因此仍是分段加密，不是端到端加密。

### 高级手动安装（可选）

懂技术的用户也可以在服务器上手动执行本目录的 `install-ssh2.sh`（部署器执行的就是它；普通用户不需要）：

```bash
sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 \
  --remote-port 18080 --pubkey-file /tmp/snow.pub
```

- `--switch-upstream <port>`：只把 Caddy 回环上游切到 `127.0.0.1:<port>`，执行完即退出；
- `--email you@example.com`（可选）：设置 Caddy 申请证书的 ACME 联系邮箱；
- `--lang zh-CN`（或 `SNOW_LANG=zh-CN`）：输出中文提示，默认英文；
- 需要先准备本机公钥文件（内容形如 `ssh-ed25519 AAAA...`）。

## 1. 准备 DNS 与软件

> 以下第 1–5 节为 **FRP 方式**的手动部署与排错说明；采用 SSH2 的用户可跳过本节组，直接阅读上文“SSH2 模式（可选）”。

准备两个 DNS 名称，可以指向同一台 VPS：

- `snow.example.com`：手机 HTTPS 入口；
- `frp.example.com`：桌面 frpc 验证的隧道服务器名称。

从两个项目的官方 Release 下载 `versions.json` 中固定的 Linux amd64 归档，先用 `sha256sum` 对照清单，再安装 `caddy`、`frps`。不要使用未固定的 `latest` 包。

## 2. 创建 FRP 身份材料

以下命令应在 VPS 的受限管理终端中运行；示例域名需替换。CA 私钥只保留在可信离线位置，不得复制到桌面 Snow。

```bash
sudo install -d -m 0750 -o root -g snow-frp /etc/frp/tls
umask 077
openssl rand -base64 48 | sudo tee /etc/frp/snow_remote.token >/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out frp-ca.key
openssl req -x509 -new -sha256 -days 3650 -key frp-ca.key \
  -subj "/CN=Snow Remote FRP CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" -out frp-ca.crt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out frp-server.key
openssl req -new -sha256 -key frp-server.key -subj "/CN=frp.example.com" \
  -addext "subjectAltName=DNS:frp.example.com" -out frp-server.csr
printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:frp.example.com' > frp-server.ext
openssl x509 -req -sha256 -days 825 -in frp-server.csr \
  -CA frp-ca.crt -CAkey frp-ca.key -CAcreateserial \
  -extfile frp-server.ext -out frp-server.crt
```

把 `frp-server.crt` 和 `frp-server.key` 安装到 `/etc/frp/tls/`，权限设为 `0640 root:snow-frp`。桌面只需要：

- `frp-ca.crt` 公钥证书；
- `/etc/frp/snow_remote.token` 中的独立 FRP token。

FRP token 与 Snow 手机远控令牌用途不同，不得复用。token 文件权限在 VPS 和桌面都应限制为仅运行用户可读。

## 3. 安装 VPS 配置

1. 创建不可登录的 `snow-frp` 系统用户。
2. 将 `frps.toml.example` 复制为 `/etc/frp/frps.toml`。
3. 将 `systemd/snow-frps.service` 复制到 `/etc/systemd/system/`。
4. 将 `Caddyfile.example` 复制为 `/etc/caddy/Caddyfile`，为 Caddy 服务设置 `SNOW_REMOTE_DOMAIN=snow.example.com` 和 ACME 联系邮箱。
5. 启动前验证配置：

```bash
/usr/local/bin/frps verify -c /etc/frp/frps.toml
/usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now snow-frps caddy
```

确认 `ss -lntp` 中 `18080` 只绑定 `127.0.0.1`，并从另一台机器确认 `VPS_IP:18080` 无法连接。

## 4. 连接桌面 Snow

Windows、macOS 与 Linux 安装包均已内置对应平台固定版本并校验 SHA-256 的 `frpc`（Windows 为 `frpc.exe`），无需另行下载或手动启动。打开 Snow 的“设置 → 手机远控”，展开“第一次配置”向导并填写：

1. FRP 服务器地址：例如 `frp.example.com`，不要包含协议或路径；
2. FRP 端口：与 VPS 的 `bindPort` 一致，模板默认 `7000`；
3. 手机 HTTPS 地址：例如 `https://snow.example.com`，必须是无路径、查询和凭据的根地址；
4. FRP TLS 服务器名称：必须与 `frp-server.crt` 的 SAN 一致；
5. FRP 凭据：`/etc/frp/snow_remote.token` 的内容；
6. FRP CA 证书：完整粘贴 `frp-ca.crt` PEM 公钥证书。

启用公网远控后点击“保存并连接”。Snow 使用系统安全存储加密持久化 token 和 CA，在仅当前用户可读的临时目录生成运行配置，校验内置 frpc 后启动；断开或退出时会终止子进程并清理临时明文文件。安全存储不可用时拒绝明文保存。

依次确认设置页的“本机 WAN”“FRP 隧道”“HTTPS 探测”均正常，再扫描公网二维码。二维码与地址携带公网令牌；浏览器用它换取 `Secure; HttpOnly; SameSite=Strict` 会话 Cookie。不要把 FRP token 放进域名、二维码或代理日志。

`frpc.toml.example` 保留用于服务器管理员独立排错和验证协议兼容性；日常使用不需要外部 frpc。点击“仅断开本次连接”会保留加密配置以便稍后重连；手机丢失或链接泄露时必须在设置页的“公网令牌”里重新生成并确定更换，使旧 Cookie 和待发送附件立即失效。

## 5. 验收与故障定位

按层检查，避免把“进程存在”误认为“公网可用”：

1. Snow 设置中 WAN listener 为运行状态；
2. frpc 日志显示登录成功且 `snow-remote-control` proxy 启动；
3. VPS 以公网域名作为 Host 请求 `127.0.0.1:18080/health` 时返回未配对的 `401`（Caddy 将此状态作为“隧道可达”）；
4. `https://snow.example.com/` 返回配对页面；
5. 蜂窝网络手机可配对、查看状态、发送、停止和上传；
6. 轮换配对后旧 Cookie 立即返回 `401`；
7. 停止 frpc 后公网入口不可用，但 LAN 入口保持工作。

SSH2 方式的验收与排查见上文“SSH2 模式（可选）”：确认“SSH2 隧道”状态已认证、回环端口 `/health` 返回未配对 `401`、公网域名可达配对页；常用命令为 `systemctl status snow-tunnel-sshd.service` 与 `journalctl -u snow-tunnel-sshd`。

证书错误或 FRP token 错误必须视为配置故障，不应关闭验证或自动无限重试。Caddy 默认自动申请并续期站点证书；DNS、80/443 可达性和续期日志仍需由 VPS 管理员监控。

部分杀毒软件会把内置 frpc 误判为风险程序并拦截运行、删除或隔离，这是 frp 上游长期存在的误报问题。Snow 设置页检测到组件缺失、被修改或无法启动时会显示信任区引导，并给出需要加入白名单的目录路径；按引导处理后若组件已被删除，覆盖安装 Snow 即可恢复，再点击“连接公网”。

以上引导仅适用于 FRP 方式：SSH2 方式运行时不启动 frpc 子进程，但安装包仍携带同一 frpc 组件，仍可能被安全软件扫描拦截，Snow 不承诺“不报毒”。

## 升级与回退

升级前查看 frp/Caddy 官方安全公告和变更记录，更新 `versions.json` 的版本、资产名和 SHA-256，并分别运行 `frps verify`、`frpc verify`、`caddy validate`。先备份旧二进制；新版本完整代理链验收失败时恢复旧二进制并重启对应服务。配置文件和 token 不需要随普通二进制回退而轮换；若怀疑泄露，应单独轮换 FRP token、撤销 Snow 公网配对并重新签发相关证书。
