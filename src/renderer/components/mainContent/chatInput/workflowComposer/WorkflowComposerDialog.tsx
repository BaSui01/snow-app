// 聊天输入区 WorkFlow 手动编排器弹窗。
//
// 复用定时任务工作流画布（variant="chat"）作为手动画布：用户自己绘制节点与
// 连线、填写节点提示词与模型，点「发送」后编排图随本条消息进入当前会话的
// WorkFlow 流程（由既有 WorkFlow 卡片确认执行）。本组件只负责画布宿主、流程名
// 与备注输入、发送前校验与载荷转换，不直接发起任何 AI 调用。

import { Loader2, Send, X } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  ApiConfigRecord,
  ScheduledTaskWorkflow,
  ScheduledTaskWorkflowNode,
} from "../../../../../preload";
import { useI18n } from "../../../../i18n";
import { Modal } from "../../../common/Modal";
import {
  ScheduledTaskWorkflowCanvas,
  type ScheduledTaskWorkflowCanvasHandle,
} from "../../../sidebar/scheduledTasks/ScheduledTaskWorkflowCanvas";
import type { WorkflowComposerGraph } from "../types";

type Translate = ReturnType<typeof useI18n>["t"];

export type WorkflowComposerDialogProps = {
  open: boolean;
  onClose: () => void;
  apiConfigs: ApiConfigRecord[];
  /** 发送：graph 为编排图，note 为用户备注（可为空字符串）。会话正在运行时
   *  不在这里拦截：发送链路按既有排队语义暂存本回合（编排图随 options 入队，
   *  队列冲刷时用同一张图重建载荷），因此无需禁用发送。 */
  onSend: (graph: WorkflowComposerGraph, note: string) => void;
};

