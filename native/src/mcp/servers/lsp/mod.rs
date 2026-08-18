//! LSP MCP service — external language-server integration.
//!
//! Consumes the `lsp_server_configs` table and drives external language
//! servers (rust-analyzer / gopls / pyright ...) over LSP stdio.
//!
//! Tools:
//! - `lsp-diagnostics`: per-file diagnostics (pull-first, push fallback)
//! - `lsp-hover`: symbol hover info as Markdown
//! - `lsp-goto` / `lsp-references` / `lsp-symbols`:
//!   semantic navigation (Phase 3; definition/type-definition/implementation
//!   merged into lsp-goto{kind} in the 2026-08-16 tool trim)
//!
//! Tools are OFF by default (§8.0): `collect_all_mcp_tools` filters them out
//! unless the table has at least one enabled server.
//!
//! Design: docs/zh-CN/4-架构与开发/7-LSP外部语言服务器接入设计.md

pub(crate) mod capabilities;
mod client;
mod config;
pub(crate) mod detect; // crate 内共享（exports 层 napi 导出「检测技术栈」）
mod format;
pub(crate) mod manager; // crate 内共享（exports 层 napi 导出会话状态快照）
pub(crate) mod probe; // crate 内共享（storage 种子/迁移/校正也要探测，§8.6）
mod session;
mod types;

pub use config::tool_exposure;
pub use probe::{probe_commands, ProbeResult};

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;
use super::remote_workspace::is_ssh_path;
use session::{PendingDiagnostics, PrepareResult, ServerSession};
use types::ServerConfig;
use crate::storage::services::workspace_directories::get_workspace_directory_path;

const SERVER_ID: &str = "lsp";

/// 工具 schema（恒定；暴露与否由 collect 阶段按表配置过滤，§8.0）。
fn tool_schemas() -> Vec<McpTool> {
    vec![
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "diagnostics".to_string(),
            description: "Check code for compile errors/warnings using the configured language server — far more accurate than reading source manually. Use after any edit to verify code is correct.\n\n- filePath: single file; filePaths: batch of up to 30 (mutually exclusive).\n- Returns per-file errors/warnings with severity, message, source, code and precise line/column positions.\n- Only languages with an enabled server are checked.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Absolute path to the source file to diagnose (mutually exclusive with filePaths; omit instead of sending an empty value)."
                    },
                    "filePaths": {
                        "type": "array",
                        "minItems": 1,
                        "items": { "type": "string", "minLength": 1 },
                        "description": "Absolute paths to up to 30 source files to diagnose in one batch (mutually exclusive with filePath)."
                    }
                }
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "hover".to_string(),
            description: "Get the exact type signature and doc comment of a symbol at a position. Use to understand an identifier or an unknown API without reading its implementation.\n\n- Position is 1-indexed (line, column).\n- Returns Markdown contents (type info + doc comment).\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "goto".to_string(),
            description: "Jump to a symbol at a position with one of three navigation kinds: kind=definition (default; the declaration — cross-file, resolution-accurate; imports/generics/traits/stdlib & dependency sources), kind=type-definition (the type's definition), kind=implementation (all implementations of an interface/abstract class/trait).\n\n- Returns target file/line/column(s).\n- type-definition / implementation are only supported by servers that declare those capabilities.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["definition", "type-definition", "implementation"],
                        "description": "Navigation kind (default \"definition\")."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "references".to_string(),
            description: "Find all references to a symbol at a position (declaration included by default; pass includeDeclaration=false to exclude it).\n\nUse to assess the impact of renaming or changing a symbol. Each reference carries its one-line code context.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    },
                    "includeDeclaration": {
                        "type": "boolean",
                        "description": "Whether to include the declaration itself (default true)."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "symbols".to_string(),
            description: "Get a file's symbol outline from the language server — semantic, more accurate than tree-sitter: includes nested children, types and visibility via detail. Use to quickly understand a file's structure before reading it.\n\nReturns a nested tree of symbols with name, kind, detail, range and children.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    }
                },
                "required": ["filePath"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "rename".to_string(),
            description: "Rename a symbol at a position across the whole project (textDocument/rename, WorkspaceEdit).\n\n- dryRun=true (default): previews the multi-file edit list without writing.\n- dryRun=false: applies the edits to disk.\n- Use after locating the symbol with lsp-goto / lsp-references.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    },
                    "newName": {
                        "type": "string",
                        "description": "The new symbol name."
                    },
                    "dryRun": {
                        "type": "boolean",
                        "description": "Only return the WorkspaceEdit description without writing files (default true)."
                    }
                },
                "required": ["filePath", "line", "column", "newName"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "code-action".to_string(),
            description: "List or apply code actions (quick fixes / refactorings) at a position. Use to auto-fix lint errors or apply safe refactorings.\n\n- only: optional CodeActionKind filter, e.g. [\"quickfix\"] or [\"refactor.extract\"].\n- apply=true: applies edit-based actions.\n- Command-based actions are NEVER executed implicitly — they are listed in deferredCommands; copy their command/arguments into lsp-execute-command to run.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    },
                    "only": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional CodeActionKind filter, e.g. [\"quickfix\"] or [\"refactor.extract\"]."
                    },
                    "apply": {
                        "type": "boolean",
                        "description": "Apply edit-based actions (default false; command-based actions are listed as deferred, never executed implicitly)."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "execute-command".to_string(),
            description: "Execute a language-server-defined command (workspace/executeCommand) — refactorings, import management, SSR, etc.\n\n- Command names and arguments are server-private: copy them verbatim from the command/arguments fields of an lsp-code-action result (e.g. rust-analyzer.applySourceChange).\n- dryRun=true (default): previews multi-file edits; dryRun=false applies them to disk.\n- filePath is optional when exactly one server is enabled; pass it to target a specific language.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Server command name, e.g. \"rust-analyzer.applySourceChange\" or \"gopls.add_import\"."
                    },
                    "arguments": {
                        "type": "array",
                        "description": "Server-private command arguments (JSON array; copy from an lsp-code-action result)."
                    },
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to a source file of the target language (optional when only one server is enabled)."
                    },
                    "dryRun": {
                        "type": "boolean",
                        "description": "Only preview a WorkspaceEdit result without writing (default true)."
                    }
                },
                "required": ["command"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "call-hierarchy".to_string(),
            description: "Get the full call graph around a function/method at a position:\n- incoming: which functions call it (caller + call-site line context)\n- outgoing: what it calls (callee + call-site context)\n\nUse for impact analysis — one call replaces many lsp-references queries.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "type-hierarchy".to_string(),
            description: "Get the type hierarchy around a type at a position:\n- supertypes: parent types (base classes / interfaces / traits)\n- subtypes: all child types (subclasses / implementors)\n\nUse to assess the blast radius of refactoring a base type.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path to the source file."
                    },
                    "line": {
                        "type": "number",
                        "description": "1-indexed line number."
                    },
                    "column": {
                        "type": "number",
                        "description": "1-indexed column number (character offset within the line)."
                    }
                },
                "required": ["filePath", "line", "column"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "workspace-symbols".to_string(),
            description: "Fuzzy-search symbols by name across the whole project (workspace/symbol) — semantic, no false positives from strings/comments. Use to locate a symbol you know by name, or to discover related symbols.\n\nReturns up to 50 symbols with kind, container and precise file/line/column. Case-insensitive fuzzy matching.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Symbol name (or fuzzy fragment) to search for, e.g. \"parseConfig\" or \"Config\". Case-insensitive fuzzy matching."
                    }
                },
                "required": ["query"]
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "workspace-diagnostics".to_string(),
            description: "Get project-wide errors/warnings in one call (workspace/diagnostic pull), grouped by file with per-file summary. Use to survey the whole project after a refactor or before reporting it clean.\n\n- Queries every enabled server that supports workspace diagnostics; servers without the capability are skipped with warnings.\n- First call on rust-analyzer may take 10-30s; subsequent calls are incremental.\n- Output capped at maxFiles (default 100, max 200) files x 200 diagnostics per file.\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "maxFiles": {
                        "type": "number",
                        "description": "Optional cap on files returned (default 100, max 200)."
                    }
                }
            }),
        },
        McpTool {
            server_id: SERVER_ID.to_string(),
            name: "vulncheck".to_string(),
            description: "Scan a Go module for known vulnerabilities in dependencies (drives the official govulncheck binary: -json -mode source -scan symbol). Run after adding/updating go.mod dependencies.\n\n- dir defaults to the project root; pattern defaults to \"./...\".\n- Returns findings grouped by advisory ID with affected packages.\n- Requires govulncheck in PATH (install: go install golang.org/x/vuln/cmd/govulncheck@latest) and a local Go project.\n- First run may take a while (vulnerability database download).\n\nLocal projects only.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "dir": {
                        "type": "string",
                        "description": "Optional directory to run the vulnerability check within (defaults to the project root)."
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Optional package pattern to check (default \"./...\")."
                    }
                }
            }),
        },
    ]
}

