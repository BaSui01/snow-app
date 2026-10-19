# ADR：HTML 动态预览 / HTML artifact preview

> 日期 / Date: 2026-10-16。状态 / Status: 记录当前实现 / Documents the current implementation.
> 中文与英文在本文件中实质对等；验证清单不是已通过报告。 / Both language sections describe the same contract; checklists are not pass reports.

## 中文

### 上下文、动机与范围

聊天生成的 HTML 需要展示交互效果，同时保留可阅读、可复制的源码。将生成内容直接插入应用 DOM 会混淆执行权限与样式边界；每次 Markdown 更新都重建预览，又会重复运行脚本。因此采用独立承载页、显式生命周期与按入口区分的自动预览策略。

本决策只覆盖 `html`、`htm`、`text/html` 围栏和复用该运行时的 HTML 文件卡片；标签忽略大小写，可带空白分隔的元信息。它不是通用网页浏览器，不新增 JSX 编译器，也不替换 Markdown 或 Mermaid 渲染器。文件发现与读取另见 [会话文件产物 ADR](2026-10-16-chat-file-artifacts.md)，源码配色见 [共享高亮 ADR](2026-10-16-shared-syntax-highlighting.md)。

### 决策与替代方案

- **采用独立 iframe 承载页**：`sandbox="allow-scripts"`，不授予 `allow-same-origin`；设置 `referrerpolicy="no-referrer"`。承载页有自己的 CSP，生成 HTML 通过消息送入其中，再由承载页写入文档，不进入应用宿主 DOM。
- **不采用宿主 DOM 注入**：不能把可执行生成内容与应用权限放在同一文档。
- **不采用直接 `srcdoc` / blob 作为当前加载方案**：当前代码选择单独加载具有独立 CSP 的承载页，而不是依赖应用文档的策略。
- **不采用所有入口一律自动运行**：只有合格的 AI 正文与 sections 默认预览；思考过程、Markdown 文件阅读器与编辑器保持显式点击。成功文件产物有独立加载策略，不由围栏自动策略授权。
- **不为布局放宽隔离**：共享样式在 Vite HTML 处理末阶段内嵌到承载页，而不是让不透明 `file:` 沙箱读取外部 CSS。

### 跨层实现路径

