//! 项目技术栈检测：扫描项目根目录（递归深度 ≤ 2，支持 monorepo 子目录），
//! 识别项目实际使用的语言/技术栈（无副作用，纯文件系统，无 DB 依赖）。
//!
//! 供设置页「检测技术栈」功能使用：根据识别结果展示对应语言服务器的启用状态。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 单条检测结果。
#[derive(Clone, Debug)]
pub struct ProjectStackDetection {
    /// 相对项目根的目录（"" = 根，或 "frontend"、"packages/web"）。
    pub path: String,
    /// 语言：typescript | rust | go | python | java | csharp | php | ruby | lua | kotlin。
    pub lang: String,
    /// 命中的标志文件名（package.json / Cargo.toml / go.mod ...）。
    pub marker: String,
}

/// 递归扫描时跳过的目录（隐藏目录以 "." 开头另行判断）。
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "out",
    "build",
    "vendor",
    ".venv",
    "venv",
];

/// 固定标志文件名 → lang 映射（按此优先级检查，同 lang 多标志时保留最先命中的 marker）。
///
/// 2026-09-24 扩展：覆盖 LSP 能力表全部语言的技术栈标志（栈根发现 / 工具暴露
/// 判定共用；此前仅覆盖 UI 技术栈展示所需的最小子集）。不支持通配（如
/// *.csproj / *.gemspec）——csharp / kotlin / lua 由下方扩展名检测兜底。
const MARKER_FILES: &[(&str, &str)] = &[
    ("package.json", "typescript"),
    ("tsconfig.json", "typescript"),
    ("jsconfig.json", "typescript"),
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("go.work", "go"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("setup.py", "python"),
    ("setup.cfg", "python"),
    ("Pipfile", "python"),
    ("pom.xml", "java"),
    ("build.gradle", "java"),
    ("build.gradle.kts", "java"),
    ("settings.gradle", "java"),
    ("settings.gradle.kts", "java"),
    ("composer.json", "php"),
    ("Gemfile", "ruby"),
    ("compile_commands.json", "c"),
    ("CMakeLists.txt", "c"),
    ("meson.build", "c"),
    ("Package.swift", "swift"),
    (".luarc.json", "lua"),
    (".luacheckrc", "lua"),
];

/// 检测项目技术栈：扫描 project_root（递归深度 ≤ 2），返回 (path, lang) 去重后
/// 按 path + lang 字典序排序的结果。project_root 不存在/不可读 → 空 Vec（不报错）。
pub fn detect_project_stack(project_root: &str) -> Vec<ProjectStackDetection> {
    let root = Path::new(project_root);
    if !root.is_dir() {
        return Vec::new();
    }

    let mut results: Vec<ProjectStackDetection> = Vec::new();
    scan_dir(root, "", 0, &mut results);

    // (path, lang) 去重（同目录多标志命中同 lang 时保留首个），再按 path + lang 稳定排序。
    let mut seen: HashSet<(String, String)> = HashSet::new();
    results.retain(|d| seen.insert((d.path.clone(), d.lang.clone())));
    results.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.lang.cmp(&b.lang)));
    results
}

/// 扫描文件数上限（防止超大仓库根目录导致提示词构建卡顿；达到上限后停止
/// 新增，已收集的保留）。
const MAX_SCANNED_FILES: usize = 3000;

/// 项目语言检测结果：标志文件检测出的语言 + 实际文件扩展名（两者互补）。
#[derive(Clone, Debug, Default)]
pub(crate) struct ProjectLanguageProfile {
    /// detect_project_stack 识别出的语言（如 rust / typescript / go）。
    pub langs: Vec<String>,
    /// 项目文件扩展名小写集合（如 "rs"、"ts"、"cpp"）。
    pub extensions: HashSet<String>,
}

/// 语言检测结果 TTL 缓存：`tool_exposure`（每轮对话）与系统提示词注入
/// （每次聊天请求）都会扫描项目，而项目语言很少变化——短 TTL 避免重复
/// 全量目录遍历（大项目根目录可达上万文件）。配置热更新后最多 60s 内
/// 反映新状态，可接受。
const LANG_DETECT_TTL: Duration = Duration::from_secs(60);
static LANG_DETECT_CACHE: OnceLock<Mutex<HashMap<String, (ProjectLanguageProfile, Instant)>>> =
    OnceLock::new();

/// 检测项目语言（缓存版）：一次调用同时返回标志文件语言与文件扩展名，
/// 供 collect 阶段工具暴露与系统提示词注入共用同一份检测结果（单一事实
/// 来源，避免两处扫描口径不一致）。
pub(crate) fn detect_project_languages_cached(project_root: &str) -> ProjectLanguageProfile {
    let cache = LANG_DETECT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = Instant::now();
    {
        let guard = cache.lock().expect("lang detect cache poisoned");
        if let Some((profile, at)) = guard.get(project_root) {
            if now.duration_since(*at) < LANG_DETECT_TTL {
                return profile.clone();
            }
        }
    }
    let langs = detect_project_stack(project_root)
        .iter()
        .map(|detection| detection.lang.clone())
        .collect();
    let extensions = scan_project_file_extensions(project_root);
    let profile = ProjectLanguageProfile { langs, extensions };
    cache
        .lock()
        .expect("lang detect cache poisoned")
        .insert(project_root.to_string(), (profile.clone(), now));
    profile
}

