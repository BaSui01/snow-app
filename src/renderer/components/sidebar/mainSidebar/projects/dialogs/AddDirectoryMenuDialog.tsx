import { Folder, FolderPlus, GitFork, Library, Server } from "lucide-react";

import { useI18n } from "../../../../../i18n";
import { FormDialog } from "../../../../common/FormDialog";

type AddDirectoryMenuDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreateProject: () => void;
  onAddLocalDirectory: () => void;
  onCloneRepository: () => void;
  onAddSshDirectory: () => void;
  onCreateCollection: () => void;
};

export function AddDirectoryMenuDialog({
  open,
  onClose,
  onCreateProject,
  onAddLocalDirectory,
  onCloneRepository,
  onAddSshDirectory,
  onCreateCollection,
}: AddDirectoryMenuDialogProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <FormDialog
      closeLabel={t("sidebar.close", { defaultValue: "Close" })}
      onCancel={onClose}
      open={open}
      showFooter={false}
      title={t("sidebar.chooseDirectoryScheme", {
        defaultValue: "Choose add method",
      })}
    >
      <div className="project-action-grid">
        <button
          className="project-action-card"
          onClick={onCreateProject}
          type="button"
        >
          <span className="project-action-card-icon">
            <FolderPlus size={16} />
          </span>
          <span className="project-action-card-content">
            <strong>
              {t("sidebar.createProject", { defaultValue: "Create project" })}
            </strong>
            <span>
              {t("sidebar.createProjectDescription", {
                defaultValue: "Create a new local project folder",
              })}
            </span>
          </span>
        </button>
        <button
          className="project-action-card"
          onClick={onAddLocalDirectory}
          type="button"
        >
          <span className="project-action-card-icon">
            <Folder size={16} />
          </span>
          <span className="project-action-card-content">
            <strong>
              {t("sidebar.addLocalDirectory", {
                defaultValue: "Add local directory",
              })}
            </strong>
            <span>
              {t("sidebar.addLocalDirectoryActionDescription", {
                defaultValue: "Select or drop an existing local folder",
              })}
            </span>
          </span>
        </button>
        <button
          className="project-action-card"
          onClick={onCloneRepository}
          type="button"
        >
          <span className="project-action-card-icon">
            <GitFork size={16} />
          </span>
          <span className="project-action-card-content">
            <strong>
              {t("sidebar.cloneGitRepository", {
                defaultValue: "Clone git repository",
              })}
            </strong>
            <span>
              {t("sidebar.cloneGitRepositoryDescription", {
                defaultValue: "Clone a remote repository into a local folder",
              })}
            </span>
          </span>
        </button>
        <button
          className="project-action-card"
          onClick={onAddSshDirectory}
          type="button"
        >
          <span className="project-action-card-icon">
            <Server size={16} />
          </span>
          <span className="project-action-card-content">
            <strong>
              {t("sidebar.addSshDirectory", {
                defaultValue: "Add SSH directory",
              })}
            </strong>
            <span>
              {t("sidebar.addSshDirectoryActionDescription", {
                defaultValue: "Connect and add a remote server directory",
              })}
            </span>
          </span>
        </button>
        <div className="project-action-separator" role="separator" />
        <button
          className="project-action-card"
          onClick={onCreateCollection}
          type="button"
        >
          <span className="project-action-card-icon">
            <Library size={16} />
          </span>
          <span className="project-action-card-content">
            <strong>
              {t("sidebar.createCollection", {
                defaultValue: "Create collection",
              })}
            </strong>
            <span>
              {t("sidebar.createCollectionDescription", {
                defaultValue:
                  "Create a collection to organize projects (drag projects into it)",
              })}
            </span>
          </span>
        </button>
      </div>
    </FormDialog>
  );
}