| 层与锚点                                                                                                                         | 职责与合约                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/mainContent/chatMessages/components/AiResponse.tsx::AiResponse`                                         | 对正文与 sections 传入 `autoPreviewHtml`；排除流式、错误、取消、重试、不完整与中断状态，并要求上游预览资格。                                              |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts::trackFenceCompletion`                            | 观察真正的 Markdown fence parser 是否消费闭合标记；EOF 或父容器结束不算闭合，不用“渲染器能显示代码”推断可执行。                                           |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts` 的 `markdown.renderer.rules.fence`               | 输出编码后的原始源码、`data-html-complete`、源码视图与预览占位，尚不创建 iframe。                                                                         |
| `src/renderer/components/mainContent/chatMessages/components/markdownRenderer.tsx::MarkdownBlock`                                | 先提交与当前内容匹配的 DOM 快照，再同步预览；流式或暂停时清理 iframe，卸载时清理运行时；用户选择代码视图优先。                                            |
| `src/renderer/components/mainContent/chatMessages/components/htmlArtifactRenderer.ts::syncHtmlArtifacts` / `setHtmlArtifactView` | 在非流式、真实闭合、当前快照就绪且节点存活时启动；已有 iframe 不重复创建，代码视图通过移除 iframe 停止执行。                                              |
| `src/renderer/htmlArtifactHost.html`                                                                                             | 独立 CSP、文档写入、缩放测量及受限消息协议。                                                                                                              |
| `src/renderer/styles.css` 与 `electron.vite.config.ts` 的 `html-artifact-carrier-layout`                                         | 布局单一来源；`transformIndexHtml` 的 `post` 阶段提取唯一的 `.html-artifact-frame` 与 `.html-artifact-carrier` 规则到占位标记；规则重复或标记缺失时报错。 |

围栏预览从 renderer 到独立浏览上下文，不经过 preload、IPC 或 Rust。文件卡片读取文件时才走这些宿主层；不得把文件读取权限暴露给 iframe。

### 消息协议与缩放

通信**不是完全单向**：父页先发送源码与标题，并发送缩放模式或相对放大/缩小操作；承载页只按协议回传缩放状态 `mode` 与 `factor`，不回传文档内容，不提供宿主 API。

- 承载页仅接收 `event.source === parent` 的初始化与缩放消息。
- 父页 `handleZoomState` 用 `event.source` 查找登记的 iframe，并同时验证 iframe 仍连接、仍属于当前块且是该块的现用预览；不依赖不透明源的 origin 字符串做信任判定。
- 回传类型必须匹配缩放状态消息；`mode` 只能是 `width`、`page`、`manual`，`factor` 必须是有限数且在 `0.25` 至 `4` 之间。其他字段不成为宿主能力或内容通道。
- 因沙箱源不透明，发送使用 `targetOrigin="*"`，只发送预览源码、标题和缩放控制，不发送应用机密或权限。
- 默认适应整页，另有适应宽度、手动加减和重置为 100%。适应模式只缩小，最终仍受缩放边界约束；相对步进在承载页基于实时比例计算，回传实际比例更新工具栏。

### 行为、失败与限制

1. 自动围栏预览须同时满足：AI 正文/sections 授权、非流式且无错误/重试/取消/中断/不完整状态、源围栏真实闭合、与当前内容对应的已提交 DOM 就绪。停止流式并不单独证明源码完整。
2. 思考、阅读器、编辑器不主动选择自动预览；用户点击预览仍需围栏闭合并满足运行时门禁。手动代码视图阻止后续自动切回；代码视图和卸载移除 iframe，而不只是隐藏它。
3. 同一源码与视图下不因同步工具栏或主题变更重建 iframe；主题配色不是重跑生成脚本的理由。切回预览创建新浏览上下文，不承诺保留上一次脚本状态。
4. 外部网络依赖不可用：CSP 为 `default-src 'none'`、`script-src 'unsafe-inline'`、`style-src 'unsafe-inline'`、`img-src data: blob:`、`font-src data:`、`connect-src 'none'`。允许内联脚本/样式及 data/blob 图片、data 字体；外部脚本、样式、字体、连接、对象和嵌套框架不受允许，沙箱未授予表单等权限。CDN 资源不会由应用代取。
5. 预览在有界高度的视口内展示、内部滚动；布局与缩放不是执行资源隔离。**没有 CPU/内存配额，不承诺阻止文档自身导航，只预览可信内容。** 此沙箱不是运行恶意代码的安全服务。

### 验证与扩展清单

以下均为**待验收**的手工场景，本次文档补齐不声称真实 UI 已通过：

- [ ] AI 正文与 sections：闭合 HTML 围栏在终态且快照就绪后自动预览；大小写和元信息可识别。
- [ ] EOF 未闭合、列表/引用容器提前结束、流式、错误、重试、取消、中断与不完整响应不自动执行。
- [ ] 思考、Markdown 阅读器/编辑器须点击；手动代码优先，代码视图/卸载后 iframe 已移除。
- [ ] 主题切换不增加 iframe 加载次数或重跑计数；切回预览重新启动符合预期。
- [ ] 伪造来源、已移除 iframe、错误消息类型、非法模式、非有限或越界比例均不更新父页状态。
- [ ] 适应宽度/整页、连续加减、100% 重置和窄容器工具栏；核对实际回传比例与内部滚动。
- [ ] 开发与打包环境承载页均内嵌共享布局；外部依赖保持受限，宿主 API 不可达。

文档门禁：运行 `npm run check:docs`。修改执行链路时另需按改动面做类型检查/构建及上述 UI 验收；文档检查不能证明沙箱运行行为或安全边界已通过。

## English

### Context, motivation, and scope

Generated HTML needs an interactive result alongside readable, copyable source. Injecting it into the application DOM would mix execution privileges and styling boundaries; rebuilding previews on every Markdown update would rerun scripts. The implementation therefore uses a separate carrier document, explicit runtime lifecycle, and surface-specific automatic-preview policy.

This decision covers `html`, `htm`, and `text/html` fences and HTML file cards reusing the runtime. Labels are case-insensitive and may include whitespace-separated metadata. It is not a general browser or a JSX compiler, and does not replace Markdown or Mermaid rendering. See the [chat file artifacts ADR](2026-10-16-chat-file-artifacts.md) for discovery/reads and the [shared highlighting ADR](2026-10-16-shared-syntax-highlighting.md) for source colors.

### Decision and alternatives

- **Use a separately loaded iframe carrier** with `sandbox="allow-scripts"`, without `allow-same-origin`, and with `referrerpolicy="no-referrer"`. It has its own CSP; messages deliver generated HTML for writing inside the carrier, never into the application DOM.
- **Reject host-DOM injection** because executable generated content must not share the application document's privileges.
- **Do not use direct `srcdoc` / blob loading here**: the current design deliberately loads a distinct document with its own CSP rather than relying on the application document's policy.
- **Reject automatic execution on every surface**: only eligible assistant bodies and sections opt in. Reasoning, Markdown file readers, and editors require a click. Successful file artifacts have a separate loading policy, not authorization from the fence policy.
- **Do not weaken isolation for layout**: embed shared layout rules in the final Vite HTML-processing stage instead of fetching external CSS from an opaque `file:` sandbox.

### Implementation across boundaries

| Layer and anchor                                                                                                                 | Responsibility and contract                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/mainContent/chatMessages/components/AiResponse.tsx::AiResponse`                                         | Passes `autoPreviewHtml` to bodies and sections only with upstream eligibility and without streaming, errors, aborting, retries, incomplete output, or interruptions.                                 |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts::trackFenceCompletion`                            | Observes whether the real fence parser consumed a closing marker. EOF and parent-container termination do not count; rendering visible code does not establish executability.                         |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts`, `markdown.renderer.rules.fence`                 | Emits encoded original source, `data-html-complete`, source markup, and a preview placeholder without creating an iframe.                                                                             |
| `src/renderer/components/mainContent/chatMessages/components/markdownRenderer.tsx::MarkdownBlock`                                | Commits a DOM snapshot matching current content before preview synchronization; cleans up frames on streaming, pause, and unmount; preserves manual code-view preference.                             |
| `src/renderer/components/mainContent/chatMessages/components/htmlArtifactRenderer.ts::syncHtmlArtifacts` / `setHtmlArtifactView` | Starts only outside streaming with a truly closed fence, a current ready snapshot, and a connected node; reuses an existing frame and removes it in code view to stop execution.                      |
| `src/renderer/htmlArtifactHost.html`                                                                                             | Own CSP, document writes, zoom measurement, and restricted messaging.                                                                                                                                 |
| `src/renderer/styles.css` and `electron.vite.config.ts`, `html-artifact-carrier-layout`                                          | One layout source. A `post` `transformIndexHtml` hook embeds the unique `.html-artifact-frame` and `.html-artifact-carrier` rules at the marker; duplicate rules or a missing marker fail explicitly. |