pub struct LspService;

#[derive(Debug, PartialEq, Eq)]
enum DiagnosticsTarget {
    Single(String),
    Batch(Vec<String>),
}

/// 归一化 lsp-diagnostics 的单文件/批量路径参数。
///
/// 某些兼容调用方会在批量请求中附带空的 `filePath` 占位值；空值
/// 必须视为未提供，否则会抢先进入单文件分支并按空扩展名匹配语言。
fn parse_diagnostics_target(args: &Value) -> napi::Result<DiagnosticsTarget> {
    let file_path = args
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(str::to_string);
    let file_paths: Vec<String> = args
        .get("filePaths")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|path| !path.trim().is_empty())
                .take(30)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    match (file_path, file_paths) {
        (Some(single), _) => Ok(DiagnosticsTarget::Single(single)),
        (None, paths) if !paths.is_empty() => Ok(DiagnosticsTarget::Batch(paths)),
        _ => Err(Error::new(
            Status::InvalidArg,
            "lsp-diagnostics requires either filePath or filePaths (non-empty array)",
        )),
    }
}

impl LspService {
    pub fn new() -> Self {
        LspService
    }

    /// 异步执行入口（call.rs 的 `lsp-` 前缀分支分发）。
    pub async fn execute_lsp_tool(
        &self,
        tool_name: &str,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        match tool_name {
            "diagnostics" => self.execute_diagnostics(args, project_id).await,
            "hover" => self.execute_hover(args, project_id).await,
            "goto" => self.execute_goto(args, project_id).await,
            "references" => self.execute_references(args, project_id).await,
            "symbols" => self.execute_symbols(args, project_id).await,
            "rename" => self.execute_rename(args, project_id).await,
            "code-action" => self.execute_code_action(args, project_id).await,
            "execute-command" => self.execute_execute_command(args, project_id).await,
            "call-hierarchy" => self.execute_call_hierarchy(args, project_id).await,
            "type-hierarchy" => self.execute_type_hierarchy(args, project_id).await,
            "workspace-symbols" => self.execute_workspace_symbols(args, project_id).await,
            "workspace-diagnostics" => self.execute_workspace_diagnostics(args, project_id).await,
            "vulncheck" => self.execute_vulncheck(args, project_id).await,
            _ => Err(Error::new(
                Status::GenericFailure,
                format!(
                    "Unknown lsp tool: \"{tool_name}\". Available tools: [diagnostics, hover, goto, references, symbols, rename, code-action, execute-command, call-hierarchy, type-hierarchy, workspace-symbols, workspace-diagnostics, vulncheck]"
                ),
            )),
        }
    }

