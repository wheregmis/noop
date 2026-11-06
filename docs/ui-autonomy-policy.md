# Member autonomy from the UI

Open **Settings → Members** on desktop, or open a member from phone settings. The autonomy control shows the saved choice, its source, the main machine's effective level and its underlying file setting.

- **Learning**, **Assisted** or **Autonomous** saves an explicit member override.
- **Use team default** saves deliberate inheritance. It overrides a file-defined member level and follows the validated team default under **Team configuration → Autonomy & approvals**.
- **Restore file setting** removes only that member's UI override. Shared and machine-local files can supply a different level from the team default. Each machine uses its own files after synchronization.

Invalid saved levels use Learning and are shown as invalid, rather than as deliberate inheritance. File restoration is unavailable when the underlying file value is invalid; a valid UI selection can repair the member's policy without changing that file. If a legacy member-settings container is malformed, repairing one member preserves every other existing member's effective level as an explicit choice. Unrequested repairs also preserve the team's effective level. Existing approval restrictions must not disappear because another setting was edited.

Confirmed settings remain separate from a pending selection. A lost or contradictory response retains the exact request for **Retry same autonomy setting**. A fresh explicit selection gets a fresh local confirmation identity, including when returning to an earlier value. **Discard unconfirmed selection…** forgets only that local recovery state and ticket; it does not undo settings or work that may already have been applied. Pending tool choices and autonomy choices remain independent.

Older hubs retain their existing level choices. Source information and file reset require updated app, hub and machine code. New policy writes include `autonomy_policy_version: 1`; an older primary rejects this guard instead of silently ignoring a reset. The settings payload uses `autonomy.agents[id] = level | null`, or `autonomy.reset = ["agents.<id>"]`. Unknown levels, unsupported keys, unsafe member IDs, duplicate resets and value/reset conflicts are rejected. The version flag and reset instruction are not persisted.

A malformed generic autonomy override remains intact during unrelated configuration saves/resets. The operational form marks an invalid parent as **Invalid; Learning is effective**, allowing a direct Learning repair or a section reset. Repairs preserve existing member permissions; review those member choices before deliberately restoring inheritance.
