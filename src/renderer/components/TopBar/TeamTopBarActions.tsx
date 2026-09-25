import { Loader2, Pencil, RefreshCw, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { TeamAvatar } from "../mainContent/team/TeamShared";
import { timeAgo } from "../mainContent/team/teamUtils";
import { useTeamTopBarSnapshot } from "./teamTopBarStore";

/**
 * TopBar 上的团队协作操作区（仅团队视图渲染）：把原先面板自绘头部的同步状态、
 * 立即同步、当前身份与关闭入口搬到顶栏，与备忘录等独立页面共用同一套头部样式。
 * 数据由 TeamPanel 通过 teamTopBarStore 发布，未就绪时只保留关闭按钮。
 */
export const TeamTopBarActions = ({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const team = useTeamTopBarSnapshot();
  const closeLabel = t("team.header.close", { defaultValue: "关闭团队协作" });

  const closeButton = (
    <button
      className="icon-btn ghost feature-page-close-btn"
      type="button"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={onClose}
    >
      <X size={16} strokeWidth={1.8} />
    </button>
  );

  if (!team) {
    return closeButton;
  }

  const syncLabel = team.syncing
    ? t("team.header.syncing", { defaultValue: "同步中…" })
    : team.error
      ? t("team.header.syncError", { defaultValue: "同步异常" })
      : team.lastSyncAt
        ? t("team.header.lastSync", {
            defaultValue: "同步于 {{time}}",
            values: { time: timeAgo(team.lastSyncAt) },
          })
        : "";
  const syncDelta =
    team.localAhead > 0 || team.localBehind > 0
      ? `(${team.localAhead}↑ ${team.localBehind}↓)`
      : "";
  const syncTitle = team.error
    ? team.error
    : t("team.header.syncNow", { defaultValue: "立即同步" });

  return (
    <>
      <button
        className={`top-bar-team-sync${team.error ? " is-error" : ""}`}
        type="button"
        aria-label={syncTitle}
        title={syncTitle}
        disabled={team.syncing}
        onClick={team.sync}
      >
        {team.syncing ? (
          <Loader2 size={13} className="spin" />
        ) : (
          <RefreshCw size={13} />
        )}
        {syncLabel || syncDelta ? (
          <span className="top-bar-team-sync-text">
            {syncLabel}
            {syncDelta ? ` ${syncDelta}` : ""}
          </span>
        ) : null}
      </button>
      <div className="top-bar-team-me">
        <TeamAvatar name={team.meName} seed={team.meSeed} size={22} online />
        <span className="top-bar-team-me-name">{team.meName}</span>
        <button
          className="icon-btn ghost top-bar-team-edit"
          type="button"
          aria-label={t("team.header.editIdentity", {
            defaultValue: "修改身份",
          })}
          title={t("team.header.editIdentity", { defaultValue: "修改身份" })}
          onClick={team.editIdentity}
        >
          <Pencil size={13} />
        </button>
      </div>
      {closeButton}
    </>
  );
};
