import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Loader2, RefreshCw, Search } from "lucide-react";
import { ModelBrandIcon } from "../../common/ModelBrandIcon";
import { groupModelsByBrand, type ModelGroup } from "../../common/modelGroups";
import { useI18n } from "../../../i18n";
import type { Model } from "../../../../preload";

type ApiModelComboboxProps = {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  models: Model[];
  isLoading: boolean;
  error: string | null;
  hasLoaded: boolean;
  loadingText: string;
  noModelsText: string;
  retryText: string;
  onChange: (value: string) => void;
  onRequestModels: () => void;
  onRetry: () => void;
  /**
   * Optional metadata for known models (alias / preview / deprecated badges).
   * The list item then renders as `id` + alias + badge instead of a plain id.
   */
  knownModels?: Array<{
    id: string;
    alias?: string;
    preview?: boolean;
    deprecated?: boolean;
  }>;
  /** 已知模型徽章文案（如 "预览" / "Preview"）。 */
  previewBadgeText?: string;
  /** 已知模型徽章文案（如 "已弃用" / "Deprecated"）。 */
  deprecatedBadgeText?: string;
  /**
   * 可选的标签行右侧操作区（如「按模型 ID 填充能力」按钮）。
   * 传入后标签与操作按钮同排渲染，避免调用方在外层重复写一遍标签。
   */
  labelAction?: React.ReactNode;
};

const MAX_VISIBLE_MODELS = 80;

/** 列表行：分组标题行 + 已展开分组的模型行。 */
type ModelComboboxRow =
  { type: "group"; group: ModelGroup } | { type: "model"; model: Model };

