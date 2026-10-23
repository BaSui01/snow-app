//! Wiki agent 工具：只读浏览（filesystem-read / grep-search / grep-find）与页面就地编辑
//! （wiki-page-edit）。只读视图统一过滤依赖与构建目录、.gitignore 命中项、疑似密钥文件与符号链接。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::*;
use serde_json::{json, Value};

use crate::api::file_search_agent::AgentToolExecutor;
use crate::mcp::servers::filesystem::FilesystemService;
use crate::mcp::servers::grep::GrepService;
use crate::mcp::service::McpService;
use crate::mcp::tools::McpTool;
use crate::storage::services::file_scanner::{BINARY_EXTENSIONS, IMAGE_EXTENSIONS, SKIP_DIRS};
use crate::storage::services::gitignore::GitignoreMatcher;


const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;
const MAX_DIR_ENTRIES: usize = 400;
const SENSITIVE_WORDS: &[&str] = &[
    "token",
    "secret",
    "credential",
    "password",
    "passwd",
    "private_key",
    "privatekey",
    "apikey",
    "api_key",
];
/// 名称含敏感词时仍可读的源码扩展名（如 tokenService.ts）。
const SOURCE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "go", "java", "kt", "kts",
    "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "vue", "svelte", "dart", "scala",
    "lua", "ex", "exs", "md", "mdx",
];
const ALWAYS_SENSITIVE_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks"];

pub(crate) struct WikiReadView {
    root: String,
    matcher: GitignoreMatcher,
}

impl WikiReadView {
    pub(crate) async fn new(root: &str) -> Self {
        let root = super::store::normalize_project_path(root);
        let matcher_root = root.clone();
        let matcher = tokio::task::spawn_blocking(move || {
            GitignoreMatcher::from_project_root(Path::new(&matcher_root))
        })
        .await
        .unwrap_or_else(|_| GitignoreMatcher::from_root_content(None));
        Self { root, matcher }
    }

    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    /// 绝对路径转为根内相对路径（不在根内返回 None）。
    pub(crate) fn relative(&self, path: &str) -> Option<String> {
        let normalized = path.trim().replace('\\', "/");
        let normalized = normalized.trim_start_matches("./");
        if normalized.is_empty() || normalized == "." {
            return Some(String::new());
        }
        let is_absolute = normalized.starts_with('/')
            || (normalized.len() >= 3 && normalized.as_bytes()[1] == b':');
        if !is_absolute {
            return Some(normalized.trim_end_matches('/').to_string());
        }
        let lower = normalized.to_lowercase();
        let root_lower = self.root.to_lowercase();
        if lower == root_lower {
            return Some(String::new());
        }
        if !lower.starts_with(&format!("{root_lower}/")) {
            return None;
        }
        normalized
            .get(self.root.len() + 1..)
            .map(|rest| rest.trim_end_matches('/').to_string())
    }

    /// 工具输出里的路径：绝对路径直接转换，相对路径按搜索目录拼接。
    fn relative_from(&self, base_relative: &str, file: &str) -> Option<String> {
        let normalized = file.replace('\\', "/");
        if normalized.starts_with('/') || Path::new(file).is_absolute() {
            return self.relative(&normalized);
        }
        let joined = if base_relative.is_empty() {
            normalized
        } else {
            format!("{base_relative}/{}", normalized.trim_start_matches("./"))
        };
        self.relative(&joined)
    }

    fn absolute(&self, relative: &str) -> String {
        if relative.is_empty() {
            self.root.clone()
        } else {
            format!("{}/{relative}", self.root)
        }
    }

    pub(crate) fn is_blocked(&self, relative: &str, is_dir: bool) -> bool {
        if relative.is_empty() {
            return false;
        }
        if relative.split('/').any(|part| part == ".." || SKIP_DIRS.contains(&part)) {
            return true;
        }
        if self.matcher.is_ignored(relative, is_dir) {
            return true;
        }
        !is_dir && is_sensitive_file(relative.rsplit('/').next().unwrap_or(relative))
    }
}

fn is_sensitive_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.starts_with(".env") || lower.starts_with("id_rsa") || lower.starts_with("id_ed25519")
    {
        return true;
    }
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    if ALWAYS_SENSITIVE_EXTENSIONS.contains(&extension) {
        return true;
    }
    SENSITIVE_WORDS.iter().any(|word| lower.contains(word))
        && !SOURCE_EXTENSIONS.contains(&extension)
}

fn is_binary_file(relative: &str) -> bool {
    let extension = relative
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_lowercase())
        .unwrap_or_default();
    IMAGE_EXTENSIONS.contains(&extension.as_str()) || BINARY_EXTENSIONS.contains(&extension.as_str())
}

