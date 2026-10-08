//! Bounded attribution at tool boundaries, not an OS write audit.
//! This coordinator is deliberately independent of checkpoint/restore locks.
//! 租约等待同样有界：终端命令窗口不被他人等待，长时间命令不阻塞其他会话。
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 短窗口写者（文件工具 / 格式化）最多等待的时长，覆盖毫秒级的并发写窗口。
pub(crate) const WRITER_LEASE_WAIT: Duration = Duration::from_secs(2);
/// 终端命令窗口最多等短窗口写者让位的时间；被其他终端窗口占用立即降级。
pub(crate) const TERMINAL_LEASE_WAIT: Duration = Duration::from_millis(500);

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

const MAX_FILES: usize = 2048;
const MAX_ENTRIES: usize = 8192;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RESULT_FILES: usize = 256;
const SCAN_TIME: Duration = Duration::from_secs(3);

pub(crate) fn physical_path(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    let mut resolved = loop {
        if let Ok(canonical) = std::fs::canonicalize(ancestor) {
            break canonical;
        }
        suffix.push(ancestor.file_name()?.to_os_string());
        ancestor = ancestor.parent()?;
    };
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    let mut clean = PathBuf::new();
    for component in resolved.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    Some(clean)
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = text.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        text.strip_prefix("//?/").unwrap_or(&text).to_string()
    }
}
pub(crate) fn path_string(path: &Path) -> String {
    display(path)
}
fn key(path: &Path) -> String {
    let text = display(path);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
fn repository_root(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() { path } else { path.parent()? };
    start
        .ancestors()
        .find(|parent| parent.join(".git").exists())
        .map(Path::to_path_buf)
}
fn overlap(a: &str, b: &str) -> bool {
    a == "*"
        || b == "*"
        || a == b
        || a.strip_prefix(b).is_some_and(|rest| rest.starts_with('/'))
        || b.strip_prefix(a).is_some_and(|rest| rest.starts_with('/'))
}

/// 租约类别：终端命令窗口覆盖整个命令执行期（可能数分钟），短窗口写者
/// （文件工具 / 格式化）只有毫秒级。等待策略据此区分。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LeaseClass {
    Writer,
    Terminal,
}

