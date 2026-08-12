import {
  AlertCircle,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";

type ProjectPermissionsPanelProps = {
  open: boolean;
  projectId?: string;
  projectName?: string;
  onClose: () => void;
};

export const ProjectPermissionsPanel = ({
  open,
  projectId,
  projectName,
  onClose,
}: ProjectPermissionsPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolPendingDeletion, setToolPendingDeletion] = useState<string | null>(
    null
  );
  const [pendingToolNames, setPendingToolNames] = useState<Set<string>>(
    () => new Set()
  );
  const pendingToolGenerationsRef = useRef<Map<string, number>>(new Map());
  const loadGenerationRef = useRef(0);

  const loadToolNames = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    pendingToolGenerationsRef.current.clear();
    setPendingToolNames(new Set());
    setToolNames([]);
    setToolPendingDeletion(null);
    setError(null);

    if (!projectId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const nextToolNames =
        await window.snow.listToolApprovalProjectApprovedTools(projectId);
      if (loadGenerationRef.current === generation) {
        setToolNames(nextToolNames);
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (open) {
      void loadToolNames();
      return;
    }

    loadGenerationRef.current += 1;
    pendingToolGenerationsRef.current.clear();
    setPendingToolNames(new Set());
    setIsLoading(false);
    setToolPendingDeletion(null);
  }, [loadToolNames, open]);

  const deleteToolApproval = useCallback(
    async (toolName: string): Promise<void> => {
      if (
        !projectId ||
        pendingToolGenerationsRef.current.has(toolName) ||
        pendingToolNames.has(toolName)
      ) {
        return;
      }

      const generation = loadGenerationRef.current;
      const operationProjectId = projectId;
      pendingToolGenerationsRef.current.set(toolName, generation);
      setPendingToolNames((current) => new Set(current).add(toolName));
      setError(null);
      try {
        await window.snow.setToolApprovalProjectToolApproved(
          operationProjectId,
          toolName,
          false
        );
        if (loadGenerationRef.current === generation) {
          setToolNames((current) => current.filter((name) => name !== toolName));
        }
      } catch (deleteError) {
        if (loadGenerationRef.current === generation) {
          setError(
            deleteError instanceof Error ? deleteError.message : String(deleteError)
          );
        }
      } finally {
        if (pendingToolGenerationsRef.current.get(toolName) === generation) {
          pendingToolGenerationsRef.current.delete(toolName);
          setPendingToolNames((current) => {
            const next = new Set(current);
            next.delete(toolName);
            return next;
          });
        }
      }
    },
    [projectId, pendingToolNames]
  );

  const confirmDeleteTool = (): void => {
    if (!toolPendingDeletion) {
      return;
    }
    const toolName = toolPendingDeletion;
    setToolPendingDeletion(null);
    void deleteToolApproval(toolName);
  };

  return (
    <>
      <Modal
        className="project-sensitive-command-modal"
        closeLabel={t("projectPermissions.close")}
        description={
          projectId
            ? t("projectPermissions.description", {
                values: { project: projectName || projectId },
              })
            : t("projectPermissions.noProject")
        }
        onClose={onClose}
        open={open}
        size="large"
        title={t("projectPermissions.title")}
      >
        {!projectId ? (
          <div className="project-sensitive-command-state">
            <AlertCircle size={18} />
            <span>{t("projectPermissions.noProject")}</span>
          </div>
        ) : isLoading && toolNames.length === 0 ? (
          <div className="project-sensitive-command-state">
            <Loader2 className="spin" size={18} />
            <span>{t("projectPermissions.loading")}</span>
          </div>
        ) : (
          <>
            <div className="project-sensitive-command-toolbar">
              <div>
                <span>{t("projectPermissions.scopeNote")}</span>
                <small>
                  {t("projectPermissions.count", {
                    values: { count: toolNames.length },
                  })}
                </small>
              </div>
              <div>
                <button
                  className="project-sensitive-command-toolbar-btn"
                  disabled={isLoading || pendingToolNames.size > 0}
                  onClick={() => void loadToolNames()}
                  type="button"
                >
                  <RefreshCw className={isLoading ? "spin" : ""} size={14} />
                  <span>{t("projectPermissions.refresh")}</span>
                </button>
              </div>
            </div>

            {error ? (
              <div className="project-sensitive-command-error">
                <AlertCircle size={15} />
                <span>{error}</span>
              </div>
            ) : null}

            {toolNames.length === 0 ? (
              <div className="project-sensitive-command-empty">
                {t("projectPermissions.empty")}
              </div>
            ) : (
              <div className="project-sensitive-command-groups">
                <div className="project-sensitive-command-list">
                  {toolNames.map((toolName) => (
                    <article
                      className="project-sensitive-command-row is-enabled"
                      key={toolName}
                    >
                      <ShieldCheck size={15} />
                      <div className="project-sensitive-command-content">
                        <div>
                          <code>{toolName}</code>
                        </div>
                        <span>{t("projectPermissions.approved")}</span>
                      </div>
                      <div className="project-sensitive-command-actions">
                        <button
                          aria-label={t("projectPermissions.delete")}
                          className="icon-btn ghost danger"
                          disabled={pendingToolNames.has(toolName)}
                          onClick={() => setToolPendingDeletion(toolName)}
                          title={t("projectPermissions.delete")}
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Modal>
      <ConfirmDialog
        cancelLabel={t("settings.cancel")}
        confirmLabel={t("settings.delete")}
        message={t("projectPermissions.deleteConfirm", {
          values: { toolName: toolPendingDeletion ?? "" },
        })}
        onCancel={() => setToolPendingDeletion(null)}
        onConfirm={confirmDeleteTool}
        open={toolPendingDeletion !== null}
        title={t("projectPermissions.deleteTitle")}
        variant="danger"
      />
    </>
  );
};
