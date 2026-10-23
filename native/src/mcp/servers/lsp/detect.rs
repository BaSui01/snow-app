//! 有界技术栈/源文件发现。未完成的扫描不可用于证明全项目覆盖或符号唯一。
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct ProjectStackDetection {
    pub path: String,
    pub lang: String,
    pub marker: String,
}

const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "out",
    "build",
    "vendor",
    "venv",
];
const LANGUAGES: &[&str] = &[
    "typescript",
    "rust",
    "go",
    "python",
    "java",
    "c",
    "csharp",
    "lua",
    "php",
    "ruby",
    "kotlin",
    "swift",
];
const MAX_SCANNED_FILES: usize = 3000;
const MAX_SCAN_DEPTH: usize = 6;
const LANG_DETECT_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectLanguageProfile {
    pub langs: Vec<String>,
    pub extensions: HashSet<String>,
}
static LANG_DETECT_CACHE: OnceLock<Mutex<HashMap<String, (ProjectLanguageProfile, Instant)>>> =
    OnceLock::new();

pub(crate) fn markers_for_lang(lang: &str) -> &'static [&'static str] {
    match lang {
        "typescript" => &["tsconfig.json", "jsconfig.json", "package.json"],
        "rust" => &["Cargo.toml"],
        "go" => &["go.mod", "go.work"],
        "python" => &[
            "pyproject.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
            "Pipfile",
        ],
        "java" => &[
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
        "c" => &["compile_commands.json", "CMakeLists.txt", "meson.build"],
        "csharp" => &["*.csproj", "*.sln", "*.fsproj"],
        "lua" => &[".luarc.json", ".luacheckrc"],
        "php" => &["composer.json"],
        "ruby" => &["Gemfile", "*.gemspec"],
        "kotlin" => &["build.gradle.kts", "*.kt"],
        "swift" => &["Package.swift", "*.xcodeproj"],
        _ => &[],
    }
}

fn marker_matches(name: &str, marker: &str) -> bool {
    match marker.strip_prefix('*') {
        Some(suffix) => name
            .to_ascii_lowercase()
            .ends_with(&suffix.to_ascii_lowercase()),
        None => name == marker,
    }
}
fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

#[derive(Default)]
pub(crate) struct ProjectInventory {
    pub files: Vec<PathBuf>,
    pub directories: Vec<PathBuf>,
    pub incomplete: bool,
}

pub(crate) fn scan_project_inventory(root: &Path, max_depth: usize) -> ProjectInventory {
    let mut result = ProjectInventory::default();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= MAX_SCANNED_FILES {
            result.incomplete = true;
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => {
                result.incomplete = true;
                continue;
            }
        };
        result.directories.push(dir.clone());
        let mut children = Vec::new();
        for entry in entries {
            if visited >= MAX_SCANNED_FILES {
                result.incomplete = true;
                break;
            }
            visited += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    result.incomplete = true;
                    continue;
                }
            };
            if kind.is_symlink() {
                result.incomplete = true;
            } else if kind.is_file() {
                result.files.push(entry.path());
            } else if kind.is_dir() && !should_skip_dir(&entry.file_name().to_string_lossy()) {
                if depth < max_depth {
                    children.push(entry.path());
                } else {
                    result.incomplete = true;
                }
            }
        }
        children.sort();
        queue.extend(children.into_iter().map(|path| (path, depth + 1)));
    }
    result.files.sort();
    result.directories.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then(a.cmp(b))
    });
    result
}

fn stacks_from_inventory(root: &Path, inventory: &ProjectInventory) -> Vec<ProjectStackDetection> {
    let mut names: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for path in inventory.files.iter().chain(inventory.directories.iter()) {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            names
                .entry(parent.to_path_buf())
                .or_default()
                .push(name.to_string_lossy().into_owned());
        }
    }
    let mut found = Vec::new();
    for dir in &inventory.directories {
        let entries = names.get(dir).map(Vec::as_slice).unwrap_or(&[]);
        for lang in LANGUAGES {
            let marker = markers_for_lang(lang)
                .iter()
                .find_map(|marker| entries.iter().find(|name| marker_matches(name, marker)));
            if let Some(marker) = marker {
                found.push(ProjectStackDetection {
                    path: dir
                        .strip_prefix(root)
                        .unwrap_or(dir)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    lang: (*lang).to_string(),
                    marker: marker.clone(),
                });
            }
        }
    }
    found
}

