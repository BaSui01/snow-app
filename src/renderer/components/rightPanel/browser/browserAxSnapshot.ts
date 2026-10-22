import {
  axBackendNodeId,
  serializeAxTree,
  type AxNode,
  type AxSnapshotResult,
} from "../../../../shared/browserAxSnapshot";

export type { AxNode } from "../../../../shared/browserAxSnapshot";

/**
 * 无障碍快照 ref 注册表（issue #251）：ref 按「标签页 + 文档代际」隔离。
 * - 同一文档内多次快照复用同一 ref（同一 backendNodeId 得到同一 uid）；
 * - 主 frame 跨文档导航（含重载）会作废该标签页的全部 ref，快照发现文档根节点
 *   已更换时同样开启新代际；
 * - 代际号全局递增并编码进 uid（e<代际>-<序号>），其他标签页或旧文档的 ref
 *   一律拒绝，不会静默解析到新文档里的另一个节点。
 */
type AxRefScope = {
  generation: number;
  documentBackendId: number;
  nextIndex: number;
  uidByBackend: Map<number, string>;
  backendByUid: Map<string, number>;
};

export type AxRefTarget = {
  backendNodeId: number;
  /** 快照时主文档节点的 backendNodeId，解析时用于确认目标仍属于该文档。 */
  documentBackendId: number;
};

const AX_REF_PATTERN = /^e(\d+)-\d+$/;
const scopes = new Map<string, AxRefScope>();
let generationCounter = 0;

/** 主 frame 跨文档导航、重载或实例卸载时作废该标签页的全部 ref。 */
export const invalidateAxRefs = (instanceId: string): void => {
  scopes.delete(instanceId);
};

/** 序列化主 frame 无障碍树，并按标签页 + 文档代际分配 ref。 */
export const snapshotAxTree = (
  instanceId: string,
  nodes: AxNode[],
  options: { verbose: boolean; maxNodes: number },
): AxSnapshotResult => {
  const root =
    nodes.find((node) => node.role?.value === "RootWebArea") ?? nodes[0];
  const documentBackendId = root ? axBackendNodeId(root) : null;
  if (documentBackendId === null) {
    throw new Error(
      "Accessibility tree has no document root; wait for the page to load and retry",
    );
  }
  let scope = scopes.get(instanceId);
  if (!scope || scope.documentBackendId !== documentBackendId) {
    scope = {
      generation: ++generationCounter,
      documentBackendId,
      nextIndex: 0,
      uidByBackend: new Map(),
      backendByUid: new Map(),
    };
    scopes.set(instanceId, scope);
  }
  const active = scope;
  const rootFrameId = root?.frameId;
  return serializeAxTree(nodes, {
    ...options,
    refForNode: (node) => {
      const backend = axBackendNodeId(node);
      // 只为主文档节点分配 ref；子 frame 节点需经 browser-frames 的帧快照操作。
      if (
        backend === null ||
        (rootFrameId && node.frameId && node.frameId !== rootFrameId)
      ) {
        return null;
      }
      let uid = active.uidByBackend.get(backend);
      if (!uid) {
        uid = `e${active.generation}-${++active.nextIndex}`;
        active.uidByBackend.set(backend, uid);
        active.backendByUid.set(uid, backend);
      }
      return uid;
    },
  });
};

/** ref → backendNodeId；代际不符（导航/重载/其他标签页）或未登记时抛出明确错误。 */
export const resolveAxRef = (instanceId: string, ref: string): AxRefTarget => {
  const match = AX_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error(
      `Ref ${ref} is not a valid accessibility uid. Use a [uid=...] value from the latest browser-devtools action=ax snapshot of this tab.`,
    );
  }
  const scope = scopes.get(instanceId);
  if (!scope || scope.generation !== Number(match[1])) {
    throw new Error(
      `Ref ${ref} is stale: it belongs to an earlier document (the page navigated or reloaded since that snapshot) or to another browser tab. Capture a new accessibility snapshot (browser-devtools action=ax) of this tab first.`,
    );
  }
  const backendNodeId = scope.backendByUid.get(ref);
  if (backendNodeId === undefined) {
    throw new Error(
      `Ref ${ref} is not in the current snapshot of this tab. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
    );
  }
  return { backendNodeId, documentBackendId: scope.documentBackendId };
};
