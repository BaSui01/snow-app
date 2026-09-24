use std::path::Path;

use napi::bindgen_prelude::*;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::super::database;

const KEYBOARD_SHORTCUTS_SETTING_NAME: &str = "Keyboard shortcuts";
const KEYBOARD_SHORTCUTS_SETTING_CODE: &str = "keyboard_shortcuts";

/// 单个快捷键配置：按键绑定 + 是否启用 + 是否仅台前生效。
///
/// `key` 使用平台无关的规范化格式：`mod` 代表平台主修饰键
/// （macOS 为 Cmd，其他平台为 Ctrl），主键用小写。
/// 例如 `mod+f`、`escape`、`mod+backtick`。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcutConfig {
    pub key: String,
    pub enabled: bool,
    pub foreground_only: bool,
}

impl Default for KeyboardShortcutConfig {
    fn default() -> Self {
        Self {
            key: String::new(),
            enabled: true,
            foreground_only: true,
        }
    }
}

/// 校验 key 是否合法：非空且仅含允许的字符集。
/// 允许：字母 / 数字 / `mod` / `+` / `-` / 反引号 / 部分命名键。
fn is_valid_key(key: &str) -> bool {
    if key.trim().is_empty() {
        return false;
    }
    key.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '`' | ',' | '.' | '/'))
}

/// toggleWindow 的默认配置：mod+shift+h（macOS ⌘⇧H / 其他 Ctrl+Shift+H）。
/// foreground_only 默认 false：该快捷键由主进程 globalShortcut 注册，
/// 窗口隐藏到托盘时也要能呼出，不受"仅台前"限制。
fn default_toggle_window_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_TOGGLE_WINDOW_KEY.to_string(),
        enabled: true,
        foreground_only: false,
    }
}

/// togglePet 的默认配置：mod+shift+p（macOS ⌘⇧P / 其他 Ctrl+Shift+P）。
/// foreground_only 默认 true：宠物启停由渲染进程快捷键触发（应用聚焦时生效），
/// 与其余常规快捷键一致。
fn default_toggle_pet_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_TOGGLE_PET_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

/// focusInput 的默认配置：mod+i（macOS ⌘I / 其他 Ctrl+I）。
/// foreground_only 默认 true：聚焦输入框由渲染进程快捷键触发（应用聚焦时生效）。
fn default_focus_input_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_FOCUS_INPUT_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

/// toggleSidebar 的默认配置：ctrl+shift+l（收起/展开左侧边栏）。
/// foreground_only 默认 true：收起/展开侧边栏由渲染进程快捷键触发（应用聚焦时生效）。
fn default_toggle_sidebar_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_TOGGLE_SIDEBAR_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

/// toggleRightPanel 的默认配置：ctrl+shift+r（收起/展开右侧面板）。
/// foreground_only 默认 true：收起/展开右面板由渲染进程快捷键触发（应用聚焦时生效）。
fn default_toggle_right_panel_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_TOGGLE_RIGHT_PANEL_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_new_chat_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_NEW_CHAT_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_send_message_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_SEND_MESSAGE_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_stop_generation_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_STOP_GENERATION_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_prev_conversation_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_PREV_CONVERSATION_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_next_conversation_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_NEXT_CONVERSATION_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_scroll_to_top_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_SCROLL_TO_TOP_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_scroll_to_bottom_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_SCROLL_TO_BOTTOM_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_open_settings_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_OPEN_SETTINGS_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_copy_last_response_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_COPY_LAST_RESPONSE_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_toggle_right_panel_fullscreen_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_TOGGLE_RIGHT_PANEL_FULLSCREEN_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_show_shortcut_help_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_SHOW_SHORTCUT_HELP_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_open_project_memory_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_OPEN_PROJECT_MEMORY_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_open_scheduled_tasks_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_OPEN_SCHEDULED_TASKS_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

fn default_open_plugins_config() -> KeyboardShortcutConfig {
    KeyboardShortcutConfig {
        key: DEFAULT_OPEN_PLUGINS_KEY.to_string(),
        enabled: true,
        foreground_only: true,
    }
}

