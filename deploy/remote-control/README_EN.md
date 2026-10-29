# Snow App self-hosted public remote control template

> Chinese version: [README.md](README.md)

This template forwards phone HTTPS requests to the dedicated WAN listener of the desktop Snow app. The public entry uses only an SSH2 reverse tunnel (an in-process implementation that starts no external tunnel child process):

```text
phone -> HTTPS :443 -> Caddy -> 127.0.0.1:<loopback port, default 18080>
      -> SSH2 reverse tunnel (outbound SSH initiated by the desktop; served by a dedicated restricted sshd)
      -> desktop WAN listener
```

The VPS only forwards traffic: it runs no agent, stores no Snow session, and holds no phone pairing credential. The VPS can see traffic after TLS termination (Caddy terminates HTTPS on the VPS), so this is segmented encryption, not end-to-end encryption between the phone and the desktop. Use only a VPS you trust and manage.

## Start here if you are new

If the phone and the computer are always on the same Wi-Fi, you do not need a server at all; just scan the LAN QR code on the Snow settings page.

To access over cellular data or from another location, buy only two things, from **any vendor**:

1. A paid, always-on "lightweight application server" or ordinary VPS: Ubuntu 22+, Debian 11+, Fedora 44+, CentOS Stream/RHEL/Rocky/AlmaLinux 9+, x86_64/amd64 only, at least 1 vCPU, 1 GB RAM and 20 GB disk, with a dedicated public IPv4. Buy a monthly or yearly instance; do not buy preemptible, spot, Windows, database, GPU, pre-installed-panel, custom Alpine image, or second-device-keepalive plans.
2. A paid domain you keep long-term: any registrar and suffix; common suffixes such as `.com` are recommended. You do not need an SSL certificate, CDN, premium DNS, business email, or website builder.

After purchasing, complete two vendor-specific steps in the cloud console:

1. Add one A record: `snow` pointing to the server public IPv4.
2. In the security group or cloud firewall, allow TCP `22`, `80`, `443`, and the SSH2 tunnel port (default `7001`, editable in the Snow deployment form); do not expose the loopback tunnel port (default `18080`, also configurable).

Then open Snow "Settings -> Mobile remote control -> First-time setup", fill in the public IP, root domain, SSH login method and tunnel port, then click "Check DNS" and "Deploy and connect". The built-in Snow deployer reads the script from a fixed location in the installation package, installs the restricted sshd and Caddy over SSH, generates the dedicated key, imports the configuration in memory, and runs the security checks. This path calls no chat AI, does not scan the disk, and consumes no model tokens. The user never needs to understand or fill in parameters such as Caddy, PEM, or TLS names.

Passwords and key passphrases are used only for this SSH connection and are never written into the remote-control configuration. `AI_DEPLOYMENT_PROMPT.md` and `AI_DEPLOYMENT_PROMPT_EN.md` are kept only for advanced operations scenarios; they are not the recommended path for ordinary users.

After deployment, turn off phone Wi-Fi and verify real public access over cellular data. Technical users can continue with the manual instructions below; ordinary users can stop here.

## Pinned versions and ports

- Caddy `2.11.3`; the download asset, file name and SHA-256 are in `versions.json`. `install-ssh2.sh` pins the same version and checksum.
- The VPS firewall must allow only TCP `22`, `80`, `443`, and the SSH2 tunnel port (default `7001`). The tunnel loopback port (default `18080`) must stay unreachable from the internet.
- Caddy reads tunnel traffic from `127.0.0.1:<loopback port>` (default `18080`); the restricted sshd `PermitListen` is also pinned to `127.0.0.1`.
- `install-ssh2.sh` prints bilingual messages: English by default, Chinese with `--lang zh-CN`, `SNOW_LANG=zh-CN`, or a UTF-8 Chinese `LC_ALL`/`LC_MESSAGES`/`LANG`; non-UTF-8 Chinese locales fall back to English. Parameter names, exit codes, and configuration paths are language-independent.
- The template does not enable any tunnel web admin panel.

## Usage flow