#[derive(Default)]
struct Coordination {
    next: u64,
    active: BTreeMap<u64, (LeaseClass, Vec<String>)>,
}
static COORDINATION: OnceLock<Mutex<Coordination>> = OnceLock::new();
static NOTIFY: OnceLock<Notify> = OnceLock::new();
fn coordination() -> std::sync::MutexGuard<'static, Coordination> {
    COORDINATION
        .get_or_init(|| Mutex::new(Coordination::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn lease_resources(paths: &[String]) -> Vec<String> {
    let mut resources = Vec::new();
    for path in paths {
        match physical_path(Path::new(path)) {
            Some(path) => {
                resources.push(key(&path));
                // Worktree .git files resolve to their own physical workdir,
                // never the common git dir shared with other worktrees.
                resources.push(
                    repository_root(&path)
                        .map(|root| key(&root))
                        .unwrap_or_else(|| "*".into()),
                );
            }
            None => resources.push("*".into()),
        }
    }
    resources.sort();
    resources.dedup();
    resources
}

/// 与本次请求冲突的持有者类别；Terminal 优先，决定调用方能否等待。
fn conflict(state: &Coordination, resources: &[String]) -> Option<LeaseClass> {
    let mut busy = None;
    for (class, held) in state.active.values() {
        // Physical repo roots are equality domains, not path prefixes:
        // a nested independent worktree must not serialize its parent repo.
        // Non-git or unresolved targets conservatively conflict with all.
        if held
            .iter()
            .any(|a| resources.iter().any(|b| a == "*" || b == "*" || a == b))
        {
            if *class == LeaseClass::Terminal {
                return Some(LeaseClass::Terminal);
            }
            busy = Some(LeaseClass::Writer);
        }
    }
    busy
}

/// Arc leases can be carried into blocking writes, so cancellation of the
/// awaiting future cannot release the reservation while that write still runs.
pub(crate) struct WriteLease {
    id: u64,
}
impl Drop for WriteLease {
    fn drop(&mut self) {
        coordination().active.remove(&self.id);
        NOTIFY.get_or_init(Notify::new).notify_waiters();
    }
}

/// 抢一个跟踪租约；被终端命令窗口占用或超时返回 None，等待只对短窗口写者生效。
/// 调用方必须立即降级（跳过或标注 unavailable），绝不无限等待：一个会话里的
/// 长时间命令（编译等）不得阻塞其他会话的工具。
pub(crate) async fn coordinate(
    paths: &[String],
    class: LeaseClass,
    wait: Duration,
) -> Option<Arc<WriteLease>> {
    let resources = lease_resources(paths);
    let deadline = Instant::now() + wait;
    loop {
        let notified = NOTIFY.get_or_init(Notify::new).notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        {
            let mut state = coordination();
            match conflict(&state, &resources) {
                None => {
                    state.next = state.next.wrapping_add(1);
                    let id = state.next;
                    state.active.insert(id, (class, resources));
                    return Some(Arc::new(WriteLease { id }));
                }
                Some(LeaseClass::Terminal) => return None,
                Some(LeaseClass::Writer) => {}
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        if tokio::time::timeout(remaining, notified).await.is_err() {
            return None;
        }
    }
}

fn envelope(
    source: &str,
    root: Option<&Path>,
    coverage: &str,
    reasons: BTreeSet<String>,
    files: Vec<Value>,
) -> Value {
    json!({"version":1,"source":source,"root":root.map(display),"coverage":coverage,"reasons":reasons,"files":files})
}
fn file(path: &Path, kind: &str) -> Value {
    json!({"filePath":display(path),"fileKey":key(path),"kind":kind})
}
pub(crate) fn unavailable(source: &str, reason: &str) -> Value {
    let mut reasons = BTreeSet::from([reason.to_string()]);
    if source == "terminal" {
        reasons.insert("terminal-boundary".into());
    }
    envelope(source, None, "unavailable", reasons, vec![])
}

/// Called inside the actual blocking write while the independent lease is held.
pub(crate) fn filesystem_before(paths: &[String]) -> Vec<(PathBuf, Option<bool>)> {
    paths
        .iter()
        .filter_map(|path| {
            let path = physical_path(Path::new(path))?;
            let exists = match std::fs::metadata(&path) {
                Ok(_) => Some(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
            };
            Some((path, exists))
        })
        .collect()
}
pub(crate) fn filesystem_after(
    before: Vec<(PathBuf, Option<bool>)>,
    result: &Value,
    expected: usize,
) -> Value {
    let root = before.first().and_then(|(path, _)| {
        repository_root(path).or_else(|| path.parent().map(Path::to_path_buf))
    });
    let mut reasons = BTreeSet::from(["explicit-targets".to_string()]);
    let mut files = Vec::new();
    if before.len() != expected {
        reasons.insert("path-resolution-failed".into());
    }
    if result.get("success").and_then(Value::as_bool) == Some(true) {
        for (path, existed) in before {
            let Some(existed) = existed else {
                reasons.insert("metadata-unavailable".into());
                continue;
            };
            match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_file() => files.push(file(
                    &physical_path(&path).unwrap_or(path),
                    if existed { "edit" } else { "create" },
                )),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && existed => {
                    files.push(file(&path, "delete"))
                }
                _ => {
                    reasons.insert("metadata-unavailable".into());
                }
            }
        }
    } else {
        reasons.insert("tool-not-successful".into());
    }
    files.sort_by_key(|value| value["fileKey"].as_str().unwrap_or_default().to_string());
    files.dedup_by(|a, b| a["fileKey"] == b["fileKey"]);
    let coverage = if reasons
        .iter()
        .any(|reason| reason.ends_with("failed") || reason.ends_with("unavailable"))
    {
        "partial"
    } else {
        "scoped"
    };
    envelope("filesystem", root.as_deref(), coverage, reasons, files)
}

struct Snapshot {
    entries: BTreeMap<String, (PathBuf, Option<blake3::Hash>)>,
    complete: bool,
    reasons: BTreeSet<String>,
}
async fn git_paths(root: &Path) -> Result<Vec<PathBuf>, &'static str> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "git-list-unavailable")?;
    let mut bytes = Vec::new();
    let stdout = child.stdout.take().ok_or("git-list-unavailable")?;
    stdout
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "git-list-unavailable")?;
    if bytes.len() > 1024 * 1024 {
        return Err("git-list-byte-limit");
    }
    if !child
        .wait()
        .await
        .map_err(|_| "git-list-unavailable")?
        .success()
    {
        return Err("git-list-unavailable");
    }
    let mut paths = Vec::new();
    for part in bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let text = std::str::from_utf8(part).map_err(|_| "git-path-encoding")?;
        let relative = Path::new(text);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, Component::ParentDir))
        {
            return Err("git-path-invalid");
        }
        paths.push(root.join(relative));
        if paths.len() > MAX_ENTRIES {
            return Err("file-list-limit");
        }
    }
    Ok(paths)
}
async fn scan(root: &Path, previous: Option<&Snapshot>) -> Snapshot {
    let mut snapshot = Snapshot {
        entries: BTreeMap::new(),
        complete: true,
        reasons: BTreeSet::new(),
    };
    let mut paths = BTreeSet::new();
    if repository_root(root).as_deref() == Some(root) {
        snapshot
            .reasons
            .insert("git-list-scope:tracked-and-untracked-excluding-ignored".into());
        match git_paths(root).await {
            Ok(list) => paths.extend(list),
            Err(reason) => {
                snapshot.complete = false;
                snapshot.reasons.insert(reason.into());
            }
        }
    } else {
        snapshot
            .reasons
            .insert("non-git-scope:build-dependencies-and-symlinks-excluded".into());
        let mut directories = vec![root.to_path_buf()];
        let mut count = 0;
        'walk: while let Some(directory) = directories.pop() {
            let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
                snapshot.complete = false;
                snapshot.reasons.insert("directory-read-failed".into());
                continue;
            };
            loop {
                let entry = match entries.next_entry().await {
                    Ok(Some(entry)) => entry,
                    Ok(None) => break,
                    Err(_) => {
                        snapshot.complete = false;
                        snapshot.reasons.insert("directory-read-failed".into());
                        break;
                    }
                };
                count += 1;
                if count > MAX_ENTRIES {
                    snapshot.complete = false;
                    snapshot.reasons.insert("file-list-limit".into());
                    break 'walk;
                }
                let Ok(kind) = entry.file_type().await else {
                    snapshot.complete = false;
                    snapshot.reasons.insert("metadata-unavailable".into());
                    continue;
                };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if !matches!(
                        entry.file_name().to_str(),
                        Some(
                            ".git" | "node_modules" | "target" | "dist" | "out" | "build" | ".snow"
                        )
                    ) {
                        directories.push(entry.path());
                    }
                } else if kind.is_file() {
                    paths.insert(entry.path());
                }
            }
        }
    }
    if let Some(previous) = previous {
        paths.extend(previous.entries.values().map(|(path, _)| path.clone()));
    }
    let mut total = 0;
    for path in paths {
        if snapshot.entries.len() >= MAX_FILES {
            snapshot.complete = false;
            snapshot.reasons.insert("file-count-limit".into());
            break;
        }
        // Do not follow symlinks outside the scan root (nor directory symlinks).
        let Some(physical) = physical_path(&path) else {
            snapshot.complete = false;
            snapshot.reasons.insert("path-resolution-failed".into());
            continue;
        };
        if !overlap(&key(root), &key(&physical)) || !key(&physical).starts_with(&(key(root) + "/"))
        {
            snapshot.reasons.insert("external-symlink-excluded".into());
            continue;
        }
        // Separate (even nested) Git worktrees have their own coordination
        // domain; the parent repository must not attribute their writes.
        if repository_root(root).as_deref() == Some(root)
            && repository_root(&physical).as_deref() != Some(root)
        {
            snapshot.reasons.insert("nested-repository-excluded".into());
            continue;
        }
        let metadata = match tokio::fs::metadata(&physical).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                snapshot.entries.insert(key(&physical), (physical, None));
                continue;
            }
            Err(_) => {
                snapshot.complete = false;
                snapshot.reasons.insert("metadata-unavailable".into());
                continue;
            }
        };
        if !metadata.is_file() {
            snapshot.complete = false;
            snapshot.reasons.insert("non-file-excluded".into());
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES || total + metadata.len() > MAX_BYTES {
            snapshot.complete = false;
            snapshot.reasons.insert("content-byte-limit".into());
            continue;
        }
        let Ok(input) = tokio::fs::File::open(&physical).await else {
            snapshot.complete = false;
            snapshot.reasons.insert("file-read-failed".into());
            continue;
        };
        let mut bytes = Vec::new();
        if input
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .is_err()
        {
            snapshot.complete = false;
            snapshot.reasons.insert("file-read-failed".into());
            continue;
        }
        total += bytes.len() as u64;
        if bytes.len() as u64 > MAX_FILE_BYTES || total > MAX_BYTES {
            snapshot.complete = false;
            snapshot.reasons.insert("content-byte-limit".into());
            continue;
        }
        snapshot
            .entries
            .insert(key(&physical), (physical, Some(blake3::hash(&bytes))));
    }
    snapshot
}
async fn bounded_scan(root: &Path, previous: Option<&Snapshot>) -> Option<Snapshot> {
    tokio::time::timeout(SCAN_TIME, scan(root, previous))
        .await
        .ok()
}

