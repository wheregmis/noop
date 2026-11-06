# Operational settings

Open **Settings → Team configuration** for shared controls:

- **Execution → Claude task tool permissions** controls new standard Claude task runs. **Allow without prompts** keeps the existing `bypassPermissions` behavior; **Deny unapproved tools** uses `dontAsk`, which denies calls that would otherwise need a Claude permission prompt. Existing runs keep their current policy. Noop task approval may relax Noop's tool blocks but does not override this Claude policy. Custom runner commands, chat, judges and automatic repair use separate permissions. The options follow [Claude's permission modes](https://code.claude.com/docs/en/permissions#permission-modes).
- **Fleet scheduling → GitHub quota reserved for you** leaves headroom on the shared GitHub account. The default is 1,000; zero disables the reserve check.
- **Fleet scheduling → Hub polling interval** accepts whole seconds from 1 to 60, with a default of 3. Each bridge reads the saved value again when scheduling its next cycle after the configuration reaches that machine. No restart is needed. Long polling still returns messages as they arrive; this setting controls housekeeping and fallback polling rather than delaying every message.
- **Background work → Report owner-task failures** controls final-attempt failure reports for new owner-requested or urgent task runs. It is separate from device notification preferences. Existing runs retain the configuration captured when they started.

Resetting Execution removes its UI overrides and restores each machine's underlying file settings. A legacy permission mode configured in a file remains visible and unchanged when saving another setting; the UI offers only the two unattended modes above. Noop does not relay interactive Claude tool-permission prompts to its UI.

When an older hub or machine does not report a setting, that control stays unavailable and the section lists what needs an update. Saving or resetting other settings never sends unsupported keys.

Task tool order and member inheritance are configured under **Settings → Members**; see [Task tool policy](ui-provider-policy.md) for explicit choices, Automatic mode and file resets.

Unrecognized persisted autonomy levels use **Learning** (`onboarding`). An invalid member value cannot inherit a more permissive team level or authorize automatic judging. Owner-requested work and the normal Learning-mode routine exemptions keep their existing approval rules.

Explicit member autonomy choices saved in the UI override member values from configuration files, including machine-local files. Selecting the team default is an explicit inheritance choice; it does not restore a file-defined member value.

Member controls now show the effective level and source, and offer a separate **Restore file setting** action. See [Member autonomy from the UI](ui-autonomy-policy.md) for inheritance, file restoration and unconfirmed-save recovery.

Open a machine and choose **Edit resources and learning history → Resource limits → Disk to monitor** for its disk location. Use an absolute path, a disk root, or `~` for that machine's home. Blank selects its home; resetting the section restores the defaults reported by that machine. The primary never substitutes its own local path for a worker's default. Offline machines apply changes on their next sync. Older machines keep their existing resource controls and show an update message before the disk location can be changed.

Machines also expose learning status, a count-only preview, an exact run and recovery controls. See [Learning on a selected machine](ui-machine-learning.md) for source privacy, saved receipts and unfinished-collection recovery.

The machine page shows the path actually measured. If that filesystem is unavailable or has no usable capacity information, disk telemetry says **Unavailable** and includes an error. Existing runs continue, while new and heavy work wait. Task run forms exclude that machine from their accepting-machine list and allow an explicit wait choice. Automatic cleanup skips unavailable telemetry and only removes eligible caches on the monitored filesystem; a candidate containing another mounted filesystem is left alone.

Bridge cycles do not overlap. Shutdown stops new polling, drains an already-started owner action, and gives its mirrored events one final bounded delivery attempt. A transport failure leaves the local feed intact; this change does not introduce a persistent replay queue for unsent feed events.
