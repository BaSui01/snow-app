use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use chrono;
use napi::bindgen_prelude::*;

#[derive(Clone, Debug)]
pub struct ChatImage {
    pub media_type: String,
    pub data: String,
    pub data_url: String,
    /// 磁盘相对路径（相对数据库文件所在目录），例如 `upload/2026-07-25/hash.png`。
    /// 消息持久化时内联 base64 会被写入 upload 目录、标签改为相对路径；
    /// 仍以内联 data URL 形式存在（未持久化）的图片此字段为 None。
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ParsedChatMessageContent {
    pub text: String,
    pub images: Vec<ChatImage>,
}

pub fn parse_chat_message_content(
    content: &str,
    database_path: &Path,
) -> Result<ParsedChatMessageContent> {
    const IMAGE_TAG_PREFIX: &str = "@@image:";
    const REVIEW_TAG_PREFIX: &str = "@@review:";
    const COMMAND_TAG_PREFIX: &str = "@@command:";
    const ELEMENT_TAG_PREFIX: &str = "@@element:";
    const CONVERSATION_TAG_PREFIX: &str = "@@conversation:";
    const TAG_PREFIXES: [&str; 5] = [
        IMAGE_TAG_PREFIX,
        REVIEW_TAG_PREFIX,
        COMMAND_TAG_PREFIX,
        ELEMENT_TAG_PREFIX,
        CONVERSATION_TAG_PREFIX,
    ];

    let mut parsed = ParsedChatMessageContent::default();
    let mut remaining = content;
    // 会话标签展开预算惰性读取（仅首个会话标签出现时查库），
    // 多个会话标签共享总预算（与请求组装注入语义一致）。
    let mut attach_budgets: Option<(usize, usize)> = None;
    let mut attach_used_chars: usize = 0;

    // 同时识别 image / review / element / conversation 四种标签，
    // 取最先出现的那个处理。
    while let Some(tag_start) = find_earliest_tag(remaining, &TAG_PREFIXES) {
        parsed.text.push_str(&remaining[..tag_start]);

        let prefix = TAG_PREFIXES
            .iter()
            .find(|candidate| remaining[tag_start..].starts_with(**candidate))
            .copied()
            .unwrap_or(IMAGE_TAG_PREFIX);
        let tag_value_start = tag_start + prefix.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            parsed.text.push_str(&remaining[tag_start..]);
            return Ok(parsed);
        };

        let value = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;

        if prefix == REVIEW_TAG_PREFIX {
            // review 标签：将 base64 编码的完整审查提示词展开为纯文本，
            // 使 AI 收到干净的指令 + diff 内容，而非 JSON 外壳。
            if let Some(prompt) = try_expand_review_tag(value) {
                parsed.text.push_str(&prompt);
            } else {
                parsed.text.push_str(&remaining[tag_start..full_tag_end]);
            }
        } else if prefix == COMMAND_TAG_PREFIX {
            if let Some(prompt) = try_expand_command_tag(value) {
                parsed.text.push_str(&prompt);
            } else {
                parsed.text.push_str(&remaining[tag_start..full_tag_end]);
            }
        } else if prefix == ELEMENT_TAG_PREFIX {
            // element 标签：将浏览器元素选择器选取的元素展开为人类可读的
            // 描述文本（标签/选择器/备注/文本/URL），使 AI 直接理解用户
            // 选取了页面上哪个元素，而非收到 base64 JSON 外壳。
            if let Some(description) = try_expand_element_tag(value) {
                parsed.text.push_str(&description);
            } else {
                parsed.text.push_str(&remaining[tag_start..full_tag_end]);
            }
        } else if prefix == CONVERSATION_TAG_PREFIX {
            // conversation 标签：将拖拽引用的历史会话展开为精简渲染的
            // 对话记录上下文块（与旧「附带会话」注入共用渲染函数）。
            let (single_budget, total_budget) = *attach_budgets.get_or_insert_with(|| {
                crate::storage::services::context_attachments::read_attach_context_budgets(
                    database_path,
                )
            });
            let budget = single_budget.min(total_budget.saturating_sub(attach_used_chars));
            match try_expand_conversation_tag(value, database_path, budget) {
                Some(rendered) => {
                    attach_used_chars += rendered.len();
                    parsed.text.push_str(&rendered);
                }
                None => {
                    parsed.text.push_str(&remaining[tag_start..full_tag_end]);
                }
            }
        } else if let Some(svg_text) = try_extract_svg_source(value, database_path) {
            // SVG is XML text — most AI models cannot interpret it as a raster
            // image from base64. Inline the raw SVG source code instead.
            parsed.text.push_str(&svg_text);
        } else if let Some(image) = parse_image_tag_value(value, database_path)? {
            // Insert an inline placeholder so the model can see the image's
            // position and order within the message text. The 1-based index
            // matches the order images appear in the `parsed.images` vector,
            // which is also the order they are emitted as multimodal parts.
            let index = parsed.images.len() + 1;
            parsed.text.push_str(&format!("[Image #{index}]"));
            parsed.images.push(image);
        } else {
            parsed.text.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    parsed.text.push_str(remaining);
    parsed.text = parsed.text.trim().to_string();
    Ok(parsed)
}

/// 返回 remaining 中最先出现的任一标签前缀的位置。
fn find_earliest_tag(remaining: &str, prefixes: &[&str]) -> Option<usize> {
    prefixes
        .iter()
        .filter_map(|prefix| remaining.find(prefix))
        .min()
}

/// 尝试将 `@@review:{"prompt":"<base64>",...}@@` 标签展开为完整审查提示词。
///
/// prompt 在前端编码时以 base64 承载（git diff 的 hunk 头 `@@` 会破坏
/// 标签终止符，base64 字符集不含 `@@` 可安全内嵌）。非法 JSON 或
/// base64 解码失败时返回 None，调用方保留原始标签、不破坏消息内容。
fn try_expand_review_tag(value: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let prompt_b64 = parsed.get("prompt")?.as_str()?;
    if prompt_b64.is_empty() {
        return Some(String::new());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(prompt_b64)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// 尝试将 `@@command:{"name":"...","prompt":"<base64>","charCount":N}@@` 标签
/// 展开为自定义指令的 prompt 原文，使 AI 收到干净指令而非 base64 JSON 外壳。
fn try_expand_command_tag(value: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let prompt_b64 = parsed.get("prompt")?.as_str()?;
    if prompt_b64.is_empty() {
        return Some(String::new());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(prompt_b64)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// 尝试将 `@@element:{"url":"...","tag":"button","label":"button#search",
/// "text":"<base64>","note":"<base64>"}@@` 标签展开为人类可读的元素描述。
///
/// text / note 在前端编码时以 base64 承载（自由文本可能含 `@@` 破坏标签
/// 终止符）；url / tag / label 为结构化字段直接 JSON 内嵌。非法 JSON 或
/// base64 解码失败时返回 None，调用方保留原始标签、不破坏消息内容。
fn try_expand_element_tag(value: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let tag = json_text(&parsed, "tag");
    let label = json_text(&parsed, "label");
    let url = json_text(&parsed, "url");
    let text = json_base64_text(&parsed, "text");
    let note = json_base64_text(&parsed, "note");

    let display = if !label.is_empty() { label } else { tag };
    let mut parts: Vec<String> = Vec::new();
    if display.is_empty() {
        parts.push("[页面元素]".to_string());
    } else {
        parts.push(format!("[页面元素 {display}]"));
    }
    if !note.is_empty() {
        parts.push(format!("备注：{note}"));
    }
    if !text.is_empty() {
        parts.push(format!("内容：{text}"));
    }
    if !url.is_empty() {
        parts.push(format!("页面：{url}"));
    }
    Some(parts.join(" "))
}

/// 尝试将 `@@conversation:{"conversationId":"...","title":"<base64>",...}@@`
/// 标签展开为被引用历史会话的精简渲染上下文块。
///
/// 渲染与预算复用 context_attachments 服务（与旧「附带会话」注入所见即所得）。
/// 标签 JSON 非法、会话不存在或渲染失败返回 None，调用方保留原始标签。
fn try_expand_conversation_tag(
    value: &str,
    database_path: &Path,
    budget_chars: usize,
) -> Option<String> {
    if budget_chars == 0 {
        return Some(String::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    let conversation_id = parsed.get("conversationId")?.as_str()?;
    if conversation_id.trim().is_empty() {
        return None;
    }
    let rendered =
        crate::storage::services::context_attachments::render_attachment_context_with_budget(
            database_path,
            conversation_id,
            budget_chars,
        )
        .ok()?;
    Some(rendered.trim().to_string())
}

/// 展示型 chip 标签前缀（与前端 fileTagUtils 的 encode* 编码格式一一对应）。
const DISPLAY_TAG_PREFIXES: [&str; 13] = [
    "@@file:",
    "@@dir:",
    "@@image:",
    "@@commit:",
    "@@change:",
    "@@text-snippet:",
    "@@review:",
    "@@element:",
    "@@web:",
    "@@conversation:",
    "@@quote:",
    "@@command:",
    "@@skill:",
];

/// 把消息内容里的所有 chip 标签折叠为人类可读文本，用于会话标题、单行预览等
/// 展示场景，语义与前端 `summarizeContentAsPlainText` 一致：文件取「名称:L7-L9」、
/// 图片取 `[image.png]`、提交取短 hash、片段/引用/审查取摘要、网页取「标题 URL」、
/// 元素取「标签: 备注」、技能取名称，编码外壳（绝对路径、base64、JSON）不显示。
///
/// 内容不含任何标签时返回 None，调用方沿用原文；单个标签外壳损坏时保留该标签
/// 原文，不破坏消息内容。
pub(crate) fn expand_display_tags_in_content(content: &str) -> Option<String> {
    if !DISPLAY_TAG_PREFIXES
        .iter()
        .any(|prefix| content.contains(prefix))
    {
        return None;
    }

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(tag_start) = find_earliest_tag(remaining, &DISPLAY_TAG_PREFIXES) {
        result.push_str(&remaining[..tag_start]);
        let prefix = DISPLAY_TAG_PREFIXES
            .iter()
            .find(|candidate| remaining[tag_start..].starts_with(**candidate))
            .copied()
            .unwrap_or(DISPLAY_TAG_PREFIXES[0]);
        let value_start = tag_start + prefix.len();
        let value_and_rest = &remaining[value_start..];
        let Some(tag_end) = value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return Some(result);
        };
        let value = &value_and_rest[..tag_end];
        let full_tag_end = value_start + tag_end + 2;
        match display_text_for_tag(prefix, value) {
            Some(text) => result.push_str(&text),
            None => result.push_str(&remaining[tag_start..full_tag_end]),
        }
        remaining = &remaining[full_tag_end..];
    }
    result.push_str(remaining);
    Some(result)
}

/// 单个标签的展示文本；标签外壳无法解析时返回 None（调用方保留标签原文）。
fn display_text_for_tag(prefix: &str, value: &str) -> Option<String> {
    match prefix {
        "@@file:" | "@@dir:" => return Some(display_file_reference(value, prefix == "@@dir:")),
        "@@image:" => return Some(format!("[image.{}]", image_tag_extension(value))),
        _ => {}
    }

    let parsed: serde_json::Value = serde_json::from_str(value).ok()?;
    match prefix {
        "@@commit:" => Some(display_commit_reference(&parsed)),
        "@@change:" => Some(file_name_of_path(&json_text(&parsed, "path"))),
        "@@text-snippet:" | "@@quote:" => Some(display_snippet_reference(&parsed)),
        "@@review:" => Some(display_review_reference(&parsed)),
        "@@element:" => Some(display_element_reference(&parsed)),
        "@@web:" => {
            let url = json_text(&parsed, "url");
            if url.is_empty() {
                return None;
            }
            let title = json_text(&parsed, "title");
            Some(if title.is_empty() {
                url
            } else {
                format!("{title} {url}")
            })
        }
        "@@conversation:" => {
            if json_text(&parsed, "conversationId").trim().is_empty() {
                return None;
            }
            let title = json_base64_text(&parsed, "title");
            Some(if title.trim().is_empty() {
                "未命名会话".to_string()
            } else {
                title
            })
        }
        "@@command:" => {
            let name = json_text(&parsed, "name");
            if name.trim().is_empty() {
                return None;
            }
            Some(format!("/{}", name.trim()))
        }
        "@@skill:" => {
            let name = json_text(&parsed, "name");
            if !name.trim().is_empty() {
                return Some(name);
            }
            let skill_id = json_text(&parsed, "skillId");
            if skill_id.trim().is_empty() {
                return None;
            }
            Some(skill_id)
        }
        _ => None,
    }
}

/// 文件/目录引用的展示文本：`名称` 或 `名称:L7-L9`（行号后缀由编码端
/// 规范化，原样保留）。
fn display_file_reference(value: &str, is_directory: bool) -> String {
    let (path, lines) = if is_directory {
        (value, "")
    } else if let Some((path, lines)) = split_line_suffix(value) {
        (path, lines)
    } else {
        (value, "")
    };
    let name = file_name_of_path(path);
    if lines.is_empty() {
        name
    } else {
        format!("{name}:{lines}")
    }
}

/// 拆出文件引用末尾的行号后缀（`:L7-L9,L47`）。Windows 路径自带冒号
/// （盘符 `C:`），因此只有整段形如行号列表的尾部才视为后缀。
fn split_line_suffix(value: &str) -> Option<(&str, &str)> {
    let separator = value.rfind(':')?;
    let suffix = &value[separator + 1..];
    if suffix.split(',').all(is_line_reference) {
        Some((&value[..separator], suffix))
    } else {
        None
    }
}

/// 形如 `L7` / `L7-L9` 的单段行号引用。
fn is_line_reference(part: &str) -> bool {
    let valid = |segment: &str| {
        segment
            .strip_prefix('L')
            .map(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
            .unwrap_or(false)
    };
    let mut segments = part.split('-');
    segments.next().map(valid).unwrap_or(false) && segments.all(valid)
}

/// 图片标签的展示扩展名：data URL 的 MIME 优先（`svg+xml` 取 `svg`），
/// 其次取路径扩展名，都没有时按 png。
fn image_tag_extension(value: &str) -> String {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix("data:image/") {
        match rest.split(|c| c == ';' || c == '+').next() {
            Some(subtype) if !subtype.is_empty() => return subtype.to_ascii_lowercase(),
            _ => {}
        }
    }
    let path = value.split(|c| c == '?' || c == '#').next().unwrap_or(value);
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .map(|extension| extension.to_ascii_lowercase())
        .unwrap_or_else(|| "png".to_string())
}

/// 取路径的最后一段（兼容 Windows 反斜杠与 POSIX 斜杠），无有效段时返回原文。
fn file_name_of_path(path: &str) -> String {
    path.split(|c| c == '/' || c == '\\')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(path)
        .to_string()
}

/// 提交引用的展示文本：短 hash（缺失时退回完整 hash 前 7 位）。
fn display_commit_reference(parsed: &serde_json::Value) -> String {
    let short_hash = json_text(parsed, "shortHash");
    if !short_hash.is_empty() {
        return short_hash;
    }
    json_text(parsed, "hash").chars().take(7).collect()
}

/// 文本片段/划词引用的展示文本：摘要字段优先，缺失时退回正文首段。
fn display_snippet_reference(parsed: &serde_json::Value) -> String {
    let summary = json_text(parsed, "summary");
    if !summary.trim().is_empty() {
        return summary;
    }
    collapse_snippet(&json_text(parsed, "content"), 30)
}

/// 审查引用的展示文本：摘要字段优先，缺失时退回提示词（base64）首段。
fn display_review_reference(parsed: &serde_json::Value) -> String {
    let summary = json_text(parsed, "summary");
    if !summary.trim().is_empty() {
        return summary;
    }
    collapse_snippet(&json_base64_text(parsed, "prompt"), 30)
}

/// 元素引用的展示文本：`标签: 备注`（无备注时仅标签）。
fn display_element_reference(parsed: &serde_json::Value) -> String {
    let label = json_text(parsed, "label");
    let display = if label.is_empty() {
        json_text(parsed, "tag")
    } else {
        label
    };
    let note = json_base64_text(parsed, "note");
    if note.is_empty() {
        display
    } else {
        format!("{display}: {note}")
    }
}

/// 读取标签 JSON 的字符串字段，缺失或非字符串时返回空串。
fn json_text(parsed: &serde_json::Value, key: &str) -> String {
    parsed
        .get(key)
        .and_then(|field| field.as_str())
        .unwrap_or("")
        .to_string()
}

/// 读取标签 JSON 中以 base64 承载的自由文本字段（解码失败返回空串）。
fn json_base64_text(parsed: &serde_json::Value, key: &str) -> String {
    parsed
        .get(key)
        .and_then(|field| field.as_str())
        .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

/// 折叠空白并截断的片段文本（摘要字段缺失时的展示回退）。
fn collapse_snippet(text: &str, max_chars: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = compact.chars();
    let mut snippet: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        snippet.push('…');
    }
    snippet
}

fn parse_image_tag_value(value: &str, database_path: &Path) -> Result<Option<ChatImage>> {
    let value = value.trim();
    if value.starts_with("data:") {
        return Ok(parse_base64_image_data_url(value));
    }

    // Reject obviously invalid paths that are not real file references.
    // AI may output literal template strings like "{}" or placeholders
    // after reading source code containing @@image:{}@@ format strings.
    if value.is_empty() || value.contains('{') || !value.contains('/') {
        return Ok(None);
    }

    let relative_path = value;
    let file_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(relative_path);

    // Silently skip unreadable files instead of failing the entire request.
    // A stale or invalid image reference should not block the conversation.
    let bytes = match fs::read(&file_path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    if bytes.is_empty() {
        return Ok(None);
    }

    // 仅接受真实图片文件（按内容魔数嗅探，扩展名声明仅作参考——聊天工具
    // 保存的 `.jpg` 经常实为 PNG）；文本文件被引用时保留原文，避免上游
    // 视觉模型报 "cannot identify image file" 400。
    let media_type = match sniff_image_media_type(&bytes) {
        Some(actual) => actual.to_string(),
        None => return Ok(None),
    };
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let data_url = format!("data:{};base64,{}", media_type, data);

    Ok(Some(ChatImage {
        media_type,
        data,
        data_url,
        source: Some(relative_path.to_string()),
    }))
}

fn parse_base64_image_data_url(data_url: &str) -> Option<ChatImage> {
    let value = data_url.trim();
    let (metadata, data) = value.strip_prefix("data:")?.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?.trim();
    let data = data.trim();

    if media_type.len() <= "image/".len() || !media_type.starts_with("image/") || data.is_empty() {
        return None;
    }

    // 先与上游用相同标准解码器拦截非法 base64，再按内容魔数嗅探真实格式；
    // 仅可解码不足以证明是图片（如文本中的伪标签 `@@image:data:image/png;base64,YQ==@@`），
    // 否则上游视觉模型报 "cannot identify image file" 400。声明的 MIME 仅作
    // 参考，实际以嗅探结果为准（`.jpg` 实为 PNG 时修正 media_type 与 data_url）。
    let decoded = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    let actual_media_type = sniff_image_media_type(&decoded)?;

    let data_url = format!("data:{};base64,{}", actual_media_type, data);

    Some(ChatImage {
        media_type: actual_media_type.to_string(),
        data: data.to_string(),
        data_url,
        source: None,
    })
}

/// 嗅探字节流的真实图片格式（魔数优先于声明的 media_type）。
///
/// 聊天工具保存的图片扩展名经常与实际内容不符（如 `.jpg` 实为 PNG）：
/// 前端按扩展名猜出的 data URL MIME 是错的，若只按声明校验魔数，这类
/// 图片会被拒绝落盘、整段 base64 留在消息里（数百万 token 级的文本膨胀，
/// 并以错误 MIME 打死视觉端点）。返回 None 表示不是任何受支持的图片。
fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xFF\xD8\xFF") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.starts_with(b"\x00\x00\x01\x00") {
        return Some("image/x-icon");
    }
    if bytes.starts_with(b"II*\x00") || bytes.starts_with(b"MM\x00*") {
        return Some("image/tiff");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("image/avif");
    }
    // SVG 是 XML 文本，检查头部标签即可（try_extract_svg_source 已先处理）。
    let head_len = bytes.len().min(512);
    if String::from_utf8_lossy(&bytes[..head_len])
        .trim_start()
        .starts_with('<')
    {
        return Some("image/svg+xml");
    }
    None
}

/// If the image tag value refers to an SVG (either inline data URL or file path),
/// decode/read it and return the raw SVG source text. Returns None for non-SVG.
fn try_extract_svg_source(value: &str, database_path: &Path) -> Option<String> {
    let value = value.trim();

    // Case 1: inline data URL — data:image/svg+xml;base64,...
    if value.starts_with("data:") {
        let (metadata, data) = value.strip_prefix("data:")?.split_once(',')?;
        let media_type = metadata.strip_suffix(";base64")?.trim();
        if media_type != "image/svg+xml" {
            return None;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .ok()?;
        return String::from_utf8(bytes).ok();
    }

    // Case 2: relative file path ending in .svg
    if value.is_empty() || value.contains('{') || !value.contains('/') {
        return None;
    }
    let file_path = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(value);
    if file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
        != Some("svg")
    {
        return None;
    }
    fs::read_to_string(&file_path).ok()
}

pub fn persist_inline_images_to_disk(content: &str, database_path: &Path) -> Result<String> {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let upload_root = resolve_upload_root(database_path)?;
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_dir = upload_root.join(&date);

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);

        let tag_value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return Ok(result);
        };

        let data_url = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;
        if let Some(image_path) = persist_base64_image(data_url, &date_dir)? {
            result.push_str(&format!("@@image:{}@@", image_path));
        } else {
            result.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    result.push_str(remaining);
    Ok(result)
}

fn resolve_upload_root(database_path: &Path) -> Result<PathBuf> {
    let parent = database_path.parent().unwrap_or_else(|| Path::new("."));
    Ok(parent.join("upload"))
}

fn persist_base64_image(data_url: &str, date_dir: &Path) -> Result<Option<String>> {
    let value = data_url.trim();
    let (metadata, data) = match value.strip_prefix("data:").and_then(|v| v.split_once(',')) {
        Some(parts) => parts,
        None => return Ok(None),
    };
    let media_type = match metadata.strip_suffix(";base64") {
        Some(media_type) => media_type.trim(),
        None => return Ok(None),
    };
    if media_type.len() <= "image/".len()
        || !media_type.starts_with("image/")
        || data.trim().is_empty()
    {
        return Ok(None);
    }

    let decoded = match base64::engine::general_purpose::STANDARD.decode(data.trim()) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    // 仅持久化真实图片，避免文本中的伪标签（可解码但非图片）写成垃圾文件。
    // MIME 以内容嗅探结果为准（声明的扩展名可能错误，如 `.jpg` 实为 PNG），
    // 否则这类图片落盘失败、整段 base64 滞留在消息内容里撑爆上下文。
    let media_type = match sniff_image_media_type(&decoded) {
        Some(actual) => actual,
        None => return Ok(None),
    };

    fs::create_dir_all(date_dir).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create upload directory '{}': {}",
            date_dir.display(),
            error
        ))
    })?;

    let hash = blake3::hash(&decoded).to_hex().to_string();
    let ext = media_type_to_extension(media_type);
    let filename = format!("{}.{}", hash, ext);
    let file_path = date_dir.join(&filename);

    if !file_path.exists() {
        let mut file = fs::File::create(&file_path).map_err(|error| {
            Error::from_reason(format!(
                "Failed to create image file '{}': {}",
                file_path.display(),
                error
            ))
        })?;
        file.write_all(&decoded).map_err(|error| {
            Error::from_reason(format!(
                "Failed to write image file '{}': {}",
                file_path.display(),
                error
            ))
        })?;
    }

    let relative = Path::new("upload")
        .join(date_dir.file_name().unwrap_or_default())
        .join(&filename);
    Ok(Some(relative.to_string_lossy().replace('\\', "/")))
}

/// 将消息内容中以相对路径（如 `upload/2026-07-25/hash.png`）引用的
/// 内联图片重新读取为 data URL。
///
/// 发送消息时 base64 图片会被持久化到磁盘，内容里只保留相对路径以节省
/// 数据库体积。但渲染进程无法直接访问该相对路径（浏览器会按页面 base URL
/// 解析，导致 ERR_FILE_NOT_FOUND），因此加载历史消息时需把相对路径还原为
/// data URL，前端才能正常显示与预览。
///
/// 已是 data URL 的标签原样保留；无法读取的相对路径也原样保留，避免破坏内容。
pub fn resolve_inline_images_from_disk(content: &str, database_path: &Path) -> String {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let mut result = String::with_capacity(content.len());
    let mut remaining = content;

    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        result.push_str(&remaining[..tag_start]);

        let tag_value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let Some(tag_end) = tag_value_and_rest.find("@@") else {
            result.push_str(&remaining[tag_start..]);
            return result;
        };

        let value = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;

        if value.trim().starts_with("data:") {
            result.push_str(&remaining[tag_start..full_tag_end]);
        } else if let Some(image) = parse_image_tag_value(value, database_path).unwrap_or(None) {
            result.push_str(&format!("@@image:{}@@", image.data_url));
        } else {
            result.push_str(&remaining[tag_start..full_tag_end]);
        }

        remaining = &remaining[full_tag_end..];
    }

    result.push_str(remaining);
    result
}

/// 按序号解析消息内容中的图片（远控图片接口的数据库兜底路径）。
///
/// 与前端 `parseContentSegments` 的图片序号口径保持一致：只统计
/// `@@image:` 标签的出现次序（0 基），返回第 `image_index` 个标签解析出
/// 的真实图片——data URL 直接解码，`upload/...` 相对路径读盘并校验。
/// 目标标签无法解析为图片时返回 None（不向后续标签试位，避免与前端
/// 渲染出的图片序号错位）。SVG 等非位图标签即使解析成功也由调用方按
/// 支持的 MIME 白名单拒绝（与前端桥的校验一致）。
pub fn resolve_message_image(
    content: &str,
    database_path: &Path,
    image_index: usize,
) -> Option<ChatImage> {
    const IMAGE_TAG_PREFIX: &str = "@@image:";

    let mut remaining = content;
    let mut index = 0usize;
    while let Some(tag_start) = remaining.find(IMAGE_TAG_PREFIX) {
        let tag_value_start = tag_start + IMAGE_TAG_PREFIX.len();
        let tag_value_and_rest = &remaining[tag_value_start..];
        let tag_end = tag_value_and_rest.find("@@")?;
        let value = &tag_value_and_rest[..tag_end];
        let full_tag_end = tag_value_start + tag_end + 2;

        if index == image_index {
            return parse_image_tag_value(value, database_path).ok().flatten();
        }

        index += 1;
        remaining = &remaining[full_tag_end..];
    }

    None
}

fn media_type_to_extension(media_type: &str) -> &str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

#[cfg(test)]
mod sniff_tests {
    use super::{parse_base64_image_data_url, sniff_image_media_type};

    fn base64_encode(data: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(data)
    }

    // PNG magic (89 50 4E 47 0D 0A 1A 0A) + placeholder body; JPEG magic (FF D8 FF).
    const PNG_BYTES: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
    const JPEG_BYTES: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

    #[test]
    fn sniffs_real_format_from_magic_bytes() {
        assert_eq!(sniff_image_media_type(PNG_BYTES), Some("image/png"));
        assert_eq!(sniff_image_media_type(JPEG_BYTES), Some("image/jpeg"));
        assert_eq!(sniff_image_media_type(b"not an image at all"), None);
    }

    #[test]
    fn parse_data_url_corrects_mismatched_declared_mime() {
        // Chat tools often save a PNG with a `.jpg` extension: the declared
        // MIME is wrong, sniffing must win, or the image never persists and
        // its base64 stays inline bloating the context.
        let data_url = format!("data:image/jpeg;base64,{}", base64_encode(PNG_BYTES));
        let image = parse_base64_image_data_url(&data_url).expect("png-in-jpg must be accepted");

        assert_eq!(image.media_type, "image/png");
        assert!(image.data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn parse_data_url_keeps_matching_mime() {
        let data_url = format!("data:image/png;base64,{}", base64_encode(PNG_BYTES));
        let image = parse_base64_image_data_url(&data_url).expect("matching mime must pass");

        assert_eq!(image.media_type, "image/png");
    }

    #[test]
    fn parse_data_url_rejects_non_image_payload() {
        let data_url = format!("data:image/png;base64,{}", base64_encode(b"plain text payload"));
        assert!(parse_base64_image_data_url(&data_url).is_none());
    }
}
