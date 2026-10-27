import type { ComponentProps } from "react";
import { ProjectMcpPanel } from "./ProjectMcpPanel";
import { ProjectCodebasePanel } from "./ProjectCodebasePanel";
import { ProjectPermissionsPanel } from "./ProjectPermissionsPanel";
import { ProjectSensitiveCommandsPanel } from "./ProjectSensitiveCommandsPanel";
import { ProjectSkillsPanel } from "./ProjectSkillsPanel";
import { RoleEditorPanel } from "./RoleEditorPanel";
import { CustomCommandsPanel } from "./CustomCommandsPanel";
import { FileChangesPanel } from "./commands/FileChangesPanel";
import { MemoryPanel } from "./commands/MemoryPanel";
import { ReviewPanel } from "./commands/ReviewPanel";

export type ChatInputPanelsProps = {
  projectId?: string;
  projectName?: string;
  isProjectMcpOpen: boolean;
  /** 项目 MCP 弹窗聚焦的服务器 id：非空时只展示该服务器 */
  projectMcpFocusServerId: string | null;
  onClearProjectMcpFocus: () => void;
  isProjectSensitiveCommandsOpen: boolean;
  isProjectPermissionsOpen: boolean;
  isProjectSkillsOpen: boolean;
  isProjectCodebaseOpen: boolean;
  isRoleEditorOpen: boolean;
  isFileChangesOpen: boolean;
  isMemoryOpen: boolean;
  isReviewOpen: boolean;
  isCustomCommandsOpen: boolean;
  workflowMode: boolean;
  conversationFileChanges: ComponentProps<typeof FileChangesPanel>["changes"];
  reviewWorkDir: string;
  onStartReview: ComponentProps<typeof ReviewPanel>["onStartReview"];
  onCloseProjectMcp: () => void;
  onCloseSensitiveCommands: () => void;
  onClosePermissions: () => void;
  onCloseSkills: () => void;
  onCloseCodebase: () => void;
  onCloseRoleEditor: () => void;
  onCloseFileChanges: () => void;
  onCloseMemory: () => void;
  onCloseReview: () => void;
  onCloseCustomCommands: () => void;
};

export const ChatInputPanels = ({
  projectId,
  projectName,
  isProjectMcpOpen,
  projectMcpFocusServerId,
  onClearProjectMcpFocus,
  isProjectSensitiveCommandsOpen,
  isProjectPermissionsOpen,
  isProjectSkillsOpen,
  isProjectCodebaseOpen,
  isRoleEditorOpen,
  isFileChangesOpen,
  isMemoryOpen,
  isReviewOpen,
  isCustomCommandsOpen,
  workflowMode,
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
  onCloseMemory,
  onCloseReview,
  onCloseCustomCommands,
}: ChatInputPanelsProps): React.JSX.Element => (
  <>
    <ProjectMcpPanel
      open={isProjectMcpOpen}
      projectId={projectId}
      projectName={projectName}
      focusServerId={projectMcpFocusServerId}
      workflowMode={workflowMode}
      onClearFocus={onClearProjectMcpFocus}
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
      changes={conversationFileChanges}
      onClose={onCloseFileChanges}
    />
    <MemoryPanel open={isMemoryOpen} onClose={onCloseMemory} />
    <ReviewPanel
      open={isReviewOpen}
      workDir={reviewWorkDir}
      onStartReview={onStartReview}
      onClose={onCloseReview}
    />
    <CustomCommandsPanel
      open={isCustomCommandsOpen}
      projectId={projectId}
      projectName={projectName}
      onClose={onCloseCustomCommands}
    />
  </>
);