pub fn detect_project_stack(project_root: &str) -> Vec<ProjectStackDetection> {
    let root = Path::new(project_root);
    stacks_from_inventory(root, &scan_project_inventory(root, MAX_SCAN_DEPTH))
}

pub(crate) fn detect_project_languages_cached(project_root: &str) -> ProjectLanguageProfile {
    let key = std::fs::canonicalize(project_root)
        .unwrap_or_else(|_| PathBuf::from(project_root))
        .to_string_lossy()
        .into_owned();
    let cache = LANG_DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    if let Ok(guard) = cache.lock() {
        if let Some((profile, at)) = guard.get(&key) {
            if now.duration_since(*at) < LANG_DETECT_TTL {
                return profile.clone();
            }
        }
    }
    let root = Path::new(project_root);
    let inventory = scan_project_inventory(root, MAX_SCAN_DEPTH);
    let mut langs: Vec<String> = stacks_from_inventory(root, &inventory)
        .into_iter()
        .map(|d| d.lang)
        .collect();
    langs.sort();
    langs.dedup();
    let extensions = inventory
        .files
        .iter()
        .filter_map(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_ascii_lowercase)
        })
        .collect();
    let profile = ProjectLanguageProfile { langs, extensions };
    if let Ok(mut guard) = cache.lock() {
        guard.retain(|_, (_, at)| now.duration_since(*at) < LANG_DETECT_TTL);
        guard.insert(key, (profile.clone(), now));
    }
    profile
}

pub(crate) fn dir_has_lang_marker(dir: &Path, markers: &[&str]) -> bool {
    // 固定标志直接检查；通配目录扫描有界，不能对大型依赖目录无限遍历。
    markers.iter().any(|marker| match marker.strip_prefix('*') {
        Some(_) => std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .take(MAX_SCANNED_FILES)
                    .filter_map(Result::ok)
                    .any(|entry| marker_matches(&entry.file_name().to_string_lossy(), marker))
            })
            .unwrap_or(false),
        None => dir.join(marker).is_file(),
    })
}

#[derive(Default)]
pub(crate) struct LangRootDiscovery {
    pub roots: Vec<PathBuf>,
    pub incomplete: bool,
}

/// 独立子包不凭路径猜测属于父workspace；服务器自行解释成员/排除配置。
/// 因此保留所有真实根，仅合并相同物理根，跨根符号按位置去重。
pub(crate) fn discover_lang_roots(project_root: &Path, lang: &str) -> LangRootDiscovery {
    if markers_for_lang(lang).is_empty() {
        return LangRootDiscovery {
            roots: if project_root.is_dir() {
                vec![project_root.to_path_buf()]
            } else {
                vec![]
            },
            incomplete: !project_root.is_dir(),
        };
    }
    let inventory = scan_project_inventory(project_root, MAX_SCAN_DEPTH);
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for stack in stacks_from_inventory(project_root, &inventory)
        .into_iter()
        .filter(|d| d.lang == lang)
    {
        let root = project_root.join(stack.path);
        let physical = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        if seen.insert(physical) {
            roots.push(root);
        }
    }
    LangRootDiscovery {
        roots,
        incomplete: inventory.incomplete,
    }
}

pub(crate) fn find_lang_roots(project_root: &Path, lang: &str) -> Vec<PathBuf> {
    discover_lang_roots(project_root, lang).roots
}

/// 文件级从文件本身所属栈查找，不回落至主仓/兄弟工作树。
pub(crate) fn find_lang_root(
    project_root: &Path,
    start_dir: Option<&Path>,
    lang: &str,
) -> Option<PathBuf> {
    let markers = markers_for_lang(lang);
    if markers.is_empty() {
        return Some(project_root.to_path_buf());
    }
    if let Some(start) = start_dir {
        let canonical_root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        let start = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
        // 若传入的是文件父目录兜底根，仍需向上找到真正技术栈。
        let bounded = start != canonical_root && start.starts_with(&canonical_root);
        for dir in start.ancestors() {
            if dir_has_lang_marker(dir, markers) {
                return Some(dir.to_path_buf());
            }
            if bounded && dir == canonical_root {
                break;
            }
            // worktree根(.git为文件或目录)是语义边界，不能爬到另一个项目。
            if dir.join(".git").exists() {
                break;
            }
        }
        return None;
    }
    find_lang_roots(project_root, lang).into_iter().next()
}

