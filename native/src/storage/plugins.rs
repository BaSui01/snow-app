use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

use napi::bindgen_prelude::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::database;
use super::models::{PluginRecord, PluginStorageValue};

const PLUGINS_DIR_NAME: &str = "plugins";
const MANIFEST_FILE_NAME: &str = "plugin.json";
const DEFAULT_ENTRY_FILE: &str = "index.js";
const SKIPPED_COPY_ENTRIES: [&str; 2] = [".git", "node_modules"];
const MAX_PLUGIN_COPY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PLUGIN_TEXT_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PLUGIN_BINARY_FILE_BYTES: u64 = 16 * 1024 * 1024;

struct PluginManifest {
    id: String,
    name: Value,
    description: Value,
    version: String,
    author: String,
    homepage: String,
    license: String,
    icon: String,
    render_mode: String,
    entry: String,
    panels: Value,
    locales: Value,
    styles: Value,
    privacy: Vec<String>,
    privacy_note: String,
    min_app_version: String,
}

pub fn plugins_dir() -> Result<PathBuf> {
    Ok(super::paths::app_storage_dir()?.join(PLUGINS_DIR_NAME))
}

fn plugin_install_dir(plugin_id: &str) -> Result<PathBuf> {
    Ok(plugins_dir()?.join(plugin_id))
}

fn normalize_localized(value: Option<&Value>, fallback: &str) -> Value {
    let mut map = Map::new();
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                map.insert("default".to_string(), Value::String(trimmed.to_string()));
            }
        }
        Some(Value::Object(entries)) => {
            for (locale, item) in entries {
                let Some(text) = item.as_str() else { continue };
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let key = locale.trim();
                if key.is_empty() {
                    continue;
                }
                let key = if key.eq_ignore_ascii_case("default") {
                    "default".to_string()
                } else if key.eq_ignore_ascii_case("zh-cn") || key.eq_ignore_ascii_case("zh_cn") {
                    "zh-CN".to_string()
                } else if key.eq_ignore_ascii_case("zh-tw") || key.eq_ignore_ascii_case("zh_tw") {
                    "zh-TW".to_string()
                } else if key.eq_ignore_ascii_case("en") {
                    "en".to_string()
                } else {
                    key.to_string()
                };
                map.insert(key, Value::String(trimmed.to_string()));
            }
        }
        _ => {}
    }

    if !map.contains_key("default") {
        let fallback_text = fallback.trim();
        if !fallback_text.is_empty() {
            map.insert("default".to_string(), Value::String(fallback_text.to_string()));
        }
    }

    Value::Object(map)
}

fn normalize_panels(value: Option<&Value>, default_entry: &str) -> Value {
    let mut panels: Vec<Value> = Vec::new();
    let Some(Value::Array(items)) = value else {
        return Value::Array(panels);
    };

    for item in items {
        let Some(object) = item.as_object() else { continue };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let entry = object
            .get("entry")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_entry)
            .to_string();
        let title = normalize_localized(object.get("title").or_else(|| object.get("name")), &id);
        let icon = object
            .get("icon")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let width = object.get("widthHint").and_then(Value::as_str).unwrap_or("").to_string();
        panels.push(serde_json::json!({
            "id": id,
            "title": title,
            "entry": entry,
            "icon": icon,
            "widthHint": width,
        }));
    }

    Value::Array(panels)
}

fn normalize_locales(value: Option<&Value>) -> Value {
    let mut map = Map::new();
    let Some(Value::Object(entries)) = value else {
        return Value::Object(map);
    };
    for (locale, item) in entries {
        let Some(path) = item.as_str() else { continue };
        let locale = locale.trim();
        let path = path.trim();
        if locale.is_empty() || path.is_empty() {
            continue;
        }
        map.insert(locale.to_string(), Value::String(path.to_string()));
    }
    Value::Object(map)
}

fn normalize_string_list(value: Option<&Value>) -> Value {
    let mut items: Vec<Value> = Vec::new();
    let Some(Value::Array(entries)) = value else {
        return Value::Array(items);
    };
    for entry in entries {
        let Some(text) = entry.as_str() else { continue };
        let text = text.trim();
        if !text.is_empty() {
            items.push(Value::String(text.to_string()));
        }
    }
    Value::Array(items)
}

