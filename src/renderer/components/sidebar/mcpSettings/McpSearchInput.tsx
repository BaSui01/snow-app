import { Search, X } from "lucide-react";
import { useI18n } from "../../../i18n";

type McpSearchInputProps = {
  value: string;
  placeholder: string;
  className?: string;
  onChange: (value: string) => void;
};

/** 统一的 MCP 列表搜索框（复用工具筛选框样式）。 */
export function McpSearchInput({
  value,
  placeholder,
  className,
  onChange,
}: McpSearchInputProps): React.JSX.Element {
  const { t } = useI18n();
  const clearLabel = t("settings.mcpToolFilterClear", {
    defaultValue: "Clear filter",
  });
  return (
    <div
      className={`mcp-tool-details-search mcp-list-search${
        className ? ` ${className}` : ""
      }`}
    >
      <Search size={13} strokeWidth={1.9} />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // 位于表单内时回车不应触发提交
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="mcp-tool-details-search-clear"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          title={clearLabel}
        >
          <X size={12} strokeWidth={1.9} />
        </button>
      ) : null}
    </div>
  );
}

/** 不区分大小写的多字段包含匹配；空查询视为全部匹配。 */
export const matchesMcpQuery = (
  query: string,
  ...fields: Array<string | null | undefined>
): boolean => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return fields.some((field) => field?.toLowerCase().includes(normalized));
};
