import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";

export type CustomSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type CustomSelectBaseProps = {
  options: CustomSelectOption[];
  disabled?: boolean;
  title?: string;
  /** 触发按钮的无障碍名称；不给时退化为可见的选中项文本。 */
  ariaLabel?: string;
  /**
   * Force the dropdown to be rendered into `document.body` via a portal and
   * positioned below the trigger button, so it escapes containers that would
   * clip it (e.g. inside a Modal with `overflow: hidden`).
   *
   * Defaults to `false`, which enables auto-detection instead: when a
   * clipping ancestor (`overflow` other than `visible`, e.g. a Modal body)
   * is found, the dropdown is portal-rendered automatically so it can
   * overflow the container.
   */
  portal?: boolean;
  /**
   * Minimum width (px) of the portal dropdown. By default the dropdown is
   * exactly as wide as its trigger; pass a larger value so long option
   * labels are not ellipsized when the trigger sits in a narrow container
   * (e.g. a compact toolbar button).
   */
  dropdownMinWidth?: number;
  /**
   * Optional custom renderer for each dropdown item (e.g. an icon or a
   * small diagram next to the label). Falls back to the plain label when
   * omitted.
   */
  renderOption?: (option: CustomSelectOption) => React.ReactNode;
  /**
   * Optional custom renderer for the trigger label in single-select mode
   * (e.g. icon + text next to the selected item). Falls back to the plain
   * label when omitted or when no matching option exists.
   */
  renderLabel?: (option: CustomSelectOption) => React.ReactNode;
  /**
   * When true, a filter input is shown at the top of the dropdown; typing
   * narrows the visible options by label/value (case-insensitive). The
   * filter resets every time the dropdown opens.
   */
  filterable?: boolean;
  /** Placeholder for the filter input (only used when `filterable`). */
  filterPlaceholder?: string;
  /** Empty-state text shown when the filter matches no options. */
  noMatchText?: string;
  /** Trigger label when `multiple` is set and nothing is selected yet. */
  multipleEmptyLabel?: string;
  /**
   * Trigger label for the selected count in `multiple` mode, e.g.
   * `(count) => \`${count} selected\``. Ignored when `multiple` is unset.
   */
  multipleCountLabel?: (count: number) => string;
  /** 下拉展开/收起时回调（供调用方在菜单打开期间保持外层悬停态）。 */
  onOpenChange?: (open: boolean) => void;
};

export type CustomSelectProps =
  | (CustomSelectBaseProps & {
      multiple?: false;
      value: string;
      onChange: (value: string) => void;
    })
  | (CustomSelectBaseProps & {
      multiple: true;
      value: string[];
      onChange: (values: string[]) => void;
    });

type DropdownRect = {
  top: number;
  left: number;
  width: number;
};

