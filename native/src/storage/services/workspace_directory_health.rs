use std::fs;
use std::path::{Path, PathBuf};

use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};

use super::super::database;
use super::super::WorkspaceDirectoryVerifyReport;

pub const STATE_OK: &str = "ok";
pub const STATE_MISSING: &str = "missing";
pub const STATE_MISMATCH: &str = "mismatch";
pub const STATE_OFFLINE: &str = "offline";
pub const STATE_PERMISSION_ERROR: &str = "permission_error";
pub const STATE_REMOTE: &str = "remote";
pub const STATE_UNKNOWN: &str = "unknown";

pub const KIND_SSH: &str = "ssh";

#[cfg(unix)]
pub fn fs_identity(path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;

    match fs::metadata(path) {
        Ok(metadata) => format!("unix:{}:{}", metadata.dev(), metadata.ino()),
        Err(_) => String::new(),
    }
}

#[cfg(windows)]
pub fn fs_identity(path: &Path) -> String {
    use std::os::windows::fs::MetadataExt;

    match fs::metadata(path) {
        Ok(metadata) => format!("win:{}", metadata.creation_time()),
        Err(_) => String::new(),
    }
}

#[cfg(not(any(unix, windows)))]
pub fn fs_identity(_path: &Path) -> String {
    String::new()
}

struct DirectoryRow {
    directory_id: String,
    path: String,
    kind: String,
    last_known_path: String,
}

fn load_directory_row(database_path: &Path, directory_id: &str) -> Result<Option<DirectoryRow>> {
    database::open_connection(database_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT directory_id, path, kind, last_known_path
                       FROM workspace_directories
                      WHERE directory_id = ?1
                      LIMIT 1",
                    [directory_id],
                    |row| {
                        Ok(DirectoryRow {
                            directory_id: row.get(0)?,
                            path: row.get(1)?,
                            kind: row.get(2)?,
                            last_known_path: row.get(3)?,
                        })
                    },
                )
                .optional()
        })
        .map_err(|error| {
            database::database_error(database_path, "read workspace directory", error)
        })
}

#[cfg(windows)]
fn mount_root(path: &Path) -> PathBuf {
    for component in path.components() {
        return PathBuf::from(component.as_os_str());
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn mount_root(path: &Path) -> PathBuf {
    const VOLUME_ROOTS: &[&str] = &["Volumes", "mnt", "media", "net", "run"];

    let mut components = path.components();
    components.next();

    if let Some(second) = components.next() {
        let name = second.as_os_str().to_string_lossy().to_string();
        if VOLUME_ROOTS
            .iter()
            .any(|root| root.eq_ignore_ascii_case(&name))
        {
            let mut root = PathBuf::from("/");
            root.push(second.as_os_str());
            if let Some(third) = components.next() {
                root.push(third.as_os_str());
            }
            return root;
        }
    }

    PathBuf::from("/")
}

pub fn classify_path(path: &Path) -> String {
    match fs::metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() {
                STATE_OK.to_string()
            } else {
                STATE_MISMATCH.to_string()
            }
        }
        Err(error) => match error.kind() {
            std::io::ErrorKind::PermissionDenied => STATE_PERMISSION_ERROR.to_string(),
            _ => {
                let root = mount_root(path);
                if root.exists() {
                    STATE_MISSING.to_string()
                } else {
                    STATE_OFFLINE.to_string()
                }
            }
        },
    }
}

fn persist_state(
    database_path: &Path,
    directory_id: &str,
    state: &str,
    identity: Option<&str>,
    known_path: Option<&str>,
) -> Result<()> {
    let update = |connection: &rusqlite::Connection| -> rusqlite::Result<()> {
        match (identity, known_path) {
            (Some(identity), Some(known_path)) => connection.execute(
                "UPDATE workspace_directories
                    SET path_state = ?1,
                        path_checked_at = datetime('now', 'localtime'),
                        fs_identity = ?2,
                        last_known_path = ?3
                  WHERE directory_id = ?4",
                params![state, identity, known_path, directory_id],
            ),
            _ => connection.execute(
                "UPDATE workspace_directories
                    SET path_state = ?1,
                        path_checked_at = datetime('now', 'localtime')
                  WHERE directory_id = ?2",
                params![state, directory_id],
            ),
        }?;
        Ok(())
    };

    database::with_write_lock(|| {
        database::with_write_retry(
            || database::open_connection(database_path).and_then(|connection| update(&connection)),
            "update workspace directory path state",
        )
    })
    .map_err(|error| {
        database::database_error(database_path, "update workspace directory path state", error)
    })
}

pub fn verify_workspace_directory(
    database_path: &Path,
    directory_id: &str,
) -> Result<WorkspaceDirectoryVerifyReport> {
    let normalized_id = directory_id.trim();
    if normalized_id.is_empty() {
        return Err(Error::from_reason(
            "WORKSPACE_VERIFY_NOT_FOUND: workspace directory id is required".to_string(),
        ));
    }

    let Some(row) = load_directory_row(database_path, normalized_id)? else {
        return Err(Error::from_reason(format!(
            "WORKSPACE_VERIFY_NOT_FOUND: unknown workspace directory '{normalized_id}'"
        )));
    };

    if row.kind == KIND_SSH {
        return Ok(WorkspaceDirectoryVerifyReport {
            directory_id: row.directory_id,
            path: row.path,
            kind: row.kind,
            state: STATE_REMOTE.to_string(),
            last_known_path: row.last_known_path,
        });
    }

    if row.path.trim().is_empty() {
        return Ok(WorkspaceDirectoryVerifyReport {
            directory_id: row.directory_id,
            path: row.path,
            kind: row.kind,
            state: STATE_UNKNOWN.to_string(),
            last_known_path: row.last_known_path,
        });
    }

    let path = PathBuf::from(&row.path);
    let state = classify_path(&path);

    if state == STATE_OK {
        let identity = fs_identity(&path);
        persist_state(
            database_path,
            &row.directory_id,
            &state,
            Some(&identity),
            Some(&row.path),
        )?;
        return Ok(WorkspaceDirectoryVerifyReport {
            directory_id: row.directory_id,
            path: row.path.clone(),
            kind: row.kind,
            state,
            last_known_path: row.path,
        });
    }

    persist_state(database_path, &row.directory_id, &state, None, None)?;

    Ok(WorkspaceDirectoryVerifyReport {
        directory_id: row.directory_id,
        path: row.path,
        kind: row.kind,
        state,
        last_known_path: row.last_known_path,
    })
}
