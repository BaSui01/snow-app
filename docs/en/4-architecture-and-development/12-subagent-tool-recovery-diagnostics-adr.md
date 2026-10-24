# ADR: Sub-agent tool recovery and diagnostics

- Date: 2026-10-24
- Status: Repair contract established; build, static checks and runtime acceptance are recorded separately.
- Scope: Ordinary read errors terminating delegated runs, duplicate IPC listeners and missing preview update configuration.

## Evidence and boundaries

OS error 2 means a missing file, not an empty file. Empty text already has a successful empty-result branch. The frozen preview stops the delegated loop whenever a tool Promise rejects; this is not evidence of a process crash. Without run identities, do not connect RUN_BUSY, update failures and read errors as one incident. The temporary file producer and cleanup timing remain unknown; do not change unrelated project files speculatively.

## Decision

1. Keep storage, IPC signatures, permissions, conversation isolation, update source and MCP negotiation unchanged. Add no dependencies. Reuse the existing writeLog system log entry point.
2. Conservatively classify known filesystem-read read/decode/empty-image/argument errors as recoverable. Keep the error tool card and original result, and return the error to the model to choose a corrected path or another authorized action. Never automatically replay the tool. Unknown errors remain fatal. Permission gates, cancellation, ownership, state transition and persistence errors must not be recovered as ordinary read errors.
3. Stop after three consecutive tool rounds containing recoverable read errors, with a recovery-budget reason. A full round without these errors resets the count. This bounds the loop without changing existing model/network retries.
4. Log tool start/completion at DEBUG, recovery decisions at WARN, fatal stops at ERROR, and run start/committed terminal outcomes at INFO. Include only run/conversation/call identities, tool name, fixed reason codes, recovery decisions, counts, duration and empty-text flags. Never include arguments, paths, file contents, prompts, raw exceptions or credentials. Logging failures must not affect execution. Log terminal outcomes only after successful settlement.
5. Multiplex sub-agents:changed through one underlying IPC listener, preserving the API. Unsubscribe is idempotent; detach after the last subscriber. Isolate callback failures without raising EventEmitter listener limits.
6. Copy the existing dev-app-update.yml into preview snapshots, preserving real update checks. Diagnose missing local configuration explicitly; do not fabricate remote success or change the update source. Do not edit frozen snapshots; a new preview process must load the repair.

## Review refinements

- Recover numeric OS code 2 only (unambiguous missing file across platforms), not a union of Windows/Unix codes. Device, permission and unknown I/O failures remain fatal.
- Close stopped batches with TOOL_NOT_EXECUTED results and rejected acceptance evidence for remaining calls, without running them or leaving pending cards/unpaired history.
- Move existing result formatting/waiting and error mapping unchanged into subAgentRunResults.ts to bound the loop file size; keep the protocol unchanged.
- The shared main-process snowLogger uses a Promise boundary to isolate synchronous native throws and asynchronous rejections while preserving pendingWrites/flushLogs. Scope rejection logs omit potentially path-bearing project IDs, retaining safe parent identity and match booleans. This tightens ADR11 diagnostic fields, not permission checks.

- Fatal errors and exhausted recovery budgets block both initial and repeated force-send entry before consuming buffered input. Never clear the old error to restart the same run.

## Validation

Do not add test files, use Git, access live conversation databases, call paid models or download updates. The main agent owns changed-file LSP diagnostics, existing documentation/format guards and the full build. Use isolated in-memory probes for recovery classification, subscription cleanup and snapshot copying. Live delegated IPC, temporary-file producer and UI verification remain separate runtime acceptance; compilation does not prove them.