fn truncate_output(output: &Value) -> String {
    let serialized = serde_json::to_string(output).unwrap_or_default();
    if serialized.chars().count() <= MAX_TOOL_OUTPUT_CHARS {
        return serialized;
    }
    let mut text: String = serialized.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
    text.push_str("...[truncated: narrow the range with startLine/endLine or a more specific query]");
    text
}

/// 页面局部编辑草稿：模型用 wiki-page-edit 就地打补丁，避免整章重写。
pub(crate) struct PageDraft {
    content: tokio::sync::Mutex<String>,
    edited: AtomicBool,
}

impl PageDraft {
    pub(crate) fn new(content: String) -> Self {
        Self {
            content: tokio::sync::Mutex::new(content),
            edited: AtomicBool::new(false),
        }
    }

    pub(crate) fn was_edited(&self) -> bool {
        self.edited.load(Ordering::SeqCst)
    }

    pub(crate) async fn content(&self) -> String {
        self.content.lock().await.clone()
    }

    /// 精确字符串替换：old 必须唯一命中（replaceAll 时替换全部）。
    async fn apply(
        &self,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> std::result::Result<(usize, usize), String> {
        if old.is_empty() {
            return Err("oldString is empty: pass the exact text to replace".to_string());
        }
        if old == new {
            return Err("oldString and newString are identical, nothing to change".to_string());
        }
        let mut content = self.content.lock().await;
        let count = content.matches(old).count();
        if count == 0 {
            return Err(
                "oldString not found: copy it verbatim from the current page (include enough surrounding context)"
                    .to_string(),
            );
        }
        if count > 1 && !replace_all {
            return Err(format!(
                "oldString matches {count} places: add surrounding context to make it unique, or set replaceAll=true"
            ));
        }
        let updated = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        *content = updated;
        self.edited.store(true, Ordering::SeqCst);
        let applied = if replace_all { count } else { 1 };
        Ok((applied, content.chars().count()))
    }
}

/// 局部编辑工具定义（仅在已有页面内容时提供给模型）。
pub(crate) fn page_edit_tool() -> McpTool {
    McpTool {
        server_id: "wiki".to_string(),
        name: "page-edit".to_string(),
        description: "Patch the CURRENT wiki page markdown in place. oldString must be copied verbatim from the current page and must match exactly; keep edits minimal and leave correct sections untouched.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "oldString": {
                    "type": "string",
                    "description": "Exact text from the current page markdown to replace (include enough surrounding context to be unique)."
                },
                "newString": {
                    "type": "string",
                    "description": "Replacement text for oldString."
                },
                "replaceAll": {
                    "type": "boolean",
                    "description": "Replace every occurrence. Default false: oldString must match exactly once."
                }
            },
            "required": ["oldString", "newString"]
        }),
    }
}

/// 工具活动回调：(工具名, 目标)。
pub(crate) type ActivityFn<'a> = &'a (dyn Fn(&str, &str) + Send + Sync);

pub(crate) struct WikiToolExecutor<'a> {
    pub view: &'a WikiReadView,
    pub on_activity: ActivityFn<'a>,
    /// 局部编辑草稿；None 时 wiki-page-edit 不可用。
    pub draft: Option<&'a PageDraft>,
}


impl AgentToolExecutor for WikiToolExecutor<'_> {
    fn execute<'a>(
        &'a self,
        name: &'a str,
        arguments_json: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let args: Value = match serde_json::from_str(arguments_json) {
                Ok(args) => args,
                Err(error) => return Ok(format!("Error: failed to parse tool arguments: {error}")),
            };
            let result = match name {
                "filesystem-read" => self.read(args).await,
                "grep-search" => self.search(args).await,
                "grep-find" => self.find(args).await,
                "wiki-page-edit" => self.edit(&args).await,
                other => Err(format!(
                    "unsupported tool \"{other}\". Available tools: filesystem-read, grep-search, grep-find, wiki-page-edit"
                )),
            };
            Ok(match result {
                Ok(output) => truncate_output(&output),
                Err(message) => format!("Error: {message}"),
            })
        })
    }

    fn label(&self) -> &'static str {
        "repo_wiki_agent"
    }
}

