import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../../i18n";
import type { ChatCommand } from "./types";

export type CommandPanelHandle = {
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
};

type CommandPanelProps = {
  commands: ChatCommand[];
  query: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (command: ChatCommand) => void;
};
export const CommandPanel = forwardRef<CommandPanelHandle, CommandPanelProps>(
  function CommandPanel({ commands, query, visible, onClose, onSelect }, ref) {
    const { t } = useI18n();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [isClosing, setIsClosing] = useState(false);
    const [prevVisible, setPrevVisible] = useState(visible);
    const [lastQuery, setLastQuery] = useState(query);
    const listRef = useRef<HTMLDivElement>(null);

    if (visible !== prevVisible) {
      setPrevVisible(visible);
      setIsClosing(!visible);
    }

    useEffect(() => {
      if (!isClosing) {
        return;
      }
      const timer = window.setTimeout(() => setIsClosing(false), 160);
      return () => window.clearTimeout(timer);
    }, [isClosing]);

    useEffect(() => {
      if (visible) {
        setLastQuery(query);
      }
    }, [visible, query]);

    const displayQuery = visible ? query : lastQuery;

    const groupedCommands = useMemo(() => {
      const normalizedQuery = displayQuery.trim().toLowerCase();
      const matched = !normalizedQuery
        ? commands
        : commands.filter(
            (command) =>
              command.label.toLowerCase().includes(normalizedQuery) ||
              command.description.toLowerCase().includes(normalizedQuery) ||
              command.searchKeywords?.some((keyword) =>
                keyword.toLowerCase().includes(normalizedQuery),
              ),
          );

      const sortByDisabled = (items: ChatCommand[]): ChatCommand[] =>
        [...items].sort((a, b) => Number(a.disabled) - Number(b.disabled));

      return [
        {
          key: "builtin",
          commands: sortByDisabled(
            matched.filter((command) => command.group !== "custom"),
          ),
        },
        {
          key: "custom",
          commands: sortByDisabled(
            matched.filter((command) => command.group === "custom"),
          ),
        },
      ];
    }, [commands, displayQuery]);

    const filteredCommands = useMemo(
      () => groupedCommands.flatMap((group) => group.commands),
      [groupedCommands],
    );

    const hasMultipleGroups =
      groupedCommands.filter((group) => group.commands.length > 0).length > 1;

    useEffect(() => {
      if (!visible) {
        return;
      }
      const firstEnabled = filteredCommands.findIndex((c) => !c.disabled);
      setSelectedIndex(firstEnabled === -1 ? 0 : firstEnabled);
    }, [visible, filteredCommands]);

    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      const selectedEl = list.querySelector<HTMLElement>(
        `[data-command-index="${selectedIndex}"]`,
      );
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
    }, [selectedIndex]);

    useImperativeHandle(
      ref,
      () => ({
        handleKeyDown: (event): boolean => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return true;
          }

          if (filteredCommands.length === 0) {
            return false;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedIndex((index) => {
              const len = filteredCommands.length;
              for (let i = 1; i <= len; i++) {
                const next = (index + i) % len;
                if (!filteredCommands[next].disabled) return next;
              }
              return index;
            });
            return true;
          }

          if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((index) => {
              const len = filteredCommands.length;
              for (let i = 1; i <= len; i++) {
                const prev = (index - i + len) % len;
                if (!filteredCommands[prev].disabled) return prev;
              }
              return index;
            });
            return true;
          }

          if (event.key === "Enter") {
            event.preventDefault();
            const command = filteredCommands[selectedIndex];
            if (command && !command.disabled) {
              onSelect(command);
            }
            return true;
          }

          return false;
        },
      }),
      [filteredCommands, onClose, onSelect, selectedIndex],
    );

    return (
      (visible || isClosing) && (
        <div
          className={`chat-command-panel${isClosing ? " is-closing" : ""}`}
          data-esc-panel
          role="listbox"
          aria-label={t("chatCommand.title")}
        >
          <div className="chat-command-list" ref={listRef}>
            {filteredCommands.length > 0 ? (
              groupedCommands.map((group) =>
                group.commands.length === 0 ? null : (
                  <div className="chat-command-group" key={group.key}>
                    {hasMultipleGroups ? (
                      <div className="chat-command-group-header">
                        {group.key === "custom"
                          ? t("chatCommand.customGroup")
                          : t("chatCommand.builtinGroup")}
                      </div>
                    ) : null}
                    {group.commands.map((command) => {
                      const CommandIcon = command.icon;
                      const index = filteredCommands.indexOf(command);
                      const isSelected = index === selectedIndex;

                      return (
                        <button
                          key={command.id}
                          className={`chat-command-item${
                            isSelected ? " selected" : ""
                          }`}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-command-index={index}
                          disabled={command.disabled}
                          onMouseEnter={() => {
                            if (!command.disabled) setSelectedIndex(index);
                          }}
                          onClick={() => onSelect(command)}
                        >
                          <CommandIcon
                            size={15}
                            strokeWidth={1.8}
                            className="chat-command-item-icon"
                          />
                          <span className="chat-command-item-content">
                            <span className="chat-command-item-name">
                              /{command.label}
                              {command.badge ? (
                                <span className="chat-command-item-badge">
                                  {command.badge}
                                </span>
                              ) : null}
                            </span>
                            <span className="chat-command-item-description">
                              {command.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ),
              )
            ) : (
              <div className="chat-command-empty">{t("chatCommand.empty")}</div>
            )}
          </div>
          <div className="chat-command-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> {t("chatCommand.navigate")}
            </span>
            <span>
              <kbd>Enter</kbd> {t("chatCommand.execute")}
            </span>
            <span>
              <kbd>Esc</kbd> {t("chatCommand.close")}
            </span>
          </div>
        </div>
      )
    );
  },
);
