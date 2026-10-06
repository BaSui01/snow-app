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

pub(super) fn parse_image_tag_value(value: &str, database_path: &Path) -> Result<Option<ChatImage>> {
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
pub(super) fn try_extract_svg_source(value: &str, database_path: &Path) -> Option<String> {
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
