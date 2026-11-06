# Learning on a selected machine

Open a machine’s **Learning history** controls to check its current selections, preview new history and queue an apprentice task on that machine. The main machine uses the same controls from **Settings → AI tools & onboarding**. Execution tools and learning sources are separate choices: enabling an execution tool does not select its conversation history.

**Refresh learning status** checks configuration and saved collections without reading conversation histories. It reports selected sources and blockers. **Preview selected history** reads only those selected sources on that machine. It reports session and owner-turn counts, selected source names and whether the digest was truncated. These responses contain no transcripts, excerpts or source paths. A preview does not queue a task or advance learning progress.

**Run reviewed learning** authorizes that reviewed collection. The private snapshot stays on its source machine, and the resulting task is pinned there. Changes to relevant settings or learning progress require a fresh preview. Active conversations remain excluded by the existing learning readers. Preview counts describe the prepared collection; truncation means only the retained portion fits the digest limit.

Task editing and reopening keep that source machine fixed, with an explanation when it is offline. Another machine needs its own collection from its own selected history; changing a task's host cannot transfer its private digest. See [Task run settings](ui-task-forms.md) for repair of previously moved tasks and older source metadata.

Paused learning, an empty source selection, a paused machine, a missing apprentice, and unavailable apprentice tools or accounts block collection before history is read. A machine without the current learning capability must update and reconnect. An offline machine remains the target; Noop does not substitute another machine’s history.

The app saves the request before sending it. **Check saved run** asks that machine for the exact receipt and cannot collect history or create a task. **Inspect learning task** opens its known task. A confirmed historical run keeps its original task identity even if the task was later removed. **Retry same learning run…** keeps its request identity and reviewed snapshot. Loading the app does not retry it automatically.

If a crash leaves completion uncertain, **Release uncertain collection** can abandon that pending collection after a warning. It preserves any existing task and the machine’s current learning progress. A later preview may include the same history again. A released receipt cannot requeue its task. A lost release reply can be checked with the same saved request.

The machine’s status also exposes a count-only summary of its first unfinished collection. **Review saved collection** brings it back into the app’s saved requests if the local reminder was lost. A different saved request for that machine must be resolved or explicitly dismissed first; it is never overwritten silently.

Scheduled learning, the CLI and UI share a machine-local collection lock. Durable private receipts stage the reviewed snapshot and reserve its task identity before queue and progress changes. Interrupted work with sufficient proof can finish its own progress update; conflicting progress is preserved for explicit review and release. Raw histories and private snapshots are not synchronized. New task instructions refer to the local digest by name rather than publishing the source machine’s absolute home path.

`noop learn --dry` keeps its local digest-path output and writes no task or checkpoint. Full-history CLI collection remains a separate explicit command. The UI preview uses incremental collection.
