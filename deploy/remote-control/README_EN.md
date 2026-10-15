# Snow App self-hosted public WAN remote-control template

> Chinese version: [README.md](README.md)

Snow supports two tunnel modes, one of which is the active path at a time:

FRP (default; sections 1-5 below are the manual setup for this mode):

```text
phone -> HTTPS :443 -> Caddy -> 127.0.0.1:18080 -> frps
      -> authenticated FRP TLS tunnel with server-certificate verification -> desktop frpc
      -> 127.0.0.1:8800 -> Snow WAN listener
```

SSH2 (optional; an in-process reverse tunnel that starts no frpc, see "SSH2 mode (optional)" below):

```text
phone -> HTTPS :443 -> Caddy -> 127.0.0.1:<loopback port, default 18080>
      -> SSH2 reverse tunnel (the desktop initiates the outbound SSH connection; served by the dedicated restricted sshd)
      -> Snow WAN listener
```

The VPS only forwards traffic: it runs no Agent, keeps no Snow session, and holds no phone pairing credential. In both modes the VPS still sees traffic after TLS termination (Caddy terminates HTTPS on the VPS), so both are segmented encryption, not phone-to-desktop end-to-end encryption. Use only a VPS that you trust and manage yourself.

## If you are new to servers, read this first

If the phone and the computer are always on the same Wi-Fi, you do not need to buy a server at all: just scan the LAN QR code shown at the top of the Snow settings page.

When you need cellular or off-site access, the user buys only two things, and **any vendor works**:

1. A paid, always-on "lightweight application server" or ordinary VPS: for FRP, Ubuntu 22.04/24.04, Debian 11+, CentOS Stream/RHEL/Rocky/AlmaLinux 8+; for SSH2, Ubuntu 22+, Debian 11+, Fedora 44+, CentOS Stream/RHEL/Rocky/AlmaLinux 9+; x86_64/amd64 only, with at least 1 vCPU, 1 GB RAM and 20 GB disk, and explicitly a dedicated public IPv4. Buy a monthly or yearly instance; do not buy preemptible, spot, Windows, database, GPU, pre-installed-panel, custom Alpine image, or second-device-keepalive plans.
2. A paid domain that the user owns long term: any registrar and any suffix, with common suffixes such as `.com` recommended. You do not need an SSL certificate, a CDN, a premium DNS plan, an enterprise mailbox, or a website package.

Once the purchases are done, only two vendor-specific steps stay manual in the cloud console (the records and ports depend on the selected tunnel mode):

1. Add A records, all pointing to the server public IPv4:
   - the default FRP mode needs two: `snow` and `frp`;
   - the SSH2 mode needs only `snow`, with no `frp` record;
2. In the security group or cloud firewall, allow TCP `22`, `80`, `443` and the tunnel port of the selected mode (FRP default `7000`, SSH2 default `7001`, editable in the Snow deployment form); do not expose the loopback tunnel port (default `18080`, also configurable).

Then open Snow "Settings -> Mobile remote control -> First-time setup", select FRP (default) or SSH2 under "Tunnel mode", fill in the public IP, the root domain, the SSH login method and the matching ports (FRP defaults `7000`/`18080`, SSH2 defaults `7001`/`18080`), then click "Check DNS" and "Deploy and connect". The built-in Snow deployer reads the script from a fixed location in the installation package, installs FRP/Caddy over SSH, generates the credentials, imports the configuration in memory, and runs the security checks. This path calls no chat AI, does not scan the disk, and consumes no model tokens. The user never needs to understand or fill in parameters such as FRP, Caddy, token, CA, PEM or TLS names.

Passwords and key passphrases are used only for this SSH connection and are never written into the remote-control configuration. Never paste the FRP token, the CA private key, or the contents of `snow-remote-client.json` into a chat. `AI_DEPLOYMENT_PROMPT_EN.md` is kept only for older versions and advanced operations scenarios; it is not the recommended path for ordinary users.

After deployment, turn off Wi-Fi on the phone and run the real public-network acceptance over the cellular network. Technical users can continue with the manual instructions below; ordinary users can stop here.

