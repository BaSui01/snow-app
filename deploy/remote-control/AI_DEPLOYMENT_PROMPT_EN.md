# Deployment instructions to hand to an AI

> Chinese version: [AI_DEPLOYMENT_PROMPT.md](AI_DEPLOYMENT_PROMPT.md)

## The user only has to buy two things

Any vendor works; never hard-code one cloud provider:

1. A paid, always-on "lightweight application server" or ordinary VPS: Ubuntu 22.04/24.04, Debian 11+, CentOS Stream/RHEL/Rocky/AlmaLinux 8+ and other common x86_64 systems, at least 1 vCPU, 1 GB RAM and 20 GB disk, and explicitly a dedicated public IPv4. Buy a monthly or yearly instance; do not buy preemptible, spot, Windows, database, GPU, pre-installed-panel, custom Alpine image, or second-device-keepalive plans.
2. A paid domain that the user owns long term: any registrar and any suffix, with common suffixes such as `.com` recommended. No separate SSL certificate, CDN, premium DNS plan, enterprise mailbox, or website package is needed.

Once the purchases are done, the user opens the server console and the domain console on the computer and sends the whole block below to an AI that can operate a browser and a terminal. The user does not need to look up or enter IPs, ports, DNS records, the FRP token, the CA, or certificates.

> Please complete the Snow App phone public WAN remote-control deployment for me directly.
>
> I have already bought a long-running public Linux server and a paid domain. The cloud vendor and the registrar are not fixed, so first look at the consoles I currently have open and identify the server vendor, region, public IPv4, SSH login method and the domain; do not assume I use Alibaba Cloud, and do not make me understand or hand-fill technical parameters such as FRP, Caddy, token, CA, PEM or TLS names.
>
> Please do the following work:
>
> 1. Confirm that the server is a supported x86_64 Linux (Ubuntu 22.04/24.04, Debian 11+, CentOS Stream/RHEL/Rocky/AlmaLinux 8+) with a dedicated public IPv4, and that it is not a preemptible or spot instance.
> 2. In the domain console, create the two A records `snow` and `frp`, both pointing to the server public IPv4.
> 3. In the cloud firewall or security group, allow TCP 22, 80, 443 and the FRP control port (default 7000; use the deployment form or `--frp-bind-port` to customize it), and do not expose the tunnel port to the internet (default 18080, changeable with `--frp-remote-port`).
> 4. Find the Snow installation directory `resources/remote-control/deploy` on this computer and deploy the server with `install-linux.sh`; generate and keep the FRP token, the CA and the certificates yourself, and do not make me fill them in by hand. The script prints English by default; add `--lang zh-CN` or set `SNOW_LANG=zh-CN` when you want Chinese output.
> 5. Check that frps, Caddy, HTTPS, the ports and the tunnel port (default 18080) listen on loopback only, and confirm that the public link works.
> 6. Download the installer-generated `/root/snow-remote-client.json` securely to this machine, import it in Snow and connect; delete the local plaintext bundle after a successful import.
> 7. Finally, remind me to turn off Wi-Fi on the phone and scan the public QR code over the cellular network for acceptance.
>
> Keep working until the deployment is complete. Pause only for payment, login, CAPTCHA, identity verification, or a server password that I must type myself. Do not ask me to paste the SSH password, private keys, the FRP token, the CA private key, or the bundle contents into the chat.

The AI should operate the console that matches the actual vendor and must not ask the user to copy professional parameters out of the page one by one. Only when the AI really cannot operate a browser or a terminal, use the manual fallback command below:

```bash
# Optional parameters: --frp-bind-port <FRP control port> --frp-remote-port <FRP tunnel port> --lang en|zh-CN
sudo bash install-linux.sh \
  --public-domain snow.example.com \
  --frp-domain frp.example.com \
  --email you@example.com
```

The script supports x86_64 Debian/Ubuntu and CentOS/RHEL/Rocky/AlmaLinux systems; it pins the frp/Caddy download hashes, generates a dedicated token and a private FRP CA, configures systemd, and writes a Snow configuration bundle readable only by root. The script never pays for or buys the server or the domain on the user's behalf.
