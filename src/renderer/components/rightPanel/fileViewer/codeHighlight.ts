import hljs from "highlight.js";

import {
  escapeHtml,
  splitHighlightedHtmlLines,
  type LineIndex,
} from "./codeText";

const CHUNK_LINES = 128;
const CONTEXT_LINES = 12;
const MAX_CHUNK_CHARS = 65536;
const MAX_CACHED_CHUNKS = 48;

type ChunkEntry = { prefix: string; lines: string[] | null };

export type CodeHighlighter = {
  enabled: boolean;
  lineHtml: (line: number) => string;
  prefetch: (line: number) => void;
};

// 分块按文本内容缓存：大文件编辑每次输入都会重建行索引，
// 内容级缓存让未改动的分块（绝大多数）继续复用，只有被编辑的分块重算。
const chunkCache = new Map<string, ChunkEntry>();

const schedule = (job: () => void): void => {
  const idle = (
    window as unknown as {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (idle) {
    idle(job, { timeout: 300 });
    return;
  }
  window.setTimeout(job, 80);
};

const readChunk = (
  language: string,
  chunkText: string,
  prefixText: string,
  prefixLines: number,
): string[] | null => {
  const cached = chunkCache.get(chunkText);
  if (cached && cached.prefix === prefixText) return cached.lines;
  let lines: string[] | null = null;
  const text =
    prefixText.length > 0 ? `${prefixText}\n${chunkText}` : chunkText;
  if (text.length <= MAX_CHUNK_CHARS) {
    try {
      const html = hljs.highlight(text, {
        language,
        ignoreIllegals: true,
      }).value;
      lines = splitHighlightedHtmlLines(html).slice(prefixLines);
    } catch {
      lines = null;
    }
  }
  if (chunkCache.size >= MAX_CACHED_CHUNKS && !chunkCache.has(chunkText)) {
    const oldest = chunkCache.keys().next();
    if (!oldest.done) chunkCache.delete(oldest.value);
  }
  chunkCache.set(chunkText, { prefix: prefixText, lines });
  return lines;
};

export const createCodeHighlighter = (
  index: LineIndex,
  language: string,
): CodeHighlighter => {
  const enabled = language.length > 0 && Boolean(hljs.getLanguage(language));
  const pending = new Set<number>();

  const computeChunk = (chunk: number): string[] | null => {
    const firstLine = chunk * CHUNK_LINES + 1;
    const lastLine = Math.min(index.total, firstLine + CHUNK_LINES - 1);
    const contextFrom = Math.max(1, firstLine - CONTEXT_LINES);
    const prefixParts: string[] = [];
    for (let line = contextFrom; line < firstLine; line += 1) {
      prefixParts.push(index.getLine(line));
    }
    const bodyParts: string[] = [];
    for (let line = firstLine; line <= lastLine; line += 1) {
      bodyParts.push(index.getLine(line));
    }
    return readChunk(
      language,
      bodyParts.join("\n"),
      prefixParts.join("\n"),
      prefixParts.length,
    );
  };

  return {
    enabled,
    lineHtml: (line) => {
      const text = index.getLine(line);
      if (!enabled) return escapeHtml(text);
      const chunk = Math.floor((line - 1) / CHUNK_LINES);
      const lines = computeChunk(chunk);
      return lines?.[line - 1 - chunk * CHUNK_LINES] ?? escapeHtml(text);
    },
    prefetch: (line) => {
      if (!enabled) return;
      const chunk = Math.floor(Math.max(0, line - 1) / CHUNK_LINES);
      if (pending.has(chunk)) return;
      pending.add(chunk);
      schedule(() => {
        pending.delete(chunk);
        computeChunk(chunk);
      });
    },
  };
};
