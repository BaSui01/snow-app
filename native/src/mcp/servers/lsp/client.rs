//! LSP 协议客户端封装：进程 spawn、initialize、didOpen、hover、diagnostics、
//! definition / references / documentSymbol。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_lsp::router::Router;
use async_lsp::{ErrorCode, LanguageServer, MainLoop};
use lsp_types::notification::{LogMessage, Progress, PublishDiagnostics, ShowMessage, TelemetryEvent};
use lsp_types::request::{WorkspaceConfiguration, WorkspaceFoldersRequest};
use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem,
    CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    ClientCapabilities, CodeActionContext, CodeActionKind, CodeActionOrCommand, CodeActionParams,
    CodeActionTriggerKind, Diagnostic, DidChangeTextDocumentParams, DidOpenTextDocumentParams,
    DidSaveTextDocumentParams, DocumentDiagnosticParams, DocumentDiagnosticReport,
    DocumentSymbolParams, DocumentSymbolResponse, ExecuteCommandParams, GotoDefinitionParams,
    GotoDefinitionResponse, Hover, HoverParams, InitializeParams, InitializedParams, Location,
    PartialResultParams, Position, ProgressParams, Range, ReferenceContext, ReferenceParams,
    RenameParams, TextDocumentClientCapabilities, TextDocumentContentChangeEvent,
    TextDocumentIdentifier, TextDocumentItem, TextDocumentPositionParams, TypeHierarchyItem,
    TypeHierarchyPrepareParams, TypeHierarchySubtypesParams, TypeHierarchySupertypesParams, Url,
    VersionedTextDocumentIdentifier, WorkDoneProgressParams, WorkspaceEdit, WorkspaceFolder,
    WorkspaceSymbolParams, WorkspaceSymbolResponse,
};
use tokio::sync::Mutex;

#[cfg(windows)]
use super::probe;
use super::types::{LspError, ServerConfig};
use crate::utils::process_tree::ProcessTreeGuard;

/// push 诊断共享状态：uri key -> (generation, 诊断列表)。
///
/// generation 陈旧防护（M6/R4.3）：每次 prepare_diagnostics / didChange 递增
/// session 级 push_generation，push 写入带当时 generation；读取/合并只接受
/// generation == 当前值的条目——旧分析结果（慢速 rustc 诊断）不得被当作新鲜
/// 诊断返回。
pub type PushDiagnostics = Arc<Mutex<HashMap<String, PushEntry>>>;

/// push store 单条条目。
#[derive(Debug, Clone)]
pub struct PushEntry {
    /// 写入时的 session 级 generation（与 push_generation 比较判陈旧）。
    pub generation: u64,
    pub diagnostics: Vec<Diagnostic>,
}

/// 统一的 uri key：Windows 路径大小写不敏感（rust-analyzer 推
/// `file:///c:/...`，Url::from_file_path 生成 `file:///C:/...`），
/// 统一转小写保证匹配。
pub fn uri_key(uri: &Url) -> String {
    match uri.to_file_path() {
        Ok(path) => path
            .to_str()
            .map(|p| {
                #[cfg(windows)]
                {
                    p.to_lowercase()
                }
                #[cfg(not(windows))]
                {
                    p.to_string()
                }
            })
            .unwrap_or_else(|| uri.as_str().to_string()),
        Err(_) => uri.as_str().to_string(),
    }
}

/// JVM 系服务器启动超时（附录 B / §7.3）。
pub fn initialize_timeout_for(lang: &str) -> Duration {
    if matches!(lang, "java" | "kotlin") {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(30)
    }
}

/// 生成 LSP 语言标识（didOpen 用）。
pub fn language_id_for(lang: &str) -> String {
    match lang {
        "typescript" => "typescript".into(),
        "python" => "python".into(),
        "go" => "go".into(),
        "rust" => "rust".into(),
        "c" => "c".into(),
        "csharp" => "csharp".into(),
        "java" => "java".into(),
        "kotlin" => "kotlin".into(),
        "php" => "php".into(),
        "ruby" => "ruby".into(),
        "swift" => "swift".into(),
        "lua" => "lua".into(),
        other => other.to_string(),
    }
}

