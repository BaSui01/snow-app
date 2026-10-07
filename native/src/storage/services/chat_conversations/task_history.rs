use super::super::super::database;
use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use std::path::Path;

// References only: file content/diffs remain in their original tool records.
pub fn save_task_history(
    path: &Path,
    conversation_id: &str,
    response_id: &str,
    manifest: &str,
) -> Result<()> {
    let value: serde_json::Value =
        serde_json::from_str(manifest).map_err(|_| Error::from_reason("Invalid task manifest"))?;
    let object = value
        .as_object()
        .ok_or_else(|| Error::from_reason("Invalid task manifest"))?;
    if object.len() != 3
        || value["version"] != 1
        || value["taskId"].as_str().filter(|s| !s.is_empty()).is_none()
        || !value["sources"].is_array()
    {
        return Err(Error::from_reason("Invalid task manifest"));
    }
    for source in value["sources"].as_array().unwrap() {
        let fields = source
            .as_object()
            .ok_or_else(|| Error::from_reason("Invalid task source"))?;
        if fields.len() != 3
            || source["conversationId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none()
            || !source["subAgentName"].is_string()
            || !source["recordIds"].as_array().is_some_and(|ids| {
                ids.iter()
                    .all(|id| id.as_str().is_some_and(|id| !id.is_empty()))
            })
        {
            return Err(Error::from_reason("Invalid task source"));
        }
    }
    let mut connection = database::open_connection(path)
        .map_err(|e| database::database_error(path, "save task history", e))?;
    let transaction = connection
        .transaction()
        .map_err(|e| database::database_error(path, "save task history", e))?;
    let reply_count: i64 = transaction.query_row("SELECT COUNT(*) FROM chat_messages WHERE conversation_id = ?1 AND response_id = ?2 AND role = 'assistant'", params![conversation_id, response_id], |row| row.get(0)).map_err(|e| database::database_error(path, "validate task reply", e))?;
    if reply_count != 1 {
        return Err(Error::from_reason(
            "Task reply identity is missing or ambiguous",
        ));
    }
    let (message_id, raw): (String, String) = transaction.query_row("SELECT id, raw_json FROM chat_messages WHERE conversation_id = ?1 AND response_id = ?2 AND role = 'assistant' ORDER BY id DESC LIMIT 1", params![conversation_id, response_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| database::database_error(path, "find task reply", e))?;
    let mut owns_reply = false;
    for source in value["sources"].as_array().unwrap() {
        let source_id = source["conversationId"].as_str().unwrap();
        let mut ancestor = source_id.to_string();
        let mut visited = std::collections::HashSet::new();
        while ancestor != conversation_id && visited.insert(ancestor.clone()) {
            let parent: Option<String> = transaction.query_row("SELECT parent_conversation_id FROM sub_agent_sessions WHERE conversation_id = ?1", params![ancestor], |row| row.get(0)).optional().map_err(|e| database::database_error(path, "validate task scope", e))?;
            ancestor = parent.unwrap_or_default();
        }
        if ancestor != conversation_id {
            return Err(Error::from_reason(
                "Task source is outside its conversation scope",
            ));
        }
        for id in source["recordIds"].as_array().unwrap() {
            let id = id.as_str().unwrap();
            let exists: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM chat_messages WHERE conversation_id = ?1 AND id = ?2)", params![source_id, id], |row| row.get(0)).map_err(|e| database::database_error(path, "validate task record", e))?;
            if !exists {
                return Err(Error::from_reason("Task record is missing"));
            }
            owns_reply |= source_id == conversation_id && id == message_id;
        }
    }
    if !owns_reply {
        return Err(Error::from_reason("Task must own its end reply"));
    }
    let mut raw: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| Error::from_reason("Invalid stored response metadata"))?;
    let raw = raw
        .as_object_mut()
        .ok_or_else(|| Error::from_reason("Invalid stored response metadata"))?;
    if let Some(existing) = raw.get("__snowTaskHistory") {
        if existing == &value {
            return Ok(());
        }
        return Err(Error::from_reason("Task history is immutable"));
    }
    raw.insert("__snowTaskHistory".to_string(), value);
    let json = serde_json::to_string(&raw)
        .map_err(|_| Error::from_reason("Cannot serialize task history"))?;
    transaction
        .execute(
            "UPDATE chat_messages SET raw_json = ?2 WHERE id = ?1 AND role = 'assistant'",
            params![message_id, json],
        )
        .map_err(|e| database::database_error(path, "save task history", e))?;
    transaction
        .commit()
        .map_err(|e| database::database_error(path, "save task history", e))
}

pub fn list_task_history(path: &Path, conversation_id: &str) -> Result<Vec<String>> {
    let connection = database::open_connection(path)
        .map_err(|e| database::database_error(path, "read task history", e))?;
    let mut statement = connection.prepare("SELECT id, response_id, raw_json FROM chat_messages WHERE conversation_id = ?1 AND role = 'assistant' ORDER BY id ASC").map_err(|e| database::database_error(path, "read task history", e))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| database::database_error(path, "read task history", e))?;
    let mut result = Vec::new();
    for row in rows {
        let (id, response_id, raw) =
            row.map_err(|e| database::database_error(path, "read task history", e))?;
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(manifest) = raw.get("__snowTaskHistory") {
                result.push(serde_json::json!({"messageId": id, "responseId": response_id, "manifest": manifest}).to_string());
            }
        }
    }
    Ok(result)
}
