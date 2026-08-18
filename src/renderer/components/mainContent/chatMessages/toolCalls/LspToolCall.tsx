import { useMemo } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Crosshair,
  FileCode,
  Hash,
  Languages,
  ListPlus,
  Loader2,
  PencilLine,
  ScanSearch,
  ShieldAlert,
  Sigma,
  Wand2,
  XCircle,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type LspToolCallProps = {
  toolCall: ToolCallInfo;
};

type LspOperation =
  | "diagnostics"
  | "completion"
  | "rename"
  | "code-action"
  | "signature-help"
  | "type-definition"
  | "implementation"
  | "workspace-symbols"
  | "call-hierarchy"
  | "type-hierarchy"
  | "execute-command";

// ---- Args types（与 native/src/mcp/servers/lsp/mod.rs 的 input_schema 对齐）----

type PositionArgs = { filePath: string; line: number; column: number };
type RenameArgs = PositionArgs & { newName?: string; dryRun?: boolean };
type CodeActionArgs = PositionArgs & { only?: string[]; apply?: boolean };
type WorkspaceSymbolsArgs = { query: string };
type DiagnosticsArgs = { filePath?: string; filePaths?: string[] };
type ParsedArgs =
  | PositionArgs
  | RenameArgs
  | CodeActionArgs
  | WorkspaceSymbolsArgs
  | DiagnosticsArgs
  | null;

// ---- Result types（与 native/src/mcp/servers/lsp/format.rs 输出对齐）----

type CompletionItem = {
  label: string;
  kind?: string;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
};

type EditInfo = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

type WorkspaceFile = {
  uri: string;
  editCount: number;
  edits?: EditInfo[];
  applied?: boolean;
};

type CodeActionItem = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  hasEdit: boolean;
  command?: { command: string; title?: string; arguments?: unknown[] };
};

type AppliedAction = {
  title: string;
  kind?: string;
  changeCount: number;
  files: WorkspaceFile[];
};

type DeferredCommand = {
  title: string;
  command?: string;
  arguments?: unknown[];
  executed: boolean;
  note?: string;
};

type SignatureParameter = { label: string; documentation?: string };
type SignatureInfo = {
  label: string;
  documentation?: string;
  parameters: SignatureParameter[];
};

type DefinitionItem = {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};

type WorkspaceSymbolItem = {
  name: string;
  kind?: string;
  detail?: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type HierarchyItem = {
  name: string;
  kind?: string;
  detail?: string;
  filePath?: string;
  line?: number;
  column?: number;
};

type HierarchyCall = {
  caller?: HierarchyItem;
  callee?: HierarchyItem;
  callSites: {
    filePath: string;
    line: number;
    column: number;
    context?: string;
  }[];
};

type DiagnosticItem = {
  severity?: string;
  message: string;
  source?: string;
  code?: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
};

type BatchDiagnosticsFile = {
  filePath: string;
  language?: string;
  summary?: string;
  diagnostics?: DiagnosticItem[];
  error?: string;
};

type ParsedResult =
  | {
      type: "diagnostics";
      language?: string;
      filePath?: string;
      summary?: string;
      count: number;
      diagnostics: DiagnosticItem[];
    }
  | {
      type: "diagnostics-batch";
      fileCount: number;
      files: BatchDiagnosticsFile[];
    }
  | {
      type: "completion";
      language?: string;
      isIncomplete: boolean;
      count: number;
      total: number;
      items: CompletionItem[];
    }
  | {
      type: "rename";
      language?: string;
      applied: boolean;
      dryRun: boolean;
      changeCount: number;
      files: WorkspaceFile[];
    }
  | {
      type: "code-action";
      language?: string;
      apply: boolean;
      actions: CodeActionItem[];
      appliedCount: number;
      applied: AppliedAction[];
      deferred: DeferredCommand[];
    }
  | {
      type: "signature-help";
      language?: string;
      count: number;
      signatures: SignatureInfo[];
      activeSignature: number | null;
      activeParameter: number | null;
    }
  | {
      type: "definition-jump";
      language?: string;
      name?: string;
      count: number;
      definitions: DefinitionItem[];
    }
  | {
      type: "workspace-symbols";
      language?: string;
      query?: string;
      count: number;
      total: number;
      symbols: WorkspaceSymbolItem[];
    }
  | {
      type: "call-hierarchy";
      language?: string;
      symbol?: string;
      incomingCount: number;
      outgoingCount: number;
      incoming: HierarchyCall[];
      outgoing: HierarchyCall[];
    }
  | {
      type: "type-hierarchy";
      language?: string;
      symbol?: string;
      supertypesCount: number;
      subtypesCount: number;
      supertypes: HierarchyItem[];
      subtypes: HierarchyItem[];
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const BADGE_KEYS: Record<LspOperation, string> = {
  diagnostics: "toolCall.lsp.op.diagnostics",
  completion: "toolCall.lsp.op.completion",
  rename: "toolCall.lsp.op.rename",
  "code-action": "toolCall.lsp.op.code-action",
  "signature-help": "toolCall.lsp.op.signature-help",
  "type-definition": "toolCall.lsp.op.type-definition",
  implementation: "toolCall.lsp.op.implementation",
  "workspace-symbols": "toolCall.lsp.op.workspace-symbols",
  "call-hierarchy": "toolCall.lsp.op.call-hierarchy",
  "type-hierarchy": "toolCall.lsp.op.type-hierarchy",
  "execute-command": "toolCall.lsp.op.execute-command",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositionArgs = (args: ParsedArgs): args is PositionArgs =>
  args !== null && "line" in args;

/** 是否携带 filePath 参数（type-definition / implementation / 位置类工具）。 */
const hasFilePath = (
  args: ParsedArgs
): args is PositionArgs | RenameArgs | CodeActionArgs =>
  args !== null && "filePath" in args;

const isRenameArgs = (args: ParsedArgs): args is RenameArgs =>
  args !== null && "newName" in args;

const isCodeActionArgs = (args: ParsedArgs): args is CodeActionArgs =>
  args !== null && "apply" in args;

const getOperation = (toolName: string): LspOperation | null => {
  switch (toolName) {
    case "lsp-diagnostics":
      return "diagnostics";
    case "lsp-completion":
      return "completion";
    case "lsp-rename":
      return "rename";
    case "lsp-code-action":
      return "code-action";
    case "lsp-signature-help":
      return "signature-help";
    case "lsp-type-definition":
      return "type-definition";
    case "lsp-implementation":
      return "implementation";
    case "lsp-workspace-symbols":
      return "workspace-symbols";
    case "lsp-call-hierarchy":
      return "call-hierarchy";
    case "lsp-type-hierarchy":
      return "type-hierarchy";
    case "lsp-execute-command":
      return "execute-command";
    default:
      return null;
  }
};

const parseString = (
  record: Record<string, unknown>,
  key: string
): string | undefined =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;

const parseNumber = (
  record: Record<string, unknown>,
  key: string
): number | undefined =>
  typeof record[key] === "number" ? (record[key] as number) : undefined;

const parseBoolean = (
  record: Record<string, unknown>,
  key: string
): boolean | undefined =>
  typeof record[key] === "boolean" ? (record[key] as boolean) : undefined;

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/**
 * 参数仍在流式到达（半截 JSON，parseArgs 会失败）时的兜底：
 * 直接从原始 arguments 字符串里正则抠出 filePath，让 header 在等待期
 * 也能显示文件名；参数完整后 useMemo 重算会被正式解析结果替换。
 */
const extractFilePath = (args: string): string | undefined => {
  if (!args) return undefined;
  const match = args.match(/"filePath"\s*:\s*"([^"]*)"/);
  return match ? match[1].replace(/\\/g, "\\") : undefined;
};

/** file:// URI → 本地路径（Windows: file:///E:/...）。 */
const uriToPath = (uri: string): string => {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
  } catch {
    return uri.replace(/^file:\/\//i, "");
  }
};

const parseArgs = (args: string, operation: LspOperation): ParsedArgs => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed)) return null;

    // workspace-symbols 只有 query，无文件位置。
    if (operation === "workspace-symbols") {
      const query = parseString(parsed, "query");
      if (!query) return null;
      return { query };
    }

    // diagnostics：filePath 或 filePaths（批量）。
    if (operation === "diagnostics") {
      const filePath = parseString(parsed, "filePath");
      const filePathsValue = parsed.filePaths;
      const filePaths = Array.isArray(filePathsValue)
        ? filePathsValue.filter(
            (item): item is string => typeof item === "string"
          )
        : undefined;
      if (!filePath && (!filePaths || filePaths.length === 0)) return null;
      return filePath ? { filePath } : { filePaths };
    }

    const filePath = parseString(parsed, "filePath");
    const line = parseNumber(parsed, "line");
    const column = parseNumber(parsed, "column");
    if (!filePath || line === undefined || column === undefined) return null;

    if (operation === "rename") {
      return {
        filePath,
        line,
        column,
        newName: parseString(parsed, "newName"),
        dryRun: parseBoolean(parsed, "dryRun") ?? true,
      };
    }
    if (operation === "code-action") {
      const onlyValue = parsed.only;
      return {
        filePath,
        line,
        column,
        only: Array.isArray(onlyValue)
          ? onlyValue.filter(
              (item): item is string => typeof item === "string"
            )
          : undefined,
        apply: parseBoolean(parsed, "apply") ?? false,
      };
    }
    return { filePath, line, column };
  } catch {
    return null;
  }
};