/// Windows 上解析 spawn 命令。npm 全局二进制是 .cmd/.ps1 shim（无 .exe），
/// CreateProcess 无法直接执行；返回 (program, args) 供 Command 使用（A1）。
///
/// - `.cmd/.bat`：`cmd.exe /d /s /c call "path" args...`——`call` 前缀 + 每个参数
///   作为独立 argv 元素，规避 cmd 的引号解析陷阱（Rust 会把含空格参数包成
///   `"..."`，行首非引号时 cmd 不做引号剥离，`call` 正确接收带引号路径）。
/// - `.ps1`：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File path args...`。
/// - 其他（.exe/.com/无扩展名）：直跑。
#[cfg(windows)]
fn resolve_windows_spawn(
    command: &str,
    args: &[String],
) -> std::io::Result<(String, Vec<String>)> {
    use std::io::ErrorKind;

    // probe::resolve_command 按 PATHEXT(+.PS1) 返回首个存在的候选；找不到 →
    // NotFound（保持现有 ServerMissing 降级路径，含 install_command 提示）。
    let Some(mut path) = probe::resolve_command(command) else {
        return Err(std::io::Error::from(ErrorKind::NotFound));
    };

    // npm cmd-shim 会额外生成无扩展名的 sh 脚本（排在 PATHEXT 候选之前，probe
    // 先命中它），CreateProcess 无法执行：改选同名 shim（.cmd/.bat/.ps1）。
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".exe")
        || lower.ends_with(".com")
        || lower.ends_with(".cmd")
        || lower.ends_with(".bat")
        || lower.ends_with(".ps1"))
    {
        for shim_ext in [".cmd", ".bat", ".ps1"] {
            let candidate = format!("{path}{shim_ext}");
            if Path::new(&candidate).is_file() {
                path = candidate;
                break;
            }
        }
    }

    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut full = vec!["/d".into(), "/s".into(), "/c".into(), "call".into(), path];
        full.extend(args.iter().map(|arg| escape_cmd_arg(arg)));
        Ok(("cmd.exe".into(), full))
    } else if lower.ends_with(".ps1") {
        let mut full = vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            path,
        ];
        full.extend(args.iter().cloned());
        Ok(("powershell.exe".into(), full))
    } else {
        // .exe/.com/无扩展名可执行文件。
        Ok((path, args.to_vec()))
    }
}

/// cmd.exe 命令行参数转义：`^` → `^^`、`"` → `^"`（cmd 的转义符是 `^` 而非
/// 反斜杠；参数内出现这两个字符会被 cmd 解析吞掉或打断引号。罕见但防炸）。
#[cfg(windows)]
fn escape_cmd_arg(arg: &str) -> String {
    arg.replace('^', "^^").replace('"', "^\"")
}

