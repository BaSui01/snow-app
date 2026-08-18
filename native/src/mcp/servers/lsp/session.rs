//! ServerSession：单个 (语言 × 项目根) 的语言服务器会话。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyOutgoingCall, CodeActionOrCommand, Diagnostic,
    Location, TextEdit, WorkspaceEdit,
};
use serde_json::{json, Value};

use async_lsp::LanguageServer;

use super::client::{self, PushDiagnostics};
use super::format;
use super::types::{LspError, ServerConfig};
use crate::utils::process_tree::ProcessTreeGuard;

use std::sync::Arc;

/// 最大分析文件大小（与 codelens MAX_FILE_SIZE 一致，§9）。
pub const MAX_FILE_SIZE: u64 = 512 * 1024;

/// 请求超时（§7.3）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const HOVER_TIMEOUT: Duration = Duration::from_secs(5);
/// push 诊断等待上限：rust-analyzer 的 rustc/cargo 诊断经 flycheck（cargo check）
/// 产生，首次项目构建可能 10-30s（§8.1 / rust-lang/rust-analyzer#18709）。
const PUSH_TIMEOUT: Duration = Duration::from_secs(30);
/// references 返回上限（§10 输出限制）。
const MAX_REFERENCES: usize = 100;

pub struct ServerSession {
    pub lang: String,
    pub project_root: PathBuf,
    config: ServerConfig,
    child: tokio::process::Child,
    /// mainloop 完成标志（M5/R2.2）：mainloop 结束（进程退出/管道断开）置位，
    /// 状态快照与 get_or_start 据此判定 dead，消除「running 但请求全失败」僵尸态。
    pub main_loop_done: Arc<AtomicBool>,
    socket: async_lsp::ServerSocket,
    opened_files: HashMap<PathBuf, i32>, // 已打开文件 → 当前 LSP 版本
    /// 服务器是否声明 pull 诊断支持（initialize 能力，§8.1）。
    pull_diagnostics_supported: bool,
    /// 最近使用时间（unix 毫秒，原子更新供空闲回收 / LRU 淘汰）。
    pub last_used_ms: AtomicU64,
    pub restart_count: u32,
    pub dead: bool,
    push_diagnostics: PushDiagnostics,
    /// push generation 计数器（M6/R4.3）：prepare_diagnostics/didChange 递增，
    /// push 写入带当时值，读取/合并按当前值过滤陈旧条目。
    push_generation: Arc<AtomicU64>,
    /// 进程树回收 guard（M2/R4.1）：会话销毁时 Drop 兜底杀整棵树
    ///（Windows Job Object / Unix 进程组），消除 shim 后代孤儿进程。
    /// shutdown() 的显式 kill 逻辑不变；字段本身不读（下划线前缀抑制告警）。
    _process_tree_guard: ProcessTreeGuard,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ServerSession {
    /// 启动会话：spawn 进程 + initialize 握手（带超时）。
    /// `restart_count`：本次启动前已连续重启次数（崩溃重启用，R2.1）。
    pub async fn start(
        lang: &str,
        project_root: &Path,
        config: ServerConfig,
        restart_count: u32,
    ) -> Result<Self, LspError> {
        let (
            child,
            _main_loop,
            socket,
            push_diagnostics,
            main_loop_done,
            push_generation,
            process_tree_guard,
        ) = client::spawn_client(&config, project_root)
                .map_err(|error| match error.kind() {
                    std::io::ErrorKind::NotFound => LspError::ServerMissing(
                        config.command.clone(),
                        config.install_command.clone(),
                    ),
                    _ => LspError::ServerFailed(format!("spawn failed: {error}")),
                })?;

        let mut session = ServerSession {
            lang: lang.to_string(),
            project_root: project_root.to_path_buf(),
            config,
            child,
            main_loop_done,
            socket,
            opened_files: HashMap::new(),
            pull_diagnostics_supported: false,
            last_used_ms: AtomicU64::new(now_ms()),
            restart_count,
            dead: false,
            push_diagnostics,
            push_generation,
            _process_tree_guard: process_tree_guard,
        };

        // initialize 握手（JVM 系 120s，其余 30s）。
        let timeout = client::initialize_timeout_for(lang);
        let mut socket = session.socket.clone();
        let pull_diagnostics_supported = match client::initialize(
            &mut socket,
            project_root,
            session.config.initialization_options.clone(),
            timeout,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                // 进程已提前退出（如 rustup shim 存在但组件缺失）：附加退出码与
                // 行动指引，否则只有 "initialize failed: ServiceStopped"（D1）。
                // tokio Child::try_wait 是同步方法（不阻塞，只查一次退出状态）。
                match session.child.try_wait() {
                    Ok(Some(status)) => {
                        let code = match status.code() {
                            Some(code) => code.to_string(),
                            None => "unknown".to_string(),
                        };
                        let base = match &error {
                            LspError::ServerFailed(message) => message.clone(),
                            other => format!("{other:?}"),
                        };
                        let hint = format!(
                            "。服务器进程已提前退出（exit code {code}），常见原因：组件未安装或运行环境不完整{}",
                            session
                                .config
                                .install_command
                                .as_deref()
                                .filter(|cmd| !cmd.is_empty())
                                .map(|cmd| format!("。可尝试安装命令: {cmd}"))
                                .unwrap_or_default()
                        );
                        return Err(LspError::ServerFailed(format!("{base}{hint}")));
                    }
                    // 进程仍在运行（如 initialize 超时）：原样返回原错误。
                    _ => return Err(error),
                }
            }
        };
        session.pull_diagnostics_supported = pull_diagnostics_supported;
        // 会话首次启动预热：didOpen 项目入口文件，让服务器提前加载 workspace
        // 建索引（不触发 flycheck，避免后台 cargo check CPU 成本；失败静默）。
        // 预热文件记入 opened_files，后续真实调用不重复打开。
        session.warmup(project_root).await;
        Ok(session)
    }

