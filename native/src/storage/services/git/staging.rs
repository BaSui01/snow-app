use std::collections::HashSet;
use std::path::Path;

use napi::bindgen_prelude::*;

use super::status::parse_porcelain_z;
use super::{run_git, GitStageResult};

fn ok(message: &str) -> Result<GitStageResult> {
    Ok(GitStageResult {
        success: true,
        message: message.to_string(),
    })
}

// 只带回 git 原文（Display 会多出 "GenericFailure, " 前缀）。
fn failed(e: Error) -> Result<GitStageResult> {
    Ok(GitStageResult {
        success: false,
        message: e.reason.clone(),
    })
}

pub fn stage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to stage");
    }

    let mut args = vec!["add", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));

    match run_git(repo_path, &args) {
        Ok(_) => ok("Files staged successfully"),
        Err(e) => failed(e),
    }
}

pub fn unstage_files(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to unstage");
    }

    let mut args = vec!["reset", "HEAD", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));

    match run_git(repo_path, &args) {
        Ok(_) => ok("Files unstaged successfully"),
        Err(e) => failed(e),
    }
}

pub fn stage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["add", "--all"]) {
        Ok(_) => ok("All changes staged"),
        Err(e) => failed(e),
    }
}

pub fn unstage_all(repo_path: &str) -> Result<GitStageResult> {
    match run_git(repo_path, &["reset", "HEAD"]) {
        Ok(_) => ok("All changes unstaged"),
        Err(e) => failed(e),
    }
}

pub fn discard_changes(repo_path: &str, file_paths: &[String]) -> Result<GitStageResult> {
    if file_paths.is_empty() {
        return ok("No files to discard");
    }

    // 未跟踪文件走 `git clean -f`，其余走 `git checkout --` 恢复到 HEAD。
    let status_output = match run_git(repo_path, &["status", "--porcelain=v1", "-z", "-uall"]) {
        Ok(s) => s,
        Err(e) => return failed(e),
    };

    let path_set: HashSet<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    let mut untracked: Vec<&str> = Vec::new();
    let mut tracked: Vec<&str> = Vec::new();

    let (_, entries) = parse_porcelain_z(&status_output);
    for entry in &entries {
        if !path_set.contains(entry.path) {
            continue;
        }
        if entry.index == '?' {
            untracked.push(entry.path);
        } else {
            tracked.push(entry.path);
        }
    }

    // 状态里找不到的路径按已跟踪处理，由 checkout 自行报错。
    for p in &path_set {
        if !untracked.contains(p) && !tracked.contains(p) {
            tracked.push(*p);
        }
    }

    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(tracked.iter().copied());
        if let Err(e) = run_git(repo_path, &args) {
            return failed(e);
        }
    }

    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(untracked.iter().copied());
        let output = match run_git(repo_path, &args) {
            Ok(out) => out,
            Err(e) => return failed(e),
        };

        // clean 对目录 / 嵌套仓库会静默跳过，按磁盘实际残留判定。
        let root = Path::new(repo_path);
        let remaining: Vec<&str> = untracked
            .iter()
            .copied()
            .filter(|p| root.join(p).symlink_metadata().is_ok())
            .collect();
        if !remaining.is_empty() {
            let mut message = format!("git clean did not remove: {}", remaining.join(", "));
            let output = output.trim();
            if !output.is_empty() {
                message.push('\n');
                message.push_str(output);
            }
            return Ok(GitStageResult {
                success: false,
                message,
            });
        }
    }

    ok("Changes discarded successfully")
}
