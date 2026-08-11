use std::time::Duration;

use futures::Stream;
use tokio_util::sync::CancellationToken;

use crate::api::retry::{next_stream_item_with_idle, StreamReadOutcome};

/// Find the earliest SSE event separator in a byte buffer.
///
/// SSE events are separated by `\n\n` (LF line endings) or `\r\n\r\n`
/// (CRLF line endings). Some API servers use CRLF, which `str::find("\n\n")`
/// cannot match because the two `\n` bytes are separated by `\r`.
///
/// Using a `Vec<u8>` buffer instead of a `String` also avoids data
/// corruption when a TCP chunk boundary falls inside a multi-byte UTF-8
/// sequence (e.g. Chinese characters in tool-call arguments). With
/// `String::from_utf8_lossy` the incomplete bytes would be replaced by
/// U+FFFD, producing invalid JSON and causing the entire SSE event —
/// potentially the one carrying a `function.name` delta — to be silently
/// skipped, which in turn makes the agent loop terminate early.
///
/// Returns `(position, length)` of the separator, or `None` if not found.
pub(crate) fn find_sse_separator(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf_pos = buffer.windows(2).position(|w| w == b"\n\n");
    let crlf_pos = buffer.windows(4).position(|w| w == b"\r\n\r\n");
    match (lf_pos, crlf_pos) {
        (Some(lf), Some(crlf)) => {
            if crlf < lf {
                Some((crlf, 4))
            } else {
                Some((lf, 2))
            }
        }
        (Some(lf), None) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
}

/// Final outcome of consuming one Provider SSE response body.
///
/// The Provider-specific parser reports terminal events through the callback;
/// transport EOF, read errors, idle timeouts, and cancellation remain typed so
/// the caller can apply the shared recovery policy exactly once.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SseStreamEnd<E> {
    ProviderTerminal,
    ReadError(E),
    UnexpectedEof,
    IdleTimeout,
    Cancelled,
}

/// Consume SSE bytes until the Provider reports a terminal event or the
/// transport ends. Complete delimiter-terminated blocks are parsed as they
/// arrive. On EOF, a final non-empty block without a trailing delimiter is
/// parsed before classifying the stream as an unexpected EOF.
pub(crate) async fn read_sse_stream_until_terminal<S, T, E, F>(
    stream: &mut S,
    byte_buffer: &mut Vec<u8>,
    cancel_token: &CancellationToken,
    idle_timeout: Duration,
    mut process_event_block: F,
) -> SseStreamEnd<E>
where
    S: Stream<Item = std::result::Result<T, E>> + Unpin,
    T: AsRef<[u8]>,
    F: FnMut(&str) -> bool,
{
    loop {
        match next_stream_item_with_idle(stream, cancel_token, idle_timeout).await {
            StreamReadOutcome::Cancelled => return SseStreamEnd::Cancelled,
            StreamReadOutcome::Data(chunk) => {
                byte_buffer.extend_from_slice(chunk.as_ref());
                while let Some((separator_index, separator_len)) = find_sse_separator(byte_buffer) {
                    let event_block =
                        String::from_utf8_lossy(&byte_buffer[..separator_index]).to_string();
                    *byte_buffer = byte_buffer[separator_index + separator_len..].to_vec();
                    if process_event_block(&event_block) {
                        return SseStreamEnd::ProviderTerminal;
                    }
                }
            }
            StreamReadOutcome::ReadError(error) => return SseStreamEnd::ReadError(error),
            StreamReadOutcome::Eof => {
                let trailing_bytes = std::mem::take(byte_buffer);
                if !trailing_bytes.is_empty() {
                    let trailing_block = String::from_utf8_lossy(&trailing_bytes).to_string();
                    if !trailing_block.trim().is_empty() && process_event_block(&trailing_block) {
                        return SseStreamEnd::ProviderTerminal;
                    }
                }
                return SseStreamEnd::UnexpectedEof;
            }
            StreamReadOutcome::IdleTimeout => return SseStreamEnd::IdleTimeout,
        }
    }
}