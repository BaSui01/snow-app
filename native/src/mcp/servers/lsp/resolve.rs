//! 符号名直接寻址引擎（Symbol Address Resolver）。
//!
//! 允许 Agent 直接以 `symbol: "foo"` 替代传统的 `(line, column)` 物理坐标寻址：
//! 1. 单文件快速通道：优先通过 `documentSymbol` 在当前文件 AST 中递归匹配；
//!    若唯一命中，短路直达目标行列；
//! 2. 工作区全局通道：单文件未命中时，通过 `workspace/symbol` 在工程中搜索同名符号；
//! 3. 歧义安全保障：多重命中时，并发提取各候选的源码切片并返回 `ambiguous_symbol` 结构，
//!    拒绝臆造和静默猜选，由 Agent 精准指定行号。

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::capabilities::lang_supports_tool;
use super::detect;
use super::manager::ServerManager;
use super::session::{read_line_context, ServerSession};
use super::types::{LspError, ServerConfig};

/// 符号定位候选项（多重命中时回显）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolCandidate {
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    pub preview: String,
}

/// 符号解析结果目标
pub enum ResolvedTarget {
    /// 唯一精准解析出的物理位置
    Exact {
        path: PathBuf,
        line: u32,
        column: u32,
    },
    /// 歧义响应卡片数据（直接返回给客户端）
    Ambiguous(Value),
}

/// 工作区全局符号解析结果目标（无 filePath 时）
pub enum GlobalResolvedTarget {
    /// 唯一精准解析出的物理位置与所属语言
    Exact {
        path: PathBuf,
        line: u32,
        column: u32,
        lang: String,
    },
    /// 歧义响应卡片数据（直接返回给客户端）
    Ambiguous(Value),
}

/// 解析目标符号的位置，若已提供有效坐标 (line, column) 则直接透传
pub async fn resolve_symbol_or_coords(
    session: &mut ServerSession,
    file_path: &Path,
    args: &Value,
) -> Result<ResolvedTarget, LspError> {
    // 1. 若显式提供了 line 和 column，以物理坐标为最高优先级
    let has_line = args.get("line").and_then(Value::as_u64);
    let has_col = args.get("column").and_then(Value::as_u64);

    if let (Some(l), Some(c)) = (has_line, has_col) {
        if l > 0 && c > 0 {
            return Ok(ResolvedTarget::Exact {
                path: file_path.to_path_buf(),
                line: l as u32,
                column: c as u32,
            });
        }
    }

    // 2. 检查是否提供了 symbol 参数
    let symbol_opt = args
        .get("symbol")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let Some(symbol) = symbol_opt else {
        return Err(LspError::Internal(
            "Missing addressing parameters: provide either (line, column) or symbol.".to_string(),
        ));
    };

    // 3. 执行两级推测式符号查找
    // 第一级：单文件 documentSymbol
    let doc_symbols_val = session.document_symbols(file_path).await?;
    let mut local_matches = Vec::new();
    collect_matching_document_symbols(&doc_symbols_val["symbols"], symbol, &mut local_matches);

    if local_matches.len() == 1 {
        let m = &local_matches[0];
        return Ok(ResolvedTarget::Exact {
            path: file_path.to_path_buf(),
            line: m.line,
            column: m.column,
        });
    }

    if local_matches.len() > 1 {
        // 单文件内多重匹配（如重载、同名字段），并发提取源码行
        let mut candidates = Vec::new();
        for m in local_matches {
            let preview = read_line_context(file_path, m.line.saturating_sub(1)).await;
            candidates.push(SymbolCandidate {
                file_path: file_path.to_string_lossy().to_string(),
                line: m.line,
                column: m.column,
                kind: m.kind,
                container: m.container,
                preview,
            });
        }
        return Ok(ResolvedTarget::Ambiguous(json!({
            "status": "ambiguous_symbol",
            "symbol": symbol,
            "count": candidates.len(),
            "message": format!(
                "Found {} symbols named '{}' in {}. Please re-call using (line, column) from the candidates below:",
                candidates.len(),
                symbol,
                file_path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
            ),
            "candidates": candidates
        })));
    }

    // 第二级：单文件未匹配，工作区全局查询 workspace/symbol
    let ws_symbols_val = session.workspace_symbols(symbol).await?;
    let empty_vec = Vec::new();
    let ws_symbols = ws_symbols_val
        .get("symbols")
        .and_then(Value::as_array)
        .unwrap_or(&empty_vec);

    let mut ws_matches: Vec<(String, u32, u32, String, Option<String>)> = Vec::new();
    for item in ws_symbols {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if name == symbol {
            let fp = item.get("filePath").and_then(Value::as_str).unwrap_or("");
            if fp.trim().is_empty() {
                continue;
            }
            let line = item.get("line").and_then(Value::as_u64).unwrap_or(1) as u32;
            let col = item.get("column").and_then(Value::as_u64).unwrap_or(1) as u32;
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or("unknown").to_string();
            let detail = item.get("detail").and_then(Value::as_str).map(|s| s.to_string());
            ws_matches.push((fp.to_string(), line, col, kind, detail));
        }
    }

    if ws_matches.len() == 1 {
        let (fp, line, col, _kind, _detail) = &ws_matches[0];
        return Ok(ResolvedTarget::Exact {
            path: PathBuf::from(fp),
            line: *line,
            column: *col,
        });
    }

    if ws_matches.len() > 1 {
        let mut candidates = Vec::new();
        for (fp, line, col, kind, container) in ws_matches {
            let p = PathBuf::from(&fp);
            let preview = read_line_context(&p, line.saturating_sub(1)).await;
            candidates.push(SymbolCandidate {
                file_path: fp,
                line,
                column: col,
                kind,
                container,
                preview,
            });
        }
        return Ok(ResolvedTarget::Ambiguous(json!({
            "status": "ambiguous_symbol",
            "symbol": symbol,
            "count": candidates.len(),
            "message": format!(
                "Found {} symbols named '{}' across the project workspace. Please re-call using (line, column) and filePath from the candidates below:",
                candidates.len(),
                symbol
            ),
            "candidates": candidates
        })));
    }

    // 两级均未命中
    Err(LspError::Internal(format!(
        "Symbol '{}' not found in '{}' or the project workspace. Check the spelling or use lsp-workspace-symbols to search across the project.",
        symbol,
        file_path.display()
    )))
}