fn parse_privacy(value: Option<&Value>) -> (Vec<String>, String) {
    match value {
        Some(Value::Array(entries)) => {
            let scopes = entries
                .iter()
                .filter_map(Value::as_str)
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>();
            (scopes, String::new())
        }
        Some(Value::Object(object)) => {
            let scopes = object
                .get("scopes")
                .or_else(|| object.get("domains"))
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|entry| entry.trim().to_string())
                        .filter(|entry| !entry.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let note = object
                .get("note")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            (scopes, note)
        }
        _ => (Vec::new(), String::new()),
    }
}

fn is_valid_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        && !value.starts_with('.')
}

fn parse_manifest(raw: &str) -> Result<PluginManifest> {
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|error| Error::from_reason(format!("Invalid {MANIFEST_FILE_NAME}: {error}")))?;
    let Some(object) = parsed.as_object() else {
        return Err(Error::from_reason(format!(
            "{MANIFEST_FILE_NAME} must contain a JSON object"
        )));
    };

    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !is_valid_plugin_id(&id) {
        return Err(Error::from_reason(
            "Plugin id is required and may only contain letters, digits, dot, dash and underscore"
                .to_string(),
        ));
    }

    let entry = object
        .get("entry")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ENTRY_FILE)
        .to_string();

    let render_mode = object
        .get("renderMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| value == "esm" || value == "iframe")
        .unwrap_or_else(|| "esm".to_string());

    let name = normalize_localized(object.get("name"), &id);
    let name_text = name
        .get("default")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let privacy = parse_privacy(object.get("privacy").or_else(|| object.get("permissions")));

    Ok(PluginManifest {
        id,
        name,
        description: normalize_localized(object.get("description"), &name_text),
        version: object
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("1.0.0")
            .to_string(),
        author: object
            .get("author")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        homepage: object
            .get("homepage")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        license: object
            .get("license")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        icon: object
            .get("icon")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        render_mode,
        entry: entry.clone(),
        panels: normalize_panels(object.get("panels"), &entry),
        locales: normalize_locales(object.get("locales")),
        styles: normalize_string_list(object.get("styles")),
        privacy: privacy.0,
        privacy_note: privacy.1,
        min_app_version: object
            .get("minAppVersion")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
    })
}

fn resolve_plugin_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err(Error::from_reason("Plugin file path is required".to_string()));
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err(Error::from_reason(
            "Plugin file path must be relative to the plugin directory".to_string(),
        ));
    }

    let mut resolved = root.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            _ => {
                return Err(Error::from_reason(
                    "Plugin file path must stay inside the plugin directory".to_string(),
                ))
            }
        }
    }
    Ok(resolved)
}

fn copy_dir_recursive(source: &Path, target: &Path, copied: &mut u64) -> Result<()> {
    fs::create_dir_all(target).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create plugin directory '{}': {error}",
            target.display()
        ))
    })?;

    let entries = fs::read_dir(source).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read plugin source directory '{}': {error}",
            source.display()
        ))
    })?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            Error::from_reason(format!("Failed to read plugin source entry: {error}"))
        })?;
        let name = entry.file_name();
        if SKIPPED_COPY_ENTRIES
            .iter()
            .any(|skipped| OsStr::new(skipped) == name.as_os_str())
        {
            continue;
        }

        let path = entry.path();
        let destination = target.join(&name);
        let metadata = entry.metadata().map_err(|error| {
            Error::from_reason(format!(
                "Failed to inspect plugin entry '{}': {error}",
                path.display()
            ))
        })?;

        if metadata.is_dir() {
            copy_dir_recursive(&path, &destination, copied)?;
        } else if metadata.is_file() {
            *copied += metadata.len();
            if *copied > MAX_PLUGIN_COPY_BYTES {
                return Err(Error::from_reason(format!(
                    "Plugin directory is too large to install (limit {} MB)",
                    MAX_PLUGIN_COPY_BYTES / (1024 * 1024)
                )));
            }
            fs::copy(&path, &destination).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to copy plugin file '{}': {error}",
                    path.display()
                ))
            })?;
        }
    }

    Ok(())
}

fn read_manifest_file(directory: &Path) -> Result<String> {
    let manifest_path = directory.join(MANIFEST_FILE_NAME);
    if !manifest_path.is_file() {
        return Err(Error::from_reason(format!(
            "Missing {MANIFEST_FILE_NAME} in '{}'",
            directory.display()
        )));
    }
    fs::read_to_string(&manifest_path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read '{MANIFEST_FILE_NAME}': {error}"
        ))
    })
}

