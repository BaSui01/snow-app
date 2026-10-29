#!/usr/bin/env python3
"""Generate the Snow App README feature boards and the before/after board.

Capability wording is derived from the project's own sources: the capability
matrix in docs/FEATURE_COVERAGE.md, the 25 settings pages in
src/renderer/components/sidebar/settingsItems.ts, the panel/component tree under
src/renderer/components, and the UI strings in src/renderer/i18n/lang/zh-CN.ts.

Usage: python build_features.py [zh|en]
"""

import sys

from theme import (
    ASSETS, BRAND, BRAND_DEEP, FAINT, INK, LINE, MONO, MUTED, PAPER, SANS,
    SURFACE, SURFACE_2, icon, esc, svg_open, write_svg,
)

TEXTS = {
    "zh": {
        "label_face": "sans",
        "boards": [
            {
                "key": "workspace",
                "label": "工作区面板 · WORKSPACE PANELS",
                "title": "Snow App 工作区面板",
                "desc": "八个工作区面板：AI 对话、集成终端、SSH、Git、内置浏览器、文件浏览、代码库检索与任务管理器。",
                "items": [
                    ("message-square-text", "AI 对话", ["流式输出与代码渲染", "Markdown / Mermaid"]),
                    ("square-terminal", "集成终端", ["本地与 SSH 持久 PTY", "AI 可在其中执行命令"]),
                    ("server", "SSH 远程工作区", ["远程文件与命令", "上传下载与凭据管理"]),
                    ("git-branch", "Git 面板", ["提交图与差异查看", "暂存、提交与同步"]),
                    ("globe", "内置浏览器", ["多标签与自动化", "代理、登录态与 DevTools"]),
                    ("folder-tree", "文件浏览与预览", ["本地与 SSH 项目树", "代码、表格与文档预览"]),
                    ("file-search", "代码库语义检索", ["向量索引与语义搜索", "符号定位与球面图"]),
                    ("activity", "任务管理器", ["进程与性能趋势", "LSP 服务与监控告警"]),
                ],
            },
            {
                "key": "agent",
                "label": "Agent 与协作 · AGENT AND TEAM",
                "title": "Snow App Agent 与协作能力",
                "desc": "八项 Agent 与协作能力：Skills、MCP、子代理、Hooks、Goal 模式、定时任务与工作流、项目记忆、团队协作。",
                "items": [
                    ("sparkles", "Skills 技能", ["安装 SKILL.md", "按需启用扩展能力"]),
                    ("blocks", "MCP 服务器", ["接入外部 MCP 工具", "内置工具域可开关"]),
                    ("bot", "子代理", ["独立执行循环", "同步或异步并行"]),
                    ("zap", "Hooks 生命周期", ["请求前后执行命令", "或注入自定义提示词"]),
                    ("target", "Goal 模式", ["自主执行长任务", "持续跟进目标"]),
                    ("calendar-clock", "定时任务与工作流", ["单次与周期任务", "多节点工作流编排"]),
                    ("brain", "项目记忆", ["持久记忆自动注入", "跨会话复用项目知识"]),
                    ("users", "团队协作", ["任务、评审与知识", "成员动态一屏掌握"]),
                ],
            },
            {
                "key": "extend",
                "label": "扩展与内容 · EXTEND",
                "title": "Snow App 扩展与内容能力",
                "desc": "八项扩展与内容能力：插件与市场、用户脚本、自定义命令、请求代理层、仓库 Wiki、绘图工作台、图像库、LSP 诊断。",
                "items": [
                    ("package", "插件与市场", ["面板插件与脚本", "官方市场与社区源"]),
                    ("code", "用户脚本", ["油猴脚本与客户端", "脚本注入与 GM API"]),
                    ("slash-square", "自定义命令", ["斜杠命令自定义", "项目级命令覆盖"]),
                    ("route", "请求代理层", ["脚本改写请求体", "处理 SSE 响应事件"]),
                    ("book-open-text", "仓库 Wiki", ["为仓库生成 Wiki", "按项目与语言配置"]),
                    ("paintbrush", "绘图工作台", ["文生图与图生图", "画布编辑与参考图"]),
                    ("images", "图像库", ["相册、搜索与批量", "导入、下载与迁移"]),
                    ("braces", "LSP 代码诊断", ["多语言符号定位", "诊断与语言服务器"]),
                ],
            },
            {
                "key": "security",
                "label": "安全与体验 · SECURITY AND UX",
                "title": "Snow App 安全与体验",
                "desc": "八项安全与体验能力：应用锁、工具授权、隐私脱敏、检查点与回滚、用量与日志、主题与个性化、手机远控、桌面宠物。",
                "items": [
                    ("lock", "应用锁", ["PIN 与谷歌验证器", "失焦自动锁定"]),
                    ("shield-check", "工具授权", ["工具白名单开关", "敏感命令需确认"]),
                    ("eye-off", "隐私脱敏", ["输出规则掩码", "支持自定义正则"]),
                    ("history", "检查点与回滚", ["文件检查点与差异", "会话回滚到任意点"]),
                    ("chart-column", "用量与日志", ["Token 用量统计", "系统日志排错"]),
                    ("palette", "主题与个性化", ["模式、配色与背景", "字体、光标与快捷键"]),
                    ("smartphone", "手机远控", ["局域网扫码连接", "自建隧道公网访问"]),
                    ("paw-print", "桌面宠物", ["安装宠物资源包", "响应 AI 工作状态"]),
                ],
            },
        ],
        "ba_title": "从五个窗口回到一个工作区",
        "ba_before": "BEFORE · 分散的工具",
        "ba_after": "AFTER · 单个窗口",
        "ba_before_items": [
            ("square-terminal", "终端应用"),
            ("server", "SSH 客户端"),
            ("git-branch", "Git GUI"),
            ("globe", "浏览器"),
            ("message-square-text", "网页版 AI 对话"),
        ],
        "ba_lanes": ["对话与 Agent", "终端 · Git · SSH", "浏览器"],
    },
    "en": {
        "label_face": "mono",
        "boards": [
            {
                "key": "workspace",
                "label": "WORKSPACE PANELS",
                "title": "Snow App workspace panels",
                "desc": "Eight workspace panels: AI chat, integrated terminal, SSH, Git, built-in browser, file explorer, codebase search and task manager.",
                "items": [
                    ("message-square-text", "AI Chat", ["Streaming replies", "Markdown and Mermaid"]),
                    ("square-terminal", "Integrated Terminal", ["Local and SSH PTY", "AI can run commands"]),
                    ("server", "SSH Workspaces", ["Remote files, shell", "uploads and downloads"]),
                    ("git-branch", "Git Panel", ["Commit graph, diffs", "stage and sync"]),
                    ("globe", "Built-in Browser", ["Tabs and automation", "proxy and login state"]),
                    ("folder-tree", "File Explorer", ["Local and SSH trees", "code and doc preview"]),
                    ("file-search", "Codebase Search", ["Vector index search", "symbols, sphere view"]),
                    ("activity", "Task Manager", ["Processes and trends", "LSP services, alerts"]),
                ],
            },
            {
                "key": "agent",
                "label": "AGENT AND TEAM",
                "title": "Snow App agent and team capabilities",
                "desc": "Eight agent and team capabilities: skills, MCP, sub-agents, hooks, goal mode, scheduled tasks and workflows, project memory, team collaboration.",
                "items": [
                    ("sparkles", "Skills", ["Install SKILL.md", "extend the agent"]),
                    ("blocks", "MCP Servers", ["External MCP tools", "toggle built-in sets"]),
                    ("bot", "Sub-Agents", ["Independent loops", "sync or async"]),
                    ("zap", "Hooks", ["Run commands before", "and after key events"]),
                    ("target", "Goal Mode", ["Autonomous tasks", "with goal tracking"]),
                    ("calendar-clock", "Scheduled Tasks", ["One-off or recurring", "multi-node workflows"]),
                    ("brain", "Project Memory", ["Persistent memory", "reused per project"]),
                    ("users", "Collaboration", ["Tasks, reviews,", "notes and activity"]),
                ],
            },
            {
                "key": "extend",
                "label": "EXTEND",
                "title": "Snow App extension and content capabilities",
                "desc": "Eight extension and content capabilities: plugins and market, user scripts, custom commands, request proxy, repo wiki, drawing studio, image library, LSP diagnostics.",
                "items": [
                    ("package", "Plugin Market", ["Panel plugins and", "official market"]),
                    ("code", "User Scripts", ["Userscripts for the", "browser and client"]),
                    ("slash-square", "Custom Commands", ["Your own slash", "commands per project"]),
                    ("route", "Request Proxy", ["Rewrite request body", "and SSE response"]),
                    ("book-open-text", "Repo Wiki", ["Generate a wiki", "for any project"]),
                    ("paintbrush", "Drawing Studio", ["Text to image, edit", "canvas and reference"]),
                    ("images", "Image Library", ["Albums, search and", "batch import, export"]),
                    ("braces", "LSP Diagnostics", ["Symbol lookup and", "language servers"]),
                ],
            },
            {
                "key": "security",
                "label": "SECURITY AND UX",
                "title": "Snow App security and experience",
                "desc": "Eight security and experience capabilities: app lock, tool authorization, privacy masking, checkpoints and rollback, usage and logs, themes, mobile remote control, desktop pets.",
                "items": [
                    ("lock", "App Lock", ["PIN or authenticator", "locks when unfocused"]),
                    ("shield-check", "Tool Approval", ["Allow lists and tool", "command approvals"]),
                    ("eye-off", "Privacy Masking", ["Rule-based masking", "with custom regex"]),
                    ("history", "Checkpoints", ["File checkpoints", "with rollback support"]),
                    ("chart-column", "Usage and Logs", ["Token usage stats", "system log console"]),
                    ("palette", "Themes", ["Mode, palette and", "fonts and shortcuts"]),
                    ("smartphone", "Mobile Remote", ["Pair over LAN by QR", "self-hosted tunnel"]),
                    ("paw-print", "Desktop Pets", ["Install pet packs", "react to AI work"]),
                ],
            },
        ],
        "ba_title": "From five windows back to one workspace",
        "ba_before": "BEFORE · scattered tools",
        "ba_after": "AFTER · one window",
        "ba_before_items": [
            ("square-terminal", "Terminal app"),
            ("server", "SSH client"),
            ("git-branch", "Git GUI"),
            ("globe", "Browser"),
            ("message-square-text", "Web AI chat"),
        ],
        "ba_lanes": ["Chat and agent", "Terminal · Git · SSH", "Browser"],
    },
}


