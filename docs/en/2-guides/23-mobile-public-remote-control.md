# Deploy mobile public remote control

> Applies to Snow desktop on Windows, macOS, and Linux. Snow's built-in deployer performs the installation without invoking the chat AI or requiring the user to understand FRP, Caddy, tokens, CA/PEM files, or TLS names.

## Goal

After deployment, a phone with Wi-Fi disabled can open Snow at `https://snow.<your-domain>` and pair by scanning the public QR code in Settings.

## What to prepare

1. A persistent Linux server from any provider: Ubuntu 22.04/24.04, Debian 11+, or CentOS Stream/RHEL/Rocky/AlmaLinux 8+, x86_64, and a dedicated public IPv4 address. At least 1 vCPU and 1 GB RAM is recommended. Do not use a spot or preemptible instance.
2. A domain you control, from any registrar and with any suffix. You do not need to buy an SSL certificate, CDN, website builder, or business email product.
3. SSH access using either a `root` password or a private key. A non-root account is supported only when it has passwordless `sudo`.

If the phone and computer always use the same Wi-Fi network, scan the LAN QR code instead; no server or domain is required.

## The only two manual cloud-console tasks

Snow cannot provide one universal integration for every cloud control panel. Complete these two tasks first:

1. Create two DNS A records. Point both to the server's public IPv4 address:
   - host `snow`
   - host `frp`
2. Allow inbound TCP `22`, `80`, `443`, and the FRP control port (default `7000`, configurable in the deploy form) in the cloud security group or firewall. Do not expose the tunnel port (default `18080`, configurable in the deploy form).

DNS propagation may take a few minutes. The “Check DNS” button reports whether both records are correct.

## Let Snow deploy everything else

1. Open “Settings → Mobile remote control → Self-hosted public connection”.
2. Enter the server public IPv4 address, root domain such as `example.com`, SSH username and port, plus the FRP control and tunnel ports (defaults `7000` and `18080`).
3. Select password or private-key authentication. Passwords and key passphrases remain in memory only for this deployment and are not stored in the remote-control configuration.
4. Select “Check DNS”. When both records are ready, select “Deploy and connect automatically”.
5. Wait while Snow checks the OS, uploads its bundled installer, installs FRP and Caddy, generates independent credentials, imports the configuration, and verifies public HTTPS.

Snow reads the installer from a fixed packaged resource path, so the chat AI never searches the disk. The generated client configuration is imported in memory and is never written as a plaintext local file. Snow also removes the temporary server-side bundle after import.

## Verify

On success, Local WAN, FRP tunnel, and HTTPS probe are all healthy and a public QR code is available. Disable phone Wi-Fi, scan it over cellular data, and test viewing a conversation, sending a message, stopping a task, and uploading an attachment.

Only `22`, `80`, `443`, and the FRP control port (default `7000`) should be public. The tunnel port (default `18080`) must listen only on `127.0.0.1`; Snow verifies this at the end of deployment.

## Troubleshooting and recovery

- “DNS is not ready”: confirm both `snow` and `frp` A records point to the public IPv4 entered in Snow, then wait a few minutes and retry.
- A persistent `198.18.x.x` result while a proxy is active is commonly a VPN/TUN fake IP. Snow verifies it through public DNS over HTTPS, so a correct A record does not need to be changed and the proxy does not need to be disabled.
- Unsupported server OS: use Ubuntu 22.04/24.04, Debian 11+, or CentOS Stream/RHEL/Rocky/AlmaLinux 8+ on x86_64.
- SSH connection failure: verify the public IP, port, username, and password or key. Never paste a password or private key into chat.
- Installation succeeds but the endpoint is unreachable: allow TCP `80`, `443`, and the FRP control port (default `7000`), and check for an additional host firewall.
- Interrupted deployment: run it again. Snow removes the temporary script and does not leave an unverified configuration reconnecting automatically.
- Redeploying the same server: Snow reuses the installed frps/Caddy binaries, the FRP token, CA, and server certificate, so no binary is downloaded again and credentials are not rotated; the configuration is rewritten and only the affected service restarts when a port or version changed.
- Redeploying with a different root domain: the existing FRP server certificate no longer matches the new `frp` domain, so Snow stops instead of rotating the CA unexpectedly. Delete `/etc/frp/tls` on the server once the old certificate is no longer needed, then deploy again.
- Advanced users may import an existing server bundle from the advanced section. Beginners do not need that entry.

## Implementation anchors

- `src/renderer/components/sidebar/RemoteControlSettingsPanel.tsx`
- `src/main/remoteControl/remoteServerDeployer.ts::deployRemoteServer`
- `src/main/remoteControl/remoteServerDeploymentSchema.ts::normalizeRemoteServerDeployInput`
- `deploy/remote-control/install-linux.sh`