fn insert_plugin(connection: &Connection, manifest: &PluginManifest, install_path: &str, source_path: &str, enabled: bool, raw_manifest: &str) -> rusqlite::Result<()> {
    connection.execute(
"INSERT INTO app_plugins (
            plugin_id, name_json, description_json, version, author, homepage, license,
            icon, render_mode, entry, enabled, install_path, source_path, manifest_json,
            panels_json, locales_json, styles_json, privacy_json, privacy_note, min_app_version
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19, ?20
        )
        ON CONFLICT(plugin_id) DO UPDATE SET
            name_json = excluded.name_json,
            description_json = excluded.description_json,
            version = excluded.version,
            author = excluded.author,
            homepage = excluded.homepage,
            license = excluded.license,
            icon = excluded.icon,
            render_mode = excluded.render_mode,
            entry = excluded.entry,
            install_path = excluded.install_path,
            source_path = excluded.source_path,
            manifest_json = excluded.manifest_json,
            panels_json = excluded.panels_json,
            locales_json = excluded.locales_json,
            styles_json = excluded.styles_json,
            privacy_json = excluded.privacy_json,
            privacy_note = excluded.privacy_note,
            min_app_version = excluded.min_app_version,
            updated_at = datetime('now', 'localtime')",
        params![
            manifest.id,
            manifest.name.to_string(),
            manifest.description.to_string(),
            manifest.version,
            manifest.author,
            manifest.homepage,
            manifest.license,
            manifest.icon,
            manifest.render_mode,
            manifest.entry,
            enabled,
            install_path,
            source_path,
            raw_manifest,
            manifest.panels.to_string(),
            manifest.locales.to_string(),
            manifest.styles.to_string(),
            serde_json::to_string(&manifest.privacy).unwrap_or_else(|_| "[]".to_string()),
            manifest.privacy_note,
            manifest.min_app_version,
        ],
    )?;
    Ok(())
}

pub fn list_plugins(database_path: &Path) -> Result<Vec<PluginRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection.prepare(
                "SELECT plugin_id FROM app_plugins ORDER BY sort_order ASC, created_at ASC, plugin_id ASC",
            )?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut records = Vec::new();
            for id in ids {
                if let Some(record) = query_plugin_record(&connection, &id)? {
                    records.push(record);
                }
            }
            Ok(records)
        })
        .map_err(|error| database::database_error(database_path, "list plugins", error))
}

pub fn install_plugin(database_path: &Path, source_dir: &str) -> Result<PluginRecord> {
    let source = PathBuf::from(source_dir.trim());
    if !source.is_dir() {
        return Err(Error::from_reason(format!(
            "Plugin source directory '{}' does not exist",
            source.display()
        )));
    }

    let raw_manifest = read_manifest_file(&source)?;
    let manifest = parse_manifest(&raw_manifest)?;

    let plugins_root = plugins_dir()?;
    fs::create_dir_all(&plugins_root).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create plugin directory '{}': {error}",
            plugins_root.display()
        ))
    })?;
    let target = plugin_install_dir(&manifest.id)?;

    let source_canonical = fs::canonicalize(&source).unwrap_or_else(|_| source.clone());
    let target_canonical = fs::canonicalize(&target).ok();
    let already_in_place = target_canonical
        .as_ref()
        .map(|existing| existing == &source_canonical)
        .unwrap_or(false);

    if !already_in_place {
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| {
                Error::from_reason(format!(
                    "Failed to replace existing plugin directory '{}': {error}",
                    target.display()
                ))
            })?;
        }
        let mut copied = 0u64;
        copy_dir_recursive(&source, &target, &mut copied)?;
    }

    let entry_path = resolve_plugin_path(&target, &manifest.entry)?;
    if !entry_path.is_file() {
        return Err(Error::from_reason(format!(
            "Plugin entry file '{}' is missing",
            manifest.entry
        )));
    }

    let install_path = target.to_string_lossy().to_string();
    let source_path = if already_in_place {
        install_path.clone()
    } else {
        source.to_string_lossy().to_string()
    };

    database::with_write_lock(|| -> Result<()> {
        let connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "install plugin", error))?;
        let existing_enabled: Option<bool> = connection
            .query_row(
                "SELECT enabled FROM app_plugins WHERE plugin_id = ?1",
                [&manifest.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| database::database_error(database_path, "install plugin", error))?;
        insert_plugin(
            &connection,
            &manifest,
            &install_path,
            &source_path,
            existing_enabled.unwrap_or(true),
            &raw_manifest,
        )
        .map_err(|error| database::database_error(database_path, "install plugin", error))?;
        Ok(())
    })?;

    query_plugin(database_path, &manifest.id)?
        .ok_or_else(|| Error::from_reason("Failed to read back installed plugin".to_string()))
}

