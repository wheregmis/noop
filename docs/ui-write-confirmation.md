# Confirming UI and chat writes

Changing a task's machine, member, priority or requirements must not report success when refreshing or synchronizing the shared data failed. The same rule applies to owner-created work, amendments, cancellation, plans and memory writes.

## Persistence contract

1. Serialize each operation with the scheduler and refresh the current mirror before making a change. A failed refresh changes nothing.
2. Record the resulting identity as soon as a write occurs. A failed publication returns an explicit partial result with that identity and `saved_locally: true`; it never becomes an ordinary success.
3. Wake planners only after confirmation. Chat may acknowledge a request quickly, but a failed action produces a same-thread correction and a failed tool result.

## Message delivery contract

The client sends a bounded `Idempotency-Key` header that remains stable across retries. Uploaded image URLs are cached for that key so a retry has the same payload. Direct task replies retain their request key while delivery is unconfirmed.

The hub scopes receipts to the authenticated owner session. Its event, primary inbox item and receipt commit together; replay returns the existing event and never enqueues another action. The local server keeps private receipts outside shared data, including the original event and confirmed or partial result. A failed refresh can retry against that same event. An interrupted running action is uncertain and is not replayed automatically. Receipts expire after seven days.

The primary also uses the event identity when consuming cloud messages. This protects the gap between applying a message and acknowledging the inbox item. Partial results are acknowledged with a visible warning rather than repeatedly applying an uncertain mutation.

Task cancellation and marking done use the same confirmed request channel. New task and plan confirmations first require the primary's `GET /api/stops/capabilities` response with `family_stops: 1`. Remote claiming machines must advertise `task_api: 2`, which includes related-run capture; older single-run support cannot satisfy the action. Active requests bind the host and unique run identity shown before the owner's confirmation. The primary delegates remote stops to the claiming machine, which waits for process-tree shutdown before publishing terminal state. Queued UI requests refuse an intervening active run. A rejected cancellation shows the reason on its page and restores its controls.

Task-control request keys survive lost initial replies as well as pending tickets. The cloud scopes those receipts to the owner session; the local primary stores private results before acknowledging them. Replaying an uncertain, partial or completed request cannot silently target a replacement run. The task page offers a same-request check and a status refresh.

The client retains outgoing messages until a valid event receipt arrives, even if the HTTP status is successful. Unsend preserves a newer composer draft. Before installing an app update, pending messages and image or reply drafts must be reviewed; failed retry rows can be dismissed explicitly without deleting any task or plan already created.

## Related-run stop recovery

A cancelled plan or terminal parent record does not by itself confirm that every descendant stopped. Cancellation persists the original active run identities in a `pending_stops` batch before losing the plan's running-step links or the parent's child links. Queued descendants are handled in the same mutation; unverifiable active work remains unresolved. Exact stop markers also reach the target machines through shared data.

The primary drains captured targets outside the file lock and removes them only after a refreshed, synchronized terminal record confirms the original run. Pending targets and failed progress publication produce a partial `503`, preserve the owner identity, and remain visible on cancelled-plan and terminal-parent pages. Startup recovery honors a matching stop intent instead of requeueing that interrupted run.

**Retry remaining stops** starts a separate recovery request containing the displayed `operation_id`; a newer operation conflicts with `409`. When only publication confirmation remains, the same action is labelled **Confirm cleanup**. Task recovery uses `/api/tasks/stops/retry` with `{id, operation_id}`, and plan recovery uses `/api/plans/:id/retry-stops` with `{operation_id}`. The original receipt stays unchanged even after recovery finishes. Archive and reopen guards remain until the pending cleanup is confirmed.

Pending and unresolved rows can be reviewed explicitly. A fresh preview binds the owner, operation, batch and current task records. Inclusion authorizes only that reviewed version; exclusion records a reason, preserves the live task and does not claim it stopped. Both decisions leave a durable audit. A changed preview returns `409` before any marker or process change. The coordinator respects exclusions instead of rediscovering them.

Review resolution uses a stable `request_id` in its body. An identical replay returns the saved decision and can retry its publication without applying it again, including after its row was removed. A changed payload with the same identity conflicts. If local write damage leaves an audit without its matching owner decision, replay fails closed and requires a fresh review. Cloud publication recovery may use a new transport ticket while retaining the domain request identity; the original partial receipt remains immutable. A confirmed include proceeds through exact-run cleanup, and a confirmed exclusion can release archive/reopen guards once no other work remains unresolved.

Archive restoration follows the same publication rule, with its own durable restore receipt. Replaying the request cannot restore twice or undo a later deliberate deletion. Remote project restoration requires current machine-folder proof; confirming an existing restore receipt can work without that machine online. Restored routines stay paused and plans remain terminal history. See [Archived records](ui-archives.md) for the browser and request contract.

Explicit task creation and reopening save all selected run settings before inbox publication. Their receipts preserve task identity across claims, later attempts and terminal states; reopening also requires a current terminal-record preview and completed related-run cleanup. Confirmation-only checks cannot create or reopen work. See [Creating and reopening tasks](ui-task-forms.md) for the UI and request contract.

## Verification

- False or throwing refresh: no file changes.
- False or throwing publication: stable identity, explicit partial result and no premature planner wake.
- Repeated message keys: one event and one action; changed payloads conflict.
- Restarted handlers: completed receipts survive; uncertain running operations do not replay.
- Failed image delivery: the same key and image URLs are reused.
- Desktop and phone errors retain the saved task identity and offer inspection.
- Rejected cancel and done requests leave usable controls and display the returned error.
- Active child/grandchild stops survive real cross-host synchronization and daemon restart without requeueing cancelled work.
- Partial child publication remains pending until the terminal record is synchronized; an explicit recovery request can then clear it while the original partial reply stays unchanged.
- Stale run or cleanup-operation UUIDs cannot target a replacement run; pending cleanup blocks archive/reopen until confirmed.
- Stale review previews cannot authorize a replacement attempt; explicit fresh inclusion records both original and reviewed identities.
- Lost review replies and partial publication preserve one audit entry, even when the reviewed row has already been removed.
- Audited exclusions remain excluded during background discovery and can release archive guards while their processes remain alive, without creating false terminal records.

All verification uses temporary data and fixture messages; it does not alter live tasks or send external notifications.