    /// codelens-* 代码定位工具的 LSP 优先执行（call.rs 的 `codelens-` 分支分发）。
    ///
    /// 项目启用了匹配文件语言的 LSP 服务器（外部命令可用、scope 允许）时，
    /// 优先通过外部 LSP 语义分析执行（跨文件解析准确），并把结果归一化为
    /// codelens 输出格式（前端 CodeLensToolCall 无感，附加 `"engine": "lsp"`
    /// 标记）。归一化映射：
    /// - `codelens-find_definition` → `lsp-goto`（kind=definition）
    /// - `codelens-find_references` → `lsp-references`
    /// - `codelens-file_outline` → `lsp-symbols`
    ///
    /// 返回 `Ok(None)` 表示 LSP 不可用（未配置 / 命令缺失 / 启动失败 /
    /// SSH 远程 / scope 禁用 / 参数缺失），调用方应回退到 CodeLensService
    /// 的 tree-sitter 静态分析——LSP 只是更优路径，不应阻断代码定位。
    pub async fn execute_codelens_preferred(
        &self,
        codelens_tool: &str,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Option<Value>> {
        let (lsp_tool, kind) = match codelens_tool {
            "find_definition" => ("goto", Some("definition")),
            "find_references" => ("references", None),
            "file_outline" => ("symbols", None),
            _ => return Ok(None),
        };
        let Some(file_path) = args.get("filePath").and_then(Value::as_str) else {
            return Ok(None);
        };
        // lsp 仅支持本地项目：SSH 远程路径不转发。
        if is_ssh_path(file_path) {
            return Ok(None);
        }
        // 用户显式禁用了 LSP 域（全局黑名单 / 项目 scope）时不转发；
        // scope 查询失败（DB 瞬时故障）同样视为不可用，静默回退静态分析
        //（LSP 只是更优路径，任何 LSP 侧错误都不应阻断代码定位）。
        let scope_allowed = match lsp_tool_scope_allowed(lsp_tool, project_id).await {
            Ok(allowed) => allowed,
            Err(error) => {
                lsp_app_log(
                    "warn",
                    "execute_codelens_preferred",
                    &format!(
                        "codelens-{codelens_tool} LSP scope check failed, falling back to static analysis"
                    ),
                    Some(&error.to_string()),
                )
                .await;
                return Ok(None);
            }
        };
        if !scope_allowed {
            return Ok(None);
        }
        // goto 需要注入 kind 参数（find_definition → kind=definition）。
        let mut effective_args = args.clone();
        if let Some(kind) = kind {
            effective_args["kind"] = json!(kind);
        }
        let result = match self.execute_lsp_tool(lsp_tool, &effective_args, project_id).await {
            Ok(value) => value,
            Err(error) => {
                lsp_app_log(
                    "warn",
                    "execute_codelens_preferred",
                    &format!(
                        "codelens-{codelens_tool} LSP-preferred execution failed, falling back to static analysis"
                    ),
                    Some(&error.to_string()),
                )
                .await;
                return Ok(None);
            }
        };
        let normalized = match lsp_tool {
            "goto" => definition_to_codelens(file_path, result),
            "references" => references_to_codelens(file_path, result),
            _ => symbols_to_codelens(file_path, result),
        };
        Ok(Some(normalized))
    }

    /// lsp-diagnostics（单文件 filePath 或批量 filePaths ≤30，互斥）。
    async fn execute_diagnostics(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        match parse_diagnostics_target(args)? {
            DiagnosticsTarget::Single(single) => self.run_diagnostics(&single, project_id).await,
            DiagnosticsTarget::Batch(paths) => {
                // 批量：配置只加载一次（避免 n 次 reload_configs 的 DB 读），
                // 阶段 1 串行准备（锁内，快：缓存命中直接收结果，未命中收集
                // 待等待）；阶段 2 并发等待（锁外，socket/push store 克隆入 task）；
                // 阶段 3 串行回写 DB 缓存（锁内）。
                let manager = manager::ServerManager::instance();
                manager.reload_configs(project_id).await?;
                let configs = manager.configs(project_id).await;

                let mut files: Vec<Value> = Vec::new();
                let mut pending_tasks: Vec<(
                    PathBuf,
                    Arc<tokio::sync::Mutex<ServerSession>>,
                    tokio::task::JoinHandle<std::result::Result<Value, types::LspError>>,
                )> = Vec::new();

                for path in &paths {
                    match self
                        .prepare_single_with_configs(path, project_id, &configs)
                        .await
                    {
                        Ok(Prepared::Cached(mut value)) => {
                            // 附加 filePath（批量输出按文件分组，agent 需要知道每条属于哪个文件）。
                            if let Value::Object(map) = &mut value {
                                map.insert("filePath".to_string(), json!(path));
                            }
                            files.push(value);
                        }
                        Ok(Prepared::Pending { session, pending }) => {
                            let task = session.lock().await.spawn_await_task(&pending);
                            pending_tasks.push((pending.path.clone(), session, task));
                        }
                        // 单文件失败不中断整批：记录错误继续（agent 可一次看到全部问题文件）。
                        Err(error) => {
                            files.push(json!({
                                "filePath": path,
                                "error": error.to_string(),
                            }));
                        }
                    }
                }

                // 并发等待 + 回写缓存（等待重叠：10 文件 ≈ 1 文件耗时）。
                for (path, session, task) in pending_tasks {
                    let result = match task.await {
                        Ok(Ok(mut value)) => {
                            if let Value::Object(map) = &mut value {
                                map.insert("filePath".to_string(), json!(path));
                            }
                            let mut guard = session.lock().await;
                            guard.store_diagnostics(&path, &value).await;
                            Ok(value)
                        }
                        Ok(Err(error)) => Err(error.into()),
                        Err(join_error) => Err(Error::new(
                            Status::GenericFailure,
                            format!("LSP diagnostic task failed: {join_error}"),
                        )),
                    };
                    match result {
                        Ok(value) => files.push(value),
                        Err(error) => {
                            files.push(json!({ "filePath": path, "error": error.to_string() }));
                        }
                    }
                }

                Ok(json!({
                    "batch": true,
                    "fileCount": files.len(),
                    "files": files,
                }))
            }
        }
    }

    /// 单文件诊断（filePath 与 filePaths 批量共用）：准备 → 等待 → 回写缓存。
    async fn run_diagnostics(&self, file_path: &str, project_id: Option<&str>) -> napi::Result<Value> {
        match self.prepare_single(file_path, project_id).await? {
            Prepared::Cached(value) => Ok(value),
            Prepared::Pending { session, pending } => {
                let path = pending.path.clone();
                let task = session.lock().await.spawn_await_task(&pending);
                let awaited: std::result::Result<Value, types::LspError> = task
                    .await
                    .map_err(|error| {
                        Error::new(
                            Status::GenericFailure,
                            format!("LSP diagnostic task failed: {error}"),
                        )
                    })?;
                let value = awaited.map_err(|error| -> napi::Error { error.into() })?;
                let mut guard = session.lock().await;
                guard.store_diagnostics(&path, &value).await;
                Ok(value)
            }
        }
    }

    /// 单文件诊断准备（单文件路径）：reload 配置一次后委托共享实现。
    async fn prepare_single(
        &self,
        file_path: &str,
        project_id: Option<&str>,
    ) -> napi::Result<Prepared> {
        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        self.prepare_single_with_configs(file_path, project_id, &configs)
            .await
    }

    /// 单文件诊断准备（共享实现）：配置匹配 + 会话获取 + 缓存指纹检查 + didChange 触发。
    /// 返回缓存命中（直接结果）或待等待（并发拉取所需信息）。
    /// `configs` 由调用方提供（单文件路径自行 reload 一次；批量路径循环前
    /// 统一加载一次，避免 n 次 DB 读）。
    async fn prepare_single_with_configs(
        &self,
        file_path: &str,
        project_id: Option<&str>,
        configs: &[ServerConfig],
    ) -> napi::Result<Prepared> {
        let path = PathBuf::from(file_path);

        if is_ssh_path(file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let (_config, lang) = config::match_config(configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        let project_root = resolve_project_root(project_id, file_path)?;

        let session = manager::ServerManager::instance()
            .get_or_start(lang, &project_root, project_id)
            .await?;
        let prepare_result = {
            let mut guard = session.lock().await;
            guard.prepare_diagnostics(&path).await?
        };
        match prepare_result {
            PrepareResult::Cached(value) => Ok(Prepared::Cached(value)),
            PrepareResult::Pending(pending) => {
                Ok(Prepared::Pending { session, pending })
            }
        }
    }

    /// lsp-hover。
    async fn execute_hover(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.hover(&path, line, column).await?)
    }

    /// lsp-goto：统一跳转入口（definition / type-definition / implementation）。
    ///
    /// kind 默认 definition（全语言核心）；type-definition / implementation
    /// 按能力表运行时校验（§8.7.1 兜底，能力标记保留在 capabilities.rs）。
    async fn execute_goto(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let kind = args
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("definition")
            .to_string();
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        match kind.as_str() {
            // definition 是核心工具，全语言支持，无需能力校验。
            "definition" => {}
            "type-definition" => ensure_capability(&lang, "type-definition")?,
            "implementation" => ensure_capability(&lang, "implementation")?,
            _ => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "Unknown goto kind: \"{kind}\". Available kinds: [definition, type-definition, implementation]"
                    ),
                ))
            }
        }
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        match kind.as_str() {
            "definition" => Ok(guard.goto_definition(&path, line, column).await?),
            "type-definition" => Ok(guard.type_definition(&path, line, column).await?),
            _ => Ok(guard.implementation(&path, line, column).await?),
        }
    }

    /// lsp-references。
    async fn execute_references(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let include_declaration = args
            .get("includeDeclaration")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.references(&path, line, column, include_declaration).await?)
    }

    /// lsp-symbols。
    async fn execute_symbols(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.document_symbols(&path).await?)
    }

    /// lsp-rename。
    async fn execute_rename(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let new_name = required_string(args, "newName")?;
        let dry_run = args
            .get("dryRun")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        ensure_capability(&lang, "rename")?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.rename(&path, line, column, &new_name, dry_run).await?)
    }

    /// lsp-code-action。
    async fn execute_code_action(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let only: Option<Vec<String>> = args
            .get("only")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect()
            });
        let apply = args
            .get("apply")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        ensure_capability(&lang, "code-action")?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        let kinds = only.map(|items| {
            items
                .iter()
                .map(|kind| lsp_types::CodeActionKind::from(kind.clone()))
                .collect::<Vec<_>>()
        });
        Ok(guard.code_actions(&path, line, column, kinds, apply).await?)
    }

    /// lsp-execute-command（workspace/executeCommand：服务器重构/导入等命令）。
    ///
    /// filePath 可选：提供时按文件匹配语言；缺省时要求恰好一个启用服务器。
    async fn execute_execute_command(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        let command = required_string(args, "command")?;
        if command.trim().is_empty() {
            return Err(Error::new(Status::InvalidArg, "command must not be empty"));
        }
        let arguments: Vec<Value> = args
            .get("arguments")
            .and_then(Value::as_array)
            .map(|items| items.iter().cloned().collect())
            .unwrap_or_default();
        let dry_run = args
            .get("dryRun")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let file_path = args.get("filePath").and_then(Value::as_str).map(str::to_string);

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;

        // 确定目标语言与会话：filePath 优先；缺省时仅当恰好一个启用服务器。
        let (lang, project_root) = match &file_path {
            Some(fp) => {
                if is_ssh_path(fp) {
                    return Err(types::LspError::RemoteNotSupported.into());
                }
                let path = PathBuf::from(fp);
                let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
                    types::LspError::NotConfigured(file_extension_label(&path))
                })?;
                ensure_capability(&lang, "execute-command")?;
                let root = resolve_project_root(project_id, fp)?;
                (lang.to_string(), root)
            }
            None => {
                let enabled: Vec<&types::ServerConfig> = configs.iter().filter(|c| c.enabled).collect();
                if enabled.len() != 1 {
                    return Err(Error::new(
                        Status::InvalidArg,
                        format!(
                            "lsp-execute-command 需要 filePath 定位目标语言服务器（当前启用 {} 个服务器）；或仅启用一个服务器时可直接调用",
                            enabled.len()
                        ),
                    ));
                }
                let lang = enabled[0].lang.clone();
                ensure_capability(&lang, "execute-command")?;
                let root = resolve_project_root(project_id, "")?;
                (lang, root)
            }
        };

        let session = manager.get_or_start(&lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        Ok(guard.execute_command(&command, arguments, dry_run).await?)
    }

    /// callHierarchy 查询（LSP 3.16，双向调用链）：
    async fn execute_call_hierarchy(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        ensure_capability(&lang, "call-hierarchy")?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.call_hierarchy(&path, line, column).await?)
    }

    /// lsp-type-hierarchy（LSP 3.17：父类型链 + 全部子类型）。
    async fn execute_type_hierarchy(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let file_path = required_string(args, "filePath")?;
        let line = required_u32(args, "line")?;
        let column = required_u32(args, "column")?;
        let path = PathBuf::from(&file_path);

        if is_ssh_path(&file_path) {
            return Err(types::LspError::RemoteNotSupported.into());
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let (_config, lang) = config::match_config(&configs, &path).ok_or_else(|| {
            types::LspError::NotConfigured(file_extension_label(&path))
        })?;
        ensure_capability(&lang, "type-hierarchy")?;
        let project_root = resolve_project_root(project_id, &file_path)?;

        let session = manager.get_or_start(lang, &project_root, project_id).await?;
        let mut guard = session.lock().await;
        guard.ensure_open(&path).await?;
        Ok(guard.type_hierarchy(&path, line, column).await?)
    }

    /// lsp-workspace-symbols（无需文件位置：跨**所有**启用且支持的服务器语言合并查询）。
    async fn execute_workspace_symbols(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let query = required_string(args, "query")?;
        if query.trim().is_empty() {
            return Err(Error::new(Status::InvalidArg, "query must not be empty"));
        }

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        // workspace/symbol 没有文件上下文：对每个启用且支持该能力的服务器语言
        // 依次查询并合并（多语言 monorepo 也能一次搜全），结果按内容去重。
        let targets: Vec<&crate::mcp::servers::lsp::types::ServerConfig> = configs
            .iter()
            .filter(|config| {
                config.enabled
                    && capabilities::lang_supports_tool(&config.lang, "workspace-symbols")
            })
            .collect();
        if targets.is_empty() {
            return Err(types::LspError::CapabilityNotSupported(
                "none".into(),
                "workspace-symbols".into(),
            )
            .into());
        }
        // 会话 root：项目目录优先，否则用应用当前工作目录（不能是空路径）。
        let project_root = match project_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(pid) => {
                let storage_info = crate::storage::initialize_app_storage()?;
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

        let mut merged: Vec<serde_json::Value> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut languages: Vec<String> = Vec::new();
        // 语言级降级（2026-08-14）：单语言启动/查询失败不中断其他语言，
        // 记录 warnings 供 agent 参考。
        let mut warnings: Vec<serde_json::Value> = Vec::new();
        for config in targets {
            let session = match manager
                .get_or_start(&config.lang, &project_root, project_id)
                .await
            {
                Ok(session) => session,
                Err(error) => {
                    warnings.push(json!({
                        "language": config.lang,
                        "error": format!("{error:?}"),
                    }));
                    continue;
                }
            };
            let result = {
                let mut guard = session.lock().await;
                // TS 服务器无打开文件时 workspace/symbol 报 "No Project"：
                // 先打开项目入口文件建立项目上下文（失败静默，由降级兜底）。
                guard.ensure_project_context(&project_root).await;
                guard.workspace_symbols(&query).await
            };
            match result {
                Ok(value) => {
                    if !languages.contains(&config.lang) {
                        languages.push(config.lang.clone());
                    }
                    if let Some(symbols) = value.get("symbols").and_then(serde_json::Value::as_array) {
                        for symbol in symbols {
                            let key = serde_json::to_string(symbol).unwrap_or_default();
                            if seen.insert(key) {
                                merged.push(symbol.clone());
                            }
                        }
                    }
                }
                Err(error) => {
                    warnings.push(json!({
                        "language": config.lang,
                        "error": format!("{error:?}"),
                    }));
                }
            }
        }
        // 项目内符号优先（稳定排序保持服务器内部顺序），标准库/依赖符号置后。
        merged.sort_by(|a, b| {
            let a_in = a.get("inProject").and_then(serde_json::Value::as_bool).unwrap_or(false);
            let b_in = b.get("inProject").and_then(serde_json::Value::as_bool).unwrap_or(false);
            b_in.cmp(&a_in)
        });
        let project_symbols = merged
            .iter()
            .filter(|s| s.get("inProject").and_then(serde_json::Value::as_bool).unwrap_or(false))
            .count();
        let total = merged.len();
        merged.truncate(50);
        let mut output = serde_json::json!({
            "language": if languages.len() == 1 { languages[0].clone() } else { "multiple".into() },
            "languages": languages,
            "query": query,
            "projectSymbols": project_symbols,
            "count": merged.len(),
            "total": total,
            "symbols": merged,
        });
        if !warnings.is_empty() {
            output["warnings"] = serde_json::json!(warnings);
        }
        Ok(output)
    }

    /// lsp-workspace-diagnostics（项目级诊断）：对每个启用且支持 workspace/diagnostic
    /// 的服务器语言依次查询并合并输出（多语言 monorepo 一次查全），按文件分组。
    /// 单语言失败降级为 warnings（复用 workspace-symbols 模式）。
    async fn execute_workspace_diagnostics(
        &self,
        args: &Value,
        project_id: Option<&str>,
    ) -> napi::Result<Value> {
        // M4/R3.2：maxFiles 参数贯穿生效（clamp 1..=200，默认 100）。
        let max_files = args
            .get("maxFiles")
            .and_then(Value::as_u64)
            .map(|n| n.clamp(1, 200) as usize)
            .unwrap_or(100);

        let manager = manager::ServerManager::instance();
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let targets: Vec<&crate::mcp::servers::lsp::types::ServerConfig> = configs
            .iter()
            .filter(|config| {
                config.enabled
                    && capabilities::lang_supports_tool(&config.lang, "workspace-diagnostics")
            })
            .collect();
        if targets.is_empty() {
            return Err(types::LspError::CapabilityNotSupported(
                "none".into(),
                "workspace-diagnostics".into(),
            )
            .into());
        }
        // 会话 root：项目目录优先，否则用应用当前工作目录（不能是空路径）。
        let project_root = match project_id.map(str::trim).filter(|s| !s.is_empty()) {
            Some(pid) => {
                let storage_info = crate::storage::initialize_app_storage()?;
                let database_path = PathBuf::from(storage_info.database_path);
                match get_workspace_directory_path(&database_path, pid) {
                    Ok(Some(root)) => PathBuf::from(root),
                    _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                }
            }
            None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        };

        let mut files: Vec<Value> = Vec::new();
        let mut warnings: Vec<Value> = Vec::new();
        let mut languages: Vec<String> = Vec::new();
        for config in targets {
            let session = match manager
                .get_or_start(&config.lang, &project_root, project_id)
                .await
            {
                Ok(session) => session,
                Err(error) => {
                    warnings.push(json!({
                        "language": config.lang,
                        "error": format!("{error:?}"),
                    }));
                    continue;
                }
            };
            let result = {
                let mut guard = session.lock().await;
                guard.workspace_diagnostics(max_files).await
            };
            match result {
                Ok(value) => {
                    if !languages.contains(&config.lang) {
                        languages.push(config.lang.clone());
                    }
                    if let Some(items) = value.get("files").and_then(Value::as_array) {
                        files.extend(items.iter().cloned());
                    }
                }
                Err(error) => {
                    warnings.push(json!({
                        "language": config.lang,
                        "error": format!("{error:?}"),
                    }));
                }
            }
        }

        let mut output = json!({
            "language": if languages.len() == 1 { languages[0].clone() } else { "multiple".into() },
            "languages": languages,
            "count": files.len(),
            "files": files,
        });
        if !warnings.is_empty() {
            output["warnings"] = serde_json::json!(warnings);
        }
        Ok(output)
    }

    /// lsp-vulncheck（go 专属依赖漏洞扫描，2026-08-16）。
    ///
    /// 复用官方 `govulncheck` 二进制（gopls MCP `go_vulncheck` 同款机制：
    /// `-json -mode source -scan symbol`），绕开 gopls MCP 的 dir 参数缺陷
    /// （per-project daemon 架构下显式传 dir 会与 gopls 锁定 root 的 env
    /// 不一致，见分析记录）。stdout 为 NDJSON 多文档流（config / SBOM /
    /// progress / osv / finding），只收集 `osv` + `finding`，按 OSV ID 分组
    /// 输出 `{id, details, affectedPackages}`（与 gopls MCP 输出格式对齐）。
    ///
    /// 参数：`dir`（默认项目根：project_id → workspace 目录 → 当前目录）、
    /// `pattern`（默认 `./...`）。超时 120s（首次需下载漏洞库）。go 语言
    /// 能力表标记；无 govulncheck 时给出安装指引。
    async fn execute_vulncheck(&self, args: &Value, project_id: Option<&str>) -> napi::Result<Value> {
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("./...")
            .to_string();

        // 目标目录：dir 参数优先；否则 project_id → workspace 目录；兜底当前目录。
        let dir = args
            .get("dir")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let root = match dir {
            Some(path) => path,
            None => {
                if let Some(pid) = project_id.map(str::trim).filter(|s| !s.is_empty()) {
                    let storage_info = crate::storage::initialize_app_storage()?;
                    let database_path = PathBuf::from(storage_info.database_path);
                    match get_workspace_directory_path(&database_path, pid) {
                        Ok(Some(root)) => PathBuf::from(root),
                        _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                    }
                } else {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }
            }
        };

        // govulncheck 在单独进程中运行（CPU 密集 + 网络下载漏洞库），
        // 异步执行不阻塞 Node.js 主线程（架构红线）；超时兜底 + kill_on_drop
        // 防止超时后残留进程（同 gopls 上游注释：独立进程即完美的 GC）。
        let mut command = crate::utils::process::cmd_async("govulncheck");
        command
            .arg("-json")
            .arg("-mode")
            .arg("source")
            .arg("-scan")
            .arg("symbol")
            .arg("-C")
            .arg(&root)
            .arg(&pattern)
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(120), command.output())
            .await
            .map_err(|_| {
                Error::new(
                    Status::GenericFailure,
                    "govulncheck timed out after 120s (vulnerability database download may be slow); retry later".to_string(),
                )
            })?
            .map_err(|error| {
                // spawn 失败（二进制缺失 / 不可执行）→ 安装指引。
                if error.kind() == std::io::ErrorKind::NotFound {
                    Error::new(
                        Status::GenericFailure,
                        "govulncheck not found in PATH. Install it with: go install golang.org/x/vuln/cmd/govulncheck@latest".to_string(),
                    )
                } else {
                    Error::new(
                        Status::GenericFailure,
                        format!("failed to run govulncheck: {error}"),
                    )
                }
            })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(Error::new(
                Status::GenericFailure,
                format!(
                    "govulncheck failed (exit {:?}): {}",
                    output.status.code(),
                    stderr.trim()
                ),
            ));
        }

        parse_vulncheck_output(&output.stdout, &pattern, &root.to_string_lossy())
    }
}

