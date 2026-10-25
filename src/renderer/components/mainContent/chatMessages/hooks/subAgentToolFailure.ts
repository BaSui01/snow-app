/** Preserve terminal output for both rejected calls and structured tool failures. */
export const withSubAgentTerminalFailureOutput = (
  result: string,
  streamingStdout: string,
  streamingStderr: string,
): string => {
  if (!streamingStdout && !streamingStderr) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return result;
  const failure = parsed as Record<string, unknown>;
  const stdout =
    typeof failure.stdout === "string" && failure.stdout.length > 0
      ? failure.stdout
      : streamingStdout;
  const stderr =
    typeof failure.stderr === "string" && failure.stderr.length > 0
      ? failure.stderr
      : streamingStderr;
  const partialOutput =
    typeof failure.partialOutput === "string" &&
    failure.partialOutput.length > 0
      ? failure.partialOutput
      : [stdout, stderr].filter(Boolean).join("\n");
  return JSON.stringify({ ...failure, stdout, stderr, partialOutput });
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
