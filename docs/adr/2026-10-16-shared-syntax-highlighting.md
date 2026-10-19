# ADR：共享源码高亮 / Shared source highlighting

> 日期 / Date: 2026-10-16。状态 / Status: 记录当前实现 / Documents the current implementation.
> 预算与缓存数值来自本轮核对的源码常量，不是基准测试结果。 / Budgets and cache sizes below are verified source constants, not benchmark results.

## 中文

### 动机、职责与边界

聊天围栏、HTML 文件卡片、工具代码片段和文件阅读器需要一致的语言别名、安全转义和主题配色。HTML 源码还包含 CSS/JavaScript 子语言，不能把“有代码视图”误当作“已有多色高亮”。同时文件阅读器已有虚拟行、分块和缓存策略，统一词法入口不应把它改成整文件同步高亮。

本方案集中语言解析与有预算的 highlight.js 调用，保留各视图自己的呈现与调度。高亮是**展示**而非执行或编译：HTML 运行时仍用原文；`jsx`/`tsx` 别名只影响配色，不提供 JSX 编译或新的预览类型。执行边界见 [HTML 预览 ADR](2026-10-16-html-artifact-preview.md)，文件加载见 [会话文件产物 ADR](2026-10-16-chat-file-artifacts.md)。

### 决策与替代方案

1. **共享工具层而非重复语言映射**：`src/renderer/utils/syntaxHighlight.ts` 管理 `LANGUAGE_ALIASES`、`FILE_LANGUAGES`、首标签提取、语言规范化、路径推断、代码文本转义和高亮回退。
2. **语义主题角色而非独立固定色板**：`src/renderer/themes/tokens.css` 定义引用应用现有语义颜色的 `--syntax-*`；`src/renderer/themes/hljs.css` 在 `.hljs` 源码根下消费这些角色，覆盖标签、属性、关键字、字符串、注释、数字及嵌套 token。
3. **有界同步分词而非无条件调用**：超过 `MAX_SYNTAX_HIGHLIGHT_CHARS`，或语言缺失、不支持、分词异常时，完整安全转义原文，不截断。
4. **保留文件阅读器分块而非整文件统一处理**：复用共享工具，但维持上下文、虚拟行及 LRU。也不以逐行独立分词替代工具片段的完整分词，以免丢失跨行注释/字符串状态。
5. **不扩展为渲染器重写**：不更换 Markdown/Mermaid，不为源码配色重建 iframe，不新增执行环境。

### 跨组件实现路径

| 入口与代码锚点                                                                                                                        | 数据流及保留的契约                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/utils/syntaxHighlight.ts::getCodeLanguageHint` / `normalizeCodeLanguage` / `getCodeLanguageFromPath`                    | 围栏只取第一个空白分隔标签、小写化并校验字符；元信息不进入语言类名。别名如 `html` / `htm` / `text/html` → `xml`，`js` → `javascript`；路径按扩展名和既有特殊文件名规则识别。 |
| `src/renderer/utils/syntaxHighlight.ts::highlightCodeHtml` / `escapeCodeHtml`                                                         | 检查同步预算及语言支持后调用 highlight.js；失败完整转义 `&`、`<`、`>`。输出用于代码文本区域，不是通用属性值转义器。                                                          |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts` 的 `highlight` 回调与 `markdown.renderer.rules.fence` | 普通代码与 HTML 围栏调用共享入口；HTML 使用 XML 语法及其已支持的子语言高亮，保留原文供复制/执行，不把原始源码直接当宿主 HTML。                                               |
| `src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::HtmlFileRuntime`                               | 只在代码视图 `useMemo` 计算 HTML 源码高亮，预览视图不为隐藏源码额外分词；运行使用原始 `source`。                                                                             |
| `src/renderer/components/mainContent/chatMessages/toolCalls/shared/CodeHighlightView.tsx::CodeHighlightView`                          | 显式语言优先，否则按文件路径推断；先对完整片段高亮，再用 `splitHighlightedHtmlLines` 拆行，保留跨行 token，复制仍写入原始 `code`。保留既有初始行数与展开行为。               |
| `src/renderer/components/rightPanel/FileViewerContent.tsx`                                                                            | 编辑器高亮入口调用共享 `highlightCodeHtml`；阅读器继续使用自己的行索引、折叠和虚拟行呈现。                                                                                   |
| `src/renderer/components/rightPanel/fileViewer/codeHighlight.ts::createCodeHighlighter` / `readChunk`                                 | 规范语言后按上下文分块；缓存命中须匹配语言、正文和前缀上下文，保留 LRU 与预取。                                                                                              |
| `src/renderer/themes/tokens.css` 与 `src/renderer/themes/hljs.css`                                                                    | 语义角色映射到现有主题颜色；样式变化不改变原始代码或 HTML 执行实例。                                                                                                         |

