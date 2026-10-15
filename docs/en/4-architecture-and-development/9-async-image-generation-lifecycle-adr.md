# ADR: Asynchronous image-generation task lifecycle and delivery

- Date: 2026-10-15
- Status: Implemented; live provider/UI acceptance requires a process running all new artifacts.
- Scope: Rust image generation, SQLite task facts, Electron IPC/preload, chat galleries and batch notifications.

## Context

A pending tool response acknowledges admission, not generation completion. Releasing a preload callback when invoke resolves loses every late terminal event. Updating only React state also loses completion after history reload. A generated library image is not evidence of delivery to a chat card or an agent notification.

## Decisions

1. Persist independent `image_generation_batches` and `image_generation_tasks` in SQLite. New timestamps are UTC RFC3339 with a Z suffix; existing application-log timestamp formats are not migrated here. Task transition timestamps advance strictly, including same-millisecond transitions and wall-clock rollback.
2. Use existing UUID support for task identities. States are `registered`, `queued`, `running`, `completed`, `failed`, and `cancelled`. `asynchronous` distinguishes a background receipt from a synchronous result.
3. Register authorized, valid image-tool members before invocation. The runtime creates the batch ID and binds each member to its conversation, interaction ID and call ID. Seal the batch in the executor's finally phase; cancel only members that remain unsubmitted. Queued and running tasks continue.
4. Main overwrites the reserved `__snowImageGeneration` metadata with actual IPC conversation/interaction IDs. Rust overwrites conversation ownership again from the trusted dispatcher argument. Unregistered direct calls create independent sealed batches; empty-conversation tasks do not notify a chat agent.
5. Commit the terminal `resultJson` before emitting events. The durable task, not a one-shot callback, is authoritative. Apply result privacy processing without damaging task identities, image references or structured result parsing. Do not persist channel credentials, authorization headers or secrets; normal lifecycle logs contain identifiers and status, not prompts or result bodies.
6. Keep `stream=imagegen` partial previews and terminal chunks. Attach the complete task snapshot. In preload, retain callbacks only when the actual response is pending; synchronous results and submission failures release immediately. A terminal arriving before the receipt must not be re-registered. Budget expiry performs bounded reads of real task state and resource cleanup, never fabricated completion.
7. Add an independent `imagegen:task` subscription with bounded replay. History loading, conversation switching, focus recovery and lost callbacks can query persisted snapshots. Locate cards by task ID, call ID or interaction ID, not a temporary assistant message ID. Missing legacy task facts produce an explicit localized unavailable state and never automatically repeat paid requests.
8. Keep React updaters pure. Deduplicate terminal consumption and schedule notifications outside them. Each image updates its original slot immediately. After a sealed batch reaches all terminal states, count success, failure and cancellation and issue one localized summary; there is no first-image delay window.
9. Atomically claim notification eligibility in SQLite by conversation and batch. Release a claim when dispatch is rejected. Log queued versus sent separately. This prevents normal duplicate delivery but does not promise strict exactly-once external model calls across a process crash.
10. Enforce `maxConcurrentImages` at each actual upstream image request in Rust, including legacy multi-image calls. Hold permits through streaming, downloads and image-result finalization. Pending receipts do not release permits. Publish running only after actual request admission. Frontend limits submission slots without draining the entire queued list.
11. Explicit startup recovery, after the single-instance/storage gate, settles interrupted previous-process tasks as failures and seals orphaned batches without resending upstream requests. Read APIs never trigger startup recovery.
12. Separate submission, request start, terminal commit, callback enqueue, IPC forwarding, frontend consumption and notification stages in metadata-only logs. Include `conversation_id`, task ID and batch ID; successful generation must not be described as successful frontend delivery.
13. Reuse existing dependencies and shared TypeScript contracts. No test files, mock providers, scattered CSS, new inline styles or hard-coded color values are introduced. Handwritten modules stay below 120KB.

## Boundary APIs

The NAPI boundary encodes snapshots as JSON strings. The preload facade exposes validated typed objects from `src/shared/imageGeneration.ts`.

- `registerImageGenerationBatch(registrationJson)` registers `{conversationId, batchId, members:[{interactionId,callId}]}`.
- `sealImageGenerationBatch(conversationId,batchId)` seals submissions and returns a batch snapshot.
- `listImageGenerationBatches(conversationId)` lists only that conversation's batches.
- `getImageGenerationTask(conversationId,taskId)` returns the exact task or null.
- `claimImageGenerationBatchNotification(conversationId,batchId)` atomically claims a sealed, terminal, asynchronous batch.
- `releaseImageGenerationBatchNotification(conversationId,batchId)` releases a rejected dispatch claim.
- `recoverInterruptedImageGenerationTasks()` is startup-only and does not run from queries.
- `onImageGenerationTask(listener)` is the independent preload subscription and returns an unsubscribe function.

Batch snapshots contain `{batchId,conversationId,sealed,notified,tasks}`. Task snapshots contain `{taskId,conversationId,batchId,interactionId,callId,status,asynchronous,resultJson,createdAt,updatedAt,durationMs}`. Pending receipts additionally carry `deadlineAt`, `budgetMs`, `timeoutSecs` and the task snapshot.

## Acceptance boundary

Compile Rust and TypeScript and build Electron production artifacts. Check documentation, shared contracts and module sizes. Live acceptance must separately observe an immediately returned pending receipt, individual original-card updates, a single all-terminal batch summary, history recovery, explicit failure states, and real upstream concurrency limits. Compiling successfully is not a claim that a provider request or the running application's UI was exercised. All new native, main, preload and renderer artifacts must be loaded together before that exercise.
