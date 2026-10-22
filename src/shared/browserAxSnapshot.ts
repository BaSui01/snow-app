/** CDP AXValue.value 运行时并不保证是字符串：spinbutton 等节点的数量值是 number，checked 类是 boolean。 */
export type AxValue = string | number | boolean;
/** CDP AX 属性（checked/expanded/valuemin 等）：紧凑输出据此保留控件状态与取值范围。 */
export type AxProperty = {
  name?: string;
  value?: { value?: AxValue };
};
export type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: AxValue };
  name?: { value?: AxValue };
  value?: { value?: AxValue };
  description?: { value?: AxValue };
  properties?: AxProperty[];
  childIds?: string[];
  frameId?: string;
  backendDOMNodeId?: number;
  backendNodeId?: number;
};
export type AxSnapshotResult = {
  tree: string;
  totalNodes: number;
  emitted: number;
  truncated: boolean;
};
export type AxSerializeOptions = {
  verbose?: boolean;
  maxNodes?: number;
  /** 帧快照沿用既有隐私策略：不输出控件取值，只保留角色、名称与状态。 */
  redactValues?: boolean;
  /** 节点 ref 分配由调用方负责：ref 必须绑定到所属标签页与文档，避免跨文档误解析。 */
  refForNode: (node: AxNode) => string | null;
};
const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "heading",
  "banner",
  "navigation",
  "main",
  "dialog",
  "alert",
  "listbox",
  "option",
  "switch",
  "slider",
  "spinbutton",
  "table",
  "row",
  "columnheader",
  "rowheader",
  "grid",
  "tree",
  "img",
  "form",
  "search",
  "toolbar",
  "tablist",
  "menu",
  "menu bar",
  "complementary",
  "contentinfo",
  "region",
  "article",
  "list",
  "listitem",
  "group",
  "progressbar",
  "status",
  "timer",
  "text",
  "paragraph",
]);
/** 需要保留取值才能判断下一步的控件角色。 */
const VALUE_ROLES = new Set([
  "combobox",
  "listbox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "progressbar",
  "meter",
]);
/** 取值范围属性适用的角色。 */
const RANGE_ROLES = new Set(["slider", "spinbutton", "progressbar", "meter"]);
/** 表格行按单元格聚合文本，其余容器聚合后代文本。 */
const TEXT_SUMMARY_ROLES = new Set([
  "row",
  "listitem",
  "paragraph",
  "alert",
  "status",
  "dialog",
]);
const CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
/** 紧凑模式输出的布尔/枚举状态；true 表示仅非 true 值省略。 */
const STATE_ATTRIBUTES: [string, "always" | "true" | "nonfalse"][] = [
  ["checked", "always"],
  ["pressed", "always"],
  ["expanded", "always"],
  ["selected", "true"],
  ["disabled", "true"],
  ["required", "true"],
  ["readonly", "true"],
  ["invalid", "nonfalse"],
  ["multiselectable", "true"],
];
/** 密码类控件的取值不下发，即使 CDP 未屏蔽也一样处理。 */
const SENSITIVE_VALUE_NAME =
  /\bpass(?:word|phrase|code|wd)\b|密码|口令|\bsecret\b|\btoken\b|api[ _-]?key|\bcvv\b|\bcvc\b|credit[ _-]?card|card[ _-]?number|\bssn\b|social[ _-]?security|one[ _-]?time/i;