/// 扫描项目根（递归深度 ≤ 2，跳过隐藏/依赖目录），返回去重后的文件扩展名
/// 小写集合（如 "rs"、"ts"、"cpp"、"md"）。与 `detect_project_stack` 的标志
/// 文件检测互补：覆盖没有项目标志文件的 C/C++/Swift 等（由系统提示词注入
/// 用服务器配置的 file_extensions 直接匹配）。project_root 不存在/不可读 →
/// 空集合（不报错）。
pub(crate) fn scan_project_file_extensions(project_root: &str) -> HashSet<String> {
    let root = Path::new(project_root);
    if !root.is_dir() {
        return HashSet::new();
    }
    let mut extensions = HashSet::new();
    let mut scanned: usize = 0;
    scan_extensions_dir(root, 0, &mut extensions, &mut scanned);
    extensions
}

/// 递归扫描目录收集文件扩展名（深度 ≤ 2；与 scan_dir 同遍历规则）。
fn scan_extensions_dir(
    dir: &Path,
    depth: usize,
    extensions: &mut HashSet<String>,
    scanned: &mut usize,
) {
    if *scanned >= MAX_SCANNED_FILES {
        return;
    }
    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect(),
        Err(_) => return,
    };

    for entry in &entries {
        if *scanned >= MAX_SCANNED_FILES {
            return;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        *scanned += 1;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let path = Path::new(name);
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            extensions.insert(ext.to_ascii_lowercase());
        }
    }

    // 子目录递归（深度 < 2 才下探；跳过隐藏/依赖目录；符号链接目录不跟随）。
    if depth < 2 {
        for entry in &entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if should_skip_dir(name) {
                continue;
            }
            let child = entry.path();
            scan_extensions_dir(&child, depth + 1, extensions, scanned);
        }
    }
}

/// 递归扫描单个目录。depth = 当前深度（根 = 0），最多下探到 2；
/// rel = 相对项目根的目录路径（"" = 根，子目录用 "/" 连接）。
fn scan_dir(dir: &Path, rel: &str, depth: usize, results: &mut Vec<ProjectStackDetection>) {
    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.filter_map(Result::ok).collect(),
        Err(_) => return,
    };

    // 固定标志文件（优先级顺序；同 lang 多标志只记第一个，去重见 detect_project_stack）。
    for &(marker, lang) in MARKER_FILES {
        if entries.iter().any(|e| e.file_name() == marker) {
            results.push(ProjectStackDetection {
                path: rel.to_string(),
                lang: lang.to_string(),
                marker: marker.to_string(),
            });
        }
    }

    // 目录条目扩展名 glob（随 read_dir 结果检查，无需额外遍历；marker 记实际文件名）。
    // 注意：*.kts 不映射 kotlin——build.gradle.kts 属 Java 项目标志，避免 gradle
    // kotlin DSL 与 kotlin 语言误判冲突（*.kt 才映射 kotlin）。
    let mut ext_detected: HashSet<&str> = HashSet::new();
    for entry in &entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".csproj") || lower.ends_with(".sln") {
            if ext_detected.insert("csharp") {
                results.push(ProjectStackDetection {
                    path: rel.to_string(),
                    lang: "csharp".to_string(),
                    marker: name.to_string(),
                });
            }
        } else if lower.ends_with(".kt") {
            if ext_detected.insert("kotlin") {
                results.push(ProjectStackDetection {
                    path: rel.to_string(),
                    lang: "kotlin".to_string(),
                    marker: name.to_string(),
                });
            }
        } else if lower.ends_with(".lua") {
            if ext_detected.insert("lua") {
                results.push(ProjectStackDetection {
                    path: rel.to_string(),
                    lang: "lua".to_string(),
                    marker: name.to_string(),
                });
            }
        }
    }

    // 子目录递归（深度 < 2 才下探；跳过隐藏/依赖目录；符号链接目录不跟随，避免循环）。
    if depth < 2 {
        for entry in &entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if should_skip_dir(name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            scan_dir(&entry.path(), &child_rel, depth + 1, results);
        }
    }
}

/// 隐藏目录（"." 开头）与构建产物/依赖目录跳过。
fn should_skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

// ---------------------------------------------------------------------------
// 技术栈根发现（LSP workspace 根，2026-09-24）
// ---------------------------------------------------------------------------