export function ApiModelCombobox({
  label,
  value,
  placeholder,
  disabled,
  models,
  isLoading,
  error,
  hasLoaded,
  loadingText,
  noModelsText,
  retryText,
  onChange,
  onRequestModels,
  onRetry,
  knownModels,
  previewBadgeText,
  deprecatedBadgeText,
  labelAction,
}: ApiModelComboboxProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  // null 表示高亮跟随选中模型所在行（由列表结构推导），交互后固定为具体行索引
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  // 手动展开的分组键；null 表示未被用户改动，回到默认（只展开选中模型所在分组）
  const [expandedGroups, setExpandedGroups] = useState<Set<string> | null>(
    null,
  );
  // Kept separate from `value`: the input value holds the selected model id,
  // and filtering by it would hide every other model when the list reopens.
  // The keyword only applies to text the user typed since the list was opened.
  const [filterKeyword, setFilterKeyword] = useState("");

  const filteredModels = useMemo(() => {
    const keyword = filterKeyword.trim().toLowerCase();
    const matchedModels = keyword
      ? models.filter((model) => model.id.toLowerCase().includes(keyword))
      : models;

    return matchedModels.slice(0, MAX_VISIBLE_MODELS);
  }, [models, filterKeyword]);

  // 按品牌分组：只有多个品牌时才折叠展示，单品牌保持平铺列表
  const modelGroups = useMemo(
    () => groupModelsByBrand(filteredModels),
    [filteredModels],
  );
  const isGrouped = modelGroups.length > 1;
  const isFiltering = filterKeyword.trim().length > 0;

  // 默认展开选中模型所在分组（无选中项时退回首个分组）
  const defaultExpandedGroupKeys = useMemo(() => {
    const selectedGroup = modelGroups.find((group) =>
      group.models.some((model) => model.id === value),
    );
    const key = selectedGroup?.key ?? modelGroups[0]?.key;
    return new Set<string>(key ? [key] : []);
  }, [modelGroups, value]);
  const expandedGroupKeys = expandedGroups ?? defaultExpandedGroupKeys;

  const rows = useMemo<ModelComboboxRow[]>(() => {
    if (!isGrouped) {
      return filteredModels.map((model) => ({ type: "model", model }));
    }
    const list: ModelComboboxRow[] = [];
    for (const group of modelGroups) {
      list.push({ type: "group", group });
      if (expandedGroupKeys.has(group.key)) {
        for (const model of group.models) {
          list.push({ type: "model", model });
        }
      }
    }
    return list;
  }, [filteredModels, modelGroups, isGrouped, expandedGroupKeys]);

  // 未交互时高亮跟随选中模型所在行，交互后固定为具体行
  const defaultHighlightedIndex = useMemo(() => {
    const selectedIndex = rows.findIndex(
      (row) => row.type === "model" && row.model.id === value,
    );
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
    const firstModelIndex = rows.findIndex((row) => row.type === "model");
    return firstModelIndex >= 0 ? firstModelIndex : 0;
  }, [rows, value]);
  const activeIndex = highlightedIndex ?? defaultHighlightedIndex;

  // 选中模型或过滤结果变化时，高亮回到选中模型所在行
  useEffect(() => {
    setHighlightedIndex(null);
  }, [value, filteredModels]);

  // 过滤时展开所有分组保证匹配结果可见；未过滤时回到默认展开状态
  useEffect(() => {
    if (!isFiltering) {
      setExpandedGroups(null);
      return;
    }
    setExpandedGroups(new Set(modelGroups.map((group) => group.key)));
  }, [isFiltering, modelGroups]);

  // 每次打开列表回到默认展开状态：只展开选中模型所在分组
  useEffect(() => {
    if (isOpen) {
      setExpandedGroups(null);
    }
  }, [isOpen]);

  // 可见行变化时收敛高亮索引，避免越界
  useEffect(() => {
    setHighlightedIndex((index) =>
      index === null || rows.length === 0
        ? index
        : Math.min(index, rows.length - 1),
    );
  }, [rows]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen]);

  const openModelList = () => {
    if (disabled) {
      return;
    }

    setIsOpen(true);
    onRequestModels();
  };

  // Reopening a closed list must not reuse the previous filter keyword,
  // otherwise the other models stay filtered out and the list looks broken.
  const showFullModelList = () => {
    setFilterKeyword("");
    openModelList();
  };

  const handleSelectModel = (modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
  };

  const setGroupExpanded = (key: string, expanded: boolean): void => {
    setExpandedGroups((previous) => {
      const next = new Set(previous ?? defaultExpandedGroupKeys);
      if (expanded) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  // ↑↓ 在可见行（分组标题 + 已展开分组的模型）间移动高亮，
  // Enter 选中模型或展开/收起分组标题行。
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (isOpen) {
        // 仅在本层真正消费 ESC（关闭下拉列表）时阻断冒泡，
        // 避免把事件传给外层弹窗导致其被一并关闭。
        event.stopPropagation();
        setIsOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (isOpen) {
        openModelList();
      } else {
        showFullModelList();
      }
      setHighlightedIndex(
        Math.min(activeIndex + 1, Math.max(rows.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex(Math.max(activeIndex - 1, 0));
      return;
    }

    if (event.key === "Enter" && isOpen) {
      const row = rows[activeIndex];
      if (!row) {
        return;
      }
      event.preventDefault();
      if (row.type === "group") {
        setGroupExpanded(row.group.key, !expandedGroupKeys.has(row.group.key));
      } else {
        handleSelectModel(row.model.id);
      }
    }
  };

  const shouldShowEmpty =
    !isLoading && !error && hasLoaded && filteredModels.length === 0;

  return (
    <label className="api-settings-field api-model-combobox-field">
      {labelAction ? (
        <span className="api-model-combobox-label">
          <span>{label}</span>
          {labelAction}
        </span>
      ) : (
        <span>{label}</span>
      )}
      <div className="api-model-combobox" ref={rootRef}>
        <div className="api-model-combobox-input-wrap">
          {value.trim() ? (
            <ModelBrandIcon
              model={value}
              size={14}
              className="api-model-combobox-search"
            />
          ) : (
            <Search size={14} className="api-model-combobox-search" />
          )}
          <input
            value={value}
            onChange={(event) => {
              const nextValue = event.target.value;
              onChange(nextValue);
              setFilterKeyword(nextValue);
              openModelList();
            }}
            onFocus={showFullModelList}
            onClick={showFullModelList}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
          />
          <span className="api-model-combobox-status" aria-hidden="true">
            {isLoading ? (
              <Loader2 size={14} className="api-model-combobox-spin" />
            ) : (
              <ChevronDown size={14} />
            )}
          </span>
        </div>

        {isOpen && !disabled && (
          <div className="api-model-combobox-menu" role="listbox">
            {isLoading && (
              <div className="api-model-combobox-message">{loadingText}</div>
            )}

            {error && (
              <div className="api-model-combobox-error">
                <span>{error}</span>
                <button type="button" onClick={onRetry} disabled={isLoading}>
                  <RefreshCw size={12} />
                  <span>{retryText}</span>
                </button>
              </div>
            )}

            {!isLoading && !error && rows.length > 0 && (
              <div className="api-model-combobox-list">
                {rows.map((row, index) => {
                  if (row.type === "group") {
                    const isExpanded = expandedGroupKeys.has(row.group.key);

                    return (
                      <button
                        key={`group-${row.group.key}`}
                        type="button"
                        className={`api-model-combobox-option api-model-combobox-group ${
                          index === activeIndex ? "highlighted" : ""
                        }`}
                        aria-expanded={isExpanded}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        onClick={(event) => {
                          // Prevent the wrapping <label> from forwarding the
                          // click to the input.
                          event.preventDefault();
                          setGroupExpanded(row.group.key, !isExpanded);
                        }}
                      >
                        <span className="api-model-combobox-option-main">
                          <ModelBrandIcon
                            model={row.group.iconModel}
                            size={14}
                            className="api-model-combobox-option-icon"
                          />
                          <span className="api-model-combobox-group-name">
                            {row.group.label ||
                              t("chat.otherModels", { defaultValue: "Other" })}
                          </span>
                        </span>
                        <span className="api-model-combobox-group-meta">
                          <span>{row.group.models.length}</span>
                          <ChevronDown
                            size={12}
                            className="api-model-combobox-group-chevron"
                          />
                        </span>
                      </button>
                    );
                  }

                  const model = row.model;
                  const isSelected = model.id === value;
                  const isHighlighted = index === activeIndex;
                  const known = knownModels?.find(
                    (entry) =>
                      entry.id.toLowerCase() === model.id.toLowerCase(),
                  );

                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={`api-model-combobox-option ${
                        isSelected ? "selected" : ""
                      } ${isHighlighted ? "highlighted" : ""}${
                        isGrouped ? " api-model-combobox-model" : ""
                      }`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={(event) => {
                        // Prevent the wrapping <label> from forwarding the
                        // click to the input (which would re-open the menu
                        // via onFocus/onClick after the option is unmounted).
                        event.preventDefault();
                        handleSelectModel(model.id);
                      }}
                      role="option"
                      aria-selected={isSelected}
                      title={model.id}
                    >
                      <span className="api-model-combobox-option-main">
                        <ModelBrandIcon
                          model={model.id}
                          size={16}
                          className="api-model-combobox-option-icon"
                        />
                        <span className="api-model-combobox-option-name">
                          {model.id}
                        </span>
                        {known?.alias ? (
                          <span className="api-model-combobox-option-alias">
                            {known.alias}
                          </span>
                        ) : null}
                        {known?.preview ? (
                          <span className="api-model-combobox-badge preview">
                            {previewBadgeText ?? "Preview"}
                          </span>
                        ) : null}
                        {known?.deprecated ? (
                          <span className="api-model-combobox-badge deprecated">
                            {deprecatedBadgeText ?? "Deprecated"}
                          </span>
                        ) : null}
                      </span>
                      {isSelected && <Check size={14} />}
                    </button>
                  );
                })}
              </div>
            )}

            {shouldShowEmpty && (
              <div className="api-model-combobox-message">{noModelsText}</div>
            )}
          </div>
        )}
      </div>
    </label>
  );
}