const NAME_MAX_CHARS = 200;
const ROW_TEXT_MAX_CHARS = 240;
/** 段落只保留短文本（价格、错误提示等），避免把全站正文灌进快照。 */
const PARAGRAPH_MAX_CHARS = 160;
/** 把任意运行时 AX value 安全转成文本；number 0、false 等合法值不丢失。 */
const axText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
};
const normalizeText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();
const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;
const escapeAxText = (value: string): string => value.replace(/"/g, '\\"');
/** AX 节点对应的 DOM backendNodeId（CDP 不同版本字段名不同）。 */
export const axBackendNodeId = (node: AxNode): number | null => {
  const backend = node.backendDOMNodeId ?? node.backendNodeId;
  return typeof backend === "number" ? backend : null;
};
/** Serialize engine AX nodes; refs are issued by the caller per tab/document. */
export const serializeAxTree = (
  nodes: AxNode[],
  options: AxSerializeOptions,
): AxSnapshotResult => {
  const verbose = options.verbose === true;
  const redactValues = options.redactValues === true;
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 200));
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const referenced = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const lines: string[] = [];
  let totalNodes = 0;
  let emitted = 0;
  let truncated = false;
  const visited = new Set<string>();
  const roleOf = (node: AxNode): string => axText(node.role?.value);
  const nameOf = (node: AxNode): string =>
    normalizeText(axText(node.name?.value));
  const propertiesOf = (node: AxNode): Map<string, AxValue | undefined> => {
    const properties = new Map<string, AxValue | undefined>();
    for (const property of node.properties ?? []) {
      if (typeof property.name !== "string" || !property.name) continue;
      properties.set(property.name, property.value?.value);
    }
    return properties;
  };
  const propertyText = (value: AxValue | undefined): string => {
    if (value === true) return "true";
    if (value === false) return "false";
    return normalizeText(axText(value));
  };
  const staticText = (node: AxNode): string => {
    const role = roleOf(node);
    if (role === "StaticText" || role === "text") return nameOf(node);
    if (role === "" && (node.childIds?.length ?? 0) === 0) return nameOf(node);
    return "";
  };
  /** 单元格文本：优先自身名称，否则拼接内部静态文本。 */
  const cellCaption = (cell: AxNode): string => {
    const own = nameOf(cell);
    if (own) return own;
    const parts: string[] = [];
    let scanned = 0;
    const visit = (id: string): void => {
      if (scanned++ > 60) return;
      const child = byId.get(id);
      if (!child) return;
      const role = roleOf(child);
      if (CELL_ROLES.has(role)) return;
      const text = staticText(child);
      if (text) {
        if (parts[parts.length - 1] !== text) parts.push(text);
        return;
      }
      for (const grandChild of child.childIds ?? []) visit(grandChild);
    };
    for (const child of cell.childIds ?? []) visit(child);
    return parts.join(" ");
  };
  /** 聚合容器后代文本；表格行按单元格用 ` | ` 分隔。 */
  const collectText = (
    node: AxNode,
    tableRow: boolean,
  ): { text: string; nestedSummary: boolean } => {
    const parts: string[] = [];
    let nestedSummary = false;
    let scanned = 0;
    const push = (value: string): void => {
      const text = normalizeText(value);
      if (!text) return;
      // 表格单元格可以重复（相同的价格/数量），其他容器去重避免重复文本。
      if (!tableRow && parts[parts.length - 1] === text) return;
      parts.push(text);
    };
    const visit = (id: string): void => {
      if (scanned++ > 400) return;
      const child = byId.get(id);
      if (!child) return;
      const role = roleOf(child);
      if (tableRow) {
        if (CELL_ROLES.has(role)) {
          push(cellCaption(child));
          return;
        }
      } else if (TEXT_SUMMARY_ROLES.has(role)) {
        // 子容器会输出自己的文本摘要，父容器不再重复。
        nestedSummary = true;
        return;
      }
      const text = staticText(child);
      if (text) {
        push(text);
        return;
      }
      for (const grandChild of child.childIds ?? []) visit(grandChild);
    };
    for (const child of node.childIds ?? []) visit(child);
    return {
      text: clip(parts.join(tableRow ? " | " : " "), ROW_TEXT_MAX_CHARS),
      nestedSummary,
    };
  };
  const summarize = (node: AxNode, role: string): string => {
    if (!TEXT_SUMMARY_ROLES.has(role)) return "";
    const { text, nestedSummary } = collectText(node, role === "row");
    if (!text || nestedSummary) return "";
    if (role === "paragraph" && text.length > PARAGRAPH_MAX_CHARS) return "";
    return text;
  };
  /** combobox/listbox 未提供 value 时，回退到选中 option 的文本。 */
  const selectedOptionCaption = (node: AxNode): string => {
    const queue = [...(node.childIds ?? [])];
    let scanned = 0;
    while (queue.length && scanned++ < 200) {
      const id = queue.shift() as string;
      const child = byId.get(id);
      if (!child) continue;
      if (roleOf(child) === "option") {
        const selected = propertyText(propertiesOf(child).get("selected"));
        if (selected === "true") return nameOf(child);
        continue;
      }
      queue.push(...(child.childIds ?? []));
    }
    return "";
  };
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node || truncated || visited.has(id)) return;
    visited.add(id);
    const role = roleOf(node);
    const name = nameOf(node);
    const interesting =
      !node.ignored &&
      (verbose ||
        INTERESTING_ROLES.has(role) ||
        (!!name.trim() && role === ""));
    if (interesting) {
      totalNodes++;
      if (emitted >= maxNodes) {
        truncated = true;
        return;
      }
      const summary = name ? "" : summarize(node, role);
      const label = name || summary;
      const properties = propertiesOf(node);
      const parts: string[] = [];
      if (role) parts.push(role);
      if (label) parts.push(`"${escapeAxText(clip(label, NAME_MAX_CHARS))}"`);
      const usedProperties = new Set<string>([
        "valuetext",
        "valuemin",
        "valuemax",
      ]);
      for (const [key, mode] of STATE_ATTRIBUTES) {
        const value = propertyText(properties.get(key));
        if (!value) continue;
        if (mode === "true" && value !== "true") continue;
        if (mode === "nonfalse" && value === "false") continue;
        parts.push(`${key}=${value}`);
        usedProperties.add(key);
      }
      if (VALUE_ROLES.has(role) || verbose) {
        const valueText =
          propertyText(properties.get("valuetext")) ||
          propertyText(node.value?.value) ||
          selectedOptionCaption(node);
        if (valueText && !redactValues) {
          const target = name || label;
          const display = SENSITIVE_VALUE_NAME.test(target)
            ? "[redacted]"
            : clip(valueText, NAME_MAX_CHARS);
          parts.push(`value="${escapeAxText(display)}"`);
        }
      }
      if (RANGE_ROLES.has(role)) {
        const min = propertyText(properties.get("valuemin"));
        const max = propertyText(properties.get("valuemax"));
        if (min) parts.push(`min=${min}`);
        if (max) parts.push(`max=${max}`);
      }
      if (verbose) {
        for (const [key, value] of properties) {
          if (usedProperties.has(key)) continue;
          const text = propertyText(value);
          if (text) parts.push(`${key}="${escapeAxText(text)}"`);
        }
      }
      const bareSummary = !verbose && TEXT_SUMMARY_ROLES.has(role) && !label;
      const lineEmitted = parts.length > 0 && !bareSummary;
      if (lineEmitted) {
        const uid = options.refForNode(node);
        if (uid) parts.push(`[uid=${uid}]`);
        lines.push(`${"  ".repeat(depth)}- ${parts.join(" ")}`);
        emitted++;
      }
      for (const child of node.childIds ?? [])
        walk(child, lineEmitted ? depth + 1 : depth);
      return;
    }
    for (const child of node.childIds ?? []) walk(child, depth);
  };
  for (const node of nodes)
    if (!referenced.has(node.nodeId)) walk(node.nodeId, 0);
  return { tree: lines.join("\n"), totalNodes, emitted, truncated };
};
