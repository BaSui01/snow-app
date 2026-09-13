import hljs from "highlight.js/lib/common";
import { escapeHtml } from "./dom";

/**
 * 轻量 Markdown 渲染（远控页专用，不依赖桌面 Renderer 的 markdown-it 链路）。
 * 支持：围栏代码块、标题（1-3 级）、有序/无序列表、引用、分割线、表格与
 * 内联的 code / strong / em / 链接。
 */

const safeUrl = (value: string): string => {
  try {
    const url = new URL(value, location.href);
    return /^(https?:|mailto:)$/.test(url.protocol)
      ? escapeHtml(url.href)
      : "#";
  } catch {
    return "#";
  }
};

export const inlineMarkdown = (text: string): string => {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\u0000/g, "");
  escaped = escaped.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  escaped = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  escaped = escaped.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label: string, url: string) =>
      `<a href="${safeUrl(url)}" target="_blank" rel="noreferrer">${label}</a>`,
  );
  return escaped;
};

const isTableSeparator = (line: string): boolean => {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return (
    cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
  );
};

const tableHtml = (header: string[], rows: string[][]): string => {
  const head = header
    .map((cell) => `<th>${inlineMarkdown(cell.trim())}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell.trim())}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
};

const splitCells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

/** 超长代码块跳过高亮：流式渲染期间变更块会反复重渲，避免移动端单帧成本过大。 */
const HIGHLIGHT_LENGTH_LIMIT = 30000;

/**
 * 围栏代码块 HTML：语言标签条 + highlight.js 高亮（common 语言集，
 * 与桌面端同库同色板）。未标注语言、语言未收录或高亮失败时退回纯转义文本。
 */
const codeBlockHtml = (info: string, code: string): string => {
  // fence info 可能带附加说明（如 ```ts title=...），语言取第一个词。
  const language = info.trim().split(/\s+/)[0] || "";
  let body = `<code>${escapeHtml(code)}</code>`;
  if (
    language &&
    code.length <= HIGHLIGHT_LENGTH_LIMIT &&
    hljs.getLanguage(language)
  ) {
    try {
      const highlighted = hljs.highlight(code, {
        language,
        ignoreIllegals: true,
      }).value;
      body = `<code class="hljs language-${escapeHtml(language)}">${highlighted}</code>`;
    } catch {
      // 高亮失败时保留纯转义文本
    }
  }
  return (
    `<div class="code-block">` +
    `<div class="code-block-head">${escapeHtml(language || "code")}</div>` +
    `<pre>${body}</pre>` +
    `</div>`
  );
};

export const renderMarkdown = (source: string | null | undefined): string => {
  let text = String(source || "").replace(/\r\n?/g, "\n");

  // 先摘出围栏代码块，避免块内内容参与行解析。
  const blocks: string[] = [];
  text = text.replace(
    /```([^\n]*)\n?([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const key = `\u0000BLOCK${blocks.length}\u0000`;
      blocks.push(codeBlockHtml(lang, code.replace(/\n$/, "")));
      return key;
    },
  );

  const lines = text.split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;

  const flush = (): void => {
    if (paragraph.length) {
      out.push(
        `<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`,
      );
      paragraph = [];
    }
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) {
      flush();
      out.push(blocks[Number(block[1])]);
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      flush();
      const header = splitCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      i--;
      out.push(tableHtml(header, rows));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const item = line.match(/^\s*([-*+] |\d+\. )(.+)$/);
    if (item) {
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== kind) {
        flush();
        list = kind;
        out.push(`<${kind}>`);
      }
      out.push(`<li>${inlineMarkdown(item[2])}</li>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flush();
      out.push(
        `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`,
      );
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    paragraph.push(line);
  }
  flush();
  return out.join("");
};