/// spawn 语言服务器进程并建立 async-lsp 客户端。
///
/// 返回 (子进程句柄, mainloop 任务, 客户端 socket, push 诊断共享状态,
/// mainloop 完成标志, push generation 计数器, 进程树回收 guard)。mainloop 完成
/// 标志用于会话死亡检测（M5/R2.2）；push generation 随会话创建（M6/R4.3）；
/// ProcessTreeGuard（M2/R4.1，Job Object / 进程组）在会话销毁时兜底杀整棵树，
/// 消除 cmd/powershell shim 后代孤儿进程（构造失败仅告警，不失败）。
pub fn spawn_client(
    config: &ServerConfig,
    project_root: &Path,
) -> std::io::Result<(
    tokio::process::Child,
    tokio::task::JoinHandle<()>,
    async_lsp::ServerSocket,
    PushDiagnostics,
    Arc<AtomicBool>,
    Arc<AtomicU64>,
    ProcessTreeGuard,
)> {
    // Windows：npm 全局二进制是 .cmd/.ps1 shim（无 .exe），CreateProcess 无法直接
    // 执行，需按 PATHEXT 解析候选并包装（A1）；非 Windows 保持原样。
    #[cfg(windows)]
    let (program, parsed_args) = resolve_windows_spawn(&config.command, &config.args)?;
    #[cfg(not(windows))]
    let (program, parsed_args) = (config.command.clone(), config.args.clone());

    let mut command = tokio::process::Command::new(program);
    command
        .args(parsed_args)
        .current_dir(project_root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: 防止服务器进程弹出黑窗（tokio Command 自带方法）。
        command.creation_flags(0x0800_0000);
    }

    // Unix：子进程设为独立进程组组长（pgid == pid），进程树 guard 用
    // kill(-pgid) 回收整棵树（与 external MCP 一致，M2/R4.1）。
    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    // M2/R4.1：接入进程树回收（Windows Job Object / Unix 进程组），与 external
    // MCP 一致；构造失败仅告警（guard 内部降级，不阻断 spawn）。
    // id() 为 None（进程已退出）时 pid 0 → guard 为无害空操作。
    let process_tree_guard = ProcessTreeGuard::new(&config.lang, child.id().unwrap_or(0));
    let stdout = child.stdout.take().expect("stdout piped");
    let stdin = child.stdin.take().expect("stdin piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let lang_for_stderr = config.lang.clone();
    let lang_for_mainloop = config.lang.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = stderr;
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buffer[..n]);
                    for line in text.lines() {
                        eprintln!("[lsp:{lang_for_stderr}] {line}");
                    }
                }
            }
        }
    });

    // push 诊断收集（fallback 路径）。generation 计数器随会话创建，session 持有；
    // mainloop 写入时读当前值——prepare/didChange 递增后旧 push 自然失效（M6）。
    let push_diagnostics: PushDiagnostics = Arc::new(Mutex::new(HashMap::new()));
    let push_clone = push_diagnostics.clone();
    let push_generation = Arc::new(AtomicU64::new(0));
    let push_generation_clone = push_generation.clone();

    let (mainloop, socket) = MainLoop::new_client(move |_socket| {
        let mut router = Router::new(());
        // 未注册的普通通知会终止 mainloop（Router 默认 Break）——必须覆盖
        // 常见通知：诊断收集 + showMessage/logMessage/telemetry 记日志。
        router.notification::<PublishDiagnostics>(move |_, params| {
            let uri = params.uri.clone();
            let diagnostics = params.diagnostics.clone();
            let store = push_clone.clone();
            // 在通知处理同步段（而非写入 task 内）读取 generation：写入 task
            // 可能排队晚于 prepare_diagnostics 的 fetch_add 执行——若在写入时
            // 才 load，prepare 前到达的旧诊断会误带新 generation 被当作新鲜
            // 结果（M6/R4.3 陈旧防护失效）。捕获「通知到达时刻」的 generation
            // 才与递增语义一致：prepare 递增前的旧通知必然带旧值而失效。
            let generation = push_generation_clone.load(Ordering::Acquire);
            tokio::spawn(async move {
                store.lock().await.insert(
                    uri_key(&uri),
                    PushEntry {
                        generation,
                        diagnostics,
                    },
                );
            });
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<ShowMessage>(|_, params| {
            eprintln!("[lsp] showMessage: {:?}: {}", params.typ, params.message);
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<LogMessage>(|_, params| {
            eprintln!("[lsp] logMessage: {:?}: {}", params.typ, params.message);
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<TelemetryEvent>(|_, _| {
            std::ops::ControlFlow::Continue(())
        });
        router.notification::<Progress>(|_, params: ProgressParams| {
            if let lsp_types::NumberOrString::String(token) = &params.token {
                eprintln!("[lsp] progress: {token}");
            }
            std::ops::ControlFlow::Continue(())
        });
        // rust-analyzer 等请求 workspace/configuration 获取服务器设置：
        // 返回空数组 = 使用服务器默认配置（未处理会报
        // "No such method workspace/configuration"，诊断等功能可能降级）。
        router.request::<WorkspaceConfiguration, _>(|_, _params| async move {
            Ok(Vec::<serde_json::Value>::new())
        });
        // workspaceFolders：root 已通过 initialize 的 workspaceFolders 提供。
        router.request::<WorkspaceFoldersRequest, _>(|_, _params| async move { Ok(None) });
        router
    });

    let main_loop_done = Arc::new(AtomicBool::new(false));
    let done_flag = main_loop_done.clone();
    let mainloop_task = tokio::spawn(async move {
        use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
        if let Err(error) = mainloop.run_buffered(stdout.compat(), stdin.compat_write()).await {
            eprintln!("[lsp:{lang_for_mainloop}] mainloop ended: {error}");
        }
        // mainloop 结束 = 会话不可用（进程退出 / 管道断开）：置位供死亡检测。
        done_flag.store(true, Ordering::Release);
    });

    Ok((
        child,
        mainloop_task,
        socket,
        push_diagnostics,
        main_loop_done,
        push_generation,
        process_tree_guard,
    ))
}

/// LSP initialize 握手（带超时）。
///
/// 返回服务器是否声明 pull 诊断支持（diagnostic_provider），供诊断路径选择。
pub async fn initialize(
    socket: &mut async_lsp::ServerSocket,
    project_root: &Path,
    initialization_options: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<bool, LspError> {
    let workspace_uri = Url::from_file_path(project_root)
        .map_err(|_| LspError::Internal(format!("invalid project root: {}", project_root.display())))?;
    let params = InitializeParams {
        process_id: None,
        initialization_options,
        capabilities: ClientCapabilities {
            text_document: Some(TextDocumentClientCapabilities {
                diagnostic: Some(lsp_types::DiagnosticClientCapabilities {
                    dynamic_registration: None,
                    related_document_support: Some(true),
                }),
                ..Default::default()
            }),
            ..Default::default()
        },
        workspace_folders: Some(vec![WorkspaceFolder {
            uri: workspace_uri,
            name: "root".to_string(),
        }]),
        ..Default::default()
    };
    let result = tokio::time::timeout(timeout, socket.initialize(params))
        .await
        .map_err(|_| LspError::RequestTimeout("initialize".into()))?
        .map_err(|error| LspError::ServerFailed(format!("initialize failed: {error:?}")))?;
    let pull_diagnostics_supported = result.capabilities.diagnostic_provider.is_some();
    eprintln!(
        "[lsp] server={:?} pull_diagnostics={pull_diagnostics_supported}",
        result.server_info.as_ref().map(|i| i.name.clone())
    );
    socket
        .initialized(InitializedParams {})
        .map_err(|error| LspError::ServerFailed(format!("initialized failed: {error:?}")))?;
    // VS Code 等客户端必备：通知服务器应用配置（空配置，使用服务器默认）。
    socket
        .did_change_configuration(lsp_types::DidChangeConfigurationParams {
            settings: serde_json::json!({}),
        })
        .map_err(|error| LspError::ServerFailed(format!("didChangeConfiguration failed: {error:?}")))?;
    Ok(pull_diagnostics_supported)
}

/// 发送 didOpen（文件已确认未打开时）。
pub async fn did_open(
    socket: &mut async_lsp::ServerSocket,
    lang: &str,
    path: &Path,
    text: &str,
) -> Result<Url, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_open(DidOpenTextDocumentParams {
            text_document: TextDocumentItem {
                uri: uri.clone(),
                language_id: language_id_for(lang),
                version: 1,
                text: text.to_string(),
            },
        })
        .map_err(|error| LspError::ServerFailed(format!("didOpen failed: {error:?}")))?;
    Ok(uri)
}

/// 发送 didChange（version 递增，全量内容）——强制服务器重新诊断。
pub async fn did_change(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    version: i32,
    text: &str,
) -> Result<(), LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_change(DidChangeTextDocumentParams {
            text_document: VersionedTextDocumentIdentifier { uri, version },
            content_changes: vec![TextDocumentContentChangeEvent {
                range: None,
                range_length: None,
                text: text.to_string(),
            }],
        })
        .map_err(|error| LspError::ServerFailed(format!("didChange failed: {error:?}")))
}

/// 发送 didSave（带全文）——触发 flycheck 类诊断（rust-analyzer 的 rustc/cargo
/// 诊断只在保存后运行，见 rust-lang/rust-analyzer#18709）。
pub async fn did_save(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    text: &str,
) -> Result<(), LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    socket
        .did_save(DidSaveTextDocumentParams {
            text_document: TextDocumentIdentifier { uri },
            text: Some(text.to_string()),
        })
        .map_err(|error| LspError::ServerFailed(format!("didSave failed: {error:?}")))
}

/// hover 请求。
pub async fn hover(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Hover>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.hover(HoverParams {
        text_document_position_params: TextDocumentPositionParams {
            text_document: TextDocumentIdentifier { uri },
            position: Position {
                line: line.saturating_sub(1),
                character: column.saturating_sub(1),
            },
        },
        work_done_progress_params: WorkDoneProgressParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("hover".into()))?
    .map_err(|error| LspError::ServerFailed(format!("hover failed: {error:?}")))
}

/// pull 诊断（LSP 3.17 textDocument/diagnostic）。
///
/// 服务器不支持时返回 Ok(None)，调用方回退 push。
pub async fn pull_diagnostics(
    socket: &mut async_lsp::ServerSocket,
    uri: &Url,
    timeout: Duration,
) -> Result<Option<Vec<Diagnostic>>, LspError> {
    let result = tokio::time::timeout(timeout, socket.document_diagnostic(DocumentDiagnosticParams {
        text_document: TextDocumentIdentifier { uri: uri.clone() },
        identifier: None,
        previous_result_id: None,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("diagnostics".into()))?;

    match result {
        Ok(report) => match report {
            lsp_types::DocumentDiagnosticReportResult::Report(report) => {
                Ok(Some(extract_diagnostic_items(report)))
            }
            lsp_types::DocumentDiagnosticReportResult::Partial(_) => Ok(Some(Vec::new())),
        },
        Err(async_lsp::Error::Response(ref response_error))
            if response_error.code == ErrorCode::METHOD_NOT_FOUND =>
        {
            Ok(None)
        }
        Err(error) => Err(LspError::ServerFailed(format!("diagnostics failed: {error:?}"))),
    }
}

/// push 诊断：等待 publishDiagnostics 通知（≤timeout）。
///
/// 只接受 `entry.generation == push_generation 当前值` 的条目（M6/R4.3）：
/// prepare/didChange 递增 generation 后，旧分析结果（慢速 rustc 诊断）即使
/// 仍在 store 中也不得被当作新鲜诊断返回；每次轮询读当前值，等待期间
/// 再次 prepare 也会让已到达的旧条目失效。
pub async fn wait_push_diagnostics(
    store: &PushDiagnostics,
    push_generation: &AtomicU64,
    uri: &Url,
    timeout: Duration,
) -> Result<Vec<Diagnostic>, LspError> {
    let key = uri_key(uri);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let guard = store.lock().await;
            if let Some(entry) = guard.get(&key) {
                if entry.generation == push_generation.load(Ordering::Acquire) {
                    return Ok(entry.diagnostics.clone());
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(Vec::new());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// workspace/diagnostic（LSP 3.17 pull）：一次请求返回整个项目的诊断。
///
/// 服务器不支持时返回 Ok(None)，调用方跳过该语言。
/// 返回 (uri, diagnostics) 列表，按服务器报告顺序。
pub async fn workspace_diagnostics(
    socket: &mut async_lsp::ServerSocket,
    timeout: Duration,
) -> Result<Option<Vec<(Url, Vec<Diagnostic>)>>, LspError> {
    let result = tokio::time::timeout(
        timeout,
        socket.workspace_diagnostic(lsp_types::WorkspaceDiagnosticParams {
            identifier: None,
            previous_result_ids: Vec::new(),
            work_done_progress_params: WorkDoneProgressParams::default(),
            partial_result_params: PartialResultParams::default(),
        }),
    )
    .await
    .map_err(|_| LspError::RequestTimeout("workspace-diagnostics".into()))?;

    match result {
        Ok(report) => match report {
            lsp_types::WorkspaceDiagnosticReportResult::Report(report) => {
                let mut files: Vec<(Url, Vec<Diagnostic>)> = Vec::new();
                for item in report.items {
                    match item {
                        lsp_types::WorkspaceDocumentDiagnosticReport::Full(full) => {
                            let items = full.full_document_diagnostic_report.items;
                            files.push((full.uri, items));
                        }
                        lsp_types::WorkspaceDocumentDiagnosticReport::Unchanged(unchanged) => {
                            files.push((unchanged.uri, Vec::new()));
                        }
                    }
                }
                Ok(Some(files))
            }
            lsp_types::WorkspaceDiagnosticReportResult::Partial(_) => Ok(Some(Vec::new())),
        },
        Err(async_lsp::Error::Response(ref response_error))
            if response_error.code == ErrorCode::METHOD_NOT_FOUND =>
        {
            Ok(None)
        }
        Err(error) => Err(LspError::ServerFailed(format!(
            "workspace diagnostics failed: {error:?}"
        ))),
    }
}

/// 从 DocumentDiagnosticReport 提取诊断项（含相关文档）。
pub fn extract_diagnostic_items(report: DocumentDiagnosticReport) -> Vec<Diagnostic> {
    let mut items = Vec::new();
    match report {
        DocumentDiagnosticReport::Full(report) => {
            items.extend(report.full_document_diagnostic_report.items);
            if let Some(related) = report.related_documents {
                for (_, related_report) in related {
                    if let lsp_types::DocumentDiagnosticReportKind::Full(full) = related_report {
                        items.extend(full.items);
                    }
                }
            }
        }
        DocumentDiagnosticReport::Unchanged(_) => {}
    }
    items
}

/// goto definition 请求（跨文件语义跳转）。
pub async fn goto_definition(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.definition(GotoDefinitionParams {
        text_document_position_params: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("definition".into()))?
    .map_err(|error| LspError::ServerFailed(format!("gotoDefinition failed: {error:?}")))
}

/// references 请求（全部引用位置，含/不含声明）。
pub async fn references(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    include_declaration: bool,
    timeout: Duration,
) -> Result<Vec<Location>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    let result = tokio::time::timeout(timeout, socket.references(ReferenceParams {
        text_document_position: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
        context: ReferenceContext {
            include_declaration,
        },
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("references".into()))?
    .map_err(|error| LspError::ServerFailed(format!("references failed: {error:?}")))?;
    Ok(result.unwrap_or_default())
}

/// documentSymbol 请求（文件符号大纲，树形）。
pub async fn document_symbols(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    timeout: Duration,
) -> Result<Option<DocumentSymbolResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.document_symbol(DocumentSymbolParams {
        text_document: TextDocumentIdentifier { uri },
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("documentSymbols".into()))?
    .map_err(|error| LspError::ServerFailed(format!("documentSymbol failed: {error:?}")))
}

/// 组装 TextDocumentPositionParams（line/column 1-indexed → 0-indexed）。
fn text_document_position_params(
    uri: Url,
    line: u32,
    column: u32,
) -> TextDocumentPositionParams {
    TextDocumentPositionParams {
        text_document: TextDocumentIdentifier { uri },
        position: Position {
            line: line.saturating_sub(1),
            character: column.saturating_sub(1),
        },
    }
}

/// rename 请求（语义级重命名，返回 WorkspaceEdit：多文件 edits）。
pub async fn rename(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    new_name: &str,
    timeout: Duration,
) -> Result<Option<WorkspaceEdit>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.rename(RenameParams {
        text_document_position: text_document_position_params(uri, line, column),
        new_name: new_name.to_string(),
        work_done_progress_params: WorkDoneProgressParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("rename".into()))?
    .map_err(|error| LspError::ServerFailed(format!("rename failed: {error:?}")))
}

/// codeAction 请求（诊断快速修复 / 重构建议；only 过滤 kind）。
///
/// diagnostics 为当前位置所在文件的诊断（quickfix 类 action 依赖
/// CodeActionContext.diagnostics——VS Code 语义，rust-analyzer 等按此提供
/// allow/import 修复；传空则只剩不依赖诊断的 refactor 类）。
pub async fn code_actions(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    only: Option<Vec<CodeActionKind>>,
    diagnostics: Vec<Diagnostic>,
    timeout: Duration,
) -> Result<Option<Vec<CodeActionOrCommand>>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    let position = Position {
        line: line.saturating_sub(1),
        character: column.saturating_sub(1),
    };
    tokio::time::timeout(timeout, socket.code_action(CodeActionParams {
        text_document: TextDocumentIdentifier { uri },
        range: Range {
            start: position,
            end: position,
        },
        context: CodeActionContext {
            diagnostics,
            only,
            trigger_kind: Some(CodeActionTriggerKind::INVOKED),
        },
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("codeAction".into()))?
    .map_err(|error| LspError::ServerFailed(format!("codeAction failed: {error:?}")))
}

/// typeDefinition 请求（跳到符号「类型」的定义；参数类型是 GotoDefinitionParams 别名）。
pub async fn type_definition(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.type_definition(GotoDefinitionParams {
        text_document_position_params: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("typeDefinition".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeDefinition failed: {error:?}")))
}

/// implementation 请求（接口/抽象类的实现跳转；参数类型是 GotoDefinitionParams 别名）。
pub async fn implementation(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<GotoDefinitionResponse>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.implementation(GotoDefinitionParams {
        text_document_position_params: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("implementation".into()))?
    .map_err(|error| LspError::ServerFailed(format!("implementation failed: {error:?}")))
}

/// workspace/symbol 请求（跨文件按名搜索符号，语义级；无需 didOpen）。
pub async fn workspace_symbols(
    socket: &mut async_lsp::ServerSocket,
    query: &str,
    timeout: Duration,
) -> Result<Option<WorkspaceSymbolResponse>, LspError> {
    tokio::time::timeout(timeout, socket.symbol(WorkspaceSymbolParams {
        query: query.to_string(),
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("workspaceSymbols".into()))?
    .map_err(|error| LspError::ServerFailed(format!("workspace/symbol failed: {error:?}")))
}

/// prepareCallHierarchy 请求（LSP 3.16）：返回位置处的调用层级条目（函数/方法）。
pub async fn prepare_call_hierarchy(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyItem>>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.prepare_call_hierarchy(CallHierarchyPrepareParams {
        text_document_position_params: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("prepareCallHierarchy".into()))?
    .map_err(|error| LspError::ServerFailed(format!("prepareCallHierarchy failed: {error:?}")))
}

/// callHierarchy/incomingCalls 请求：谁调用了该条目（调用者 + 调用点位置）。
pub async fn call_hierarchy_incoming_calls(
    socket: &mut async_lsp::ServerSocket,
    item: CallHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyIncomingCall>>, LspError> {
    tokio::time::timeout(timeout, socket.incoming_calls(CallHierarchyIncomingCallsParams {
        item,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("callHierarchy/incomingCalls".into()))?
    .map_err(|error| LspError::ServerFailed(format!("callHierarchy/incomingCalls failed: {error:?}")))
}

/// callHierarchy/outgoingCalls 请求：该条目调用了谁（被调者 + 调用点位置）。
pub async fn call_hierarchy_outgoing_calls(
    socket: &mut async_lsp::ServerSocket,
    item: CallHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<CallHierarchyOutgoingCall>>, LspError> {
    tokio::time::timeout(timeout, socket.outgoing_calls(CallHierarchyOutgoingCallsParams {
        item,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("callHierarchy/outgoingCalls".into()))?
    .map_err(|error| LspError::ServerFailed(format!("callHierarchy/outgoingCalls failed: {error:?}")))
}

/// prepareTypeHierarchy 请求（LSP 3.17）：返回位置处的类型层级条目（类/接口/trait）。
pub async fn prepare_type_hierarchy(
    socket: &mut async_lsp::ServerSocket,
    path: &Path,
    line: u32,
    column: u32,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    let uri = Url::from_file_path(path)
        .map_err(|_| LspError::Internal(format!("invalid file path: {}", path.display())))?;
    tokio::time::timeout(timeout, socket.prepare_type_hierarchy(TypeHierarchyPrepareParams {
        text_document_position_params: text_document_position_params(uri, line, column),
        work_done_progress_params: WorkDoneProgressParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("prepareTypeHierarchy".into()))?
    .map_err(|error| LspError::ServerFailed(format!("prepareTypeHierarchy failed: {error:?}")))
}

/// typeHierarchy/supertypes 请求：条目的父类型链（基类/父接口）。
pub async fn type_hierarchy_supertypes(
    socket: &mut async_lsp::ServerSocket,
    item: TypeHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    tokio::time::timeout(timeout, socket.supertypes(TypeHierarchySupertypesParams {
        item,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("typeHierarchy/supertypes".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeHierarchy/supertypes failed: {error:?}")))
}

/// typeHierarchy/subtypes 请求：条目的所有子类型（子类/实现）。
pub async fn type_hierarchy_subtypes(
    socket: &mut async_lsp::ServerSocket,
    item: TypeHierarchyItem,
    timeout: Duration,
) -> Result<Option<Vec<TypeHierarchyItem>>, LspError> {
    tokio::time::timeout(timeout, socket.subtypes(TypeHierarchySubtypesParams {
        item,
        work_done_progress_params: WorkDoneProgressParams::default(),
        partial_result_params: PartialResultParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("typeHierarchy/subtypes".into()))?
    .map_err(|error| LspError::ServerFailed(format!("typeHierarchy/subtypes failed: {error:?}")))
}

/// workspace/executeCommand 请求：执行服务器定义命令（重构/导入等）。
///
/// 命令名与参数为服务器私有格式——agent 通常从 `lsp-code-action` 返回的
/// action.command 原样透传（如 rust-analyzer.applySourceChange / gopls.add_import）。
pub async fn execute_command(
    socket: &mut async_lsp::ServerSocket,
    command: &str,
    arguments: Vec<serde_json::Value>,
    timeout: Duration,
) -> Result<Option<serde_json::Value>, LspError> {
    tokio::time::timeout(timeout, socket.execute_command(ExecuteCommandParams {
        command: command.to_string(),
        arguments,
        work_done_progress_params: WorkDoneProgressParams::default(),
    }))
    .await
    .map_err(|_| LspError::RequestTimeout("executeCommand".into()))?
    .map_err(|error| LspError::ServerFailed(format!("executeCommand failed: {error:?}")))
}
