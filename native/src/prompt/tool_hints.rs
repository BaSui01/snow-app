//! 动态工具提示词片段（2026-09-24）。
//!
//! Plan 模式的「分析阶段工具清单」不再写死在模板里：按当前项目**实际可
//! 调用**的工具在请求构建时动态生成——工具不可用时对应行不出现，绝不
//! 用静态文本诱导模型调用不可见工具（与「注入条件 = 工具可见性」的全局
//! 设计原则一致，见 docs 的 LSP 设计文档 §8.10 / Agent 运行时文档 §5）。
//!
//! 判定来源：
//! - `lsp-*`：`lsp::analysis_tools_line`（域 scope + 服务器 enabled/已安装
//!   + 项目技术栈存在 + 能力并集，与 collect 阶段工具暴露同源）；
//! - `codebase-search`：`is_codebase_available`（项目启用索引且有已嵌入分块）；
//! - `grep-search` / `filesystem-read`：默认启用的只读底行——作为计划阶段的
//!   最低调查手段恒定列出（若用户在项目 scope 中禁用，模型会从工具列表
//!   自行发现，此处保留列出不影响正确性）。

use std::path::Path;

/// 构建 Plan 模式分析工具清单行（Markdown 列表，直接替换模板占位符）。
///
/// 顺序：LSP（条件）→ codebase（条件）→ 恒定只读底行。
pub(crate) async fn build_analysis_tools_lines(
    project_id: Option<&str>,
    project_root: Option<&Path>,
) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();

    // ① LSP 语义工具行：三重条件全部满足（项目启用 builtin:lsp + 服务器可用
    //    且已安装 + 项目内存在该语言的技术栈标志）才出现。
    let lsp_line = crate::mcp::servers::lsp::analysis_tools_line(project_id, project_root).await;
    let lsp_available = lsp_line.is_some();
    if let Some(line) = lsp_line {
        lines.push(line);
    }

    // ② codebase 索引搜索：项目启用索引且存在已嵌入分块时才暴露。
    if crate::mcp::tools::is_codebase_available(project_id)
        .await
        .unwrap_or(false)
    {
        lines.push(
            "- `codebase-search` - Concept-level semantic search over the project index (\"where is X implemented\" style; not symbol-accurate)".to_string(),
        );
    }

    // ③ 恒定只读底行：LSP 可用时明确「回落边界」——语义问题先走上面的 lsp-*，
    //    grep 只承接字面文本（2026-09-25 优先级强化，与 Language Servers 章节
    //    的 Routing rules 同一措辞方向）；LSP 不可用时保持通用描述。
    lines.push(if lsp_available {
        "- `grep-search` - Literal strings/patterns ONLY (log text, config keys, comments, string constants); it cannot tell a real reference from a same-named symbol".to_string()
    } else {
        "- `grep-search` - Search file contents by pattern (regex or literal), with file glob filtering".to_string()
    });
    lines.push("- `filesystem-read` - Read current code to understand implementation".to_string());

    lines
}