/// 运行时二次校验（§8.7.1）：按文件匹配到的语言服务器是否支持该工具。
/// collect 阶段已按能力并集过滤，此错误仅兜底静态表与真实情况不一致的场景。
fn ensure_capability(lang: &str, tool: &str) -> napi::Result<()> {
    if !capabilities::lang_supports_tool(lang, tool) {
        return Err(types::LspError::CapabilityNotSupported(lang.to_string(), tool.to_string()).into());
    }
    Ok(())
}

/// govulncheck `-json` stdout 解析（NDJSON 多文档流，实测 v1.6.0）。
///
/// 流对象形如 `{"config": ...}` / `{"SBOM": ...}` / `{"progress": ...}` /
/// `{"osv": {...}}` / `{"finding": {...}}`（多行缩进文档串联，非每行一个）。
/// 只收集 `osv`（id → entry）与 `finding`（引用 osv id + trace 链），按
/// OSV ID 分组输出 `{id, details, affectedPackages}`——与 gopls MCP
/// `go_vulncheck` 输出格式一致（package 取 trace[0]，空则标
/// "Go standard library"；`osv` 对象含大量未调用的候选，只有被 `finding`
/// 引用的才算真实命中）。
fn parse_vulncheck_output(stdout: &[u8], pattern: &str, dir: &str) -> napi::Result<Value> {
    let mut osvs: HashMap<String, Value> = HashMap::new();
    let mut findings: Vec<Value> = Vec::new();

    let mut stream = serde_json::Deserializer::from_slice(stdout).into_iter::<Value>();
    while let Some(item) = stream.next() {
        let obj = item.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("failed to parse govulncheck JSON stream: {error}"),
            )
        })?;
        if let Some(osv) = obj.get("osv") {
            if let Some(id) = osv.get("id").and_then(Value::as_str) {
                osvs.insert(id.to_string(), osv.clone());
            }
        } else if let Some(finding) = obj.get("finding") {
            findings.push(finding.clone());
        }
    }

    // 按 OSV ID 分组（BTreeMap 保证 ID 排序稳定）。
    let mut grouped: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    for finding in &findings {
        let Some(osv_id) = finding.get("osv").and_then(Value::as_str) else {
            continue;
        };
        let details = osvs
            .get(osv_id)
            .and_then(|entry| entry.get("details"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let pkg = finding
            .get("trace")
            .and_then(Value::as_array)
            .and_then(|trace| trace.first())
            .and_then(|t0| t0.get("package"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "Go standard library".to_string());
        let entry = grouped
            .entry(osv_id.to_string())
            .or_insert_with(|| (details, BTreeSet::new()));
        entry.1.insert(pkg);
    }

    let findings_out: Vec<Value> = grouped
        .into_iter()
        .map(|(id, (details, packages))| {
            json!({
                "id": id,
                "details": details,
                "affectedPackages": packages.into_iter().collect::<Vec<_>>(),
            })
        })
        .collect();
    let count = findings_out.len();

    Ok(json!({
        "findings": findings_out,
        "count": count,
        "summary": format!(
            "Vulnerability check for pattern {pattern:?} in {dir:?} complete. Found {count} vulnerabilities."
        ),
    }))
}

impl McpService for LspService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        // 暴露与否由 collect_all_mcp_tools 按表配置过滤（§8.0）。
        tool_schemas()
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "LSP tool \"{tool_name}\" must be executed through the asynchronous executor"
            ),
        ))
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 单文件准备结果：缓存命中（直接返回）或待并发等待（锁外拉取）。
enum Prepared {
    Cached(Value),
    Pending {
        session: Arc<tokio::sync::Mutex<ServerSession>>,
        pending: PendingDiagnostics,
    },
}

