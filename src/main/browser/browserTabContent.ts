/**
 * browser-get_tab_content 的页面提取脚本（issue #240）。
 *
 * content 保持原契约：document.body.innerText 的前 maxLength 个字符。
 * times 是显式标注的时间语义补充，不混入正文：按 DOM 顺序收集 <time>、
 * relative-time 及带 datetime 属性的元素，保留可见文本、逐字 datetime
 * 属性、时区标注与附近上下文。
 *
 * 约束：
 * - 缺失/无效 datetime 不猜测替代值（null / datetimeInvalid），也不执行页面脚本。
 * - datetime 原样保留 Z / offset，未带时区时标注 unstated。
 * - 正文已出现完整日期时不再重复堆叠；条目数与字符预算独立受限。
 * - 只读 DOM，不把不可见属性伪装成页面原本显示的文字（text 只取渲染文字）。
 */
export const buildTabContentScript = (
  maxLength: number,
  includeTimes: boolean,
  timesBudget: number,
): string => String.raw`(() => {
  const MAX_ENTRIES = 40;
  const CONTEXT_LENGTH = 160;
  const BUDGET = ${timesBudget};
  const INCLUDE_TIMES = ${includeTimes ? "true" : "false"};
  const FULL_DATE = /(?:(?:19|20)\d{2}[-/年.]\d{1,2}[-/月.]\d{1,2})|(?:\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}\b)|(?:\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2}\b)/i;
  const collapse = (value) =>
    String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const content = String((document.body && document.body.innerText) || '').slice(0, ${maxLength});
  const title = document.title || '';
  if (!INCLUDE_TIMES) return { title, content };
  // 渲染文字（含 shadow root）：时间组件常把可见文本渲染在 shadow DOM 里，
  // body.innerText 不会带出这些文字。
  const flatten = (node) => {
    let out = '';
    const walk = (current, depth) => {
      if (!current || out.length >= 500 || depth > 8) return;
      if (current.nodeType === 3) { out += current.nodeValue || ''; return; }
      if (current.nodeType !== 1) return;
      const tag = current.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'CANVAS') return;
      if (current.shadowRoot) { walk(current.shadowRoot, depth + 1); return; }
      for (let child = current.firstChild; child; child = child.nextSibling) walk(child, depth + 1);
    };
    walk(node, 0);
    return collapse(out);
  };
  const readText = (el) => {
    const visible = collapse(el.innerText || '');
    if (visible) return visible;
    if (el.shadowRoot) {
      const shadow = collapse(el.shadowRoot.textContent || '');
      if (shadow) return shadow;
    }
    return collapse(el.textContent || '');
  };
  // 只有实际渲染的元素才提供显示文本；隐藏元素仍保留 datetime，但标注 hidden。
  const isRendered = (el) => {
    if (typeof el.checkVisibility !== 'function') return true;
    try {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch {
      return true;
    }
  };
  const contextOf = (el, text) => {
    let node = el.parentElement;
    for (let depth = 0; depth < 3 && node && node !== document.body && node !== document.documentElement; depth += 1, node = node.parentElement) {
      // 优先 innerText：它就是页面实际显示的文字，不会带出隐藏节点。
      const candidate = collapse(node.innerText || '') || flatten(node);
      if (candidate && candidate !== text) return candidate;
    }
    return '';
  };
  const clampContext = (value, text) => {
    if (value.length <= CONTEXT_LENGTH) return value;
    const at = text ? value.indexOf(text) : -1;
    if (at < 0) return value.slice(0, CONTEXT_LENGTH) + '…';
    const start = Math.max(0, at - Math.floor((CONTEXT_LENGTH - text.length) / 2));
    const slice = value.slice(start, start + CONTEXT_LENGTH).trim();
    return (start > 0 ? '…' : '') + slice + (start + CONTEXT_LENGTH < value.length ? '…' : '');
  };
  const zoneOf = (datetime) => {
    const offset = datetime.match(/([+-]\d{2}:?\d{2})$/);
    if (offset) return offset[1];
    if (/[zZ]$/.test(datetime)) return 'UTC (Z)';
    return 'unstated';
  };
  const times = [];
  const seen = new Set();
  let total = 0;
  let used = 0;
  let truncated = false;
  const nodes = Array.from(document.querySelectorAll('time, relative-time, [datetime]'));
  for (const el of nodes) {
    const datetime = collapse(el.getAttribute('datetime') || '');
    const rendered = isRendered(el);
    const text = rendered ? readText(el) : '';
    if (!text && !datetime) continue;
    // 正文中已给出完整日期：不再重复堆叠。
    if (text && FULL_DATE.test(text) && content.indexOf(text) >= 0) continue;
    const context = clampContext(contextOf(el, text), text);
    const key = text + '\n' + datetime + '\n' + context;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;
    const cost = text.length + datetime.length + context.length + 24;
    if (times.length >= MAX_ENTRIES || used + cost > BUDGET) { truncated = true; continue; }
    used += cost;
    const valid = !!datetime && !Number.isNaN(Date.parse(datetime));
    const entry = { text, datetime: datetime || null, timezone: valid ? zoneOf(datetime) : 'unstated', context };
    if (datetime && !valid) entry.datetimeInvalid = true;
    if (!rendered) entry.hidden = true;
    times.push(entry);
  }
  if (!times.length) return { title, content };
  return {
    title,
    content,
    times,
    timesTotal: total,
    ...(truncated ? { timesTruncated: true } : {}),
  };
})()`;