pub fn rescan_plugin(database_path: &Path, plugin_id: &str) -> Result<PluginRecord> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "rescan plugin", error))?;
    let install_path: String = connection
        .query_row(
            "SELECT install_path FROM app_plugins WHERE plugin_id = ?1",
            [plugin_id],
            |row| row.get(0),
        )
        .map_err(|error| database::database_error(database_path, "rescan plugin", error))?;
    drop(connection);

    let directory = PathBuf::from(&install_path);
    let raw_manifest = read_manifest_file(&directory)?;
    let manifest = parse_manifest(&raw_manifest)?;
    if manifest.id != plugin_id {
        return Err(Error::from_reason(format!(
            "Plugin manifest id '{}' does not match '{}'",
            manifest.id, plugin_id
        )));
    }

    database::with_write_lock(|| -> Result<()> {
        let connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "rescan plugin", error))?;
        insert_plugin(&connection, &manifest, &install_path, &install_path, true, &raw_manifest)
            .map_err(|error| database::database_error(database_path, "rescan plugin", error))?;
        Ok(())
    })?;

    query_plugin(database_path, plugin_id)?
        .ok_or_else(|| Error::from_reason("Failed to read back rescanned plugin".to_string()))
}

pub fn set_plugin_enabled(database_path: &Path, plugin_id: &str, enabled: bool) -> Result<()> {
    database::with_write_lock(|| {
        database::open_connection(database_path)
            .and_then(|connection| -> rusqlite::Result<()> {
                let changed = connection.execute(
                    "UPDATE app_plugins SET enabled = ?2, updated_at = datetime('now', 'localtime')
                     WHERE plugin_id = ?1",
                    params![plugin_id, enabled],
                )?;
                if changed == 0 {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
                Ok(())
            })
            .map_err(|error| database::database_error(database_path, "set plugin enabled", error))
    })
}

pub fn delete_plugin(database_path: &Path, plugin_id: &str, delete_files: bool) -> Result<()> {
    let install_path = {
        let connection = database::open_connection(database_path)
            .map_err(|error| database::database_error(database_path, "delete plugin", error))?;
        connection
            .query_row(
                "SELECT install_path FROM app_plugins WHERE plugin_id = ?1",
                [plugin_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| database::database_error(database_path, "delete plugin", error))?
    };

    database::with_write_lock(|| {
        database::open_connection(database_path)
            .and_then(|connection| -> rusqlite::Result<()> {
                let changed = connection.execute(
                    "DELETE FROM app_plugins WHERE plugin_id = ?1",
                    [plugin_id],
                )?;
                if changed == 0 {
                    return Err(rusqlite::Error::QueryReturnedNoRows);
                }
                Ok(())
            })
            .map_err(|error| database::database_error(database_path, "delete plugin", error))
    })?;

    if delete_files {
        if let Some(path) = install_path {
            let candidate = PathBuf::from(path);
            if let (Ok(root), Ok(existing)) = (plugins_dir(), fs::canonicalize(&candidate)) {
                if existing.starts_with(&root) {
                    let _ = fs::remove_dir_all(&existing);
                }
            }
        }
    }

    Ok(())
}

pub fn read_plugin_file(database_path: &Path, plugin_id: &str, relative_path: &str) -> Result<String> {
    let root = plugin_directory(database_path, plugin_id)?;
    let path = resolve_plugin_path(&root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read plugin file '{relative_path}': {error}"))
    })?;
    if metadata.len() > MAX_PLUGIN_TEXT_FILE_BYTES {
        return Err(Error::from_reason(format!(
            "Plugin file '{relative_path}' exceeds the {} MB limit",
            MAX_PLUGIN_TEXT_FILE_BYTES / (1024 * 1024)
        )));
    }
    fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read plugin file '{relative_path}': {error}"))
    })
}

