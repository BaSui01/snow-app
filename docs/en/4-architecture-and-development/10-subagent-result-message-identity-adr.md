# ADR: Sub-agent result message identity and existing conversation UI

- Date: 2026-10-23
- Status: Repair decision established; build and runtime acceptance are recorded separately.
- Scope: Message identity at the sub-agent event receipt boundary and the existing sidebar agent list.

## Context

`listChatMessages` exposes `chat_messages.id`, also used by in-memory messages and persisted tool boundaries. Automatic event receipt stores internal `chat_messages.message_id` values. Returning those values directly as `messageIds` makes the renderer report `committed parent input is missing` despite committed messages. Explicit getResult/wait acknowledgment similarly queries the wrong identity column when verifying a renderer-provided row ID.

Asynchronous execution changes scheduling and delivery, not conversation navigation. Existing expandable parent conversations, child agent rows, status icons and selection already provide the appropriate UI. A separate background/pending run list duplicates that UI and incorrectly treats undelivered results as requests for user action.

## Decision

1. Public `receive.messageIds` and input `toolMessageId` use `chat_messages.id`, matching existing message APIs. No JSON fields, table schema or message APIs change.
2. `verify_tool_message` checks the row ID, parent conversation, tool role and sent status. Event identity, project/task scope and structured result checks remain mandatory.
3. Keep existing internal receipt identifiers. Before returning, resolve stored identifiers to parent-scoped row IDs in the same transaction: prefer an exact row ID, then support existing `message_id` identifiers. Missing rows cause a persistence error and transaction rollback. Compatibility applies only to trusted stored receipts, not caller-provided `toolMessageId`.
4. Idempotent receipt replays return the same row IDs without inserting duplicate messages. Deduplicate row IDs when multiple events share one tool message. Do not suppress missing-input errors, fabricate messages or replay tools.
5. Remove the separate background/pending count and run-card list from the sidebar. Preserve existing expansion, agent selection, input attention, execution icons, deletion gates and retry controls. Existing tool cards and agent conversations retain run details and cancellation actions.
6. Reuse existing icons and semantic classes for queued, running, waiting_input, finalizing and cancelling states. Undelivered results alone do not request user input or authorization.
7. Add no dependencies, schema migrations, private business styles, inline styles, test files or mock business data. Do not change existing time storage or mutate live application data.

## Execution mode setting

The sub-agent settings page exposes a global execution policy through existing `system_settings` IPC. The key is `sub_agent_execution_mode`; allowed values are `sync` and `async`. Missing settings default to sync. A saved selection is authoritative, not a suggested tool default: activate and terminal continue read it before admission; a model-provided `executionMode` is validated but cannot override it. Busy continue only queues input for the existing run without changing its mode. Accepted runs retain their captured mode. Each dispatch reads persistence to avoid stale detached-window caches. Read failures and invalid stored values fail explicitly; unsupported async entry points must reject rather than silently run synchronously. The effective mode is part of idempotent logical input; changing the setting must not reuse an old requestId to start a different run.

The control reuses existing selection and shared styles. It displays a new selection or success only after persistence succeeds and retains the original value on failure. New UI text comes from all three dictionaries, without extra helper copy or background lists.

## Execution mode and tool exposure

Each model request filters parent tools after existing global/project permissions and whitelists, using the persisted execution mode without rewriting MCP switches or approval grants. Sync retains activate, listSubAgents and continue by default. Project-bound async adds getResult, wait and cancel. After switching back to sync, historical async runs in this exact project/parent retain getResult; nonterminal async runs additionally retain wait/cancel until settled. Read-only checks do not consume events, mutate run/task state or load full summaries. Settings catalogs still show registered tools; request filtering is not a user disable operation.

Workflow nodes lack async capability: hide async management tools, and hide unsupported activate/continue under async settings. Unbound async entry points follow the same rule. Existing child whitelists, teammate communication and restricted-request isolation remain unchanged; synchronous batches can still run in parallel. Failed or invalid mode reads never select another execution mode. Tool descriptions reflect actual exposure rather than unconditionally recommending hidden wait/getResult tools. Changes take effect on the next request; already emitted tool calls and accepted runs keep existing validation, without forced stops or replay.

## Validation boundary

Use existing TypeScript/Rust checks, documentation guards and a full build, plus independent review of message mapping and UI reuse. Runtime acceptance should cover automatic message pairs, explicit getResult/wait deduplication, idempotent receipt and existing agent navigation. Compilation is not UI/end-to-end acceptance: the host must load the new native and renderer artifacts before manual verification.
