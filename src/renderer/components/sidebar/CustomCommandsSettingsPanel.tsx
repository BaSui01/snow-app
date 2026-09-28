import type { WorkspaceDirectoryRecord } from "../../../preload";
import { CustomCommandsManager } from "./customCommands/CustomCommandsManager";

type CustomCommandsSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

export function CustomCommandsSettingsPanel({
  activeDirectory,
}: CustomCommandsSettingsPanelProps): React.JSX.Element {
  return (
    <div className="api-settings-page" role="region">
      <CustomCommandsManager
        projectId={activeDirectory?.directoryId}
        projectName={activeDirectory?.name}
      />
    </div>
  );
}