pub fn read_plugin_asset(database_path: &Path, plugin_id: &str, relative_path: &str) -> Result<Buffer> {
    let root = plugin_directory(database_path, plugin_id)?;
    let path = resolve_plugin_path(&root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read plugin asset '{relative_path}': {error}"))
    })?;
    if metadata.len() > MAX_PLUGIN_BINARY_FILE_BYTES {
        return Err(Error::from_reason(format!(
            "Plugin asset '{relative_path}' exceeds the {} MB limit",
            MAX_PLUGIN_BINARY_FILE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = fs::read(&path).map_err(|error| {
        Error::from_reason(format!("Failed to read plugin asset '{relative_path}': {error}"))
    })?;
    Ok(Buffer::from(bytes))
}

pub fn get_plugin_values(database_path: &Path, plugin_id: &str) -> Result<Vec<PluginStorageValue>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            let mut statement = connection
                .prepare("SELECT key, value FROM app_plugin_values WHERE plugin_id = ?1 ORDER BY key")?;
            let rows = statement.query_map([plugin_id], |row| {
                Ok(PluginStorageValue {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
        .map_err(|error| database::database_error(database_path, "get plugin values", error))
}

pub fn set_plugin_value(database_path: &Path, plugin_id: &str, key: &str, value: &str) -> Result<()> {
    database::with_write_lock(|| {
        database::open_connection(database_path)
            .and_then(|connection| -> rusqlite::Result<()> {
                connection.execute(
                    "INSERT INTO app_plugin_values (plugin_id, key, value, updated_at)
                     VALUES (?1, ?2, ?3, datetime('now', 'localtime'))
                     ON CONFLICT(plugin_id, key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = datetime('now', 'localtime')",
                    params![plugin_id, key, value],
                )?;
                Ok(())
            })
            .map_err(|error| database::database_error(database_path, "set plugin value", error))
    })
}

pub fn delete_plugin_value(database_path: &Path, plugin_id: &str, key: &str) -> Result<()> {
    database::with_write_lock(|| {
        database::open_connection(database_path)
            .and_then(|connection| -> rusqlite::Result<()> {
                connection.execute(
                    "DELETE FROM app_plugin_values WHERE plugin_id = ?1 AND key = ?2",
                    params![plugin_id, key],
                )?;
                Ok(())
            })
            .map_err(|error| database::database_error(database_path, "delete plugin value", error))
    })
}

fn plugin_directory(database_path: &Path, plugin_id: &str) -> Result<PathBuf> {
    let connection = database::open_connection(database_path)
        .map_err(|error| database::database_error(database_path, "read plugin directory", error))?;
    let install_path: String = connection
        .query_row(
            "SELECT install_path FROM app_plugins WHERE plugin_id = ?1",
            [plugin_id],
            |row| row.get(0),
        )
        .map_err(|error| database::database_error(database_path, "read plugin directory", error))?;
    if install_path.trim().is_empty() {
        return Err(Error::from_reason("Plugin directory is not available".to_string()));
    }
    Ok(PathBuf::from(install_path))
}

fn query_plugin(database_path: &Path, plugin_id: &str) -> Result<Option<PluginRecord>> {
    database::open_connection(database_path)
        .and_then(|connection| query_plugin_record(&connection, plugin_id))
        .map_err(|error| database::database_error(database_path, "query plugin", error))
}

fn query_plugin_record(connection: &Connection, plugin_id: &str) -> rusqlite::Result<Option<PluginRecord>> {
    let row = connection.query_row(
        "SELECT plugin_id, name_json, description_json, version, author, homepage, license,
                icon, render_mode, entry, enabled, install_path, source_path, manifest_json,
                panels_json, locales_json, styles_json, privacy_json, privacy_note,
                min_app_version, sort_order, created_at, updated_at
         FROM app_plugins WHERE plugin_id = ?1",
        [plugin_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, bool>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, String>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, String>(18)?,
                row.get::<_, String>(19)?,
                row.get::<_, i32>(20)?,
                row.get::<_, String>(21)?,
                row.get::<_, String>(22)?,
            ))
        },
    )
    .optional()?;

    let Some((
        plugin_id,
        name_json,
        description_json,
        version,
        author,
        homepage,
        license,
        icon,
        render_mode,
        entry,
        enabled,
        install_path,
        source_path,
        manifest_json,
        panels_json,
        locales_json,
        styles_json,
        privacy_json,
        privacy_note,
        min_app_version,
        sort_order,
        created_at,
        updated_at,
    )) = row
    else {
        return Ok(None);
    };

    Ok(Some(PluginRecord {
        plugin_id,
        name: name_json,
        description: description_json,
        version,
        author,
        homepage,
        license,
        icon,
        render_mode,
        entry,
        enabled,
        install_path,
        source_path,
        manifest_json,
        panels: panels_json,
        locales: locales_json,
        styles: styles_json,
        privacy: serde_json::from_str(&privacy_json).unwrap_or_default(),
        privacy_note,
        min_app_version,
        sort_order,
        created_at,
        updated_at,
    }))
}
