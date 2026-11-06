import { enabledProviders, providerHealth } from "./providers";
import { PROVIDER_IDS, providerOrders, toolSettingsPatch } from "../cloud/src/providers";
// Hub server: runs inside the primary daemon. Chat API (for the NSH client), built-in web chat (PWA), media.
// Reach it from phone / Mac over Tailscale (`tailscale serve --bg 8787` gives HTTPS on your tailnet). No cloud.
//
// API (Bearer token = [server].token in config.local.toml):
//   POST /api/auth/start {email} · POST /api/auth/verify {email, code} → {session}   no Worker only; `noop login` shows the code
//   GET  /api/feed?since=<iso>            → { events: Event[] }        chat timeline (newest last)
//   GET  /api/stream                      → WebSocket, pushes Event JSON as it happens
//   POST /api/messages {text, reply_to?, attachments?}  → owner message: answers D-/P-/L- ids, otherwise becomes a task for `lead`
//   GET|PUT|DELETE /api/members/<id> · POST /api/members {title, name?, about?, instructions}   (local and remote)
//   GET|PUT|DELETE /api/routines/<name> · POST /api/routines {name, every, agent, prompt, ...}   (local and remote)
//   GET|POST /api/plans · GET|PUT|DELETE /api/plans/<id> · POST /api/plans/<id>/{approve,pause,resume,retry,skip,cancel,continue}   (local and remote)
//   GET|PUT|DELETE /api/projects/<id> · POST /api/projects {name, path, instructions?}   (local and remote)
//   POST /api/uploads (multipart file)    → { url }   (the owner's images for a message: image/*, ≤ 10 MB)
//   GET  /api/status                      → queue, decisions, hosts, accounts
//   POST /api/fleet/update               → every machine updates to the latest code; the primary redeploys the cloud
//   POST /api/media (multipart file)      → { url }   (workers upload screenshots/recordings here)
//   GET  /media/<file>                    → attachment
//   POST|PUT /api/documents {path, base?, content?} → primary-confirmed knowledge read/edit with conflict checks
//   GET  /api/files/list?prefix=  · GET /api/files/read?path=   → read-only rules & memory (same shape as the Worker)
import { lstatSync, renameSync, appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { accountsInfo } from "./accounts";
import { notificationTimeZone } from "../app/notify";
import { accountRequest } from "./account-ui";
import { machineAccountPath, machineProjectPath, machineTaskPath, validMachineHost, validRunId, validTaskControl } from "../cloud/src/machine-requests";
import { addRole, listRoles, readRole } from "./setup";
import { RequestError, createMember, deleteMember, parseProfile, readMember, updateMember } from "./members";
import { createRoutine, deleteRoutine, readRoutine, updateRoutine } from "./routines";
import { createProject, deleteProject, listProjects, projectFolderRequest, readProject, updateProject, type ProjectFolderCheck } from "./projects";
import { type Plan, approvePlan, archivePlan, cancelPlan, continuePlan, createPlan, editSteps, listPlans, openPlans, pausePlan, readPlan, resumePlan, retryStep, skipStep, summary } from "./plans";
import { _pull, _commitPush, journal, locked, type Cfg, DATA, P, allowedClis, toolPolicy, autonomyPolicy, hostName, isPrimary, list, loadConfig, newTask, onlineHosts, readDoc, UPDATE_REQUEST } from "./core";
import { ownerAttachments, sniffImage, uploadId, uploadProblem } from "../cloud/src/uploads";
import { readable, validPath } from "../cloud/src/files";
import { parseTaskBody, taskHistory, taskInfo, TASK_ID } from "../cloud/src/tools";
import { learningTaskBinding, learningTaskHostError } from "../cloud/src/learning";
import { recordPath } from "../cloud/src/ui-requests";
import { CONFIGURATION_FIELDS, MACHINE_CONFIGURATION_FIELDS, MACHINE_LEARNING_FIELDS, RESOURCE_FIELDS, configAt, configurationPatch, configurationValues, autonomySettingsPatch } from "../cloud/src/configuration";
import { validArchiveListRequest, validArchivePreviewRequest, validArchiveRestoreRequest, type ArchiveRestoreResult } from "../cloud/src/archives";
import { ArchiveSaveError, listArchives, previewArchive, restoreArchive, type ArchivePendingRestore } from "./archives";
import { validTaskCreateRequest, validTaskReopenPreviewRequest, validTaskReopenRequest, type TaskFormResult } from "../cloud/src/task-forms";
import { createTask, previewTaskReopen, reopenTask as reopenTaskForm, TaskFormSaveError, type TaskFormPending } from "./task-forms";
import { DOCUMENT_MAX_BYTES, documentBody, editableDocument } from "../cloud/src/documents";
import { knownHosts } from "./core";
import { localStore } from "./brain";
import { ensureWebClient } from "./webclient";
import { ActionSyncError } from "../cloud/src/action-errors";
import { receiveMessage, receiveRequest } from "./message-receipts";
import { pendingStopsView, pendingStopsError, hasPendingStops, readPendingStops, readStopIntent, stopRunId, validStopReviewRequest, validStopResolveRequest, type StopOwner } from "../cloud/src/stop-intents";
import { stopTaskPath, StopStorageError } from "./stop-intents";
import { inspectStopReview, applyStopResolution, readStopReviews, StopReviewSaveError, type StopDrainer, type StopDrainResult } from "./task-stops";
import { learningBlockReason } from "./sessions";
import { learningRequest, legacyLearningRequest } from "./learning";
import { machineLearningPath } from "../cloud/src/learning";
import { level } from "./autonomy";

export type Event = {
  id: string; ts: string; from: string; kind: "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system";
  text: string; ref?: string; options?: string[]; attachments?: string[];
  /** Said inside a task's own conversation: shown on the task page, not in the main channel. */
  thread?: boolean;
};

export const MEDIA = join(DATA, "..", "media");
const NSH_WEB = join(import.meta.dir, "..", "app", "dist", "web", "noop"); // built NSH web client
const FEED_DIR = join(DATA, "..", "feed"); // primary-local (next to the data repo), append-only JSONL per day
const sockets = new Set<ServerWebSocket<unknown>>();
type Inbound = { id: string; answer: string; source: string };
const inbound: Inbound[] = [];
/** A chat message goes to the chat brain (src/brain.ts), which replies and acts through noop's tools. `reply`: the task
 * whose message the owner replied to ("T-0125"), or whose page they wrote on; `answered`: the decision the owner answered
 * moments ago (the message may change that answer); `sentAt`: when the owner sent it (for latency). */
type OwnerTask = (text: string, o: { reply?: string; answered?: string; sentAt?: string; thread?: boolean }) => Promise<void>;
let ownerTask: OwnerTask | null = null;

const today = () => new Date().toLocaleDateString("sv-SE");

let mirror: ((e: Event) => void) | null = null; // cloud bridge: copies primary events to the Cloudflare hub
export const setMirror = (fn: (e: Event) => void) => { mirror = fn; };

export function appendEvent(e: Omit<Event, "id" | "ts"> & Partial<Pick<Event, "id" | "ts">>, opts: { mirror?: boolean } = {}): Event {
  mkdirSync(FEED_DIR, { recursive: true });
  const ev: Event = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
  if (opts.mirror !== false) mirror?.(ev);
  appendFileSync(join(FEED_DIR, `${today()}.jsonl`), JSON.stringify(ev) + "\n");
  for (const ws of sockets) ws.send(JSON.stringify(ev));
  return ev;
}

export function feed(since?: string, limit = 300): Event[] {
  if (!existsSync(FEED_DIR)) return [];
  const files = readdirSync(FEED_DIR).sort().slice(-7);
  const evs = files.flatMap((f) => readFileSync(join(FEED_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Event));
  return evs.filter((e) => !since || e.ts > since).slice(-limit);
}

/** The channel's last few hours as plain lines, oldest first: what a new chat message ("no", "note this detail down") refers to.
 * The message being handled (the owner's last event, `text`) is left out. */
export function recentChat(text = "", opts: { limit?: number; hours?: number } = {}): string[] {
  const since = new Date(Date.now() - (opts.hours ?? 6) * 3600_000).toISOString();
  let evs = feed(since, 200).filter((e) => e.kind !== "login" && e.text?.trim());
  const last = evs.at(-1);
  if (last?.from === "owner" && last.text.trim() === text.trim()) evs = evs.slice(0, -1);
  return evs.slice(-(opts.limit ?? 12)).map((e) => {
    const who = e.from === "owner" ? "owner" : e.from;
    const t = e.text.length > 700 ? `${e.text.slice(0, 700)}…` : e.text;
    return `[${e.ts.slice(11, 16)}] ${who}${e.ref ? ` (${e.ref})` : ""}: ${t.replace(/\n+/g, " ⏎ ")}`;
  });
}


/** Replies the daemon should process (same shape as Slack/Discord replies). */
export const drainInbound = () => inbound.splice(0);
/** A decision answer from the chat brain: an open card is answered; one answered minutes ago is amended. */
export function answerFromChat(id: string, answer: string, amend: boolean) {
  inbound.push({ id, answer, source: amend ? "chat-amend" : "chat" });
  if (!amend) lastAnswer = { id, at: Date.now() };
}

/** Store a local file as media; returns a server-relative URL. */
export function storeMedia(path: string): string {
  mkdirSync(MEDIA, { recursive: true });
  const name = `${Date.now()}-${basename(path).replace(/[^\w.\-]/g, "_")}`;
  writeFileSync(join(MEDIA, name), readFileSync(path));
  return `/media/${name}`;
}

/** Workers (not primary) upload media to the primary server. */
export async function uploadMedia(path: string, cfg: Cfg): Promise<string | null> {
  const url = cfg.server?.url;
  if (!url) return null;
  const fd = new FormData();
  fd.append("file", Bun.file(path), basename(path));
  const r = await fetch(`${url.replace(/\/$/, "")}/api/media`, { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` } }).catch(() => null);
  return r?.ok ? ((await r.json()) as any).url : null;
}

/** Workers forward events to the primary so the chat timeline is complete. */
export async function forwardEvent(e: Omit<Event, "id" | "ts">, cfg: Cfg) {
  const url = cfg.server?.url;
  if (!url) return false;
  const r = await fetch(`${url.replace(/\/$/, "")}/api/events`, {
    method: "POST", body: JSON.stringify(e), headers: { Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" },
  }).catch(() => null);
  return !!r?.ok;
}

/** The last journal lines, for each task's timeline. */
function journalLines(): string[] {
  const dir = P("journal");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().slice(-2);
  return files.flatMap((f) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => `${f.slice(0, 10)} ${l.slice(2)}`));
}

/** Journal lines' leading marks → a step kind the app draws with its own icon. */
const STEP_KINDS: [string[], string][] = [
  [["💬"], "chat"], [["▶"], "start"], [["✅", "✔"], "done"], [["❌", "💥"], "fail"], [["⏸", "📨"], "decision"],
  [["↻", "♻️", "🔁", "↩️"], "retry"], [["↳"], "followup"], [["🧩"], "delegated"], [["⚖️", "👤"], "judge"], [["✏️"], "edit"],
];

/** What the app shows for a task: its request, state, timeline and results. */
export function taskView(path: string, state: string, log: string[]) {
  const { meta: m, body } = readDoc(path);
  const { request, runs } = parseTaskBody(m.title, body);
  const steps = log.filter((l) => l.includes(` ${m.id} `) || l.endsWith(` ${m.id}`)).slice(-12)
    .map((l) => {
      const x = l.match(/^(\S+) (\d\d:\d\d) `([^`]+)` (.*)$/);
      if (!x) return { text: l };
      const raw = x[4].trim();
      const lead = raw.match(/^[^\p{L}\p{N}\[(`]+/u)?.[0]?.trim() ?? "";
      const kind = STEP_KINDS.find(([marks]) => marks.some((m) => lead.startsWith(m)))?.[1] ?? "note";
      const text = raw.slice(lead.length).replace(new RegExp(`^${m.id}\\b[:：]?\\s*`), "").trim();
      return { day: x[1], time: x[2], host: x[3], kind, text };
    });
  if (state === "waiting" && m.wake_at) state = "parked"; // waiting on something slow (CI, a release), not on sub-tasks
  // queued, but no online machine can run it (a task that needs Windows while none is up): it waits for one, not for a turn
  const binding = learningTaskBinding(m, body), placementError = learningTaskHostError(m, body, m.host || "any");
  const requirements = [m.requires, binding.learning_host ? `host:${binding.learning_host}` : m.host && m.host !== "any" ? `host:${m.host}` : ""].filter(Boolean).join(",");
  const needs = state === "inbox" ? placementError || (m.parked ? m.parked_need || requirements || "accepting-tasks" : undefined) : undefined;
  if (needs) state = "nohost";
  return { id: m.id, title: m.title, agent: m.agent, host: m.claimed_by ?? m.run_host, run_id: m.run_id, ...learningTaskBinding(m, body), stops: pendingStopsView(m.pending_stops), stop_reviews: readPendingStops(m.pending_stops)?.reviews, stops_error: pendingStopsError(m.pending_stops), stop_owner: readStopIntent(m)?.owner, state, needs, prefer: m.prefer ?? "", weight: m.weight ?? "normal", project: m.project ?? "", repo: m.repo ?? "", requires: m.requires ?? "", target_host: m.host ?? "any", configured_cli: m.cli ?? "auto", priority: m.priority ?? "normal", waiting_on: m.waiting_on, wake_at: m.wake_at, started: m.started, created: m.created, cli: m.cli_used, model: m.model,
    finished: m.finished, updated: m.finished ?? m.started ?? m.created, attempt: m.attempt, decision: m.decision, request, runs, steps };
}

type TaskView = ReturnType<typeof taskView>;

const taskStore = () => localStore({ acts: {}, status: () => ({}), feed: () => [] });

/** Per host: what it runs now, what it finished lately, and (for this machine) its AI accounts. */
function hostViews(active: TaskView[], finished: TaskView[], offline = false) {
  let cfg: Cfg | null = null;
  try { cfg = loadConfig(); } catch {}
  const me = cfg ? hostName(cfg) : "";
  const ran = (t: TaskView, h: string) => t.host === h || t.runs.some((r) => r.host === h);
  const online = onlineHosts(cfg ?? {});
  return (offline ? knownHosts().filter((h) => !online.some((o) => o.host === h.host)) : online).map((h) => ({
    ...h, online: !offline, enabled: cfg?.machines?.[h.host]?.enabled ?? h.enabled ?? true,
    os: h.caps.find((c) => c.startsWith("os:"))?.slice(3),
    arch: h.caps.find((c) => c.startsWith("arch:"))?.slice(5),
    clis: h.caps.filter((c) => c.startsWith("cli:")).map((c) => c.slice(4)),
    accounts: cfg && h.host === me ? (() => { try { return accountsInfo(cfg!); } catch { return undefined; } })() : undefined,
    running: active.filter((t) => t.host === h.host).map((t) => ({ id: t.id, title: t.title, agent: t.agent, run_id: t.run_id, started: t.started, learning_host: t.learning_host, learning_host_error: t.learning_host_error, activity: h.activity?.[t.id] })),
    recent: finished.filter((t) => ran(t, h.host)).slice(0, 8).map((t) => ({ id: t.id, title: t.title, state: t.state, learning_host: t.learning_host, learning_host_error: t.learning_host_error, finished: t.finished ?? t.updated })),
  }));
}

export function status() {
  const log = journalLines();
  const count = (f: string) => list(P("tasks", f), /^T-.*\.md$/).length;
  // a running task carries its agent's latest sign of life (from the heartbeat of the machine running it)
  const beats = (() => { try { return onlineHosts(loadConfig()); } catch { return []; } })();
  const active = list(P("tasks", "active"), /^T-.*\.md$/).map((p) => taskView(p, "active", log))
    .map((t) => ({ ...t, activity: beats.find((h) => h.host === t.host)?.activity?.[t.id] }));
  const others = ["done", "failed", "blocked", "waiting", "inbox"].flatMap((f) => list(P("tasks", f), /^T-.*\.md$/).map((p) => taskView(p, f, log)))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return {
    tasks: Object.fromEntries(["proposed", "inbox", "active", "waiting", "blocked", "failed", "done"].map((f) => [f, count(f)])),
    active,
    // every open task (queued, waiting on sub-tasks or something slow, blocked) and the newest finished ones; a task copied in two folders mid-sync shows once, as running
    recent: (() => {
      const rest = others.filter((t) => !active.some((a) => a.id === t.id));
      const open = rest.filter((t) => ["inbox", "nohost", "waiting", "parked", "blocked"].includes(t.state));
      return [...open, ...rest.filter((t) => !open.includes(t)).slice(0, 12)].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    })(),
    decisions: list(P("decisions", "open")).map((p) => { const m = readDoc(p).meta; return { id: m.id, kind: m.kind ?? "decision", question: m.question, held: !!m.held }; }),
    hosts: hostViews(active, others.filter((t) => t.state === "done" || t.state === "failed")),
    offline_hosts: hostViews(active, others.filter((t) => t.state === "done" || t.state === "failed"), true),
    plans: (() => { try { return openPlans().map(summary); } catch { return []; } })(),
    /** The owner's latest "update every machine" (each host reports its progress on it in `hosts[].update`). */
    update: (() => { try { return { at: String(JSON.parse(readFileSync(UPDATE_REQUEST(), "utf8")).at ?? "") }; } catch { return undefined; } })(),
  };
}

// ---------------------------------------------------------------- settings (UI-adjustable, shared via data repo)
const SETTABLE = ["clis", "tool_policy_version", "autonomy", "autonomy_policy_version", "routines", "host", "idle", "judge", "resources", "notify_prefs", "commands", "media_days"]; // whitelisted top-level keys
const settingsObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const rosterAutonomy = (cfg: Cfg) => Object.fromEntries(readdirSync(P("agents"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.name))
  .map((entry) => [entry.name, level(cfg, entry.name)]));

/** What an agent is for, from its profile's first line: "# Name (Title) — what it does" (the parenthetical is optional). */
/** Titles and one-liners for the built-in roles, used where a profile's first line gives none. */
const ROLE: Record<string, { title: string; about: string }> = {
  apprentice: { title: "Apprentice", about: "Learns how you work, judge and what you prefer from your own AI sessions" },
  architect: { title: "Team Architect", about: "Keeps tuning this team's rules, prompts, memory and roles to fit your real work" },
  "chief-of-staff": { title: "Chief of Staff", about: "When the team is idle, lists next steps you can green-light" },
  dispatcher: { title: "Dispatcher", about: "Scans incoming signals and splits them into tasks for the right members" },
  lead: { title: "Lead", about: "Default owner of tasks; decides how much process a job needs" },
  "ops-watcher": { title: "Ops Watcher", about: "Watches production alerts and CI health" },
  "oss-triage": { title: "OSS Triage", about: "Handles issues on your open-source projects" },
  "release-manager": { title: "Release Manager", about: "Versions, CHANGELOG, Homebrew and package releases" },
  reporter: { title: "Reporter", about: "Writes daily and weekly reports and OKR progress from logs, commits and GitHub activity" },
  reviewer: { title: "PR Reviewer", about: "Carefully reviews and actually verifies PRs on your projects, especially other people's" },
  maintainer: { title: "Maintainer", about: "Develops and maintains the projects you connect" },
};

export function agentRole(agent: string): { title?: string; about?: string } {
  const p = P("agents", agent, "profile.md");
  const f = existsSync(p) ? parseProfile(readFileSync(p, "utf8")) : null;
  return { title: f?.title ?? ROLE[agent]?.title, about: f?.about ?? ROLE[agent]?.about };
}

/** What each built-in routine does, for the settings page (a routine's own `desc` in config.toml wins). */
const ROUTINE_DESC: Record<string, string> = {
  "triage-inbound": "Scans GitHub notifications, PRs waiting on you, issues assigned to you and CI failures, and splits them into tasks for the right members",
  "uptime-watch": "Checks uptime alerts and handles them by the escalation rules",
  "pr-review": "Reviews PRs in your connected projects that haven't been reviewed yet, up to 3 per run",
  "own-prs-ci": "Keeps your own PRs mergeable: resolves conflicts, fixes CI, addresses obvious review comments",
  "nightly-health": "Runs each project's checks and tests on the latest main and opens a task on any regression",
  "macos-check": "Builds and tests the Core repos on macOS and reports platform-specific failures",
  "daily-report": "Writes the day's report from the journal, commits and GitHub activity",
  "weekly-report": "Drafts this week's report against the OKRs, asking you before it's submitted",
  "focus-check": "Checks your focus areas: which continue, which are done, which should be added",
  "learn-ceo": "Each machine learns how you work and judge from its local Claude / Codex sessions",
  "learn-owner": "Each machine learns how you work and judge from its local Claude / Codex sessions",
  evolve: "Reviews the last 7 days and adjusts the team's rules, prompts and memory",
  "evolve-deep": "Reviews the last 30 days, rewrites each member's profile and proposes new roles",
  "release-wednesday": "Wednesday NSH release: prepares everything and asks you once before publishing",
};
const routineDesc = (r: any) =>
  String(r.desc ?? ROUTINE_DESC[r.name] ?? String(r.prompt ?? "").split(/(?<=[.。])\s/)[0].slice(0, 120)).trim() || undefined;

export function settingsView() {
  const cfg = loadConfig();
  const agents = readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  return {
    current: existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {},
    effective: {
      primary_host: hostName(cfg),
      tool_policy: { version: 1 as const, team: toolPolicy(cfg) },
      autonomy_policy_version: 1 as const,
      agents: agents.map((a) => {
        const policy = autonomyPolicy(cfg, a);
        return { id: a, ...agentRole(a), clis: allowedClis({ agent: a }, cfg), tool_policy: toolPolicy(cfg, a), paused: Array.isArray(cfg.clis?.agents?.[a]) && cfg.clis.agents[a].length === 0, autonomy: policy.effective, autonomy_inherited: policy.configured === null && !policy.invalid, autonomy_policy: policy };
      }),
      enabled_clis: enabledProviders(cfg),
      autonomy: level(cfg),
      projects: listProjects(),
      routines: (cfg.routine ?? []).map((r: any) => ({ name: r.name, desc: routineDesc(r), every: r.every, agent: r.agent, enabled: r.enabled !== false, readonly: r.readonly === true, project: r.project, kind: r.kind })),
      max_parallel: cfg.host?.max_parallel ?? null,
      media_days: mediaDays(cfg),
    },
    options: { clis: providerOrders(enabledProviders(cfg)), autonomy: ["onboarding", "assisted", "autonomous"] },
  };
}

export async function saveSettings(input: unknown, io = { pull: _pull, push: _commitPush }) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !SETTABLE.includes(key))) throw new RequestError(400, "Choose supported settings to change");
  let patch = input as Record<string, unknown>;
  const versionedAutonomy = patch.autonomy_policy_version === 1;
  if (Object.hasOwn(patch, "autonomy_policy_version")) {
    if (patch.autonomy_policy_version !== 1 || !Object.hasOwn(patch, "autonomy")) throw new RequestError(400, "Choose supported member autonomy settings");
    const { autonomy_policy_version: _version, ...values } = patch; patch = values;
  }
  const versionedTools = patch.tool_policy_version === 1;
  if (Object.hasOwn(patch, "tool_policy_version")) {
    if (patch.tool_policy_version !== 1 || !Object.hasOwn(patch, "clis")) throw new RequestError(400, "Choose supported task tool settings");
    const { tool_policy_version: _version, ...values } = patch; patch = values;
  }
  let toolReset: string[] = [];
  if (Object.hasOwn(patch, "clis")) {
    const checked = toolSettingsPatch(patch.clis);
    if ("error" in checked) throw new RequestError(400, checked.error);
    if (!versionedTools && (Object.hasOwn(patch.clis as object, "preference") || Object.hasOwn(patch.clis as object, "reset")))
      throw new RequestError(400, "Update the app to change or restore the default task tool policy");
    patch = { ...patch, clis: checked.values }; toolReset = checked.reset;
  }
  if ("notify_prefs" in patch) {
    const prefs = (patch as Record<string, unknown>).notify_prefs;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs) || Object.keys(prefs).some((key) => !["kinds", "quiet_hours", "tz"].includes(key))) throw new RequestError(400, "Choose valid notification preferences");
    const { kinds, quiet_hours: quiet } = prefs as Record<string, unknown>;
    if (kinds !== undefined && (!kinds || typeof kinds !== "object" || Array.isArray(kinds) || Object.entries(kinds).some(([key, value]) => !["decision", "menu", "proposals", "login", "result"].includes(key) || typeof value !== "boolean")))
      throw new RequestError(400, "Choose valid notification kinds");
    const time = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
    if (quiet !== undefined && quiet !== null && !(typeof quiet === "string" ? new RegExp(`^${time}\\s*-\\s*${time}$`).test(quiet)
      : typeof quiet === "object" && !Array.isArray(quiet) && Object.keys(quiet).length === 2 && ["start", "end"].every((key) => typeof (quiet as Record<string, unknown>)[key] === "string" && new RegExp(`^${time}$`).test((quiet as Record<string, string>)[key]))))
      throw new RequestError(400, "Quiet hours use valid start and end times, for example 22:00-08:00");
    if (Object.hasOwn(prefs, "tz")) {
      const tz = notificationTimeZone((prefs as Record<string, unknown>).tz);
      if (!tz) throw new RequestError(400, "Enter a valid IANA time zone, for example America/Toronto or UTC");
      patch = { ...patch, notify_prefs: { ...prefs, tz } };
    }
  }
  let autonomyReset: string[] = [];
  if (Object.hasOwn(patch, "autonomy")) {
    const checked = autonomySettingsPatch(patch.autonomy);
    if ("error" in checked) throw new RequestError(400, checked.error);
    if (!versionedAutonomy && Object.hasOwn(patch.autonomy as object, "reset")) throw new RequestError(400, "Update the app to restore member autonomy file settings");
    patch = { ...patch, autonomy: checked.values }; autonomyReset = checked.reset;
  }
  const deep = (a: any, b: any): any => {
    const o = a && typeof a === "object" && !Array.isArray(a) ? { ...a } : {};
    for (const [k, v] of Object.entries(b ?? {})) {
      if (["__proto__", "constructor", "prototype"].includes(k)) throw new RequestError(400, "Invalid settings key");
      o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v;
    }
    return o;
  };
  return locked(async () => {
    let refreshed = false;
    try { refreshed = await io.pull(); } catch {}
    if (!refreshed) throw new RequestError(503, "Could not load the latest settings. Reconnect the main machine and try again.");
    const f = P("settings.json"), cur = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
    const object = settingsObject;
    const malformedSavedParent = Object.hasOwn(cur, "autonomy") && !object(cur.autonomy);
    const malformedSavedAutonomy = malformedSavedParent || object(cur.autonomy) && Object.hasOwn(cur.autonomy, "agents") && !object(cur.autonomy.agents);
    if (autonomyReset.length && malformedSavedAutonomy)
      throw new RequestError(409, "Choose a valid member autonomy level or the team default before restoring file settings; the saved member settings are malformed.");
    const autonomy = (patch as Record<string, any>).autonomy;
    if (object(autonomy)) {
      const before = loadConfig(), group = before.autonomy;
      if (malformedSavedAutonomy || group !== undefined && (!object(group) || Object.hasOwn(group, "agents") && !object(group.agents))) {
        const preserved = rosterAutonomy(before);
        const team = malformedSavedParent || !object(group) ? { level: level(before) } : {};
        patch = { ...patch, autonomy: { ...team, ...autonomy, agents: { ...preserved, ...autonomy.agents } } };
      }
    }
    const next = deep(cur, patch), temporary = `${f}.${crypto.randomUUID()}.tmp`;
    for (const path of toolReset) {
      if (path === "preference") delete next.clis?.preference;
      else if (next.clis?.agents && typeof next.clis.agents === "object" && !Array.isArray(next.clis.agents)) delete next.clis.agents[path.slice(7)];
    }
    for (const path of autonomyReset) if (object(next.autonomy?.agents)) delete next.autonomy.agents[path.slice(7)];
    try { writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx" }); renameSync(temporary, f); }
    finally { rmSync(temporary, { force: true }); }
    journal(hostName(loadConfig()), "⚙️ owner changed team preferences");
    let synced = false;
    try { synced = await io.push("[settings] team preferences"); } catch {}
    if (!synced) throw new RequestError(503, "Settings were saved locally but could not sync. Reload before trying again.");
    return settingsView();
  });
}

export async function settingsRoute(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json(settingsView());
  if (req.method !== "PUT") return Response.json({ error: "method not allowed" }, { status: 405 });
  try { return Response.json(await saveSettings(await req.json().catch(() => null))); }
  catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

type RecordSync = { pull: () => Promise<boolean>; push: (summary: string) => Promise<boolean> };
const recordSync: RecordSync = { pull: _pull, push: _commitPush };
async function persistRecord<T>(change: () => T, describe: (value: T) => string, io: RecordSync) {
  return locked(async () => {
    if (!await io.pull()) throw new RequestError(503, "Could not load the latest records. Reconnect the main machine and try again.");
    const value = change(), summary = describe(value);
    let synced = false;
    try {
      journal(hostName(loadConfig()), `⚙️ owner changed ${summary}`);
      synced = await io.push(`[settings] ${summary}`);
    } catch (error) { console.error(`record sync: ${error}`); }
    return { value, synced };
  });
}
const recordResponse = (data: Record<string, unknown>, synced: boolean) => Response.json(synced ? data : {
  ...data, saved_locally: true, error: "Saved on the main machine, but sync could not be confirmed. Check the saved record before starting another one.",
}, { status: synced ? 200 : 503 });

const archiveResponse = (result: ArchiveRestoreResult | ArchivePendingRestore, synced: boolean, error?: string, uncertain = false) => Response.json({ ...result, ok: synced,
  ...(!synced ? { saved_locally: true, ...(uncertain ? { uncertain: true } : {}), error: error ?? "The restoration was saved on the main machine, but sync was not confirmed. Check this same saved restoration before starting another one." } : {}),
}, { status: synced ? 200 : 503 });

/** Archive reads and restoration use the primary's refreshed records, never a worker's mirror. */
export async function archiveRequest(req: Request, action?: string, io: RecordSync = recordSync, projectFolder?: ProjectFolderCheck): Promise<Response> {
  if (!(action ? req.method === "POST" : ["GET", "POST"].includes(req.method))) return Response.json({ error: "method not allowed" }, { status: 405 });
  if (new URL(req.url).search) return Response.json({ error: "Send archive filters in the POST form" }, { status: 400 });
  let input: unknown = {};
  if (req.method === "POST") {
    const text = await req.text();
    if (text.length > 65_536) return Response.json({ error: "Archive form is too large" }, { status: 413 });
    try { input = JSON.parse(text); } catch { return Response.json({ error: "Invalid archive form" }, { status: 400 }); }
  }
  if (!(action === "restore" ? validArchiveRestoreRequest(input) : action === "preview" ? validArchivePreviewRequest(input) : !action && validArchiveListRequest(input)))
    return Response.json({ error: "Choose supported archive filters, a preview or a saved restoration" }, { status: 400 });
  const checked = { ...io, pull: async () => { try { return await io.pull(); } catch { return false; } } };
  const primary = () => {
    if (!isPrimary(loadConfig())) throw new RequestError(409, "Open the main machine to browse or restore the team's archives.");
  };
  try {
    if (action === "restore" && validArchiveRestoreRequest(input)) {
      const result = await persistRecord(() => { primary(); return restoreArchive(input, projectFolder); }, (value) => `restored ${value.kind} ${value.id} (${value.request_id})`, checked);
      return archiveResponse(result.value, result.synced);
    }
    return await locked(async () => {
      if (!await checked.pull()) throw new RequestError(503, "Could not refresh the archives. Nothing was changed; reconnect the main machine and retry.");
      primary();
      if (action === "preview" && validArchivePreviewRequest(input)) return Response.json(previewArchive(input));
      if (validArchiveListRequest(input)) return Response.json(listArchives(input));
      throw new RequestError(400, "Choose supported archive filters");
    });
  } catch (error) {
    if (error instanceof ArchiveSaveError) return archiveResponse(error.result, false, error.message, true);
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

const taskFormResponse = (result: TaskFormResult | TaskFormPending, synced: boolean, error?: string, uncertain = false) => Response.json({ ...result, ok: synced,
  ...(!synced ? { saved_locally: true, ...(uncertain ? { uncertain: true } : {}), error: error ?? "The task change was saved on the main machine, but sync was not confirmed. Check this same saved request before starting another one." } : {}),
}, { status: synced ? 200 : 503 });

/** A form's durable request identity is retained even after the task starts, finishes or disappears. */
export async function taskFormRequest(req: Request, action: "create" | "reopen-preview" | "reopen", io: RecordSync = recordSync): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (new URL(req.url).search) return Response.json({ error: "Send task settings in the POST form" }, { status: 400 });
  const text = await req.text();
  if (text.length > 65_536) return Response.json({ error: "Task form is too large" }, { status: 413 });
  let input: unknown; try { input = JSON.parse(text); } catch { return Response.json({ error: "Invalid task form" }, { status: 400 }); }
  if (!(action === "create" ? validTaskCreateRequest(input) : action === "reopen-preview" ? validTaskReopenPreviewRequest(input) : validTaskReopenRequest(input)))
    return Response.json({ error: "Choose supported task settings and a current reopening preview" }, { status: 400 });
  const checked = { ...io, pull: async () => { try { return await io.pull(); } catch { return false; } } };
  const primary = () => { if (!isPrimary(loadConfig())) throw new RequestError(409, "Open the main machine to create or reopen a task."); };
  try {
    if (action === "reopen-preview" && validTaskReopenPreviewRequest(input)) return await locked(async () => {
      if (!await checked.pull()) throw new RequestError(503, "Could not refresh this task. Nothing was changed; reconnect the main machine and retry.");
      primary(); return Response.json(previewTaskReopen(input));
    });
    const result = await persistRecord(() => {
      primary();
      if (action === "create" && validTaskCreateRequest(input)) return createTask(input);
      if (action === "reopen" && validTaskReopenRequest(input)) return reopenTaskForm(input);
      throw new RequestError(400, "Choose supported task settings");
    }, (value) => `${value.action} task ${value.id} (${value.request_id})`, checked);
    return taskFormResponse(result.value, result.synced);
  } catch (error) {
    if (error instanceof TaskFormSaveError) return taskFormResponse(error.result, false, error.message, true);
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

/** Every record write refreshes, validates and syncs under the same lock as the scheduler. */
async function recordRoute(req: Request, id: string | undefined, kind: string, r: { read: (id: string) => unknown; create: (b: unknown) => string; update: (id: string, b: unknown) => void; remove: (id: string) => void }, io: RecordSync): Promise<Response> {
  try {
    if (req.method === "GET" && id) return Response.json(r.read(id));
    const body = req.method === "POST" || req.method === "PUT" ? await req.json().catch(() => null) : null;
    const mutation = req.method === "POST" && !id ? "added" : req.method === "PUT" && id ? "edited" : req.method === "DELETE" && id ? "archived" : "";
    if (!mutation) return Response.json({ error: "not found" }, { status: 404 });
    const result = await persistRecord(() => {
      let one = id!;
      if (mutation === "added") one = r.create(body);
      else if (mutation === "edited") { r.update(one, body); if (kind === "routine") one = String((body as Record<string, unknown>).name); }
      else r.remove(one);
      return { id: one, view: settingsView() };
    }, (value) => `${kind} ${value.id} ${mutation}`, io);
    return recordResponse(result.value, result.synced);
  } catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
let planHook: (() => void) | null = null;
/** The daemon starts drafting and the next step right away instead of on its next tick. */
export const onPlanChanged = (fn: () => void) => { planHook = fn; };
const PLAN_ACTIONS: Record<string, (id: string, body: unknown) => Plan> = {
  approve: approvePlan, pause: pausePlan, resume: resumePlan, retry: retryStep, skip: skipStep, continue: continuePlan,
};
const planView = (plan: Plan) => ({ ...plan, stop_reviews: readStopReviews({ kind: "plan", id: plan.id }) });
/** The plans API (see docs/plans-design.md). Plans are shared with the daemon's tick, so every write takes its lock. */
export async function planRoute(req: Request, id?: string, action?: string, io: RecordSync = recordSync): Promise<Response> {
  const write = async (what: string, fn: () => Plan): Promise<Response> => {
    const result = await persistRecord(fn, (plan) => `plan ${plan.id} ${what}`, io);
    if (result.synced) planHook?.();
    return recordResponse({ plan: planView(result.value) }, result.synced);
  };
  const body = () => req.json().catch(() => null);
  try {
    if (!id && req.method === "GET") return Response.json({ plans: listPlans() });
    if (!id && req.method === "POST") { const b = await body(); return await write("created", () => createPlan(b)); }
    if (id && !action && req.method === "GET") return Response.json({ plan: planView(readPlan(id)) });
    if (id && !action && req.method === "PUT") { const b = await body(); return await write("edited", () => editSteps(id, b)); }
    if (id && !action && req.method === "DELETE") {
      const result = await persistRecord(() => { archivePlan(id); return { id, ok: true }; }, () => `plan ${id} archived`, io);
      return recordResponse(result.value, result.synced);
    }
    if (id && action === "cancel" && req.method === "POST") {
      const result = await persistRecord(() => cancelPlan(id), () => `plan ${id} cancelled`, io);
      if (!result.synced) return recordResponse({ plan: planView(result.value.plan) }, false);
      if (!hasPendingStops(result.value.plan.pending_stops)) return Response.json({ ok: true, id, plan: planView(result.value.plan), cleanup: { remaining: 0, pending: [], unresolved: [] } });
      return stopProgressResponse({ kind: "plan", id }, await drainStopOwner({ kind: "plan", id }));
    }
    if (id && action === "retry-stops" && req.method === "POST") {
      const input = await body() as { operation_id?: unknown } | null;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !stopRunId(input.operation_id))
        return Response.json({ error: "Choose the saved cleanup request to retry" }, { status: 400 });
      return stopProgressResponse({ kind: "plan", id }, await drainStopOwner({ kind: "plan", id }, input.operation_id));
    }
    const act = action ? PLAN_ACTIONS[action] : undefined;
    if (id && act && req.method === "POST") { const b = await body(); return await write(action!, () => act(id, b)); }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export const memberRoute = (req: Request, id?: string, io: RecordSync = recordSync) =>
  recordRoute(req, id, "member", { read: readMember, create: createMember, update: updateMember, remove: (m) => deleteMember(m, loadConfig()) }, io);
export const routineRoute = (req: Request, id?: string, io: RecordSync = recordSync) =>
  recordRoute(req, id, "routine", { read: readRoutine, create: createRoutine, update: updateRoutine, remove: deleteRoutine }, io);
export const projectRoute = (req: Request, id?: string, io: RecordSync = recordSync, projectFolder?: ProjectFolderCheck) =>
  recordRoute(req, id, "project", { read: readProject, create: (b) => createProject(b, hostName(loadConfig()), projectFolder),
    update: (id, b) => updateProject(id, b, hostName(loadConfig()), projectFolder), remove: deleteProject }, io);

/** Read and save owner-editable knowledge using the primary's latest copy and a content precondition. */
export async function documentRoute(req: Request, io = { pull: _pull, push: _commitPush }): Promise<Response> {
  if (!["POST", "PUT"].includes(req.method)) return Response.json({ error: "method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => null) as Record<string, any> | null;
  if (!body || !editableDocument(body.path)) return Response.json({ error: "Choose a rule, preference or member memory document" }, { status: 400 });
  const { path } = body;
  if (req.method === "PUT" && (typeof body.content !== "string" || !(body.base === null || typeof body.base === "string")
    || new TextEncoder().encode(body.content).length > DOCUMENT_MAX_BYTES || typeof body.base === "string" && new TextEncoder().encode(body.base).length > DOCUMENT_MAX_BYTES))
    return Response.json({ error: "Send the original document and Markdown text (up to 64 KB each)" }, { status: 400 });
  try {
    return await locked(async () => {
      if (!await io.pull()) throw new RequestError(503, "Could not load the latest document. Reconnect the main machine and try again.");
      const file = P(path);
      // Do not let a knowledge document or any of its parent folders redirect writes outside the data folder.
      let currentPath = DATA;
      for (const part of path.split("/")) {
        currentPath = join(currentPath, part);
        try { if (lstatSync(currentPath).isSymbolicLink()) throw new RequestError(400, "Linked documents cannot be edited here"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      if (path.startsWith("agents/") && !existsSync(P("agents", path.split("/")[1], "profile.md"))) throw new RequestError(404, "This member no longer exists");
      if (existsSync(file) && !statSync(file).isFile()) throw new RequestError(400, "Choose a Markdown file");
      const current = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (current !== null && new TextEncoder().encode(current).length > DOCUMENT_MAX_BYTES) throw new RequestError(413, "This document is too large for the editor (64 KB maximum)");
      if (req.method === "POST") return Response.json({ path, content: current });
      if (current !== body.base) throw new RequestError(409, "This document changed since you opened it. Your draft is kept. Reload the latest version before saving again.");
      const header = current === null ? "" : current.slice(0, current.length - documentBody(current).length);
      const content = header + body.content;
      if (new TextEncoder().encode(content).length > DOCUMENT_MAX_BYTES) throw new RequestError(413, "The complete document must fit within 64 KB");
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { writeFileSync(temporary, content, { flag: "wx" }); renameSync(temporary, file); }
      finally { rmSync(temporary, { force: true }); }
      journal(hostName(loadConfig()), `📝 owner edited ${path}`);
      if (!await io.push(`[knowledge] edit ${path}`)) throw new RequestError(503, "The document was saved locally but could not sync. Reload before trying again.");
      return Response.json({ path, content });
    });
  } catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** Only operational settings are returned; bootstrap credentials and file-only custom commands never enter the form. */
export function configurationView() {
  const cfg = loadConfig(true, false), f = P("settings.json");
  const saved = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).configuration ?? {} : {};
  const values = configurationValues(cfg), overrides = CONFIGURATION_FIELDS.filter((field) => configAt(saved, field.path) !== undefined).map((field) => field.path);
  if (Object.hasOwn(saved, "autonomy") && !settingsObject(saved.autonomy)) {
    values["autonomy.level"] = "Invalid; Learning is effective";
    if (!overrides.includes("autonomy.level")) overrides.push("autonomy.level");
  }
  return { values, learning: { host: hostName(cfg), blocked_reason: learningBlockReason(cfg) },
    provider_status: providerHealth(cfg).map((provider) => ({ ...provider, host: hostName(cfg) })), overrides };
}

/** Read histories only on the main machine, after refreshing the owner's selections. */
export async function learningRoute(req: Request, io: RecordSync = recordSync): Promise<Response> {
  return legacyLearningRequest(req, io);
}

export async function configurationRoute(req: Request, io = { pull: _pull, push: _commitPush }): Promise<Response> {
  if (req.method === "GET") return Response.json(configurationView());
  if (req.method !== "PUT") return Response.json({ error: "method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => null);
  try {
    await locked(async () => {
      if (!await io.pull()) throw new RequestError(503, "Could not load the latest settings. Try again after the main machine reconnects.");
      const f = P("settings.json"), current = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      const result = configurationPatch(body, current.configuration ?? {}, loadConfig(false));
      if ("error" in result) throw new RequestError(400, result.error);
      const next = { ...current, configuration: result.configuration };
      if (current.configuration && Object.hasOwn(current.configuration, "autonomy") && !settingsObject(current.configuration.autonomy) && settingsObject(result.configuration.autonomy)) {
        const before = loadConfig(), input = body as { values?: Record<string, unknown>; reset?: string[] };
        if (!Object.hasOwn(input.values ?? {}, "autonomy.level") && !input.reset?.includes("autonomy.level")) result.configuration.autonomy.level = level(before);
        const previous = settingsObject(current.autonomy) ? current.autonomy : {};
        next.autonomy = { ...previous, agents: { ...(settingsObject(previous.agents) ? previous.agents : {}), ...rosterAutonomy(before) } };
      }
      writeFileSync(`${f}.tmp`, JSON.stringify(next, null, 2) + "\n");
      renameSync(`${f}.tmp`, f);
      journal(hostName(loadConfig()), "⚙️ owner updated execution and resource settings");
      if (!await io.push("[settings] execution and resource configuration")) throw new RequestError(503, "Could not sync the settings. Reload them before trying again.");
    });
    return Response.json(configurationView());
  } catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** A machine can be paused without stopping its current work; overrides sync to that named machine only. */
export async function machineRoute(req: Request, name: string, io = { pull: _pull, push: _commitPush }): Promise<Response> {
  if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(name) || ["constructor", "prototype"].includes(name)) return Response.json({ error: "Invalid machine name" }, { status: 400 });
  const view = () => {
    const cfg = loadConfig(), beat = knownHosts().find((h) => h.host === name);
    if (!beat) throw new RequestError(404, "No such machine");
    const saved = cfg.machines?.[name] ?? {};
    return { host: name, enabled: saved.enabled ?? beat.enabled ?? true, max_parallel: saved.max_parallel !== undefined ? saved.max_parallel : beat.max_parallel ?? null,
      caps: saved.caps ?? beat.custom_caps ?? [], seen: beat.seen };
  };
  try {
    if (req.method === "GET") return Response.json(view());
    if (req.method !== "PUT") return Response.json({ error: "method not allowed" }, { status: 405 });
    view();
    const b = await req.json().catch(() => null) as { enabled?: unknown; max_parallel?: unknown; caps?: unknown } | null;
    if (!b || typeof b.enabled !== "boolean" || !(b.max_parallel === null || Number.isInteger(b.max_parallel) && Number(b.max_parallel) >= 1 && Number(b.max_parallel) <= 32)
      || !Array.isArray(b.caps) || b.caps.length > 40 || b.caps.some((c) => typeof c !== "string" || !/^[a-zA-Z0-9][\w.-]{0,39}$/.test(c)))
      throw new RequestError(400, "Choose whether to accept tasks, a limit from 1 to 32 (or automatic), and custom capability names without spaces or colons");
    return await locked(async () => {
      if (!await io.pull()) throw new RequestError(503, "Could not load the latest machine settings. Reconnect the main machine and try again.");
      view();
      const f = P("settings.json"), cur = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
      const value = { ...cur.machines?.[name], enabled: b.enabled, max_parallel: b.max_parallel, caps: [...new Set(b.caps as string[])] };
      const temporary = `${f}.${crypto.randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify({ ...cur, machines: { ...cur.machines, [name]: value } }, null, 2) + "\n", { flag: "wx" }); renameSync(temporary, f); }
      finally { rmSync(temporary, { force: true }); }
      journal(hostName(loadConfig()), `⚙️ owner updated run settings for ${name}`);
      if (!await io.push(`[settings] machine ${name}`)) throw new RequestError(503, "Machine settings were saved locally but could not sync. Reload before trying again.");
      return Response.json(view());
    });
  } catch (e) {
    if (e instanceof RequestError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** Machine defaults come from that machine, never from the primary's local history paths. */
export async function machineConfigurationRoute(req: Request, name: string, io = { pull: _pull, push: _commitPush }): Promise<Response> {
  if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(name) || ["constructor", "prototype"].includes(name)) return Response.json({ error: "Invalid machine name" }, { status: 400 });
  const snapshot = () => {
    const cfg = loadConfig(), beat = knownHosts().find((host) => host.host === name);
    if (!beat) throw new RequestError(404, "No such machine");
    const reported = name === hostName(cfg) ? cfg.resource_defaults : beat.resource_defaults;
    if (!reported) throw new RequestError(409, "Update this machine and let it sync once to report its resource defaults. Offline machines can be edited after their first report.");
    const learningReported = name === hostName(cfg) ? cfg.learning_defaults : beat.learning_defaults;
    const learningSupported = !!learningReported;
    const diskPathSupported = name === hostName(cfg) || beat.disk_path_supported === true && Object.hasOwn(reported, "resources.disk_path");
    const fields = MACHINE_CONFIGURATION_FIELDS.filter((field) => (learningSupported || field.group !== "onboarding") && (diskPathSupported || field.path !== "resources.disk_path"));
    const saved = cfg.machines?.[name] ?? {}, defaults: Record<string, any> = { resources: {}, learn: {} };
    for (const field of fields) {
      const [group, key] = field.path.split(".");
      defaults[group][key] = (group === "resources" ? reported : learningReported)?.[field.path] ?? field.default;
    }
    // Shared UI changes may be newer than the machine's latest heartbeat.
    for (const field of RESOURCE_FIELDS) {
      const value = configAt(cfg.configuration ?? {}, field.path);
      if (value !== undefined) defaults.resources[field.path.split(".")[1]!] = value;
    }
    return { saved, defaults, fields, learningSupported, diskPathSupported, view: { host: name, learning_supported: learningSupported, disk_path_supported: diskPathSupported,
      values: Object.fromEntries(fields.map((field) => [field.path, configAt(saved, field.path) !== undefined ? configAt(saved, field.path) : configAt(defaults, field.path)])),
      overrides: fields.filter((field) => configAt(saved, field.path) !== undefined).map((field) => field.path), seen: beat.seen } };
  };
  try {
    if (req.method === "GET") return Response.json(snapshot().view);
    if (req.method !== "PUT") return Response.json({ error: "method not allowed" }, { status: 405 });
    const body = await req.json().catch(() => null) as { values?: Record<string, unknown>; reset?: string[] } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "values" && key !== "reset")
      || body.values !== undefined && (!body.values || typeof body.values !== "object" || Array.isArray(body.values))
      || body.reset !== undefined && !Array.isArray(body.reset)
      || [...Object.keys(body.values ?? {}), ...(body.reset ?? [])].some((path) => !MACHINE_CONFIGURATION_FIELDS.some((field) => field.path === path)))
      throw new RequestError(400, "Only resource limits and learning history locations can be overridden for a machine");
    return await locked(async () => {
      if (!await io.pull()) throw new RequestError(503, "Could not load the latest machine settings. Reconnect the main machine and try again.");
      const { saved, defaults, fields, learningSupported, diskPathSupported } = snapshot();
      if (!learningSupported && [...Object.keys(body.values ?? {}), ...(body.reset ?? [])].some((path) => MACHINE_LEARNING_FIELDS.some((field) => field.path === path)))
        throw new RequestError(409, "Update this machine and let it sync once to configure its learning history locations.");
      if (!diskPathSupported && [...Object.keys(body.values ?? {}), ...(body.reset ?? [])].includes("resources.disk_path"))
        throw new RequestError(409, "Update this machine and let it sync once to choose its disk monitoring path.");
      const result = configurationPatch(body, saved, defaults, fields);
      if ("error" in result) throw new RequestError(400, result.error);
      const file = P("settings.json"), current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      const value = { ...current.machines?.[name], resources: result.configuration.resources ?? {}, ...(learningSupported ? { learn: result.configuration.learn ?? {} } : {}) };
      if (!diskPathSupported && Object.hasOwn(saved.resources ?? {}, "disk_path")) value.resources.disk_path = saved.resources.disk_path;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify({ ...current, machines: { ...current.machines, [name]: value } }, null, 2) + "\n", { flag: "wx" }); renameSync(temporary, file); }
      finally { rmSync(temporary, { force: true }); }
      journal(hostName(loadConfig()), `⚙️ owner updated resource and learning settings for ${name}`);
      if (!await io.push(`[settings] machine configuration for ${name}`)) throw new RequestError(503, "Machine settings were saved locally but could not sync. Reload before trying again.");
      return Response.json(snapshot().view);
    });
  } catch (error) {
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

/** Built-in specialists use the same confirmed record writes as custom members. */
export async function roleRoute(req: Request, id?: string, io: RecordSync = recordSync): Promise<Response> {
  try {
    if (id && !listRoles().some((role) => role.id === id)) throw new RequestError(404, "No such built-in specialist");
    if (req.method === "GET") return Response.json(id ? readRole(id) : { roles: listRoles() });
    if (req.method !== "POST" || !id) return Response.json({ error: "method not allowed" }, { status: 405 });
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
      throw new RequestError(400, "Send an empty object to add the selected built-in specialist");
    const result = await persistRecord(() => ({ id, routines: addRole(id), view: settingsView() }), (value) => `built-in specialist ${value.id} added`, io);
    return recordResponse(result.value, result.synced);
  } catch (error) {
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    console.error("built-in specialist setup failed", error);
    return Response.json({ error: "Could not load or add this built-in specialist. Check the main machine and retry." }, { status: 500 });
  }
}

/** The same forms and validation serve local connections and remote requests from the owner's cloud hub. */
export async function recordRequest(req: Request, io: RecordSync = recordSync, projectFolder?: ProjectFolderCheck): Promise<Response> {
  if (machineLearningPath(new URL(req.url).pathname)) return learningRequest(req, io);
  const route = recordPath(new URL(req.url).pathname);
  if (route?.kind === "archive") return archiveRequest(req, route.action, io, projectFolder);
  if (route?.kind === "task-create") return taskFormRequest(req, "create", io);
  if (route?.kind === "task-reopen-preview") return taskFormRequest(req, "reopen-preview", io);
  if (route?.kind === "task-reopen") return taskFormRequest(req, "reopen", io);
  if (route?.kind === "stop-capabilities") return req.method !== "GET" ? Response.json({ error: "method not allowed" }, { status: 405 })
    : stopDrainer && cancelHook ? Response.json({ family_stops: 1, family_reviews: 1 }) : Response.json({ error: "Connect or update the main machine to confirm task-family stops." }, { status: 503 });
  if (route?.kind === "stop-review" || route?.kind === "stop-resolve") return stopReviewRequest(req, route.kind === "stop-resolve", io);
  if (route?.kind === "settings") return settingsRoute(req);
  if (route?.kind === "roles") return roleRoute(req, route.id, io);
  if (route?.kind === "documents") return documentRoute(req);
  if (route?.kind === "configuration") return configurationRoute(req);
  if (route?.kind === "learning") return learningRoute(req, io);
  if (route?.kind === "task-cancel") return taskCancelRequest(req);
  if (route?.kind === "task-stop-retry") return taskStopRetryRequest(req);
  if (route?.kind === "task-config") {
    if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
    const result = await applyOp({ ...(await req.json().catch(() => ({})) as Record<string, unknown>), tool: "configure_task" }) as { ok?: boolean; error?: string; data?: Record<string, unknown> } | null;
    if (!result) return Response.json({ ok: false, error: "daemon unavailable" }, { status: 503 });
    const detail: Record<string, unknown> = result.data ?? result;
    const status = detail.status === 503 ? 503 : result.ok === false || detail.ok === false ? 400 : 200;
    return Response.json(detail.saved_locally ? { ...result, id: detail.id, saved_locally: true, error: detail.error } : result, { status });
  }
  if (route?.kind === "machines" && route.id) return route.action === "configuration" ? machineConfigurationRoute(req, route.id) : machineRoute(req, route.id);
  if (route?.kind === "members") return memberRoute(req, route.id, io);
  if (route?.kind === "routines") return routineRoute(req, route.id, io);
  if (route?.kind === "projects") return projectRoute(req, route.id, io, projectFolder);
  if (route?.kind === "plans") return planRoute(req, route.id, route.action, io);
  return Response.json({ error: "not found" }, { status: 404 });
}

const ID = /^\s*((?:[DP]-[A-Z]?\d{4}|L-\d{4,}))\b[\s:：,，\-]*([\s\S]*)$/;

/** Owner said something (local chat or via the cloud inbox): answer an open D-/P-/L- item, or hand it to lead. */
let lastAnswer: { id: string; at: number } | null = null;
export type TaskRunExpectation = { host: string; run_id: string };
let stopDrainer: StopDrainer | null = null;
export const setStopDrainer = (fn: StopDrainer | null) => { stopDrainer = fn; };
let cancelHook: ((tid: string, done?: boolean, expected?: TaskRunExpectation, onlyQueued?: boolean) => Promise<string>) | null = null;
export const setCancelTask = (fn: (tid: string, done?: boolean, expected?: TaskRunExpectation, onlyQueued?: boolean) => Promise<string>) => { cancelHook = fn; };
/** The owner cancels a task (queued, waiting, blocked, proposed or running). */
/** done: the owner finished it himself (merged by hand, …): it ends as done, not cancelled. */
export const cancelTask = async (tid: string, done = false, expected?: TaskRunExpectation, onlyQueued = false) => {
  let result = "not available", failure: unknown;
  try { if (cancelHook) result = await cancelHook(tid, done, expected, onlyQueued); } catch (error) { failure = error; }
  if (stopDrainer && (failure || result === "cancelled" || result === "done")) {
    const progress = await stopDrainer({ kind: "task", id: tid });
    if (progress.operation_id || progress.remaining) {
      if (!progress.complete || !progress.synced) throw stopProgressFailure({ kind: "task", id: tid }, progress, expected?.run_id);
      const terminal = progress.terminal;
      if (terminal?.id === tid && terminal.result === (done ? "done" : "cancelled") && (!expected || terminal.run_id === expected.run_id && terminal.host === expected.host)) return terminal.result;
    }
  }
  if (failure) throw failure;
  return result;
};

function stopProgressFailure(owner: StopOwner, progress: StopDrainResult, run_id?: string) {
  return new ActionSyncError(progress.error ?? (progress.remaining ? `${progress.remaining} stop${progress.remaining === 1 ? "" : "s"} still need confirmation for ${owner.id}. Retry the remaining stops from its page.` : "Cleanup was saved, but synchronization is not confirmed. Refresh its progress before retrying."), {
    id: owner.id, ...(run_id ? { run_id } : {}), saved_locally: true, stops: progress.pending_stops,
  });
}
async function drainStopOwner(owner: StopOwner, operation_id?: string): Promise<StopDrainResult> {
  if (!stopDrainer) {
    const plan = owner.kind === "plan" ? readPlan(owner.id) : undefined, path = owner.kind === "task" ? stopTaskPath(owner.id) : undefined;
    if (owner.kind === "task" && !path) throw new RequestError(404, "No such task cleanup");
    const raw = plan ? plan.pending_stops : readDoc(path!).meta.pending_stops, batch = readPendingStops(raw);
    if (operation_id && operation_id !== batch?.operation_id) throw new RequestError(409, "This cleanup operation changed. Refresh it before retrying.");
    return { owner, operation_id: batch?.operation_id, done: batch?.done, complete: false, synced: false,
      remaining: batch ? batch.pending.length + batch.unresolved.length : hasPendingStops(raw) ? 1 : 0,
      pending: batch?.pending ?? [], unresolved: batch?.unresolved ?? [], pending_stops: batch, plan,
      error: pendingStopsError(raw) ?? "Connect the main machine to confirm the remaining stops." };
  }
  return stopDrainer(owner, operation_id);
}
function stopProgressResponse(owner: StopOwner, progress: StopDrainResult): Response {
  const ok = progress.complete && progress.synced;
  return Response.json({ ok, id: owner.id, ...(owner.kind === "plan" ? { plan: planView(progress.plan ?? readPlan(owner.id)) } : { task: taskInfo(taskStore(), owner.id) }),
    stops: progress.pending_stops ? pendingStopsView(progress.pending_stops) : undefined,
    cleanup: { operation_id: progress.operation_id, remaining: progress.remaining, pending: progress.pending, unresolved: progress.unresolved },
    ...(!ok ? { saved_locally: true, error: progress.error ?? "Some child stops still need confirmation. Their original run identities have been kept; refresh or retry the remaining stops." } : {}),
  }, { status: ok ? 200 : 503 });
}
/** Reviewing a stop changes its authorization, never the process state or the cleanup operation. */
export async function stopReviewRequest(req: Request, resolve = false, io: RecordSync = recordSync): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const input: unknown = await req.json().catch(() => null);
  if (!(resolve ? validStopResolveRequest(input) : validStopReviewRequest(input)))
    return Response.json({ error: "Choose the saved cleanup target and a current review before recording a decision." }, { status: 400 });
  const primary = () => {
    if (!isPrimary(loadConfig())) throw new RequestError(409, "Open the main machine to review this cleanup. A worker cannot authorize another run.");
  };
  const checked = { ...io, pull: async () => { try { return await io.pull(); } catch { return false; } } };
  try {
    if (!resolve && validStopReviewRequest(input)) return await locked(async () => {
      if (!await checked.pull()) throw new RequestError(503, "Could not refresh this cleanup. Nothing was changed; reconnect the main machine and retry.");
      primary();
      return Response.json(inspectStopReview(input));
    });
    if (!validStopResolveRequest(input)) return Response.json({ error: "Choose a supported cleanup decision." }, { status: 400 });
    const result = await persistRecord(() => {
      primary();
      const resolution = applyStopResolution(input), owner = resolution.owner;
      return { resolution, view: owner.kind === "plan" ? { plan: planView(readPlan(owner.id)) } : { task: taskInfo(taskStore(), owner.id) } };
    }, (value) => `cleanup review ${value.resolution.review_id} for ${value.resolution.owner.id}`, checked);
    const value = result.value.resolution, owner = value.owner, batch = value.pending_stops;
    let view = result.value.view;
    try { view = owner.kind === "plan" ? { plan: planView(readPlan(owner.id)) } : { task: taskInfo(taskStore(), owner.id) }; } catch { /* A lost sync race must retain the saved review identity. */ }
    return Response.json({ ok: result.synced, id: owner.id, owner, operation_id: value.operation_id, target_id: value.target_id, action: value.action,
      request_id: value.request_id, review_id: value.review_id, review: value.review,
      ...view,
      stops: pendingStopsView(batch), cleanup: { operation_id: value.operation_id, remaining: value.remaining, pending: batch.pending, unresolved: batch.unresolved },
      ...(!result.synced ? { saved_locally: true, error: "The review was saved on the main machine, but sync was not confirmed. Retry this same review request before retrying the remaining stops." } : {}),
    }, { status: result.synced ? 200 : 503 });
  } catch (error) {
    if (error instanceof StopReviewSaveError) {
      const value = error.resolution, owner = value.owner, batch = value.pending_stops;
      let view: Record<string, unknown> = {};
      try { view = owner.kind === "plan" ? { plan: planView(readPlan(owner.id)) } : { task: taskInfo(taskStore(), owner.id) }; } catch { /* Preserve the review even when a partial write left its owner unavailable. */ }
      return Response.json({ ok: false, id: owner.id, owner, operation_id: value.operation_id, target_id: value.target_id, action: value.action,
        request_id: value.request_id, review_id: value.review_id, review: value.review, ...view, stops: pendingStopsView(batch),
        cleanup: { operation_id: value.operation_id, remaining: value.remaining, pending: batch.pending, unresolved: batch.unresolved },
        saved_locally: true, uncertain: true, error: error.message }, { status: 503 });
    }
    if (error instanceof ActionSyncError) return Response.json({ ...(validStopResolveRequest(input) ? {
      id: input.owner.id, owner: input.owner, operation_id: input.operation_id, target_id: input.target_id, action: input.action, request_id: input.request_id,
    } : {}), ...error.data }, { status: 503 });
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof StopStorageError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
export async function taskStopRetryRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const input = await req.json().catch(() => null) as { id?: unknown; operation_id?: unknown } | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["id", "operation_id"].includes(key)) || typeof input.id !== "string" || !TASK_ID.test(input.id) || !stopRunId(input.operation_id))
    return Response.json({ error: "Choose the task and its saved cleanup request" }, { status: 400 });
  try { return stopProgressResponse({ kind: "task", id: input.id }, await drainStopOwner({ kind: "task", id: input.id }, input.operation_id)); }
  catch (error) { if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
}
/** Local and remote UI cancellation wait for the daemon's checked persistence result. */
export async function taskCancelRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => null) as { id?: unknown; done?: unknown; host?: unknown; run_id?: unknown; queued?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["id", "done", "host", "run_id", "queued"].includes(key))
    || typeof body.id !== "string" || !TASK_ID.test(body.id) || body.done !== undefined && typeof body.done !== "boolean"
    || body.queued !== undefined && body.queued !== true
    || (body.host !== undefined || body.run_id !== undefined) && (body.queued === true || !validMachineHost(body.host) || !validRunId(body.run_id)))
    return Response.json({ error: "Choose a task and whether to mark it done" }, { status: 400 });
  const id = body.id;
  const expected = body.host !== undefined ? { host: body.host as string, run_id: body.run_id as string } : undefined;
  const key = req.headers.get("Idempotency-Key");
  if (key === null) return cancellationResponse(id, body.done === true, expected, body.queued === true);
  const intent = { id, done: body.done === true, ...expected, queued: body.queued === true };
  const result = await receiveRequest(`task-control:${req.headers.get("Authorization") ?? "internal-ui"}`, key, intent, () => ({ id, ...(expected ? { run_id: expected.run_id } : {}) }), async () => {
    const response = await cancellationResponse(id, body.done === true, expected, body.queued === true), data = await response.json() as Record<string, unknown>;
    if (response.status === 503 && data.retryable === true) throw new ActionSyncError(String(data.error), data);
    return { status: response.status, data };
  }, () => ({ status: 503, data: { ok: false, id, ...(expected ? { run_id: expected.run_id } : {}), uncertain: true,
    error: "This task request stopped before confirmation. Refresh the task before taking another action; this request will not be applied again." } }));
  return Response.json(result.data, { status: result.status });
}

async function cancellationResponse(id: string, done: boolean, expected?: TaskRunExpectation, onlyQueued = false) {
  const identity = { id, ...(expected ? { run_id: expected.run_id } : {}) };
  try {
    const result = await cancelTask(id, done, expected, onlyQueued);
    if (result === "cancelled" || result === "done") return Response.json({ ok: true, ...identity, result });
    const status = result === "not found" ? 404 : result === "not available" ? 503 : 409;
    const error = result.startsWith("running on ") ? `This task is ${result}. Cancel or finish it on that machine; the main machine cannot stop this run.`
      : result === "not found" ? `Task ${id} is no longer open. Reload its status before trying again.`
      : result === "not available" ? "The main machine's task controls are unavailable. Reconnect it and retry." : result;
    return Response.json({ ok: false, ...identity, error, result }, { status });
  } catch (error) {
    if (error instanceof ActionSyncError) return Response.json({ ...error.data, ...identity }, { status: 503 });
    if (error instanceof RequestError) return Response.json({ ok: false, ...identity, error: error.message }, { status: error.status });
    throw error;
  }
}

/** A targeted machine command stops only its own exact run; the primary never writes another worker's terminal state. */
export async function taskControlRequest(req: Request): Promise<Response> {
  const route = machineTaskPath(new URL(req.url).pathname);
  if (!route) return Response.json({ error: "not found" }, { status: 404 });
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["id", "run_id", "done"].includes(key)) || !validTaskControl({ ...body, host: route.host }))
    return Response.json({ error: "Choose the exact task run and outcome" }, { status: 400 });
  const id = body.id as string, run_id = body.run_id as string;
  if (route.host !== hostName(loadConfig())) return Response.json({ ok: false, id, run_id, error: "This run belongs to a different machine." }, { status: 409 });
  const response = await cancellationResponse(id, body.done === true, { host: route.host, run_id });
  const data = await response.json() as Record<string, unknown>;
  if (response.ok) return Response.json(data, { status: response.status });
  return Response.json({ ok: false, id, run_id, error: String(data.error ?? "Could not confirm this task control"),
    ...(typeof data.result === "string" ? { result: data.result } : {}),
    ...Object.fromEntries(["saved_locally", "uncertain", "retryable"].filter((key) => data[key] === true).map((key) => [key, true])) }, { status: response.status });
}
let opHook: ((op: any) => Promise<unknown>) | null = null;
export const setApplyOp = (fn: (op: any) => Promise<unknown>) => { opHook = fn; };
/** A write the cloud MCP server handed over (create/amend/cancel a task, remember, …): performed here, where the data lives. */
export const applyOp = async (op: any) => (opHook ? opHook(op) : null);
export async function ownerActionResponse(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ActionSyncError) return Response.json(error.data, { status: 503 });
    throw error;
  }
}
let updateHook: (() => Promise<number>) | null = null;
export const setUpdateFleet = (fn: () => Promise<number>) => { updateHook = fn; };
/** The owner asks every machine to update to the latest code (the primary also redeploys the Worker and the web app). */
export async function updateFleet(): Promise<string> {
  if (!updateHook) return "not available";
  const n = await updateHook();
  appendEvent({ from: "hub", kind: "system", text: `Asked ${n} machine(s) to update to the latest code: idle ones update now, busy ones restart when their tasks finish; the main host also redeploys the live site.` });
  return "ok";
}
const AMEND_MS = 5 * 60_000;

