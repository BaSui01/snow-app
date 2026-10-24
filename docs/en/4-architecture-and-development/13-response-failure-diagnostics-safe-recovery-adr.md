# ADR: Response failure diagnostics and safe recovery

- Date: 2026-10-24
- Status: implementation contract frozen; verification evidence is reported separately.
- Scope: Chat / Responses terminal failures, persisted message presentation, and the model/tool replay boundary.

## Decisions

1. No new dependency, schema migration, live database mutation, Git operation, tool permission change, or sub-agent execution-mode change. Store only small diagnostics in the existing assistant raw_json field; never retain raw SSE, request payloads, or tool results as failure metadata.
2. native/src/api/failure.rs is the shared normalizer. ProviderFailure contains optional message/code/type strings. Redact before truncation (768 UTF-8 bytes for message, 128 each for code/type), including exact nonempty request secrets, authentication, cookies, credential URLs and structured request echoes. Generated content is never inferred to be an error reason.
3. Keep ResponsesApiResult.failureReason as an optional readable safe string; expose the same optional field on historical ChatMessageRecord. Persist {providerFailure:{message,code,type}} in raw_json, without a schema change. Missing historical metadata stays missing. Preserve generated body and render a separate error notice, using a localized explicit missing-reason message.
4. Chat errors retain safe metadata instead of stderr-only reporting. Failed responses cannot expose executable tool fragments. Responses keeps existing conservative retry classification and cancellation vetoes. Cancellation clears failure metadata, and attempt resets cannot leak earlier errors.
5. Terminal failures use ERROR logs with the fixed message AI response stream failed. JSON context contains conversation_id, response_id, provider, status, safe failure fields and bounded counters, never body text, tool inputs/results, request bodies/headers, or raw stream events. Missing response IDs stay empty. Logging is best effort; ephemeral requests remain nonpersistent.
6. Model recovery does not roll back or replay completed tools. Failure disposition is checked before tool dispatch. Completed tool results remain context; recovery must not rerun activation/continuation operations from failed responses. Cancellation wins. Recovery is bounded and protected by executable guards, not prompt-only instructions. Explicit user rollback/re-execution remains a distinct operation with existing confirmation boundaries.

## Tightened recovery boundary

Existing retry cleanup deletes current request rows, so it cannot safely remove completed tool results. This repair fails closed: the renderer checks current tool-result messages before retry, and native code checks the deletion range inside an IMMEDIATE transaction; any tool row prevents deletion. The user is told to continue from preserved conversation state rather than replay actions. No new context deduplication or resume protocol is introduced. Requests without tool results retain manual model retry. Cancellation is checked again after awaited cleanup and before streaming resumes. Explicit user rollback remains a separate operation.

## Verification boundary

The parent agent owns the full gate suite; implementers run only scoped LSP checks. No new test files, business mocks, fake progress, inline styles, hex colors, or Unicode emoji. No live database, paid-model, service-start, or Git operations. Verify changed supported files with LSP, type checking, existing documentation/format guards and the full build; use file-free in-memory probes for redaction, body/error separation and dispatch guards. Compilation is not live-model or UI end-to-end acceptance.
