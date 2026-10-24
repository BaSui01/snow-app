# ADR: Runtime scope, read snapshots and LSP shutdown

- Date: 2026-10-23
- Status: Source repair, full build, documentation/format guards, real read probes and scoped source review completed. Post-restart agent/LSP scenario acceptance remains outstanding. Supplemental rustc push diagnostics timed out; the full Rust build supplied compilation validation.
- Scope: Sub-agent scope rejection, read-cache side-channel errors and LSP retirement.

## Verified context

1. Electron and Rust independently verify that the parent conversation exists and belongs to the requested project. Preserve both isolation checks; the active UI project is not a replacement for the parent's persisted binding.
2. The filesystem-read tool already expands home paths and supports directories. ReadonlyCallGuard instead joins home paths to the workspace and uses file-only readFileContent for directories. Snapshot errors do not prove tool failure.
3. LSP shutdown queues exit and immediately aborts the mainloop that owns pipe I/O. A queued notification is not proof of transmission.

## Decisions

- Do not change database schemas, tool permissions, parent/child isolation, MCP negotiation or existing timestamp contracts. Add no dependencies.
- Repair sub-agent caller identity/lifecycle rather than accepting invalid scope. Track each runId only after a new admission succeeds; terminal commits retire only that run, while a confirmed missing parent retires its scopes and revokes local wake eligibility. Stop stale component queries, coalesce cancellation observers without dropping intervening changes, and prevent stale results from cancelling retired runs. Rejection logs identify the operation and requested/actual projects without task contents.
- Preserve home-relative paths and resolve exact entries through the existing native resolver. Dispatch files and directories separately. Do not use failed file reads to detect directories or project suffix matching to substitute another snapshot target. An unavailable snapshot cannot justify cache reuse.
- Reuse the shared Rust expand_home_dir helper. Never hardcode usernames, drives or shell HOME in renderer code.
- LSP shutdown requests shutdown, queues exit, keeps communication alive during a bounded child wait, kills only as necessary, and cleans up the communication task last. Record actual failures instead of hiding language-server errors.
- Do not guess at configuration changes for watcher warnings without their target paths. Legacy MCP handshake notices remain normal compatibility behavior.

## Validation

The main agent owns final supported-file LSP diagnostics, TypeScript/Rust compilation, documentation guards and the full local build. Reproducible probes use only project source and explicitly identified non-sensitive documentation, without test files, live conversation mutations or Git operations. A successful build does not reload the running host; application verification requires a new process.
