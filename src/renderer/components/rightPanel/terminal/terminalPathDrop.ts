type DragPayload = Record<string, unknown>;

type ShellFlavor = "posix" | "cmd" | "powershell";

const POSIX_SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WINDOWS_SAFE_PATH = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

const isDragPayload = (value: unknown): value is DragPayload =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectEntryPaths = (entries: unknown): string[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (isDragPayload(entry) && typeof entry.path === "string" && entry.path) {
      paths.push(entry.path);
    }
  }
  return paths;
};

const parseDroppedPaths = (jsonData: string): string[] => {
  try {
    const parsed = JSON.parse(jsonData) as unknown;
    if (!isDragPayload(parsed)) {
      return [];
    }
    if (parsed.type === "file-tags") {
      return collectEntryPaths(parsed.tags);
    }
    if (typeof parsed.path === "string" && parsed.path) {
      return [parsed.path];
    }
    return collectEntryPaths(parsed.images);
  } catch {
    return [];
  }
};

export const readTerminalDropPaths = async (
  dataTransfer: DataTransfer,
): Promise<string[]> => {
  const jsonData = dataTransfer.getData("application/json");
  const files = Array.from(dataTransfer.files);

  if (jsonData) {
    const paths = parseDroppedPaths(jsonData);
    if (paths.length > 0) {
      return paths;
    }
  }
  if (files.length === 0) {
    return [];
  }

  try {
    const entries = await window.snow.resolveDroppedFiles(files);
    return entries.map((entry) => entry.path);
  } catch {
    return [];
  }
};

const detectShellFlavor = (shellPath: string): ShellFlavor => {
  const name = shellPath.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name.startsWith("pwsh") || name.startsWith("powershell")) {
    return "powershell";
  }
  if (name.startsWith("cmd")) {
    return "cmd";
  }
  if (name.length > 0) {
    return "posix";
  }
  return /win/i.test(navigator.platform) ? "cmd" : "posix";
};

const quotePath = (path: string, flavor: ShellFlavor): string => {
  if (flavor === "posix") {
    return POSIX_SAFE_PATH.test(path)
      ? path
      : `'${path.replace(/'/g, "'\\''")}'`;
  }
  if (flavor === "powershell") {
    return WINDOWS_SAFE_PATH.test(path)
      ? path
      : `'${path.replace(/'/g, "''")}'`;
  }
  return WINDOWS_SAFE_PATH.test(path) ? path : `"${path.replace(/"/g, '""')}"`;
};

export const formatTerminalPathInsertion = (
  paths: string[],
  shellPath: string,
): string => {
  if (paths.length === 0) {
    return "";
  }
  const flavor = detectShellFlavor(shellPath);
  const quoted = paths.map((path) => quotePath(path, flavor)).join(" ");
  return `${quoted} `;
};
