import type { JSX, ReactNode } from "react";
import { useI18n } from "../../../../i18n";
import {
  sanitizeBrowserDisplayValue,
  formatBrowserDisplayJson,
} from "./browserToolPresentation";

export const EXTENDED_BROWSER_OPERATIONS = [
  "emulate",
  "resize_page",
  "performance_start_trace",
  "performance_stop_trace",
  "performance_analyze_insight",
  "get_css_styles",
  "audit",
  "take_heapsnapshot",
  "get_heapsnapshot_summary",
  "query_heapsnapshot_objects",
  "get_heapsnapshot_object_details",
  "get_heapsnapshot_edges",
  "get_heapsnapshot_retainers",
  "get_heapsnapshot_retaining_paths",
  "get_heapsnapshot_duplicate_strings",
  "compare_heapsnapshots",
  "screencast_start",
  "screencast_stop",
  "list_page_tools",
  "call_page_tool",
  "get_tab_content",
  "frames",
] as const;

export type ExtendedBrowserOperation =
  (typeof EXTENDED_BROWSER_OPERATIONS)[number];
export type BrowserTranslate = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

type Data = Record<string, unknown>;
type ViewProps = { data: Data; args: Data; t: BrowserTranslate };
const PREFIX = "toolCall.browser.extended.";
const ROW_LIMIT = 40;
const TEXT_LIMIT = 16000;
const CELL_LIMIT = 600;
const record = (value: unknown): Data =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const tr = (
  t: BrowserTranslate,
  key: string,
  values?: Record<string, string | number>,
) => t(`${PREFIX}${key}`, values ? { values } : undefined);

/** Every raw value passes the shared presentation-only sanitizer. Never mutate stored results. */
const text = (value: unknown, limit = CELL_LIMIT): string => {
  const safe = sanitizeBrowserDisplayValue(value);
  const result =
    typeof safe === "string" ? safe : formatBrowserDisplayJson(safe);
  return result.length > limit ? `${result.slice(0, limit)}…` : result;
};
const label = (t: BrowserTranslate, key: string) =>
  t(`${PREFIX}field.${key}`, { defaultValue: text(key, 100) });
const cell = (value: unknown, t: BrowserTranslate): string => {
  if (value === undefined) return "—";
  if (value === null) return tr(t, "resultEmpty");
  if (typeof value === "boolean") return tr(t, value ? "yes" : "no");
  return text(value);
};

