import { useEffect, useRef, useState } from "react";
import type { PluginChatInputActionResult } from "../../../plugins/pluginChatInputAction";
import type { Locale } from "../../../i18n";

const LABELS = {
  en: {
    review: "Review project sources",
    continue: "Continue with selected sources",
    without: "Continue without code",
    source: "Read-only source preview",
    warnings: "Warnings",
    reason: "Context outcome",
    unavailable: "Source preview unavailable",
  },
  "zh-CN": {
    review: "审阅项目来源",
    continue: "使用所选来源继续",
    without: "不带代码继续",
    source: "只读代码预览",
    warnings: "注意事项",
    reason: "上下文结果",
    unavailable: "代码预览不可用",
  },
  "zh-TW": {
    review: "審閱專案來源",
    continue: "使用所選來源繼續",
    without: "不帶程式碼繼續",
    source: "唯讀程式碼預覽",
    warnings: "注意事項",
    reason: "上下文結果",
    unavailable: "程式碼預覽不可用",
  },
};
const CONTEXT_LABELS: Record<string, readonly [string, string, string]> = {
  used: ["Used", "已使用", "已使用"],
  skipped: ["Skipped", "已跳过", "已略過"],
  degraded: ["Degraded", "已降级", "已降級"],
  review_required: ["Review required", "等待来源审核", "等待來源審核"],
  fresh: ["Fresh", "最新", "最新"],
  stale: ["Stale", "已过期", "已過期"],
  indexing: ["Indexing", "正在索引", "正在索引"],
  unknown: ["Unknown", "未知", "未知"],
  unavailable: ["Unavailable", "不可用", "無法使用"],
  exact: ["Exact", "精确匹配", "精確比對"],
  semantic: ["Semantic", "语义匹配", "語意比對"],
  mixed: ["Mixed", "混合匹配", "混合比對"],
  none: ["None", "无", "無"],
  sources_selected: ["Selected sources", "已选择来源", "已選擇來源"],
  not_code_related: ["Not code related", "非代码相关请求", "非程式碼相關請求"],
  authorization_required: [
    "Authorization required",
    "需要项目授权",
    "需要專案授權",
  ],
  project_index_disabled: [
    "Project index disabled",
    "项目索引已关闭",
    "專案索引已關閉",
  ],
  no_project: [
    "No project bound; optimized without project code",
    "未绑定项目，已不带项目代码优化",
    "未繫結專案，已不帶專案程式碼優化",
  ],
  history_omitted_no_project_binding: [
    "History omitted because no project binding was available",
    "无可验证项目绑定，已省略历史消息",
    "無可驗證專案繫結，已省略歷史訊息",
  ],
  project_root_unavailable: [
    "Project root unavailable",
    "项目目录不可用",
    "專案目錄無法使用",
  ],
  index_empty: ["Index empty", "项目索引为空", "專案索引為空"],
  index_unavailable: [
    "Index unavailable",
    "项目索引不可用",
    "專案索引無法使用",
  ],
  context_tool_disabled: [
    "Codebase tool disabled",
    "代码检索工具已禁用",
    "程式碼檢索工具已停用",
  ],
  worktree_index_unavailable: [
    "Worktree index unavailable",
    "工作树索引不可用",
    "工作樹索引無法使用",
  ],
  remote_project_unsupported: [
    "Remote project unsupported",
    "暂不支持远程项目",
    "暫不支援遠端專案",
  ],
  index_model_or_dimension_mismatch: [
    "Index model or dimension mismatch",
    "索引模型或维度不匹配",
    "索引模型或維度不符",
  ],
  context_source_changed: [
    "Source changed",
    "来源文件已改变",
    "來源檔案已變更",
  ],
  context_authorization_changed: [
    "Authorization changed",
    "授权配置已改变",
    "授權設定已變更",
  ],
  context_index_changed: ["Index changed", "项目索引已改变", "專案索引已變更"],
  context_handle_expired: [
    "Review expired",
    "来源审核已过期",
    "來源審核已過期",
  ],
  planner_unavailable: [
    "Planner unavailable; local search retained",
    "查询规划不可用，保留本地检索",
    "查詢規劃無法使用，保留本機檢索",
  ],
  embedding_unavailable: [
    "Embedding unavailable; exact search retained",
    "嵌入服务不可用，保留精确检索",
    "嵌入服務無法使用，保留精確檢索",
  ],
  reranking_unavailable: [
    "Reranking unavailable; original ranking retained",
    "重排不可用，保留原始排序",
    "重排無法使用，保留原始排序",
  ],
  embedding_dimension_mismatch: [
    "Embedding dimension mismatch",
    "嵌入维度不匹配",
    "嵌入維度不符",
  ],
  index_model_mismatch: [
    "Index model mismatch",
    "索引模型不匹配",
    "索引模型不符",
  ],
  ambiguous_source_name: [
    "Ambiguous source name; verify the path",
    "存在同名来源，请核对路径",
    "存在同名來源，請核對路徑",
  ],
  no_relevant_sources: ["No relevant sources", "没有相关来源", "沒有相關來源"],
  source_review_required: [
    "Review sources before sending code",
    "发送代码前请审核来源",
    "傳送程式碼前請審核來源",
  ],
  bounded_project_context: [
    "Bounded project context",
    "已附加预算内的项目上下文",
    "已附加預算內的專案上下文",
  ],
  sources_found: ["Sources found", "已找到相关来源", "已找到相關來源"],
};
const contextLabel = (value: string, locale: Locale): string =>
  CONTEXT_LABELS[value]?.[locale === "en" ? 0 : locale === "zh-CN" ? 1 : 2] ??
  value;
