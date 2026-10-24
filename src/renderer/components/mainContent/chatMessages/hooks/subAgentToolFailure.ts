export type RecoverableReadReason =
  | "READ_PATH_ERROR"
  | "READ_DECODE_ERROR"
  | "READ_EMPTY_IMAGE"
  | "READ_ARGUMENT_ERROR";

/** Only native filesystem-read failures with a known shape are recoverable.
 * Never inspect path text for error codes or accept a generic NAPI status alone.
 */
export const classifySubAgentToolFailure = (
  toolName: string,
  errorMessage: string,
): RecoverableReadReason | null => {
  if (toolName !== "filesystem-read") return null;
  const message = errorMessage
    .replace(/^Error invoking remote method '[^'\r\n]+': /, "")
    .replace(/^Error: /, "");
  if (message === "Image file is empty") return "READ_EMPTY_IMAGE";
  if (
    message ===
      'filePath must be a non-empty string for tool "filesystem-read".' ||
    message === "filePath is required for filesystem-read" ||
    /^filePath is required for tool "filesystem-read"\. Received keys: \[[^\r\n]*\]\. Please provide a valid file path\.$/.test(
      message,
    )
  )
    return "READ_ARGUMENT_ERROR";
  if (
    /^Failed to decode file as text: not a text file in a supported encoding \(binary content detected\) \(path: [\s\S]*\)$/.test(
      message,
    )
  )
    return "READ_DECODE_ERROR";
  const readFailure =
    /^Failed to read (?:file|directory): ([^\r\n]*?) \(path: [\s\S]*\)$/.exec(
      message,
    );
  const imageFailure = /^Failed to read image file: ([^\r\n]*)$/.exec(message);
  const cause = readFailure?.[1] ?? imageFailure?.[1];
  // ENOENT / Windows ERROR_FILE_NOT_FOUND share code 2. Do not merge other
  // platforms' numeric codes: Windows 21 is a device error, not EISDIR.
  // Unknown, permission and resource/IO faults deliberately remain fatal.
  if (cause && /^[^()\r\n]+ \(os error 2\)$/.test(cause)) {
    return "READ_PATH_ERROR";
  }
  return null;
};

export const SUB_AGENT_RECOVERY_ROUND_LIMIT = 3;

/** Call once per complete tool round, not once per tool. */
export const advanceSubAgentRecoveryBudget = (
  previousRounds: number,
  hadRecoverableFailure: boolean,
): { consecutiveRounds: number; exhausted: boolean } => {
  const consecutiveRounds = hadRecoverableFailure ? previousRounds + 1 : 0;
  return {
    consecutiveRounds,
    exhausted: consecutiveRounds >= SUB_AGENT_RECOVERY_ROUND_LIMIT,
  };
};

/** Empty successful text is a diagnostic fact, never a failure classifier. */
export const isSubAgentEmptyTextRead = (
  toolName: string,
  result: string,
): boolean => {
  if (toolName !== "filesystem-read") return false;
  try {
    const value = JSON.parse(result);
    return (
      value !== null &&
      typeof value === "object" &&
      value.content === "" &&
      value.totalLines === 0 &&
      value.isImage !== true &&
      !value.error
    );
  } catch {
    return false;
  }
};