这条路径在 renderer/Markdown worker 中完成，不需要新增 preload、IPC 或 Rust 服务。文件内容如何进入阅读器/卡片是读取层的职责，不是高亮层的权限。

### 预算、缓存与回退细节

- 共享同步预算为 `128 * 1024`，即 **131,072 个 JavaScript 字符串长度单位**，不是 UTF-8 字节限制。条件是 `source.length > MAX_SYNTAX_HIGHLIGHT_CHARS` 才回退；这与 HTML 文件卡片 2 MiB 接纳上限是不同契约。
- 超预算、未知/空语言或高亮异常返回**完整 escaped 纯文本**；不截断源码、不丢弃复制/执行内容，也不进行自动语言猜测。预算限制分词输入，不是耗时、内存或帧率保证。
- 阅读器保留 `CHUNK_LINES = 128`、`CONTEXT_LINES = 12`、`MAX_CHUNK_CHARS = 65536` 和 `MAX_CACHED_CHUNKS = 128`。分块正文加前缀超过自身预算就走行文本回退，而不是强行利用共享层更大的预算。
- 全局块缓存 key 包含规范语言和块正文；entry 还保存前缀文本，只有前缀相同才复用结果。命中刷新 LRU；容量受限时淘汰最旧项。相同正文但语言/上下文不同不复用错误配色。
- 上下文只有前 12 行，不承诺从文件开头重建任意长语法状态。现有 `truncateLongLine` 的长行显示保护和虚拟行策略仍在；“共享高亮完整降级”不等于取消阅读器既有长行展示截断提示。
- 主题切换通过 `--syntax-*` 和 `.hljs` 样式更新源码颜色，不触发 HTML iframe 重建。`html` 在高亮中映射到 `xml` 不等于把所有 XML/框架文件加入可执行 HTML 围栏白名单。

### 扩展与验证清单

扩展语言时修改共享别名/路径映射，核对 highlight.js 实际支持；扩展配色时增加语义角色及 `.hljs` 规则，不在各组件复制固定颜色。保持原文、执行白名单和阅读器预算彼此独立。

以下手工场景全部为**待验收**；本轮没有据此声称 UI、性能或基准测试通过：

- [ ] 聊天普通围栏、HTML 围栏、卡片代码视图、工具片段、阅读器和编辑器的语言别名/主题角色一致。
- [ ] 混合大小写标签、带元信息标签、未知语言、空语言及带特殊字符输入安全显示，不把标签元信息注入属性。
- [ ] HTML 标签/属性、内联 CSS/JavaScript、跨行注释和模板字符串正确配色；工具拆行不丢 token 范围。
- [ ] 输入长度在 131,072 边界及超出时行为符合条件；超预算文本完整转义，复制和执行原文不变。
- [ ] 阅读器相同块在不同规范语言、不同前缀上下文、编辑重建行索引后不串缓存；LRU/预取、虚拟行和长行保护保持。
- [ ] 大文件分块含上下文超过 65,536 字符时正常回退；不推导耗时或内存配额。
- [ ] 各主题源码对比度人工核对；切换主题不重跑预览脚本；卡片仅在代码视图计算高亮。
- [ ] Markdown、Mermaid、复制与原始文件读取没有因共享高亮改变既有入口或内容。

