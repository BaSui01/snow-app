import {
  ArrowDown,
  Circle,
  Clock,
  Gauge,
  Pause,
  Play,
  Timer,
} from "lucide-react";
import { memo, useEffect, useReducer } from "react";
import { useI18n } from "../../../i18n";

export type StreamMetricsProps = {
  /** Cumulative streamed tokens across every model iteration in the run. */
  tokenCount: number;
  /** Complete stream elapsed time accumulated across all run iterations. */
  elapsedMs: number;
  /** TTFT captured from the run's first model iteration. */
  ttftMs: number;
  /** Wall-clock timestamp (Date.now()) captured once when an agent loop
   *  starts, sourced from the active conversation session state. Drives the
   *  accumulating elapsed timer so it survives conversation switches between
   *  parallel streaming sessions. 0 when the loop is finished. */
  startedAt: number;
  /** Wall-clock timestamp (Date.now()) captured when the loop was paused,
   *  sourced from the active conversation session state (session-scoped like
   *  startedAt, so parallel paused sessions keep their own anchor). Used to
   *  freeze the elapsed display during pause. 0 while not paused. */
  pausedAt: number;
  /** Whether the agent loop is currently paused. */
  isPaused: boolean;
  /** One-based index of the active top-level TODO step. */
  taskCurrent: number;
  /** Total number of top-level TODO steps. */
  taskTotal: number;
  /** Number of unique files changed in the active conversation. */
  changedFileCount: number;
  additions: number;
  deletions: number;
  /** Open the detailed file-changes panel. */
  onOpenFileChanges: () => void;
  /** Pause the agent loop (only valid while streaming and not already paused). */
  onPause: () => void;
  /** Resume a paused agent loop. */
  onResume: () => void;
};

const formatTokenCount = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

const formatTtft = (ms: number): string => {
  if (ms <= 0) return "--";
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
};

const formatTokPerSec = (tokens: number, elapsedMs: number): string => {
  if (elapsedMs <= 0 || tokens <= 0) return "--";
  const tps = (tokens / elapsedMs) * 1000;
  return tps >= 100 ? `${Math.round(tps)}` : tps.toFixed(1);
};

type StreamMetricsWorkSummaryProps = {
  /** One-based index of the active top-level TODO step. */
  taskCurrent: number;
  /** Total number of top-level TODO steps. */
  taskTotal: number;
  /** Number of unique files changed in the active run. */
  changedFileCount: number;
  additions: number;
  deletions: number;
  /** Open the detailed file-changes panel. */
  onOpenFileChanges: () => void;
};

/**
 * 步骤进度 + 文件更改统计区域。拆为独立 memo 子组件：指标栏的 elapsed
 * 500ms tick 与流式 token 更新只重绘主组件，只要本区域各 props 引用不变，
 * React 会跳过这里 —— 长 run（数十分钟）下避免整条指标栏随 tick 高频
 * 重绘（P0-1 性能优化）。
 */
const StreamMetricsWorkSummary = memo(
  ({
    taskCurrent,
    taskTotal,
    changedFileCount,
    additions,
    deletions,
    onOpenFileChanges,
  }: StreamMetricsWorkSummaryProps): React.JSX.Element | null => {
    const { t } = useI18n();
    const hasWorkSummary =
      taskTotal > 0 || changedFileCount > 0 || additions > 0 || deletions > 0;
    if (!hasWorkSummary) {
      return null;
    }
    return (
      <>
        <span className="stream-metrics-work-summary">
          {taskTotal > 0 ? (
            <span className="stream-metrics-task-progress">
              <Circle
                aria-hidden="true"
                size={11}
                className="stream-metrics-work-icon"
              />
              <span>
                {t("chat.streamMetrics.step", {
                  values: { current: taskCurrent, total: taskTotal },
                })}
              </span>
            </span>
          ) : null}
          {taskTotal > 0 ? (
            <span className="stream-metrics-work-dot">·</span>
          ) : null}
          <button
            type="button"
            className="stream-metrics-file-progress"
            aria-label={t("chat.fileChanges.toggle")}
            title={t("chat.fileChanges.toggle")}
            onClick={onOpenFileChanges}
          >
            <span className="stream-metrics-files-count">
              {changedFileCount}
            </span>
            <span className="stream-metrics-files-label">
              {t("chat.streamMetrics.filesLabel")}
            </span>
            <span className="stream-metrics-additions">+{additions}</span>
            <span className="stream-metrics-deletions">-{deletions}</span>
          </button>
        </span>
        <span className="stream-metrics-sep" />
      </>
    );
  }
);
StreamMetricsWorkSummary.displayName = "StreamMetricsWorkSummary";