/** 编排器自建节点的 id：时间戳 + 随机后缀，同一张图内唯一且稳定。 */
const createComposerNodeId = (): string =>
  `wf-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * 打开弹窗时的初始图：交接上下文、连线延时恒为 0、预置一个空节点（提示词留空，
 * 由用户填写）。预置节点让画布一打开就有可编辑对象，节点 id 由编排器生成。
 */
const createEmptyWorkflow = (t: Translate): ScheduledTaskWorkflow => ({
  contextMode: "handoff",
  nodes: [
    {
      id: createComposerNodeId(),
      label: t("scheduledTask.workflow.newNodeName", {
        values: { index: 1 },
        defaultValue: "Step 1",
      }),
      prompt: "",
      position: { x: 80, y: 120 },
    },
  ],
  edges: [],
});

/** 拓扑校验的节点 JSON 形状（与 Rust validate_graph 的入参口径一致）。 */
const toValidationNodes = (
  nodes: ScheduledTaskWorkflowNode[],
): {
  id: string;
  name: string;
  label: string;
  prompt: string;
  description: string;
  apiProfile: string;
  model: string;
}[] =>
  nodes.map((node) => ({
    id: node.id,
    name: node.label || node.id,
    label: node.label,
    prompt: node.prompt,
    description: "",
    apiProfile: node.apiProfile ?? "",
    model: node.model ?? "",
  }));

/**
 * 画布图 → 发送契约图：字段逐项映射（可选字段缺省空串），边只保留两端都在
 * 节点集合内的（与 workflowRunner.parseWorkflowGraph 的防御口径一致）。
 */
const toComposerGraph = (
  workflow: ScheduledTaskWorkflow,
  title: string,
): WorkflowComposerGraph => {
  const nodes = workflow.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    prompt: node.prompt,
    apiProfile: node.apiProfile ?? "",
    model: node.model ?? "",
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = workflow.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }));
  return { title: title.trim(), nodes, edges };
};

export function WorkflowComposerDialog({
  open,
  onClose,
  apiConfigs,
  onSend,
}: WorkflowComposerDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const canvasRef = useRef<ScheduledTaskWorkflowCanvasHandle>(null);
  const [workflow, setWorkflow] = useState<ScheduledTaskWorkflow>(() =>
    createEmptyWorkflow(t),
  );
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 每次打开都重置为初始值：画布不保留上一次绘制的图，流程名/备注/错误一并清空。
  useEffect(() => {
    if (!open) return;
    setWorkflow(createEmptyWorkflow(t));
    setTitle("");
    setNote("");
    setError(null);
    setIsSubmitting(false);
  }, [open, t]);

  /**
   * ESC 语义：先让画布关掉自己的浮层（节点/连线编辑、放大视图），画布没有浮层
   * 时才关弹窗。本包装层在 Modal 对话框内部，冒泡早于 Modal 的 closeOnEscape
   * 处理，因此在这里吞掉事件即可实现「浮层优先」。
   */
  const handleContentKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Escape") return;
      if (canvasRef.current?.closeOverlay()) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [],
  );

  const handleSend = useCallback(async (): Promise<void> => {
    // 校验顺序：① 至少一个节点且至少一个节点提示词非空；② Rust 拓扑/环校验。
    if (workflow.nodes.length === 0) {
      setError(t("workflowComposer.invalidNoNode"));
      return;
    }
    if (!workflow.nodes.some((node) => node.prompt.trim())) {
      setError(t("workflowComposer.invalidEmptyPrompt"));
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const result = await window.snow.validateWorkflowGraph(
        JSON.stringify(toValidationNodes(workflow.nodes)),
        JSON.stringify(
          workflow.edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
          })),
        ),
      );
      if (result.errors.length > 0) {
        setError(
          t("workflowComposer.invalidGraph", {
            values: { reason: result.errors[0] },
          }),
        );
        return;
      }
    } catch {
      // 校验桥不可用时放行：Rust 端在 workflow-generate 时会再校验一次拓扑。
    } finally {
      setIsSubmitting(false);
    }

    onSend(toComposerGraph(workflow, title), note);
  }, [note, onSend, t, title, workflow]);

  return (
    <Modal
      className="workflow-composer-modal"
      closeLabel={t("workflowComposer.close")}
      // ESC 交给弹窗处理，但画布内浮层优先（见 handleContentKeyDown）。
      closeOnEscape
      description={t("workflowComposer.subtitle")}
      footer={
        <>
          <button
            className="api-settings-form-btn secondary"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            <X size={15} strokeWidth={1.9} />
            <span>{t("workflowComposer.cancel")}</span>
          </button>
          <button
            className="api-settings-form-btn primary"
            disabled={isSubmitting}
            onClick={() => void handleSend()}
            type="button"
          >
            {isSubmitting ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Send size={15} strokeWidth={1.9} />
            )}
            <span>{t("workflowComposer.send")}</span>
          </button>
        </>
      }
      onClose={onClose}
      open={open}
      size="large"
      title={t("workflowComposer.title")}
    >
      <div className="workflow-composer-body" onKeyDown={handleContentKeyDown}>
        <div className="api-settings-field">
          <input
            disabled={isSubmitting}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("workflowComposer.titlePlaceholder")}
            type="text"
            value={title}
          />
        </div>
        <div className="workflow-composer-canvas">
          <ScheduledTaskWorkflowCanvas
            ref={canvasRef}
            apiConfigs={apiConfigs}
            onChange={setWorkflow}
            value={workflow}
            variant="chat"
          />
        </div>
        {workflow.nodes.length === 0 && (
          <p className="workflow-composer-hint">
            {t("workflowComposer.emptyHint")}
          </p>
        )}
        <div className="api-settings-field">
          <textarea
            className="api-settings-field-textarea workflow-composer-note"
            disabled={isSubmitting}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("workflowComposer.notePlaceholder")}
            rows={2}
            value={note}
          />
        </div>
        {error && <p className="workflow-composer-error">{error}</p>}
      </div>
    </Modal>
  );
}