## Pinned versions and ports

- frp `0.71.0`, Caddy `2.11.3`; the download assets and their SHA-256 values are in `versions.json`.
- Desktop installers bundle frpc per `resources/remote-control/frp/<platform>-<arch>`: Windows x64, macOS arm64/x64, Linux x64. Adding a platform or architecture requires the binary, `manifest.json`, and the matching `extraResources` entry in `package.json`.
- The VPS firewall must allow only TCP `80`, `443` and the FRP control port (default `7000`, changeable with `--frp-bind-port`). The tunnel port (default `18080`, changeable with `--frp-remote-port`) must stay unreachable from the internet.
- Caddy reads tunnel traffic from `127.0.0.1:<tunnel port>` (default `18080`); the frps `proxyBindAddr` is also pinned to `127.0.0.1`.
- `install-linux.sh` prints bilingual messages: English by default, and Chinese with `--lang zh-CN`, `SNOW_LANG=zh-CN`, or a UTF-8 Chinese `LC_ALL`/`LC_MESSAGES`/`LANG`; a non-UTF-8 Chinese locale falls back to English. Option names, exit codes, and the configuration bundle path do not depend on the language.
- The optional SSH2 mode does not use frps/frpc: the tunnel is established by the `ssh2` library inside the Snow main process, the server side is served by the dedicated restricted `snow-tunnel-sshd` (default port `7001`), and Caddy still reads the loopback port; `install-ssh2.sh` also prints bilingual messages with `--lang zh-CN`/`SNOW_LANG`.
- The template does not enable the frps/frpc web admin panel.

## SSH2 mode (optional)

SSH2 is an optional tunnel mode: the Snow main process uses the built-in `ssh2` library to establish an SSH reverse TCP forward directly (an in-process implementation that starts no frpc child process). Installers still bundle frpc for the FRP mode, and the two modes are alternative active paths; FRP behavior is unchanged.

Usage flow ("Settings -> Mobile remote control -> First-time setup"):

1. DNS needs only one `snow` A record pointing to the server public IPv4; no second `frp` record.
2. Server support: Ubuntu 22+, Debian 11+, Fedora 44+, CentOS Stream/RHEL/Rocky/AlmaLinux 9+, x86_64/amd64 only, with root or passwordless sudo and systemd.
3. In the security group, allow TCP `80`, `443` and the SSH2 tunnel port (default `7001`, editable in the "SSH2 tunnel port" field of the wizard); the loopback forward port (default `18080`) must never be exposed to the internet.
4. Select SSH2 under "Tunnel mode", enter the server public IP, the root domain and the administrator SSH login method, then click "Check DNS" and "Deploy and connect". Snow then: generates a dedicated ed25519 key pair locally (only the public key is uploaded); installs the dedicated restricted sshd (`snow-tunnel-sshd.service`, account `snow-tunnel`; the system sshd is never modified); verifies the tunnel forward and that the loopback port is not exposed; switches the Caddy upstream; and finally saves the configuration encrypted with the system secure storage (safeStorage).
5. Port conflicts: if an existing FRP setup already occupies loopback port `18080`, the wizard defaults to suggesting `18081`; the two tunnels cannot share the same loopback port. Switching the active tunnel mode requires running the deployment again and selecting the target mode (the FRP services and credentials are kept).
6. Automatic rollback: the deployment first verifies the candidate tunnel (a `/health` request through the server loopback port, expecting the unpaired `401`) and only then switches the Caddy upstream; if any step fails it best-effort restores the previous Caddy upstream, the previous device key authorization and the local tunnel configuration, so the previous FRP setup stays usable; when a rollback itself fails, the tool keeps the current state and points to manual recovery.
7. Private key and bundles: the dedicated private key is stored in OpenSSH format inside the safeStorage-encrypted configuration and is never exported; after importing an SSH2 bundle without the key, use "Deploy and connect" to re-authorize this device (the panel shows a missing-key notice).
8. Keys and trust: the desktop strictly verifies the server host key fingerprint (pinned from the trusted management connection during deployment); a changed fingerprint stops the connection and asks for manual verification instead of auto-accepting. Phone access still uses the existing public token; the SSH key can never replace it. Rotate the public token when the phone is lost or a link leaks; when the tunnel key is suspected to have leaked, redeploy to replace the authorized public key on the server.
9. Troubleshooting:
   - `systemctl status snow-tunnel-sshd.service` and `journalctl -u snow-tunnel-sshd`: tunnel service state and logs;
   - `sshd -T -f /etc/snow-remote/sshd_config`: the effective configuration should show `maxsessions 0`, `permitlisten 127.0.0.1:<loopback port>` and `allowtcpforwarding remote`;
   - server files: `/etc/snow-remote/sshd_config` and `/etc/snow-remote/ssh/` (dedicated host key and `authorized_keys`);
   - the deployer's temporary script and metadata (`/tmp/snow-ssh2-*`, `/root/snow-remote-ssh2.json`) are cleaned up automatically after deployment.