pub(crate) struct TerminalTracking {
    root: Option<PathBuf>,
    before: Option<Snapshot>,
    reason: Option<&'static str>,
    _lease: Option<Arc<WriteLease>>,
}
impl TerminalTracking {
    pub(crate) async fn begin(args: &Value, remote: bool) -> Self {
        let reason = if remote {
            Some("ssh")
        } else if args.get("detach").and_then(Value::as_bool) == Some(true) {
            Some("detached")
        } else {
            None
        };
        let root = args
            .get("workingDirectory")
            .and_then(Value::as_str)
            .filter(|_| !remote)
            .and_then(|root| physical_path(Path::new(root)))
            .map(|path| repository_root(&path).unwrap_or(path));
        let mut tracking = Self {
            root,
            before: None,
            reason,
            _lease: None,
        };
        if tracking.reason.is_none() {
            if let Some(root) = tracking.root.as_ref() {
                // 同域已有终端窗口在跑（长时间命令）时立即降级：命令照常执行，
                // 只是本次不做文件归属追踪，绝不等待。
                tracking._lease =
                    coordinate(&[display(root)], LeaseClass::Terminal, TERMINAL_LEASE_WAIT).await;
                if tracking._lease.is_some() {
                    tracking.before = bounded_scan(root, None).await;
                } else {
                    tracking.reason = Some("concurrent-execution");
                }
            } else {
                tracking.reason = Some("root-unavailable");
            }
        }
        tracking
    }
    pub(crate) async fn finish(self) -> Value {
        if let Some(reason) = self.reason {
            return unavailable("terminal", reason);
        }
        let Some(root) = self.root.as_ref() else {
            return unavailable("terminal", "root-unavailable");
        };
        let after = bounded_scan(root, self.before.as_ref()).await;
        let (Some(before), Some(after)) = (self.before, after) else {
            return envelope(
                "terminal",
                Some(root),
                "unavailable",
                BTreeSet::from(["terminal-boundary".into(), "scan-time-limit".into()]),
                vec![],
            );
        };
        let mut reasons = before.reasons;
        reasons.extend(after.reasons);
        reasons.insert("terminal-boundary".into());
        let mut files = Vec::new();
        for (identity, (path, current)) in &after.entries {
            let old = before.entries.get(identity).map(|(_, hash)| hash);
            let kind = match (old, current) {
                (Some(Some(old)), Some(new)) if old != new => Some("edit"),
                (Some(Some(_)), None) => Some("delete"),
                (Some(None), Some(_)) => Some("create"),
                (None, Some(_)) if before.complete => Some("create"),
                _ => None,
            };
            if let Some(kind) = kind {
                if files.len() == MAX_RESULT_FILES {
                    reasons.insert("response-file-limit".into());
                    break;
                }
                files.push(file(path, kind));
            }
        }
        envelope("terminal", Some(root), "partial", reasons, files)
    }
}