/// Only stock gopls with no semantic overrides is eligible for Go workspace
/// sharing. Wrappers, flags, env/build/directory settings need server-specific
/// interpretation; retaining independent roots is safer than guessing.
fn can_share_go_workspace(config: &super::types::ServerConfig) -> bool {
    config.lang == "go"
        && matches!(
            Path::new(&config.command)
                .file_name()
                .and_then(|s| s.to_str()),
            Some("gopls" | "gopls.exe")
        )
        && config.args.is_empty()
        && config.initialization_options.as_ref().is_none_or(|value| {
            value.is_null() || value.as_object().is_some_and(|object| object.is_empty())
        })
}

/// Parse with the installed Go toolchain, never a home-grown go.work grammar.
/// GOTOOLCHAIN=local prevents discovery from downloading or running a requested
/// toolchain. Unsupported syntax/toolchains simply leave the original root.
#[cfg(test)]
pub(super) static GO_JSON_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

async fn go_json(go: &str, root: &Path, args: &[&std::ffi::OsStr]) -> Option<serde_json::Value> {
    #[cfg(test)]
    GO_JSON_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut command = tokio::process::Command::new(go);
    command
        .args(args)
        .current_dir(root)
        .env("PATH", super::probe::augmented_path_os_string())
        .env("GOTOOLCHAIN", "local")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().ok()?;
    let _tree = crate::utils::process_tree::ProcessTreeGuard::new("lsp-go-workspace", child.id()?);
    let output = tokio::time::timeout(Duration::from_secs(2), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

#[derive(Clone)]
struct GoEnvironmentSnapshot {
    value: serde_json::Value,
    files: Vec<PathBuf>,
    signature: blake3::Hash,
}
static GO_ENV_CACHE: OnceLock<
    tokio::sync::Mutex<HashMap<(String, PathBuf), GoEnvironmentSnapshot>>,
> = OnceLock::new();

/// Content-bind every possible ancestor marker (including absence), persisted
/// Go environment files, the selected explicit work file and process environment.
/// No TTL decides ownership; a newly created nested go.work invalidates at once.
async fn go_environment_signature(
    go: &str,
    root: &Path,
    extra_files: &[PathBuf],
) -> Option<blake3::Hash> {
    let mut env = std::env::vars_os()
        .map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect::<Option<Vec<_>>>()?;
    env.sort();
    let mut hash = blake3::Hasher::new();
    hash.update(&serde_json::to_vec(&env).ok()?);
    hash.update(
        super::probe::augmented_path_os_string()
            .to_str()?
            .as_bytes(),
    );
    let tool = tokio::fs::metadata(go).await.ok()?;
    hash.update(format!("{}:{:?}", tool.len(), tool.modified().ok()?).as_bytes());
    let mut files = extra_files.to_vec();
    for dir in root.ancestors() {
        files.push(dir.join("go.work"));
        files.push(dir.join("go.mod"));
    }
    files.sort();
    files.dedup();
    if files.len() > 128 {
        return None;
    }
    for path in files {
        hash.update(path.to_str()?.as_bytes());
        hash.update(&[0]);
        match tokio::fs::metadata(&path).await {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hash.update(&[0]);
            }
            Ok(meta) if meta.is_file() && meta.len() <= 512 * 1024 => {
                let physical = tokio::fs::canonicalize(&path).await.ok()?;
                hash.update(physical.to_str()?.as_bytes());
                let bytes = tokio::fs::read(&path).await.ok()?;
                if bytes.len() > 512 * 1024 {
                    return None;
                }
                hash.update(&[1]);
                hash.update(blake3::hash(&bytes).as_bytes());
            }
            _ => return None,
        }
    }
    Some(hash.finalize())
}

async fn go_environment(go: &str, root: &Path) -> Option<serde_json::Value> {
    let key = (go.to_string(), root.to_path_buf());
    let cached = {
        GO_ENV_CACHE
            .get_or_init(Default::default)
            .lock()
            .await
            .get(&key)
            .cloned()
    };
    if let Some(cached) = cached {
        if go_environment_signature(go, root, &cached.files).await == Some(cached.signature) {
            return Some(cached.value);
        }
    }
    let args = [
        "env".as_ref(),
        "-json".as_ref(),
        "GOWORK".as_ref(),
        "GOFLAGS".as_ref(),
        "GO111MODULE".as_ref(),
        "GOENV".as_ref(),
        "GOROOT".as_ref(),
    ];
    let value = go_json(go, root, &args).await?;
    let mut files = Vec::new();
    for field in ["GOENV", "GOWORK"] {
        if let Some(path) = value[field]
            .as_str()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
        {
            files.push(path);
        }
    }
    files.push(PathBuf::from(value["GOROOT"].as_str()?).join("go.env"));
    // The first response discovers the exact GOENV/GOROOT files. Re-read once
    // between snapshots before caching, rather than guessing platform locations.
    let before = go_environment_signature(go, root, &files).await;
    if let Some(signature) = before {
        let verified = go_json(go, root, &args).await?;
        if verified != value || go_environment_signature(go, root, &files).await != Some(signature)
        {
            return None;
        }
        let mut cache = GO_ENV_CACHE.get_or_init(Default::default).lock().await;
        if cache.len() >= 128 {
            cache.clear();
        }
        cache.insert(
            key,
            GoEnvironmentSnapshot {
                value: value.clone(),
                files,
                signature,
            },
        );
    }
    Some(value)
}

async fn effective_go_work(go: &str, root: &Path) -> Option<PathBuf> {
    let value = go_environment(go, root).await?;
    if value["GO111MODULE"].as_str() == Some("off")
        || value["GOFLAGS"]
            .as_str()
            .is_none_or(|flags| !flags.trim().is_empty())
    {
        return None;
    }
    let work = PathBuf::from(value["GOWORK"].as_str()?);
    if !work.is_absolute() {
        return None;
    } // includes GOWORK=off and no workspace
    tokio::fs::canonicalize(work).await.ok()
}

type GoWorkCache = HashMap<(PathBuf, String, String), (Option<Vec<PathBuf>>, Instant)>;
static GO_WORK_CACHE: OnceLock<tokio::sync::Mutex<GoWorkCache>> = OnceLock::new();

async fn go_work_members(go: &str, work: &Path) -> Option<Vec<PathBuf>> {
    // Hash bytes, not only mtime: editor saves and same-size edits invalidate
    // immediately. The cache contains parser output, never resolved membership.
    let metadata = tokio::fs::metadata(work).await.ok()?;
    if metadata.len() > 512 * 1024 {
        return None;
    }
    let bytes = tokio::fs::read(work).await.ok()?;
    if bytes.len() > 512 * 1024 {
        return None;
    }
    let key = (
        work.to_path_buf(),
        go.to_string(),
        blake3::hash(&bytes).to_hex().to_string(),
    );
    {
        let mut cache = GO_WORK_CACHE.get_or_init(Default::default).lock().await;
        cache.retain(|_, (_, at)| at.elapsed() < LANG_DETECT_TTL);
        if let Some((members, _)) = cache.get(&key) {
            return members.clone();
        }
    }
    // Never serialize unrelated workspaces behind an external parser process.
    let value = go_json(
        go,
        work.parent()?,
        &[
            "work".as_ref(),
            "edit".as_ref(),
            "-json".as_ref(),
            work.as_os_str(),
        ],
    )
    .await;
    let members = value.and_then(|value| {
        value["Use"]
            .as_array()?
            .iter()
            .map(|entry| entry["DiskPath"].as_str().map(PathBuf::from))
            .collect::<Option<Vec<_>>>()
    });
    // Do not cache a parse that raced with a file edit.
    if tokio::fs::read(work).await.ok().as_deref() != Some(bytes.as_slice()) {
        return None;
    }
    let mut cache = GO_WORK_CACHE.get_or_init(Default::default).lock().await;
    if cache.len() >= 128 {
        cache.clear();
    }
    cache.insert(key, (members.clone(), Instant::now()));
    members
}

/// Logical stack discovery is deliberately NOT coalesced: roots remain query
/// coverage units. All startup paths call this one physical-session resolver.
/// Only an actual `use` member with the same effective GOWORK at both cwd values
/// may share the workspace folder. No cross-worktree or sibling promotion.
pub(crate) async fn session_root(config: &super::types::ServerConfig, root: &Path) -> PathBuf {
    let original = root.to_path_buf();
    if !can_share_go_workspace(config) || !root.join("go.mod").is_file() {
        return original;
    }
    let Some(go) = super::probe::resolve_command("go") else {
        return original;
    };
    let Ok(module) = tokio::fs::canonicalize(root).await else {
        return original;
    };
    let Some(work) = effective_go_work(&go, &module).await else {
        return original;
    };
    let Some(owner) = work.parent() else {
        return original;
    };
    if owner == module || !module.starts_with(owner) {
        return original;
    }
    // .git files (linked worktrees) and directories are equally hard boundaries.
    if module
        .ancestors()
        .take_while(|dir| *dir != owner)
        .any(|dir| dir.join(".git").try_exists().unwrap_or(true))
    {
        return original;
    }
    if effective_go_work(&go, owner).await.as_deref() != Some(work.as_path()) {
        return original;
    }
    let Some(members) = go_work_members(&go, &work).await else {
        return original;
    };
    for member in members {
        if tokio::fs::canonicalize(owner.join(member))
            .await
            .ok()
            .as_ref()
            == Some(&module)
        {
            return owner.to_path_buf();
        }
    }
    original
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markers_cover_lsp_languages() {
        for lang in LANGUAGES {
            assert!(!markers_for_lang(lang).is_empty());
        }
        assert!(markers_for_lang("brainfuck").is_empty());
        assert!(marker_matches("App.xcodeproj", "*.xcodeproj"));
        assert!(marker_matches("Lib.gemspec", "*.gemspec"));
        assert!(marker_matches("App.fsproj", "*.fsproj"));
        let mut config = super::super::types::ServerConfig {
            lang: "go".into(),
            command: "gopls".into(),
            args: vec![],
            file_extensions: vec!["go".into()],
            install_command: None,
            initialization_options: None,
            enabled: true,
        };
        assert!(can_share_go_workspace(&config));
        config.initialization_options = Some(serde_json::json!({"env":{"GOWORK":"off"}}));
        assert!(!can_share_go_workspace(&config));
        config.initialization_options = None;
        config.args = vec!["-remote=auto".into()];
        assert!(!can_share_go_workspace(&config));
        config.args.clear();
        config.command = "wrapper".into();
        assert!(!can_share_go_workspace(&config));
    }
    #[test]
    fn find_lang_root_walks_up_to_nearest_ancestor() {
        // Child invocations isolate Go environment overrides from parallel Rust
        // tests and from the host process (no set_var / go env -w).
        if let Some(module) = std::env::var_os("SNOW_LSP_GO_ROOT_FIXTURE") {
            let expected = PathBuf::from(std::env::var_os("SNOW_LSP_GO_ROOT_EXPECTED").unwrap());
            let config = super::super::types::ServerConfig {
                lang: "go".into(),
                command: "gopls".into(),
                args: vec![],
                file_extensions: vec!["go".into()],
                install_command: None,
                initialization_options: None,
                enabled: true,
            };
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let module = std::fs::canonicalize(module).unwrap();
            let expected = std::fs::canonicalize(expected).unwrap();
            assert_eq!(runtime.block_on(session_root(&config, &module)), expected);
            if expected != module {
                let calls = GO_JSON_CALLS.load(std::sync::atomic::Ordering::Relaxed);
                assert_eq!(runtime.block_on(session_root(&config, &module)), expected);
                assert_eq!(
                    GO_JSON_CALLS.load(std::sync::atomic::Ordering::Relaxed),
                    calls,
                    "unchanged routing must not spawn go env again"
                );
                if std::env::var("GOWORK").unwrap_or_default().is_empty() {
                    let nested = module.join("go.work");
                    std::fs::write(&nested, "go 1.18\nuse .\n").unwrap();
                    assert_eq!(runtime.block_on(session_root(&config, &module)), module);
                    std::fs::remove_file(nested).unwrap();
                    assert_eq!(runtime.block_on(session_root(&config, &module)), expected);
                }
            }
            return;
        }
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let start = manifest.join("src").join("mcp");
        assert_eq!(
            find_lang_root(manifest, Some(&start), "rust"),
            std::fs::canonicalize(manifest).ok()
        );
        assert!(find_lang_roots(manifest, "rust")
            .iter()
            .any(|root| root == manifest));
        if super::super::probe::resolve_command("go").is_none() {
            eprintln!("Go routing fixture skipped: installed Go toolchain unavailable");
            return;
        }
        let fixture =
            std::env::temp_dir().join(format!("snow-lsp-go-roots-{}", uuid::Uuid::new_v4()));
        for dir in ["member space", "other", "unlisted", "nested/leaf", ".git"] {
            std::fs::create_dir_all(fixture.join(dir)).unwrap();
        }
        for dir in ["member space", "other", "unlisted", "nested/leaf"] {
            std::fs::write(
                fixture.join(dir).join("go.mod"),
                format!("module example.test/{}\n\ngo 1.18\n", dir.replace(' ', "-")),
            )
            .unwrap();
        }
        let work = fixture.join("go.work");
        std::fs::write(
            &work,
            "go 1.18\nuse (\n \"./member space\" // quoted path\n ./other\n ./nested/leaf\n)\n",
        )
        .unwrap();
        let run = |gowork: &std::ffi::OsStr, module: &Path, expected: &Path| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "mcp::servers::lsp::detect::tests::find_lang_root_walks_up_to_nearest_ancestor",
                    "--nocapture",
                ])
                .env("SNOW_LSP_GO_ROOT_FIXTURE", module)
                .env("SNOW_LSP_GO_ROOT_EXPECTED", expected)
                .env("GOENV", "off")
                .env("GOFLAGS", "")
                .env("GO111MODULE", "on")
                .env("GOTOOLCHAIN", "local")
                .env("GOWORK", gowork)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Go fixture failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let member = fixture.join("member space");
        run("".as_ref(), &member, &fixture);
        run("off".as_ref(), &member, &member);
        run(work.as_os_str(), &member, &fixture);
        let unlisted = fixture.join("unlisted");
        run("".as_ref(), &unlisted, &unlisted);
        std::fs::write(fixture.join("nested/go.work"), "go 1.18\nuse ./leaf\n").unwrap();
        let leaf = fixture.join("nested/leaf");
        run("".as_ref(), &leaf, &fixture.join("nested"));
        // Explicit GOWORK wins over the nested auto-discovered workspace.
        run(work.as_os_str(), &leaf, &fixture);
        std::fs::write(member.join(".git"), "gitdir: example-worktree\n").unwrap();
        run("".as_ref(), &member, &member);
        std::fs::write(&work, "not valid go workspace syntax\n").unwrap();
        let other = fixture.join("other");
        run("".as_ref(), &other, &other);
        // Fixtures live only in the OS temp directory, never in a business repo.
        std::fs::remove_dir_all(&fixture).unwrap();
    }
    #[test]
    fn file_request_does_not_fall_back_to_unrelated_root() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            find_lang_root(manifest, Some(&manifest.join("src")), "go"),
            None
        );
    }
    #[test]
    fn depth_limit_is_reported() {
        let inventory = scan_project_inventory(Path::new(env!("CARGO_MANIFEST_DIR")), 0);
        assert!(inventory.incomplete);
        assert!(inventory
            .files
            .iter()
            .any(|file| file.ends_with("Cargo.toml")));
    }

    #[test]
    fn independent_roots_and_wildcard_markers_are_preserved() {
        let root = Path::new("/workspace");
        let inventory = ProjectInventory {
            files: vec![
                root.join("a/Cargo.toml"),
                root.join("b/Cargo.toml"),
                root.join("c/lib.gemspec"),
                root.join("d/app.fsproj"),
            ],
            directories: vec![
                root.into(),
                root.join("a"),
                root.join("b"),
                root.join("c"),
                root.join("d"),
                root.join("e"),
                root.join("e/App.xcodeproj"),
            ],
            incomplete: false,
        };
        let stacks = stacks_from_inventory(root, &inventory);
        assert_eq!(stacks.iter().filter(|s| s.lang == "rust").count(), 2);
        assert!(stacks.iter().any(|s| s.lang == "ruby"));
        assert!(stacks.iter().any(|s| s.lang == "csharp"));
        assert!(stacks.iter().any(|s| s.lang == "swift"));
    }
}
