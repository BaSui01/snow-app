use napi::bindgen_prelude::*;

use super::{is_git_repo, run_git, run_git_raw, GitBranch};

pub fn get_git_branches(repo_path: &str) -> Result<Vec<GitBranch>> {
    if !is_git_repo(repo_path) {
        return Ok(Vec::new());
    }

    let output = run_git(
        repo_path,
        &["branch", "--list", "--all", "--format=%(HEAD)%(refname)"],
    )?;

    let mut branches: Vec<GitBranch> = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let is_current = trimmed.starts_with('*');
        let refname = if is_current {
            trimmed[1..].trim_start()
        } else {
            trimmed
        };

        if let Some(name) = refname.strip_prefix("refs/heads/") {
            branches.push(GitBranch {
                name: name.to_string(),
                is_current,
                is_remote: false,
                remote_name: None,
            });
            continue;
        }

        let Some(rest) = refname.strip_prefix("refs/remotes/") else {
            continue;
        };
        let Some((remote_name, branch_name)) = rest.split_once('/') else {
            continue;
        };
        // refs/remotes/<remote>/HEAD 是符号引用，不作为分支展示。
        if branch_name == "HEAD" {
            continue;
        }

        branches.push(GitBranch {
            name: rest.to_string(),
            is_current,
            is_remote: true,
            remote_name: Some(remote_name.to_string()),
        });
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