export const PromptContextReview = ({
  result,
  locale,
  disabled,
  isCurrent,
  apply,
}: {
  result: PluginChatInputActionResult;
  locale: Locale;
  disabled: boolean;
  isCurrent: () => boolean;
  apply: (ids: string[]) => void;
}): React.JSX.Element => {
  const labels = LABELS[locale];
  const selection = result.sourceSelection;
  const [selected, setSelected] = useState<string[]>(
    selection?.defaultSelectedIds ?? [],
  );
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const previewRequest = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    previewRequest.current += 1;
    setSelected(selection?.defaultSelectedIds ?? []);
    setPreview("");
    setLoading(false);
    return () => {
      previewRequest.current += 1;
    };
  }, [selection]);
  const show = async (sourceId: string): Promise<void> => {
    if (disabled || !isCurrent() || !selection) return;
    const request = ++previewRequest.current;
    const current = (): boolean =>
      request === previewRequest.current &&
      selectionRef.current === selection &&
      isCurrent();
    setLoading(true);
    try {
      const text = await window.snow.getPromptContextSourcePreview(
        selection.contextHandle,
        sourceId,
      );
      if (current()) setPreview(text);
    } catch {
      if (current()) setPreview(labels.unavailable);
    } finally {
      if (current()) setLoading(false);
    }
  };
  const report = result.details?.contextReport;
  const warnings = [
    ...new Set(
      [...(result.details?.warnings ?? []), ...(report?.warnings ?? [])].map(
        (value) => contextLabel(value, locale),
      ),
    ),
  ];
  // Only the review-required flow keeps an element in the toolbar; an ordinary
  // optimization result must not add any persistent input-area affordance.
  if (!selection) return <></>;
  return (
    <details open>
      <summary style={{ cursor: "pointer", fontSize: 12 }}>
        {labels.review}
      </summary>
      <div
        style={{
          position: "absolute",
          bottom: "100%",
          right: 0,
          width: "min(600px, 85vw)",
          maxHeight: "65vh",
          overflow: "auto",
          padding: 12,
          background: "var(--bg-secondary, Canvas)",
          color: "var(--text-primary, CanvasText)",
          border: "1px solid currentColor",
          borderRadius: 8,
          zIndex: 31,
        }}
      >
        {report && (
          <p>
            {labels.reason}: {contextLabel(report.outcome, locale)} —{" "}
            {contextLabel(report.reason, locale)}
            <br />
            {contextLabel(report.indexState, locale)} /{" "}
            {contextLabel(report.queryKind, locale)} / {report.characters} /{" "}
            {report.elapsedMs} ms
            {report.cacheHit && (
              <span>
                {" "}
                ·{" "}
                {locale === "en"
                  ? "Cache hit"
                  : locale === "zh-CN"
                    ? "命中缓存"
                    : "命中快取"}
              </span>
            )}
            {report.truncated && (
              <span>
                {" "}
                ·{" "}
                {locale === "en"
                  ? "Budget truncated"
                  : locale === "zh-CN"
                    ? "已按预算截断"
                    : "已按預算截斷"}
              </span>
            )}
          </p>
        )}
        {warnings.length > 0 && (
          <div role="status">
            <strong>{labels.warnings}</strong>
            <ul>
              {warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        {selection && (
          <>
            <ul style={{ listStyle: "none", padding: 0 }}>
              {selection.sources.map((source) => (
                <li key={source.id}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selected.includes(source.id)}
                      onChange={(event) => {
                        if (isCurrent())
                          setSelected((ids) =>
                            event.target.checked
                              ? [...ids, source.id]
                              : ids.filter((id) => id !== source.id),
                          );
                      }}
                    />{" "}
                    {source.path}:{source.startLine}–{source.endLine} (
                    {contextLabel(source.matchKind, locale)},{" "}
                    {contextLabel(source.freshness, locale)},{" "}
                    {source.characters})
                  </label>
                  <button
                    type="button"
                    className="toolbar-btn"
                    disabled={disabled || loading}
                    onClick={() => {
                      void show(source.id);
                    }}
                  >
                    {labels.source}
                  </button>
                </li>
              ))}
            </ul>
            {preview && (
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 240,
                  overflow: "auto",
                }}
              >
                {preview}
              </pre>
            )}
            <button
              type="button"
              className="toolbar-btn"
              disabled={disabled}
              onClick={() => {
                if (isCurrent()) apply(selected);
              }}
            >
              {labels.continue}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              disabled={disabled}
              onClick={() => {
                if (isCurrent()) apply([]);
              }}
            >
              {labels.without}
            </button>
          </>
        )}
      </div>
    </details>
  );
};
