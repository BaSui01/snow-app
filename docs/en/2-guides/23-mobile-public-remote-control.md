# Deploy mobile public remote control

> Applies to Snow desktop on Windows, macOS, and Linux. Snow's built-in deployer performs the installation without invoking the chat AI or requiring the user to understand Caddy, PEM files, or TLS names. The public entry uses only an SSH2 reverse tunnel.

## Goal

After deployment, a phone with Wi-Fi disabled can open Snow at `https://snow.<your-domain>` and pair by scanning the public QR code in Settings.

## What to prepare

1. A persistent Linux server from any provider: Ubuntu 22+, Debian 11+, Fedora 44+, or CentOS Stream/RHEL/Rocky/AlmaLinux 9+; x86_64/amd64 only, with a dedicated public IPv4 address. At least 1 vCPU and 1 GB RAM is recommended. Do not use a spot or preemptible instance.
2. A domain you control, from any registrar and with any suffix. You do not need to buy an SSL certificate, CDN, website builder, or business email product.
3. SSH access using either a `root` password or a private key. A non-root account is supported only when it has passwordless `sudo`.

If the phone and computer always use the same Wi-Fi network, scan the LAN QR code instead; no server or domain is required.

## The tunnel mode is SSH2

Snow uses an in-process SSH2 reverse tunnel in “Settings → Mobile remote control → First-time setup”: it starts no external tunnel child process, needs only one DNS A record (`snow`), listens on SSH2 tunnel port `7001` by default (allow it in the security group), and uses loopback port `18080` by default.

- The desktop initiates the outbound SSH connection; the server side is served by the dedicated restricted `snow-tunnel-sshd`, which never modifies the system sshd.
- The dedicated tunnel private key is stored in the local system secure storage and is never exported in a configuration bundle; after importing a bundle without the key, use “Deploy and connect automatically” to re-authorize this device.
- Full instructions (DNS records, security-group ports, troubleshooting commands and the manual installer) are in the [self-hosted public remote-control template](../../../deploy/remote-control/README_EN.md).

## The only two manual cloud-console tasks

Snow cannot provide one universal integration for every cloud control panel. Complete these two tasks first:

1. Create one DNS A record pointing to the server's public IPv4 address:
   - host `snow`
2. Allow inbound TCP `22`, `80`, `443`, and `7001` (the default SSH2 tunnel port, configurable in the deploy form) in the cloud security group or firewall. Do not expose `18080` (the default loopback port, configurable in the deploy form).

DNS propagation may take a few minutes. The “Check DNS” button reports whether the record is correct.

## Let Snow deploy everything else

1. Open “Settings → Mobile remote control → Self-hosted public connection”.
2. Enter the server public IPv4 address, root domain such as `example.com`, SSH username and port, plus the SSH2 tunnel port (default `7001`) and loopback port (default `18080`).
3. Select password or private-key authentication. Passwords and key passphrases remain in memory only for this deployment and are not stored in the remote-control configuration.
4. Select “Check DNS”. When the record is ready, select “Deploy and connect automatically”.
5. Wait while Snow checks the OS, uploads its bundled installer, installs the restricted sshd and Caddy, generates the dedicated key, imports the configuration, and verifies public HTTPS.

Snow reads the installer from a fixed packaged resource path, so the chat AI never searches the disk. The generated tunnel metadata is imported in memory and is never written as a plaintext local file. Snow also removes the temporary server-side metadata after import.

## Verify

On success, Local WAN, SSH2 tunnel, and the HTTPS probe are all healthy and a public QR code is available. Disable phone Wi-Fi, scan it over cellular data, and test viewing a conversation, sending a message, stopping a task, and uploading an attachment.

Only `22`, `80`, `443`, and the SSH2 tunnel port (default `7001`) should be public. The loopback tunnel port (default `18080`) must listen only on `127.0.0.1`; Snow verifies this at the end of deployment.

## Troubleshooting and recovery

- “DNS is not ready”: confirm the `snow` A record points to the public IPv4 entered in Snow, then wait a few minutes and retry.
- A persistent `198.18.x.x` result while a proxy is active is commonly a VPN/TUN fake IP. Snow verifies it through public DNS over HTTPS, so a correct A record does not need to be changed and the proxy does not need to be disabled.
- Unsupported server OS: use Ubuntu 22+, Debian 11+, Fedora 44+, or CentOS Stream/RHEL/Rocky/AlmaLinux 9+, x86_64/amd64 only.
- SSH connection failure: verify the public IP, port, username, and password or key. Never paste a password or private key into chat.
- Installation succeeds but the endpoint is unreachable: allow TCP `80`, `443`, and the SSH2 tunnel port (default `7001`), and check for an additional host firewall.
- Interrupted deployment: run it again. Snow removes the temporary script and does not leave an unverified configuration reconnecting automatically.
- Redeploying the same server: the restricted sshd, Caddy, and the server host key are reused; each redeployment generates a new local key and replaces the public key authorized on the server. The configuration is rewritten and only the affected service restarts when a port or version changed.
- Redeploying with a different root domain: the Caddy configuration is rewritten for the new domain and a new certificate is obtained; the restricted sshd, server host key, and the authorized public key are unaffected.
- Lost phone or leaked link: regenerate and confirm a new public token. If you suspect the tunnel key leaked, redeploy to replace the public key authorized on the server.

## Implementation anchors

- `src/renderer/components/sidebar/RemoteControlSettingsPanel.tsx`
- `src/main/remoteControl/remoteServerDeployer.ts::deployRemoteServer`
- `src/main/remoteControl/remoteServerDeploymentSchema.ts::normalizeRemoteServerDeployInput`
- `src/main/remoteControl/remoteTunnelManager.ts`
- `deploy/remote-control/install-ssh2.sh`