/// 各语言「技术栈根」标志文件（供**向上查找**使用，允许 `*` 前缀后缀通配）。
///
/// 与 MARKER_FILES 的关系：MARKER_FILES 供目录扫描（detect_project_stack，
/// 不支持通配）；本表供文件级向上查找（如 native/src/x.rs → native/Cargo.toml
/// 所在目录）。两表语义对齐——同一语言的技术栈标志应尽量一致。未定义标志
/// 的语言返回空切片，调用方对空标志不做栈根约束（保持旧行为）。
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
        // kotlin：gradle Kotlin DSL 或含 .kt 源文件的目录（与 java 的
        // build.gradle.kts 存在重叠——重叠只会让双方都「匹配」，由具体
        // 服务器命令是否安装与调用时的文件扩展名决定实际使用者）。
        "kotlin" => &["build.gradle.kts", "*.kt"],
        "swift" => &["Package.swift", "*.xcodeproj"],
        _ => &[],
    }
}

/// 目录是否命中任一标志（`*` 前缀 = 后缀通配，如 *.csproj / *.kt）。
pub(crate) fn dir_has_lang_marker(dir: &Path, markers: &[&str]) -> bool {
    markers.iter().any(|marker| match marker.strip_prefix('*') {
        Some(suffix) => {
            let suffix = suffix.to_ascii_lowercase();
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries.filter_map(Result::ok).any(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .to_ascii_lowercase()
                            .ends_with(&suffix)
                    })
                })
                .unwrap_or(false)
        }
        None => dir.join(marker).exists(),
    })
}

/// 发现某语言的技术栈根（LSP workspace 根）。
///
/// 解析顺序：
/// 1. `start_dir` 提供时从该目录**向上**查找（含 project_root 层）——
///    文件级请求用它：monorepo 中每个 crate / 子包各自命中最近的栈根
///    （如 native/src/x.rs → native/Cargo.toml 所在目录）；
/// 2. 未命中（或 start_dir 为 None，如 workspace-symbols 无文件上下文）
///    时从 project_root **向下**扫描（detect_project_stack，深度 ≤2、
///    60s TTL 缓存）——取该语言最浅的命中目录；
/// 3. 仍未命中 → None（调用方据此拒绝启动：技术栈不存在，不暴露不使用）。
///
/// 标志未定义的语言（markers 为空）→ Some(project_root)（不约束，旧行为）。
pub(crate) fn find_lang_root(
    project_root: &Path,
    start_dir: Option<&Path>,
    lang: &str,
) -> Option<PathBuf> {
    let markers = markers_for_lang(lang);
    if markers.is_empty() {
        return Some(project_root.to_path_buf());
    }
    // 1) 向上查找：start → project_root（含）。路径比较统一小写（Windows
    //    大小写不敏感）；start 在项目外时一路向上到文件系统根（分析外部
    //    文件的合理语义：以其所属技术栈根为根）。
    if let Some(start) = start_dir {
        let root_key = project_root.to_string_lossy().to_ascii_lowercase();
        let mut current = Some(start.to_path_buf());
        while let Some(dir) = current {
            if dir_has_lang_marker(&dir, markers) {
                return Some(dir);
            }
            if dir.to_string_lossy().to_ascii_lowercase() == root_key {
                break; // 已到项目根仍未命中 → 停止（项目根之上不属于本项目）
            }
            current = dir.parent().map(Path::to_path_buf);
        }
    }
    // 2) 向下扫描（复用 detect_project_stack 的 60s TTL 缓存）。
    detect_project_stack(&project_root.to_string_lossy())
        .iter()
        .find(|detection| detection.lang == lang)
        .map(|detection| {
            if detection.path.is_empty() {
                project_root.to_path_buf()
            } else {
                project_root.join(&detection.path)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_cover_lsp_languages() {
        assert!(markers_for_lang("rust").contains(&"Cargo.toml"));
        assert!(markers_for_lang("go").contains(&"go.mod"));
        assert!(markers_for_lang("typescript").contains(&"tsconfig.json"));
        assert!(markers_for_lang("python").contains(&"pyproject.toml"));
        assert!(markers_for_lang("java").contains(&"pom.xml"));
        assert!(markers_for_lang("c").contains(&"CMakeLists.txt"));
        assert!(markers_for_lang("swift").contains(&"Package.swift"));
        // 未定义语言：空标志（调用方不约束）。
        assert!(markers_for_lang("brainfuck").is_empty());
    }

    #[test]
    fn find_lang_root_walks_up_to_nearest_ancestor() {
        // 用本 crate 的真实结构：CARGO_MANIFEST_DIR = .../native（含 Cargo.toml）。
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let start = manifest.join("src").join("mcp");
        assert_eq!(
            find_lang_root(manifest, Some(&start), "rust"),
            Some(manifest.to_path_buf())
        );
        // 无文件上下文（向下扫描）同样命中自身。
        assert_eq!(
            find_lang_root(manifest, None, "rust"),
            Some(manifest.to_path_buf())
        );
    }

    #[test]
    fn find_lang_root_returns_none_without_stack() {
        // native/ 下没有 go.mod → go 栈根不存在（拒绝启动）。
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(find_lang_root(manifest, None, "go"), None);
        assert_eq!(
            find_lang_root(manifest, Some(&manifest.join("src")), "go"),
            None
        );
    }
}
