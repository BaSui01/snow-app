import { ChevronDown, Radio, X } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useI18n } from "../../../i18n";

export type MonitoredTerminal = {
  tabId: string;
  cwd: string;
};

type TerminalMonitorBarProps = {
  monitoredTerminal: MonitoredTerminal | null;
  monitoredLines: string[];
  monitorExpanded: boolean;
  monitorScrollRef: RefObject<HTMLDivElement | null>;
  handleStopMonitor: () => void;
  setMonitorExpanded: Dispatch<SetStateAction<boolean>>;
};

export const TerminalMonitorBar = ({
  monitoredTerminal,
  monitoredLines,
  monitorExpanded,
  monitorScrollRef,
  handleStopMonitor,
  setMonitorExpanded,
}: TerminalMonitorBarProps): React.JSX.Element | null => {
  const { t } = useI18n();

  if (!monitoredTerminal) {
    return null;
  }

  return (
    <div
      className={`terminal-monitor-bar${monitorExpanded ? " expanded" : ""}`}
      role="status"
    >
      <div className="terminal-monitor-main">
        <button
          type="button"
          className="terminal-monitor-head"
          onClick={() => setMonitorExpanded((value) => !value)}
          title={t("chat.terminalMonitorToggle", {
            defaultValue: "展开 / 收起监控日志",
          })}
        >
          <Radio
            size={12}
            strokeWidth={2}
            className="terminal-monitor-icon"
            aria-hidden="true"
          />
          <span className="terminal-monitor-label">
            {t("chat.terminalMonitorLabel", {
              defaultValue: "监控终端",
            })}
          </span>
          <span className="terminal-monitor-cwd">{monitoredTerminal.cwd}</span>
          <span className="terminal-monitor-count">
            {t("chat.terminalMonitorLines", {
              defaultValue: "{{count}} 行",
              values: { count: monitoredLines.length },
            })}
          </span>
          <ChevronDown
            size={13}
            className={`terminal-monitor-chevron${
              monitorExpanded ? " open" : ""
            }`}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="terminal-monitor-stop"
          onClick={handleStopMonitor}
          title={t("chat.terminalMonitorStop", {
            defaultValue: "停止监控",
          })}
          aria-label={t("chat.terminalMonitorStop", {
            defaultValue: "停止监控",
          })}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {monitorExpanded ? (
        <div className="terminal-monitor-log" ref={monitorScrollRef}>
          {monitoredLines.length > 0 ? (
            monitoredLines.map((line, index) => (
              <div key={index} className="terminal-monitor-line">
                {line || "\u00A0"}
              </div>
            ))
          ) : (
            <div className="terminal-monitor-empty">
              {t("chat.terminalMonitorEmpty", {
                defaultValue: "等待终端输出…",
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
