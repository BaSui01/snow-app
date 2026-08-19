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

/// Keep the first `max_tokens` tokens and decode them back to UTF-8 text.
pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    if text.is_empty() || max_tokens == 0 {
        return String::new();
    }

    let bpe = o200k_base_singleton();
    let bpe_guard = bpe.lock();
    let tokens = bpe_guard.encode_ordinary(text);

    if tokens.len() <= max_tokens {
        return text.to_string();
    }

    bpe_guard
        .decode(tokens.into_iter().take(max_tokens).collect())
        .unwrap_or_default()
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