    /// 确保文件已 didOpen（读文件内容，≤512KB）。
    pub async fn ensure_open(&mut self, path: &Path) -> Result<(), LspError> {
        if self.opened_files.contains_key(path) {
            self.touch();
            return Ok(());
        }
        if path.is_dir() {
            return Err(LspError::Internal(format!("not a file: {}", path.display())));
        }
        let metadata = tokio::fs::metadata(path)
            .await
            .map_err(|error| LspError::Internal(format!("read metadata failed: {error}")))?;
        if metadata.len() > MAX_FILE_SIZE {
            return Err(LspError::FileTooLarge(path.display().to_string()));
        }
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| LspError::Internal(format!("read file failed: {error}")))?;

        client::did_open(&mut self.socket, &self.lang, path, &text).await?;
        self.opened_files.insert(path.to_path_buf(), 1);
        self.touch();
        Ok(())
    }

    /// 读取文件内容（≤512KB）。
    async fn read_file_text(&self, path: &Path) -> Result<String, LspError> {
        let text = tokio::fs::read_to_string(path)
            .await
            .map_err(|error| LspError::Internal(format!("read file failed: {error}")))?;
        Ok(text)
    }

    /// 会话首次启动预热：didOpen 项目入口文件，让服务器提前加载 workspace 建索引
    /// （不触发 didSave/flycheck，避免后台 cargo check CPU 成本；失败静默仅日志）。
    /// 预热文件记入 opened_files，后续真实调用不重复打开。
    pub async fn warmup(&mut self, project_root: &Path) {
        let entry = match self.lang.as_str() {
            "typescript" => find_project_entry(project_root, &[".ts", ".tsx"]),
            "rust" => {
                const CANDIDATES: &[&str] = &["src/lib.rs", "src/main.rs", "lib.rs", "main.rs"];
                CANDIDATES
                    .iter()
                    .map(|c| project_root.join(c))
                    .find(|p| p.is_file())
            }
            _ => None,
        };
        let Some(entry) = entry else { return };
        if let Err(error) = self.ensure_open(&entry).await {
            eprintln!("[lsp:{}] warmup didOpen failed: {error:?}", self.lang);
        }
    }

    /// 建立项目上下文（typescript 专用）：会话无打开文件时，打开项目根的一个
    /// TS/TSX 入口文件，让 tsserver 加载项目——否则 workspace/symbol 报
    /// "No Project"（tsserver 的 navigate-to-items 依赖已加载的项目）。
    /// 失败静默（不阻断查询；调用方错误降级兜底）。
    pub async fn ensure_project_context(&mut self, project_root: &Path) {
        if self.lang != "typescript" || !self.opened_files.is_empty() {
            return;
        }
        if let Some(entry) = find_project_entry(project_root, &[".ts", ".tsx"]) {
            if let Err(error) = self.ensure_open(&entry).await {
                eprintln!("[lsp:typescript] ensure project context failed: {error:?}");
            }
        }
    }

    /// hover 查询。
    pub async fn hover(&mut self, path: &Path, line: u32, column: u32) -> Result<Value, LspError> {
        let result = client::hover(&mut self.socket, path, line, column, HOVER_TIMEOUT).await?;
        self.touch();
        match result {
            Some(hover) => Ok(format::hover_to_value(&self.lang, &hover)),
            None => Ok(serde_json::json!({
                "language": self.lang,
                "contents": "",
                "range": null,
            })),
        }
    }

    /// goto definition 查询（语义跳转，可跨文件；name 从请求位置行提取）。
    pub async fn goto_definition(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        let response =
            client::goto_definition(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// references 查询（全部引用位置 + 代码上下文，上限 MAX_REFERENCES）。
    pub async fn references(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
        include_declaration: bool,
    ) -> Result<Value, LspError> {
        let locations = client::references(
            &mut self.socket,
            path,
            line,
            column,
            include_declaration,
            REQUEST_TIMEOUT,
        )
        .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let contexts = read_reference_contexts(&locations, MAX_REFERENCES).await;
        let shown = locations.len().min(contexts.len());
        Ok(format::references_to_value(
            &self.lang,
            &symbol,
            &locations[..shown],
            &contexts[..shown],
        ))
    }

    /// documentSymbol 查询（树形大纲：name/kind/detail/range/children）。
    pub async fn document_symbols(&mut self, path: &Path) -> Result<Value, LspError> {
        let response = client::document_symbols(&mut self.socket, path, REQUEST_TIMEOUT).await?;
        self.touch();
        Ok(format::symbols_to_value(&self.lang, response))
    }

    /// rename 查询：dry_run=true 只返回 WorkspaceEdit 描述（不写盘）；
    /// dry_run=false 应用多文件 edits 写回 + 已打开文件 didChange 同步。
    pub async fn rename(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
        new_name: &str,
        dry_run: bool,
    ) -> Result<Value, LspError> {
        let result =
            client::rename(&mut self.socket, path, line, column, new_name, REQUEST_TIMEOUT).await?;
        self.touch();
        let Some(edit) = result else {
            return Ok(json!({
                "language": self.lang,
                "applied": false,
                "dryRun": dry_run,
                "changeCount": 0,
                "files": [],
            }));
        };
        if dry_run {
            let mut value = format::workspace_edit_to_value(&edit);
            value["language"] = json!(self.lang);
            value["applied"] = json!(false);
            value["dryRun"] = json!(true);
            return Ok(value);
        }
        let files = apply_workspace_edit(self, &edit).await?;
        Ok(json!({
            "language": self.lang,
            "applied": true,
            "dryRun": false,
            "changeCount": files.len(),
            "files": files,
        }))
    }

    /// codeAction 查询：apply=false 返回 action 描述（command 类不执行）；
    /// apply=true 应用 edits 类 action（command 类仍只返回描述，绝不隐式执行）。
    ///
    /// 请求前先拉取当前文件诊断（pull，带服务器端增量）作为
    /// CodeActionContext.diagnostics——quickfix 类 action 依赖它。
    pub async fn code_actions(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
        only: Option<Vec<lsp_types::CodeActionKind>>,
        apply: bool,
    ) -> Result<Value, LspError> {
        let diagnostics = {
            let uri = lsp_types::Url::from_file_path(path)
                .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
            // 双轨合并（与 spawn_await_task 的 prepare 语义一致，H4/R1.3）：
            // pull 诊断 + push store 中该 uri 的条目——rust-analyzer 的 rustc/cargo
            // 类型错误诊断只走 push（publishDiagnostics），只靠 pull 拿不到，
            // quickfix（auto-import / replace-with）会因此缺失。
            // 只合并当前 generation 的 push 条目（M6/R4.3，陈旧防护）。
            let mut diagnostics = client::pull_diagnostics(&mut self.socket, &uri, REQUEST_TIMEOUT)
                .await?
                .unwrap_or_default();
            let current_generation = self.push_generation.load(Ordering::Acquire);
            if let Some(entry) = self.push_diagnostics.lock().await.get(&client::uri_key(&uri)) {
                if entry.generation == current_generation {
                    diagnostics.extend(entry.diagnostics.clone());
                }
            }
            dedup_diagnostics(&mut diagnostics);
            diagnostics
        };
        let result = client::code_actions(
            &mut self.socket,
            path,
            line,
            column,
            only,
            diagnostics,
            REQUEST_TIMEOUT,
        )
        .await?;
        self.touch();
        let actions = result.unwrap_or_default();
        if !apply {
            return Ok(format::code_actions_to_value(&self.lang, actions));
        }
        let mut applied: Vec<Value> = Vec::new();
        let mut deferred: Vec<Value> = Vec::new();
        for action in actions {
            match action {
                CodeActionOrCommand::CodeAction(ca) => {
                    if let Some(edit) = ca.edit {
                        let files = apply_workspace_edit(self, &edit).await?;
                        applied.push(json!({
                            "title": ca.title,
                            "kind": ca.kind.as_ref().map(|k| k.as_str().to_string()),
                            "changeCount": files.len(),
                            "files": files,
                        }));
                    } else if let Some(command) = ca.command {
                        deferred.push(json!({
                            "title": ca.title,
                            "command": command.command,
                            "arguments": command.arguments,
                            "executed": false,
                        }));
                    } else {
                        deferred.push(json!({
                            "title": ca.title,
                            "note": "action 无 edit/command，无法自动应用",
                        }));
                    }
                }
                CodeActionOrCommand::Command(command) => {
                    deferred.push(json!({
                        "title": command.title,
                        "command": command.command,
                        "arguments": command.arguments,
                        "executed": false,
                    }));
                }
            }
        }
        Ok(json!({
            "language": self.lang,
            "apply": true,
            "appliedCount": applied.len(),
            "applied": applied,
            "deferredCommands": deferred,
        }))
    }

    /// typeDefinition 查询（跳到符号「类型」的定义；输出与 definition 对齐）。
    pub async fn type_definition(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        let response =
            client::type_definition(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// implementation 查询（接口/抽象类的实现跳转；输出与 definition 对齐）。
    pub async fn implementation(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        let response =
            client::implementation(&mut self.socket, path, line, column, REQUEST_TIMEOUT).await?;
        self.touch();
        let name = self.symbol_at(path, line, column).await;
        Ok(format::definition_to_value(&self.lang, &name, response))
    }

    /// callHierarchy 查询（LSP 3.16，双向调用链）：
    /// incoming = 谁调用了该函数（调用者 + 调用点上下文）；outgoing = 该函数调用了谁。
    /// 一次调用拿全，agent 改前影响分析无需递归 references。
    pub async fn call_hierarchy(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        let items =
            client::prepare_call_hierarchy(&mut self.socket, path, line, column, REQUEST_TIMEOUT)
                .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let Some(first) = items.and_then(|items| items.into_iter().next()) else {
            return Ok(format::call_hierarchy_empty(&self.lang, &symbol));
        };
        let incoming = client::call_hierarchy_incoming_calls(
            &mut self.socket,
            first.clone(),
            REQUEST_TIMEOUT,
        )
        .await?
        .unwrap_or_default();
        let outgoing = client::call_hierarchy_outgoing_calls(&mut self.socket, first, REQUEST_TIMEOUT)
            .await?
            .unwrap_or_default();
        let incoming_contexts = read_incoming_call_contexts(&incoming, MAX_REFERENCES).await;
        let outgoing_contexts = read_outgoing_call_contexts(path, &outgoing, MAX_REFERENCES).await;
        let caller_path = path
            .to_str()
            .map(|p| p.to_string())
            .unwrap_or_default();
        Ok(format::call_hierarchy_to_value(
            &self.lang,
            &symbol,
            &caller_path,
            &incoming,
            &incoming_contexts,
            &outgoing,
            &outgoing_contexts,
        ))
    }

    /// typeHierarchy 查询（LSP 3.17）：supertypes 父类型链 + subtypes 全部子类型。
    pub async fn type_hierarchy(
        &mut self,
        path: &Path,
        line: u32,
        column: u32,
    ) -> Result<Value, LspError> {
        let items =
            client::prepare_type_hierarchy(&mut self.socket, path, line, column, REQUEST_TIMEOUT)
                .await?;
        self.touch();
        let symbol = self.symbol_at(path, line, column).await;
        let Some(first) = items.and_then(|items| items.into_iter().next()) else {
            return Ok(format::type_hierarchy_empty(&self.lang, &symbol));
        };
        let supertypes = client::type_hierarchy_supertypes(&mut self.socket, first.clone(), REQUEST_TIMEOUT)
            .await?
            .unwrap_or_default();
        let subtypes = client::type_hierarchy_subtypes(&mut self.socket, first, REQUEST_TIMEOUT)
            .await?
            .unwrap_or_default();
        Ok(format::type_hierarchy_to_value(
            &self.lang,
            &symbol,
            &supertypes,
            &subtypes,
        ))
    }

    /// workspace/executeCommand：执行服务器定义命令（重构/导入/SSR 等）。
    ///
    /// 命令名与参数为服务器私有格式——agent 通常从 `lsp-code-action` 返回的
    /// action.command + arguments 原样透传。结果若是 WorkspaceEdit（如
    /// rust-analyzer.applySourceChange）→ dryRun 默认预览多文件 edits、false
    /// 应用写盘 + didChange 同步；其他结果原样返回。
    pub async fn execute_command(
        &mut self,
        command: &str,
        arguments: Vec<Value>,
        dry_run: bool,
    ) -> Result<Value, LspError> {
        let result =
            client::execute_command(&mut self.socket, command, arguments, REQUEST_TIMEOUT).await?;
        self.touch();
        let Some(value) = result else {
            return Ok(json!({
                "language": self.lang,
                "command": command,
                "result": null,
            }));
        };
        // 尝试识别 WorkspaceEdit（服务器命令最常见的结构化返回）。
        if let Ok(edit) = serde_json::from_value::<WorkspaceEdit>(value.clone()) {
            // 空 WorkspaceEdit：任意 JSON 对象都会被 serde 解析成空编辑
            //（三字段全 Option，未知字段默认忽略），必须视为非 WorkspaceEdit，
            // 原样返回服务器结果——否则 dryRun=false 会谎报 applied:true（H2/R1.1）。
            if format::workspace_edit_is_empty(&edit) {
                return Ok(json!({
                    "language": self.lang,
                    "command": command,
                    "result": value,
                }));
            }
            if dry_run {
                let mut preview = format::workspace_edit_to_value(&edit);
                preview["language"] = json!(self.lang);
                preview["command"] = json!(command);
                preview["applied"] = json!(false);
                preview["dryRun"] = json!(true);
                return Ok(preview);
            }
            let files = apply_workspace_edit(self, &edit).await?;
            return Ok(json!({
                "language": self.lang,
                "command": command,
                "applied": true,
                "dryRun": false,
                "changeCount": files.len(),
                "files": files,
            }));
        }
        // 非 WorkspaceEdit：原样返回服务器结果（可能含光标移动等附加信息）。
        Ok(json!({
            "language": self.lang,
            "command": command,
            "result": value,
        }))
    }

    /// workspaceSymbol 查询（跨文件按名搜索符号；无需 didOpen，输出上限 50）。
    pub async fn workspace_symbols(&mut self, query: &str) -> Result<Value, LspError> {
        let response = client::workspace_symbols(&mut self.socket, query, REQUEST_TIMEOUT).await?;
        self.touch();
        Ok(format::workspace_symbols_to_value(
            &self.lang,
            query,
            &self.project_root,
            response,
        ))
    }

    /// 项目级诊断（LSP 3.17 workspace/diagnostic pull）：一次返回全项目诊断。
    /// 服务器不支持该能力（Ok(None)）→ 返回空 files + 明确 summary。
    /// 输出上限：max_files 文件 × 200 诊断/文件（防输出爆炸，M4/R3.2）。
    pub async fn workspace_diagnostics(&mut self, max_files: usize) -> Result<Value, LspError> {
        let result = client::workspace_diagnostics(&mut self.socket, PUSH_TIMEOUT).await?;
        self.touch();

        let Some(files) = result else {
            return Ok(json!({
                "language": self.lang,
                "server": self.config.command,
                "summary": "workspace diagnostics not supported by this server",
                "files": [],
            }));
        };

        let mut out_files: Vec<Value> = Vec::new();
        let mut total_errors: usize = 0;
        let mut total_warnings: usize = 0;
        for (uri, diagnostics) in files.into_iter().take(max_files) {
            let path = uri
                .to_file_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| uri.to_string());
            let (errors, warnings) = count_severities(&diagnostics);
            total_errors += errors;
            total_warnings += warnings;
            let items: Vec<Value> = diagnostics
                .iter()
                .take(200)
                .map(format::diagnostic_to_json)
                .collect();
            out_files.push(json!({
                "filePath": path,
                "summary": format::diagnostics_summary(&diagnostics),
                "diagnostics": items,
            }));
        }

        Ok(json!({
            "language": self.lang,
            "server": self.config.command,
            "summary": format!(
                "{total_errors} errors, {total_warnings} warnings across {} file(s)",
                out_files.len()
            ),
            "files": out_files,
        }))
    }

    /// 提取 (line, column) 处的标识符（1-indexed；简单边界扫描，无 regex 依赖）。
    async fn symbol_at(&self, path: &Path, line: u32, column: u32) -> String {
        let Ok(text) = self.read_file_text(path).await else {
            return String::new();
        };
        let Some(source_line) = text.lines().nth(line.saturating_sub(1) as usize) else {
            return String::new();
        };
        extract_identifier_at(source_line, column.saturating_sub(1) as usize)
    }

    /// 诊断准备阶段（锁内调用）：DB 缓存指纹检查 + ensure_open + didChange + didSave。
    ///
    /// - 缓存命中（mtime_ms + size 一致）→ `PrepareResult::Cached`：毫秒级返回，
    ///   语言服务器零参与（含冷启动跳过）。
    /// - 未命中 → didChange（版本递增、全量内容）触发重新分析 + didSave 触发
    ///   flycheck（pull 能力服务器），返回 `PrepareResult::Pending` 供并发等待。
    pub async fn prepare_diagnostics(
        &mut self,
        path: &Path,
    ) -> Result<PrepareResult, LspError> {
        if let Some(value) = self.cached_diagnostics(path).await {
            self.touch();
            return Ok(PrepareResult::Cached(value));
        }

        self.ensure_open(path).await?;
        let uri = lsp_types::Url::from_file_path(path)
            .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;

        let version = self.opened_files.get(path).copied().unwrap_or(1) + 1;
        let text = self.read_file_text(path).await?;
        // 先移除 push store 旧 key：否则 wait_push 会立即返回上次诊断的旧结果
        //（key 存在即返回，不区分内容新旧——重复诊断 bug，2026-08-14 修复）。
        // 递增 generation（M6/R4.3）：remove 与递增原子相邻——旧 push 条目即使
        // 因并发未及时 remove，也会因 generation 不匹配而失效。
        self.push_generation.fetch_add(1, Ordering::AcqRel);
        self.push_diagnostics.lock().await.remove(&client::uri_key(&uri));
        client::did_change(&mut self.socket, path, version, &text).await?;
        self.opened_files.insert(path.to_path_buf(), version);
        if self.pull_diagnostics_supported {
            client::did_save(&mut self.socket, path, &text).await?;
        }

        Ok(PrepareResult::Pending(PendingDiagnostics {
            path: path.to_path_buf(),
            uri,
        }))
    }

    /// 生成诊断等待任务（锁外并发）：socket / push store 克隆进 task，
    /// 不持有会话锁，批量诊断可并行等待。
    ///
    /// - 声明 diagnosticProvider（rust-analyzer）：**push + pull 合并**——
    ///   rustc/cargo 诊断（类型错误等）只走 push（publishDiagnostics，didSave
    ///   触发），rust-analyzer 原生诊断走 pull，两者不重叠（#18709）。
    /// - 未声明（gopls 等）：纯 push。
    pub fn spawn_await_task(
        &self,
        pending: &PendingDiagnostics,
    ) -> tokio::task::JoinHandle<Result<Value, LspError>> {
        let mut socket = self.socket.clone();
        let push_store = self.push_diagnostics.clone();
        let push_generation = self.push_generation.clone();
        let pull_supported = self.pull_diagnostics_supported;
        let uri = pending.uri.clone();
        let lang = self.lang.clone();
        let command = self.config.command.clone();
        tokio::spawn(async move {
            let items = if pull_supported {
                // 事件驱动：不固定 sleep——push 到达或 pull 有结果即返回。
                let push_future =
                    client::wait_push_diagnostics(&push_store, &push_generation, &uri, PUSH_TIMEOUT);
                let pull_future = pull_diagnostics_with_retry(&mut socket, &uri);
                let (pushed, pulled) = tokio::join!(push_future, pull_future);
                let mut merged = pushed?;
                merged.extend(pulled?);
                dedup_diagnostics(&mut merged);
                merged
            } else {
                client::wait_push_diagnostics(&push_store, &push_generation, &uri, PUSH_TIMEOUT)
                    .await?
            };
            Ok(format::diagnostics_to_value(&lang, &command, items))
        })
    }

    /// 诊断结果写回（锁内调用）：DB 持久化缓存 upsert；失败降级（不阻断）。
    pub async fn store_diagnostics(&mut self, path: &Path, value: &Value) {
        self.store_cached_diagnostics(path, value).await;
        self.touch();
    }

    /// 标记最近使用（供空闲回收 / LRU 淘汰）。
    pub fn touch(&self) {
        self.last_used_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// 查询子进程是否已退出（同步、非阻塞）：返回退出码；`None` = 仍在运行。
    /// 供状态快照检测「进程崩溃但会话未标记 dead」的情况（§7.1 懒标记）。
    pub fn exited_code(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => status.code(),
            _ => None,
        }
    }

    /// 优雅关闭：shutdown → 等待退出（≤3s）→ kill 兜底。
    pub async fn shutdown(&mut self) {
        self.dead = true;
        let _ = self.socket.shutdown(()).await;
        let _ = self.socket.exit(());
        // 等待进程退出（≤3s），超时 kill。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if tokio::time::Instant::now() >= deadline {
                let _ = self.child.kill().await;
                break;
            }
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = self.child.kill().await;
    }
}

/// 诊断准备结果：缓存命中（直接返回）或待等待（并发拉取）。
pub enum PrepareResult {
    Cached(Value),
    Pending(PendingDiagnostics),
}

/// 待等待的诊断（锁外并发所需的最小信息集）。
pub struct PendingDiagnostics {
    pub path: PathBuf,
    pub uri: lsp_types::Url,
}

/// pull 轮询：LSP 3.17 pull 语义为「返回当前状态」——didChange 后分析
/// 未完成时返回空，轮询直到有结果（最多 ~8 次 × 500ms 首次立即）；服务器取消
/// （-32802）按规范重发。
async fn pull_diagnostics_with_retry(
    socket: &mut async_lsp::ServerSocket,
    uri: &lsp_types::Url,
) -> Result<Vec<Diagnostic>, LspError> {
    for attempt in 0..8 {
        match client::pull_diagnostics(socket, uri, REQUEST_TIMEOUT).await {
            Ok(Some(list)) => {
                if !list.is_empty() || attempt == 7 {
                    return Ok(list);
                }
            }
            Ok(None) => {
                // 服务器能力声明了 pull 但请求返回 MethodNotFound（罕见）：
                // 回退 push（调用方无 push store，返回空——由调用方决定）。
                return Ok(Vec::new());
            }
            // -32802 server cancelled：按 LSP 规范重发请求。
            Err(LspError::ServerFailed(message)) if message.contains("cancelled") => {}
            Err(error) => return Err(error),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Ok(Vec::new())
}

impl ServerSession {
    /// 诊断缓存键（M6/R4.3）：lang + 服务器命令 + 文件路径——切换 LSP 配置后
    /// 不得命中另一服务器的旧缓存。表结构不变（file_path 仍为主键），仅调用方
    /// 拼键；旧无前缀缓存行自然失效（键不匹配，LRU 清理回收）。
    fn cache_key(&self, path: &Path) -> String {
        format!(
            "{}\u{1F}{}\u{1F}{}",
            self.lang,
            self.config.command,
            path.to_string_lossy()
        )
    }

    /// 读 DB 诊断缓存：指纹（mtime_ms, size）一致返回结果 JSON；任何失败降级为 None
    /// （缓存只是加速层，正确性不依赖它）。同步 fs::metadata + SQLite 移入
    /// spawn_blocking，不阻塞 tokio worker（M7/R3.3）；JoinError（任务 panic）
    /// 同样降级为 None（缓存未命中 → 走完整诊断流程）。
    async fn cached_diagnostics(&self, path: &Path) -> Option<Value> {
        let key = self.cache_key(path);
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let storage_info = crate::storage::initialize_app_storage().ok()?;
            let db_path = std::path::PathBuf::from(storage_info.database_path);
            let metadata = std::fs::metadata(&path).ok()?;
            let mtime_ms = metadata
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            let size = metadata.len() as i64;

            let entry = crate::storage::services::lsp_diagnostic_cache::get(&db_path, &key).ok()??;
            if entry.mtime_ms == mtime_ms && entry.size == size {
                serde_json::from_str(&entry.result_json).ok()
            } else {
                None
            }
        })
        .await
        .ok()
        .flatten()
    }

    /// 写 DB 诊断缓存（指纹 + 结果 JSON）；任何失败静默降级（不阻断诊断流程）。
    /// 同步 fs::metadata + SQLite 移入 spawn_blocking（M7/R3.3）。
    async fn store_cached_diagnostics(&self, path: &Path, value: &Value) {
        let key = self.cache_key(path);
        let path = path.to_path_buf();
        let Ok(result_json) = serde_json::to_string(value) else {
            return;
        };
        tokio::task::spawn_blocking(move || {
            let Ok(storage_info) = crate::storage::initialize_app_storage() else {
                return;
            };
            let db_path = std::path::PathBuf::from(storage_info.database_path);
            let Ok(metadata) = std::fs::metadata(&path) else {
                return;
            };
            let Ok(mtime) = metadata.modified() else {
                return;
            };
            let Ok(mtime_ms) = mtime.duration_since(std::time::UNIX_EPOCH) else {
                return;
            };
            let _ = crate::storage::services::lsp_diagnostic_cache::upsert(
                &db_path,
                &key,
                mtime_ms.as_millis() as i64,
                metadata.len() as i64,
                &result_json,
            );
        })
        .await
        .ok();
    }

    /// 失效 DB 诊断缓存（文件被外部写盘后调用，如 format/rename/code-action 落盘）。
    /// SQLite 操作移入 spawn_blocking（M7/R3.3）。
    async fn invalidate_cached_diagnostics(&self, path: &Path) {
        let key = self.cache_key(path);
        tokio::task::spawn_blocking(move || {
            let Ok(storage_info) = crate::storage::initialize_app_storage() else {
                return;
            };
            let db_path = std::path::PathBuf::from(storage_info.database_path);
            let _ = crate::storage::services::lsp_diagnostic_cache::remove(&db_path, &key);
        })
        .await
        .ok();
    }
}

/// 在项目根下寻找代表性入口文件（常见入口优先，其次根目录第一层扫描）。
/// 供会话预热 / TS 项目上下文建立使用。
fn find_project_entry(project_root: &Path, extensions: &[&str]) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "src/main.ts",
        "src/index.ts",
        "main.ts",
        "index.ts",
        "src/main.tsx",
        "src/index.tsx",
        "main.tsx",
        "index.tsx",
    ];
    for candidate in CANDIDATES {
        let path = project_root.join(candidate);
        if path.is_file() {
            return Some(path);
        }
    }
    // 根目录第一层扫描（非递归），找第一个扩展名匹配的文件。
    if let Ok(entries) = std::fs::read_dir(project_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|ext| extensions.iter().any(|wanted| ext.eq_ignore_ascii_case(wanted)))
                    .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }
    None
}