impl WikiToolExecutor<'_> {
    fn resolve(&self, requested: Option<&str>) -> std::result::Result<String, String> {
        let requested = requested.unwrap_or("").trim();
        self.view.relative(requested).ok_or_else(|| {
            format!(
                "path \"{requested}\" is outside the workspace \"{}\"",
                self.view.root()
            )
        })
    }

    /// 就地编辑当前页面草稿：精确字符串替换。
    async fn edit(&self, args: &Value) -> std::result::Result<Value, String> {
        let Some(draft) = self.draft else {
            return Err("wiki-page-edit is not available for this task".to_string());
        };
        let old = args
            .get("oldString")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let new = args
            .get("newString")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let replace_all = args
            .get("replaceAll")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let target: String = old
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(80)
            .collect();
        (self.on_activity)(
            "edit",
            if target.is_empty() {
                "page"
            } else {
                target.as_str()
            },
        );
        let (applied, page_chars) = draft.apply(old, new, replace_all).await?;
        Ok(json!({ "applied": applied, "pageChars": page_chars }))
    }

    async fn read(&self, mut args: Value) -> std::result::Result<Value, String> {
        let requested = args.get("filePath").and_then(Value::as_str).map(str::to_string);
        if requested.as_deref().map(str::trim).unwrap_or("").is_empty() {
            return Err("filePath is required".to_string());
        }
        let relative = self.resolve(requested.as_deref())?;
        let absolute = self.view.absolute(&relative);
        (self.on_activity)("read", if relative.is_empty() { "." } else { relative.as_str() });

        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| format!("cannot access \"{relative}\": {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("symbolic links are excluded from the wiki read view".to_string());
        }
        if metadata.is_dir() {
            if self.view.is_blocked(&relative, true) {
                return Err(format!("\"{relative}\" is excluded from the wiki read view"));
            }
            return self.list_dir(&relative, &absolute).await;
        }
        if self.view.is_blocked(&relative, false) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        if is_binary_file(&relative) {
            return Err(format!("\"{relative}\" is a binary file"));
        }
        args["filePath"] = Value::String(absolute);
        let output = tokio::task::spawn_blocking(move || FilesystemService::new().execute("read", &args))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.reason.clone())?;
        let mut output = output;
        if let Some(object) = output.as_object_mut() {
            object.insert("path".to_string(), json!(relative));
        }
        Ok(output)
    }

    async fn list_dir(&self, relative: &str, absolute: &str) -> std::result::Result<Value, String> {
        let mut reader = tokio::fs::read_dir(absolute)
            .await
            .map_err(|error| format!("failed to read directory: {error}"))?;
        let mut entries: Vec<String> = Vec::new();
        let mut hidden = 0usize;
        while let Ok(Some(entry)) = reader.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_symlink() {
                hidden += 1;
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let is_dir = file_type.is_dir();
            if name == ".git" || self.view.is_blocked(&child, is_dir) {
                hidden += 1;
                continue;
            }
            entries.push(if is_dir { format!("{name}/") } else { name });
        }
        entries.sort();
        let truncated = entries.len() > MAX_DIR_ENTRIES;
        entries.truncate(MAX_DIR_ENTRIES);
        Ok(json!({
            "path": if relative.is_empty() { "." } else { relative },
            "entries": entries.join("\n"),
            "excludedEntries": hidden,
            "truncated": truncated,
        }))
    }

    async fn search(&self, mut args: Value) -> std::result::Result<Value, String> {
        let relative = self.resolve(args.get("path").and_then(Value::as_str))?;
        if self.view.is_blocked(&relative, true) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (self.on_activity)("search", &pattern);
        args["path"] = json!(self.view.absolute(&relative));
        if let Some(object) = args.as_object_mut() {
            object.remove("linkedRoots");
        }
        let mut output = GrepService::new()
            .execute_search_local(&args)
            .await
            .map_err(|error| error.reason.clone())?;
        if let Some(object) = output.as_object_mut() {
            object.remove("rawOutput");
            object.remove("backend");
            object.insert("path".to_string(), json!(relative));
        }
        if let Some(matches) = output.get_mut("matches").and_then(Value::as_array_mut) {
            matches.retain_mut(|item| {
                let Some(file) = item.get("file").and_then(Value::as_str) else {
                    return false;
                };
                match self.view.relative_from(&relative, file) {
                    Some(rel) if !self.view.is_blocked(&rel, false) => {
                        item["file"] = json!(rel);
                        true
                    }
                    _ => false,
                }
            });
        }
        Ok(output)
    }

    async fn find(&self, mut args: Value) -> std::result::Result<Value, String> {
        let relative = self.resolve(args.get("path").and_then(Value::as_str))?;
        if self.view.is_blocked(&relative, true) {
            return Err(format!("\"{relative}\" is excluded from the wiki read view"));
        }
        let pattern = args
            .get("pattern")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (self.on_activity)("find", &pattern);
        args["path"] = json!(self.view.absolute(&relative));
        args["searchAll"] = json!(false);
        if let Some(object) = args.as_object_mut() {
            object.remove("linkedRoots");
        }
        let mut output = GrepService::new()
            .execute_find_local(&args)
            .await
            .map_err(|error| error.reason.clone())?;
        if let Some(object) = output.as_object_mut() {
            object.remove("backend");
            object.insert("path".to_string(), json!(relative));
        }
        if let Some(files) = output.get_mut("files").and_then(Value::as_array_mut) {
            let filtered: Vec<Value> = files
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|file| self.view.relative_from(&relative, file))
                .filter(|rel| !self.view.is_blocked(rel, false))
                .map(Value::String)
                .collect();
            *files = filtered;
        }
        Ok(output)
    }
}