function Empty({
  t,
  content = false,
}: {
  t: BrowserTranslate;
  content?: boolean;
}): JSX.Element {
  return (
    <p className="tool-call-section-text">
      {tr(t, content ? "noContent" : "resultEmpty")}
    </p>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="tool-call-section">
      <span className="tool-call-section-label">{title}</span>
      {children}
    </section>
  );
}
function Notice({
  t,
  total,
  shown,
  more = false,
}: {
  t: BrowserTranslate;
  total: number;
  shown: number;
  more?: boolean;
}): JSX.Element | null {
  if (total > shown)
    return (
      <p className="tool-call-section-text">
        {tr(t, "truncated", { shown, total })}
      </p>
    );
  return more ? (
    <p className="tool-call-section-text">{tr(t, "moreAvailable")}</p>
  ) : null;
}
function Fields({
  data,
  keys,
  t,
}: {
  data: Data;
  keys: readonly string[];
  t: BrowserTranslate;
}): JSX.Element {
  const present = keys.filter((key) => data[key] !== undefined);
  return present.length ? (
    <dl className="tool-call-tags">
      {present.map((key) => (
        <div className="tool-call-tag" key={key}>
          <dt>{label(t, key)}</dt>
          <dd>{cell(data[key], t)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <Empty t={t} />
  );
}
function Table({
  items,
  columns,
  t,
  total,
  more = false,
}: {
  items: unknown;
  columns: readonly string[];
  t: BrowserTranslate;
  total?: number;
  more?: boolean;
}): JSX.Element {
  const all = rows(items);
  const shown = all.slice(0, ROW_LIMIT);
  return (
    <>
      {shown.length ? (
        <div className="tool-call-section-pre">
          <table>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key} scope="col">
                    {label(t, key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((item, i) => (
                <tr key={i}>
                  {columns.map((key) => (
                    <td key={key}>
                      {key === "isMainFrame" &&
                      typeof record(item)[key] === "boolean"
                        ? tr(t, record(item)[key] ? "mainFrame" : "childFrame")
                        : cell(record(item)[key], t)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty t={t} />
      )}
      <Notice
        t={t}
        total={total ?? all.length}
        shown={shown.length}
        more={more}
      />
    </>
  );
}
function TextBlock({
  value,
  t,
}: {
  value: unknown;
  t: BrowserTranslate;
}): JSX.Element {
  const safe = sanitizeBrowserDisplayValue(value);
  if (typeof safe !== "string" || !safe.length) return <Empty t={t} content />;
  return (
    <>
      <pre className="tool-call-section-pre">{text(safe, TEXT_LIMIT)}</pre>
      {safe.length > TEXT_LIMIT ? (
        <p className="tool-call-section-text">
          {tr(t, "textTruncated", { shown: TEXT_LIMIT })}
        </p>
      ) : null}
    </>
  );
}
function Details({
  value,
  t,
}: {
  value: unknown;
  t: BrowserTranslate;
}): JSX.Element {
  return (
    <details className="tool-call-section">
      <summary className="tool-call-section-label">
        {tr(t, "technicalDetails")}
      </summary>
      <pre className="tool-call-section-pre">
        {formatBrowserDisplayJson(value)}
      </pre>
    </details>
  );
}

/** Arbitrary page-tool results have a typed value/table view; JSON remains optional detail. */
function PageToolResult({
  value,
  t,
}: {
  value: unknown;
  t: BrowserTranslate;
}): JSX.Element {
  if (value === null || value === undefined) return <Empty t={t} />;
  if (typeof value === "string") return <TextBlock value={value} t={t} />;
  if (Array.isArray(value)) {
    const objectRows = value.every(
      (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
    if (objectRows && value.length) {
      const allKeys = [
        ...new Set(value.flatMap((item) => Object.keys(record(item)))),
      ];
      const keys = allKeys.slice(0, 10);
      return (
        <>
          <Table items={value} columns={keys} t={t} />
          <Notice t={t} shown={keys.length} total={allKeys.length} />
        </>
      );
    }
    return (
      <Table
        items={value.map((item, index) => ({ index, value: item }))}
        columns={["index", "value"]}
        t={t}
      />
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(record(value));
    return (
      <Table
        items={entries.map(([name, value]) => ({ name, value }))}
        columns={["name", "value"]}
        t={t}
      />
    );
  }
  return <p className="tool-call-section-text">{cell(value, t)}</p>;
}
function PageView({
  operation,
  data,
  args,
  t,
}: ViewProps & { operation: ExtendedBrowserOperation }): JSX.Element {
  if (operation === "get_tab_content")
    return (
      <Section title={tr(t, "pageContent")}>
        <TextBlock value={data.content} t={t} />
      </Section>
    );
  if (operation === "frames")
    return (
      <Section title={tr(t, "frames")}>
        <Table
          items={data.frames}
          columns={["frameId", "parentFrameId", "isMainFrame", "name", "url"]}
          t={t}
        />
        {rows(data.unavailable).length ? (
          <Section title={tr(t, "partialFailure")}>
            <Table
              items={data.unavailable}
              columns={["frameTreeNodeId", "error"]}
              t={t}
            />
          </Section>
        ) : null}
      </Section>
    );
  if (operation === "call_page_tool")
    return (
      <Section title={tr(t, "toolResult")}>
        <Fields data={args} keys={["name"]} t={t} />
        <PageToolResult value={data.result} t={t} />
      </Section>
    );
  const tools = rows(data.tools);
  return (
    <Section title={tr(t, "pageTools")}>
      {tools.length ? (
        tools.slice(0, ROW_LIMIT).map((item, index) => {
          const tool = record(item);
          return (
            <Section title={text(tool.name)} key={index}>
              <TextBlock value={tool.description} t={t} />
              {tool.parameters !== null && tool.parameters !== undefined ? (
                <details>
                  <summary>{tr(t, "parameters")}</summary>
                  <pre className="tool-call-section-pre">
                    {formatBrowserDisplayJson(tool.parameters)}
                  </pre>
                </details>
              ) : null}
            </Section>
          );
        })
      ) : (
        <Empty t={t} />
      )}
      <Notice
        t={t}
        total={number(data.total) ?? tools.length}
        shown={Math.min(ROW_LIMIT, tools.length)}
      />
    </Section>
  );
}

const EMULATION_KEYS = [
  "colorScheme",
  "cpuThrottlingRate",
  "networkConditions",
  "userAgent",
  "extraHttpHeaders",
] as const;
function EmulationView({
  operation,
  data,
  t,
}: ViewProps & { operation: ExtendedBrowserOperation }): JSX.Element {
  if (operation === "resize_page")
    return (
      <Section title={tr(t, "viewport")}>
        <Fields data={data} keys={["width", "height"]} t={t} />
      </Section>
    );
  return (
    <Section title={tr(t, "emulation")}>
      {EMULATION_KEYS.some((key) => data[key] !== undefined) ? (
        <Fields data={data} keys={EMULATION_KEYS} t={t} />
      ) : null}
      {"geolocation" in data ? (
        <Section title={label(t, "geolocation")}>
          {data.geolocation === null ? (
            <p>{tr(t, "cleared")}</p>
          ) : (
            <Fields
              data={record(data.geolocation)}
              keys={["latitude", "longitude", "accuracy"]}
              t={t}
            />
          )}
        </Section>
      ) : null}
      {"viewport" in data ? (
        <Section title={tr(t, "viewport")}>
          {data.viewport === null ? (
            <p>{tr(t, "cleared")}</p>
          ) : (
            <Fields
              data={record(data.viewport)}
              keys={[
                "width",
                "height",
                "deviceScaleFactor",
                "mobile",
                "touch",
                "landscape",
              ]}
              t={t}
            />
          )}
        </Section>
      ) : null}
      {!EMULATION_KEYS.some((key) => key in data) &&
      !("geolocation" in data) &&
      !("viewport" in data) ? (
        <Empty t={t} />
      ) : null}
    </Section>
  );
}

function PerformanceView({
  operation,
  data,
  args,
  t,
}: ViewProps & { operation: ExtendedBrowserOperation }): JSX.Element {
  if (operation === "performance_start_trace")
    return (
      <Section
        title={tr(t, data.started === true ? "tracing" : "resultUnavailable")}
      >
        <Fields data={data} keys={["startedAt", "categories"]} t={t} />
      </Section>
    );
  if (operation === "performance_analyze_insight") {
    const detail = record(data.detail);
    return (
      <Section title={tr(t, "insight")}>
        <p className="tool-call-section-text">{text(args.insightId)}</p>
        {data.found === false ? (
          <Empty t={t} />
        ) : (
          <>
            <Fields
              data={detail}
              keys={[
                "fcpMs",
                "timeMs",
                "size",
                "score",
                "firstResponseMs",
                "note",
              ]}
              t={t}
            />
            {"tasks" in detail ? (
              <Section title={tr(t, "tasks")}>
                <Table
                  items={detail.tasks}
                  columns={["startMs", "durationMs"]}
                  t={t}
                />
              </Section>
            ) : null}
            {"shifts" in detail ? (
              <Section title={tr(t, "shifts")}>
                <Table
                  items={detail.shifts}
                  columns={["startMs", "score", "hadRecentInput"]}
                  t={t}
                />
              </Section>
            ) : null}
          </>
        )}
      </Section>
    );
  }
  const metrics = record(data.metrics);
  return (
    <>
      <Section title={tr(t, "metrics")}>
        <Fields
          data={data}
          keys={["durationMs", "eventCount", "savedTo"]}
          t={t}
        />
        <Fields
          data={{ ...metrics, lcpMs: record(metrics.lcp).timeMs }}
          keys={[
            "fcpMs",
            "lcpMs",
            "cls",
            "loadMs",
            "domContentLoadedMs",
            "firstResponseMs",
          ]}
          t={t}
        />
      </Section>
      <Section title={tr(t, "longTasks")}>
        <Fields
          data={record(data.longTasks)}
          keys={["count", "totalMs", "longestMs"]}
          t={t}
        />
      </Section>
      <Section title={tr(t, "insights")}>
        <Table
          items={data.insights}
          columns={["id", "title", "summary"]}
          t={t}
        />
      </Section>
      <Section title={tr(t, "events")}>
        <Table items={data.topEventTypes} columns={["name", "count"]} t={t} />
      </Section>
      {typeof data.note === "string" ? (
        <TextBlock value={data.note} t={t} />
      ) : null}
    </>
  );
}

function Declarations({
  value,
  t,
}: {
  value: unknown;
  t: BrowserTranslate;
}): JSX.Element {
  const all = rows(value);
  return (
    <>
      {all.length ? (
        <ul>
          {all.slice(0, ROW_LIMIT).map((item, index) => {
            const declaration = record(item);
            const content = (
              <code>
                {text(declaration.name)}: {text(declaration.value)}
              </code>
            );
            return (
              <li key={index}>
                {declaration.overloaded === true ? (
                  <del>{content}</del>
                ) : (
                  content
                )}
                {declaration.important === true ? (
                  <span className="tool-call-tag">{tr(t, "important")}</span>
                ) : null}
                {declaration.overloaded === true ? (
                  <span className="tool-call-tag">{tr(t, "overloaded")}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty t={t} />
      )}
      <Notice
        t={t}
        shown={Math.min(ROW_LIMIT, all.length)}
        total={all.length}
      />
    </>
  );
}
function CssView({ data, t }: ViewProps): JSX.Element {
  const rules = rows(data.rules);
  const inherited = rows(data.inherited);
  return (
    <>
      <Fields data={data} keys={["totalRules", "pageIdx"]} t={t} />
      <Section title={tr(t, "inline")}>
        <Declarations value={data.inline} t={t} />
      </Section>
      <Section title={tr(t, "rules")}>
        {rules.length ? (
          rules.slice(0, ROW_LIMIT).map((item, index) => {
            const rule = record(item);
            return (
              <Section title={text(rule.selector)} key={index}>
                <Fields data={rule} keys={["origin", "media"]} t={t} />
                {rule.source ? (
                  <Fields
                    data={record(rule.source)}
                    keys={["url", "line"]}
                    t={t}
                  />
                ) : null}
                <Declarations value={rule.properties} t={t} />
              </Section>
            );
          })
        ) : (
          <Empty t={t} />
        )}
        <Notice
          t={t}
          total={number(data.totalRules) ?? rules.length}
          shown={Math.min(ROW_LIMIT, rules.length)}
          more={data.hasMore === true}
        />
      </Section>
      <Section title={tr(t, "inherited")}>
        {inherited.length ? (
          inherited.slice(0, ROW_LIMIT).map((item, index) => {
            const level = record(item);
            return (
              <Section title={text(level.selector)} key={index}>
                <Fields data={level} keys={["level"]} t={t} />
                <Declarations value={level.properties} t={t} />
              </Section>
            );
          })
        ) : (
          <Empty t={t} />
        )}
        <Notice
          t={t}
          shown={Math.min(ROW_LIMIT, inherited.length)}
          total={inherited.length}
        />
      </Section>
      <Section title={tr(t, "computed")}>
        <Table
          items={Object.entries(record(data.computed)).map(([name, value]) => ({
            name,
            value,
          }))}
          columns={["name", "value"]}
          t={t}
        />
      </Section>
    </>
  );
}
function AuditView({ data, t }: ViewProps): JSX.Element {
  const accessibility = record(data.accessibility);
  const violations = rows(accessibility.violations);
  return (
    <>
      <Fields data={data} keys={["consoleErrors"]} t={t} />
      {"accessibility" in data ? (
        <Section title={tr(t, "accessibility")}>
          <Fields
            data={accessibility}
            keys={[
              "engine",
              "version",
              "violationCount",
              "passesCount",
              "incompleteCount",
            ]}
            t={t}
          />
          {violations.length ? (
            violations.slice(0, ROW_LIMIT).map((item, index) => {
              const violation = record(item);
              return (
                <Section title={text(violation.id)} key={index}>
                  <Fields
                    data={violation}
                    keys={["impact", "help", "nodeCount"]}
                    t={t}
                  />
                  <Table
                    items={violation.nodes}
                    columns={["target", "failureSummary"]}
                    t={t}
                    total={number(violation.nodeCount)}
                  />
                </Section>
              );
            })
          ) : (
            <Empty t={t} />
          )}
          <Notice
            t={t}
            shown={Math.min(ROW_LIMIT, violations.length)}
            total={violations.length}
          />
        </Section>
      ) : null}
      {(["seo", "bestPractices"] as const)
        .filter((key) => key in data)
        .map((key) => (
          <Section title={tr(t, key)} key={key}>
            <Fields data={record(data[key])} keys={["issueCount"]} t={t} />
            <Table
              items={record(data[key]).checks}
              columns={["id", "severity", "message"]}
              t={t}
            />
          </Section>
        ))}
    </>
  );
}

const NODE_COLUMNS = [
  "index",
  "id",
  "name",
  "type",
  "selfSize",
  "detachedness",
] as const;
function HeapView({
  operation,
  data,
  t,
}: ViewProps & { operation: ExtendedBrowserOperation }): JSX.Element {
  const metadata = (
    <Fields
      data={data}
      keys={[
        "file",
        "bytes",
        "nodeIndex",
        "total",
        "pageIdx",
        "scanned",
        "maxDepth",
        "note",
      ]}
      t={t}
    />
  );
  switch (operation) {
    case "take_heapsnapshot":
      return <Section title={tr(t, "snapshot")}>{metadata}</Section>;
    case "get_heapsnapshot_summary":
      return (
        <>
          <Section title={tr(t, "snapshot")}>
            <Fields
              data={data}
              keys={[
                "file",
                "nodeCount",
                "edgeCount",
                "totalSelfSize",
                "detachedCount",
              ]}
              t={t}
            />
          </Section>
          <Section title={tr(t, "topConstructors")}>
            <Table
              items={data.topConstructors}
              columns={["name", "count", "selfSize"]}
              t={t}
            />
          </Section>
          <Section title={tr(t, "topTypes")}>
            <Table
              items={data.topTypes}
              columns={["name", "count", "selfSize"]}
              t={t}
            />
          </Section>
        </>
      );
    case "get_heapsnapshot_object_details":
      return (
        <Section title={tr(t, "objectDetails")}>
          <Fields
            data={data}
            keys={[...NODE_COLUMNS, "edgeCount", "retainerCount", "nodeCount"]}
            t={t}
          />
        </Section>
      );
    case "get_heapsnapshot_retaining_paths": {
      const paths = rows(data.paths);
      return (
        <Section title={tr(t, "paths")}>
          {metadata}
          {paths.length ? (
            paths.slice(0, ROW_LIMIT).map((item, index) => {
              const path = record(item);
              return (
                <Section
                  title={`${index + 1} · ${tr(t, path.reachedRoot === true ? "reachedRoot" : "rootNotReached")}`}
                  key={index}
                >
                  <Table items={path.nodes} columns={NODE_COLUMNS} t={t} />
                </Section>
              );
            })
          ) : (
            <Empty t={t} />
          )}
          <Notice
            t={t}
            shown={Math.min(ROW_LIMIT, paths.length)}
            total={paths.length}
          />
        </Section>
      );
    }
    case "get_heapsnapshot_duplicate_strings":
      return (
        <Section title={tr(t, "duplicates")}>
          <Fields
            data={data}
            keys={["file", "stringCount", "topWastedBytes"]}
            t={t}
          />
          <Table
            items={data.duplicates}
            columns={["value", "count", "wastedBytes"]}
            t={t}
          />
        </Section>
      );
    case "compare_heapsnapshots":
      return (
        <>
          <Fields data={data} keys={["baseFile", "currentFile"]} t={t} />
          {(["base", "current"] as const).map((key) => (
            <Section title={tr(t, key)} key={key}>
              <Fields
                data={record(data[key])}
                keys={["nodeCount", "edgeCount"]}
                t={t}
              />
            </Section>
          ))}
          {(["growth", "shrink"] as const).map((key) => (
            <Section title={tr(t, key)} key={key}>
              <Table
                items={data[key]}
                columns={[
                  "name",
                  "baseCount",
                  "currentCount",
                  "deltaCount",
                  "deltaSelfSize",
                ]}
                t={t}
              />
            </Section>
          ))}
        </>
      );
    default: {
      const kind =
        operation === "get_heapsnapshot_edges"
          ? "edges"
          : operation === "get_heapsnapshot_retainers"
            ? "retainers"
            : "objects";
      const columns =
        kind === "edges"
          ? ["type", "name", "toIndex", "toName", "toType"]
          : kind === "retainers"
            ? [...NODE_COLUMNS, "edgeCount", "via"]
            : NODE_COLUMNS;
      return (
        <Section title={tr(t, kind)}>
          {metadata}
          <Table
            items={data.rows}
            columns={columns}
            t={t}
            total={number(data.total)}
            more={data.hasMore === true}
          />
        </Section>
      );
    }
  }
}
function ScreencastView({
  operation,
  data,
  args,
  t,
}: ViewProps & { operation: ExtendedBrowserOperation }): JSX.Element {
  return (
    <Section
      title={tr(
        t,
        operation === "screencast_start" && data.started === true
          ? "recording"
          : "screencast",
      )}
    >
      <Fields
        data={data}
        keys={[
          "file",
          "startedAt",
          "frames",
          "durationMs",
          "bytes",
          "fps",
          "width",
          "height",
          "format",
          "note",
        ]}
        t={t}
      />
      {operation === "screencast_start" ? (
        <Fields
          data={args}
          keys={["quality", "maxWidth", "maxFrames", "maxDurationMs"]}
          t={t}
        />
      ) : null}
    </Section>
  );
}

export function BrowserExtendedResult({
  operation,
  args,
  data,
}: {
  operation: ExtendedBrowserOperation;
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): JSX.Element {
  const { t } = useI18n();
  if (data === null)
    return (
      <Section title={tr(t, "resultUnavailable")}>
        <Empty t={t} />
      </Section>
    );
  // Sanitize complete objects first to retain field context (e.g. headers and URL queries).
  const safeData = record(sanitizeBrowserDisplayValue(data));
  const safeArgs = record(sanitizeBrowserDisplayValue(args));
  const props = { data: safeData, args: safeArgs, t, operation };
  let body: ReactNode;
  switch (operation) {
    case "get_tab_content":
    case "frames":
    case "list_page_tools":
    case "call_page_tool":
      body = <PageView {...props} />;
      break;
    case "emulate":
    case "resize_page":
      body = <EmulationView {...props} />;
      break;
    case "performance_start_trace":
    case "performance_stop_trace":
    case "performance_analyze_insight":
      body = <PerformanceView {...props} />;
      break;
    case "get_css_styles":
      body = <CssView {...props} />;
      break;
    case "audit":
      body = <AuditView {...props} />;
      break;
    case "screencast_start":
    case "screencast_stop":
      body = <ScreencastView {...props} />;
      break;
    default:
      body = <HeapView {...props} />;
  }
  return (
    <>
      <Section title={tr(t, "metadata")}>
        <Fields
          data={safeData}
          keys={["title", "url", "frameId", "instanceId"]}
          t={t}
        />
      </Section>
      {safeData.ok === false || safeData.started === false ? (
        <p className="tool-call-error">{tr(t, "failed")}</p>
      ) : null}
      {body}
      <Details value={safeData} t={t} />
    </>
  );
}

export function getBrowserExtendedSummary(
  operation: string,
  args: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  t: BrowserTranslate,
): string | undefined {
  if (
    !(EXTENDED_BROWSER_OPERATIONS as readonly string[]).includes(operation) ||
    !data
  )
    return undefined;
  const d = record(sanitizeBrowserDisplayValue(data));
  const a = record(sanitizeBrowserDisplayValue(args));
  if (d.ok === false || d.started === false) return tr(t, "failed");
  const count = (key: string, value: number) => tr(t, key, { count: value });
  let summary: string;
  switch (operation) {
    case "get_tab_content":
      summary = count(
        "textSummary",
        typeof d.content === "string" ? d.content.length : 0,
      );
      break;
    case "frames":
      summary = rows(d.unavailable).length
        ? tr(t, "partialFailure")
        : count("frameSummary", rows(d.frames).length);
      break;
    case "list_page_tools":
      summary = count("toolSummary", number(d.total) ?? rows(d.tools).length);
      break;
    case "call_page_tool":
      summary =
        typeof a.name === "string"
          ? `${text(a.name, 80)} · ${tr(t, "completed")}`
          : tr(t, "completed");
      break;
    case "resize_page":
      summary =
        number(d.width) !== undefined && number(d.height) !== undefined
          ? `${d.width} × ${d.height}`
          : tr(t, "completed");
      break;
    case "emulate":
      summary = count(
        "settingsSummary",
        [...EMULATION_KEYS, "geolocation", "viewport"].filter((key) => key in d)
          .length,
      );
      break;
    case "performance_start_trace":
      summary = tr(t, d.started === true ? "tracing" : "resultUnavailable");
      break;
    case "performance_stop_trace":
      summary = tr(t, "traceSummary", {
        count: number(d.eventCount) ?? 0,
        duration: number(d.durationMs) ?? 0,
      });
      break;
    case "performance_analyze_insight":
      summary =
        d.found === false
          ? tr(t, "resultEmpty")
          : text(a.insightId ?? tr(t, "insight"), 100);
      break;
    case "get_css_styles":
      summary =
        d.found === false
          ? tr(t, "resultEmpty")
          : count("cssSummary", number(d.totalRules) ?? rows(d.rules).length);
      break;
    case "audit":
      summary = count(
        "auditSummary",
        (number(record(d.accessibility).violationCount) ?? 0) +
          (number(record(d.seo).issueCount) ?? 0) +
          (number(record(d.bestPractices).issueCount) ?? 0),
      );
      break;
    case "take_heapsnapshot":
      summary = `${number(d.bytes) ?? 0} B`;
      break;
    case "get_heapsnapshot_summary":
      summary = tr(t, "heapSummary", {
        count: number(d.nodeCount) ?? 0,
        bytes: number(d.totalSelfSize) ?? 0,
      });
      break;
    case "query_heapsnapshot_objects":
    case "get_heapsnapshot_edges":
    case "get_heapsnapshot_retainers":
      summary = count("countSummary", number(d.total) ?? rows(d.rows).length);
      break;
    case "get_heapsnapshot_object_details":
      summary = `${text(d.name ?? d.index, 80)} · ${number(d.selfSize) ?? 0} B`;
      break;
    case "get_heapsnapshot_retaining_paths":
      summary = count("countSummary", rows(d.paths).length);
      break;
    case "get_heapsnapshot_duplicate_strings":
      summary = count("countSummary", rows(d.duplicates).length);
      break;
    case "compare_heapsnapshots":
      summary = `${tr(t, "growth")} ${rows(d.growth).length} · ${tr(t, "shrink")} ${rows(d.shrink).length}`;
      break;
    case "screencast_start":
      summary = tr(t, d.started === true ? "recording" : "resultUnavailable");
      break;
    case "screencast_stop":
      summary = tr(t, "recordingSummary", {
        count: number(d.frames) ?? 0,
        duration: number(d.durationMs) ?? 0,
      });
      break;
    default:
      return undefined;
  }
  return text(summary, 180);
}