1. DNS needs only one `snow` A record pointing to the server public IPv4.
2. Supported servers: Ubuntu 22+, Debian 11+, Fedora 44+, CentOS Stream/RHEL/Rocky/AlmaLinux 9+, x86_64/amd64 only, root or passwordless sudo, with systemd.
3. Allow TCP `80`, `443`, and the SSH2 tunnel port (default `7001`, editable in the "SSH2 tunnel port" field of the wizard) in the security group; never expose the loopback forwarding port (default `18080`) to the internet.
4. Fill in the server public IP, root domain, and administrator SSH login method, then click "Check DNS" and "Deploy and connect". Snow automatically: generates a dedicated ed25519 key on this device (uploads only the public key); installs the dedicated restricted sshd (`snow-tunnel-sshd.service`, dedicated `snow-tunnel` account, never modifies the system sshd); verifies tunnel forwarding and that the loopback port is not exposed; switches the Caddy upstream; and finally saves the configuration encrypted with the system secure storage (safeStorage).
5. Automatic rollback: the deployment first verifies the candidate tunnel (a `/health` request through the server loopback port, expecting the unpaired `401`) and only then switches the Caddy upstream; if any step fails it best-effort restores the previous Caddy upstream, the previous device key authorization and the local tunnel configuration; when a rollback itself fails, the tool keeps the current state and points to manual recovery.
6. Private key and bundles: the dedicated private key is stored in OpenSSH format inside the safeStorage-encrypted configuration and is never exported into a bundle; after importing a bundle without the private key, use "Deploy and connect" to authorize this device again (the panel reports the missing tunnel private key).
7. Keys and trust: the desktop strictly verifies the server host public key/fingerprint (fetched and pinned over the trusted management connection during deployment); a fingerprint change stops the connection and requires re-verification instead of silently accepting a new key. Phone access still uses the existing "public token"; the SSH key cannot replace the phone token. If the phone is lost or the link leaks, rotate the public token; if you suspect the tunnel key leaked, redeploy to replace the public key authorized on the server.
8. Troubleshooting:
   - `systemctl status snow-tunnel-sshd.service`, `journalctl -u snow-tunnel-sshd`: tunnel service status and logs;
   - `sshd -T -f /etc/snow-remote/sshd_config`: effective configuration, expected to show `maxsessions 0`, `permitlisten 127.0.0.1:<loopback port>`, `allowtcpforwarding remote`;
   - server files: `/etc/snow-remote/sshd_config`, `/etc/snow-remote/ssh/` (dedicated host key and `authorized_keys`);
   - the deployer's temporary script and metadata (`/tmp/snow-ssh2-*`, `/root/snow-remote-ssh2.json`) are cleaned up automatically after deployment.
9. Boundaries: the tunnel is an outbound SSH connection initiated by the desktop, so the desktop network must allow that outbound direction and the server security group must allow the tunnel port inbound; Caddy still terminates HTTPS on the VPS, so this remains segmented encryption, not end-to-end encryption.

### Manual installation (optional)

Technical users can also run `install-ssh2.sh` from this directory on the server (this is what the deployer executes; ordinary users do not need it):

```bash
sudo bash install-ssh2.sh --public-domain snow.example.com --tunnel-port 7001 \
  --remote-port 18080 --pubkey-file /tmp/snow.pub
```

- `--switch-upstream <port>`: only switch the Caddy loopback upstream to `127.0.0.1:<port>` and exit;
- `--email <addr>` (optional): set the ACME contact email for Caddy;
- `--lang zh-CN` (or `SNOW_LANG=zh-CN`): print Chinese messages; English is the default;
- prepare a local public key file first (content like `ssh-ed25519 AAAA...`).

## Acceptance and troubleshooting

Check layer by layer instead of mistaking "the process exists" for "public access works":

1. The WAN listener is running in Snow settings;
2. The "SSH2 tunnel" status in the settings page is authenticated and the host key fingerprint matches the server;
3. On the VPS, a `/health` request to `127.0.0.1:18080` with the public domain as Host returns the unpaired `401`;
4. `https://snow.example.com/` returns the pairing page;
5. A phone on cellular data can pair, view status, send, stop, and upload;
6. After rotating the public token, old cookies immediately return `401`;
7. After stopping the SSH2 tunnel, the public entry becomes unavailable while the LAN entry keeps working.

Host-key or authorization errors must be treated as configuration failures; do not disable verification or retry indefinitely. Caddy requests and renews the site certificate automatically, but DNS, the reachability of ports 80/443, and the renewal logs still have to be monitored by the VPS administrator.

## Upgrade and rollback

Before upgrading, review the official Caddy security advisories and changelogs, update the version, asset names, and SHA-256 values in `versions.json` and `install-ssh2.sh`, and run `caddy validate`. Back up the old binary first; if the full proxy chain fails acceptance on the new version, restore the old binary and restart the service. If a key leak is suspected, remove the public configuration in Snow and deploy again to replace the public key authorized on the server.
