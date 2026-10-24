# ADR: Separate archiving from deletion gates

- Date: 2026-10-24
- Status: User approved implementation; compilation and live UI acceptance are separate.
- Scope: Single, batch and plugin conversation archiving through the shared removal bridge. Permanent-deletion safety remains unchanged.

## Problem

Archiving previously committed `prepare_delete` separately for each root before moving data. Preparation was not archival completion. A later failure or wait left persistent deletion gates, “deletion in progress” messages and permanent-delete recovery controls, despite the user's intent to archive.

## Frozen contract

1. Archiving does not invoke `prepare_delete`, create persistent deletion gates or use permanent deletion as recovery. Actual deletion retains its preparation, cancellation, owner-drain and physical-cleanup protections.
2. Renderer preparation only queries delegated-run terminal state and drains locally owned terminal executions. Active runs produce an explicit error without cancellation. The parent is stopped and local session state released only after this check.
3. Rust rechecks every descendant run under the existing ATTACH/Immediate transaction before copying. The renderer precheck never replaces storage-level validation; concurrent admission cannot acquire the transaction's write lock.
4. After copying complete run, request, message, event and acceptance facts, delete live runs by the exact copied IDs before cleaning sessions and conversations. The permanent-delete triggers remain unchanged. All copies and cleanup share the original transaction and roll back together on an ordinary SQL failure. Do not ignore conflicts or disable foreign keys.
5. Conversations left gated by the old archive path may be archived again. Successful conversation removal clears old gates through existing foreign-key cascades. Failure does not silently reopen admission or claim success.
6. Clear drafts, switch away from an archived active conversation and refresh the list only after successful storage completion. Pinned skipping, tombstones and restore semantics remain unchanged. No new schema, dependency or test files; no operations on the user's real database and no automatic restart.

## Verification boundaries

Use isolated in-memory probes of source SQL for terminal archives without gates, retrying old gates, rollback on copy/cleanup failure, active-run rejection, unchanged permanent-delete guards and foreign-key integrity. Run changed-file LSP diagnostics, TypeScript/Rust checks and production builds. The user's original eight conversations require a new application process and an explicit archive retry; source probes do not establish live UI acceptance.
