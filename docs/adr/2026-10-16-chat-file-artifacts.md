# ADR：会话文件产物 / Chat file artifacts

> 日期 / Date: 2026-10-16。状态 / Status: 记录当前实现 / Documents the current implementation.
> 本文覆盖 HTML 文件产物，不把模型提到的路径当作文件写入证据。 / This decision covers HTML file artifacts, not path mentions presented as proof of a write.

## 中文

### 动机与目标

AI 通过文件工具生成网页后，用户需要在会话中查看实际文件，而不是执行模型回复中可能已经过期的源码片段。历史会话也应从持久化消息/调用重建产物入口，而不依赖当时的实时工具事件。与此同时，执行目录可能绑定 WorkTree 或 SSH 工作区，不能把同名相对路径误读为当前项目根目录中的文件。

目标是“真实写入证据发现 + 绑定目录真实读取 + 共用沙箱运行时”，不是网页发布、文件快照存储或任意远程 URL 抓取。隔离细节见 [HTML 预览 ADR](2026-10-16-html-artifact-preview.md)。

### 决策与替代方案

- **采用证据驱动的自动卡片**：仅识别 `filesystem-create`、`filesystem-replace_edit`、`filesystem-copy`。调用必须 `completed`，解析结果明确 `success: true`、不含 `error`、未标记 `truncated: true`，且没有待授权标识；仅有文件路径参数或模型文字不足以自动加载。
- **允许 HTML 链接的手动卡片**：解析 AI 正文中的 Markdown 链接；没有成功写入证据时默认等待显式加载，不因出现链接就自动读取执行。普通代码路径文字不是此入口。
- **不从工具输出拼造页面内容**：读当前磁盘/SSH 文件。工具输出用于证据和版本变化，不替代文件内容。
- **不退回项目根猜测 WorkTree**：绑定必须解析并验证；WorkTree 绑定缺失/失效时关闭入口。SSH 读取在主进程管理连接，不把凭据发送到 renderer 或 iframe。
- **不承诺每帧 O(delta)**：按持久化 message/call 标识复用参数、结果与链接解析，仍遍历消息并重建产物分组；缓存不是已测量的时间复杂度或帧预算保证。

### 跨层路径与代码锚点

| 阶段             | 真实实现路径                                                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话执行根       | `src/renderer/components/mainContent/chatMessages/components/ChatMessageList.tsx::ChatMessageList` 的 `artifactBinding` → `src/renderer/components/mainContent/chatMessages/utils/conversationHelpers.ts::resolveConversationWorkspacePath`。根据会话、目录、WorkTree 模式及 ID 异步验证实际执行根。          |
| 发现、归属与版本 | `src/renderer/components/mainContent/chatMessages/components/chatFileArtifacts.ts::createChatFileArtifactCollector`，以及 `resolveArtifactPath`、`resolveArtifactHref`、`affectedWritePaths`。                                                                                                                |
| 卡片生命周期     | `src/renderer/components/mainContent/chatMessages/components/AiResponse.tsx::AiResponse` 以会话、文件 key、revision、blocked 组成卡片 key；`src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::ChatFileArtifactCard` 管理加载、刷新与过期结果丢弃。                        |
| 本地文件读取     | `window.snow.readFileContent` → `src/preload/modules/workspaceApi.ts::workspaceApi` 的 `readFileContent` → `src/main/ipc/handlers/workspaceHandlers.ts` 的 `workspace-directories:read-file` → native `readFileContent`。读取真实文件，不由卡片生成 HTML。                                                    |
| SSH 文件读取     | `window.snow.sshReadFile(workspace, path)` → `src/preload/modules/sshApi.ts` 的 `sshReadFile` → `src/main/ipc/handlers/sshHandlers.ts` 的 `ssh:read-file` → `src/main/ssh/sshManager.ts::readSshFileWithVersion`。workspace URL 在 main 获取连接 profile、校验绝对远程路径、限额读取，并在 finally 释放引用。 |
| 运行与源码视图   | `src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::HtmlFileRuntime` → `src/renderer/components/mainContent/chatMessages/components/htmlArtifactRenderer.ts::setHtmlArtifactView` → `src/renderer/htmlArtifactHost.html`；不把 preload API 注入沙箱。                      |
| 大小契约         | `src/shared/htmlArtifact.ts::HTML_ARTIFACT_MAX_BYTES` 定义 `2 * 1024 * 1024` 字节，即 2 MiB。renderer 核对返回大小和内容 UTF-8 字节数；SSH workspace 读取同时向 main reader 传此限额。                                                                                                                        |

