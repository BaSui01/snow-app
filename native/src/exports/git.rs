use std::path::Path;
use std::process::Stdio;

use napi::bindgen_prelude::{Status, Unknown};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::io::AsyncReadExt;

use crate::api::commit_message::generate_commit_message_stream;
use crate::api::responses::{ResponsesApiResult, ResponsesApiStreamCallback};
use crate::storage::services::git::{
    GitBranch, GitCheckoutResult, GitCommitFile, GitCommitResult, GitDiffResult, GitLogEntry,
    GitPushPullResult, GitRepoInfo, GitStageResult, GitStatusResult,
};
use crate::storage::services::git_watcher::GitChangeCallback;

#[napi]
pub async fn get_git_status(repo_path: String, status_limit: i32) -> napi::Result<GitStatusResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_git_status(&repo_path, status_limit)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get git status: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_branches(repo_path: String) -> napi::Result<Vec<GitBranch>> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::get_git_branches(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to get git branches: {join_error}"))
        })?
}

#[napi]
pub async fn git_stage_files(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::stage_files(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to stage files: {join_error}"))
    })?
}

#[napi]
pub async fn git_unstage_files(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::unstage_files(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to unstage files: {join_error}"))
    })?
}

#[napi]
pub async fn git_stage_all(repo_path: String) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::stage_all(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to stage all files: {join_error}"))
        })?
}

#[napi]
pub async fn git_unstage_all(repo_path: String) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::unstage_all(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to unstage all files: {join_error}"))
        })?
}

#[napi]
pub async fn git_commit(repo_path: String, message: String) -> napi::Result<GitCommitResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::commit_changes(&repo_path, &message)
    })
    .await
    .map_err(|join_error| napi::Error::from_reason(format!("Failed to commit: {join_error}")))?
}

/// Push local commits to the remote. Runs on the blocking thread pool
/// because `git push` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_push(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::push_changes(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to push to remote: {join_error}"))
        })?
}

/// Pull changes from the remote. Runs on the blocking thread pool
/// because `git pull` performs network I/O and may take seconds — it
/// must never block the async runtime.
#[napi]
pub async fn git_pull(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::pull_changes(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to pull from remote: {join_error}"))
        })?
}

/// Fetch from the remote without merging. Runs on the blocking thread
/// pool because `git fetch` performs network I/O and may take seconds —
/// it must never block the async runtime.
#[napi]
pub async fn git_fetch(repo_path: String) -> napi::Result<GitPushPullResult> {
    tokio::task::spawn_blocking(move || crate::storage::services::git::fetch_remote(&repo_path))
        .await
        .map_err(|join_error| {
            napi::Error::from_reason(format!("Failed to fetch from remote: {join_error}"))
        })?
}

#[napi]
pub async fn git_checkout(
    repo_path: String,
    branch_name: String,
) -> napi::Result<GitCheckoutResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::checkout_branch(&repo_path, &branch_name)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to checkout branch: {join_error}"))
    })?
}

#[napi]
pub async fn git_create_branch(
    repo_path: String,
    branch_name: String,
) -> napi::Result<GitCheckoutResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::create_branch(&repo_path, &branch_name)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to create branch: {join_error}"))
    })?
}

#[napi]
pub async fn git_file_diff(
    repo_path: String,
    file_path: String,
    staged: bool,
) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_file_diff(&repo_path, &file_path, staged)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get file diff: {join_error}"))
    })?
}

#[napi]
pub async fn git_discard_changes(
    repo_path: String,
    file_paths: Vec<String>,
) -> napi::Result<GitStageResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::discard_changes(&repo_path, &file_paths)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to discard changes: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_log(
    repo_path: String,
    skip: i32,
    limit: i32,
) -> napi::Result<Vec<GitLogEntry>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_git_log(&repo_path, skip, limit)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get git log: {join_error}"))
    })?
}

