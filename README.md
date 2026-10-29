<p align="center">
  <img src="./assets/readme/en/hero.png" width="100%" alt="Snow App: a desktop AI development workspace with AI chat, terminal, SSH, Git and a built-in browser in one window">
</p>

<p align="center">
  <a href="https://github.com/xb0or/snow-app/releases"><img src="https://img.shields.io/github/v/release/xb0or/snow-app?label=release&color=3b82f6" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-73afd1" alt="Supported platforms">
  <img src="https://img.shields.io/badge/license-MIT-111827" alt="MIT license">
</p>

Snow App is a desktop workspace for developers: AI chat, an integrated terminal, SSH remote management, a Git panel and a built-in browser all live in one window, and the AI can drive them directly.

[中文文档](./README_zh.md)

## What it looks like

<p align="center">
  <img src="./assets/readme/screenshots/desktop-annotated.en.png" width="100%" alt="Snow App three-column layout: sidebar for sessions and projects, chat and agent in the middle, browser, terminal and Git in the right panel">
</p>

## From five windows back to one workspace

<p align="center">
  <img src="./assets/readme/en/before-after.svg" width="100%" alt="Before: a terminal app, an SSH client, a Git GUI, a browser and a web AI chat. After: one Snow App window">
</p>

## What is inside

<p align="center">
  <img src="./assets/readme/en/features-workspace.svg" width="100%" alt="Snow App workspace panels: AI chat, integrated terminal, SSH workspaces, Git panel, built-in browser, file explorer, codebase search, task manager">
</p>

These panels share one conversation context: the AI can read terminal output, browser pages and Git state directly, so nothing has to be copied between tools.

## Agent and team

<p align="center">
  <img src="./assets/readme/en/features-agent.svg" width="100%" alt="Snow App agent and team: skills, MCP servers, sub-agents, hooks, goal mode, scheduled tasks and workflows, project memory, team collaboration">
</p>

Skills, MCP servers, sub-agents and hooks are all pluggable; scheduled tasks support multi-node workflows, and project memory persists per project and is injected automatically.

## Extend and create

<p align="center">
  <img src="./assets/readme/en/features-extend.svg" width="100%" alt="Snow App extension and content: plugin market, user scripts, custom commands, request proxy, repo wiki, drawing studio, image library, LSP diagnostics">
</p>

Plugins, user scripts and the request proxy layer can rewrite the interface and the requests themselves; repo wiki, the drawing studio and the image library keep content work inside the same session.

## Security and experience

<p align="center">
  <img src="./assets/readme/en/features-security.svg" width="100%" alt="Snow App security and experience: app lock, tool approval, privacy masking, checkpoints and rollback, usage and logs, themes, mobile remote, desktop pets">
</p>

Tool approval and privacy masking decide what the AI may do and see. App lock is off by default, covers the interface without encrypting disk data, and stores only a salted PIN hash.

## Continue on mobile

<p align="center">
  <img src="./assets/readme/screenshots/mobile-pair.png" width="640" alt="Snow App mobile remote control: conversation and streaming on the left, actions, modes and approvals on the right">
</p>

Pair a phone from **Settings → Mobile Remote Control** and keep working from a mobile browser: switch workspaces and models, approve tools, answer questions, and send images or files. LAN pairing needs no cloud service; the optional public mode uses a self-hosted, authenticated TLS tunnel with one-time pairing, session revocation and sensitive-output redaction. See the [setup guide](docs/en/2-guides/23-mobile-public-remote-control.md).

## Requirements and first run

- **Node.js** >= 18
- **Rust** stable toolchain (builds the native module)
- **macOS**: Xcode Command Line Tools ｜ **Windows**: Visual Studio Build Tools (C++ workload) ｜ **Linux**: `build-essential`, `pkg-config`

```bash
npm install
npm run dev        # start in development mode with HMR
npm run build:app  # build a distributable package into release/
```

> **macOS users:** if the app reports "damaged" or "cannot be opened" after installation, run:
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/Snow\ App.app
> ```

## More

- Full documentation: [docs/](./docs/README.md)
- QQ group: 910298558
- Friendly link: [Linux DO](https://linux.do)
- License: [MIT](./LICENSE) · Copyright (c) 2026 MayMay