### 绑定、路径与异步失效

`ChatMessageList` 的绑定对象包含会话、目录、WorkTree 模式、WorkTree ID 与初始化就绪条件，并随会话视图身份变化。异步解析结果保存原绑定对象；当前绑定与结果绑定不是同一对象时，`artifactWorkspace` 在渲染阶段立即变成 `undefined`，**先于被动 effect 禁止读取旧目录**。未解析就不发卡片，连绝对路径也等待绑定；失败不回退猜测根目录。旧异步解析被取消，卡片读请求另有取消标记和递增序号，刷新先使旧结果失效。

路径只接受可解析的 `.html` / `.htm`（大小写忽略）：本地支持绝对路径、相对执行根的路径及有效本地 `file:` 链接；SSH 只允许当前 workspace authority 的 SSH URI 或 POSIX 路径，不把远端路径当本地路径。拒绝控制字符、UNC/双斜线开头和不支持的 scheme。链接先移除 query/fragment 装饰再解码；编码的文件名字符仍是文件名。Windows 文件 key 统一分隔符及大小写。

执行根用于解析相对路径，不是对所有绝对路径施加目录内访问控制的声明。本 ADR 不扩大现有文件 API 的权限语义。

### 归属、缓存与阻塞行为

- 以用户消息分隔轮次，同轮跨 AI 消息按规范文件 key 去重；后续正文链接可把同一个成功产物归属移到包含链接的消息，保留成功证据的自动属性。不同轮次可保留各自卡片。
- 卡片读的是**当前文件**，不是历史字节快照。收集器同时汇总后续写入：pending/running/待授权会挂起同文件旧卡片，失败或不能证明成功的最新写入也阻塞旧预览，避免把旧内容当作本次产物。
- `filesystem-copy` 配合 `deleteSource` 是剪切：目标与源路径都受影响，即使目标不是 HTML，HTML 源也必须失效；只复制时不把未改动的源当作写入。
- 缓存按 message ID 和 `interactionId` / `callId`（缺失时调用索引）保存解析，比较名称、参数、结果、状态和授权状态。仅保留当前消息/调用集合，workspace 变化清空缓存；不依赖每次 render 的对象身份，也不永久保留整段历史调用对象。
- 成功证据卡片自动请求并默认预览；仅链接卡片先显示加载入口。刷新重新读取，pending/failed 阻塞时禁止刷新和运行；读取失败、二进制/NUL 或超限展示状态，不创建运行时。SSH 超限错误映射为超限状态。
- 2 MiB 是**产物接纳上限**，不是 CPU/内存配额，也不是所有本地读取都在读前受同一上限保护的承诺。本地卡片在文件 API 返回后再核对大小；SSH workspace 调用额外传读限额。
- 代码视图只在需要时计算共享高亮，运行使用原始文件内容；切到代码移除 iframe。主题变更不重启同一运行时。本地卡片支持显式在应用内浏览器独立标签打开，SSH 不提供相同本地文件动作；该浏览器标签与文件卡片的离线 sandbox 预览是不同边界，并非系统外部浏览器。

### 验证清单与后果

以下手工场景全部**待验收**，不代表本轮已实测：

- [ ] create/edit/copy 真成功才自动加载；仅参数、失败、截断结果、待授权不冒充成功；HTML 正文链接只手动加载。
- [ ] 同轮多消息与重复链接只有一个对应产物；跨轮旧卡片遇到 pending/running/failed 写入暂停，并在新成功证据后读取新内容。
- [ ] `copy + deleteSource` 同时失效 HTML 源与目标，包括非 HTML 目标；普通复制不误伤源。
- [ ] 快速切会话、项目或 WorkTree，以及绑定失效和慢解析时，旧读/旧 iframe 不恢复，不误读项目根。
- [ ] 本地与 SSH 真实读取；检查同名相对文件、跨 SSH authority 拒绝、query/fragment 与编码字符处理、Windows key 规范化。
- [ ] 2 MiB 边界、超限、多字节内容、二进制/NUL、文件缺失、SSH 断线与刷新竞态呈现正确状态。
- [ ] 历史消息恢复、参数流式片段、稳定标识重用和内容变化可正确触发 revision；不据此推导每帧性能保证。
- [ ] 代码/预览切换停止并重建运行时；主题切换不重跑；显式打开应用内浏览器独立标签，与文件卡片离线 sandbox 预览的边界明确区分。

