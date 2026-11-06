# Creating and reopening tasks

Open **All tasks → New task** to choose instructions and run settings together. The form includes title, member, AI tool, machine, OS, project, required capabilities and priority, plus preferred capabilities and resource use. The selected settings and an explicit planning timestamp are written before the task enters the shared inbox. Automatic routing does not replace those selections.

Matching machines are shown before submission. When valid run settings have no matching machine, the action explicitly queues work until one is available. Choose another available OS or machine when the work supports it. A selected project binds its machine, folder and requirements; changed project placement requires a refreshed selection before submission.

On a done, failed or explicitly cancelled task, choose **Reopen with run settings**. New instructions create another attempt under the same task ID, retaining earlier runs as context. Current cleanup or ownership by an open plan or waiting parent can block independent reopening; resolve that work through its existing controls first. Reopening does not restart related tasks or reuse old operational plan links and approvals.

The reopen preview binds the current terminal record. A changed task returns `409` and requires a refreshed preview. A legacy custom folder can remain on its original machine, using **Use folder’s current machine** when needed. Select **None** to detach that folder before choosing another machine. Registered projects carry a snapshot of their current host, path and effective requirements.

Learning tasks keep the machine holding their private digest. Their run settings show that source as fixed, including when it is offline; **Any machine** and other hosts are unavailable. A task that was previously moved can be saved back to its verified source. Projects must use that same machine. A reopen preview detaches a conflicting old project or custom folder with a warning, so the reviewed settings can repair the placement. Member, tool, title and capability settings remain editable.

Some older learning tasks preserve their source in their original owner metadata. Reassignment does not remove that restriction. If a legacy task's source cannot be verified, or its learning metadata is malformed, changes and execution fail with an explanation. Cancel that obsolete task and use the source machine's Learning controls for a new collection. An incremental preview does not recover history whose old checkpoint was already consumed; explicit full-history collection currently uses `noop learn --full`.

Each explicit action has a stable `request_id`. Closing the form or navigating away preserves its exact pending request and draft. **Check saved task request** confirms a receipt; **Retry same request** checks that same authorization. Completed receipts remain historical after a worker claims the task, a newer attempt starts or the task finishes again. Replaying them cannot create another task or reopen a later run. Changed instructions or settings with the same request identity conflict.

A failed publication returns the saved task identity with `saved_locally: true`; retry publishes that existing action without repeating it. A prepared or reservation-only authorization remains pending until completion can be verified. It does not claim the task was queued, and its ID cannot be reused for unrelated work. Inspect the current task before authorizing a fresh request. Starting fresh while an earlier request is uncertain requires explicit acknowledgement that it may still finish.

The primary serves three POST-only endpoints, rejecting query strings and unknown fields:

- `/api/tasks/create`: `{request_id, instructions, settings, confirm_only?}`.
- `/api/tasks/reopen-preview`: `{id}`.
- `/api/tasks/reopen`: `{request_id, id, preview_digest, instructions, settings, confirm_only?}`.

`settings` contains `{title, agent, cli, host, requires, priority, prefer, weight, project, project_guard?}`. A selected project's guard contains `{host, path, requires}`. `confirm_only: true` checks the original action before reading current task or project state and never creates or reopens work. Missing receipts return `404`; a known incomplete reservation returns `503` with its stable pending identity. A chat reply to a cancelled task returns a readable `409` directing the owner to explicit reopening.

Learning source fields in task detail, status and reopen previews are read-only. The server derives them from current records and rechecks them after refresh, during claiming and before execution. Client-supplied run settings cannot replace the source binding. Saved confirmation-only requests still describe their historical action and never move or recreate work.

`cloud/test/task-forms.ts` verifies the production Worker with separate RemoteFiles primary and worker mirrors: initial published settings, lost replies, failed publication, same-ID cancelled reopening, preserved history, project guards, cleanup and stale-preview rejection, receipt replay after claims and later attempts, and confirmation-only behavior. Claims use the production `core.claim` helper. Terminal transitions are fixture metadata events; no agent or model commands run. The mirrors share a physical filesystem and use temporary records and fake sessions.