文档门禁为 `npm run check:docs`。高亮实现变更仍需按影响范围执行类型检查/构建与真实 UI 验收；文档检查不能替代这些门禁。此次文档补齐不新增测试。

## English

### Motivation, responsibilities, and boundaries

Chat fences, HTML file cards, tool snippets, and the file viewer need consistent language aliases, escaping, and theme colors. HTML source also contains CSS/JavaScript sublanguages: having a source view alone does not establish multicolor highlighting. The file viewer already has virtual rows, chunking, and caches; sharing tokenization must not turn it into synchronous whole-file highlighting.

The design centralizes language resolution and budgeted highlight.js calls while preserving each surface's presentation and scheduling. Highlighting is **display**, not execution or compilation: the HTML runtime still uses original text. `jsx`/`tsx` aliases affect coloring only, not JSX compilation or new preview types. See the [HTML preview ADR](2026-10-16-html-artifact-preview.md) for execution boundaries and the [chat file artifacts ADR](2026-10-16-chat-file-artifacts.md) for reads.

### Decision and alternatives

1. **Share utilities rather than duplicate mappings**: `src/renderer/utils/syntaxHighlight.ts` owns `LANGUAGE_ALIASES`, `FILE_LANGUAGES`, first-label extraction, normalization, path inference, code-text escaping, and fallback.
2. **Use semantic theme roles rather than a separate fixed palette**: `src/renderer/themes/tokens.css` defines `--syntax-*` in terms of existing application semantic colors; `src/renderer/themes/hljs.css` consumes them under `.hljs` source roots, including tags, attributes, keywords, strings, comments, numbers, and nested tokens.
3. **Bound synchronous tokenization rather than always invoking it**: exceeding `MAX_SYNTAX_HIGHLIGHT_CHARS`, missing/unsupported languages, or exceptions returns complete escaped source without truncation.
4. **Preserve viewer chunks rather than force whole-file processing**: reuse the utility while retaining context, virtual rows, and LRU. Do not replace complete tool-snippet tokenization with independent line tokenization, which loses multiline comment/string state.
5. **Do not rewrite renderers**: no Markdown/Mermaid replacement, iframe rebuild for source coloring, or new execution environment.

### Cross-component implementation path