// ---------------------------------------------------------------- the owner's images (attachments of a chat message)
// Downloaded next to the data repo (not into it: the repo syncs through git / the Worker's files API, which is no place
// for screenshots), one directory per message, and named by absolute path in the task so Claude / Codex can open them.
export const ATTACH_DIR = join(DATA, "..", "attachments");
export type FetchAttachment = (path: string) => Promise<Uint8Array | null>;
/** The local server's own media ("/media/<file>" in MEDIA). */
export const localMedia: FetchAttachment = async (p) => {
  const f = join(MEDIA, basename(p));
  return existsSync(f) && statSync(f).isFile() ? new Uint8Array(readFileSync(f)) : null;
};

/** How long images and other media are kept: one of MEDIA_DAYS (settings `media_days`), 7 by default. */
export const MEDIA_DAYS = [7, 14, 30, 90];
export const mediaDays = (cfg: Cfg) => (MEDIA_DAYS.includes(Number(cfg.media_days)) ? Number(cfg.media_days) : 7);

/** Delete media and downloaded attachments older than `days` (by modification time); returns how many entries went. */
export function pruneMedia(days: number, dirs = [MEDIA, ATTACH_DIR], now = Date.now()): number {
  const cutoff = now - days * 86_400_000;
  let n = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try { if (statSync(f).mtimeMs < cutoff) { rmSync(f, { recursive: true, force: true }); n++; } } catch {}
    }
  }
  return n;
}

