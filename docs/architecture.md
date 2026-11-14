# Noop architecture

## Architecture

```
  app (NSH: web / macOS / Linux / mobile) ── HTTPS ──┐
                                                     ▼
            Owner's Cloudflare Worker + Durable Object (SQLite)
            files + history · chat feed · inbox · status · media
            email OTP login · Web Push
                ▲                                  ▲
                │ outbound HTTPS                   │
       primary (macOS / Linux, always on)  workers (macOS, Linux, Windows)
       routines, triage, judge, agents      claim tasks when online
```

- Machines never accept inbound connections; they call the Worker.
- Shared state is a set of files. Each machine keeps a local mirror (`DATA`) so agents read and write plain Markdown; `src/sync.ts` syncs it with the Worker (`cloud/src/files.ts`).
- Commits are compare-and-swap per path (`base_version`). A 409 means another host won; task claims rely on this, so exactly one host claims a task.
- Every file version is kept in `history` (90 days / 20k rows, latest per path always kept) and can be reverted — this is how self-evolution edits are audited and undone.
- The primary mirrors chat events to the Worker and long-polls its inbox (`GET /api/host/inbox?wait=25`: the Worker holds the request until something arrives) for the owner's messages, settings and MCP writes (`src/cloud.ts`).
- Chat brain (`src/brain.ts`): every owner message that isn't a bare `D-0012 A` goes to a fast model (Claude Haiku via the local `claude` CLI, a pre-spawned warm process) that runs a short agent loop over Noop's tools (`cloud/src/tools.ts`, shared with the MCP server): answer, look up, create/amend/cancel/reprioritise/reassign tasks, answer decisions, remember, edit or delete memories. The owner's model login stays on the primary; only the message and the reply cross the Worker. Latency per message: `~/.noop/brain.jsonl`.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | CLI entry and the daemon loop (`pull → routines → replies → judge → run tasks → push`) |
| `src/core.ts` | config, local paths (`HOME_DIR`), tasks, claims, journal, `locked()` |
| `src/sync.ts` | file sync with the Worker (CAS commit, pull, merge of append-only files) |
| `src/runner.ts` | prompt building and running Claude Code / Codex |
| `src/decisions.ts`, `src/autonomy.ts` | the judge, proposals, graduated autonomy |
| `src/gates.ts`, `src/github.ts` | hard gates, GitHub quota etiquette |
| `src/accounts.ts` | multiple AI accounts, quota cooldown, remote login links |
| `src/resources.ts` | resource governor and disk cleanup |
| `src/notify.ts`, `src/server.ts`, `src/cloud.ts` | events, local API, Worker bridge and deploy |
| `src/medic.ts` | AI self-repair for install/update/daemon failures |
| `src/sessions.ts` | learning the owner from local Claude/Codex history (redacted, never uploaded raw) |
| `src/setup.ts` | init, join, install as a service, self-update with rollback |
| `cloud/` | the Worker: `index.ts` (routes, auth, feed), `files.ts`, `smtp.ts`, `push.ts` |
| `app/` | the NSH client; machines download the web package from the latest release (`src/webclient.ts`), and `app/build-web.sh` builds it locally |
| `templates/` | default config, agents, policies and memory seeded into a new install |

Machine-local files live in `HOME_DIR` (`$NOOP_HOME`, else `~/.noop`, falling back to an existing `~/.agent-hub`): `noop.toml` (Worker URL + machine token), `sync.json`, `data/` (the mirror), accounts, logs.

## Worker API

Auth: the machine token (hosts) or an owner session from email login (clients). `?token=` is accepted only for WebSocket and media URLs.

| Route | Who | Purpose |
|---|---|---|
| `POST /api/auth/start`, `/verify`, `/logout` | public / session | email one-time code login |
| `GET /api/feed`, `WS /api/stream`, `POST /api/messages` | session | chat timeline |
| `GET /api/status`, `GET/PUT /api/settings` | session | dashboard, UI-adjustable settings |
| `POST /api/media`, `GET /media/<id>` | both | screenshots and recordings |
| `/api/push/*` | session | Web Push subscribe / test / answer from a notification |
| `/api/files/changes`, `/commit` | machine | file sync |
| `/api/files/history`, `/revert` | session | audit and undo |
| `POST /api/events`, `PUT /api/host/state`, `GET /api/host/inbox` | machine | primary bridge |
| `POST /api/host/join` | session | a new machine gets its token |

## Agents and safety

- The lead agent owns every task and decides how much process it needs; other roles are spawned as parallel sub-agents.
- Hard gates (`src/gates.ts`) are enforced through Claude Code's `--disallowedTools`, not model judgment: merge, approve, release, publish, force-push, pushing to main, repo/secret admin, GitHub REST loops. Running one requires an owner decision, which unlocks the approvable gates (merge, approve, release, publish, push) for that task only; repo deletion, secrets, `rm -rf /` or `~` and `[gates] extra` stay blocked.
- Anything posted outside Noop carries the agent's signature.
- Failures are retried; tooling problems go to the medic; the owner is told only about failures of work they asked for, in one plain sentence.
