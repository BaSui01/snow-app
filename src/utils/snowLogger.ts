import type { AppLogInput } from "../main/native/types";
import { native } from "../main/native/nativeBridge";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  module: string;
  func: string;
  line?: number;
  message: string;
  input?: string;
  output?: string;
  duration?: string;
  context?: string;
  error?: string;
}

const pendingWrites = new Set<Promise<void>>();

export function writeLog(level: LogLevel, entry: LogEntry): void {
  const input: AppLogInput = {
    level,
    module: entry.module,
    func: entry.func,
    line: entry.line,
    message: entry.message,
    input: entry.input,
    output: entry.output,
    duration: entry.duration,
    context: entry.context,
    error: entry.error,
    source: "main",
  };
  const task = native.writeAppLog(input).catch(() => {
    // Logging failures must not break application functionality.
  });
  pendingWrites.add(task);
  const settle = (): void => {
    pendingWrites.delete(task);
  };
  task.then(settle, settle);
}

export const flushLogs = async (timeoutMs = 2000): Promise<void> => {
  if (pendingWrites.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    while (pendingWrites.size > 0) {
      const drained = await Promise.race([
        Promise.allSettled([...pendingWrites]).then(() => true as const),
        deadline,
      ]);
      if (!drained) return;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const snowLog = {
  debug: (entry: LogEntry) => writeLog("DEBUG", entry),
  info: (entry: LogEntry) => writeLog("INFO", entry),
  warn: (entry: LogEntry) => writeLog("WARN", entry),
  error: (entry: LogEntry) => writeLog("ERROR", entry),
};