const parseEdit = (value: unknown): EditInfo | null => {
  if (!isRecord(value)) return null;
  const startLine = parseNumber(value, "startLine");
  const startColumn = parseNumber(value, "startColumn");
  const endLine = parseNumber(value, "endLine");
  const endColumn = parseNumber(value, "endColumn");
  const newText = parseString(value, "newText");
  if (
    startLine === undefined ||
    startColumn === undefined ||
    endLine === undefined ||
    endColumn === undefined ||
    newText === undefined
  ) {
    return null;
  }
  return { startLine, startColumn, endLine, endColumn, newText };
};

const parseWorkspaceFile = (value: unknown): WorkspaceFile | null => {
  if (!isRecord(value)) return null;
  const uri = parseString(value, "uri");
  if (!uri) return null;
  const editCount = parseNumber(value, "editCount") ?? 0;
  const editsValue = value.edits;
  return {
    uri,
    editCount,
    edits: Array.isArray(editsValue)
      ? editsValue
          .map(parseEdit)
          .filter((edit): edit is EditInfo => edit !== null)
      : undefined,
    applied: parseBoolean(value, "applied"),
  };
};

const parseCompletionItem = (value: unknown): CompletionItem | null => {
  if (!isRecord(value)) return null;
  const label = parseString(value, "label");
  if (!label) return null;
  return {
    label,
    kind: parseString(value, "kind"),
    detail: parseString(value, "detail"),
    documentation: parseString(value, "documentation"),
    insertText: parseString(value, "insertText"),
    sortText: parseString(value, "sortText"),
  };
};

const parseCodeActionItem = (value: unknown): CodeActionItem | null => {
  if (!isRecord(value)) return null;
  const title = parseString(value, "title");
  if (!title) return null;
  const commandValue = value.command;
  return {
    title,
    kind: parseString(value, "kind"),
    isPreferred: parseBoolean(value, "isPreferred"),
    hasEdit: parseBoolean(value, "hasEdit") ?? false,
    command: isRecord(commandValue)
      ? {
          command: parseString(commandValue, "command") ?? "",
          title: parseString(commandValue, "title"),
          arguments: Array.isArray(commandValue.arguments)
            ? (commandValue.arguments as unknown[])
            : undefined,
        }
      : undefined,
  };
};

const parseSignature = (value: unknown): SignatureInfo | null => {
  if (!isRecord(value)) return null;
  const label = parseString(value, "label");
  if (!label) return null;
  const parametersValue = value.parameters;
  return {
    label,
    documentation: parseString(value, "documentation"),
    parameters: Array.isArray(parametersValue)
      ? parametersValue
          .filter(isRecord)
          .map((param) => ({
            label: parseString(param, "label") ?? "",
            documentation: parseString(param, "documentation"),
          }))
      : [],
  };
};