/// 诊断去重（push 与 pull 可能重叠）：按 (起始行, 起始列, 消息) 去重。
fn dedup_diagnostics(diagnostics: &mut Vec<Diagnostic>) {
    let mut seen = std::collections::HashSet::new();
    diagnostics.retain(|d| {
        seen.insert((d.range.start.line, d.range.start.character, d.message.clone()))
    });
}

/// 统计诊断 severity 数量（1=error, 2=warning；其余忽略）。
fn count_severities(diagnostics: &[Diagnostic]) -> (usize, usize) {
    let mut errors = 0usize;
    let mut warnings = 0usize;
    for item in diagnostics {
        match item.severity {
            Some(lsp_types::DiagnosticSeverity::ERROR) => errors += 1,
            Some(lsp_types::DiagnosticSeverity::WARNING) => warnings += 1,
            _ => {}
        }
    }
    (errors, warnings)
}

// ---------------------------------------------------------------------------
// Phase 3 工具辅助（definition/references/symbols/format）
// ---------------------------------------------------------------------------

fn is_ident_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 从代码行提取 column（0-indexed）处的标识符（简单边界扫描，无 regex 依赖）。
fn extract_identifier_at(line: &str, column: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || column >= chars.len() || !is_ident_char(chars[column]) {
        return String::new();
    }
    let mut start = column;
    let mut end = column;
    while start > 0 && is_ident_char(chars[start - 1]) {
        start -= 1;
    }
    while end < chars.len() && is_ident_char(chars[end]) {
        end += 1;
    }
    chars[start..end].iter().collect()
}

