//! 业务逻辑直接生成的「用户消息 + 助手工具调用」交换（不经模型请求），
//! 例如输入区 WorkFlow 手动编排器提交：图已由用户画好，直接落库成一次工具调用。

use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};

use crate::storage::database;
use super::{
    create_snippet, create_title, insert_message, is_conversation_tombstoned,
    resolve_conversation_id, ChatContextMessage,
};
use crate::api::conversation::tags::expand_display_tags_in_content;

pub struct ManualToolExchangeInput<'a> {
    pub conversation_id: Option<&'a str>,
    pub directory_id: &'a str,
    pub model: &'a str,
    pub api_profile_name: &'a str,
    pub checkpoint_id: &'a str,
    pub user_content: &'a str,
    pub tool_name: &'a str,
    pub arguments_json: &'a str,
}

pub struct ManualToolExchange {
    pub conversation_id: String,
    pub response_id: String,
    pub tool_calls_json: String,
    pub persisted_user_message_ids: Vec<String>,
}

pub fn store_manual_tool_exchange(
    database_path: &Path,
    input: &ManualToolExchangeInput<'_>,
) -> Result<ManualToolExchange> {
    let user_content = input.user_content.trim();
    let tool_name = input.tool_name.trim();
    if user_content.is_empty() || tool_name.is_empty() {
        return Err(Error::from_reason(
            "Manual tool exchange requires user content and a tool name",
        ));
    }
    let arguments: Value = serde_json::from_str(input.arguments_json)
        .map_err(|error| Error::from_reason(format!("Invalid tool arguments JSON: {error}")))?;
    if !arguments.is_object() {
        return Err(Error::from_reason("Tool arguments must be a JSON object"));
    }

    let conversation_id = resolve_conversation_id(database_path, input.conversation_id, None)?;
    let snowflake = database::create_snowflake_id();
    let response_id = format!("manual_{snowflake}");
    // OpenAI Chat 规范化格式，各 provider 回放历史时自行转换
    let tool_calls_json = json!([{
        "id": format!("call_manual_{snowflake}"),
        "type": "function",
        "function": { "name": tool_name, "arguments": arguments.to_string() },
    }])
    .to_string();

    let request_messages = [ChatContextMessage {
        role: "user".to_string(),
        content: user_content.to_string(),
        tool_calls_json: None,
        tool_results_json: None,
        thinking: None,
        thinking_blocks_json: None,
    }];
    let title = create_title(&request_messages);
    let preview = create_snippet(
        &expand_display_tags_in_content(user_content).unwrap_or_else(|| user_content.to_string()),
        180,
    );

    let persisted = database::open_connection(database_path)
        .and_then(|mut connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if is_conversation_tombstoned(&transaction, &conversation_id)? {
                return Ok(None);
            }
            transaction.execute(
                "INSERT INTO chat_conversations (
                   id,
                   conversation_id,
                   title,
                   summary,
                   last_message_preview,
                   message_count,
                   model,
                   api_profile_name,
                   last_response_id,
                   status,
                   directory_id,
                   forked_from_conversation_id,
                   fork_message_count,
                   created_at,
                   updated_at
                 ) VALUES (
                   ?1, ?2, ?3, ?3, '', 0, ?4, ?5, ?6, 'active', ?7, '', 0, datetime('now', 'localtime'), datetime('now', 'localtime')
                 )
                 ON CONFLICT(conversation_id) DO NOTHING",
                params![
                    database::create_snowflake_id(),
                    conversation_id,
                    title,
                    input.model,
                    input.api_profile_name,
                    response_id,
                    input.directory_id,
                ],
            )?;
            let user_message_id = insert_message(
                &transaction,
                &conversation_id,
                "user",
                user_content,
                "",
                input.checkpoint_id,
                input.model,
                "sent",
                None,
                None,
                "{}",
                "",
                "[]",
                0,
                0,
                "[]",
                None,
                0,
                0,
                "",
            )?;
            // 无模型调用：不写 token 快照，保留会话已有的上下文用量
            insert_message(
                &transaction,
                &conversation_id,
                "assistant",
                "",
                &response_id,
                "",
                input.model,
                "completed",
                None,
                None,
                "{}",
                "",
                "[]",
                0,
                0,
                &tool_calls_json,
                None,
                1,
                0,
                "",
            )?;
            transaction.execute(
                "UPDATE chat_conversations
                    SET title = CASE WHEN title = '' THEN ?2 ELSE title END,
                        summary = CASE WHEN summary = '' THEN ?2 ELSE summary END,
                        last_message_preview = ?3,
                        message_count = (
                          SELECT COUNT(*)
                            FROM chat_messages
                           WHERE conversation_id = ?1
                        ),
                        model = CASE WHEN ?4 <> '' THEN ?4 ELSE model END,
                        last_response_id = ?5,
                        status = 'active',
                        directory_id = CASE WHEN directory_id = '' THEN ?6 ELSE directory_id END,
                        updated_at = datetime('now', 'localtime')
                  WHERE conversation_id = ?1",
                params![
                    conversation_id,
                    title,
                    preview,
                    input.model,
                    response_id,
                    input.directory_id,
                ],
            )?;
            transaction.commit()?;
            Ok(Some(user_message_id))
        })
        .map_err(|error| {
            database::database_error(database_path, "store manual tool exchange", error)
        })?;

    let Some(user_message_id) = persisted else {
        return Err(Error::from_reason("Conversation has been deleted or archived"));
    };

    Ok(ManualToolExchange {
        conversation_id,
        response_id,
        tool_calls_json,
        persisted_user_message_ids: vec![user_message_id],
    })
}