const parseResult = (
  result: string | undefined,
  operation: LspOperation
): ParsedResult => {
  if (!result) return { type: "empty" };

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) return { type: "raw", text: result };

    // napi 错误包装为 { "error": "..." }。
    const errorStr = parseString(parsed, "error");
    if (errorStr) return { type: "error", message: errorStr };

    const language = parseString(parsed, "language");

    // 单文件诊断（含 summary + diagnostics 列表）。
    if (operation === "diagnostics" && Array.isArray(parsed.diagnostics)) {
      const diagnostics = parsed.diagnostics
        .filter(isRecord)
        .map((item): DiagnosticItem | null => {
          const message = parseString(item, "message");
          const line = parseNumber(item, "line");
          const column = parseNumber(item, "column");
          if (!message || line === undefined || column === undefined) {
            return null;
          }
          return {
            severity: parseString(item, "severity"),
            message,
            source: parseString(item, "source"),
            code: parseString(item, "code"),
            line,
            column,
            endLine: parseNumber(item, "endLine"),
            endColumn: parseNumber(item, "endColumn"),
          };
        })
        .filter((item): item is DiagnosticItem => item !== null);
      return {
        type: "diagnostics",
        language,
        filePath: parseString(parsed, "filePath"),
        summary: parseString(parsed, "summary"),
        count: parseNumber(parsed, "count") ?? diagnostics.length,
        diagnostics,
      };
    }

    // 批量诊断（batch: files[]，含单文件 error）。
    if (operation === "diagnostics" && Array.isArray(parsed.files)) {
      const files = parsed.files
        .filter(isRecord)
        .map((item): BatchDiagnosticsFile | null => {
          const filePath = parseString(item, "filePath");
          if (!filePath) return null;
          const errorStr = parseString(item, "error");
          const rawDiag = Array.isArray(item.diagnostics)
            ? item.diagnostics
            : [];
          const diagnostics = rawDiag
            .filter(isRecord)
            .map((d): DiagnosticItem | null => {
              const message = parseString(d, "message");
              const line = parseNumber(d, "line");
              const column = parseNumber(d, "column");
              if (!message || line === undefined || column === undefined) {
                return null;
              }
              return {
                severity: parseString(d, "severity"),
                message,
                source: parseString(d, "source"),
                code: parseString(d, "code"),
                line,
                column,
                endLine: parseNumber(d, "endLine"),
                endColumn: parseNumber(d, "endColumn"),
              };
            })
            .filter((d): d is DiagnosticItem => d !== null);
          return {
            filePath,
            language: parseString(item, "language"),
            summary: parseString(item, "summary"),
            diagnostics,
            error: errorStr,
          };
        })
        .filter((item): item is BatchDiagnosticsFile => item !== null);
      return {
        type: "diagnostics-batch",
        fileCount: parseNumber(parsed, "fileCount") ?? files.length,
        files,
      };
    }

    if (operation === "completion" && Array.isArray(parsed.items)) {
      const items = parsed.items
        .map(parseCompletionItem)
        .filter((item): item is CompletionItem => item !== null);
      return {
        type: "completion",
        language,
        isIncomplete: parseBoolean(parsed, "isIncomplete") ?? false,
        count: parseNumber(parsed, "count") ?? items.length,
        total: parseNumber(parsed, "total") ?? items.length,
        items,
      };
    }

    if (operation === "rename" && Array.isArray(parsed.files)) {
      return {
        type: "rename",
        language,
        applied: parseBoolean(parsed, "applied") ?? false,
        dryRun: parseBoolean(parsed, "dryRun") ?? true,
        changeCount: parseNumber(parsed, "changeCount") ?? parsed.files.length,
        files: parsed.files
          .map(parseWorkspaceFile)
          .filter((file): file is WorkspaceFile => file !== null),
      };
    }

    if (operation === "code-action") {
      const actionsValue = parsed.actions;
      const actions = Array.isArray(actionsValue)
        ? actionsValue
            .map(parseCodeActionItem)
            .filter((action): action is CodeActionItem => action !== null)
        : [];
      const appliedValue = parsed.applied;
      const deferredValue = parsed.deferredCommands;
      return {
        type: "code-action",
        language,
        apply: parseBoolean(parsed, "apply") ?? false,
        actions,
        appliedCount: parseNumber(parsed, "appliedCount") ?? 0,
        applied: Array.isArray(appliedValue)
          ? appliedValue
              .filter(isRecord)
              .map((action) => ({
                title: parseString(action, "title") ?? "",
                kind: parseString(action, "kind"),
                changeCount: parseNumber(action, "changeCount") ?? 0,
                files: Array.isArray(action.files)
                  ? action.files
                      .map(parseWorkspaceFile)
                      .filter((file): file is WorkspaceFile => file !== null)
                  : [],
              }))
          : [],
        deferred: Array.isArray(deferredValue)
          ? deferredValue
              .filter(isRecord)
              .map((item) => ({
                title: parseString(item, "title") ?? "",
                command: parseString(item, "command"),
                arguments: Array.isArray(item.arguments)
                  ? (item.arguments as unknown[])
                  : undefined,
                executed: parseBoolean(item, "executed") ?? false,
                note: parseString(item, "note"),
              }))
          : [],
      };
    }

    if (
      operation === "signature-help" &&
      Array.isArray(parsed.signatures)
    ) {
      const signatures = parsed.signatures
        .map(parseSignature)
        .filter((sig): sig is SignatureInfo => sig !== null);
      return {
        type: "signature-help",
        language,
        count: parseNumber(parsed, "count") ?? signatures.length,
        signatures,
        activeSignature:
          parseNumber(parsed, "activeSignature") ?? null,
        activeParameter:
          parseNumber(parsed, "activeParameter") ?? null,
      };
    }

    // type-definition / implementation：输出与 definition 对齐（name + definitions）。
    if (
      (operation === "type-definition" || operation === "implementation") &&
      Array.isArray(parsed.definitions)
    ) {
      const definitions = parsed.definitions
        .filter(isRecord)
        .map((item): DefinitionItem | null => {
          const filePath = parseString(item, "filePath");
          const line = parseNumber(item, "line");
          const column = parseNumber(item, "column");
          if (!filePath || line === undefined || column === undefined) {
            return null;
          }
          const endLine = parseNumber(item, "endLine");
          const endColumn = parseNumber(item, "endColumn");
          return {
            filePath,
            line,
            column,
            ...(endLine !== undefined ? { endLine } : {}),
            ...(endColumn !== undefined ? { endColumn } : {}),
          };
        })
        .filter((item): item is DefinitionItem => item !== null);
      return {
        type: "definition-jump",
        language,
        name: parseString(parsed, "name"),
        count: parseNumber(parsed, "count") ?? definitions.length,
        definitions,
      };
    }

    // workspace-symbols：query + 符号列表（可能跨语言合并）。
    if (operation === "workspace-symbols" && Array.isArray(parsed.symbols)) {
      const symbols = parsed.symbols
        .filter(isRecord)
        .map((item) => ({
          name: parseString(item, "name") ?? "",
          kind: parseString(item, "kind"),
          detail: parseString(item, "detail"),
          filePath: parseString(item, "filePath"),
          line: parseNumber(item, "line"),
          column: parseNumber(item, "column"),
        }))
        .filter((item) => item.name.length > 0);
      return {
        type: "workspace-symbols",
        language,
        query: parseString(parsed, "query"),
        count: parseNumber(parsed, "count") ?? symbols.length,
        total: parseNumber(parsed, "total") ?? symbols.length,
        symbols,
      };
    }

    // call-hierarchy：incoming（谁调用它）+ outgoing（它调用谁）。
    if (operation === "call-hierarchy" && Array.isArray(parsed.incoming)) {
      const parseItem = (value: unknown): HierarchyItem | null => {
        if (!isRecord(value)) return null;
        const name = parseString(value, "name");
        if (!name) return null;
        return {
          name,
          kind: parseString(value, "kind"),
          detail: parseString(value, "detail"),
          filePath: parseString(value, "filePath"),
          line: parseNumber(value, "line"),
          column: parseNumber(value, "column"),
        };
      };
      const parseCall = (value: unknown): HierarchyCall | null => {
        if (!isRecord(value)) return null;
        const callSitesValue = value.callSites;
        const callSites = Array.isArray(callSitesValue)
          ? callSitesValue
              .filter(isRecord)
              .map((site) => ({
                filePath: parseString(site, "filePath") ?? "",
                line: parseNumber(site, "line") ?? 0,
                column: parseNumber(site, "column") ?? 0,
                context: parseString(site, "context"),
              }))
              .filter((site) => site.filePath.length > 0)
          : [];
        return {
          caller: parseItem(value.caller) ?? undefined,
          callee: parseItem(value.callee) ?? undefined,
          callSites,
        };
      };
      const incoming = parsed.incoming
        .map(parseCall)
        .filter((call): call is HierarchyCall => call !== null);
      const outgoingValue = parsed.outgoing;
      const outgoing = Array.isArray(outgoingValue)
        ? outgoingValue
            .map(parseCall)
            .filter((call): call is HierarchyCall => call !== null)
        : [];
      return {
        type: "call-hierarchy",
        language,
        symbol: parseString(parsed, "symbol"),
        incomingCount: parseNumber(parsed, "incomingCount") ?? incoming.length,
        outgoingCount: parseNumber(parsed, "outgoingCount") ?? outgoing.length,
        incoming,
        outgoing,
      };
    }

    // type-hierarchy：supertypes（父类型链）+ subtypes（子类型列表）。
    if (operation === "type-hierarchy" && Array.isArray(parsed.supertypes)) {
      const parseType = (value: unknown): HierarchyItem | null => {
        if (!isRecord(value)) return null;
        const name = parseString(value, "name");
        if (!name) return null;
        return {
          name,
          kind: parseString(value, "kind"),
          detail: parseString(value, "detail"),
          filePath: parseString(value, "filePath"),
          line: parseNumber(value, "line"),
          column: parseNumber(value, "column"),
        };
      };
      const supertypes = parsed.supertypes
        .map(parseType)
        .filter((item): item is HierarchyItem => item !== null);
      const subtypesValue = parsed.subtypes;
      const subtypes = Array.isArray(subtypesValue)
        ? subtypesValue
            .map(parseType)
            .filter((item): item is HierarchyItem => item !== null)
        : [];
      return {
        type: "type-hierarchy",
        language,
        symbol: parseString(parsed, "symbol"),
        supertypesCount: parseNumber(parsed, "supertypesCount") ?? supertypes.length,
        subtypesCount: parseNumber(parsed, "subtypesCount") ?? subtypes.length,
        supertypes,
        subtypes,
      };
    }

    // 部分错误以 { "message": "..." } 形式到达。
    const messageStr = parseString(parsed, "message");
    if (messageStr) return { type: "error", message: messageStr };

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

