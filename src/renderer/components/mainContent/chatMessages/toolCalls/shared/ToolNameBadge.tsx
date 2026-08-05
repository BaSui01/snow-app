import {
  Bell,
  BookOpen,
  Bot,
  Box,
  Calendar,
  Clock,
  Code2,
  Compass,
  Cpu,
  Database,
  FilePen,
  FilePlus,
  FileText,
  Filter,
  FolderOpen,
  GitBranch,
  Globe,
  Hammer,
  Hash,
  HelpCircle,
  Image as ImageIcon,
  Key,
  Layers,
  Lightbulb,
  Link2,
  ListChecks,
  ListTree,
  Lock,
  MessageCircleQuestion,
  MousePointerClick,
  Package,
  Pencil,
  Puzzle,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Send,
  Settings,
  Star,
  Tag,
  Target,
  Terminal,
  User,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type ToolCategory =
  | "read"
  | "edit"
  | "create"
  | "search"
  | "terminal"
  | "web"
  | "git"
  | "outline"
  | "todo"
  | "interaction"
  | "agent"
  | "lens"
  | "image"
  | "generic";

/**
 * Pool of generic lucide icons used for tool-call badges. Each tool name is
 * assigned one random icon from this pool per app session, so the icon stays
 * stable across re-renders while different tools get varied icons.
 */
const TOOL_ICON_POOL: LucideIcon[] = [
  Wrench,
  Hammer,
  Settings,
  Zap,
  Terminal,
  FileText,
  FilePen,
  FilePlus,
  Search,
  Globe,
  GitBranch,
  ListTree,
  ListChecks,
  MessageCircleQuestion,
  Bot,
  ScanSearch,
  ImageIcon,
  Code2,
  Layers,
  Box,
  Puzzle,
  BookOpen,
  Compass,
  FolderOpen,
  Cpu,
  Database,
  RefreshCw,
  Lightbulb,
  Rocket,
  Bell,
  Calendar,
  Clock,
  Star,
  Lock,
  Key,
  MousePointerClick,
  Link2,
  HelpCircle,
  Filter,
  Hash,
  Package,
  Pencil,
  Send,
  Tag,
  Target,
  User,
  Users,
];

const toolIconCache = new Map<string, LucideIcon>();

/** Pick a random icon for a tool name; stable per app session. */
const getToolIcon = (toolName: string): LucideIcon => {
  const cached = toolIconCache.get(toolName);
  if (cached) {
    return cached;
  }
  const icon =
    TOOL_ICON_POOL[Math.floor(Math.random() * TOOL_ICON_POOL.length)] ??
    Hammer;
  toolIconCache.set(toolName, icon);
  return icon;
};

/**
 * Map a raw MCP tool name to a display category for icon selection.
 *
 * Examples:
 *   "filesystem-read"       -> "read"
 *   "filesystem-replace_edit" -> "edit"
 *   "filesystem-create"      -> "create"
 *   "ace-search"                   -> "search"
 *   "terminal-execute"             -> "terminal"
 *   "websearch-search"             -> "web"
 *   "todo-manage"                  -> "generic"
 */
export const getToolCategory = (toolName: string): ToolCategory => {
  const lower = toolName.toLowerCase();
  if (
    lower.includes("sub-agent") ||
    lower.includes("subagent") ||
    lower.includes("activate")
  ) {
    return "agent";
  }
  if (lower.includes("read")) return "read";
  if (lower.includes("edit") || lower.includes("replace")) return "edit";
  if (lower.includes("create") || lower.includes("write")) return "create";
  if (
    lower.includes("search") ||
    lower.includes("find") ||
    lower.includes("semantic") ||
    lower.includes("codebase")
  )
    return "search";
  if (
    lower.includes("terminal") ||
    lower.includes("execute") ||
    lower.includes("command")
  )
    return "terminal";
  if (lower.includes("web") || lower.includes("fetch") || lower.includes("url"))
    return "web";
  if (lower.includes("imagegen") || lower.includes("generate-image"))
    return "image";
  if (lower.includes("git")) return "git";
  if (lower.includes("codelens") || lower.includes("diagnose")) {
    return "lens";
  }
  if (
    lower.includes("outline") ||
    lower.includes("tree") ||
    lower.includes("symbol")
  )
    return "outline";
  if (lower.includes("todo")) return "todo";
  if (lower.includes("question") || lower.includes("interaction")) {
    return "interaction";
  }
  return "generic";
};

type ToolNameBadgeProps = {
  /** The display name shown in the badge, e.g. "read", "edit", "create". */
  name: string;
  /**
   * Legacy category hint, kept for API compatibility. Badge icons are now
   * assigned randomly from the lucide icon pool, so this is not used.
   */
  category?: ToolCategory;
};

export const ToolNameBadge = ({
  name,
}: ToolNameBadgeProps): React.JSX.Element => {
  const Icon = getToolIcon(name);

  return (
    <span className="tool-call-tool-name">
      <Icon size={10} className="tool-call-tool-name-icon" aria-hidden="true" />
      {name}
    </span>
  );
};