/// 完整快捷键设置：26 个快捷键各自的配置。
/// 序列化为 JSON 存储在 system_settings 表中。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct KeyboardShortcutsSettings {
    pub cancel_session: KeyboardShortcutConfig,
    pub open_search: KeyboardShortcutConfig,
    pub open_memo: KeyboardShortcutConfig,
    pub open_todo: KeyboardShortcutConfig,
    pub cycle_project: KeyboardShortcutConfig,
    pub open_project_explorer: KeyboardShortcutConfig,
    #[serde(default = "default_open_project_memory_config")]
    pub open_project_memory: KeyboardShortcutConfig,
    #[serde(default = "default_open_scheduled_tasks_config")]
    pub open_scheduled_tasks: KeyboardShortcutConfig,
    #[serde(default = "default_open_plugins_config")]
    pub open_plugins: KeyboardShortcutConfig,
    pub cycle_api_profile: KeyboardShortcutConfig,
    /// 显示/隐藏对话窗口。旧 JSON 缺少该字段时回退到默认配置
    /// （foreground_only=false，见 default_toggle_window_config）。
    #[serde(default = "default_toggle_window_config")]
    pub toggle_window: KeyboardShortcutConfig,
    /// 切换宠物启停。旧 JSON 缺少该字段时回退到默认配置
    /// （foreground_only=true，见 default_toggle_pet_config）。
    #[serde(default = "default_toggle_pet_config")]
    pub toggle_pet: KeyboardShortcutConfig,
    /// 聚焦对话输入框。旧 JSON 缺少该字段时回退到默认配置
    /// （mod+i，见 default_focus_input_config）。
    #[serde(default = "default_focus_input_config")]
    pub focus_input: KeyboardShortcutConfig,
    /// 收起/展开左侧边栏。旧 JSON 缺少该字段时回退到默认配置
    /// （ctrl+shift+l，见 default_toggle_sidebar_config）。
    #[serde(default = "default_toggle_sidebar_config")]
    pub toggle_sidebar: KeyboardShortcutConfig,
    /// 收起/展开右侧面板。旧 JSON 缺少该字段时回退到默认配置
    /// （ctrl+shift+r，见 default_toggle_right_panel_config）。
    #[serde(default = "default_toggle_right_panel_config")]
    pub toggle_right_panel: KeyboardShortcutConfig,
    #[serde(default = "default_new_chat_config")]
    pub new_chat: KeyboardShortcutConfig,
    #[serde(default = "default_send_message_config")]
    pub send_message: KeyboardShortcutConfig,
    #[serde(default = "default_stop_generation_config")]
    pub stop_generation: KeyboardShortcutConfig,
    #[serde(default = "default_prev_conversation_config")]
    pub prev_conversation: KeyboardShortcutConfig,
    #[serde(default = "default_next_conversation_config")]
    pub next_conversation: KeyboardShortcutConfig,
    #[serde(default = "default_scroll_to_top_config")]
    pub scroll_to_top: KeyboardShortcutConfig,
    #[serde(default = "default_scroll_to_bottom_config")]
    pub scroll_to_bottom: KeyboardShortcutConfig,
    #[serde(default = "default_open_settings_config")]
    pub open_settings: KeyboardShortcutConfig,
    #[serde(default = "default_copy_last_response_config")]
    pub copy_last_response: KeyboardShortcutConfig,
    #[serde(default = "default_toggle_right_panel_fullscreen_config")]
    pub toggle_right_panel_fullscreen: KeyboardShortcutConfig,
    #[serde(default = "default_show_shortcut_help_config")]
    pub show_shortcut_help: KeyboardShortcutConfig,
}

