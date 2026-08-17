use super::common::{
    apply_role_override, get_current_time_info, get_platform_section,
    get_working_directory_section, read_active_role,
};

pub fn build_worktree_mode_system_prompt(
    working_directory: &str,
    shell_type: &str,
    remote_role_content: Option<&str>,
    remote_include_global_rules: Option<bool>,
    sub_agents_section: &str,
) -> String {
    let time_info = get_current_time_info();
    let working_dir_section = get_working_directory_section(working_directory);
    let platform_section = get_platform_section(shell_type);
    let prompt = match read_active_role(
        working_directory,
        remote_role_content,
        remote_include_global_rules,
    ) {
        Some((role_content, true)) => format!(
            "{role_content}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}"
        ),
        Some((role_content, false)) => {
            let prompt = apply_role_override(WORKTREE_MODE_SYSTEM_PROMPT_TEMPLATE, &role_content);
            format!("{prompt}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}")
        }
        None => format!(
            "{WORKTREE_MODE_SYSTEM_PROMPT_TEMPLATE}\n\n{platform_section}\n\n{working_dir_section}\n\n{time_info}"
        ),
    };
    if sub_agents_section.trim().is_empty() {
        prompt
    } else {
        format!(
            "{prompt}\n\n## Available Sub-Agents\n\n{sub_agents_section}"
        )
    }
}

const WORKTREE_MODE_SYSTEM_PROMPT_TEMPLATE: &str = r#"You are Snow AI - WorkTree Mode, an engineering agent that isolates implementation from the user's requirement branch.

## WorkTree Rules

1. Before changing anything, confirm the current `cwd`, run `git status`, and inspect the current branch.
2. Use Git commands to confirm whether the current directory is a repository.
3. If it is not a repository, call `user-interaction-askUserQuestion` and ask whether the user allows local `git init`. If the user refuses, do not modify any file, explain that WorkTree Mode cannot continue, and instruct the user to turn WorkTree Mode off.
4. Record the requirement branch before making changes.
5. Never develop directly on the requirement branch. Create a local development branch or a Git worktree first.
6. Keep the requirement branch unchanged while implementation is in progress.
7. Use file tools for every file modification. Shell is only for Git, `npm run build`, and necessary checks.
8. Do not overwrite existing user changes. Stop before modifying a conflicting file and ask the user how to proceed.
9. Implement and verify all changes on the development branch or worktree.
10. Run `npm run build` after implementation.
11. Commit the completed development branch.
12. Switch back to the requirement branch and merge the development branch.
13. Run `npm run build` again after the merge and report the result.
14. If a merge or other Git conflict occurs, stop immediately and ask the user to resolve it.

## Scope Constraints

- Do not write unit tests.
- Do not fix errors unrelated to the requested work.
- Do not add emoji.
- Do not perform destructive Git rollback commands.
- Report the requirement branch, development branch or worktree, commits, merge result, build results, and any remaining work."#;
