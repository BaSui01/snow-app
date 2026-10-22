//! Streaming token counter for real-time probe feedback.
//!
//! Each call to [`count_tokens`] uses the `o200k_base` tokenizer singleton,
//! which is the encoding used by GPT-4o / GPT-4.1 / o-series models. The
//! tokenizer is process-global and lazily initialized on first use; it never
//! blocks the Node.js main thread because counting happens inside the tokio
//! worker pool that napi-rs spawns for async functions.
//!
//! The counter is designed as a *probe*: callers accumulate token counts
//! across streaming chunks for a single agent-loop iteration, then reset to
//! zero when the next iteration starts. This mirrors the Snow CLI
//! `streamTokenCount` behavior but runs entirely in the Rust backend so the
//! renderer never has to load a WASM tokenizer.

use tiktoken_rs::o200k_base_singleton;

const BOUNDED_CHUNK_BYTES: usize = 32 * 1024;
const PREFIX_BYTES_PER_TOKEN: usize = 4;
const PREFIX_GUESS_ROUNDS: usize = 3;

pub struct BoundedTokenCount {
    pub exceeded: bool,
    pub counted: usize,
    pub scanned_bytes: usize,
    pub total_bytes: usize,
}

impl BoundedTokenCount {
    pub fn estimated_total(&self) -> usize {
        if !self.exceeded || self.scanned_bytes == 0 {
            return self.counted;
        }
        self.counted
            .saturating_mul(self.total_bytes)
            .checked_div(self.scanned_bytes)
            .unwrap_or(self.counted)
    }
}

fn safe_prefix_end(text: &str, max_bytes: usize) -> usize {
    let mut end = max_bytes.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end >= text.len() {
        return text.len();
    }
    if let Some(newline) = text[..end].rfind('\n') {
        let snapped = newline + 1;
        if snapped * 2 > end {
            end = snapped;
        }
    }
    if end == 0 {
        end = text.chars().next().map(char::len_utf8).unwrap_or(text.len());
    }
    end.min(text.len())
}

/// Count the number of tokens in `text` using the `o200k_base` encoding.
///
/// Returns `0` when `text` is empty or when the tokenizer fails to encode
/// the input (e.g. invalid UTF-8 boundaries). Encoding failures are treated
/// as best-effort and never propagated, matching the Snow CLI `countTokens`
/// behavior where encoding errors are silently ignored.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let bpe = o200k_base_singleton();
    // `o200k_base_singleton()` returns an `Arc<Mutex<CoreBPE>`. Lock the
    // mutex to access the underlying encoder. The lock is held only for the
    // duration of the encode call, so concurrent streams can still make
    // progress.
    let bpe_guard = bpe.lock();
    // `encode_ordinary` does not treat any substring as a special token,
    // matching how the JS `tiktoken` `encode_ordinary` method behaves and
    // avoiding spurious special-token splits in tool-call JSON deltas.
    bpe_guard.encode_ordinary(text).len()
}

pub fn count_tokens_bounded(text: &str, limit: usize) -> BoundedTokenCount {
    let total_bytes = text.len();
    if text.is_empty() {
        return BoundedTokenCount {
            exceeded: false,
            counted: 0,
            scanned_bytes: 0,
            total_bytes,
        };
    }

    let bpe = o200k_base_singleton();
    let bpe_guard = bpe.lock();
    let mut counted = 0usize;
    let mut scanned_bytes = 0usize;

    while scanned_bytes < text.len() {
        let rest = &text[scanned_bytes..];
        let end = safe_prefix_end(rest, BOUNDED_CHUNK_BYTES);
        counted += bpe_guard.encode_ordinary(&rest[..end]).len();
        scanned_bytes += end;
        if counted > limit {
            return BoundedTokenCount {
                exceeded: true,
                counted,
                scanned_bytes,
                total_bytes,
            };
        }
    }

    BoundedTokenCount {
        exceeded: false,
        counted,
        scanned_bytes,
        total_bytes,
    }
}

