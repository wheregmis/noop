# Account management from the UI

The owner must be able to configure and sign in to AI accounts on the machine selected in Noop. Running every account action on the main machine would change the wrong login for workers.

## Routing and compatibility

- Keep the existing primary bridge for chat, shared records and legacy machine credentials.
- Mint hashed, host-scoped machine credentials on owner-approved join. Existing daemons pre-save a separate random channel credential in their local bootstrap file, then register it using the legacy fleet credential. Registration retries reuse that credential without rotating an existing host binding.
- Poll a separate account-command inbox on every daemon. Only the authenticated target machine may claim a command or return its result. Workers cannot consume the primary inbox or administrative endpoints.
- Owner requests use session-scoped confirmation tickets. Commands expire after two minutes; their bodies are cleared on claim or expiration. Results expire after five minutes. A restarted process must not repeat an uncertain mutation.

## Local account behavior

- Keep account metadata and persistent provider credentials outside shared team data. Preserve existing file configuration until the owner overrides that provider in the UI.
- Add/remove named accounts and optionally use the normal default login. Removing an account leaves its credentials and running processes intact.
- Existing file-defined names keep their configured directories when accounts are added, reordered, removed or reset to file defaults. This includes a legacy named account called `default`; the `default` name selects the ordinary CLI login only when no file account defines that name for the tool.
- Cached authentication, verification and cooldown state belongs to the tool and its credential home. If a file-defined directory or the normal login's environment changes, an older run or login must not update the replacement account. Credential files are not moved or copied.
- On upgrade, old cached state with no credential-home identity is preserved in a private local backup before being invalidated. The backup is never reused as authentication or exposed through account APIs. Accounts return to **Not checked** until a run or sign-in verifies them; setup-token-only logins may need signing in again. Existing provider credential files remain untouched.
- Return only allowlisted status and sign-in challenge fields. One-time authorization codes are relayed through the expiring command channel; they never enter shared files, task prompts or the event feed. Persistent OAuth tokens remain on the target machine.
- Use the existing Claude/Codex login adapters, with UI flows suppressing external login notifications. Explain Hermes native-setup limitations accurately.

## Implementation and checks

1. Add authenticated host identity and the ephemeral command channel, with cross-host/session and replay tests.
2. Add local account operations and safe login state, using fake provider executables for tests.
3. Connect all daemon roles and the machine account UI, including confirmation polling, unknown authentication status, cancellation and partial failure recovery.
4. Verify the complete owner → Worker → two distinct machines path locally, then run server/UI checks and build the app. Do not deploy or authenticate real accounts during verification.
