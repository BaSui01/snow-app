import {
  BookOpen,
  GitPullRequest,
  ListTodo,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCcw,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TeamTask, WorkspaceDirectoryRecord } from "../../../../preload";
import { useI18n } from "../../../i18n";
import {
  teamTopBarStore,
  type TeamTopBarSnapshot,
} from "../../TopBar/teamTopBarStore";
import { Modal } from "../../common/Modal";
import type { MainContentView } from "../types";
import { TeamActivity } from "./TeamActivity";
import { TeamMembers } from "./TeamMembers";
import { TeamNotes } from "./TeamNotes";
import { TeamReviews } from "./TeamReviews";
import { TeamSetupView } from "./TeamSetup";
import { TeamAvatar } from "./TeamShared";
import { TeamTasks } from "./TeamTasks";
import {
  TEAM_ENABLED_CHANGED_EVENT,
  useTeamData,
  teamLog,
} from "./useTeamData";
import { AVATAR_COLORS, isCustomAvatarColor, memberName } from "./teamUtils";

type TeamTab = "activity" | "tasks" | "reviews" | "notes" | "members";

const TABS: { id: TeamTab; icon: React.JSX.Element; label: string }[] = [
  {
    id: "activity",
    icon: <MessageSquare size={15} strokeWidth={1.8} />,
    label: "动态",
  },
  {
    id: "tasks",
    icon: <ListTodo size={15} strokeWidth={1.8} />,
    label: "任务",
  },
  {
    id: "reviews",
    icon: <GitPullRequest size={15} strokeWidth={1.8} />,
    label: "评审",
  },
  {
    id: "notes",
    icon: <BookOpen size={15} strokeWidth={1.8} />,
    label: "知识",
  },
  { id: "members", icon: <Users size={15} strokeWidth={1.8} />, label: "成员" },
];