/** Download a message's attachments into ATTACH_DIR/<key>/; returns the absolute paths saved (failures are skipped). */
export async function saveAttachments(key: string, paths: string[], fetchOne: FetchAttachment = localMedia, root = ATTACH_DIR): Promise<string[]> {
  const dir = join(root, key.replace(/[^\w.\-]/g, "_"));
  const out: string[] = [];
  for (const p of paths) {
    const bytes = await fetchOne(p).catch(() => null);
    if (!bytes) { console.error(`attachment ${p}: download failed`); continue; }
    mkdirSync(dir, { recursive: true });
    const f = join(dir, basename(p).replace(/[^\w.\-]/g, "_") || `image-${out.length + 1}`);
    writeFileSync(f, bytes);
    out.push(f);
  }
  return out;
}

/** The owner's text with the saved images listed for the agent (a message of images only gets a placeholder text). */
export function withAttachments(text: string, files: string[], missing = 0): string {
  if (!files.length && !missing) return text;
  const lines = files.map((f) => `- ${f}`);
  if (missing) lines.push(`- (${missing} more image(s) could not be downloaded)`);
  return `${text.trim() || "(see the attached images)"}\n\nAttached images from the owner (absolute paths on the primary host; open them to see):\n${lines.join("\n")}`;
}