| Entry and code anchor                                                                                                                     | Flow and preserved contract                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/utils/syntaxHighlight.ts::getCodeLanguageHint` / `normalizeCodeLanguage` / `getCodeLanguageFromPath`                        | Extracts, lowercases, and validates the first whitespace-separated fence label; metadata does not enter language classes. Aliases include `html` / `htm` / `text/html` → `xml`, and `js` → `javascript`. Paths use extension and existing special-filename rules. |
| `src/renderer/utils/syntaxHighlight.ts::highlightCodeHtml` / `escapeCodeHtml`                                                             | Checks synchronous budget/language support before highlight.js; fallback escapes all `&`, `<`, and `>`. This escapes code text, not arbitrary attribute values.                                                                                                   |
| `src/renderer/components/mainContent/chatMessages/components/markdownWorker.ts`, `highlight` callback and `markdown.renderer.rules.fence` | Regular code and HTML fences use the shared utility. HTML uses XML syntax and its supported sublanguages; originals remain available for copying/execution rather than being inserted as raw host HTML.                                                           |
| `src/renderer/components/mainContent/chatMessages/components/ChatFileArtifactCard.tsx::HtmlFileRuntime`                                   | `useMemo` highlights HTML only in code view, avoiding tokenization for hidden source in preview view; execution receives the original `source`.                                                                                                                   |
| `src/renderer/components/mainContent/chatMessages/toolCalls/shared/CodeHighlightView.tsx::CodeHighlightView`                              | Explicit language wins, otherwise infer from path. Highlights the complete snippet before `splitHighlightedHtmlLines` so multiline tokens survive. Copy still writes original `code`; initial-line and expand behavior remain.                                    |
| `src/renderer/components/rightPanel/FileViewerContent.tsx`                                                                                | Editor highlighting uses shared `highlightCodeHtml`; reader retains line indices, folding, and virtual rows.                                                                                                                                                      |
| `src/renderer/components/rightPanel/fileViewer/codeHighlight.ts::createCodeHighlighter` / `readChunk`                                     | Normalizes language before context-aware chunking; cache reuse requires matching language, body, and prefix context, retaining LRU and prefetch.                                                                                                                  |
| `src/renderer/themes/tokens.css` and `src/renderer/themes/hljs.css`                                                                       | Semantic roles resolve against existing theme colors; style changes do not mutate original code or HTML execution instances.                                                                                                                                      |

This path stays in the renderer/Markdown worker and introduces no preload, IPC, or Rust service. Supplying file content belongs to the reading layer, not to highlighting privileges.

### Budgets, cache isolation, and fallback

- Shared synchronous budget is `128 * 1024`, or **131,072 JavaScript string-length units**, not UTF-8 bytes. Fallback is triggered by `source.length > MAX_SYNTAX_HIGHLIGHT_CHARS`; this is distinct from the HTML file card's 2 MiB acceptance limit.
- Over-budget input, unknown/empty language, or exceptions produce **complete escaped plain text**: no source truncation, loss of copied/executed content, or automatic language detection. The budget bounds tokenization input, not duration, memory, or frame rate.
- The reader retains `CHUNK_LINES = 128`, `CONTEXT_LINES = 12`, `MAX_CHUNK_CHARS = 65536`, and `MAX_CACHED_CHUNKS = 128`. A body plus prefix exceeding its own chunk budget falls back to line text rather than exploiting the larger shared budget.
- Global chunk-cache keys include normalized language and chunk body; entries also store prefix text, which must match for reuse. Hits refresh LRU order; capacity eviction removes the oldest entry. Identical bodies with different languages/context cannot incorrectly reuse colors.
- Only the preceding 12 lines supply context; arbitrary long syntax state from the file start is not guaranteed. Existing `truncateLongLine` display protection and virtual rows remain. Complete shared fallback does not remove the reader's existing long-line display truncation notice.
- Themes update source colors through `--syntax-*` and `.hljs` styles without rebuilding HTML iframes. Mapping `html` to `xml` for highlighting does not add every XML/framework file to the executable HTML fence allowlist.

### Extension and verification checklist

Extend shared aliases/path mappings when adding a language, checking actual highlight.js support. Extend semantic roles and `.hljs` rules for colors rather than copying fixed palettes into components. Keep original text, execution allowlists, and viewer budgets independent.

All manual scenarios below are **pending acceptance**. No UI, performance, or benchmark pass is asserted by this documentation change:

- [ ] Verify consistent aliases/theme roles across regular chat fences, HTML fences, card source, tools, readers, and editors.
- [ ] Safely display mixed-case/metadata labels, unknown/empty languages, and special characters without injecting label metadata into attributes.
- [ ] Verify HTML tags/attributes, embedded CSS/JavaScript, multiline comments, and template strings; splitting tool lines preserves token scope.
- [ ] Check behavior at and above 131,072 units; over-budget content remains fully escaped, with unchanged originals for copying/execution.
- [ ] Verify viewer cache isolation by normalized language, prefix context, and rebuilt line indices after edits; preserve LRU/prefetch, virtual rows, and long-line protection.
- [ ] Verify fallback for chunks plus context above 65,536 characters without inferring duration or memory quotas.
- [ ] Manually assess source contrast in each theme; theme changes do not rerun scripts; cards highlight only in code view.
- [ ] Verify shared highlighting does not change Markdown, Mermaid, copy, or original-file-read entry points/content.

The documentation gate is `npm run check:docs`. Highlighting implementation changes still need scoped type/build checks and real UI acceptance; documentation checks cannot substitute for them. This documentation addition creates no tests.