export function CustomSelect({
  value,
  options,
  onChange,
  multiple = false,
  disabled = false,
  title,
  ariaLabel,
  portal = false,
  dropdownMinWidth,
  renderOption,
  renderLabel,
  filterable = false,
  filterPlaceholder = "Filter...",
  noMatchText = "No matching options",
  multipleEmptyLabel = "",
  multipleCountLabel,
  onOpenChange,
}: CustomSelectProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const changeOpen = useCallback(
    (next: boolean): void => {
      setIsOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [filterText, setFilterText] = useState("");
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);
  // Auto-detect clipping ancestors (e.g. Modal bodies with `overflow: hidden`
  // or `overflow: auto`): when one is found, render the dropdown through a
  // portal so it can overflow the container instead of being clipped by it.
  const [autoPortal, setAutoPortal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (portal) return;
    let node = containerRef.current?.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        setAutoPortal(true);
        return;
      }
      node = node.parentElement;
    }
    setAutoPortal(false);
  }, [portal]);

  const usePortal = portal || autoPortal;

  // Reset the filter and focus the input every time the dropdown opens.
  useEffect(() => {
    if (!isOpen || !filterable) return;
    setFilterText("");
    filterInputRef.current?.focus();
  }, [filterable, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      changeOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, changeOpen]);

  // 测量 portal 下拉的位置与宽度：默认与触发按钮等宽；调用方给出
  // dropdownMinWidth 时取两者较大值，避免窄按钮旁的菜单把选项文字截断。
  // 加宽后仍要保证菜单不超出窗口右边缘。
  const measureDropdownRect = useCallback((): DropdownRect | null => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = Math.max(rect.width, dropdownMinWidth ?? 0);
    const maxLeft = Math.max(0, window.innerWidth - width - 8);
    return {
      top: rect.bottom + 4,
      left: Math.min(rect.left, maxLeft),
      width,
    };
  }, [dropdownMinWidth]);

  // Reposition the portal dropdown on resize/scroll while open.
  useEffect(() => {
    if (!isOpen || !usePortal) return;
    const update = (): void => {
      const next = measureDropdownRect();
      if (!next) return;
      setDropdownRect(next);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isOpen, usePortal, measureDropdownRect]);

  // Initial measurement for portal dropdown.
  useLayoutEffect(() => {
    if (!usePortal) {
      setDropdownRect(null);
      return;
    }
    if (!isOpen) return;
    const next = measureDropdownRect();
    if (!next) return;
    setDropdownRect(next);
  }, [isOpen, usePortal, measureDropdownRect]);

  const selectedValues = multiple ? (Array.isArray(value) ? value : []) : null;
  const selectedOption = multiple
    ? null
    : options.find((opt) => opt.value === value);
  const displayLabel: string = multiple
    ? (selectedValues?.length ?? 0) > 0
      ? (multipleCountLabel?.(selectedValues?.length ?? 0) ??
        `${selectedValues?.length ?? 0} selected`)
      : multipleEmptyLabel
    : (selectedOption?.label ?? String(value));

  const handleSelect = useCallback(
    (
      event: React.MouseEvent<HTMLButtonElement>,
      option: CustomSelectOption,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      if (option.disabled) return;
      if (multiple) {
        if (option.value === "") return;
        const current = Array.isArray(value) ? value : [];
        const next = current.includes(option.value)
          ? current.filter((item) => item !== option.value)
          : [...current, option.value];
        (onChange as (values: string[]) => void)(next);
      } else {
        changeOpen(false);
        (onChange as (value: string) => void)(option.value);
      }
    },
    [multiple, onChange, value, changeOpen],
  );

  const handleTriggerClick = (): void => {
    if (disabled) return;
    changeOpen(!isOpen);
  };

  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleOptions =
    filterable && normalizedFilter
      ? options.filter(
          (opt) =>
            opt.label.toLowerCase().includes(normalizedFilter) ||
            opt.value.toLowerCase().includes(normalizedFilter),
        )
      : options;

  const dropdownItems = (
    <>
      {filterable ? (
        <input
          ref={filterInputRef}
          className="custom-select-filter"
          onChange={(event) => setFilterText(event.target.value)}
          placeholder={filterPlaceholder}
          value={filterText}
        />
      ) : null}
      {visibleOptions.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`custom-select-item${opt.disabled ? " disabled" : ""}`}
          onClick={(event) => handleSelect(event, opt)}
          disabled={opt.disabled}
        >
          <span>{renderOption ? renderOption(opt) : opt.label}</span>
          {(multiple
            ? selectedValues?.includes(opt.value)
            : opt.value === value) && (
            <Check size={14} className="custom-select-check" />
          )}
        </button>
      ))}
      {visibleOptions.length === 0 ? (
        <div className="custom-select-empty">{noMatchText}</div>
      ) : null}
    </>
  );

  const dropdown = (
    <div className="custom-select-dropdown" ref={dropdownRef}>
      {dropdownItems}
    </div>
  );

  return (
    <div className="custom-select" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
      >
        <span className="custom-select-label" title={displayLabel}>
          {selectedOption && renderLabel
            ? renderLabel(selectedOption)
            : displayLabel}
        </span>
        <ChevronDown size={14} />
      </button>
      {usePortal && dropdownRect
        ? createPortal(
            isOpen && (
              <div
                className="custom-select-dropdown-portal"
                ref={dropdownRef}
                style={{
                  position: "fixed",
                  top: `${dropdownRect.top}px`,
                  left: `${dropdownRect.left}px`,
                  width: `${dropdownRect.width}px`,
                  zIndex: 100000,
                }}
              >
                <div className="custom-select-dropdown">{dropdownItems}</div>
              </div>
            ),
            document.body,
          )
        : !usePortal && isOpen && dropdown}
    </div>
  );
}