10. Boundaries: the SSH2 mode makes no "no antivirus flag" promise (the installer still bundles frpc), but at runtime no external frpc child process is started; the tunnel is an outbound SSH connection initiated by the desktop, so the desktop network must allow that outbound direction and the server security group must allow the tunnel port inbound; Caddy still terminates HTTPS on the VPS, so this remains segmented encryption, not end-to-end encryption.

### Advanced manual install (optional)

Technical users can also run `install-ssh2.sh` from this directory on the server (this is what the deployer executes; ordinary users do not need it):

```bash
sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 \
  --remote-port 18080 --pubkey-file /tmp/snow.pub
```

- `--switch-upstream <port>`: only switches the Caddy loopback upstream to `127.0.0.1:<port>` and exits;
- `--email you@example.com` (optional): sets the ACME contact email used by Caddy;
- `--lang zh-CN` (or `SNOW_LANG=zh-CN`): prints Chinese messages; English is the default;
- prepare a local public key file first (content shaped like `ssh-ed25519 AAAA...`).

## 1. Prepare DNS and software

> Sections 1-5 below are the manual deployment and troubleshooting instructions for the **FRP mode**; SSH2 users can skip them and read "SSH2 mode (optional)" above.

Prepare two DNS names, which may point to the same VPS:

- `snow.example.com`: the phone HTTPS entry point;
- `frp.example.com`: the tunnel server name verified by the desktop frpc.

Download the Linux amd64 archives pinned in `versions.json` from the official releases of both projects, check them against the manifest with `sha256sum` first, and then install `caddy` and `frps`. Do not use unpinned `latest` packages.

## 2. Create FRP identity material

The commands below must run in a restricted administrative terminal on the VPS; replace the example domain. Keep the CA private key only in a trusted offline location and never copy it into the desktop Snow app.

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

Install `frp-server.crt` and `frp-server.key` into `/etc/frp/tls/` with mode `0640 root:snow-frp`. The desktop side only needs:

- the `frp-ca.crt` public certificate;
- the dedicated FRP token in `/etc/frp/snow_remote.token`.

The FRP token serves a different purpose than the Snow phone pairing code and must not be reused. On both the VPS and the desktop, the token file must be readable only by the runtime user.

## 3. Install the VPS configuration

1. Create the non-login `snow-frp` system user.
2. Copy `frps.toml.example` to `/etc/frp/frps.toml`.
3. Copy `systemd/snow-frps.service` to `/etc/systemd/system/`.
4. Copy `Caddyfile.example` to `/etc/caddy/Caddyfile`, and set `SNOW_REMOTE_DOMAIN=snow.example.com` plus the ACME contact email for the Caddy service.
5. Validate the configuration before starting:

```bash
/usr/local/bin/frps verify -c /etc/frp/frps.toml
/usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now snow-frps caddy
```

Confirm that `18080` in `ss -lntp` is bound to `127.0.0.1` only, and verify from another machine that `VPS_IP:18080` is unreachable.

## 4. Connect the desktop Snow app

