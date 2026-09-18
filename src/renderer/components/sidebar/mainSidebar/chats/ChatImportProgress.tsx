import { Loader2 } from "lucide-react";

import type { ConversationImportProgress } from "../../../../../preload";
import { useI18n } from "../../../../i18n";

type ChatImportProgressProps = {
  progress: ConversationImportProgress | null;
};

export function ChatImportProgress({
  progress,
}: ChatImportProgressProps): React.JSX.Element | null {
  const { t } = useI18n();

  if (!progress) {
    return null;
  }

  const percent =
    progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  return (
    <div className="chat-import-progress" role="status">
      <div className="chat-import-progress-text">
        <Loader2 className="spin" size={12} />
        <span>
          {t("sidebar.chatImportProgress", {
            defaultValue: "Importing {{current}}/{{total}}",
            values: {
              current: progress.processed,
              total: progress.total,
            },
          })}
        </span>
        {progress.fileName ? (
          <span className="chat-import-progress-file">{progress.fileName}</span>
        ) : null}
      </div>
      <div className="chat-import-progress-track">
        <div
          className="chat-import-progress-bar"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}