/// 解析项目根：project_id → workspace_directories 表；无则文件父目录兜底（§7.2）。
fn resolve_project_root(project_id: Option<&str>, file_path: &str) -> napi::Result<PathBuf> {
    if let Some(pid) = project_id {
        if !pid.trim().is_empty() {
            let storage_info = crate::storage::initialize_app_storage()?;
            let database_path = PathBuf::from(storage_info.database_path);
            if let Ok(Some(root)) = get_workspace_directory_path(&database_path, pid) {
                return Ok(PathBuf::from(root));
            }
        }
    }
    // 兜底：文件所在目录。
    Ok(PathBuf::from(file_path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".")))
}

/// 文件扩展名标签（错误信息用）。
fn file_extension_label(path: &std::path::Path) -> String {
    path.extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| "<unknown>".to_string())
}

fn required_string(args: &Value, key: &str) -> napi::Result<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("Missing or invalid string parameter: {key}")))
}

fn required_u32(args: &Value, key: &str) -> napi::Result<u32> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("Missing or invalid number parameter: {key}")))
}

/// 检查 LSP 工具是否被用户允许（与 collect 阶段对 lsp-* 工具的判定一致）：
/// 全局黑名单或项目 scope（builtin:lsp 服务器 / 具体 lsp-* 工具）禁用时
/// 返回 false——用户禁用了 LSP 就不应把 codelens 调用转发过去。lsp 是
/// 默认关闭服务器：无项目 scope（用户从未在项目 MCP 面板启用 builtin:lsp）
/// 同样返回 false，与 tool_is_enabled 的无 scope 判定保持一致。
async fn lsp_tool_scope_allowed(lsp_tool: &str, project_id: Option<&str>) -> napi::Result<bool> {
    use crate::mcp::tools::{builtin_scope_server_id, load_global_scope, load_project_scope};
    let lsp_full_name = format!("lsp-{lsp_tool}");
    if let Some(global) = load_global_scope().await? {
        if global.disabled_tool_names.contains(&lsp_full_name) {
            return Ok(false);
        }
    }
    let Some(scope) = load_project_scope(project_id).await? else {
        return Ok(false);
    };
    Ok(scope.is_server_enabled(&builtin_scope_server_id("lsp"))
        && scope.is_tool_enabled(&lsp_full_name))
}