impl Default for KeyboardShortcutsSettings {
    fn default() -> Self {
        Self {
            cancel_session: KeyboardShortcutConfig {
                key: DEFAULT_CANCEL_SESSION_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            open_search: KeyboardShortcutConfig {
                key: DEFAULT_OPEN_SEARCH_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            open_memo: KeyboardShortcutConfig {
                key: DEFAULT_OPEN_MEMO_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            open_todo: KeyboardShortcutConfig {
                key: DEFAULT_OPEN_TODO_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            cycle_project: KeyboardShortcutConfig {
                key: DEFAULT_CYCLE_PROJECT_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            open_project_explorer: KeyboardShortcutConfig {
                key: DEFAULT_OPEN_PROJECT_EXPLORER_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            open_project_memory: default_open_project_memory_config(),
            open_scheduled_tasks: default_open_scheduled_tasks_config(),
            open_plugins: default_open_plugins_config(),
            cycle_api_profile: KeyboardShortcutConfig {
                key: DEFAULT_CYCLE_API_PROFILE_KEY.to_string(),
                enabled: true,
                foreground_only: true,
            },
            toggle_window: default_toggle_window_config(),
            toggle_pet: default_toggle_pet_config(),
            focus_input: default_focus_input_config(),
            toggle_sidebar: default_toggle_sidebar_config(),
            toggle_right_panel: default_toggle_right_panel_config(),
            new_chat: default_new_chat_config(),
            send_message: default_send_message_config(),
            stop_generation: default_stop_generation_config(),
            prev_conversation: default_prev_conversation_config(),
            next_conversation: default_next_conversation_config(),
            scroll_to_top: default_scroll_to_top_config(),
            scroll_to_bottom: default_scroll_to_bottom_config(),
            open_settings: default_open_settings_config(),
            copy_last_response: default_copy_last_response_config(),
            toggle_right_panel_fullscreen: default_toggle_right_panel_fullscreen_config(),
            show_shortcut_help: default_show_shortcut_help_config(),
        }
    }
}

/// 12 个快捷键的默认按键绑定（与渲染层 useKeyboardShortcuts 原始硬编码一致）。
/// `mod` 为平台主修饰键占位符（macOS=Cmd，其他=Ctrl）。
/// cycleApiProfile 平台相关：macOS 用 Ctrl+P（Option/Alt 会输入特殊字符），
/// 其他平台用 Alt+P。
/// toggleWindow 用 mod+shift+h：macOS ⌘⇧H / 其他 Ctrl+Shift+H，全局生效。
/// togglePet 用 mod+shift+p：macOS ⌘⇧P / 其他 Ctrl+Shift+P，仅台前生效。
/// focusInput 用 mod+i：macOS ⌘I / 其他 Ctrl+I，仅台前生效。
/// toggleSidebar / toggleRightPanel 用 mod+shift+l / mod+shift+r：
/// macOS ⌘⇧L / ⌘⇧R，其他 Ctrl+Shift+L / Ctrl+Shift+R，
/// 收起/展开左右侧边栏，仅台前生效。
const DEFAULT_CANCEL_SESSION_KEY: &str = "escape";
const DEFAULT_OPEN_SEARCH_KEY: &str = "mod+f";
const DEFAULT_OPEN_MEMO_KEY: &str = "mod+b";
const DEFAULT_OPEN_TODO_KEY: &str = "mod+t";
const DEFAULT_CYCLE_PROJECT_KEY: &str = "mod+backtick";
const DEFAULT_OPEN_PROJECT_EXPLORER_KEY: &str = "mod+d";
const DEFAULT_OPEN_PROJECT_MEMORY_KEY: &str = "mod+shift+m";
const DEFAULT_OPEN_SCHEDULED_TASKS_KEY: &str = "mod+shift+t";
const DEFAULT_OPEN_PLUGINS_KEY: &str = "mod+shift+x";
const DEFAULT_CYCLE_API_PROFILE_KEY: &str = if cfg!(target_os = "macos") {
    "ctrl+p"
} else {
    "alt+p"
};
const DEFAULT_TOGGLE_WINDOW_KEY: &str = "mod+shift+h";
const DEFAULT_TOGGLE_PET_KEY: &str = "mod+shift+p";
const DEFAULT_FOCUS_INPUT_KEY: &str = "mod+i";
const DEFAULT_TOGGLE_SIDEBAR_KEY: &str = "mod+shift+l";
const DEFAULT_TOGGLE_RIGHT_PANEL_KEY: &str = "mod+shift+r";
const DEFAULT_NEW_CHAT_KEY: &str = "mod+n";
const DEFAULT_SEND_MESSAGE_KEY: &str = "mod+enter";
const DEFAULT_STOP_GENERATION_KEY: &str = "mod+.";
const DEFAULT_PREV_CONVERSATION_KEY: &str = "alt+left";
const DEFAULT_NEXT_CONVERSATION_KEY: &str = "alt+right";
const DEFAULT_SCROLL_TO_TOP_KEY: &str = "mod+up";
const DEFAULT_SCROLL_TO_BOTTOM_KEY: &str = "mod+down";
const DEFAULT_OPEN_SETTINGS_KEY: &str = "mod+,";
const DEFAULT_COPY_LAST_RESPONSE_KEY: &str = "mod+shift+c";
const DEFAULT_TOGGLE_RIGHT_PANEL_FULLSCREEN_KEY: &str = "mod+shift+f";
const DEFAULT_SHOW_SHORTCUT_HELP_KEY: &str = "mod+/";

impl KeyboardShortcutsSettings {
    /// 规范化：对每个配置校验 key 合法性，不合法时回退到默认按键绑定。
    /// bool 字段（enabled / foreground_only）天然合法，无需校验。
    fn normalize(&mut self) {
        if !is_valid_key(&self.cancel_session.key) {
            self.cancel_session.key = DEFAULT_CANCEL_SESSION_KEY.to_string();
        }
        if !is_valid_key(&self.open_search.key) {
            self.open_search.key = DEFAULT_OPEN_SEARCH_KEY.to_string();
        }
        if !is_valid_key(&self.open_memo.key) {
            self.open_memo.key = DEFAULT_OPEN_MEMO_KEY.to_string();
        }
        if !is_valid_key(&self.open_todo.key) {
            self.open_todo.key = DEFAULT_OPEN_TODO_KEY.to_string();
        }
        if !is_valid_key(&self.cycle_project.key) {
            self.cycle_project.key = DEFAULT_CYCLE_PROJECT_KEY.to_string();
        }
        if !is_valid_key(&self.open_project_explorer.key) {
            self.open_project_explorer.key = DEFAULT_OPEN_PROJECT_EXPLORER_KEY.to_string();
        }
        if !is_valid_key(&self.open_project_memory.key) {
            self.open_project_memory.key = DEFAULT_OPEN_PROJECT_MEMORY_KEY.to_string();
        }
        if !is_valid_key(&self.open_scheduled_tasks.key) {
            self.open_scheduled_tasks.key = DEFAULT_OPEN_SCHEDULED_TASKS_KEY.to_string();
        }
        if !is_valid_key(&self.open_plugins.key) {
            self.open_plugins.key = DEFAULT_OPEN_PLUGINS_KEY.to_string();
        }
        // macOS 上旧默认值 alt+p 不适用（Option+P 会输入特殊字符），
        // 视为未自定义，迁移到 ctrl+p。
        if cfg!(target_os = "macos") && self.cycle_api_profile.key == "alt+p" {
            self.cycle_api_profile.key = DEFAULT_CYCLE_API_PROFILE_KEY.to_string();
        }
        if !is_valid_key(&self.cycle_api_profile.key) {
            self.cycle_api_profile.key = DEFAULT_CYCLE_API_PROFILE_KEY.to_string();
        }
        if !is_valid_key(&self.toggle_window.key) {
            self.toggle_window.key = DEFAULT_TOGGLE_WINDOW_KEY.to_string();
        }
        if !is_valid_key(&self.toggle_pet.key) {
            self.toggle_pet.key = DEFAULT_TOGGLE_PET_KEY.to_string();
        }
        if !is_valid_key(&self.focus_input.key) {
            self.focus_input.key = DEFAULT_FOCUS_INPUT_KEY.to_string();
        }
        if !is_valid_key(&self.toggle_sidebar.key) {
            self.toggle_sidebar.key = DEFAULT_TOGGLE_SIDEBAR_KEY.to_string();
        }
        if !is_valid_key(&self.toggle_right_panel.key) {
            self.toggle_right_panel.key = DEFAULT_TOGGLE_RIGHT_PANEL_KEY.to_string();
        }
        if !is_valid_key(&self.new_chat.key) {
            self.new_chat.key = DEFAULT_NEW_CHAT_KEY.to_string();
        }
        if !is_valid_key(&self.send_message.key) {
            self.send_message.key = DEFAULT_SEND_MESSAGE_KEY.to_string();
        }
        if !is_valid_key(&self.stop_generation.key) {
            self.stop_generation.key = DEFAULT_STOP_GENERATION_KEY.to_string();
        }
        if !is_valid_key(&self.prev_conversation.key) {
            self.prev_conversation.key = DEFAULT_PREV_CONVERSATION_KEY.to_string();
        }
        if !is_valid_key(&self.next_conversation.key) {
            self.next_conversation.key = DEFAULT_NEXT_CONVERSATION_KEY.to_string();
        }
        if !is_valid_key(&self.scroll_to_top.key) {
            self.scroll_to_top.key = DEFAULT_SCROLL_TO_TOP_KEY.to_string();
        }
        if !is_valid_key(&self.scroll_to_bottom.key) {
            self.scroll_to_bottom.key = DEFAULT_SCROLL_TO_BOTTOM_KEY.to_string();
        }
        if !is_valid_key(&self.open_settings.key) {
            self.open_settings.key = DEFAULT_OPEN_SETTINGS_KEY.to_string();
        }
        if !is_valid_key(&self.copy_last_response.key) {
            self.copy_last_response.key = DEFAULT_COPY_LAST_RESPONSE_KEY.to_string();
        }
        if !is_valid_key(&self.toggle_right_panel_fullscreen.key) {
            self.toggle_right_panel_fullscreen.key =
                DEFAULT_TOGGLE_RIGHT_PANEL_FULLSCREEN_KEY.to_string();
        }
        if !is_valid_key(&self.show_shortcut_help.key) {
            self.show_shortcut_help.key = DEFAULT_SHOW_SHORTCUT_HELP_KEY.to_string();
        }
    }
}

/// 默认值：26 个快捷键各自默认 key + enabled=true；除 toggleWindow 外
/// foreground_only=true，toggleWindow 默认 false（全局生效，窗口隐藏时
/// 也要能呼出）。与 DEFAULT_*_KEY 常量保持一致；cycleApiProfile 的 key
/// 平台相关，动态构造。
fn default_keyboard_shortcuts_value() -> String {
    format!(
        r#"{{"cancelSession":{{"key":"escape","enabled":true,"foregroundOnly":true}},"openSearch":{{"key":"mod+f","enabled":true,"foregroundOnly":true}},"openMemo":{{"key":"mod+b","enabled":true,"foregroundOnly":true}},"openTodo":{{"key":"mod+t","enabled":true,"foregroundOnly":true}},"cycleProject":{{"key":"mod+backtick","enabled":true,"foregroundOnly":true}},"openProjectExplorer":{{"key":"mod+d","enabled":true,"foregroundOnly":true}},"openProjectMemory":{{"key":"mod+shift+m","enabled":true,"foregroundOnly":true}},"openScheduledTasks":{{"key":"mod+shift+t","enabled":true,"foregroundOnly":true}},"openPlugins":{{"key":"mod+shift+x","enabled":true,"foregroundOnly":true}},"cycleApiProfile":{{"key":"{DEFAULT_CYCLE_API_PROFILE_KEY}","enabled":true,"foregroundOnly":true}},"toggleWindow":{{"key":"mod+shift+h","enabled":true,"foregroundOnly":false}},"togglePet":{{"key":"mod+shift+p","enabled":true,"foregroundOnly":true}},"focusInput":{{"key":"mod+i","enabled":true,"foregroundOnly":true}},"toggleSidebar":{{"key":"mod+shift+l","enabled":true,"foregroundOnly":true}},"toggleRightPanel":{{"key":"mod+shift+r","enabled":true,"foregroundOnly":true}},"newChat":{{"key":"mod+n","enabled":true,"foregroundOnly":true}},"sendMessage":{{"key":"mod+enter","enabled":true,"foregroundOnly":true}},"stopGeneration":{{"key":"mod+.","enabled":true,"foregroundOnly":true}},"prevConversation":{{"key":"alt+left","enabled":true,"foregroundOnly":true}},"nextConversation":{{"key":"alt+right","enabled":true,"foregroundOnly":true}},"scrollToTop":{{"key":"mod+up","enabled":true,"foregroundOnly":true}},"scrollToBottom":{{"key":"mod+down","enabled":true,"foregroundOnly":true}},"openSettings":{{"key":"mod+,","enabled":true,"foregroundOnly":true}},"copyLastResponse":{{"key":"mod+shift+c","enabled":true,"foregroundOnly":true}},"toggleRightPanelFullscreen":{{"key":"mod+shift+f","enabled":true,"foregroundOnly":true}},"showShortcutHelp":{{"key":"mod+/","enabled":true,"foregroundOnly":true}}}}"#
    )
}

pub fn get_keyboard_shortcuts_settings(database_path: &Path) -> Result<KeyboardShortcutsSettings> {
    let raw_value = match database::open_connection(database_path).and_then(|connection| {
        connection
            .query_row(
                "SELECT setting_value FROM system_settings WHERE setting_code = ?1",
                [KEYBOARD_SHORTCUTS_SETTING_CODE],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }) {
        Ok(value) => value,
        Err(error) => {
            return Err(database::database_error(
                database_path,
                "read keyboard shortcuts settings",
                error,
            ))
        }
    };

    match raw_value {
        Some(value) => {
            let mut settings =
                serde_json::from_str::<KeyboardShortcutsSettings>(&value).map_err(|error| {
                    Error::new(
                        Status::GenericFailure,
                        format!("Failed to parse keyboard shortcuts settings: {error}"),
                    )
                })?;
            settings.normalize();
            Ok(settings)
        }
        None => Ok(KeyboardShortcutsSettings::default()),
    }
}

pub fn set_keyboard_shortcuts_settings(
    database_path: &Path,
    settings: &KeyboardShortcutsSettings,
) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize keyboard shortcuts settings: {error}"),
        )
    })?;

    database::open_connection(database_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))
                 ON CONFLICT(setting_code) DO UPDATE SET
                   setting_name = excluded.setting_name,
                   setting_value = excluded.setting_value,
                   updated_at = datetime('now', 'localtime')",
                (
                    database::create_snowflake_id(),
                    KEYBOARD_SHORTCUTS_SETTING_NAME,
                    KEYBOARD_SHORTCUTS_SETTING_CODE,
                    setting_value,
                ),
            )
        })
        .map_err(|error| {
            database::database_error(
                database_path,
                "write keyboard shortcuts settings",
                error,
            )
        })?;

    Ok(())
}

/// Seed 默认快捷键设置（仅在首次创建时插入，不覆盖已有值）。
pub fn seed_default_keyboard_shortcuts(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT OR IGNORE INTO system_settings (id, setting_name, setting_code, setting_value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now', 'localtime'), datetime('now', 'localtime'))",
        (
            database::create_snowflake_id(),
            KEYBOARD_SHORTCUTS_SETTING_NAME,
            KEYBOARD_SHORTCUTS_SETTING_CODE,
            default_keyboard_shortcuts_value(),
        ),
    )?;

    Ok(())
}