/// 读取每个引用位置的上下文行（trim，最多 max 条；读取失败留空）。
async fn read_reference_contexts(locations: &[Location], max: usize) -> Vec<String> {
    let mut contexts = Vec::with_capacity(locations.len().min(max));
    for location in locations.iter().take(max) {
        let context = match location.uri.to_file_path() {
            Ok(path) => read_line_context(&path, location.range.start.line).await,
            Err(_) => String::new(),
        };
        contexts.push(context);
    }
    contexts
}

/// 读取指定行（0-indexed）的 trim 文本。
async fn read_line_context(path: &Path, line: u32) -> String {
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return String::new();
    };
    text.lines()
        .nth(line as usize)
        .map(|l| l.trim().to_string())
        .unwrap_or_default()
}

/// 读取 incoming call 每个调用点的上下文行（调用点位于调用者 from.uri 文件，最多 max 条）。
async fn read_incoming_call_contexts(
    calls: &[CallHierarchyIncomingCall],
    max: usize,
) -> Vec<Vec<String>> {
    let mut all = Vec::with_capacity(calls.len().min(max));
    for call in calls.iter().take(max) {
        let mut contexts = Vec::with_capacity(call.from_ranges.len());
        let path = call.from.uri.to_file_path().ok();
        for range in call.from_ranges.iter() {
            let context = match &path {
                Some(path) => read_line_context(path, range.start.line).await,
                None => String::new(),
            };
            contexts.push(context);
        }
        all.push(contexts);
    }
    all
}

