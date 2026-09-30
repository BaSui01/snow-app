import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Target, GitBranch, Edit3, ChevronDown, Check } from "lucide-react";
import { useI18n } from "../../../i18n";

export type WorktreeBaseRefSelectProps = {
  /** 当前选中的基线引用（例如 "HEAD"、"main" 或自定义引用） */
  value: string;
  /** 是否处于自定义基线输入模式 */
  isCustom: boolean;
  /** 当前 Git 分支名称（可选） */
  currentBranch?: string;
  /** 主干分支名称（例如 "main" 或 "master"，可选） */
  mainBranch?: string | null;
  /** 本地已有分支名称列表（可选） */
  localBranches?: string[];
  /** 是否禁用 */
  disabled?: boolean;
  /** 选择某个预设/已有分支时的回调 */
  onSelect: (ref: string) => void;
  /** 用户选择“手动输入自定义引用”时的回调 */
  onSelectCustom: () => void;
};

type DropdownRect = {
  top: number;
  left: number;
  width: number;
};

export function WorktreeBaseRefSelect({
  value,
  isCustom,
  currentBranch = "HEAD",
  mainBranch,
  localBranches = [],
  disabled = false,
  onSelect,
  onSelectCustom,
}: WorktreeBaseRefSelectProps): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部自动收起
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // 监听按键 Escape 自动收起
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // 动态更新 Portal 悬浮框坐标
  const updateRect = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setDropdownRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 260),
    });
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updateRect();
    }
  }, [isOpen, updateRect]);

  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [isOpen, updateRect]);

  // 过滤出排除当前分支和主干后的其他本地分支
  const otherLocalBranches = localBranches.filter(
    (name) => name !== currentBranch && name !== mainBranch,
  );

  // 渲染当前选中的触发器标签与图标
  const renderTriggerContent = (): React.JSX.Element => {
    if (isCustom) {
      return (
        <span className="branch-ref-trigger-content">
          <Edit3 size={13} className="branch-ref-item-icon text-purple-400" />
          <span className="branch-ref-trigger-text">
            {value && value !== "HEAD"
              ? value
              : t("git.worktreeBaseCustomOption", {
                  defaultValue: "自定义引用 / Commit",
                })}
          </span>
          <span className="branch-ref-badge branch-ref-badge-custom">
            Custom
          </span>
        </span>
      );
    }

    if (value === "HEAD" || !value) {
      return (
        <span className="branch-ref-trigger-content">
          <Target size={13} className="branch-ref-item-icon text-blue-400" />
          <span className="branch-ref-trigger-text">HEAD</span>
          <span className="branch-ref-badge branch-ref-badge-current">
            {t("git.worktreeCurrentTag", { defaultValue: "当前" })}:{" "}
            {currentBranch || "HEAD"}
          </span>
        </span>
      );
    }

    if (mainBranch && value === mainBranch) {
      return (
        <span className="branch-ref-trigger-content">
          <GitBranch
            size={13}
            className="branch-ref-item-icon text-emerald-400"
          />
          <span className="branch-ref-trigger-text">{mainBranch}</span>
          <span className="branch-ref-badge branch-ref-badge-main">
            {t("git.worktreeMainTag", { defaultValue: "主干" })}
          </span>
        </span>
      );
    }

    // 其它本地分支
    return (
      <span className="branch-ref-trigger-content">
        <GitBranch size={13} className="branch-ref-item-icon text-zinc-400" />
        <span className="branch-ref-trigger-text">{value}</span>
      </span>
    );
  };

  const handleSelectRef = (ref: string): void => {
    onSelect(ref);
    setIsOpen(false);
  };

  const handleSelectCustomMode = (): void => {
    onSelectCustom();
    setIsOpen(false);
  };

  const isHeadSelected = !isCustom && (value === "HEAD" || !value);
  const isMainSelected = !isCustom && mainBranch && value === mainBranch;

  const dropdownMenu = (
    <div
      ref={dropdownRef}
      className="branch-ref-dropdown"
      style={{
        maxHeight: "300px",
      }}
    >
      {/* 推荐基线组 */}
      <div className="branch-ref-group-title">
        {t("git.worktreeBaseRecommended", {
          defaultValue: "推荐基线",
        })}
      </div>

      {/* HEAD 选项 */}
      <button
        type="button"
        className={`branch-ref-option${isHeadSelected ? " is-active" : ""}`}
        onClick={() => handleSelectRef("HEAD")}
      >
        <div className="branch-ref-option-left">
          <Target size={13} className="branch-ref-item-icon text-blue-400" />
          <span className="branch-ref-option-title">HEAD</span>
          <span className="branch-ref-badge branch-ref-badge-current">
            {t("git.worktreeCurrentTag", { defaultValue: "当前" })}:{" "}
            {currentBranch || "HEAD"}
          </span>
        </div>
        {isHeadSelected && (
          <Check size={13} className="branch-ref-check text-blue-400" />
        )}
      </button>

      {/* 主干分支选项 */}
      {mainBranch && (
        <button
          type="button"
          className={`branch-ref-option${isMainSelected ? " is-active" : ""}`}
          onClick={() => handleSelectRef(mainBranch)}
        >
          <div className="branch-ref-option-left">
            <GitBranch
              size={13}
              className="branch-ref-item-icon text-emerald-400"
            />
            <span className="branch-ref-option-title">{mainBranch}</span>
            <span className="branch-ref-badge branch-ref-badge-main">
              {t("git.worktreeMainTag", { defaultValue: "主干" })}
            </span>
          </div>
          {isMainSelected && (
            <Check size={13} className="branch-ref-check text-emerald-400" />
          )}
        </button>
      )}

      {/* 本地已有分支列表 */}
      {otherLocalBranches.length > 0 && (
        <>
          <div className="branch-ref-divider" />
          <div className="branch-ref-group-title">
            {t("git.worktreeBaseLocalBranches", {
              defaultValue: "本地已有分支",
            })}
          </div>
          <div className="branch-ref-sub-list">
            {otherLocalBranches.map((branch) => {
              const isSelected = !isCustom && value === branch;
              return (
                <button
                  key={branch}
                  type="button"
                  className={`branch-ref-option${isSelected ? " is-active" : ""}`}
                  onClick={() => handleSelectRef(branch)}
                >
                  <div className="branch-ref-option-left">
                    <GitBranch
                      size={13}
                      className="branch-ref-item-icon text-zinc-400"
                    />
                    <span className="branch-ref-option-title">{branch}</span>
                  </div>
                  {isSelected && (
                    <Check
                      size={13}
                      className="branch-ref-check text-blue-400"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="branch-ref-divider" />

      {/* 手动输入自定义选项 */}
      <button
        type="button"
        className={`branch-ref-option branch-ref-custom-option${isCustom ? " is-active" : ""}`}
        onClick={handleSelectCustomMode}
      >
        <div className="branch-ref-option-left">
          <Edit3 size={13} className="branch-ref-item-icon text-purple-400" />
          <span className="branch-ref-option-title">
            {t("git.worktreeBaseCustomOption", {
              defaultValue: "手动输入自定义 Commit/Tag/引用...",
            })}
          </span>
        </div>
        {isCustom && (
          <Check size={13} className="branch-ref-check text-purple-400" />
        )}
      </button>
    </div>
  );

  return (
    <div className="branch-ref-select-container" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`branch-ref-select-trigger${isOpen ? " is-open" : ""}`}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        disabled={disabled}
      >
        {renderTriggerContent()}
        <ChevronDown
          size={13}
          className={`branch-ref-chevron${isOpen ? " is-open" : ""}`}
        />
      </button>

      {isOpen &&
        dropdownRect &&
        createPortal(
          <div
            className="branch-ref-dropdown-portal"
            style={{
              top: `${dropdownRect.top}px`,
              left: `${dropdownRect.left}px`,
              width: `${dropdownRect.width}px`,
            }}
          >
            {dropdownMenu}
          </div>,
          document.body,
        )}
    </div>
  );
}