/// 检查 LSP 域整体是否被用户允许（与 collect 阶段 lsp-* 工具暴露的 scope
/// 条件一致）：全局黑名单把全部核心 lsp 工具禁用，或项目 scope 禁用了
/// builtin:lsp 服务器时返回 false——用户禁用了 LSP 就不应在系统提示词中
/// 注入优先使用指引（否则提示词与工具可见性不一致）。lsp 是默认关闭
/// 服务器：无项目 scope（未在任何项目启用过 builtin:lsp）同样返回 false。
async fn lsp_domain_scope_allowed(project_id: Option<&str>) -> napi::Result<bool> {
    use crate::mcp::tools::{builtin_scope_server_id, load_global_scope, load_project_scope};
    // 核心代表工具：任一未被全局禁用即认为域可用（collect 阶段按工具粒度
    // 过滤，工具级个别禁用不影响域级注入）。
    const CORE_LSP_TOOLS: [&str; 4] = [
        "lsp-goto",
        "lsp-references",
        "lsp-symbols",
        "lsp-diagnostics",
    ];
    if let Some(global) = load_global_scope().await? {
        if CORE_LSP_TOOLS
            .iter()
            .all(|tool| global.disabled_tool_names.contains(*tool))
        {
            return Ok(false);
        }
    }
    let Some(scope) = load_project_scope(project_id).await? else {
        return Ok(false);
    };
    Ok(scope.is_server_enabled(&builtin_scope_server_id("lsp")))
}

