import { Braces, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LspSessionStatus } from "../../../../preload";
import { useI18n } from "../../../i18n";

/** 会话状态轮询间隔（ms）：会话生命周期变化（启动/退出/回收）秒级感知即可。 */
const POLL_INTERVAL_MS = 3000;

const STATUS_LABEL_KEY: Record<LspSessionStatus["status"], string> = {
  running: "chatInput.lspBadgeStatusRunning",
  dead: "chatInput.lspBadgeStatusDead",
  exited: "chatInput.lspBadgeStatusExited",
};

/**
 * 浮层中只显示项目名（路径最后一段），不暴露本地完整路径；
 * 完整路径仍保留在行的 title 悬停提示中。
 */
function projectDisplayName(projectRoot: string): string {
  const parts = projectRoot.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? projectRoot) : projectRoot;
}

/**
 * 输入框工具栏的 LSP 会话状态徽章（截图位置：加号旁的徽章区）。
 *
 * - 实时轮询 native ServerManager 会话快照（不触发任何会话创建/回收）；
 * - `projectId`：当前项目 id（`activeDirectory.directoryId`）。传入时只展示
 *   该项目根下的会话——切换项目后徽章不再显示其他项目的常驻进程；
 * - 无会话 → 灰色待机；有运行中 → 绿色 + 运行数；有异常 → 黄色告警；
 * - 鼠标悬停展示浮层：逐语言状态、项目根、错误信息（纯展示，无设置入口）。
 */
export function LspStatusBadge({
  projectId,
}: {
  projectId?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<LspSessionStatus[] | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const fetchStatuses = async (): Promise<void> => {
      try {
        const items = await window.snow.listLspSessionStatuses(projectId);
        if (!disposed) {
          setStatuses(items);
        }
      } catch {
        // 静默失败：native 桥不可用/查询失败时保留上次快照，不打扰输入。
      }
    };
    void fetchStatuses();
    const timer = window.setInterval(() => void fetchStatuses(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  if (statuses === null) {
    return null;
  }

  const runningCount = statuses.filter((s) => s.status === "running").length;
  const problemCount = statuses.filter(
    (s) => s.status === "dead" || s.status === "exited"
  ).length;
  const hasProblems = problemCount > 0;

  const title = hasProblems
    ? t("chatInput.lspBadgeTitleProblems", {
        defaultValue: "{{count}} language server(s) unhealthy",
        values: { count: String(problemCount) },
      })
    : runningCount > 0
      ? t("chatInput.lspBadgeTitleRunning", {
          defaultValue: "{{count}} language server(s) running",
          values: { count: String(runningCount) },
        })
      : t("chatInput.lspBadgeTitleIdle", {
          defaultValue: "LSP idle (auto-starts on first tool call)",
        });

  return (
    <div
      className="tooltip-wrapper lsp-status-badge-root"
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`plan-mode-badge lsp-status-badge${
          hasProblems
            ? " has-problems"
            : runningCount > 0
              ? " is-active"
              : " is-idle"
        }`}
        aria-label={title}
        title={title}
      >
        {hasProblems ? (
          <CircleAlert size={14} strokeWidth={1.8} />
        ) : (
          <Braces size={14} strokeWidth={1.8} />
        )}
        {runningCount > 0 && (
          <span className="lsp-status-badge-count">{runningCount}</span>
        )}
      </button>

      {open && (
        <div className="lsp-status-popover" role="dialog">
          <div className="lsp-status-popover-header">
            <strong>
              {t("chatInput.lspBadgeTitle", {
                defaultValue: "LSP language servers",
              })}
            </strong>
            <span>
              {t("chatInput.lspBadgeRunning", {
                defaultValue: "{{running}}/{{total}} running",
                values: {
                  running: String(runningCount),
                  total: String(statuses.length),
                },
              })}
            </span>
          </div>

          <div className="lsp-status-popover-list">
            {statuses.length === 0 ? (
              <div className="lsp-status-popover-empty">
                {t("chatInput.lspBadgeEmpty", {
                  defaultValue:
                    "No sessions yet — servers auto-start on first tool call.",
                })}
              </div>
            ) : (
              statuses.map((session) => (
                <div
                  key={`${session.lang}:${session.projectRoot}`}
                  className={`lsp-status-row ${session.status}`}
                >
                  <span className="lsp-status-dot" aria-hidden="true" />
                  <span className="lsp-status-lang">{session.lang}</span>
                  <span
                    className="lsp-status-project"
                    title={session.projectRoot}
                  >
                    {projectDisplayName(session.projectRoot)}
                  </span>
                  <span className="lsp-status-label">
                    {t(STATUS_LABEL_KEY[session.status], {
                      defaultValue: session.status,
                    })}
                  </span>
                  {session.error && (
                    <span className="lsp-status-error" title={session.error}>
                      {session.error}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