#[napi]
pub async fn get_git_commit_files(
    repo_path: String,
    hash: String,
) -> napi::Result<Vec<GitCommitFile>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_files(&repo_path, &hash)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit files: {join_error}"))
    })?
}

/// Get the full diff introduced by a single commit. Runs on the blocking
/// thread pool so `git show` never blocks the async runtime.
#[napi]
pub async fn get_commit_diff(repo_path: String, hash: String) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_diff(&repo_path, &hash)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit diff: {join_error}"))
    })?
}

/// Get the diff of a single file within a single commit
/// (`git show <hash> -- <path>`). Runs on the blocking thread pool so
/// `git show` never blocks the async runtime.
#[napi]
pub async fn git_commit_file_diff(
    repo_path: String,
    hash: String,
    file_path: String,
) -> napi::Result<GitDiffResult> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_commit_file_diff(&repo_path, &hash, &file_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get commit file diff: {join_error}"))
    })?
}

/// Discover all git repositories within a directory tree.
///
/// Walks `root_path` breadth-first up to `max_depth` levels deep (default 1,
/// matching VSCode's `git.repositoryScanMaxDepth`; negative = unlimited).
/// Directories listed in `ignored_folders` (matched against the folder name,
/// case-insensitive) are never traversed.
/// Runs on the blocking thread pool because filesystem traversal and
/// `git rev-parse` calls may be slow on large directory trees.
#[napi]
pub async fn discover_git_repos(
    root_path: String,
    max_depth: i32,
    ignored_folders: Vec<String>,
) -> napi::Result<Vec<GitRepoInfo>> {
    tokio::task::spawn_blocking(move || {
        crate::storage::services::git::discover_git_repos(&root_path, max_depth, &ignored_folders)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to discover git repos: {join_error}"))
    })?
}

#[napi(
    ts_args_type = "repoPath: string, debounceMs: number, onChange: (repoPath: string) => void",
    ts_return_type = "void"
)]
pub fn start_git_watch(
    repo_path: String,
    debounce_ms: f64,
    on_change: GitChangeCallback,
) -> napi::Result<()> {
    crate::storage::services::git_watcher::start_git_watch(repo_path, debounce_ms, on_change)
}
#[napi]
pub fn stop_git_watch(repo_path: String) -> napi::Result<()> {
    crate::storage::services::git_watcher::stop_git_watch(repo_path)
}

/// Generate a commit message from the staged diff using the active API
/// config's **basic model**. Dispatches to whichever provider (chat /
/// responses / anthropic / gemini) the active config specifies.
///
/// - `repoPath`: git repository path (used to run `git diff --cached`)
/// - `onChunk`: streaming callback receiving `ResponsesApiStreamChunk`
/// - `streamId`: unique stream id for cancellation support
///
/// Returns the full `ResponsesApiResult` (`.content` holds the message).
#[napi(
    ts_args_type = "repoPath: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message(
    repo_path: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    // 1. Get staged diff (blocking git command in spawn_blocking)
    let staged_diff = tokio::task::spawn_blocking(move || {
        crate::storage::services::git::get_staged_diff(&repo_path)
    })
    .await
    .map_err(|join_error| {
        napi::Error::from_reason(format!("Failed to get staged diff: {join_error}"))
    })??;

    if staged_diff.trim().is_empty() {
        return Err(napi::Error::from_reason(
            "No staged changes found. Please stage your changes first.",
        ));
    }

    // 2. Register cancellation token
    let cancel_token = crate::api::cancel::create_and_register(&stream_id);

    // 3. Stream commit message generation
    let result = generate_commit_message_stream(staged_diff, on_chunk, cancel_token).await;

    // 4. Unregister stream
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