export async function handleOwnerMessage(
  text: string, reply_to?: string, noAmend = false,
  att: { paths?: string[]; key?: string; fetch?: FetchAttachment; sentAt?: string; thread?: boolean } = {},
) {
  if (att.thread && (!reply_to || !TASK_ID.test(reply_to))) throw new RequestError(400, "Choose a valid task thread before sending this instruction.");
  let m = text.match(ID);
  const id = m?.[1] ?? (reply_to && /^(?:[DP]-[A-Z]?\d{4}|L-\d{4,})$/.test(reply_to) ? reply_to : null);
  // A reply keeps its task context, including host-prefixed task identities.
  const replyTask = !id && reply_to && TASK_ID.test(reply_to) ? reply_to : undefined;
  if (att.thread && replyTask && !["inbox", "active", "waiting", "blocked", "done", "failed"].some((state) => existsSync(P("tasks", state, `${replyTask}.md`)))) {
    const cancelled = P("tasks/rejected", `${replyTask}.md`);
    if (existsSync(cancelled) && readDoc(cancelled).meta.cancelled)
      throw new RequestError(409, `Task ${replyTask} is cancelled. Use Reopen task to review its run settings before continuing it.`);
  }
  if (att.paths?.length) {
    const files = await saveAttachments(att.key ?? crypto.randomUUID(), att.paths, att.fetch);
    text = withAttachments(text, files, att.paths.length - files.length);
    m = text.match(ID);
  }
  if (id) {
    inbound.push({ id, answer: (m ? m[2] : text).trim(), source: "chat" });
    if (id.startsWith("D-")) lastAnswer = { id, at: Date.now() };
  } else if (ownerTask) {
    // everything else goes to the chat brain: it answers, looks things up, and creates or adjusts work through the tools
    const answered = !noAmend && !replyTask && lastAnswer && Date.now() - lastAnswer.at < AMEND_MS ? lastAnswer.id : undefined;
    await ownerTask(text, { reply: replyTask, answered, sentAt: att.sentAt, thread: !!(att.thread && replyTask) });
  }
}

