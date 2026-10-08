use napi::bindgen_prelude::*;

use super::ensure_database_file;
use super::services;

pub fn write_app_log(input: services::app_logs::AppLogInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::app_logs::insert_app_log(&database_path, &input)
}

pub fn list_app_logs(
    level: String,
    module: String,
    since: String,
    until: String,
    limit: i32,
    offset: i32,
) -> Result<services::app_logs::AppLogPage> {
    let database_path = ensure_database_file()?;
    services::app_logs::list_app_logs(
        &database_path,
        &level,
        &module,
        &since,
        &until,
        limit,
        offset,
    )
}

pub fn clear_app_logs() -> Result<u32> {
    let database_path = ensure_database_file()?;
    services::app_logs::clear_app_logs(&database_path)
}

pub fn get_app_logs_retention_days() -> Result<i32> {
    let database_path = ensure_database_file()?;
    services::system_settings::get_app_logs_retention_days(&database_path)
}

pub fn set_app_logs_retention_days(days: i32) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::system_settings::set_app_logs_retention_days(&database_path, days)
}

/// 按当前保留期设置清理过期系统日志，返回删除行数。
pub fn prune_app_logs() -> Result<u32> {
    let database_path = ensure_database_file()?;
    let retention_days = services::system_settings::get_app_logs_retention_days(&database_path)?;
    services::app_logs::prune_app_logs(&database_path, retention_days)
}