/// Generate a commit message from a raw staged-diff string.
///
/// Identical to `generate_commit_message` but skips the local `git diff
/// --cached` step. Used by remote (SSH) repositories, where the diff is
/// produced on the remote host and streamed back to this process before
/// the AI generation runs here.
#[napi(
    ts_args_type = "diff: string, onChunk: (chunk: ResponsesApiStreamChunk) => void, streamId: string",
    ts_return_type = "Promise<ResponsesApiResult>"
)]
pub async fn generate_commit_message_from_diff(
    diff: String,
    on_chunk: ResponsesApiStreamCallback,
    stream_id: String,
) -> napi::Result<ResponsesApiResult> {
    if diff.trim().is_empty() {
        return Err(napi::Error::from_reason(
            "No staged changes found. Please stage your changes first.",
        ));
    }

    let cancel_token = crate::api::cancel::create_and_register(&stream_id);
    let result = generate_commit_message_stream(diff, on_chunk, cancel_token).await;
    crate::api::cancel::unregister_stream(&stream_id);

    result
}

// ===== Clone repository =====

/// `git clone` 的实时进度：一条 stderr 进度行 + 解析出的百分比。
#[napi(object)]
pub struct GitCloneProgress {
    /// git 输出的一条原始进度行（已去除行尾控制符）。
    pub line: String,
    /// 从进度行解析出的百分比（0-100），无法解析时为 None。
    pub percent: Option<f64>,
}

type GitCloneProgressCallback = ThreadsafeFunction<
    GitCloneProgress,
    Unknown<'static>,
    GitCloneProgress,
    Status,
    false,
>;

/// 克隆 Git 仓库到本地目录。
///
/// `parent_path` 为保存位置：按 git 的默认命名规则从仓库地址推导
/// 项目名，并在其下新建 `<项目名>` 子目录进行克隆（与 `git clone`
/// 不带目标目录时的行为一致）。全程使用 tokio 异步子进程执行
/// `git clone --progress`，不经过 spawn_blocking、不阻塞 Node.js
/// 主线程。stderr 按字节流读取并按 `\r` / `\n` 分行（git 的进度
/// 更新以 `\r` 结尾），每条进度行通过 `onProgress` 回调实时推送
/// 给渲染层。克隆成功返回实际克隆目录的完整路径。
#[napi(
    ts_args_type = "repoUrl: string, parentPath: string, onProgress: ((chunk: GitCloneProgress) => void) | undefined",
    ts_return_type = "Promise<string>"
)]
pub async fn clone_git_repository(
    repo_url: String,
    parent_path: String,
    on_progress: Option<GitCloneProgressCallback>,
) -> napi::Result<String> {
    let url = repo_url.trim().to_string();
    if url.is_empty() {
        return Err(napi::Error::from_reason(
            "Repository URL is required and must be non-empty",
        ));
    }

    let parent = parent_path.trim().to_string();
    if parent.is_empty() {
        return Err(napi::Error::from_reason(
            "Parent directory is required and must be non-empty",
        ));
    }

    let parent_obj = Path::new(&parent);
    if !parent_obj.is_dir() {
        return Err(napi::Error::from_reason(format!(
            "Parent directory does not exist or is not a directory: '{parent}'"
        )));
    }

    // 与 git 默认命名一致：去掉 .git 后缀后取最后一段作为项目名，
    // 在所选目录下新建同名子目录，避免直接占用所选目录本身。
    let repo_name = derive_repo_name(&url).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "Unable to derive repository name from URL: '{url}'"
        ))
    })?;
    let target_obj = parent_obj.join(&repo_name);
    let target = target_obj.to_string_lossy().to_string();

    // 子目录已存在时仅允许空目录（可直接克隆进入）；非空则报错，
    // 通常是上一次克隆残留的目录。
    if target_obj.exists() {
        if !target_obj.is_dir() {
            return Err(napi::Error::from_reason(format!(
                "Target path is not a directory: '{target}'"
            )));
        }
        let has_entries = std::fs::read_dir(&target_obj)
            .map_err(|error| {
                napi::Error::from_reason(format!(
                    "Failed to inspect target directory '{target}': {error}"
                ))
            })?
            .next()
            .is_some();
        if has_entries {
            return Err(napi::Error::from_reason(format!(
                "Target directory is not empty: '{target}'"
            )));
        }
    }

    // GIT_TERMINAL_PROMPT=0 避免无凭证助手时 git 在终端上挂起等待输入，
    // 认证失败快速报错；Windows 下 Git Credential Manager 仍可弹窗交互。
    let mut child = crate::utils::process::cmd_async("git")
        .args(["clone", "--progress", &url, &target])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                napi::Error::from_reason(
                    "git executable not found in PATH — install Git before cloning repositories",
                )
            } else {
                napi::Error::from_reason(format!("Failed to start git clone: {error}"))
            }
        })?;

    let mut stderr = child.stderr.take().ok_or_else(|| {
        napi::Error::from_reason("Failed to capture git clone progress output")
    })?;
    let mut last_line = String::new();
    let mut read_buffer = [0u8; 4096];
    let mut line_buffer: Vec<u8> = Vec::new();

    loop {
        let bytes_read = stderr.read(&mut read_buffer).await.map_err(|error| {
            napi::Error::from_reason(format!("Failed to read git clone progress: {error}"))
        })?;
        if bytes_read == 0 {
            break;
        }
        for &byte in &read_buffer[..bytes_read] {
            // git 的进度更新以 \r 结尾（不换行覆盖刷新），普通信息行
            // 以 \n 结尾，两者都视为一行边界。
            if byte == b'\n' || byte == b'\r' {
                if !line_buffer.is_empty() {
                    last_line = emit_clone_progress(&on_progress, &line_buffer);
                    line_buffer.clear();
                }
            } else {
                line_buffer.push(byte);
            }
        }
    }
    if !line_buffer.is_empty() {
        last_line = emit_clone_progress(&on_progress, &line_buffer);
    }

    let status = child.wait().await.map_err(|error| {
        napi::Error::from_reason(format!("Failed to wait for git clone: {error}"))
    })?;
    if !status.success() {
        let detail = last_line.trim();
        let message = if detail.is_empty() {
            format!(
                "git clone exited with code {}",
                status.code().unwrap_or(-1)
            )
        } else {
            detail.to_string()
        };
        return Err(napi::Error::from_reason(format!(
            "Failed to clone repository: {message}"
        )));
    }

    Ok(target)
}

