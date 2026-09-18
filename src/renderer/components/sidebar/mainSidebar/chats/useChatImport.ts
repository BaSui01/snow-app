import { useCallback, useRef, useState } from "react";

import type { ConversationImportProgress } from "../../../../../preload";
import { useI18n } from "../../../../i18n";

type UseChatImportOptions = {
  directoryId: string;
  refreshConversations: () => void;
};

export type ChatImportNoticeTone = "success" | "error" | "warning";

export type ChatImportNotice = {
  message: string;
  tone: ChatImportNoticeTone;
};

export function useChatImport({
  directoryId,
  refreshConversations,
}: UseChatImportOptions) {
  const { t } = useI18n();
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState<ConversationImportProgress | null>(
    null,
  );
  const [notice, setNotice] = useState<ChatImportNotice | null>(null);
  const isImportingRef = useRef(false);

  const dismissNotice = useCallback((): void => setNotice(null), []);

  const handleImportConversations = useCallback(async (): Promise<void> => {
    if (isImportingRef.current || !directoryId) {
      return;
    }

    let filePaths: string[] = [];
    try {
      filePaths = await window.snow.pickConversationImportFiles();
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("sidebar.chatImportFailed", {
                defaultValue: "Failed to import conversations",
              }),
        tone: "error",
      });
      return;
    }

    if (filePaths.length === 0) {
      return;
    }

    isImportingRef.current = true;
    setIsImporting(true);
    setNotice(null);
    setProgress({
      processed: 0,
      total: filePaths.length,
      fileName: "",
      success: true,
      error: null,
    });

    try {
      const summary = await window.snow.importConversations(
        directoryId,
        filePaths,
        setProgress,
      );
      refreshConversations();

      if (summary.failedCount === 0) {
        setNotice({
          message: t("sidebar.chatImportDone", {
            defaultValue: "Imported {{count}} conversation(s)",
            values: { count: summary.importedCount },
          }),
          tone: "success",
        });
      } else {
        setNotice({
          message: t("sidebar.chatImportPartial", {
            defaultValue: "Imported {{imported}}, {{failed}} file(s) failed",
            values: {
              imported: summary.importedCount,
              failed: summary.failedCount,
            },
          }),
          tone: "warning",
        });
      }
    } catch (error) {
      setNotice({
        message:
          error instanceof Error
            ? error.message
            : t("sidebar.chatImportFailed", {
                defaultValue: "Failed to import conversations",
              }),
        tone: "error",
      });
    } finally {
      isImportingRef.current = false;
      setIsImporting(false);
      setProgress(null);
    }
  }, [directoryId, refreshConversations, t]);

  return {
    isImporting,
    progress,
    notice,
    dismissNotice,
    handleImportConversations,
  };
}