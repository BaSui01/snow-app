/**
 * 终端"等待输入"检测：判断当前屏幕最后一行的内容是否表明
 * 程序/shell 正在等待用户（或 Agent）输入，并提取提示文本。
 *
 * 判定条件（全部满足才算等待输入）：
 * 1. 光标停留在 buffer 最后一行（输出若以换行结束，光标会移到下一行行首，
 *    说明没有悬而未决的提示符）。
 * 2. 最后一行非空，且未填满整行宽度（满行 + isWrapped 属于持续输出中）。
 * 3. 行内容命中等待输入模式：明确的提问/确认/密码/按键提示，或以
 *    shell 提示符（$ # % > 等结尾），或以 ? : > 结尾的弱信号。
 */

import type { Terminal } from "@xterm/xterm";

export type AwaitingInputInfo = {
  /** 是否正在等待输入 */
  awaiting: boolean;
  /** 匹配到的提示文本（用于展示给用户/Agent 判断该输入什么） */
  hint: string;
};

/** 明确的交互提示模式（英文） */
const PROMPT_PATTERNS: RegExp[] = [
  /press enter/i,
  /press return/i,
  /press any key/i,
  /hit enter/i,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[yes\/no\]/i,
  /\(yes\/no\)/i,
  /\by\/n\b/i,
  /yes\/no/i,
  /password:/i,
  /passphrase:/i,
  /token:/i,
  /otp:/i,
  /continue\?/i,
  /proceed\?/i,
  /confirm/i,
  /overwrite/i,
  /replace (existing|the file)/i,
  /do you want/i,
  /are you sure/i,
  /select (an option|a number|the .* option)/i,
  /choose/i,
  /enter your/i,
  /enter (a|the) (value|number|name|path|key)/i,
  /type your/i,
  /please (enter|type|provide|input|press)/i,
  /authenticate/i,
  /login:/i,
  /username:/i,
];

/** 明确的交互提示模式（中文） */
const PROMPT_PATTERNS_ZH: RegExp[] = [
  /按(回车|任意键|回车键)/i,
  /请输入/i,
  /请选择/i,
  /是否/i,
  /确认/i,
  /继续/i,
  /密码/i,
  /口令/i,
  /登录/i,
  /用户名/i,
  /\[y\/n\]/i,
];

/** shell 提示符结尾：`$ `、`# `、`% `、`> `、`❯ ` 等 */
const SHELL_PROMPT_RE = /(?:^|\s)[$#%>❯▶›] ?$/;

/** 弱信号：行尾是提问/等待字符（? : >），无空格或带尾随空格 */
const WEAK_TRAILING_RE = /[?:>]\s*$/;

export const detectAwaitingInput = (term: Terminal): AwaitingInputInfo => {
  const buffer = term.buffer.active;
  const length = buffer.length;
  if (length === 0) {
    return { awaiting: false, hint: "" };
  }

  // 光标不在最后一行 → 输出仍在进行或刚换行结束，不算等待输入
  if (buffer.cursorY !== length - 1) {
    return { awaiting: false, hint: "" };
  }

  const line = buffer.getLine(length - 1);
  if (!line) {
    return { awaiting: false, hint: "" };
  }

  const text = line.translateToString(true).trimEnd();
  if (!text) {
    return { awaiting: false, hint: "" };
  }

  // 行内容填满宽度（整行都在刷输出）→ 输出中，不算等待输入
  if (text.length >= term.cols - 1) {
    return { awaiting: false, hint: "" };
  }

  const allPatterns = [...PROMPT_PATTERNS, ...PROMPT_PATTERNS_ZH];
  if (allPatterns.some((pattern) => pattern.test(text))) {
    return { awaiting: true, hint: text };
  }

  if (SHELL_PROMPT_RE.test(text)) {
    return { awaiting: true, hint: text };
  }

  if (WEAK_TRAILING_RE.test(text)) {
    return { awaiting: true, hint: text };
  }

  return { awaiting: false, hint: "" };
};
