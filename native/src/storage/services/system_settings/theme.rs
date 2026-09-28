use std::path::Path;

use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};

use super::{
    get_system_setting_value, set_system_setting, DEFAULT_THEME_SETTING_CODE,
    DEFAULT_THEME_SETTING_NAME,
};

// 排版数值范围与默认值，与渲染层 themeSettingsUtils 的 typography 常量保持一致。
const UI_FONT_SIZE_MIN: f64 = 12.0;
const UI_FONT_SIZE_MAX: f64 = 18.0;
const DEFAULT_UI_FONT_SIZE: f64 = 13.0;
const FONT_WEIGHT_MIN: f64 = 100.0;
const FONT_WEIGHT_MAX: f64 = 900.0;
const DEFAULT_FONT_WEIGHT: f64 = 400.0;
const CHAT_FONT_SIZE_MIN: f64 = 12.0;
const CHAT_FONT_SIZE_MAX: f64 = 20.0;
const DEFAULT_CHAT_FONT_SIZE: f64 = 15.0;
const CHAT_LINE_HEIGHT_MIN: f64 = 1.2;
const CHAT_LINE_HEIGHT_MAX: f64 = 2.4;
const DEFAULT_CHAT_LINE_HEIGHT: f64 = 1.75;
const CODE_FONT_SIZE_MIN: f64 = 10.0;
const CODE_FONT_SIZE_MAX: f64 = 18.0;
const DEFAULT_CODE_FONT_SIZE: f64 = 12.5;

// ===== Theme settings =====

/// 主题调色板，对应渲染层 CSS 变量。每个字段为合法 CSS 颜色字符串
/// （hex 或 rgba()），serde default 使旧数据缺字段时仍可反序列化。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemePalette {
    pub bg_primary: String,
    pub bg_secondary: String,
    pub bg_tertiary: String,
    pub bg_hover: String,
    pub bg_active: String,
    pub chrome_bg: String,
    pub app_bg: String,
    pub border_color: String,
    pub border_light: String,
    pub border_subtle: String,
    pub text_primary: String,
    pub text_secondary: String,
    pub text_tertiary: String,
    pub text_muted: String,
    pub accent_green: String,
    pub accent_green_bg: String,
    pub accent_green_text: String,
    pub accent_red: String,
    pub accent_red_bg: String,
    pub accent_red_text: String,
    pub accent_blue: String,
    pub accent_blue_bg: String,
    pub accent_blue_text: String,
    pub accent_color: String,
    pub on_solid: String,
    pub selection_bg: String,
    pub focus_ring: String,
}

impl ThemePalette {
    /// 将空字符串字段填充为占位透明色，避免渲染层 var() 回退为 initial。
    fn normalize(&mut self) {
        let placeholder = "transparent";
        macro_rules! fill {
            ($field:ident) => {
                if self.$field.trim().is_empty() {
                    self.$field = placeholder.to_string();
                } else {
                    self.$field = self.$field.trim().to_string();
                }
            };
        }
        fill!(bg_primary);
        fill!(bg_secondary);
        fill!(bg_tertiary);
        fill!(bg_hover);
        fill!(bg_active);
        fill!(chrome_bg);
        fill!(app_bg);
        fill!(border_color);
        fill!(border_light);
        fill!(border_subtle);
        fill!(text_primary);
        fill!(text_secondary);
        fill!(text_tertiary);
        fill!(text_muted);
        fill!(accent_green);
        fill!(accent_green_bg);
        fill!(accent_green_text);
        fill!(accent_red);
        fill!(accent_red_bg);
        fill!(accent_red_text);
        fill!(accent_blue);
        fill!(accent_blue_bg);
        fill!(accent_blue_text);
        fill!(accent_color);
        fill!(on_solid);
        fill!(selection_bg);
        fill!(focus_ring);
    }
}

/// 自定义主题：亮色 + 暗色两套调色板。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomTheme {
    pub light: ThemePalette,
    pub dark: ThemePalette,
}

impl CustomTheme {
    fn normalize(&mut self) {
        self.light.normalize();
        self.dark.normalize();
    }
}

/// 背景图配置。image_path 为空字符串表示未设置；opacity 范围 0.0~1.0；
/// blur 为高斯模糊像素值（0 表示不模糊）。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeBackground {
    pub enabled: bool,
    pub image_path: String,
    pub opacity: f64,
    pub blur: f64,
}

impl ThemeBackground {
    fn normalize(&mut self) {
        self.image_path = self.image_path.trim().to_string();
        if !self.opacity.is_finite() || self.opacity < 0.0 {
            self.opacity = 1.0;
        } else if self.opacity > 1.0 {
            self.opacity = 1.0;
        }
        if !self.blur.is_finite() || self.blur < 0.0 {
            self.blur = 0.0;
        } else if self.blur > 100.0 {
            self.blur = 100.0;
        }
        if self.image_path.is_empty() {
            self.enabled = false;
        }
    }
}

/// 流式光标配置。icon_type 决定渲染形态：
/// - "dot"：默认脉冲圆点
/// - "lucide"：使用内置 lucide 图标，由 lucide_name 指定
/// - "custom"：使用用户上传的 SVG，由 svg_path 指定文件路径
/// icon_type 为 "lucide" 时 svg_path 应为空；为 "custom" 时 lucide_name 应为空。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeStreamCursor {
    pub icon_type: String,
    pub lucide_name: String,
    pub svg_path: String,
    pub icon_size: f64,
}