/**
 * Fixed streaming metrics bar displayed above the input box while the AI
 * is generating a response. Shows run-level token count, first-iteration
 * TTFT, cumulative stream speed, and accumulated elapsed time.
 *
 * Elapsed is a pure derivation of `startedAt` — a wall-clock timestamp the
 * agent loop captures once when it begins and resets to 0 when it ends
 * (the anchor lives in session state, owned and maintained by the state
 * layer). The component holds no parallel shadow state: a 500ms interval
 * only triggers re-renders, and the displayed value is recomputed from
 * `startedAt` on every render. This makes conversation switches, new runs
 * and first paint inherently consistent — no residual, no lag, no sync bugs.
 *
 * Elapsed is intentionally independent of `elapsedMs`, which contains the
 * sum of complete per-iteration stream durations used to calculate the
 * run's tok/s. Each parallel streaming conversation carries its own timer
 * anchor, so switching between them does not reset the accumulated duration.
 *
 * Pause semantics live in the state layer: on pause the interval stops
 * (display freezes), and on resume the state layer shifts `streamStartedAt`
 * forward by the paused duration, so paused time is excluded from the total.
 *
 * The pause/resume button is rendered on the left edge of the bar. It
 * allows the user to pause the agent loop before the next iteration
 * (i.e. before the next AI response) and resume it later. The button is
 * per-session because the pause controller is keyed by conversation id.
 */
export const StreamMetrics = memo(
  ({
    tokenCount,
    elapsedMs,
    ttftMs,
    startedAt,
    pausedAt,
    isPaused,
    taskCurrent,
    taskTotal,
    changedFileCount,
    additions,
    deletions,
    onOpenFileChanges,
    onPause,
    onResume,
  }: StreamMetricsProps): React.JSX.Element => {
    const { t } = useI18n();
    const hasTtft = typeof ttftMs === "number" && ttftMs > 0;
    const isActive = typeof startedAt === "number" && startedAt > 0;

    // --- Elapsed 计时：单一数据源设计 ---
    // elapsed 不从任何本地状态派生（组件内无 state、无 ref），而是每次渲染
    // 时从 props.startedAt 纯派生 —— 锚点由状态层持有并维护（暂停/恢复时状态
    // 层调整锚点，组件不做任何补偿）。定时器只负责触发重渲染（forceTick），
    // 不持有任何值。因此切换会话 / 新 run / 首帧天然一致，无残留、无延迟。
    const [, forceTick] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
      if (!isActive || isPaused) {
        return;
      }
      const interval = setInterval(forceTick, 500);
      return () => clearInterval(interval);
    }, [isActive, isPaused]);

    // 暂停期间：elapsed = 暂停时刻的累计值（冻结），暂停进行时长不累计。
    // pausedAt 来自会话状态，随会话切换原子更新，不会串台。恢复时状态层已
    // 将 streamStartedAt 前移（扣除暂停时长），派生值自动从冻结值继续。
    const pausedSoFar =
      isPaused && pausedAt > 0 ? Math.max(0, Date.now() - pausedAt) : 0;
    // clamp 负值：debug 中系统时间回拨时避免显示 "-1s"
    const elapsedDisplay = formatDuration(
      isActive ? Math.max(0, Date.now() - startedAt - pausedSoFar) : 0
    );
    const hasTokens = tokenCount > 0;
    const tps =
      tokenCount > 0 && elapsedMs > 0
        ? formatTokPerSec(tokenCount, elapsedMs)
        : "--";
    const hasTps = tps !== "--";

    return (
      <span className="stream-metrics">
        <button
          type="button"
          className={`stream-metrics-pause-btn${
            isPaused ? " is-paused" : ""
          }`}
          aria-label={
            isPaused
              ? t("chat.streamMetrics.resume")
              : t("chat.streamMetrics.pause")
          }
          title={
            isPaused
              ? t("chat.streamMetrics.resume")
              : t("chat.streamMetrics.pause")
          }
          onClick={isPaused ? onResume : onPause}
        >
          {isPaused ? (
            <Play size={11} fill="currentColor" />
          ) : (
            <Pause size={11} fill="currentColor" />
          )}
        </button>
        <span className="stream-metrics-sep" />
        <StreamMetricsWorkSummary
          taskCurrent={taskCurrent}
          taskTotal={taskTotal}
          changedFileCount={changedFileCount}
          additions={additions}
          deletions={deletions}
          onOpenFileChanges={onOpenFileChanges}
        />
        <span
          className={`stream-metrics-metric stream-metrics-elapsed${
            isActive ? " is-active" : ""
          }`}
          title={t("chat.streamMetrics.elapsedTitle")}
        >
          <Timer size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">{elapsedDisplay}</span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className="stream-metrics-metric stream-metrics-ttft"
          title={t("chat.streamMetrics.ttftTitle")}
        >
          <Clock size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">
            {hasTtft ? formatTtft(ttftMs) : "--"}
          </span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className={`stream-metrics-metric stream-metrics-tokens${
            hasTokens ? " is-active" : ""
          }`}
          title="tokens"
        >
          <ArrowDown size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">
            {formatTokenCount(tokenCount)}
          </span>
          <span className="stream-metrics-label">tokens</span>
        </span>
        <span className="stream-metrics-sep" />
        <span
          className={`stream-metrics-metric stream-metrics-tps${
            hasTps ? " is-active" : ""
          }`}
          title="tok/s"
        >
          <Gauge size={11} className="stream-metrics-icon" />
          <span className="stream-metrics-value">{tps}</span>
          <span className="stream-metrics-label">tok/s</span>
        </span>
      </span>
    );
  }
);

StreamMetrics.displayName = "StreamMetrics";