/// 读取 outgoing call 每个调用点的上下文行（调用点位于**调用者**文件，即
/// prepare 时选中的当前文件；最多 max 条）。
async fn read_outgoing_call_contexts(
    caller_path: &Path,
    calls: &[CallHierarchyOutgoingCall],
    max: usize,
) -> Vec<Vec<String>> {
    let mut all = Vec::with_capacity(calls.len().min(max));
    for call in calls.iter().take(max) {
        let mut contexts = Vec::with_capacity(call.from_ranges.len());
        for range in call.from_ranges.iter() {
            contexts.push(read_line_context(caller_path, range.start.line).await);
        }
        all.push(contexts);
    }
    all
}

/// 应用 LSP TextEdit 列表到文本（edits 按范围升序；从后往前应用保证偏移有效）。
fn apply_edits(text: &str, edits: &[TextEdit]) -> String {
    let chars: Vec<char> = text.chars().collect();

    // 每行的 char 起始偏移（含换行符位置计算）。
    let mut line_starts = vec![0usize];
    for (index, c) in chars.iter().enumerate() {
        if *c == '\n' {
            line_starts.push(index + 1);
        }
    }

    // 预计算所有 (start, end, new_text)（基于原始文本偏移，从后往前应用互不影响）。
    let mut planned: Vec<(usize, usize, Vec<char>)> = edits
        .iter()
        .map(|edit| {
            let start = offset_of(&line_starts, chars.len(), edit.range.start.line, edit.range.start.character);
            let end = offset_of(&line_starts, chars.len(), edit.range.end.line, edit.range.end.character);
            (start, end, edit.new_text.chars().collect())
        })
        .collect();
    planned.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));

    let mut result = chars;
    for (start, end, new_chars) in planned {
        if end < start {
            continue;
        }
        result.splice(start..end, new_chars);
    }

    result.into_iter().collect()
}

