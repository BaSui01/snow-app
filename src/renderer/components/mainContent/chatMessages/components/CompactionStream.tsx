import { useLayoutEffect, useRef } from "react";
import { AlertCircle, Minimize2 } from "lucide-react";
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
        <div className="context-compaction-error" role="alert">
          <AlertCircle size={14} />
          <span>
            {t("chat.compactionFailed")}: {compactionError}
          </span>
        </div>
      ) : null}
    </>
  );
};