The Windows, macOS and Linux installers all bundle a SHA-256-verified `frpc` of the pinned version for the matching platform (`frpc.exe` on Windows), so nothing has to be downloaded or started manually. Open Snow "Settings -> Mobile remote control", expand the "First-time setup" wizard and fill in:

1. FRP server address: for example `frp.example.com`, with no protocol or path;
2. FRP port: must match `bindPort` on the VPS, `7000` in this template;
3. Phone HTTPS address: for example `https://snow.example.com`, and it must be a root address without path, query, or credentials;
4. FRP TLS server name: must match the SAN of `frp-server.crt`;
5. FRP credential: the content of `/etc/frp/snow_remote.token`;
6. FRP CA certificate: paste the complete PEM public certificate `frp-ca.crt`.

After enabling public WAN remote control, click "Save and connect". Snow encrypts the token and the CA with the system secure storage, generates the runtime configuration in a temporary directory readable only by the current user, verifies the bundled frpc and then starts it; on disconnect or exit it terminates the child process and removes the temporary plaintext files. When secure storage is unavailable, plaintext persistence is refused.

Confirm in order that "Local WAN", "FRP tunnel" and "HTTPS probe" on the settings page are all healthy, then scan the public QR code. The QR code and address carry the public token; the browser exchanges it for a `Secure; HttpOnly; SameSite=Strict` session cookie. Never put the FRP token into the domain, the QR code, or proxy logs.

`frpc.toml.example` is kept for server administrators who need to troubleshoot independently and verify protocol compatibility; everyday use needs no external frpc. Clicking "Disconnect this connection only" keeps the encrypted configuration for a later reconnect; if the phone is lost or the link leaks, regenerate and confirm a new public token in the settings above so that old cookies and pending attachments are invalidated immediately.

## 5. Acceptance and troubleshooting

Check layer by layer instead of mistaking "the process exists" for "public access works":

1. The WAN listener in the Snow settings is running;
2. frpc logs show a successful login and the `snow-remote-control` proxy starting;
3. When the VPS requests `127.0.0.1:18080/health` with the public domain as the Host, it returns the unpaired `401` (Caddy treats that status as "tunnel reachable");
4. `https://snow.example.com/` returns the pairing page;
5. A phone on the cellular network can pair, view status, send, stop, and upload;
6. After the pairing credential is rotated, old cookies immediately return `401`;
7. After frpc stops, the public entry point becomes unavailable while the LAN entry point keeps working.

Acceptance and troubleshooting for the SSH2 mode are in "SSH2 mode (optional)" above: confirm the SSH2 tunnel is authenticated, the loopback `/health` returns the unpaired `401`, and the public domain serves the pairing page; the usual commands are `systemctl status snow-tunnel-sshd.service` and `journalctl -u snow-tunnel-sshd`.

Certificate errors or a wrong FRP token must be treated as configuration failures; do not disable verification or retry indefinitely. Caddy requests and renews the site certificate automatically, but DNS, the reachability of ports 80/443, and the renewal logs still have to be monitored by the VPS administrator.

Some antivirus tools misflag the bundled frpc as risky and block, delete, or quarantine it; this false positive is a long-standing issue upstream in frp. When Snow detects that the component is missing, modified, or unable to start, the settings page shows a trust-zone guide with the exact directory to whitelist; follow it, reinstall Snow if the component was deleted, and click "Connect public access" again.

That guide applies to the FRP mode only: the SSH2 mode starts no frpc child process, but the installer still bundles the same frpc component, so antivirus scans may still flag it and Snow makes no "no false positive" promise.

## Upgrade and rollback

Before upgrading, review the official security advisories and changelogs of frp/Caddy, update the version, asset names and SHA-256 values in `versions.json`, and run `frps verify`, `frpc verify` and `caddy validate` separately. Back up the old binaries first; if the full proxy chain fails acceptance on the new version, restore the old binaries and restart the corresponding services. Configuration files and the token do not need to be rotated for an ordinary binary rollback; if a leak is suspected, rotate the FRP token separately, revoke the Snow public pairing, and re-issue the related certificates.
