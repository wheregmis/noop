# Project folders on worker machines

The project editor chooses the machine that owns a folder. The selected machine expands `~`, resolves symlinks, rejects unsafe folders, and detects the GitHub repository and build-tool requirements. A folder on a worker is never inspected through an identically named path on the main machine.

## Confirmed folder checks

`POST /api/machines/{host}/project-folder-check` accepts `{path}`. The existing private machine-request channel delivers the command to that host. A successful owner poll returns the canonical folder, detected metadata, and a `probe_ticket`.

A project create or update may attach that ticket with the same `host` and requested `path`. The hub checks its owner session, target, command kind, completion, and expiry. It adds the verified result outside the owner's form body as `UiJob.project_folder`; the primary receives it separately from the HTTP request body. An account ticket or a form-supplied snapshot cannot authorize a folder.

The primary remains the sole project writer and saves under the scheduler's refresh/write/sync lock. A partial save returns its project ID; the editor retries as an update instead of creating another project. It preserves newer edits typed during confirmation and normalizes a successfully saved folder without replacing a newer path edit.

The local server can inspect its own machine directly. Checking a different machine requires the cloud hub. Older workers report that an update is needed; the account channel retains its older heartbeat format as a fallback.

## Saved settings

Project forms expose `name`, `path`, `host`, `instructions`, a GitHub `repo` override, and additional `requires`. An empty or null repository override uses the detected repository. Detected and custom requirements are stored separately and combined for placement. Existing task snapshots keep their settings until explicitly reconfigured.

Remote project views report unknown local existence rather than “folder not found.” Unchanged remote folders can keep their saved snapshots while the worker is offline, so the owner can edit instructions and custom settings. Changing a folder or host requires a fresh check and is refused while the project has open tasks or plans. Removing the project archives its metadata and never deletes its folder.

The client invalidates a proof when a recheck starts or a save rejects it. Cache age uses the client's receipt time; the worker's reported check time is display metadata. The hub's own clock controls authoritative expiry.

## Verification

`cloud/test/project-machines.ts` runs the production Worker with two isolated bridge processes and temporary data/account homes. It verifies selected-child-only dispatch, proof binding, primary filesystem isolation, partial saves, and offline edits. The fixture shares one physical filesystem and changes same-path manifests between probes; it does not simulate two simultaneous filesystem namespaces. Unit tests cover migration, expiry, malformed proofs, and project placement. Desktop and phone UI tests cover selection, stale checks, clock drift, confirmation, and draft recovery.