Fence preview stays between the renderer and an isolated browsing context: no preload, IPC, or Rust call is involved. File cards use host layers only to read files; those capabilities are not exposed to the iframe.

### Messaging and zoom

Communication is **not entirely one-way**. The parent sends source/title and zoom modes or relative zoom actions; the carrier's accepted reply protocol contains only zoom state, `mode` and `factor`, not document content or host APIs.

- The carrier accepts initialization and zoom messages only from `event.source === parent`.
- Parent-side `handleZoomState` resolves `event.source` to a registered iframe, checks that it is connected and still the current preview of its block, and does not use an opaque origin string as the trust decision.
- The reply type must match the zoom-state message; `mode` is restricted to `width`, `page`, or `manual`, and `factor` must be finite and within `0.25`–`4`. Other fields do not become content channels or host capabilities.
- The opaque sandbox origin requires `targetOrigin="*"`. Only preview source, title, and zoom control are sent, not application secrets or privileges.
- Fit-page is the default; fit-width, relative steps, and a 100% reset are available. Fit modes only shrink, subject to final scale bounds. The carrier computes relative steps against the live scale and returns the effective factor for the toolbar.

### Behavior, failures, and limitations

1. Automatic fences require all of: assistant-body/sections opt-in; no streaming, error, retry, abort, interruption, or incomplete state; a genuinely closed source fence; and a committed DOM snapshot matching current content. Ending a stream alone does not prove completeness.
2. Reasoning, readers, and editors do not opt in automatically; clicking preview still requires closure and runtime gates. Manual code view prevents automatic switching back. Code view and unmount remove the iframe rather than merely hiding it.
3. Synchronizing controls or changing themes does not recreate the iframe for unchanged source/view. Source colors do not justify rerunning generated scripts. Returning to preview creates a new browsing context and does not promise to preserve script state.
4. External dependencies are unavailable. CSP is `default-src 'none'`, `script-src 'unsafe-inline'`, `style-src 'unsafe-inline'`, `img-src data: blob:`, `font-src data:`, and `connect-src 'none'`. Inline scripts/styles, data/blob images, and data fonts are allowed; external scripts/styles/fonts, connections, objects, and nested frames are not permitted. Sandbox permissions such as forms are not granted. The app does not proxy CDN assets.
5. The preview uses a bounded-height viewport with internal scrolling. Layout and zoom are not resource isolation. **There are no CPU/memory quotas, self-navigation is not guaranteed to be prevented, and only trusted content should be previewed.** This is not a secure service for executing hostile code.

### Verification and extension checklist

All manual scenarios below are **pending acceptance**; this documentation addition does not claim a real UI pass:

- [ ] Eligible assistant bodies/sections preview closed HTML fences only after terminal state and the current DOM snapshot; recognize case variants and metadata.
- [ ] Unclosed EOF, early list/quote termination, streaming, errors, retries, aborts, interruptions, and incomplete responses do not auto-execute.
- [ ] Reasoning and Markdown readers/editors require a click; manual code choice wins; code view/unmount removes the frame.
- [ ] Theme changes do not add frame loads or execution counts; returning to preview restarts as expected.
- [ ] Forged sources, detached frames, wrong message types, invalid modes, and nonfinite/out-of-range factors do not update parent state.
- [ ] Check fit modes, repeated relative actions, 100% reset, narrow toolbars, effective-factor feedback, and internal scrolling.
- [ ] Development and packaged carriers embed shared layouts while retaining external-resource restrictions and no host API access.

Documentation gate: run `npm run check:docs`. Changes to execution paths also require scoped type/build checks and the UI acceptance above. A documentation check is not evidence that sandbox behavior or security boundaries passed.