export const setOwnerTask = (fn: OwnerTask) => { ownerTask = fn; };

// ---------------------------------------------------------------- read-only rules & memory (mirrors the Worker's /api/files/list|read)
export function listDataFiles(prefix: string, root = DATA) {
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  if (!readable(prefix)) return null;
  const out: { path: string; size: number; updated: string; version: number }[] = [];
  const walk = (rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(join(root, rel)).sort(); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const r = rel + n, st = statSync(join(root, r));
      if (st.isDirectory()) walk(r + "/");
      else if (out.length < 2000) out.push({ path: r, size: st.size, updated: st.mtime.toISOString(), version: 0 });
    }
  };
  walk(prefix);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
export function readDataFile(path: string, root = DATA) {
  if (!validPath(path) || !readable(path)) return null;
  try {
    const st = statSync(join(root, path));
    if (!st.isFile()) return undefined;
    return { path, content: readFileSync(join(root, path), "utf8"), size: st.size, updated: st.mtime.toISOString(), version: 0 };
  } catch { return undefined; }
}

/**
 * Sign-in for a hub with no Worker: the client asks for a code, the owner reads it with `noop login` on this machine.
 * Same limits as the Worker's login. shortcut: the session is the machine token, so signing out revokes nothing and the
 * code is forgotten on restart; give clients their own sessions if a local hub ever serves more than its owner.
 */
