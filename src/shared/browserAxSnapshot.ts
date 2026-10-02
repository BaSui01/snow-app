export type AxNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  description?: { value?: string };
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
]);
let axUidCounter = 0;
const axUidByDomKey = new Map<string, string>();
const axUidToBackend = new Map<string, number>();
const uidOf = (node: AxNode): string | null => {
  const backend = node.backendDOMNodeId ?? node.backendNodeId;
  if (typeof backend !== "number") return null;
  const key = `${node.frameId ?? "root"}:${backend}`;
  let uid = axUidByDomKey.get(key);
  if (!uid) {
    uid = `e${++axUidCounter}`;
    axUidByDomKey.set(key, uid);
    axUidToBackend.set(uid, backend);
  }
  return uid;
};
export const resolveAxRef = (ref: string): number | null =>
  axUidToBackend.get(ref) ?? null;
/** Serialize engine AX nodes; custom refs allow callers to isolate snapshots by document/session. */
export const serializeAxTree = (
  nodes: AxNode[],
  options: {
    verbose?: boolean;
    maxNodes?: number;
    refForNode?: (node: AxNode) => string | null;
  } = {},
): AxSnapshotResult => {
  const verbose = options.verbose === true;
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? 200));
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const referenced = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const lines: string[] = [];
  let totalNodes = 0;
  let emitted = 0;
  let truncated = false;
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node || truncated || visited.has(id)) return;
    visited.add(id);
    const role = node.role?.value ?? "";
    const name = node.name?.value ?? "";
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
      const parts: string[] = [];
      const escape = (value: string): string => value.replace(/"/g, '\\"');
      if (role) parts.push(role);
      if (name) parts.push(`"${escape(name)}"`);
      if (verbose && node.value?.value)
        parts.push(`value="${escape(node.value.value)}"`);
      const uid = options.refForNode ? options.refForNode(node) : uidOf(node);
      if (uid) parts.push(`[uid=${uid}]`);
      if (parts.length) {
        lines.push(`${"  ".repeat(depth)}- ${parts.join(" ")}`);
        emitted++;
      }
    }
    for (const child of node.childIds ?? [])
      walk(child, interesting ? depth + 1 : depth);
  };
  for (const node of nodes)
    if (!referenced.has(node.nodeId)) walk(node.nodeId, 0);
  return { tree: lines.join("\n"), totalNodes, emitted, truncated };
};