struct MatchItem {
    line: u32,
    column: u32,
    kind: String,
    container: Option<String>,
}

fn collect_matching_document_symbols(
    symbols_val: &Value,
    target_symbol: &str,
    out: &mut Vec<MatchItem>,
) {
    let Some(arr) = symbols_val.as_array() else {
        return;
    };
    for item in arr {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if name == target_symbol {
            // 优先 selection.start，其次 range.start
            let pos = item
                .get("selection")
                .and_then(|s| s.get("start"))
                .or_else(|| item.get("range").and_then(|r| r.get("start")));
            if let Some(p) = pos {
                let line = p.get("line").and_then(Value::as_u64).unwrap_or(1) as u32;
                let column = p.get("column").and_then(Value::as_u64).unwrap_or(1) as u32;
                let kind = item.get("kind").and_then(Value::as_str).unwrap_or("unknown").to_string();
                let detail = item.get("detail").and_then(Value::as_str).map(|s| s.to_string());
                out.push(MatchItem {
                    line,
                    column,
                    kind,
                    container: detail,
                });
            }
        }
        // 递归 children 节点
        if let Some(children) = item.get("children") {
            collect_matching_document_symbols(children, target_symbol, out);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkspaceSymbolMatch {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub kind: String,
    pub container: Option<String>,
    pub lang: String,
}

pub(crate) fn collect_matching_workspace_symbols(
    symbols_val: &Value,
    target_symbol: &str,
    lang: &str,
    root: Option<&Path>,
    seen: &mut std::collections::HashSet<(String, u32, u32)>,
    out: &mut Vec<WorkspaceSymbolMatch>,
) {
    let empty_vec = Vec::new();
    let symbols = symbols_val
        .get("symbols")
        .and_then(Value::as_array)
        .or_else(|| symbols_val.as_array())
        .unwrap_or(&empty_vec);

    for item in symbols {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        if name == target_symbol {
            let fp_raw = item.get("filePath").and_then(Value::as_str).unwrap_or("");
            if fp_raw.trim().is_empty() {
                continue;
            }
            let fp = if let Some(base_root) = root {
                let p = Path::new(fp_raw);
                if p.is_relative() {
                    base_root.join(p).to_string_lossy().to_string()
                } else {
                    fp_raw.to_string()
                }
            } else {
                fp_raw.to_string()
            };
            let line = item.get("line").and_then(Value::as_u64).unwrap_or(1) as u32;
            let col = item.get("column").and_then(Value::as_u64).unwrap_or(1) as u32;
            let key = (fp.clone(), line, col);
            if !seen.insert(key) {
                continue;
            }
            let kind = item
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let detail = item.get("detail").and_then(Value::as_str).map(|s| s.to_string());
            out.push(WorkspaceSymbolMatch {
                file_path: fp,
                line,
                column: col,
                kind,
                container: detail,
                lang: lang.to_string(),
            });
        }
    }
}

/// 工作区全局符号查找（当调用方未提供 filePath 时）：
/// 跨当前工程所有可用且支持 workspace-symbols 的技术栈服务器查询，
/// 单一命中时直接解析物理位置与所属语言；多重命中时返回 Ambiguous 卡片；零命中报错。
pub async fn resolve_symbol_workspace_global(
    manager: &ServerManager,
    configs: &[ServerConfig],
    project_id: Option<&str>,
    symbol: &str,
) -> Result<GlobalResolvedTarget, LspError> {
    let project_root = match project_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(pid) => {
            let storage_info = crate::storage::initialize_app_storage()
                .map_err(|e| LspError::Internal(e.to_string()))?;
            let database_path = PathBuf::from(storage_info.database_path);
            match crate::storage::services::workspace_directories::get_workspace_directory_path(
                &database_path,
                pid,
            ) {
                Ok(Some(root)) => PathBuf::from(root),
                _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            }
        }
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    };

    let targets: Vec<&ServerConfig> = configs
        .iter()
        .filter(|config| {
            config.enabled
                && lang_supports_tool(&config.lang, "workspace-symbols")
                && super::config::is_command_installed_cached(&config.command)
        })
        .collect();

    if targets.is_empty() {
        return Err(LspError::CapabilityNotSupported(
            "none".into(),
            "workspace-symbols".into(),
        ));
    }

    let mut all_matches: Vec<WorkspaceSymbolMatch> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for config in targets {
        let Some(lang_root) = detect::find_lang_root(&project_root, None, &config.lang) else {
            continue;
        };
        let session = match manager
            .get_or_start(&config.lang, &lang_root, project_id)
            .await
        {
            Ok(s) => s,
            Err(_) => continue,
        };
        let ws_symbols_val = match session.lock().await.workspace_symbols(symbol).await {
            Ok(v) => v,
            Err(_) => continue,
        };
        collect_matching_workspace_symbols(
            &ws_symbols_val,
            symbol,
            &config.lang,
            Some(&lang_root),
            &mut seen,
            &mut all_matches,
        );
    }

    if all_matches.len() == 1 {
        let m = all_matches.remove(0);
        return Ok(GlobalResolvedTarget::Exact {
            path: PathBuf::from(m.file_path),
            line: m.line,
            column: m.column,
            lang: m.lang,
        });
    }

    if all_matches.len() > 1 {
        let mut candidates = Vec::new();
        for m in all_matches {
            let p = PathBuf::from(&m.file_path);
            let preview = read_line_context(&p, m.line.saturating_sub(1)).await;
            candidates.push(SymbolCandidate {
                file_path: m.file_path,
                line: m.line,
                column: m.column,
                kind: m.kind,
                container: m.container,
                preview,
            });
        }
        return Ok(GlobalResolvedTarget::Ambiguous(json!({
            "status": "ambiguous_symbol",
            "symbol": symbol,
            "count": candidates.len(),
            "message": format!(
                "Found {} symbols named '{}' across the project workspace. Please re-call using (line, column) and filePath from the candidates below:",
                candidates.len(),
                symbol
            ),
            "candidates": candidates
        })));
    }

    Err(LspError::Internal(format!(
        "Symbol '{}' not found across the project workspace. Check the spelling or use lsp-workspace-symbols to search across the project.",
        symbol
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collect_matching_document_symbols_nested() {
        let json_tree = json!([
            {
                "name": "OuterClass",
                "kind": "class",
                "selection": { "start": { "line": 10, "column": 5 } },
                "children": [
                    {
                        "name": "target_fn",
                        "kind": "method",
                        "detail": "OuterClass",
                        "selection": { "start": { "line": 15, "column": 9 } },
                        "children": null
                    },
                    {
                        "name": "other_fn",
                        "kind": "method",
                        "selection": { "start": { "line": 20, "column": 9 } },
                        "children": null
                    }
                ]
            },
            {
                "name": "target_fn",
                "kind": "function",
                "detail": "global",
                "selection": { "start": { "line": 35, "column": 1 } },
                "children": null
            }
        ]);

        let mut matches = Vec::new();
        collect_matching_document_symbols(&json_tree, "target_fn", &mut matches);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].line, 15);
        assert_eq!(matches[0].column, 9);
        assert_eq!(matches[0].container.as_deref(), Some("OuterClass"));
        assert_eq!(matches[1].line, 35);
        assert_eq!(matches[1].column, 1);

        let mut single_matches = Vec::new();
        collect_matching_document_symbols(&json_tree, "OuterClass", &mut single_matches);
        assert_eq!(single_matches.len(), 1);
        assert_eq!(single_matches[0].line, 10);
        assert_eq!(single_matches[0].column, 5);

        let mut zero_matches = Vec::new();
        collect_matching_document_symbols(&json_tree, "non_existent", &mut zero_matches);
        assert_eq!(zero_matches.len(), 0);
    }

    #[test]
    fn test_collect_matching_flat_symbols_range_fallback() {
        let json_flat = json!([
            {
                "name": "my_var",
                "kind": "variable",
                "range": { "start": { "line": 42, "column": 7 } }
            }
        ]);
        let mut matches = Vec::new();
        collect_matching_document_symbols(&json_flat, "my_var", &mut matches);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 42);
        assert_eq!(matches[0].column, 7);
    }

    #[test]
    fn test_collect_matching_workspace_symbols() {
        let ws_payload = json!({
            "symbols": [
                {
                    "name": "GlobalSymbol",
                    "filePath": "/path/to/file_a.rs",
                    "line": 12,
                    "column": 4,
                    "kind": "struct",
                    "detail": "crate::foo"
                },
                {
                    "name": "OtherSymbol",
                    "filePath": "/path/to/file_b.rs",
                    "line": 20,
                    "column": 1,
                    "kind": "function"
                },
                {
                    "name": "GlobalSymbol",
                    "filePath": "/path/to/file_a.rs",
                    "line": 12,
                    "column": 4,
                    "kind": "struct",
                    "detail": "crate::foo"
                },
                {
                    "name": "GlobalSymbol",
                    "filePath": "",
                    "line": 5,
                    "column": 1
                }
            ]
        });

        let mut seen = std::collections::HashSet::new();
        let mut matches = Vec::new();
        collect_matching_workspace_symbols(
            &ws_payload,
            "GlobalSymbol",
            "rust",
            None,
            &mut seen,
            &mut matches,
        );

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].file_path, "/path/to/file_a.rs");
        assert_eq!(matches[0].line, 12);
        assert_eq!(matches[0].column, 4);
        assert_eq!(matches[0].kind, "struct");
        assert_eq!(matches[0].lang, "rust");

        // 测试相对路径自动结合 root 转为绝对路径
        let ws_relative_payload = json!({
            "symbols": [
                {
                    "name": "RelativeSymbol",
                    "filePath": "src/sub/mod.rs",
                    "line": 5,
                    "column": 1
                }
            ]
        });
        let base_root = PathBuf::from("/workspace/root");
        let mut rel_matches = Vec::new();
        let mut rel_seen = std::collections::HashSet::new();
        collect_matching_workspace_symbols(
            &ws_relative_payload,
            "RelativeSymbol",
            "rust",
            Some(&base_root),
            &mut rel_seen,
            &mut rel_matches,
        );
        assert_eq!(rel_matches.len(), 1);
        assert!(rel_matches[0].file_path.contains("src"));
        assert!(rel_matches[0].file_path.contains("workspace"));
    }
}