export function localSignIn(token: string, now = Date.now) {
  const CODE_TTL = 10 * 60_000, CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 10;
  let pending: { email: string; code: string; expires: number; sent: number; tries: number } | null = null;
  let sends: number[] = [];
  const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
  return {
    start(email: unknown) {
      const e = normEmail(email), t = now();
      if (!/^[^@\s]+@[^@\s]+$/.test(e)) return { status: 400, body: { error: "invalid email" } };
      sends = sends.filter((s) => s > t - 3600_000);
      if (pending && pending.sent > t - RESEND_MS) return { status: 429, body: { error: "Please wait a minute before requesting another code." } };
      if (sends.length >= SENDS_PER_HOUR) return { status: 429, body: { error: "Too many codes sent. Try again in an hour." } };
      sends.push(t);
      pending = { email: e, code: String(randomInt(1_000_000)).padStart(6, "0"), expires: t + CODE_TTL, sent: t, tries: 0 };
      return { status: 200, body: { ok: true, delivery: "cli" } };
    },
    verify(email: unknown, code: unknown) {
      if (!pending || pending.expires <= now()) return { status: 401, body: { error: "Wrong or expired code." } };
      if (pending.tries >= CODE_TRIES) return { status: 401, body: { error: "Too many attempts. Request a new code." } };
      pending.tries++;
      if (pending.email !== normEmail(email) || pending.code !== String(code ?? "")) return { status: 401, body: { error: "Wrong or expired code." } };
      pending = null;
      return { status: 200, body: { session: token } };
    },
    pendingCode() {
      return pending && pending.expires > now() ? { email: pending.email, code: pending.code, expires: pending.expires } : null;
    },
  };
}