impl ThemeStreamCursor {
    fn normalize(&mut self) {
        self.icon_type = self.icon_type.trim().to_string();
        if !matches!(self.icon_type.as_str(), "dot" | "lucide" | "custom") {
            self.icon_type = "dot".to_string();
        }
        self.lucide_name = self.lucide_name.trim().to_string();
        self.svg_path = self.svg_path.trim().to_string();
        // 图标尺寸范围 8~48，默认 14。
        if !self.icon_size.is_finite() || self.icon_size < 8.0 {
            self.icon_size = 14.0;
        } else if self.icon_size > 48.0 {
            self.icon_size = 48.0;
        }
        // 根据类型清理无关字段，避免持久化数据与实际渲染形态不一致。
        match self.icon_type.as_str() {
            "dot" => {
                self.lucide_name.clear();
                self.svg_path.clear();
            }
            "lucide" => {
                self.svg_path.clear();
                if self.lucide_name.is_empty() {
                    // 退化到默认脉冲圆点。
                    self.icon_type = "dot".to_string();
                }
            }
            "custom" => {
                self.lucide_name.clear();
                if self.svg_path.is_empty() {
                    self.icon_type = "dot".to_string();
                }
            }
            _ => {}
        }
    }
}

/// 排版设置：界面字号（驱动整页缩放）+ 正文字重 + 聊天正文字号 /
/// 行高 + 代码字号。数值范围与前端 typography 常量保持一致。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeTypography {
    pub font_size: f64,
    pub font_weight: f64,
    pub chat_font_size: f64,
    pub chat_line_height: f64,
    pub code_font_size: f64,
}

impl Default for ThemeTypography {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_UI_FONT_SIZE,
            font_weight: DEFAULT_FONT_WEIGHT,
            chat_font_size: DEFAULT_CHAT_FONT_SIZE,
            chat_line_height: DEFAULT_CHAT_LINE_HEIGHT,
            code_font_size: DEFAULT_CODE_FONT_SIZE,
        }
    }
}

impl ThemeTypography {
    fn normalize(&mut self) {
        if !self.font_size.is_finite()
            || self.font_size < UI_FONT_SIZE_MIN
            || self.font_size > UI_FONT_SIZE_MAX
        {
            self.font_size = DEFAULT_UI_FONT_SIZE;
        }
        if !self.font_weight.is_finite()
            || self.font_weight < FONT_WEIGHT_MIN
            || self.font_weight > FONT_WEIGHT_MAX
        {
            self.font_weight = DEFAULT_FONT_WEIGHT;
        }
        if !self.chat_font_size.is_finite()
            || self.chat_font_size < CHAT_FONT_SIZE_MIN
            || self.chat_font_size > CHAT_FONT_SIZE_MAX
        {
            self.chat_font_size = DEFAULT_CHAT_FONT_SIZE;
        }
        if !self.chat_line_height.is_finite()
            || self.chat_line_height < CHAT_LINE_HEIGHT_MIN
            || self.chat_line_height > CHAT_LINE_HEIGHT_MAX
        {
            self.chat_line_height = DEFAULT_CHAT_LINE_HEIGHT;
        }
        if !self.code_font_size.is_finite()
            || self.code_font_size < CODE_FONT_SIZE_MIN
            || self.code_font_size > CODE_FONT_SIZE_MAX
        {
            self.code_font_size = DEFAULT_CODE_FONT_SIZE;
        }
    }
}

/// 完整主题设置：模式 + 预设 ID + 自定义调色板 + 背景图 + 字体 + 流式光标 + 排版。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThemeSettings {
    pub mode: String,
    pub preset_id: String,
    pub custom: CustomTheme,
    pub background: ThemeBackground,
    pub font_family: String,
    pub stream_cursor: ThemeStreamCursor,
    pub typography: ThemeTypography,
}

impl ThemeSettings {
    fn normalize(&mut self) {
        self.mode = self.mode.trim().to_string();
        if !matches!(self.mode.as_str(), "system" | "light" | "dark") {
            self.mode = "system".to_string();
        }
        self.preset_id = self.preset_id.trim().to_string();
        if self.preset_id.is_empty() {
            self.preset_id = "snow".to_string();
        }
        self.custom.normalize();
        self.background.normalize();
        self.font_family = self.font_family.trim().to_string();
        self.stream_cursor.normalize();
        self.typography.normalize();
    }
}

pub fn get_theme_settings(database_path: &Path) -> Result<ThemeSettings> {
    let Some(raw_value) = get_system_setting_value(database_path, DEFAULT_THEME_SETTING_CODE)?
    else {
        return Ok(ThemeSettings::default());
    };

    let mut settings = serde_json::from_str::<ThemeSettings>(&raw_value).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to parse theme settings: {error}"),
        )
    })?;
    settings.normalize();
    Ok(settings)
}

pub fn set_theme_settings(database_path: &Path, settings: &ThemeSettings) -> Result<()> {
    let mut normalized = settings.clone();
    normalized.normalize();
    let setting_value = serde_json::to_string(&normalized).map_err(|error| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize theme settings: {error}"),
        )
    })?;
    set_system_setting(
        database_path,
        DEFAULT_THEME_SETTING_NAME,
        DEFAULT_THEME_SETTING_CODE,
        &setting_value,
    )
}
