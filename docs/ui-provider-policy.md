# Task tool policy

Open **Settings → Members** to set the **Default task tool order**. Each member also has task tool choices on desktop and on their phone settings page. Execution enablement and history learning remain separate under **AI tools & onboarding**.

An explicit order is tried among usable tools on the machine that claims the task. It does not reserve work for a tool on a different machine. Uninstalled tools, unavailable accounts and exhausted accounts are skipped without widening the selected pool. If no ordered policy applies, **Automatic** lets the planner recommend the first enabled tool.

These policy semantics require the current Noop code on the machines running tasks. Update worker daemons along with the hub and app; an older daemon can retain its previous file-precedence or planner-order behavior. Saved settings reach updated machines on their next synchronization.

Member choices have distinct meanings:

- An ordered list replaces the team task defaults for that member.
- **Use team default** explicitly inherits the team order, even when a configuration file contains a member override.
- An empty member selection pauses new work for that member, including tasks pinned to a tool.
- **Restore file settings** removes that UI override and reveals the underlying shared or machine-local file setting. It can differ from inheriting the team.

An empty team order leaves inherited automatic tasks without a tool. Explicit member choices and tasks pinned to an enabled tool may still run. To stop all new AI work, disable execution tools under **AI tools & onboarding**. Chat, judges and automatic repair use their own preferences; default task order is not a global AI switch. Existing runs keep their captured configuration.

The UI reports the configured choice, currently enabled tools and policy source. Globally disabled tools remain in saved preferences, so they can become available again when enabled. A filtered empty list is not displayed as a deliberate member pause. Malformed legacy settings fail closed and remain correctable from the UI. Saved UI team/member choices take precedence over machine files; restoring a file setting removes only the corresponding UI leaf.

The versioned settings API accepts `{ "tool_policy_version": 1, "clis": { ... } }`. Within `clis`, `preference` is an ordered provider array or `null` for Automatic; `agents[id]` is an ordered array, `[]` to pause, or `null` to inherit. `reset` contains `"preference"` and/or `"agents.<id>"` to remove UI overrides. A value and reset for the same leaf conflict. Unknown providers, duplicate providers, unsupported keys and arbitrary commands are rejected before persistence. Team preference and reset requests require the version guard, so an older primary rejects them rather than claiming an ignored action succeeded.

If synchronization cannot be confirmed, inspect or retry the same pending choice. A locally saved change can already affect that machine even when the UI receives a synchronization error.