/** 截断长文本（补全文档 / 编辑预览）。 */
const truncateText = (text: string, max = 220): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;

export const LspToolCall = ({
  toolCall,
}: LspToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = getOperation(toolCall.name);

  const parsedArgs = useMemo(
    () => (operation ? parseArgs(toolCall.arguments, operation) : null),
    [toolCall.arguments, operation]
  );
  const parsedResult = useMemo(
    () =>
      operation
        ? parseResult(toolCall.result, operation)
        : ({ type: "empty" } as ParsedResult),
    [toolCall.result, operation]
  );

  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const badgeName = operation
    ? t(BADGE_KEYS[operation])
    : t("toolCall.lsp.name");

  const filePath = hasFilePath(parsedArgs)
    ? parsedArgs.filePath
    : (extractFilePath(toolCall.arguments) ?? "");
  const displayName = filePath ? getFileName(filePath) : undefined;
  const position = isPositionArgs(parsedArgs) ? parsedArgs : null;

  // Header meta：语言 badge + 结果计数 badge。
  const meta = useMemo(() => {
    const language =
      parsedResult.type === "completion" ||
      parsedResult.type === "rename" ||
      parsedResult.type === "code-action" ||
      parsedResult.type === "signature-help" ||
      parsedResult.type === "definition-jump" ||
      parsedResult.type === "workspace-symbols" ||
      parsedResult.type === "call-hierarchy" ||
      parsedResult.type === "type-hierarchy" ||
      parsedResult.type === "diagnostics"
        ? parsedResult.language
        : undefined;
    const langBadge = language ? (
      <span className="tool-call-lsp-lang-badge">
        <Languages size={10} aria-hidden="true" />
        {language}
      </span>
    ) : null;

    if (parsedResult.type === "completion") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.completionCount", {
              values: {
                shown: parsedResult.count,
                total: parsedResult.total,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "rename") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.applied
                ? "tool-call-codelens-count-ok"
                : "tool-call-codelens-count-info"
            }`}
          >
            {parsedResult.applied
              ? t("toolCall.lsp.renameApplied")
              : t("toolCall.lsp.dryRun")}
          </span>
          <span className="tool-call-codelens-count tool-call-codelens-count-muted">
            {t("toolCall.lsp.changeCount", {
              values: { count: parsedResult.changeCount },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "code-action") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.apply
                ? "tool-call-codelens-count-ok"
                : "tool-call-codelens-count-info"
            }`}
          >
            {parsedResult.apply
              ? t("toolCall.lsp.appliedCount", {
                  values: { count: parsedResult.appliedCount },
                })
              : t("toolCall.lsp.actionCount", {
                  values: { count: parsedResult.actions.length },
                })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "signature-help") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.signatureCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "definition-jump") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.definitionsCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "workspace-symbols") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.symbolsCount", {
              values: { shown: parsedResult.count, total: parsedResult.total },
            })}
          </span>
          {parsedResult.total > parsedResult.count ? (
            <span className="tool-call-codelens-count tool-call-codelens-count-muted">
              {t("toolCall.lsp.truncated", {
                values: { count: parsedResult.count },
              })}
            </span>
          ) : null}
        </>
      );
    }
    if (parsedResult.type === "call-hierarchy") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.incomingCount > 0 || parsedResult.outgoingCount > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.callHierarchyCount", {
              values: {
                incoming: parsedResult.incomingCount,
                outgoing: parsedResult.outgoingCount,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "type-hierarchy") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.supertypesCount > 0 || parsedResult.subtypesCount > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.typeHierarchyCount", {
              values: {
                supertypes: parsedResult.supertypesCount,
                subtypes: parsedResult.subtypesCount,
              },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "diagnostics") {
      return (
        <>
          {langBadge}
          <span
            className={`tool-call-codelens-count ${
              parsedResult.count > 0
                ? "tool-call-codelens-count-error"
                : "tool-call-codelens-count-ok"
            }`}
          >
            {t("toolCall.lsp.diagnosticsCount", {
              values: { count: parsedResult.count },
            })}
          </span>
        </>
      );
    }
    if (parsedResult.type === "diagnostics-batch") {
      return (
        <>
          <span
            className={`tool-call-codelens-count ${
              parsedResult.fileCount > 0
                ? "tool-call-codelens-count-info"
                : "tool-call-codelens-count-muted"
            }`}
          >
            {t("toolCall.lsp.batchCount", {
              values: { count: parsedResult.fileCount },
            })}
          </span>
        </>
      );
    }
    return langBadge;
  }, [parsedResult, t]);

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={badgeName}
      category="lens"
      displayName={displayName}
      displayNameTitle={filePath}
      displayNameDataPath={filePath}
      status={effectiveStatus}
      meta={meta}
      className="tool-call-lsp"
    >
      <div className="tool-call-body tool-call-lsp-body">
        {/* Parameters */}
        {parsedArgs ? (
          <div className="tool-call-codelens-params">
            {"query" in parsedArgs ? (
              <div className="tool-call-codelens-param-item">
                <ScanSearch size={11} aria-hidden="true" />
                <span className="tool-call-codelens-param-label">
                  {t("toolCall.lsp.query")}
                </span>
                <code className="tool-call-codelens-param-value">
                  {parsedArgs.query}
                </code>
              </div>
            ) : (
              <>
                <div className="tool-call-codelens-param-item">
                  <FileCode size={11} aria-hidden="true" />
                  <span className="tool-call-codelens-param-label">
                    {t("toolCall.lsp.filePath")}
                  </span>
                  <span
                    className="tool-call-codelens-param-value"
                    title={filePath}
                  >
                    {filePath}
                  </span>
                </div>
                {position ? (
                  <div className="tool-call-codelens-param-item">
                    <Crosshair size={11} aria-hidden="true" />
                    <span className="tool-call-codelens-param-label">
                      {t("toolCall.lsp.position")}
                    </span>
                    <code className="tool-call-codelens-param-value">
                      {position.line}:{position.column}
                    </code>
                  </div>
                ) : null}
              </>
            )}
            {isRenameArgs(parsedArgs) ? (
              <>
                <div className="tool-call-codelens-param-item">
                  <PencilLine size={11} aria-hidden="true" />
                  <span className="tool-call-codelens-param-label">
                    {t("toolCall.lsp.newName")}
                  </span>
                  <code className="tool-call-codelens-param-value">
                    {parsedArgs.newName ?? ""}
                  </code>
                </div>
                {parsedArgs.dryRun !== undefined ? (
                  <div className="tool-call-codelens-param-item">
                    <ShieldAlert size={11} aria-hidden="true" />
                    <span className="tool-call-codelens-param-label">
                      {t("toolCall.lsp.dryRun")}
                    </span>
                    <span className="tool-call-codelens-param-value">
                      {parsedArgs.dryRun ? "true" : "false"}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
            {isCodeActionArgs(parsedArgs) ? (
              <>
                {parsedArgs.only && parsedArgs.only.length > 0 ? (
                  <div className="tool-call-codelens-param-item">
                    <Wand2 size={11} aria-hidden="true" />
                    <span className="tool-call-codelens-param-label">
                      {t("toolCall.lsp.only")}
                    </span>
                    <code className="tool-call-codelens-param-value">
                      {parsedArgs.only.join(", ")}
                    </code>
                  </div>
                ) : null}
                {parsedArgs.apply !== undefined ? (
                  <div className="tool-call-codelens-param-item">
                    <Wand2 size={11} aria-hidden="true" />
                    <span className="tool-call-codelens-param-label">
                      {t("toolCall.lsp.apply")}
                    </span>
                    <span className="tool-call-codelens-param-value">
                      {parsedArgs.apply ? "true" : "false"}
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {/* Error */}
        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* Completion view */}
        {parsedResult.type === "completion" ? (
          parsedResult.items.length > 0 ? (
            <div className="tool-call-lsp-completion-list">
              {parsedResult.isIncomplete ? (
                <div className="tool-call-lsp-incomplete-note">
                  {t("toolCall.lsp.incomplete")}
                </div>
              ) : null}
              {parsedResult.items.map((item, idx) => (
                <div key={`${item.label}-${idx}`} className="tool-call-lsp-completion-item">
                  <span className="tool-call-lsp-completion-label">
                    <ListPlus size={11} aria-hidden="true" />
                    <code>{item.label}</code>
                  </span>
                  {item.kind ? (
                    <span className="tool-call-lsp-kind-badge">{item.kind}</span>
                  ) : null}
                  {item.detail ? (
                    <span className="tool-call-lsp-completion-detail" title={item.detail}>
                      {item.detail}
                    </span>
                  ) : null}
                  {item.documentation ? (
                    <span
                      className="tool-call-lsp-completion-doc"
                      title={item.documentation}
                    >
                      {truncateText(item.documentation)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noCompletions")}</span>
            </div>
          )
        ) : null}

        {/* Rename view */}
        {parsedResult.type === "rename" ? (
          parsedResult.files.length > 0 ? (
            <div className="tool-call-lsp-rename-list">
              {!parsedResult.applied ? (
                <div className="tool-call-lsp-preview-note">
                  <ShieldAlert size={12} aria-hidden="true" />
                  <span>{t("toolCall.lsp.renamePreview")}</span>
                </div>
              ) : null}
              {parsedResult.files.map((file, fileIdx) => (
                <div key={`${file.uri}-${fileIdx}`} className="tool-call-lsp-rename-file">
                  <div
                    className="tool-call-lsp-rename-file-header"
                    title={uriToPath(file.uri)}
                  >
                    <FileCode size={12} aria-hidden="true" />
                    <span className="tool-call-lsp-rename-file-name">
                      {getFileName(uriToPath(file.uri))}
                    </span>
                    <span className="tool-call-lsp-rename-file-path">
                      {uriToPath(file.uri)}
                    </span>
                    {file.applied !== undefined ? (
                      <span
                        className={`tool-call-lsp-rename-applied ${
                          file.applied ? "applied" : "skipped"
                        }`}
                      >
                        {file.applied
                          ? t("toolCall.lsp.renameApplied")
                          : t("toolCall.lsp.noChanges")}
                      </span>
                    ) : (
                      <span className="tool-call-codelens-ref-file-count">
                        {t("toolCall.lsp.editCount", {
                          values: { count: file.editCount },
                        })}
                      </span>
                    )}
                  </div>
                  {file.edits && file.edits.length > 0 ? (
                    <div className="tool-call-lsp-edit-list">
                      {file.edits.map((edit, editIdx) => (
                        <div
                          key={`${edit.startLine}-${edit.startColumn}-${editIdx}`}
                          className="tool-call-lsp-edit-row"
                        >
                          <span className="tool-call-lsp-edit-loc">
                            <Hash size={9} aria-hidden="true" />
                            {edit.startLine}:{edit.startColumn} → {edit.endLine}:
                            {edit.endColumn}
                          </span>
                          <code className="tool-call-lsp-edit-text" title={edit.newText}>
                            {truncateText(edit.newText, 160)}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noChanges")}</span>
            </div>
          )
        ) : null}

        {/* Code action view */}
        {parsedResult.type === "code-action" ? (
          parsedResult.actions.length > 0 ||
          parsedResult.applied.length > 0 ||
          parsedResult.deferred.length > 0 ? (
            <div className="tool-call-lsp-action-list">
              {parsedResult.actions.map((action, idx) => {
                const appliedAction = parsedResult.applied.find(
                  (applied) => applied.title === action.title
                );
                return (
                  <div key={`${action.title}-${idx}`} className="tool-call-lsp-action-item">
                    <span className="tool-call-lsp-action-title">
                      <Wand2 size={11} aria-hidden="true" />
                      {action.title}
                    </span>
                    {action.kind ? (
                      <span className="tool-call-lsp-kind-badge">{action.kind}</span>
                    ) : null}
                    {action.isPreferred ? (
                      <span className="tool-call-lsp-preferred-badge">
                        {t("toolCall.lsp.preferred")}
                      </span>
                    ) : null}
                    {action.hasEdit ? (
                      <span className="tool-call-lsp-edit-badge">
                        {t("toolCall.lsp.editsAvailable")}
                      </span>
                    ) : null}
                    {action.command ? (
                      <span
                        className="tool-call-lsp-command-badge"
                        title={action.command.command}
                      >
                        <ShieldAlert size={10} aria-hidden="true" />
                        {t("toolCall.lsp.commandNotExecuted")}
                      </span>
                    ) : null}
                    {appliedAction ? (
                      <span className="tool-call-lsp-applied-badge">
                        <CheckCircle2 size={10} aria-hidden="true" />
                        {t("toolCall.lsp.changeCount", {
                          values: { count: appliedAction.changeCount },
                        })}
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {parsedResult.applied.length > 0 ? (
                <div className="tool-call-lsp-result-section">
                  <span className="tool-call-lsp-section-label">
                    <CheckCircle2 size={11} aria-hidden="true" />
                    {t("toolCall.lsp.appliedSection")}
                  </span>
                  {parsedResult.applied.map((action, idx) => (
                    <div key={`applied-${action.title}-${idx}`} className="tool-call-lsp-action-item">
                      <span className="tool-call-lsp-action-title">
                        <CheckCircle2 size={11} aria-hidden="true" />
                        {action.title}
                      </span>
                      {action.kind ? (
                        <span className="tool-call-lsp-kind-badge">{action.kind}</span>
                      ) : null}
                      <span className="tool-call-lsp-applied-badge">
                        {t("toolCall.lsp.changeCount", {
                          values: { count: action.changeCount },
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {parsedResult.deferred.length > 0 ? (
                <div className="tool-call-lsp-result-section">
                  <span className="tool-call-lsp-section-label">
                    <ShieldAlert size={11} aria-hidden="true" />
                    {t("toolCall.lsp.deferredSection")}
                  </span>
                  {parsedResult.deferred.map((item, idx) => (
                    <div key={`deferred-${item.title}-${idx}`} className="tool-call-lsp-action-item">
                      <span className="tool-call-lsp-action-title">
                        <ShieldAlert size={11} aria-hidden="true" />
                        {item.title}
                      </span>
                      {item.note ? (
                        <span className="tool-call-lsp-command-badge">{item.note}</span>
                      ) : (
                        <span className="tool-call-lsp-command-badge">
                          {t("toolCall.lsp.commandNotExecuted")}
                        </span>
                      )}
                      {item.command ? (
                        <code
                          className="tool-call-lsp-deferred-command"
                          title={item.command}
                        >
                          {item.command}
                        </code>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noActions")}</span>
            </div>
          )
        ) : null}

        {/* Signature help view */}
        {parsedResult.type === "signature-help" ? (
          parsedResult.signatures.length > 0 ? (
            <div className="tool-call-lsp-signature-list">
              {parsedResult.signatures.map((signature, sigIdx) => {
                const isActive =
                  parsedResult.activeSignature === sigIdx ||
                  (parsedResult.activeSignature === null &&
                    sigIdx === 0);
                return (
                  <div
                    key={`${signature.label}-${sigIdx}`}
                    className={`tool-call-lsp-signature-item ${
                      isActive ? "active" : ""
                    }`}
                  >
                    <div className="tool-call-lsp-signature-label">
                      <Sigma size={12} aria-hidden="true" />
                      <code>{signature.label}</code>
                      {isActive ? (
                        <span className="tool-call-lsp-active-badge">
                          {t("toolCall.lsp.activeSignature")}
                        </span>
                      ) : null}
                    </div>
                    {signature.documentation ? (
                      <div
                        className="tool-call-lsp-signature-doc"
                        title={signature.documentation}
                      >
                        {truncateText(signature.documentation)}
                      </div>
                    ) : null}
                    {signature.parameters.length > 0 ? (
                      <div className="tool-call-lsp-param-list">
                        {signature.parameters.map((param, paramIdx) => {
                          const isActiveParam =
                            isActive &&
                            (parsedResult.activeParameter === paramIdx ||
                              (parsedResult.activeParameter === null &&
                                paramIdx === 0));
                          return (
                            <span
                              key={`${param.label}-${paramIdx}`}
                              className={`tool-call-lsp-param-chip ${
                                isActiveParam ? "active" : ""
                              }`}
                              title={param.documentation}
                            >
                              {param.label || `#${paramIdx + 1}`}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noSignatures")}</span>
            </div>
          )
        ) : null}

        {/* Definition jump view（type-definition / implementation） */}
        {parsedResult.type === "definition-jump" ? (
          parsedResult.definitions.length > 0 ? (
            <div className="tool-call-lsp-def-list">
              {parsedResult.definitions.map((def, idx) => (
                <div key={`${def.filePath}-${def.line}-${idx}`} className="tool-call-lsp-def-item">
                  <div className="tool-call-lsp-def-header" title={def.filePath}>
                    <Crosshair size={11} aria-hidden="true" />
                    <span className="tool-call-lsp-def-name">
                      {getFileName(def.filePath)}
                    </span>
                    <span className="tool-call-lsp-def-path">
                      {def.filePath}
                    </span>
                    <span className="tool-call-codelens-ref-file-count">
                      <Hash size={9} aria-hidden="true" />
                      {def.line}:{def.column}
                      {def.endLine !== undefined && def.endColumn !== undefined
                        ? ` → ${def.endLine}:${def.endColumn}`
                        : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noDefinitions")}</span>
            </div>
          )
        ) : null}

        {/* Workspace symbols view */}
        {parsedResult.type === "workspace-symbols" ? (
          parsedResult.symbols.length > 0 ? (
            <div className="tool-call-lsp-symbol-list">
              {parsedResult.symbols.map((symbol, idx) => (
                <div
                  key={`${symbol.name}-${symbol.filePath ?? ""}-${symbol.line ?? 0}-${idx}`}
                  className="tool-call-lsp-symbol-item"
                >
                  <span className="tool-call-lsp-symbol-name">
                    <ScanSearch size={11} aria-hidden="true" />
                    <code>{symbol.name}</code>
                  </span>
                  {symbol.kind ? (
                    <span className="tool-call-lsp-kind-badge">{symbol.kind}</span>
                  ) : null}
                  {symbol.detail ? (
                    <span
                      className="tool-call-lsp-symbol-detail"
                      title={symbol.detail}
                    >
                      {symbol.detail}
                    </span>
                  ) : null}
                  {symbol.filePath ? (
                    <span className="tool-call-lsp-symbol-path" title={symbol.filePath}>
                      {getFileName(symbol.filePath)}
                      {symbol.line !== undefined && symbol.line > 0
                        ? `:${symbol.line}:${symbol.column ?? 0}`
                        : ""}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noSymbols")}</span>
            </div>
          )
        ) : null}

        {/* Diagnostics view（单文件） */}
        {parsedResult.type === "diagnostics" ? (
          <div className="tool-call-lsp-diag-list">
            {parsedResult.summary ? (
              <div className="tool-call-lsp-diag-summary">{parsedResult.summary}</div>
            ) : null}
            {parsedResult.diagnostics.length > 0 ? (
              parsedResult.diagnostics.map((diag, idx) => (
                <div
                  key={`${diag.line}-${diag.column}-${idx}`}
                  className={`tool-call-lsp-diag-item severity-${diag.severity ?? "unknown"}`}
                >
                  <span className="tool-call-lsp-diag-sev">
                    {diag.severity ?? "?"}
                  </span>
                  <span className="tool-call-lsp-diag-loc">
                    <Hash size={9} aria-hidden="true" />
                    {diag.line}:{diag.column}
                  </span>
                  <span className="tool-call-lsp-diag-message" title={diag.message}>
                    {truncateText(diag.message, 200)}
                  </span>
                  {diag.source ? (
                    <span className="tool-call-lsp-diag-source">
                      {diag.source}
                      {diag.code ? ` ${diag.code}` : ""}
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="tool-call-codelens-no-results">
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>{t("toolCall.lsp.noDiagnostics")}</span>
              </div>
            )}
          </div>
        ) : null}

        {/* Diagnostics view（批量） */}
        {parsedResult.type === "diagnostics-batch" ? (
          <div className="tool-call-lsp-diag-batch">
            {parsedResult.files.map((file, idx) => (
              <div key={`${file.filePath}-${idx}`} className="tool-call-lsp-diag-file">
                <div className="tool-call-lsp-diag-file-header">
                  <FileCode size={11} aria-hidden="true" />
                  <span
                    className="tool-call-lsp-diag-file-name"
                    title={file.filePath}
                  >
                    {getFileName(file.filePath)}
                  </span>
                  {file.error ? (
                    <span className="tool-call-lsp-diag-file-error">
                      {truncateText(file.error, 120)}
                    </span>
                  ) : file.summary ? (
                    <span className="tool-call-lsp-diag-file-summary">
                      {file.summary}
                    </span>
                  ) : null}
                </div>
                {file.diagnostics && file.diagnostics.length > 0 ? (
                  <div className="tool-call-lsp-diag-list">
                    {file.diagnostics.map((diag, diagIdx) => (
                      <div
                        key={`${diag.line}-${diag.column}-${diagIdx}`}
                        className={`tool-call-lsp-diag-item severity-${diag.severity ?? "unknown"}`}
                      >
                        <span className="tool-call-lsp-diag-sev">
                          {diag.severity ?? "?"}
                        </span>
                        <span className="tool-call-lsp-diag-loc">
                          <Hash size={9} aria-hidden="true" />
                          {diag.line}:{diag.column}
                        </span>
                        <span
                          className="tool-call-lsp-diag-message"
                          title={diag.message}
                        >
                          {truncateText(diag.message, 200)}
                        </span>
                        {diag.source ? (
                          <span className="tool-call-lsp-diag-source">
                            {diag.source}
                            {diag.code ? ` ${diag.code}` : ""}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* Call hierarchy view */}
        {parsedResult.type === "call-hierarchy" ? (
          parsedResult.incoming.length > 0 || parsedResult.outgoing.length > 0 ? (
            <div className="tool-call-lsp-hierarchy">
              {parsedResult.incoming.length > 0 ? (
                <div className="tool-call-lsp-hierarchy-section">
                  <div className="tool-call-lsp-hierarchy-title">
                    <ArrowUp size={11} aria-hidden="true" />
                    {t("toolCall.lsp.callers")}
                  </div>
                  {parsedResult.incoming.map((call, idx) => (
                    <div key={`in-${idx}`} className="tool-call-lsp-hierarchy-item">
                      <code className="tool-call-lsp-hierarchy-name">
                        {call.caller?.name ?? "?"}
                      </code>
                      {call.caller?.kind ? (
                        <span className="tool-call-lsp-kind-badge">
                          {call.caller.kind}
                        </span>
                      ) : null}
                      <span className="tool-call-lsp-hierarchy-loc">
                        {call.caller?.filePath
                          ? `${getFileName(call.caller.filePath)}:${call.caller.line ?? 0}`
                          : ""}
                      </span>
                      <span className="tool-call-lsp-hierarchy-sites">
                        {t("toolCall.lsp.callSites", {
                          values: { count: call.callSites.length },
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {parsedResult.outgoing.length > 0 ? (
                <div className="tool-call-lsp-hierarchy-section">
                  <div className="tool-call-lsp-hierarchy-title">
                    <ArrowDown size={11} aria-hidden="true" />
                    {t("toolCall.lsp.callees")}
                  </div>
                  {parsedResult.outgoing.map((call, idx) => (
                    <div key={`out-${idx}`} className="tool-call-lsp-hierarchy-item">
                      <code className="tool-call-lsp-hierarchy-name">
                        {call.callee?.name ?? "?"}
                      </code>
                      {call.callee?.kind ? (
                        <span className="tool-call-lsp-kind-badge">
                          {call.callee.kind}
                        </span>
                      ) : null}
                      <span className="tool-call-lsp-hierarchy-loc">
                        {call.callee?.filePath
                          ? `${getFileName(call.callee.filePath)}:${call.callee.line ?? 0}`
                          : ""}
                      </span>
                      <span className="tool-call-lsp-hierarchy-sites">
                        {t("toolCall.lsp.callSites", {
                          values: { count: call.callSites.length },
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noHierarchy")}</span>
            </div>
          )
        ) : null}

        {/* Type hierarchy view */}
        {parsedResult.type === "type-hierarchy" ? (
          parsedResult.supertypes.length > 0 || parsedResult.subtypes.length > 0 ? (
            <div className="tool-call-lsp-hierarchy">
              {parsedResult.supertypes.length > 0 ? (
                <div className="tool-call-lsp-hierarchy-section">
                  <div className="tool-call-lsp-hierarchy-title">
                    <ArrowUp size={11} aria-hidden="true" />
                    {t("toolCall.lsp.supertypes")}
                  </div>
                  {parsedResult.supertypes.map((item, idx) => (
                    <div key={`sup-${idx}`} className="tool-call-lsp-hierarchy-item">
                      <code className="tool-call-lsp-hierarchy-name">
                        {item.name}
                      </code>
                      {item.kind ? (
                        <span className="tool-call-lsp-kind-badge">{item.kind}</span>
                      ) : null}
                      <span className="tool-call-lsp-hierarchy-loc">
                        {item.filePath
                          ? `${getFileName(item.filePath)}:${item.line ?? 0}`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {parsedResult.subtypes.length > 0 ? (
                <div className="tool-call-lsp-hierarchy-section">
                  <div className="tool-call-lsp-hierarchy-title">
                    <ArrowDown size={11} aria-hidden="true" />
                    {t("toolCall.lsp.subtypes")}
                  </div>
                  {parsedResult.subtypes.map((item, idx) => (
                    <div key={`sub-${idx}`} className="tool-call-lsp-hierarchy-item">
                      <code className="tool-call-lsp-hierarchy-name">
                        {item.name}
                      </code>
                      {item.kind ? (
                        <span className="tool-call-lsp-kind-badge">{item.kind}</span>
                      ) : null}
                      <span className="tool-call-lsp-hierarchy-loc">
                        {item.filePath
                          ? `${getFileName(item.filePath)}:${item.line ?? 0}`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="tool-call-codelens-no-results">
              <XCircle size={14} aria-hidden="true" />
              <span>{t("toolCall.lsp.noHierarchy")}</span>
            </div>
          )
        ) : null}

        {/* Raw result fallback */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.lsp.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* Pending / running state */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-codelens-pending ${
              isRunning ? "tool-call-codelens-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <ScanSearch size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.lsp.running")
                : t("toolCall.lsp.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