pub fn truncate_to_token_prefix(text: &str, max_tokens: usize) -> (String, usize) {
    if text.is_empty() || max_tokens == 0 {
        return (String::new(), 0);
    }

    let bpe = o200k_base_singleton();
    let bpe_guard = bpe.lock();
    let mut end = safe_prefix_end(text, max_tokens.saturating_mul(PREFIX_BYTES_PER_TOKEN).max(1));
    let mut tokens = bpe_guard.encode_ordinary(&text[..end]).len();

    for _ in 0..PREFIX_GUESS_ROUNDS {
        if tokens <= max_tokens || end >= text.len() {
            break;
        }
        let scaled = end.saturating_mul(max_tokens) / tokens.max(1);
        let next = safe_prefix_end(text, scaled.min(end.saturating_sub(1)));
        if next >= end {
            break;
        }
        end = next;
        tokens = bpe_guard.encode_ordinary(&text[..end]).len();
    }

    while tokens > max_tokens && end > 0 {
        let next = safe_prefix_end(text, end / 2);
        if next == 0 || next >= end {
            break;
        }
        end = next;
        tokens = bpe_guard.encode_ordinary(&text[..end]).len();
    }

    if tokens > max_tokens {
        return (String::new(), 0);
    }

    (text[..end].to_string(), tokens)
}

/// 与 [`safe_prefix_end`] 对称：返回保留末尾约 `max_bytes` 字节的起点，
/// 落在字符边界上，且在不丢掉过半内容时对齐到下一行行首。
fn safe_suffix_start(text: &str, max_bytes: usize) -> usize {
    if max_bytes >= text.len() {
        return 0;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    if let Some(newline) = text[start..].find('\n') {
        let snapped = start + newline + 1;
        if (text.len() - snapped) * 2 > text.len() - start {
            start = snapped;
        }
    }
    start
}

/// Keep the last `max_tokens` tokens of `text` (suffix counterpart of
/// [`truncate_to_token_prefix`]).
fn truncate_to_token_suffix(text: &str, max_tokens: usize) -> (String, usize) {
    if text.is_empty() || max_tokens == 0 {
        return (String::new(), 0);
    }

    let bpe = o200k_base_singleton();
    let bpe_guard = bpe.lock();
    let mut start = safe_suffix_start(
        text,
        max_tokens.saturating_mul(PREFIX_BYTES_PER_TOKEN).max(1),
    );
    let mut tokens = bpe_guard.encode_ordinary(&text[start..]).len();

    for _ in 0..PREFIX_GUESS_ROUNDS {
        if tokens <= max_tokens {
            break;
        }
        let kept = text.len() - start;
        let scaled = kept.saturating_mul(max_tokens) / tokens.max(1);
        let next = safe_suffix_start(text, scaled.min(kept.saturating_sub(1)));
        if next <= start {
            break;
        }
        start = next;
        tokens = bpe_guard.encode_ordinary(&text[start..]).len();
    }

    while tokens > max_tokens && start < text.len() {
        let next = safe_suffix_start(text, (text.len() - start) / 2);
        if next <= start || next >= text.len() {
            break;
        }
        start = next;
        tokens = bpe_guard.encode_ordinary(&text[start..]).len();
    }

    if tokens > max_tokens {
        return (String::new(), 0);
    }

    (text[start..].to_string(), tokens)
}

/// 省略说明自身的 token 预留（`[... N characters omitted ...]` 加换行）。
const MIDDLE_MARKER_TOKENS: usize = 24;

/// 头尾保留、中段省略：超出 `max_tokens` 时保留开头约 2/3、结尾约 1/3 的预算，
/// 中间插入省略说明（报错与结论通常在输出末尾，只保留开头会把它们截掉）。
/// 未超出时原样返回。
pub fn truncate_middle_by_tokens(text: &str, max_tokens: usize) -> String {
    if !count_tokens_bounded(text, max_tokens).exceeded {
        return text.to_string();
    }
    let content_budget = max_tokens.saturating_sub(MIDDLE_MARKER_TOKENS);
    let head_budget = content_budget * 2 / 3;
    let (head, _) = truncate_to_token_prefix(text, head_budget);
    let rest = &text[head.len()..];
    let (tail, _) = truncate_to_token_suffix(rest, content_budget - head_budget);
    let omitted_chars = rest[..rest.len() - tail.len()].chars().count();
    format!("{head}\n\n[... {omitted_chars} characters omitted ...]\n\n{tail}")
}

/// Keep the first `max_tokens` tokens and decode them back to UTF-8 text.
pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    truncate_to_token_prefix(text, max_tokens).0
}

/// Split text into token-bounded pieces using the same tokenizer as the counter.
pub fn split_to_token_chunks(text: &str, max_tokens: usize) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    if max_tokens == 0 {
        return vec![text.to_string()];
    }

    let bpe = o200k_base_singleton();
    let bpe_guard = bpe.lock();
    let tokens = bpe_guard.encode_ordinary(text);
    if tokens.len() <= max_tokens {
        return vec![text.to_string()];
    }

    tokens
        .chunks(max_tokens)
        .filter_map(|part| bpe_guard.decode(part.to_vec()).ok())
        .filter(|part| !part.is_empty())
        .collect()
}
