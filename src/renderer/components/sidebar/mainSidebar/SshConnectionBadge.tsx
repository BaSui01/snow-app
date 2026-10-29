import type { SshConnectionStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { getSshConnectionStatusLabel } from "../../../ssh/sshConnectionStatus";

type SshConnectionBadgeProps = {
  status: SshConnectionStatus;
};

/** SSH 工作区连接状态徽标：状态点 + 本地化文案（项目视图 / 树视图共用）。 */
export function SshConnectionBadge({
  status,
}: SshConnectionBadgeProps): React.JSX.Element {
  const { t } = useI18n();
  const label = getSshConnectionStatusLabel(t, status);
  return (
    <span
      aria-label={label}
      className={`workspace-directory-ssh-badge ${status}`}
      title={label}
    >
      <span aria-hidden="true" className="workspace-directory-ssh-dot" />
      <span className="workspace-directory-ssh-label">{label}</span>
    </span>
  );
}