运行 `npm run check:docs` 检查文档结构与链接。源码改动的编译及真实本地/SSH UI 验收另行执行；此次纯文档工作不新增测试或声称这些门禁通过。

## English

### Motivation and goals

After file tools generate a page, users need to inspect the actual file in the conversation, not execute a potentially stale source fragment from the model response. History must reconstruct artifact entries from persisted messages/calls rather than live tool events. The execution root can be a WorkTree or SSH workspace, so a relative filename must not silently resolve against the current project root.

The goal is evidence-based discovery, real reads against the bound execution root, and a shared sandbox runtime—not publishing, historical file-byte snapshots, or arbitrary remote-URL fetching. See the [HTML preview ADR](2026-10-16-html-artifact-preview.md) for isolation.

### Decision and alternatives

- **Use write evidence for automatic cards**: recognize only `filesystem-create`, `filesystem-replace_edit`, and `filesystem-copy`. A call must be `completed`; its parsed result must explicitly contain `success: true`, have no `error`, not be marked `truncated: true`, and have no pending authorization identifier. Path arguments or model prose alone cannot authorize automatic loading.
- **Allow manual cards for HTML links**: parse Markdown links in assistant body text. Without successful-write evidence, the card waits for explicit loading instead of reading/executing merely because a link exists. Ordinary code-formatted path mentions are not this entry point.
- **Do not synthesize pages from tool output**: read current disk/SSH content. Tool output supports evidence/revisions, not replacement file bytes.
- **Do not guess a project-root fallback for WorkTrees**: resolve and validate bindings; missing/invalid WorkTree bindings close the entry point. Main manages SSH connections without sending credentials to the renderer or iframe.
- **Do not promise per-frame O(delta)**: persisted message/call identities reuse argument, result, and link parsing, but the collector still traverses messages and rebuilds groups. Caching is not a measured complexity or frame-time guarantee.

### Cross-layer path and code anchors

| Stage                           | Actual implementation path                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution root                  | `src/renderer/components/mainContent/chatMessages/components/ChatMessageList.tsx::ChatMessageList`, `artifactBinding` → `src/renderer/components/mainContent/chatMessages/utils/conversationHelpers.ts::resolveConversationWorkspacePath`. Asynchronously validates the real root using conversation, directory, WorkTree mode, and ID.                           |
| Discovery, ownership, revisions | `src/renderer/components/mainContent/chatMessages/components/chatFileArtifacts.ts::createChatFileArtifactCollector`, plus `resolveArtifactPath`, `resolveArtifactHref`, and `affectedWritePaths`.                                                                                                                                                                 |
| Card lifecycle                  | `src/renderer/components/mainContent/chatMessages/components/AiResponse.tsx::AiResponse` keys cards by conversation, file key, revision, and blocked state; `src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::ChatFileArtifactCard` manages loads, refreshes, and stale-result rejection.                                    |
| Local read                      | `window.snow.readFileContent` → `src/preload/modules/workspaceApi.ts::workspaceApi`, `readFileContent` → `src/main/ipc/handlers/workspaceHandlers.ts`, `workspace-directories:read-file` → native `readFileContent`. Reads a real file rather than generating HTML inside the card.                                                                               |
| SSH read                        | `window.snow.sshReadFile(workspace, path)` → `src/preload/modules/sshApi.ts`, `sshReadFile` → `src/main/ipc/handlers/sshHandlers.ts`, `ssh:read-file` → `src/main/ssh/sshManager.ts::readSshFileWithVersion`. Main acquires a connection profile for workspace URLs, validates absolute remote paths, passes a read limit, and releases the reference in finally. |
| Runtime and source view         | `src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::HtmlFileRuntime` → `src/renderer/components/mainContent/chatMessages/components/htmlArtifactRenderer.ts::setHtmlArtifactView` → `src/renderer/htmlArtifactHost.html`; no preload API is injected into the sandbox.                                                         |
| Size contract                   | `src/shared/htmlArtifact.ts::HTML_ARTIFACT_MAX_BYTES` is `2 * 1024 * 1024` bytes, or 2 MiB. Renderer checks returned size and UTF-8 content bytes; SSH workspace calls also pass that limit to the main reader.                                                                                                                                                   |

