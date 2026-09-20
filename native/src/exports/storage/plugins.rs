use super::*;

#[napi]
pub async fn list_plugins() -> napi::Result<Vec<PluginRecord>> {
    tokio::task::spawn_blocking(|| {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::list_plugins(&database_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn install_plugin(source_dir: String) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::install_plugin(&database_path, &source_dir)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn rescan_plugin(plugin_id: String) -> napi::Result<PluginRecord> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::rescan_plugin(&database_path, &plugin_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_plugin_enabled(plugin_id: String, enabled: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_plugin_enabled(&database_path, &plugin_id, enabled)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin(plugin_id: String, delete_files: bool) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_plugin(&database_path, &plugin_id, delete_files)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_plugin_file(plugin_id: String, relative_path: String) -> napi::Result<String> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::read_plugin_file(&database_path, &plugin_id, &relative_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn read_plugin_asset(
    plugin_id: String,
    relative_path: String,
) -> napi::Result<Buffer> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::read_plugin_asset(&database_path, &plugin_id, &relative_path)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_plugin_values(plugin_id: String) -> napi::Result<Vec<PluginStorageValue>> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::get_plugin_values(&database_path, &plugin_id)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn set_plugin_value(
    plugin_id: String,
    key: String,
    value: String,
) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::set_plugin_value(&database_path, &plugin_id, &key, &value)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn delete_plugin_value(plugin_id: String, key: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || {
        let database_path = crate::storage::ensure_database_file()?;
        crate::storage::delete_plugin_value(&database_path, &plugin_id, &key)
    })
    .await
    .map_err(map_spawn_error)?
}

#[napi]
pub async fn get_plugins_directory() -> napi::Result<String> {
    tokio::task::spawn_blocking(|| {
        let directory = crate::storage::plugins_dir()?;
        Ok(directory.to_string_lossy().into_owned())
    })
    .await
    .map_err(map_spawn_error)?
}
