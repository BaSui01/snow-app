//! 语言服务器静态能力表（§8.7 / 附录 F：12 语言 × LSP 能力，2026-08-14 官方文档核实）。
//!
//! collect 阶段用它过滤 `lsp-*` 工具：用户启用了哪些语言的服务器，就暴露
//! 这些服务器实际支持的工具子集（能力并集）。⚠️/🔒 能力按「不支持」处理
//! （§8.7.3 维护约定），避免暴露必然失败的调用。

/// 全部服务器都支持的核心工具（附录 F 底部行：诊断/hover/跳转/引用/大纲）。
/// format 已移除（2026-08-14 工具精简，见下方注释）。
/// definition 合并进 goto（2026-08-16 工具精简：lsp-goto{kind} 统一跳转
/// 入口，kind=definition 全语言支持）。
pub const CORE_TOOLS: &[&str] = &[
    "diagnostics",
    "hover",
    "goto",
    "references",
    "symbols",
];

/// lang → 核心工具之外额外支持的工具（工具名与 `tool_schemas()` 的 name 一致）。
///
/// 2026-08-16 工具精简后：`type-definition` / `implementation` 不再有独立
/// schema（已合并进 `lsp-goto{kind}`），此处保留作为 **goto kind 能力标记**
/// ——`execute_goto` 运行时校验 kind 用（lang_supports_tool），collect 过滤
/// 时 schema 中不存在对应工具名，天然不会暴露。维护约定：新增语言时
/// 若其支持 type-definition / implementation，仍需在此标记。
///
/// 依据（附录 F-1 矩阵，2026-08-14 官方文档核实；2026-08-14 工具精简后更新；
/// 2026-08-15 hierarchy 工具加入后按服务器源码复核；2026-08-15 Phase 5.5
/// code-action 恢复 + execute-command 加入）：
/// - 全功能型（rename/type-definition/implementation/workspace-symbols 全支持）：
///   typescript / python / go / rust / c(clangd) / java
/// - workspace-diagnostics（LSP 3.17 workspace/diagnostic pull）：rust-analyzer /
///   gopls / clangd 支持；typescript-language-server / pyright 不支持
/// - call-hierarchy（LSP 3.16）：typescript-language-server（TS ≥ 3.80，源码
///   lsp-server.ts 核实）/ gopls / rust-analyzer / jdtls / sourcekit-lsp 支持；
///   pyright / clangd / csharp-ls / kotlin-lsp / lua-ls 不支持；intelephense 🔒；
///   ruby-lsp ⚠️（部分）
/// - type-hierarchy（LSP 3.17）：gopls（features 文档核实）/ jdtls（InitHandler
///   源码核实）支持；rust-analyzer / tsserver / pyright / clangd 等不支持
/// - code-action（2026-08-15 Phase 5.5 恢复，agent 修复/重构场景）：附录 F 矩阵
///   ✅ 的语言（typescript/python/go/rust/c/java/ruby）标记；csharp ⚠️、swift ⚠️、
///   lua ⚠️、kotlin ❌、php 🔒 不标记
/// - execute-command（workspace/executeCommand）：rust-analyzer（applySourceChange
///   依赖此通道）与 gopls（add_import/extract_* 等）2026-08-15 实测核实；
///   其他语言待核实后补充
/// - swift（sourcekit-lsp）：rename + type-definition + workspace-symbols + call-hierarchy
/// - kotlin：workspace-symbols（rename/code-action/type-definition/implementation 不支持）
/// - php（intelephense）：workspace-symbols（rename/code-action 等 🔒 付费墙）
/// - ruby（ruby-lsp）：workspace-symbols
/// - csharp（csharp-ls）：仅核心工具
/// - lua（lua-language-server）：rename + workspace-symbols
/// - 已移除（2026-08-14 用户决策，agent 场景低价值）：completion / signature-help /
///   format——LLM 本身即补全器，编辑器光标向工具无增量价值；相关实现已删除。
fn extra_tools_for_lang(lang: &str) -> &'static [&'static str] {
    match lang {
        // tsserver（TS ≥ 3.80）支持 call-hierarchy；type-hierarchy 不支持。
        "typescript" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "call-hierarchy",
            "code-action",
        ],
        "python" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "code-action",
        ],
        // jdtls：call + type hierarchy 双支持（InitHandler 源码核实）。
        "java" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "call-hierarchy",
            "type-hierarchy",
            "code-action",
        ],
        // rust-analyzer / gopls / clangd 支持 LSP 3.17 workspace/diagnostic(pull);
        // typescript-language-server / pyright 不支持 → 不标记。
        // gopls：call + type hierarchy 双支持（features 文档核实）；
        // rust-analyzer：仅 call-hierarchy（capabilities.rs 源码核实，
        //   type_hierarchy_provider = None）；clangd：两者都不支持。
        // vulncheck（2026-08-16）：go 专属依赖漏洞扫描——复用官方 govulncheck
        //   二进制（gopls MCP go_vulncheck 同款机制：-json -mode source -scan
        //   symbol），非 LSP 请求；仅 go 标记。
        "go" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "workspace-diagnostics",
            "call-hierarchy",
            "type-hierarchy",
            "code-action",
            "execute-command",
            "vulncheck",
        ],
        "rust" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "workspace-diagnostics",
            "call-hierarchy",
            "code-action",
            "execute-command",
        ],
        "c" => &[
            "rename",
            "type-definition",
            "implementation",
            "workspace-symbols",
            "workspace-diagnostics",
            "code-action",
        ],
        "swift" => &[
            "rename",
            "type-definition",
            "workspace-symbols",
            "call-hierarchy",
        ],
        "kotlin" | "php" => &["workspace-symbols"],
        "ruby" => &["workspace-symbols", "code-action"],
        "csharp" => &[],
        "lua" => &["rename", "workspace-symbols"],
        _ => &[],
    }
}

/// 某语言服务器支持的工具名集合（不含 `lsp-` 前缀）。
pub fn supported_tools_for_lang(lang: &str) -> Vec<&'static str> {
    let mut tools = CORE_TOOLS.to_vec();
    tools.extend(extra_tools_for_lang(lang));
    tools
}

/// 某语言服务器是否支持指定工具（运行时二次校验，§8.7.1）。
pub fn lang_supports_tool(lang: &str, tool_name: &str) -> bool {
    supported_tools_for_lang(lang).contains(&tool_name)
}
