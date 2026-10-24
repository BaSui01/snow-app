import { useMemo, useState } from "react";
import { useI18n } from "../../../../../i18n";

const PAGE_SIZE = 40;

type Collection = Record<string, unknown> | unknown[];

const isCollection = (value: unknown): value is Collection =>
  typeof value === "object" && value !== null;

const AUTO_PARSE_TEXT_LIMIT = 256 * 1024;

const ResultValue = ({
  value,
  ancestors,
}: {
  value: unknown;
  ancestors: readonly Collection[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [requestedText, setRequestedText] = useState<string | null>(null);
  const display = useMemo(() => {
    if (typeof value !== "string" || !/^\s*[\[{]/.test(value)) {
      return { value, deferred: false };
    }
    if (value.length > AUTO_PARSE_TEXT_LIMIT && requestedText !== value) {
      return { value: undefined, deferred: true };
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (isCollection(parsed)) return { value: parsed, deferred: false };
    } catch {
      // Non-JSON text retains its original content and React escaping.
    }
    return { value, deferred: false };
  }, [value, requestedText]);

  if (display.deferred) {
    return (
      <button
        type="button"
        className="tool-result-button"
        onClick={() => setRequestedText(value as string)}
      >
        {t("toolResults.loadStructured")}
      </button>
    );
  }

  const displayValue = display.value;
  if (isCollection(displayValue)) {
    if (ancestors.includes(displayValue)) {
      return (
        <span className="tool-result-empty">{t("toolResults.circular")}</span>
      );
    }

    const count = Array.isArray(displayValue)
      ? displayValue.length
      : Object.keys(displayValue).length;

    return (
      <details
        className="tool-result-details"
        onToggle={(event) => {
          if (event.target === event.currentTarget) {
            setExpanded(event.currentTarget.open);
          }
        }}
      >
        <summary className="tool-result-summary">
          {t(
            Array.isArray(displayValue)
              ? "toolResults.items"
              : "toolResults.fields",
            { values: { count } },
          )}
        </summary>
        {expanded ? (
          <ResultCollection value={displayValue} ancestors={ancestors} />
        ) : null}
      </details>
    );
  }

  const text =
    displayValue === null
      ? "null"
      : displayValue === undefined
        ? "undefined"
        : displayValue === ""
          ? t("toolResults.emptyString")
          : String(displayValue);

  return <div className="tool-result-value">{text}</div>;
};

const ResultCollection = ({
  value,
  ancestors,
}: {
  value: Collection;
  ancestors: readonly Collection[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const isList = Array.isArray(value);
  const keys = useMemo(
    () => (isList ? [] : Object.keys(value)),
    [value, isList],
  );
  const count = isList ? value.length : keys.length;
  const lastPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, count);
  const lineage = useMemo(() => [...ancestors, value], [ancestors, value]);

  if (count === 0) {
    return (
      <div className="tool-result-empty">
        {t(isList ? "toolResults.emptyList" : "toolResults.emptyObject")}
      </div>
    );
  }

  return (
    <div className="tool-result-collection">
      <dl className="tool-result-fields">
        {Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          const key = isList ? String(index) : keys[index];
          const child = isList
            ? value[index]
            : (value as Record<string, unknown>)[key];
          return (
            <div className="tool-result-field" key={key}>
              <dt className="tool-result-key">
                {isList
                  ? t("toolResults.item", { values: { index: index + 1 } })
                  : key || t("toolResults.emptyKey")}
              </dt>
              <dd className="tool-result-field-value">
                <ResultValue value={child} ancestors={lineage} />
              </dd>
            </div>
          );
        })}
      </dl>
      {count > PAGE_SIZE ? (
        <nav
          className="tool-result-pagination"
          aria-label={t("toolResults.pages")}
        >
          <button
            type="button"
            className="tool-result-button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("toolResults.previous")}
          </button>
          <span className="tool-result-range" aria-live="polite">
            {t("toolResults.range", {
              values: { start: start + 1, end, count },
            })}
          </span>
          <button
            type="button"
            className="tool-result-button"
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("toolResults.next")}
          </button>
        </nav>
      ) : null}
    </div>
  );
};

const ROOT_ANCESTORS: readonly Collection[] = [];

/** Displays every field without interpreting tool-specific status or metadata. */
export const ToolResultView = ({
  value,
}: {
  value: unknown;
}): React.JSX.Element => (
  <div className="tool-result-view">
    {isCollection(value) ? (
      <ResultCollection value={value} ancestors={ROOT_ANCESTORS} />
    ) : (
      <ResultValue value={value} ancestors={ROOT_ANCESTORS} />
    )}
  </div>
);
