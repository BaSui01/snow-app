# ADR: Sub-agent cancellation attribution and acceptance evidence boundaries

- Date: 2026-10-24
- Status: Contract frozen; implementation and verification are recorded separately. Compilation does not replace new-process end-to-end acceptance.
- Scope: Cancellation observability, real follow-up probes and tool semantics; no changes to scheduling, permissions or business acceptance algorithms.

## Context

E2E A7 and a later read-only probe were already cancelled before the parent cancel request arrived, yielding already_terminal. Neither interruption text nor a terminal state identifies the first cancellation initiator. Do not infer a tool, parent stop, child stop, UI or deletion source from those historical records. Normal termination, checklist satisfaction and business correctness are separate facts.

## Frozen contract

1. Keep outcome version 1. Add optional cancellation `{ source, requestedAt }` to SubAgentRunRecord, SubAgentOutcome and SubAgentCancelReceipt. Sources: `cancel_tool | parent_stop | conversation_stop | ui_cancel | deletion | runtime_abort | unspecified`. requestedAt is UTC epoch milliseconds captured by Rust when cancellation is first durably accepted, not click time. Callers cannot supply it. Missing means unrecorded, never backfilled.
2. The internal cancel command accepts optional source, defaulting to unspecified. The public model cancel tool still accepts only runId; trusted host branches supply the classification. Main and Rust reject invalid values. Source is diagnostic metadata, not authorization.
3. First accepted cancellation wins. queued cancellation and running/waiting_input to cancelling write status and metadata atomically. Retries while cancelling do not overwrite either value or claim legacy records lacking attribution. too_late while finalizing and already_terminal never add or replace cancellation.
4. The deletion path changes state directly and must record deletion separately. Resource drains and cancellation observers execute existing cancellation rather than initiate new attribution. Classify parent versus child stops from actual target identity; use ui_cancel in the UI resolver, cancel_tool in the model tool branch and runtime_abort only for an otherwise unattributed runtime abort. Do not claim runtime_abort proves a user action.
5. The persisted run is authoritative. finish/settle/generated outcomes project its cancellation and cannot trust or invent attribution from a renderer outcome. Recovery remains interrupted, not cancelled. Missing historical metadata stays missing. get/wait, synchronous final results and automatic events carry the same metadata.
6. Host cancellation logs include disposition, runStatus and authoritative cancellation. Renderer runSettled explicitly projects safe source/time fields. Never log full prompts, tool payloads or credentials. No new UI cards or lists; this iteration exposes metadata through tool results and logs.
7. No schema migrations, state-edge changes, dependencies, live database manipulation, restart/install, Git operations or new test files. Use isolated in-memory probes and existing checks. Restart, cross-window and deletion live tests require user participation.

## Acceptance and summary boundaries

- Acceptance currently checks whether evidence IDs belong to the child execution log. It does not independently judge semantic relevance or guarantee business success. The parent must inspect tool status and directly relevant content. One genuine result may support multiple related criteria.
- Do not replace deterministic verification with keyword/path heuristics or another model, or introduce a semantic verification service in this change. An isolated negative probe exposes this limitation, not a real task success.
- summary is the final turn text, not a complete transcript. Intermediate reports/tools belong to the child conversation; their absence alone does not prove storage truncation. Pagination uses Unicode character offsets, not turn history.
- Both wait(any) and wait(all) return snapshots for every requested run. any succeeds when at least one run is terminal, all when every run is terminal. Timeout never cancels. Result array length cannot distinguish the modes.
- message_queued proves queuing only. Run-event deliveryStatus=received proves durable incorporation into parent input only, not model comprehension or delivery of a queued message.
- Two activate calls create independent child conversations, not a RUN_BUSY case. RUN_BUSY concerns an existing active target; busy continue should queue a message.

## Verification boundary

Check first-source preservation, queued/running/deletion cancellation, no attribution for late requests, legacy records, authoritative outcomes, invalid sources and safe logs. Run existing TypeScript/Rust builds, format and documentation guards. Distinguish live end-to-end evidence from isolated source probes. The running instance does not load new Rust/renderer code merely because files changed; real new-field IPC/UI acceptance requires a new process.
