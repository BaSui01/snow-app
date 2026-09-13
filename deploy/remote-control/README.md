# Snow App 自建公网远控模板

这套模板把手机 HTTPS 请求转发到桌面 Snow 的专用 WAN listener：

```text
手机 -> HTTPS :443 -> Caddy -> 127.0.0.1:18080 -> frps
     -> 经认证并验证服务端证书的 FRP TLS 隧道 -> 桌面 frpc
     -> 127.0.0.1:8800 -> Snow WAN listener
```

VPS 只做转发，不运行 Agent、不保存 Snow 会话，也不持有手机配对凭据。它仍能看到 TLS 终止后的流量，因此这是分段加密，不是手机到桌面的端到端加密。只应使用你自己信任和管理的 VPS。

## 零基础用户先看这里

如果手机与电脑总在同一 Wi-Fi，完全不需要买服务器，直接扫描 Snow 设置页上方的局域网二维码。

需要在蜂窝网络或外地访问时，用户只购买两样东西，**厂商不限**：

1. 一台长期运行的付费“轻量应用服务器”或普通 VPS：Ubuntu 24.04/22.04、x86_64、至少 1 核 1GB、20GB 硬盘，并明确包含独立公网 IPv4。购买包月或包年实例，不要购买抢占式、竞价、Windows、数据库、GPU、预装面板、自定义 Alpine 镜像或需要另一台设备保活的套餐。
2. 一个自己长期持有的付费域名：注册商和后缀不限，推荐 `.com` 等常见后缀。不需要购买 SSL 证书、CDN、云解析高级版、企业邮箱或建站套餐。

购买完成后，只需在云控制台手工完成两项厂商相关操作：

1. 添加 `snow` 和 `frp` 两条 A 记录，均指向服务器公网 IPv4；
2. 在安全组或云防火墙中放行 TCP `22`、`80`、`443`、`7000`，不要开放 `18080`。

然后进入 Snow“设置 → 手机远控”，填写公网 IP、根域名和 SSH 登录方式，点击“检测 DNS”和“自动部署并连接”。Snow 的内置部署器会从安装包固定位置读取脚本，通过 SSH 安装 FRP/Caddy、生成凭据、在内存中导入配置并完成安全检查。这个过程不调用聊天 AI，不扫描磁盘，也不消耗模型 token。用户不需要理解或填写 FRP、Caddy、token、CA、PEM、TLS 名称等参数。

密码和私钥口令只用于本次 SSH 连接，不写入远控配置。FRP token、CA 私钥和 `snow-remote-client.json` 内容不得粘贴到聊天中。`AI_DEPLOYMENT_PROMPT.md` 仅保留给旧版本和高级运维场景，不是普通用户的推荐路径。

部署结束后，关闭手机 Wi-Fi，用蜂窝网络完成真实公网验收。懂技术的用户可继续阅读下面的手动说明；普通用户到这里即可停止。

## 固定版本与端口

- frp `0.71.0`，Caddy `2.11.3`；下载文件和 SHA-256 在 `versions.json`。
- VPS 防火墙只允许 TCP `80`、`443`、`7000`。`18080` 必须保持外部不可达。
- Caddy 从 `127.0.0.1:18080` 读取隧道流量；frps 的 `proxyBindAddr` 也固定为 `127.0.0.1`。
- 模板不启用 frps/frpc Web 管理面板。

## 1. 准备 DNS 与软件

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

FRP token 与 Snow 手机配对码用途不同，不得复用。token 文件权限在 VPS 和桌面都应限制为仅运行用户可读。

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

Windows x64 安装包已经内置固定版本并校验 SHA-256 的 `frpc.exe`，无需另行下载或手动启动。打开 Snow 的“设置 → 手机远控”，展开“第一次配置”向导并填写：

1. FRP 服务器地址：例如 `frp.example.com`，不要包含协议或路径；
2. FRP 端口：与 VPS 的 `bindPort` 一致，模板默认 `7000`；
3. 手机 HTTPS 地址：例如 `https://snow.example.com`，必须是无路径、查询和凭据的根地址；
4. FRP TLS 服务器名称：必须与 `frp-server.crt` 的 SAN 一致；
5. FRP 凭据：`/etc/frp/snow_remote.token` 的内容；
6. FRP CA 证书：完整粘贴 `frp-ca.crt` PEM 公钥证书。

启用公网远控后点击“保存并连接”。Snow 使用系统安全存储加密持久化 token 和 CA，在仅当前用户可读的临时目录生成运行配置，校验内置 frpc 后启动；断开或退出时会终止子进程并清理临时明文文件。安全存储不可用时拒绝明文保存。

依次确认设置页的“本机 WAN”“FRP 隧道”“HTTPS 探测”均正常，再扫描短期、一次性公网二维码。二维码只包含 URL fragment；浏览器会用它换取 `Secure; HttpOnly; SameSite=Strict` 会话 Cookie。不要把长期 LAN token 或 FRP token 放进域名、二维码或代理日志。

`frpc.toml.example` 保留用于服务器管理员独立排错和验证协议兼容性；日常使用不需要外部 frpc。点击“仅断开本次连接”会保留加密配置以便稍后重连；手机丢失或链接泄露时必须在上方轮换配对凭据，使旧配对码、Cookie 和待发送附件立即失效。

## 5. 验收与故障定位

按层检查，避免把“进程存在”误认为“公网可用”：

1. Snow 设置中 WAN listener 为运行状态；
2. frpc 日志显示登录成功且 `snow-remote-control` proxy 启动；
3. VPS 以公网域名作为 Host 请求 `127.0.0.1:18080/health` 时返回未配对的 `401`（Caddy 将此状态作为“隧道可达”）；
4. `https://snow.example.com/` 返回配对页面；
5. 蜂窝网络手机可配对、查看状态、发送、停止和上传；
6. 轮换配对后旧 Cookie 立即返回 `401`；
7. 停止 frpc 后公网入口不可用，但 LAN 入口保持工作。

证书错误或 FRP token 错误必须视为配置故障，不应关闭验证或自动无限重试。Caddy 默认自动申请并续期站点证书；DNS、80/443 可达性和续期日志仍需由 VPS 管理员监控。

## 升级与回退

升级前查看 frp/Caddy 官方安全公告和变更记录，更新 `versions.json` 的版本、资产名和 SHA-256，并分别运行 `frps verify`、`frpc verify`、`caddy validate`。先备份旧二进制；新版本完整代理链验收失败时恢复旧二进制并重启对应服务。配置文件和 token 不需要随普通二进制回退而轮换；若怀疑泄露，应单独轮换 FRP token、撤销 Snow 公网配对并重新签发相关证书。