/// 写应用日志（app_logs 表，复用项目现有日志体系——与系统日志面板同源，
/// config 工具 logs scope / listAppLogs 均可查；module="lsp" 便于过滤）。
/// 通过 spawn_blocking 执行 DB 写，不阻塞 tokio 工作线程；日志写入失败
/// 静默（eprintln 兜底），绝不影响主流程。
pub(crate) async fn lsp_app_log(level: &str, func: &str, message: &str, error: Option<&str>) {
    let input = crate::storage::services::app_logs::AppLogInput {
        level: level.to_string(),
        module: "lsp".to_string(),
        func: func.to_string(),
        line: None,
        message: message.to_string(),
        input: None,
        output: None,
        duration: None,
        context: None,
        error: error.map(str::to_string),
        source: "native".to_string(),
    };
    match tokio::task::spawn_blocking(move || crate::storage::write_app_log(input)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("[lsp] write_app_log failed: {err}"),
        Err(join_err) => eprintln!("[lsp] write_app_log join failed: {join_err}"),
    }
}

/// 服务器是否与项目实际语言匹配（项目语言一致性判定；collect 阶段工具暴露
/// 与系统提示词注入共用，避免两处口径不一致）。匹配 = 技术栈标志命中
/// （detect_project_stack，如 Cargo.toml → rust）或项目文件扩展名命中服务器
/// file_extensions（覆盖无标志文件的 C/C++/Swift 等）。检测结果走 TTL 缓存
/// （detect.rs，60s），避免每次调用重复全量目录扫描。
pub(crate) fn server_matches_project(config: &types::ServerConfig, project_root: &Path) -> bool {
    let profile = detect::detect_project_languages_cached(&project_root.to_string_lossy());
    profile.langs.iter().any(|lang| lang == &config.lang)
        || config.file_extensions.iter().any(|ext| {
            profile
                .extensions
                .contains(&ext.trim_start_matches('.').to_ascii_lowercase())
        })
}

/// 构建系统提示词注入的「Language Servers」章节（2026-08-15，方案 B+C+D）。
///
/// 项目启用了外部 LSP 服务器（配置 enabled + 命令已安装，与 collect 阶段
/// `tool_exposure` 判定一致）时，返回一段 Markdown 指引：
/// - 列出可用服务器及其运行状态（会话状态感知：`session_statuses` 中有
///   running 记录的标 `running`，否则标 `installed; starts on first use`）；
/// - 按合并能力分组列出应优先使用的 `lsp-*` 工具（诊断/悬停/定位/大纲/
///   符号搜索/调用图等），并给出强制任务分诊规则（方案 C）：语义查询
///   MUST 走 `lsp-*`，grep 仅限纯文本搜索——引导模型用语义分析而不是
///   tree-sitter/grep；
/// - 预热（方案 D）：返回前对非 running 的匹配服务器 spawn 后台任务
///   提前启动会话（get_or_start 幂等复用），消除模型首次调用的冷启动延迟。
///
/// 无可用服务器、SSH 远程项目（LSP 仅本地）或任何查询失败时返回空字符串
/// （静默降级——提示词构建不能因 LSP 状态查询失败而打挂整个请求）。
pub(crate) async fn build_system_prompt_section(
    project_id: Option<&str>,
    project_root: Option<&std::path::Path>,
) -> String {
    // LSP 仅支持本地项目：SSH 远程不注入（会话也永远不会启动）。
    if let Some(root) = project_root {
        if is_ssh_path(&root.to_string_lossy()) {
            return String::new();
        }
    }
    // 与 collect 阶段 lsp-* 工具暴露的 scope 条件一致：用户禁用了 LSP 域
    // （全局黑名单全禁 / 项目 scope 禁 builtin:lsp）时不注入——提示词指引
    // 必须与工具可见性保持一致，避免诱导调用不可见的工具。
    let scope_allowed = match lsp_domain_scope_allowed(project_id).await {
        Ok(allowed) => allowed,
        Err(error) => {
            lsp_app_log(
                "warn",
                "build_system_prompt_section",
                "LSP domain scope check failed, skipping Language Servers section",
                Some(&error.to_string()),
            )
            .await;
            return String::new();
        }
    };
    if !scope_allowed {
        return String::new();
    }
    let manager = manager::ServerManager::instance();
    let (configs, statuses) = match (|| async {
        manager.reload_configs(project_id).await?;
        let configs = manager.configs(project_id).await;
        let statuses = manager.session_statuses(project_root).await;
        Ok::<_, napi::Error>((configs, statuses))
    })()
    .await
    {
        Ok(pair) => pair,
        Err(error) => {
            lsp_app_log(
                "warn",
                "build_system_prompt_section",
                "LSP config/session query failed, skipping Language Servers section",
                Some(&error.to_string()),
            )
            .await;
            return String::new();
        }
    };

    // enabled + 非空扩展名（扩展名为空 = 无效配置，match_config 永不匹配
    // 任何文件）+ 命令已安装（复用 collect 阶段的 TTL 探测缓存）。
    let mut available: Vec<&types::ServerConfig> = configs
        .iter()
        .filter(|config| {
            config.enabled
                && !config.file_extensions.is_empty()
                && config::is_command_installed_cached(&config.command)
        })
        .collect();

    // 项目语言一致性（与 collect 阶段工具暴露共用 server_matches_project，
    // 单一事实来源，检测结果走 60s TTL 缓存）：项目没有编程语言（纯文档/
    // 配置仓库）、或服务器语言与项目语言不一致时不注入。project_root
    // 不可用（无项目上下文）时跳过语言过滤——实际上无项目上下文时
    // lsp_domain_scope_allowed 早已返回 false（lsp 默认关闭，需项目级
    // 显式启用），此处仅为防御性兜底。
    if let Some(root) = project_root {
        available.retain(|config| server_matches_project(config, root));
    }
    if available.is_empty() {
        return String::new();
    }
    // 会话状态三态（2026-08-15）：running / crashed（dead 或 exited，下次
    // 调用自动重启，连续失败限 2 次）/ 未启动（首次调用懒加载）。
    let status_by_lang: HashMap<String, &str> = statuses
        .iter()
        .map(|status| (status.lang.clone(), status.status.as_str()))
        .collect();

    let mut lines: Vec<String> = Vec::new();
    lines.push("## Language Servers".to_string());
    lines.push(String::new());
    lines.push("Enabled external language servers:".to_string());
    for config in &available {
        let state = match status_by_lang.get(config.lang.as_str()) {
            Some(status) if *status == "running" => "running",
            Some(_) => "crashed; restarts on next use",
            None => "installed; starts on first use",
        };
        lines.push(format!(
            "- `{}` ({}) — {}",
            config.lang, config.command, state
        ));
    }
    lines.push(String::new());
    lines.push(
        "The `lsp-*` tools are the MANDATORY semantic-analysis path for these languages (cross-file accurate; import/generic/trait aware; far more reliable than grep or tree-sitter):"
            .to_string(),
    );

    // 合并所有可用服务器支持的工具能力（§8.7 同源判定），按功能分组渲染。
    let mut merged: Vec<&'static str> = Vec::new();
    for config in &available {
        for tool in capabilities::supported_tools_for_lang(&config.lang) {
            if !merged.contains(&tool) {
                merged.push(tool);
            }
        }
    }
    let groups: [(&str, &[&str]); 6] = [
        (
            "Errors & diagnostics",
            &["diagnostics", "workspace-diagnostics", "vulncheck"],
        ),
        ("Type info", &["hover"]),
        ("Navigation", &["goto", "references"]),
        ("Outline & symbol search", &["symbols", "workspace-symbols"]),
        ("Call graph", &["call-hierarchy", "type-hierarchy"]),
        ("Refactoring", &["rename", "code-action", "execute-command"]),
    ];
    for (label, tools) in groups {
        let present: Vec<&str> = tools
            .iter()
            .copied()
            .filter(|tool| merged.contains(tool))
            .collect();
        if !present.is_empty() {
            let rendered = present
                .iter()
                .map(|tool| format!("`lsp-{tool}`"))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("- {label}: {rendered}"));
        }
    }

    // 任务分诊规则（2026-08-15，方案 C）：语义查询强制走 lsp-*，grep 仅限
    // 纯文本搜索——消除模型"用 grep 代替语义分析"的路径依赖（实测
    // grep-search 调用量远超 lsp-* 全家）。
    lines.push(String::new());
    lines.push("Routing rules (MUST follow):".to_string());
    lines.push(
        "- Semantic queries (symbols, types, definitions, references, call graph, diagnostics) MUST use `lsp-*`; do NOT use `grep-search` or tree-sitter for them."
            .to_string(),
    );
    lines.push("- `grep-search` is only for locating literal strings/patterns.".to_string());

    lines.push(String::new());
    lines.push(
        "Servers are pre-warmed for this project: running servers respond instantly; not-yet-started servers start on the first `lsp-*` call (cold start may take a few seconds), after which they stay warm."
            .to_string(),
    );

    // —— 预热（2026-08-15，方案 D）——后台启动匹配的 LSP 会话，消除模型
    // 首次调用 lsp-* 的冷启动延迟。复用 get_or_start 幂等语义：已有会话
    // 直接复用（touch 刷新），并发防重由 starting 占位串行化；running 跳过、
    // crashed 顺带重试（真实调用也会自动重启，不增加额外负担）；失败静默
    // 降级（仅日志），绝不阻塞提示词构建。project_root 缺失（无项目上下文）
    // 时跳过——会话 key 需要项目根，且无项目时工具按全局暴露、语言未知。
    if let Some(root) = project_root {
        let manager = manager::ServerManager::instance().clone();
        for config in &available {
            let running = status_by_lang
                .get(config.lang.as_str())
                .map(|status| *status == "running")
                .unwrap_or(false);
            if running {
                continue;
            }
            let lang = config.lang.clone();
            let root = root.to_path_buf();
            let project_id = project_id.map(str::to_string);
            let manager = manager.clone();
            tokio::spawn(async move {
                match manager.get_or_start(&lang, &root, project_id.as_deref()).await {
                    Ok(_) => {}
                    Err(error) => {
                        lsp_app_log(
                            "info",
                            "prewarm",
                            &format!("LSP prewarm failed for {lang}: {error:?}"),
                            None,
                        )
                        .await;
                    }
                }
            });
        }
    }

    lines.join("\n")
}

