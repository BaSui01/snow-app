use napi::bindgen_prelude::*;

use super::{is_git_repo, run_git, run_git_raw, GitBranch};

fn parse_track_info(track: &str) -> (i32, i32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let mut is_gone = false;

    for part in track.split(',') {
        let trimmed = part.trim();
        if trimmed == "gone" {
            is_gone = true;
        } else if let Some(rest) = trimmed.strip_prefix("ahead ") {
            if let Ok(n) = rest.trim().parse::<i32>() {
                ahead = n;
            }
        } else if let Some(rest) = trimmed.strip_prefix("behind ") {
            if let Ok(n) = rest.trim().parse::<i32>() {
                behind = n;
            }
        }
    }

    (ahead, behind, is_gone)
}

pub fn get_git_branches(repo_path: &str) -> Result<Vec<GitBranch>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = run_git(
        repo_path,
        &[
            "branch",
            "--list",
            "--all",
            "--format=%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track,nobracket)",
        ],
    )?;

    let mut branches: Vec<GitBranch> = Vec::new();

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }

        let is_current = parts[0].contains('*');
        let refname = parts[1].trim();
        let upstream_raw = if parts.len() > 3 { parts[3].trim() } else { "" };
        let track_raw = if parts.len() > 4 { parts[4].trim() } else { "" };

        // 排除空引用、本地 HEAD 符号引用以及远程 HEAD 符号引用（如 refs/remotes/origin/HEAD）
        if refname.is_empty() || refname == "HEAD" || refname.ends_with("/HEAD") {
            continue;
        }

        if let Some(branch_name) = refname.strip_prefix("refs/heads/") {
            if branch_name.is_empty() {
                continue;
            }
            let (ahead, behind, is_gone) = parse_track_info(track_raw);
            let upstream = if upstream_raw.is_empty() {
                None
            } else {
                Some(upstream_raw.to_string())
            };

            branches.push(GitBranch {
                name: branch_name.to_string(),
                is_current,
                is_remote: false,
                remote_name: None,
                upstream,
                ahead,
                behind,
                is_gone,
            });
        } else if let Some(remotes_part) = refname.strip_prefix("refs/remotes/") {
            if remotes_part.is_empty() {
                continue;
            }
            let Some((remote_name, branch_name)) = remotes_part.split_once('/') else {
                continue;
            };
            if branch_name == "HEAD" {
                continue;
            }
            branches.push(GitBranch {
                name: remotes_part.to_string(),
                is_current,
                is_remote: true,
                remote_name: Some(remote_name.to_string()),
                upstream: None,
                ahead: 0,
                behind: 0,
                is_gone: false,
            });
        }
    }

    Ok(branches)
}

/// Get the current branch name via `git rev-parse --abbrev-ref HEAD`.
/// Returns an empty string for detached HEAD or on error.
pub(crate) fn get_current_branch_name(repo_path: &str) -> Result<String> {
    let output = run_git_raw(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = output.trim();
    if branch.is_empty() || branch == "HEAD" {
        Ok(String::new())
    } else {
        Ok(branch.to_string())
    }
}
