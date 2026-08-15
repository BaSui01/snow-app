use std::collections::HashMap;
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::parser::ParseOptions;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;

use super::types::{ReferenceInfo, SymbolInfo, SymbolLocation};

#[derive(Clone, Debug)]
pub struct IndexEntry {
    pub symbol: SymbolInfo,
}

pub struct SymbolIndex {
    symbols_by_name: HashMap<String, Vec<IndexEntry>>,
    exports_by_file: HashMap<String, Vec<IndexEntry>>,
}

impl SymbolIndex {
    pub fn new() -> Self {
        SymbolIndex {
            symbols_by_name: HashMap::new(),
            exports_by_file: HashMap::new(),
        }
    }

    pub fn index_file(&mut self, file_path: &str, source_text: &str) {
        if super::is_js_ts(file_path) {
            // JS/TS: use oxc deep semantic analysis
            let exports = parse_file_for_index(file_path, source_text);
            for entry in &exports {
                self.symbols_by_name
                    .entry(entry.symbol.name.clone())
                    .or_default()
                    .push(entry.clone());
            }
            self.exports_by_file.insert(file_path.to_string(), exports);
        } else {
            // Other languages: use tree-sitter outline for definitions
            let outline = super::tree_sitter_analyzer::build_file_outline(file_path, source_text);
            let mut exports = Vec::new();
            for entry in outline {
                let symbol = SymbolInfo {
                    name: entry.name.clone(),
                    kind: entry.kind.clone(),
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: entry.line,
                        column: entry.column,
                        end_line: entry.end_line,
                        end_column: entry.end_column,
                    },
                    container_name: entry.container_name.clone(),
                    is_exported: entry.is_exported,
                };
                let index_entry = IndexEntry {
                    symbol: symbol.clone(),
                };
                self.symbols_by_name
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(index_entry.clone());
                exports.push(index_entry);
            }
            self.exports_by_file.insert(file_path.to_string(), exports);
        }
    }

    /// Index a file from its path on disk, auto-detecting the language.
    fn index_file_from_disk(&mut self, file_path: &str) {
        let source_text = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => return,
        };
        self.index_file(file_path, &source_text);
    }

    /// Index all source files found under `root_dir`.
    pub fn index_project(&mut self, root_dir: &Path) {
        let files = discover_source_files(root_dir);
        for file in files {
            let path_str = file.to_string_lossy().to_string();
            self.index_file_from_disk(&path_str);
        }
    }

    /// Find all references to a symbol by name across the entire project.
    /// Searches every indexed file for occurrences of the given name.
    pub fn find_references_across_project(&self, name: &str) -> Vec<ReferenceInfo> {
        let mut all_refs = Vec::new();

        for file_path_str in self.exports_by_file.keys() {
            let source_text = match std::fs::read_to_string(file_path_str) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let refs = if super::is_js_ts(file_path_str) {
                super::analyzer::find_references_by_name(file_path_str, &source_text, name)
            } else {
                super::tree_sitter_analyzer::find_references_by_name(
                    file_path_str,
                    &source_text,
                    name,
                )
            };

            all_refs.extend(refs);
        }

        all_refs
    }

    /// Find the definition of a symbol by name across the entire project.
    /// Returns the first match found.
    pub fn find_definition_across_project(&self, name: &str) -> Option<SymbolInfo> {
        // First check the symbol index for a fast lookup
        if let Some(entries) = self.symbols_by_name.get(name) {
            if let Some(entry) = entries.first() {
                return Some(entry.symbol.clone());
            }
        }

        // Fallback: scan every indexed file
        for file_path_str in self.exports_by_file.keys() {
            let source_text = match std::fs::read_to_string(file_path_str) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let def = if super::is_js_ts(file_path_str) {
                super::analyzer::find_definition_by_name(file_path_str, &source_text, name)
            } else {
                super::tree_sitter_analyzer::find_definition_by_name(
                    file_path_str,
                    &source_text,
                    name,
                )
            };

            if def.is_some() {
                return def;
            }
        }

        None
    }
}

fn parse_file_for_index(file_path: &str, source_text: &str) -> Vec<IndexEntry> {
    let path = Path::new(file_path);
    let source_type = SourceType::from_path(path).unwrap_or_default();

    let allocator = Allocator::default();
    let parse_ret = oxc::parser::Parser::new(&allocator, source_text, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            ..ParseOptions::default()
        })
        .parse();

    let program = parse_ret.program;
    let semantic_ret = SemanticBuilder::new().build(&program);
    let semantic = &semantic_ret.semantic;
    let scoping = semantic.scoping();
    let line_index = super::analyzer::LineIndexRef::new(source_text);

    let mut exports: Vec<IndexEntry> = Vec::new();
    for symbol_id in scoping.symbol_ids() {
        let scope_id = scoping.symbol_scope_id(symbol_id);
        if scope_id == scoping.root_scope_id() {
            let name = scoping.symbol_name(symbol_id).to_string();
            let span = scoping.symbol_span(symbol_id);
            let (start_line, start_col) = line_index.line_col(span.start);
            let (end_line, end_col) = line_index.line_col(span.end);

            exports.push(IndexEntry {
                symbol: SymbolInfo {
                    name: name.clone(),
                    kind: "variable".to_string(),
                    location: SymbolLocation {
                        file_path: file_path.to_string(),
                        line: start_line,
                        column: start_col,
                        end_line,
                        end_column: end_col,
                    },
                    container_name: None,
                    is_exported: true,
                },
            });
        }
    }

    exports
}

fn discover_source_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_source_dir(root, &mut files);
    files.sort();
    files
}

fn walk_source_dir(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_skip_dir(name) {
                    continue;
                }
            }
            walk_source_dir(&path, files);
        } else if path.is_file() && is_source_file(&path) {
            files.push(path);
        }
    }
}

fn is_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | ".svn"
            | ".hg"
            | "target"
            | "dist"
            | "out"
            | "build"
            | ".next"
            | ".nuxt"
            | ".snow"
            | ".cache"
            | ".turbo"
            | "__pycache__"
            | ".pytest_cache"
            | ".venv"
            | "venv"
            | ".idea"
            | ".vscode"
            | "coverage"
            | ".nyc_output"
            | "release"
    )
}

fn is_source_file(path: &Path) -> bool {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_lowercase(),
        None => return false,
    };
    matches!(
        ext.as_str(),
        "ts" | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "mts"
            | "cts"
            | "py"
            | "pyw"
            | "pyi"
            | "rs"
            | "go"
            | "c"
            | "h"
            | "java"
            | "cs"
            | "rb"
            | "php"
            | "phtml"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "json"
            | "json5"
            | "jsonc"
            | "yaml"
            | "yml"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "psm1"
            | "bat"
            | "cmd"
            | "lua"
    )
}