/// lsp-goto（kind=definition）结果 → codelens-find_definition 输出格式。
///
/// 保持 codelens 字段形状（found/name/location/searchScope，前端
/// CodeLensToolCall 与 agent 无感），附加 LSP 特有信息：完整
/// definitions 列表、language、engine 标记。LSP 不返回 kind /
/// containerName / isExported，对应字段为 null。
fn definition_to_codelens(_file_path: &str, value: Value) -> Value {
    let definitions = value
        .get("definitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let count = definitions.len();
    json!({
        "found": count > 0,
        "name": value.get("name").cloned().unwrap_or(Value::Null),
        "kind": Value::Null,
        "location": definitions.first().cloned(),
        "containerName": Value::Null,
        "isExported": Value::Null,
        "searchScope": "project",
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
        "count": count,
        "definitions": definitions,
    })
}

/// lsp-references 结果 → codelens-find_references 输出格式。
///
/// LSP 引用项自带 filePath/line/column/endLine/endColumn（前端 parseLocation
/// 直接读取），补充 codelens 需要的 access 字段并保留 LSP 的 context 代码
/// 上下文。LSP 不返回定义位置，definition 为 null。
fn references_to_codelens(_file_path: &str, value: Value) -> Value {
    let references = value
        .get("references")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = references
        .iter()
        .map(|reference| {
            let mut item = reference.clone();
            if let Value::Object(map) = &mut item {
                map.entry("access".to_string())
                    .or_insert_with(|| json!("read"));
            }
            item
        })
        .collect();
    let count = items.len();
    json!({
        "found": count > 0,
        "name": value.get("symbol").cloned().unwrap_or(Value::Null),
        "definition": Value::Null,
        "references": items,
        "totalReferences": count,
        "searchScope": "project",
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
    })
}

/// lsp-symbols 结果 → codelens-file_outline 输出格式。
///
/// LSP documentSymbol 是树形（range/selection/children），展平为 codelens
/// 的扁平 outline 列表（先父后子，range.start 作为符号位置）。
fn symbols_to_codelens(file_path: &str, value: Value) -> Value {
    let symbols = value
        .get("symbols")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut outline: Vec<Value> = Vec::new();
    flatten_symbols(&symbols, &mut outline);
    let count = outline.len();
    json!({
        "filePath": file_path,
        "outline": outline,
        "totalSymbols": count,
        "engine": "lsp",
        "language": value.get("language").cloned().unwrap_or(Value::Null),
    })
}

/// LSP documentSymbol 树形 → 扁平 outline（先父后子递归）。
fn flatten_symbols(symbols: &[Value], out: &mut Vec<Value>) {
    for symbol in symbols {
        let range = symbol.get("range");
        let (line, column, end_line, end_column) = range
            .and_then(|r| {
                let start = r.get("start")?;
                let end = r.get("end")?;
                Some((
                    start.get("line")?.clone(),
                    start.get("column")?.clone(),
                    end.get("line")?.clone(),
                    end.get("column")?.clone(),
                ))
            })
            .unwrap_or((Value::Null, Value::Null, Value::Null, Value::Null));
        out.push(json!({
            "name": symbol.get("name").cloned().unwrap_or(Value::Null),
            "kind": symbol.get("kind").cloned().unwrap_or_else(|| json!("unknown")),
            "line": line,
            "column": column,
            "endLine": end_line,
            "endColumn": end_column,
            "containerName": symbol.get("detail").cloned().unwrap_or(Value::Null),
            "isExported": false,
        }));
        if let Some(children) = symbol.get("children").and_then(Value::as_array) {
            flatten_symbols(children, out);
        }
    }
}
