use napi::bindgen_prelude::*;

use super::database;
use super::ensure_database_file;
use super::models::*;
use super::services;

pub fn list_import_resources() -> Result<Vec<ImportResourceRecord>> {
    let database_path = ensure_database_file()?;
    services::import_resources::list_import_resources(&database_path)
}

pub fn upsert_import_resources(items: Vec<ImportResourceInput>) -> Result<()> {
    let database_path = ensure_database_file()?;
    services::import_resources::upsert_import_resources(&database_path, &items)
}

pub fn commit_import_transaction(input: ImportDatabaseTransactionInput) -> Result<()> {
    let database_path = ensure_database_file()?;
    commit_import_transaction_at_path(&database_path, input)
}

fn commit_import_transaction_at_path(
    database_path: &std::path::Path,
    input: ImportDatabaseTransactionInput,
) -> Result<()> {
    let result = database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction = connection.transaction()?;
            for item in &input.mcp_servers {
                services::mcp_server_configs::upsert_mcp_server_config_with_connection(
                    &transaction,
                    item,
                )?;
            }
            for item in &input.project_mcp_servers {
                services::project_mcp_server_configs::upsert_project_mcp_server_config_with_connection(
                    &transaction,
                    &item.project_id,
                    &item.input,
                )?;
            }
            for item in &input.system_prompts {
                services::system_prompts::upsert_system_prompt_with_connection(&transaction, item)?;
            }
            for item in &input.plugins {
                services::plugins::upsert_plugin(&transaction, item)?;
            }
            for item in &input.import_resources {
                services::import_resources::upsert_resource(&transaction, item)?;
            }
            transaction.commit()
        })
        .map_err(|error| database::database_error(database_path, "commit import transaction", error));
    if result.is_ok() {
        // 导入写入了 MCP 服务器配置：按服务器精确失效工具发现缓存，
        // 其他服务器不受影响（新建服务器的 id 尚无缓存条目）。
        for item in &input.mcp_servers {
            if !item.server_id.trim().is_empty() {
                crate::mcp::external::invalidate_server_discovery_cache(item.server_id.trim());
            }
        }
        for item in &input.project_mcp_servers {
            if !item.input.server_id.trim().is_empty() {
                crate::mcp::external::invalidate_server_discovery_cache(
                    item.input.server_id.trim(),
                );
            }
        }
    }
    result
}

pub fn release_import_resource(input: ImportResourceReleaseInput) -> Result<ImportResourceRelease> {
    let database_path = ensure_database_file()?;
    services::import_resources::release_import_resource(&database_path, &input)
}