/// (line, character) → char 偏移（越界 clamp 到行尾/文件尾）。
fn offset_of(line_starts: &[usize], total_len: usize, line: u32, character: u32) -> usize {
    let line_index = (line as usize).min(line_starts.len().saturating_sub(1));
    let start = line_starts[line_index];
    let line_end = if line_index + 1 < line_starts.len() {
        line_starts[line_index + 1].saturating_sub(1)
    } else {
        total_len
    };
    start.saturating_add(character as usize).min(line_end)
}

/// 应用 WorkspaceEdit 到文件系统（多文件，rename / codeAction 共用）：
/// 读原文 → apply_edits → 有变化才写回；已打开的文件同步 didChange（版本递增）。
/// 返回每文件应用摘要。单个文件失败即报错（不静默），已应用文件不回滚。
async fn apply_workspace_edit(
    session: &mut ServerSession,
    edit: &WorkspaceEdit,
) -> Result<Vec<Value>, LspError> {
    let mut files: Vec<Value> = Vec::new();
    // Operations 类变更（create/rename/delete file）→ Unsupported 错误透传
    //（R1.2）：rename / code-action(apply) / execute-command 三条路径统一经此
    // 上报「文件操作未执行」，agent 不再看到 applied:true, changeCount:0。
    for (uri, edits) in format::workspace_edit_files(edit)? {
        let Ok(file_path) = uri.to_file_path() else {
            continue;
        };
        let text = session.read_file_text(&file_path).await?;
        let formatted = apply_edits(&text, &edits);
        let changed = formatted != text;
        if changed {
            tokio::fs::write(&file_path, &formatted)
                .await
                .map_err(|error| {
                    LspError::Internal(format!("write workspace-edit file failed: {error}"))
                })?;
            // 文件已变：DB 诊断缓存失效（下次诊断重新分析）。
            session.invalidate_cached_diagnostics(&file_path).await;
            // 已打开的文件：didChange 同步新内容（版本递增）。
            if let Some(version) = session.opened_files.get(&file_path).copied() {
                let next_version = version + 1;
                client::did_change(&mut session.socket, &file_path, next_version, &formatted)
                    .await?;
                session.opened_files.insert(file_path.clone(), next_version);
            }
        }
        files.push(json!({
            "uri": uri.to_string(),
            "editCount": edits.len(),
            "applied": changed,
        }));
    }
    Ok(files)
}