### Binding, paths, and asynchronous invalidation

`ChatMessageList` includes conversation, directory, WorkTree mode/ID, and initialization readiness in its binding object, which also changes with session-view identity. Resolved results retain the original binding object. If it differs from the current object, `artifactWorkspace` immediately becomes `undefined` during rendering, **before passive effects can read the old directory**. No cards are collected until resolution, including absolute-path cards; failures do not guess a root fallback. Old resolution effects are cancelled; card reads separately use cancellation flags and increasing request sequences, and refresh invalidates earlier results first.

Only resolvable `.html` / `.htm` paths are accepted, case-insensitively. Local paths may be absolute, execution-root-relative, or valid local `file:` links. SSH accepts POSIX paths or SSH URIs belonging to the current workspace authority, never treating remote paths as local. Control characters, UNC/double-slash prefixes, and unsupported schemes are rejected. Links strip query/fragment decorations before decoding; encoded filename characters remain filename characters. Windows file keys normalize separators and case.

The execution root resolves relative paths; this is not a claim of directory containment for every absolute path. This ADR does not broaden existing file-API permission semantics.

### Ownership, caching, and blocking

- User messages delimit runs. Within a run, normalized file keys deduplicate across assistant messages; a later body link can move a successful artifact's ownership to the linking message while retaining its automatic evidence. Separate runs may keep separate cards.
- Cards read the **current file**, not historical bytes. The collector also summarizes later writes: pending/running/authorization suspends older cards for that file, and a failed or unproven latest write blocks old previews so stale content is not presented as the new artifact.
- `filesystem-copy` with `deleteSource` is a cut: both destination and source are affected, including an HTML source with a non-HTML destination. Ordinary copy does not count the unchanged source as written.
- Parsing caches use message ID and `interactionId` / `callId` (or call index when absent), comparing name, arguments, result, status, and authorization state. Only the current message/call set is retained; a workspace change clears the cache. It does not depend on render-object identity or globally retain entire historical call objects forever.
- Successful-evidence cards request automatically and default to preview; link-only cards first show a load action. Refresh rereads. Pending/failed blocking disables refresh and runtime; failed reads, binary/NUL content, and oversized files show a status without creating a runtime. SSH size errors map to the oversized status.
- 2 MiB is an **artifact acceptance limit**, not a CPU/memory quota or a promise that every local read is bounded by the same limit before reading. Local cards check after the file API returns; SSH workspace reads additionally pass a reader limit.
- Source highlighting is computed lazily in code view, while execution uses original file content. Code view removes the iframe; changing themes does not restart an unchanged runtime. Local cards offer an explicit app-browser tab action; SSH cards do not offer the same local-file action. This opens a separate tab in the application browser, not the system's external browser, and is distinct from the file card's offline sandbox preview boundary.

### Verification checklist and consequences

All manual scenarios below are **pending acceptance**, not claimed as executed in this documentation change:

- [ ] Only real create/edit/copy success auto-loads; arguments alone, failures, truncated results, or pending authorization do not establish success; HTML body links remain manual without evidence.
- [ ] Deduplicate same-run messages/links; suspend older cross-run cards on pending/running/failed writes and read new content after new successful evidence.
- [ ] A cut invalidates both HTML source and destination, including a non-HTML destination; ordinary copy does not invalidate its unchanged source.
- [ ] Fast conversation/project/WorkTree switches, invalid bindings, and slow resolution cannot restore stale reads/frames or read the wrong project root.
- [ ] Verify real local/SSH reads, same-name relative files, foreign SSH-authority rejection, URI decorations/encoding, and Windows key normalization.
- [ ] Verify the 2 MiB boundary, oversize and multibyte content, binary/NUL data, missing files, SSH disconnects, and refresh races.
- [ ] Verify history restoration, partial streamed arguments, stable identifier reuse, and revision changes without inferring a per-frame performance guarantee.
- [ ] Code/preview switching stops and recreates execution; themes do not rerun it; distinguish the explicit app-browser tab action from the file card's offline sandbox preview boundary.

Run `npm run check:docs` for documentation structure and links. Compilation after source changes and real local/SSH UI acceptance are separate gates. This documentation-only work adds no tests and does not claim those gates passed.