/// 推送一条克隆进度，并返回该行文本（用于失败时展示最后一条信息）。
fn emit_clone_progress(
    on_progress: &Option<GitCloneProgressCallback>,
    line_bytes: &[u8],
) -> String {
    let line = String::from_utf8_lossy(line_bytes).trim().to_string();
    if let Some(callback) = on_progress {
        let chunk = GitCloneProgress {
            percent: parse_progress_percent(&line),
            line: line.clone(),
        };
        let _ = callback.call(chunk, ThreadsafeFunctionCallMode::NonBlocking);
    }
    line
}

/// 从 git 进度行中解析百分比，如
/// "Receiving objects:  42% (420/1000)" → `Some(42.0)`。
fn parse_progress_percent(line: &str) -> Option<f64> {
    let percent_index = line.find('%')?;
    let before = &line[..percent_index];
    let start = before
        .char_indices()
        .rev()
        .take_while(|(_, ch)| ch.is_ascii_digit() || *ch == '.')
        .last()
        .map(|(index, _)| index)?;
    let digits: String = before[start..]
        .chars()
        .filter(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect();
    digits
        .parse::<f64>()
        .ok()
        .filter(|value| (0.0..=100.0).contains(value))
}

/// 按 git 的默认命名规则从仓库地址推导项目目录名：去掉末尾 `.git`
/// 后缀与斜杠后，取最后一个路径段。同时支持 https/ssh 形式
/// （`https://github.com/user/repo.git`）与 scp 形式
/// （`git@host:user/repo.git`），两者都得到 `repo`。
fn derive_repo_name(repo_url: &str) -> Option<String> {
    let trimmed = repo_url.trim().trim_end_matches('/');
    let without_suffix = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    without_suffix
        .rsplit(['/', ':', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}
