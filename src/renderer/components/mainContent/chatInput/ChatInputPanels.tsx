import type { ComponentProps } from "react";
import { ProjectMcpPanel } from "./ProjectMcpPanel";
import { ProjectCodebasePanel } from "./ProjectCodebasePanel";
import { ProjectPermissionsPanel } from "./ProjectPermissionsPanel";
import { ProjectSensitiveCommandsPanel } from "./ProjectSensitiveCommandsPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { RoleEditorPanel } from "./RoleEditorPanel";
import { FileChangesPanel } from "./commands/FileChangesPanel";
import { ReviewPanel } from "./commands/ReviewPanel";

export type ChatInputPanelsProps = {
  projectId?: string;
  projectName?: string;
  isProjectMcpOpen: boolean;
  isProjectSensitiveCommandsOpen: boolean;
  isProjectPermissionsOpen: boolean;
  isProjectSkillsOpen: boolean;
  isProjectCodebaseOpen: boolean;
  isRoleEditorOpen: boolean;
  isFileChangesOpen: boolean;
  isReviewOpen: boolean;
  conversationFileChanges: ComponentProps<
    typeof FileChangesPanel
  >["changesOverride"];
  reviewWorkDir: string;
  onStartReview: ComponentProps<typeof ReviewPanel>["onStartReview"];
  onCloseProjectMcp: () => void;
  onCloseSensitiveCommands: () => void;
  onClosePermissions: () => void;
  onCloseSkills: () => void;
  onCloseCodebase: () => void;
  onCloseRoleEditor: () => void;
  onCloseFileChanges: () => void;
  onCloseReview: () => void;
};

export const ChatInputPanels = ({
  projectId,
  projectName,
  isProjectMcpOpen,
  isProjectSensitiveCommandsOpen,
  isProjectPermissionsOpen,
  isProjectSkillsOpen,
  isProjectCodebaseOpen,
  isRoleEditorOpen,
  isFileChangesOpen,
  isReviewOpen,
  conversationFileChanges,
  reviewWorkDir,
  onStartReview,
  onCloseProjectMcp,
  onCloseSensitiveCommands,
  onClosePermissions,
  onCloseSkills,
  onCloseCodebase,
  onCloseRoleEditor,
  onCloseFileChanges,
  onCloseReview,
}: ChatInputPanelsProps): React.JSX.Element => (
  <>
    <ProjectMcpPanel
      open={isProjectMcpOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseProjectMcp}
    />
    <ProjectSensitiveCommandsPanel
      open={isProjectSensitiveCommandsOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseSensitiveCommands}
    />
    <ProjectPermissionsPanel
      open={isProjectPermissionsOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onClosePermissions}
    />
    <ProjectSkillsPanel
      open={isProjectSkillsOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseSkills}
    />
    <ProjectCodebasePanel
      open={isProjectCodebaseOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseCodebase}
    />
    <RoleEditorPanel
      open={isRoleEditorOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseRoleEditor}
    />
    <FileChangesPanel
      open={isFileChangesOpen}
      changesOverride={conversationFileChanges}
      onClose={onCloseFileChanges}
    />
    <ReviewPanel
      open={isReviewOpen}
      workDir={reviewWorkDir}
      onStartReview={onStartReview}
      onClose={onCloseReview}
    />
  </>
);