export const TeamPanel = ({
  activeDirectory,
  onNavigateToView,
}: {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onNavigateToView: (view: MainContentView) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const workspacePath = activeDirectory?.path ?? "";
  const team = useTeamData(workspacePath);
  const [tab, setTab] = useState<TeamTab>("activity");
  const [reviewPreset, setReviewPreset] = useState<TeamTask | null>(null);
  const [editIdentity, setEditIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editingIdentity, setEditingIdentity] = useState(false);
  // 头像颜色（空串 = 默认色）；初始值用于判断保存时是否需要写自定义色
  const [editColor, setEditColor] = useState("");
  const editColorRef = useRef("");

  // 诊断：捕获团队面板内未捕获的渲染/运行错误
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      teamLog("TeamPanel.windowError", {
        message: event.message,
        stack: event.error?.stack,
      });
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      teamLog("TeamPanel.unhandledRejection", {
        reason:
          event.reason instanceof Error
            ? event.reason.stack
            : String(event.reason),
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const identity = team.identity;
  const myEmail = identity?.email ?? "";
  const { sync, members, syncResult, lastSyncAt, syncing, error, repoPath } =
    team;

  // 顶栏（TopBar）数据：团队名 / 远端地址 / 同步状态 / 当前身份操作全部由
  // 顶栏渲染，TeamPanel 只在挂载期间发布快照、卸载时清空（详见 teamTopBarStore）。
  const readyIdentity =
    identity && identity.isRepo && identity.hasIdentity ? identity : null;
  const readyEmail = readyIdentity?.email ?? "";
  const readyMember = members.find((member) => member.email === readyEmail);
  const teamName =
    activeDirectory?.name || readyIdentity?.remoteUrl || repoPath;

  const openEditIdentity = useCallback((): void => {
    if (!readyIdentity) {
      return;
    }
    const currentColor = isCustomAvatarColor(readyIdentity.avatarSeed)
      ? readyIdentity.avatarSeed
      : "";
    setEditName(readyIdentity.name);
    setEditEmail(readyIdentity.email);
    setEditColor(currentColor);
    editColorRef.current = currentColor;
    setEditError(null);
    setEditIdentity(true);
  }, [readyIdentity]);

  const handleSync = useCallback((): void => {
    void sync();
  }, [sync]);

  const topBarSnapshot = useMemo<TeamTopBarSnapshot | null>(() => {
    if (!readyIdentity) {
      return null;
    }
    return {
      teamName,
      remoteUrl: readyIdentity.remoteUrl,
      syncing,
      lastSyncAt,
      localAhead: syncResult?.localAhead ?? 0,
      localBehind: syncResult?.localBehind ?? 0,
      error,
      meName: memberName(members, readyEmail),
      meSeed: readyIdentity.avatarSeed || readyMember?.avatarSeed || readyEmail,
      sync: handleSync,
      editIdentity: openEditIdentity,
    };
  }, [
    readyIdentity,
    teamName,
    syncing,
    lastSyncAt,
    syncResult,
    error,
    members,
    readyEmail,
    readyMember,
    handleSync,
    openEditIdentity,
  ]);

  useEffect(() => {
    teamTopBarStore.set(topBarSnapshot);
    return () => teamTopBarStore.set(null);
  }, [topBarSnapshot]);

  // 身份尚未解析完成：先显示加载，避免闪回设置视图/工作台
  if (team.identityResolving) {
    return (
      <div className="team-panel team-setup">
        <div className="team-panel-loading">
          <Loader2 size={22} className="spin" />
          <div className="team-setup-desc">
            {t("team.loading", { defaultValue: "正在加载团队信息…" })}
          </div>
        </div>
      </div>
    );
  }

  // 未就绪：不是 git 仓库或缺少身份 → 进入设置视图
  if (!identity || !identity.isRepo || !identity.hasIdentity) {
    return (
      <TeamSetupView
        identity={identity}
        repoPath={team.repoPath}
        onConfigured={() => {
          // 身份已写入 git config，重新读取即可进入主面板
          void team.refresh();
          void team.sync();
        }}
      />
    );
  }

  const myTaskCount = team.tasks.filter(
    (task) => task.assigneeEmail === myEmail && task.status !== "done",
  ).length;
  const myReviewCount = team.reviews.filter(
    (review) => review.reviewerEmail === myEmail && review.status === "pending",
  ).length;

  const saveIdentity = async (): Promise<void> => {
    if (!editName.trim() || !editEmail.trim()) {
      setEditError(
        t("team.setup.errorRequired", { defaultValue: "请输入姓名和邮箱" }),
      );
      return;
    }
    setEditingIdentity(true);
    setEditError(null);
    try {
      await window.snow.teamConfigureIdentity(
        team.repoPath,
        editName.trim(),
        editEmail.trim(),
      );
      // 仅在颜色变化时写入，避免每次保存都多一次成员记录提交
      if (editColor !== editColorRef.current) {
        await window.snow.teamSetAvatarColor(team.repoPath, editColor);
        editColorRef.current = editColor;
      }
      setEditIdentity(false);
      await team.refresh();
      void team.sync();
      // 名称 / 头像色变化后让侧边栏入口立即重新解析身份
      window.dispatchEvent(new CustomEvent(TEAM_ENABLED_CHANGED_EVENT));
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditingIdentity(false);
    }
  };

  const requestReview = (task: TeamTask): void => {
    setReviewPreset(task);
    setTab("reviews");
  };

  const consumeReviewPreset = (): void => setReviewPreset(null);

  return (
    <div className="team-panel">
      <div className="team-panel-body">
        <nav className="team-panel-nav">
          {TABS.map((item) => {
            const count =
              item.id === "tasks"
                ? myTaskCount
                : item.id === "reviews"
                  ? myReviewCount
                  : 0;
            return (
              <button
                type="button"
                key={item.id}
                className={`team-panel-tab${tab === item.id ? " is-active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                <span>
                  {t(`team.tabs.${item.id}`, { defaultValue: item.label })}
                </span>
                {count > 0 ? (
                  <span className="team-tab-badge">{count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <section className="team-panel-content">
          {tab === "activity" ? <TeamActivity team={team} /> : null}
          {tab === "tasks" ? (
            <TeamTasks
              team={team}
              directoryId={activeDirectory?.directoryId ?? ""}
              onNavigateToView={onNavigateToView}
              onRequestReview={requestReview}
            />
          ) : null}
          {tab === "reviews" ? (
            <TeamReviews
              team={team}
              presetTask={reviewPreset}
              onPresetTaskConsumed={consumeReviewPreset}
            />
          ) : null}
          {tab === "notes" ? <TeamNotes team={team} /> : null}
          {tab === "members" ? <TeamMembers team={team} /> : null}
        </section>
      </div>

      <Modal
        open={editIdentity}
        title={t("team.header.editIdentity", { defaultValue: "修改身份" })}
        closeLabel={t("common.close", { defaultValue: "关闭" })}
        onClose={() => setEditIdentity(false)}
        footer={
          <>
            {editError ? (
              <span className="team-form-error">{editError}</span>
            ) : null}
            <button
              type="button"
              className="team-btn team-btn-primary"
              disabled={editingIdentity}
              onClick={() => void saveIdentity()}
            >
              {editingIdentity ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Pencil size={15} />
              )}
              {t("team.setup.save", { defaultValue: "保存" })}
            </button>
          </>
        }
      >
        <div className="team-form">
          <p className="team-form-hint">
            {t("team.setup.identityHint", {
              defaultValue: "身份写入仓库本地 git 配置，团队活动以该身份署名。",
            })}
          </p>
          <label className="team-form-label">
            {t("team.setup.name", { defaultValue: "姓名" })}
            <input
              className="team-form-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>
          <label className="team-form-label">
            {t("team.setup.email", { defaultValue: "邮箱" })}
            <input
              className="team-form-input"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
            />
          </label>
          <div className="team-form-label">
            {t("team.header.avatarColor", { defaultValue: "头像颜色" })}
            <div className="team-color-picker">
              <TeamAvatar
                name={editName.trim() || identity.name}
                seed={editColor || identity.avatarSeed}
                size={26}
              />
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  aria-label={color}
                  className={`team-color-swatch${
                    editColor === color ? " is-active" : ""
                  }`}
                  style={{ background: color }}
                  title={color}
                  type="button"
                  onClick={() => setEditColor(color)}
                />
              ))}
              <button
                aria-label={t("team.header.avatarDefault", {
                  defaultValue: "默认颜色",
                })}
                className={`team-color-default${
                  editColor === "" ? " is-active" : ""
                }`}
                title={t("team.header.avatarDefault", {
                  defaultValue: "默认颜色",
                })}
                type="button"
                onClick={() => setEditColor("")}
              >
                <RotateCcw size={12} />
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};