def build_features(txt, label, items, title, desc, out):
    cols, rows = 4, 2
    pad, gap, card_h = 48, 24, 208
    card_w = (1200 - pad * 2 - gap * (cols - 1)) / cols
    top = 112
    height = int(top + rows * card_h + (rows - 1) * gap + pad)

    s = [svg_open(1200, height, title, desc)]
    s.append(f'  <rect width="1200" height="{height}" rx="18" fill="{PAPER}"/>')
    face = SANS if txt.get("label_face") == "sans" else MONO
    spacing = "0.6" if txt.get("label_face") == "sans" else "1.8"
    size = 20 if txt.get("label_face") == "sans" else 19
    s.append(
        f'  <text x="{pad}" y="72" font-family="{face}" font-size="{size}" '
        f'letter-spacing="{spacing}" fill="{FAINT}">{esc(label)}</text>'
    )
    s.append(f'  <rect x="{pad}" y="88" width="64" height="3" rx="1.5" fill="{BRAND}"/>')

    for i, (ic, name, lines) in enumerate(items):
        cx = pad + (i % cols) * (card_w + gap)
        cy = top + (i // cols) * (card_h + gap)
        s.append(
            f'  <rect x="{cx:.0f}" y="{cy:.0f}" width="{card_w:.0f}" height="{card_h}" '
            f'rx="14" fill="{SURFACE}"/>'
        )
        s.append(icon(ic, cx + 24, cy + 26, 30, INK, 1.8))
        name_size = 25 if len(name) <= 12 else (22 if len(name) <= 16 else 20)
        s.append(
            f'  <text x="{cx + 24:.0f}" y="{cy + 104:.0f}" font-family="{SANS}" '
            f'font-size="{name_size}" font-weight="600" fill="{INK}">{esc(name)}</text>'
        )
        for j, ln in enumerate(lines):
            s.append(
                f'  <text x="{cx + 24:.0f}" y="{cy + 146 + j * 30:.0f}" font-family="{SANS}" '
                f'font-size="20" fill="{MUTED}">{esc(ln)}</text>'
            )
    s.append("</svg>\n")
    write_svg(out, "".join(s))


def build_before_after(txt, out):
    h = 430
    s = [svg_open(1200, h, txt["ba_title"],
                  "Conceptual comparison: scattered single-purpose tools versus one Snow App workspace.")]
    s.append(f'  <rect width="1200" height="{h}" rx="18" fill="{PAPER}"/>')

    s.append(f'  <text x="56" y="66" font-family="{MONO}" font-size="19" letter-spacing="1.6" '
             f'fill="{FAINT}">{esc(txt["ba_before"])}</text>')
    row_h, gap = 56, 14
    for i, (ic, name) in enumerate(txt["ba_before_items"]):
        y = 92 + i * (row_h + gap)
        s.append(f'  <rect x="56" y="{y}" width="440" height="{row_h}" rx="12" fill="{SURFACE_2}"/>')
        s.append(icon(ic, 76, y + 14, 28, FAINT, 1.9))
        s.append(f'  <text x="124" y="{y + 36}" font-family="{SANS}" font-size="21" fill="{MUTED}">{esc(name)}</text>')

    s.append(f'  <path d="M544 215 H636" stroke="{BRAND_DEEP}" stroke-width="3" stroke-linecap="round"/>')
    s.append(f'  <path d="M622 203 L638 215 L622 227" fill="none" stroke="{BRAND_DEEP}" '
             f'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>')

    s.append(f'  <text x="676" y="66" font-family="{MONO}" font-size="19" letter-spacing="1.6" '
             f'fill="{BRAND_DEEP}">{esc(txt["ba_after"])}</text>')
    s.append(f'  <rect x="676" y="92" width="468" height="294" rx="14" fill="{SURFACE}" stroke="{LINE}"/>')
    for x in (860, 1020):
        s.append(f'  <line x1="{x}" y1="92" x2="{x}" y2="386" stroke="{LINE}"/>')
    s.append(f'  <rect x="676" y="92" width="184" height="294" rx="14" fill="{BRAND}55"/>')

    title_x = [694, 876, 1036]
    for i, ln in enumerate(txt["ba_lanes"]):
        s.append(f'  <text x="{title_x[i]}" y="128" font-family="{SANS}" font-size="18" '
                 f'font-weight="600" fill="{INK}">{esc(ln)}</text>')
    for i in range(4):
        s.append(f'  <rect x="694" y="{152 + i * 52}" width="148" height="34" rx="8" fill="{PAPER}"/>')
    for i in range(4):
        y = 152 + i * 52 if i < 2 else 262 + (i - 2) * 52
        s.append(f'  <rect x="876" y="{y}" width="124" height="34" rx="8" fill="{PAPER}"/>')
    s.append(f'  <rect x="1036" y="152" width="88" height="212" rx="8" fill="{PAPER}"/>')
    s.append("</svg>\n")
    write_svg(out, "".join(s))


def main():
    lang = sys.argv[1] if len(sys.argv) > 1 else "zh"
    txt = TEXTS[lang]
    outdir = "%s/%s" % (ASSETS, lang)
    for board in txt["boards"]:
        build_features(
            txt, board["label"], board["items"], board["title"], board["desc"],
            f"{outdir}/features-{board['key']}.svg",
        )
    build_before_after(txt, f"{outdir}/before-after.svg")


if __name__ == "__main__":
    main()