export function startServer(cfg: Cfg, onOwnerTask: OwnerTask) {
  if (process.env.NODE_ENV !== "test") void ensureWebClient(); // served as soon as it lands
  const s = cfg.server ?? {};
  if (s.enabled === false) return;
  if (!s.token) { console.error("server: set [server].token in config.local.toml to enable the chat API"); return; }
  ownerTask = onOwnerTask;
  const auth = (req: Request) => {
    const h = req.headers.get("authorization") ?? "";
    const q = new URL(req.url).searchParams.get("token");
    return h === `Bearer ${s.token}` || q === s.token;
  };
  const json = (d: unknown, status = 200) => Response.json(d, { status });
  const signIn = cfg.cloud?.url ? null : localSignIn(s.token); // with a Worker, clients sign in there

  const server = Bun.serve({
    hostname: s.host ?? "0.0.0.0",
    port: s.port ?? 8787,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // The NSH client's web package (from the latest release, or `app/build-web.sh`) when present; else web/index.html.
      if (existsSync(join(NSH_WEB, "index.html")) && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) {
        const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const f = join(NSH_WEB, rel);
        if (!rel.includes("..") && existsSync(f) && statSync(f).isFile()) return new Response(Bun.file(f));
      }
      if (url.pathname === "/" || url.pathname === "/index.html")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "index.html")));
      if (url.pathname === "/manifest.webmanifest")
        return new Response(Bun.file(join(import.meta.dir, "..", "web", "manifest.webmanifest")));
      if (signIn && req.method === "POST" && (url.pathname === "/api/auth/start" || url.pathname === "/api/auth/verify")) {
        const b = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
        const r = url.pathname === "/api/auth/start" ? signIn.start(b?.email) : signIn.verify(b?.email, b?.code);
        return json(r.body, r.status);
      }
      if (!auth(req)) return json({ error: "unauthorized" }, 401);
      if (signIn && url.pathname === "/api/host/login-code") {
        const c = signIn.pendingCode();
        return c ? json(c) : json({ error: "no pending code" }, 404);
      }
      if (url.pathname === "/api/stream" && srv.upgrade(req)) return undefined as unknown as Response;
      if (url.pathname.startsWith("/media/")) {
        const f = join(MEDIA, basename(url.pathname));
        return existsSync(f) ? new Response(Bun.file(f)) : json({ error: "not found" }, 404);
      }
      if (machineProjectPath(url.pathname)) return projectFolderRequest(req);
      if (machineLearningPath(url.pathname)) return learningRequest(req);
      if (machineTaskPath(url.pathname)) return taskControlRequest(req);
      if (machineAccountPath(url.pathname)) return accountRequest(req);
      if (recordPath(url.pathname)) return recordRequest(req);
      if (url.pathname === "/api/feed") return json({ events: feed(url.searchParams.get("since") ?? undefined) });
      if (url.pathname === "/api/status") return json(status());
      if (url.pathname === "/api/files/list" && req.method === "GET") {
        const files = listDataFiles(url.searchParams.get("prefix") ?? "");
        return files ? json({ files }) : json({ error: "prefix not readable" }, 403);
      }
      if (url.pathname === "/api/files/read" && req.method === "GET") {
        const f = readDataFile(url.searchParams.get("path") ?? "");
        return f ? json(f) : f === null ? json({ error: "path not readable" }, 403) : json({ error: "not found" }, 404);
      }
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        return json(taskHistory(taskStore(), { query: url.searchParams.get("q") ?? "", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) }));
      }
      if (url.pathname === "/api/tasks/get" && req.method === "GET") {
        const t = taskInfo(taskStore(), url.searchParams.get("id") ?? "");
        if (!t) return json({ error: "not found" }, 404);
        const refs = new Set([t.id, ...t.decisions]);
        return json({ ...t, events: feed("", 2000).filter((e) => e.ref && refs.has(e.ref)) });
      }
      if (url.pathname === "/api/fleet/update" && req.method === "POST") return ownerActionResponse(async () => json({ ok: true, result: await updateFleet() }));
      if (url.pathname === "/api/media" && req.method === "POST") {
        const f = (await req.formData()).get("file") as File | null;
        if (!f) return json({ error: "file required" }, 400);
        mkdirSync(MEDIA, { recursive: true });
        const name = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
        await Bun.write(join(MEDIA, name), f);
        return json({ url: `/media/${name}` });
      }
      if (url.pathname === "/api/uploads" && req.method === "POST") { // the owner's images for a message
        const f = (await req.formData().catch(() => null))?.get("file") as File | null;
        if (!f || typeof f === "string") return json({ error: "file required" }, 400);
        const bytes = new Uint8Array(await f.arrayBuffer());
        const type = sniffImage(bytes.subarray(0, 16), f.type);
        const bad = uploadProblem(type, f.size);
        if (bad) return json({ error: bad.error }, bad.status);
        mkdirSync(MEDIA, { recursive: true });
        const name = uploadId(f.name);
        await Bun.write(join(MEDIA, name), bytes);
        return json({ url: `/media/${name}` });
      }
      if (url.pathname === "/api/events" && req.method === "POST") return json(appendEvent(await req.json() as Event));
      if (url.pathname === "/api/messages" && req.method === "POST") {
        const input = await req.json().catch(() => null) as { text?: unknown; reply_to?: unknown; attachments?: unknown; thread?: unknown } | null;
        if (!input || typeof input !== "object" || Array.isArray(input) || input.text !== undefined && typeof input.text !== "string"
          || input.reply_to !== undefined && typeof input.reply_to !== "string" || input.thread !== undefined && typeof input.thread !== "boolean") return json({ error: "invalid message" }, 400);
        const { text = "", reply_to, attachments, thread: inThread } = input as { text?: string; reply_to?: string; attachments?: unknown; thread?: boolean };
        if (inThread && (!reply_to || !TASK_ID.test(reply_to))) return json({ error: "Choose a valid task thread before sending this instruction." }, 400);
        const files = ownerAttachments(attachments);
        if (files === null) return json({ error: "bad attachments" }, 400);
        if (files.some((p) => !existsSync(join(MEDIA, basename(p))))) return json({ error: "attachment not found" }, 400);
        if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
        const thread = inThread === true && /^T-/.test(reply_to ?? "");
        const result = await receiveMessage(String(s.token), req.headers.get("Idempotency-Key"), { text, reply_to, attachments: files, thread },
          () => ({ id: crypto.randomUUID(), ts: new Date().toISOString(), from: "owner", kind: "owner", text, ...(reply_to ? { ref: reply_to } : {}), ...(files.length ? { attachments: files } : {}), ...(thread ? { thread } : {}) }),
          async (ev, first) => {
            if (first) appendEvent(ev);
            await handleOwnerMessage(text, reply_to, false, { paths: files, key: ev.id, thread });
          });
        return json(result.data, result.status);
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });
  console.log(`hub server on http://${server.hostname}:${server.port}  (phone: tailscale serve --bg ${server.port})`);
  return server;
}

export const hostLabel = (cfg: Cfg) => hostName(cfg);
