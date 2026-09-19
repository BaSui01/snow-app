import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Loader2,
  MessageSquare,
  Minimize2,
} from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { useI18n } from "../../../i18n";
import { ContentChips } from "./ContentChips";
import type { ContentSegment } from "./fileTagUtils";

/** 回滚目标条目：用户真实消息与压缩摘要消息（isContextCompaction）。 */
export type RollbackTargetItem = {
  id: string;
  /** 该消息在会话中的正序序号（1 起），仅用于展示定位。 */
  ordinal: number;
  /** 预览片段：文本 + chip（与消息区同款渲染）。 */
  segments: ContentSegment[];
  /** 单行纯文本预览（列表项 tooltip 用）。 */
  preview: string;
  /** true 表示这条是上下文压缩摘要（回滚边界为摘要行自身）。 */
  isContextCompaction: boolean;
};

type RollbackTargetPopupProps = {
  visible: boolean;
  /** 倒序排列（最新在最上）。 */
  targets: RollbackTargetItem[];
  selectedIndex: number;
  /** 全量历史仍在读取中（列表先以内存窗口预览）。 */
  isLoadingTargets: boolean;
  /** 正在把该目标加载进内存窗口（行内 loading）。 */
  preparingMessageId: string | null;
  /** 目标过旧无法加载时的提示。 */
  loadError: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onSelect: (messageId: string) => void;
};

/**
 * 回滚目标列表（双击 ESC 打开，渲染在输入框上方）。
 *
 * 只负责渲染与滚动定位：键盘接管（↑/↓/Enter/Esc）与跨页加载由
 * useRollbackPicker 在输入框的 keydown 链上完成，鼠标点击直接触发回滚确认。
 */
export const RollbackTargetPopup = ({
  visible,
  targets,
  selectedIndex,
  isLoadingTargets,
  preparingMessageId,
  loadError,
  containerRef,
  onSelect,
}: RollbackTargetPopupProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  // 列表中消息数变化时收敛选中项，避免选中位置悬空。
  const activeIndex = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(targets.length - 1, 0),
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    const container = listRef.current;
    if (!container) {
      return;
    }
    const selected = container.querySelector<HTMLElement>(
      `[data-rollback-index="${activeIndex}"]`,
    );
    if (!selected) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const itemRect = selected.getBoundingClientRect();
    if (itemRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - itemRect.top;
    } else if (itemRect.bottom > containerRect.bottom) {
      container.scrollTop += itemRect.bottom - containerRect.bottom;
    }
  }, [activeIndex, visible]);

  if (!visible) {
    return null;
  }

  // 全量清单读取中，或正在把选中的目标跨页加载进内存窗口：头部显示 loading，
  // 避免长会话里等待翻页时看起来像卡住。
  const isBusy = isLoadingTargets || preparingMessageId !== null;

  return (
    <div
      className="rollback-picker-popup"
      ref={containerRef}
      data-esc-panel
      aria-label={t("rollbackPicker.title")}
    >
      <div className="rollback-picker-header">
        <span className="rollback-picker-title">
          {t("rollbackPicker.title")}
        </span>
        <span className="rollback-picker-count">
          {isBusy ? (
            <>
              <Loader2 className="spin" size={11} aria-hidden="true" />
              {t("rollbackPicker.loading")}
            </>
          ) : (
            t("rollbackPicker.count", { values: { count: targets.length } })
          )}
        </span>
      </div>
      <div
        className="rollback-picker-list"
        ref={listRef}
        role="listbox"
        aria-label={t("rollbackPicker.title")}
      >
        {targets.length === 0 ? (
          // 历史尚未读取完成 / 会话确实还没有可回滚的消息：给出明确状态，
          // 而不是一个空面板。
          <div className="rollback-picker-empty">
            {isLoadingTargets ? (
              <>
                <Loader2 className="spin" size={14} aria-hidden="true" />
                <span>{t("rollbackPicker.loading")}</span>
              </>
            ) : (
              <span>{t("rollbackPicker.empty")}</span>
            )}
          </div>
        ) : (
          targets.map((target, index) => {
            const isPreparing = preparingMessageId === target.id;
            return (
              <div
                key={target.id}
                data-rollback-index={index}
                className={`rollback-picker-item${
                  index === activeIndex ? " selected" : ""
                }${isPreparing ? " is-preparing" : ""}`}
                role="option"
                aria-selected={index === activeIndex}
                title={target.preview}
                onClick={() => onSelect(target.id)}
              >
                <span className="rollback-picker-ordinal">
                  #{target.ordinal}
                </span>
                {isPreparing ? (
                  <Loader2
                    size={13}
                    className="rollback-picker-icon spin"
                    aria-hidden="true"
                  />
                ) : target.isContextCompaction ? (
                  <Minimize2
                    size={13}
                    className="rollback-picker-icon"
                    aria-hidden="true"
                  />
                ) : (
                  <MessageSquare
                    size={13}
                    className="rollback-picker-icon"
                    aria-hidden="true"
                  />
                )}
                <span className="rollback-picker-preview">
                  <ContentChips segments={target.segments} />
                </span>
                {target.isContextCompaction ? (
                  <span className="rollback-picker-badge">
                    {t("rollbackPicker.compactionBadge")}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {loadError ? (
        <div className="rollback-picker-error" role="alert">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{loadError}</span>
        </div>
      ) : null}
      <div className="rollback-picker-footer">
        <span className="rollback-picker-hint">
          <kbd className="rollback-kbd-icon">
            <ArrowUp size={10} />
          </kbd>
          <kbd className="rollback-kbd-icon">
            <ArrowDown size={10} />
          </kbd>{" "}
          {t("rollbackPicker.navigate")}
        </span>
        <span className="rollback-picker-hint">
          <kbd>Enter</kbd> {t("rollbackPicker.confirm")}
        </span>
        <span className="rollback-picker-hint">
          <kbd>Esc</kbd> {t("rollbackPicker.close")}
        </span>
      </div>
    </div>
  );
};
