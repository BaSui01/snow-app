import { useLayoutEffect, useRef } from "react";
import { Minimize2, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { MarkdownBlock } from "./markdownRenderer";

type CompactionStreamProps = {
  isCompacting: boolean;
  compactionPreview: string;
  compactionError: string | null;
};

export const CompactionStream = ({
  isCompacting,
  compactionPreview,
  compactionError,
}: CompactionStreamProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const compactionStreamRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (compactionStreamRef.current) {
      compactionStreamRef.current.scrollTop =
        compactionStreamRef.current.scrollHeight;
    }
  }, [compactionPreview]);

  if (!isCompacting && !compactionError) {
    return null;
  }

  return (
    <>
      {isCompacting ? (
        <section className="context-compaction-stream" aria-live="polite">
          <header className="context-compaction-stream-title">
            <span className="context-compaction-stream-icon" aria-hidden="true">
              <Minimize2 size={15} strokeWidth={1.9} />
            </span>
            <span className="context-compaction-stream-heading">
              {t("chat.compactionGenerating")}
            </span>
          </header>
          <div
            className="context-compaction-stream-body"
            ref={compactionStreamRef}
          >
            {compactionPreview ? (
              <MarkdownBlock
                className="context-compaction-markdown"
                content={compactionPreview}
                streaming={isCompacting}
              />
            ) : (
              <div className="context-compaction-placeholder">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </section>
      ) : null}
      {compactionError ? (
        // 压缩失败提示：与「上下文摘要」同一条横线样式，弱化呈现（警告色 +
        // 小字 + 两侧细线），不打断阅读；文案由 performCompaction 组装。
        <div className="context-compaction-notice" role="alert">
          <span className="context-compaction-notice-rule" aria-hidden="true" />
          <span
            className="context-compaction-notice-label"
            title={compactionError}
          >
            <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="context-compaction-notice-text">
              {compactionError}
            </span>
          </span>
          <span className="context-compaction-notice-rule" aria-hidden="true" />
        </div>
      ) : null}
    </>
  );
};
