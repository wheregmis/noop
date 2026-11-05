// Hub server: runs inside the primary daemon. Chat API (for the NSH client), built-in web chat (PWA), media.
// Reach it from phone / Mac over Tailscale (`tailscale serve --bg 8787` gives HTTPS on your tailnet). No cloud.
//
// API (Bearer token = [server].token in config.local.toml):
//   POST /api/auth/start {email} · POST /api/auth/verify {email, code} → {session}   no Worker only; `noop login` shows the code
//   GET  /api/feed?since=<iso>            → { events: Event[] }        chat timeline (newest last)
//   GET  /api/stream                      → WebSocket, pushes Event JSON as it happens
//   POST /api/messages {text, reply_to?, attachments?}  → owner message: answers D-/P-/L- ids, otherwise becomes a task for `lead`
//   POST /api/uploads (multipart file)    → { url }   (the owner's images for a message: image/*, ≤ 10 MB)
//   GET  /api/status                      → queue, decisions, hosts, accounts
//   POST /api/fleet/update               → every machine updates to the latest code; the primary redeploys the cloud
//   POST /api/media (multipart file)      → { url }   (workers upload screenshots/recordings here)
//   GET  /media/<file>                    → attachment
//   GET  /api/files/list?prefix=  · GET /api/files/read?path=   → read-only rules & memory (same shape as the Worker)
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ServerWebSocket } from "bun";
import { accountsInfo } from "./accounts";
import { type Cfg, DATA, P, allowedClis, hostName, list, loadConfig, onlineHosts, readDoc, UPDATE_REQUEST } from "./core";
import { ownerAttachments, sniffImage, uploadId, uploadProblem } from "../cloud/src/uploads";
import { readable, validPath } from "../cloud/src/files";
import { parseTaskBody, taskHistory, taskInfo } from "../cloud/src/tools";
import { localStore } from "./brain";
import { ensureWebClient } from "./webclient";

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
  const needs = state === "inbox" && m.parked && m.requires ? String(m.requires) : undefined;
  if (needs) state = "nohost";
  return { id: m.id, title: m.title, agent: m.agent, host: m.claimed_by, state, needs, waiting_on: m.waiting_on, wake_at: m.wake_at, started: m.started, created: m.created, cli: m.cli_used, model: m.model,
    finished: m.finished, updated: m.finished ?? m.started ?? m.created, attempt: m.attempt, decision: m.decision, request, runs, steps };
}

type TaskView = ReturnType<typeof taskView>;

const taskStore = () => localStore({ acts: {}, status: () => ({}), feed: () => [] });

/** Per host: what it runs now, what it finished lately, and (for this machine) its AI accounts. */
function hostViews(active: TaskView[], finished: TaskView[]) {
  let cfg: Cfg | null = null;
  try { cfg = loadConfig(); } catch {}
  const me = cfg ? hostName(cfg) : "";
  const ran = (t: TaskView, h: string) => t.host === h || t.runs.some((r) => r.host === h);
  return onlineHosts(cfg ?? {}).map((h) => ({
    ...h,
    os: h.caps.find((c) => c.startsWith("os:"))?.slice(3),
    arch: h.caps.find((c) => c.startsWith("arch:"))?.slice(5),
    clis: h.caps.filter((c) => c.startsWith("cli:")).map((c) => c.slice(4)),
    accounts: cfg && h.host === me ? (() => { try { return accountsInfo(cfg!); } catch { return undefined; } })() : undefined,
    running: active.filter((t) => t.host === h.host).map((t) => ({ id: t.id, title: t.title, agent: t.agent, started: t.started, activity: h.activity?.[t.id] })),
    recent: finished.filter((t) => ran(t, h.host)).slice(0, 8).map((t) => ({ id: t.id, title: t.title, state: t.state, finished: t.finished ?? t.updated })),
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
    /** The owner's latest "update every machine" (each host reports its progress on it in `hosts[].update`). */
    update: (() => { try { return { at: String(JSON.parse(readFileSync(UPDATE_REQUEST(), "utf8")).at ?? "") }; } catch { return undefined; } })(),
  };
}

// ---------------------------------------------------------------- settings (UI-adjustable, shared via data repo)
const SETTABLE = ["clis", "autonomy", "routines", "host", "idle", "judge", "resources", "notify_prefs", "commands", "media_days"]; // whitelisted top-level keys

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
  const head = existsSync(p) ? (readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("# ")) ?? "") : "";
  const m = head.match(/^#\s+(.+?)\s*(?:\(([^)]+)\))?\s*(?:\s[—–-]+\s+(.+))?$/);
  return { title: (m?.[2] ?? ROLE[agent]?.title ?? m?.[1])?.trim(), about: (m?.[3] ?? ROLE[agent]?.about)?.trim() };
}

/** What each built-in routine does, for the settings page (a routine's own `desc` in config.toml wins). */
const ROUTINE_DESC: Record<string, string> = {
  "triage-inbound": "Scans GitHub notifications, PRs waiting on you, issues assigned to you and CI failures, and splits them into tasks for the right members",
  "uptime-watch": "Checks uptime alerts and handles them by the escalation rules",
  "pr-review": "Reviews PRs in the Core repos that haven't been reviewed yet, up to 3 per run",
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
      agents: agents.map((a) => ({ id: a, ...agentRole(a), clis: allowedClis({ agent: a }, cfg), autonomy: cfg.autonomy?.agents?.[a] ?? cfg.autonomy?.level ?? "onboarding" })),
      autonomy: cfg.autonomy?.level ?? "onboarding",
      routines: (cfg.routine ?? []).map((r: any) => ({ name: r.name, desc: routineDesc(r), every: r.every, agent: r.agent, enabled: r.enabled !== false })),
      max_parallel: cfg.host?.max_parallel ?? null,
      media_days: mediaDays(cfg),
    },
    options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
  };
}

let settingsHook: ((summary: string) => Promise<void>) | null = null;
export const onSettingsSaved = (fn: (summary: string) => Promise<void>) => { settingsHook = fn; };

export async function saveSettings(patch: Record<string, unknown>) {
  const cur = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const deep = (a: any, b: any): any => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v;
    return o;
  };
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => SETTABLE.includes(k)));
  const next = deep(cur, clean);
  writeFileSync(P("settings.json"), JSON.stringify(next, null, 2) + "\n");
  await settingsHook?.(JSON.stringify(clean));
  return settingsView();
}

const ID = /^\s*([DLP]-[A-Z]?\d{4})\b[\s:：,，\-]*([\s\S]*)$/;

/** Owner said something (local chat or via the cloud inbox): answer an open D-/P-/L- item, or hand it to lead. */
let lastAnswer: { id: string; at: number } | null = null;
let cancelHook: ((tid: string, done?: boolean) => Promise<string>) | null = null;
export const setCancelTask = (fn: (tid: string, done?: boolean) => Promise<string>) => { cancelHook = fn; };
/** The owner cancels a task (queued, waiting, blocked, proposed or running). */
/** done: the owner finished it himself (merged by hand, …): it ends as done, not cancelled. */
export const cancelTask = async (tid: string, done = false) => (cancelHook ? cancelHook(tid, done) : "not available");
let opHook: ((op: any) => Promise<unknown>) | null = null;
export const setApplyOp = (fn: (op: any) => Promise<unknown>) => { opHook = fn; };
/** A write the cloud MCP server handed over (create/amend/cancel a task, remember, …): performed here, where the data lives. */
export const applyOp = async (op: any) => (opHook ? opHook(op) : null);
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
  if (att.paths?.length) {
    const files = await saveAttachments(att.key ?? crypto.randomUUID(), att.paths, att.fetch);
    text = withAttachments(text, files, att.paths.length - files.length);
  }
  const m = text.match(ID);
  const id = m?.[1] ?? (reply_to && /^[DLP]-[A-Z]?\d{4}$/.test(reply_to) ? reply_to : null);
  // a reply to an agent's message about a task (or a message on its page): it goes to that task, whatever came just before
  const replyTask = !id && reply_to && /^T-\d{4,}$/.test(reply_to) ? reply_to : undefined;
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
      if (url.pathname === "/api/settings" && req.method === "GET") return json(settingsView());
      if (url.pathname === "/api/settings" && req.method === "PUT") return json(await saveSettings((await req.json()) as Record<string, unknown>));
      if (url.pathname === "/api/tasks" && req.method === "GET") {
        return json(taskHistory(taskStore(), { query: url.searchParams.get("q") ?? "", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) }));
      }
      if (url.pathname === "/api/tasks/get" && req.method === "GET") {
        const t = taskInfo(taskStore(), url.searchParams.get("id") ?? "");
        if (!t) return json({ error: "not found" }, 404);
        const refs = new Set([t.id, ...t.decisions]);
        return json({ ...t, events: feed("", 2000).filter((e) => e.ref && refs.has(e.ref)) });
      }
      if (url.pathname === "/api/tasks/cancel" && req.method === "POST") {
        const { id, done } = (await req.json().catch(() => ({}))) as { id?: string; done?: boolean };
        if (!id || !/^T-[\w]*\d{4}$/.test(id)) return json({ error: "id required" }, 400);
        return json({ ok: true, result: await cancelTask(id, done === true) });
      }
      if (url.pathname === "/api/fleet/update" && req.method === "POST") return json({ ok: true, result: await updateFleet() });
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
        const { text = "", reply_to, attachments, thread: inThread } = (await req.json()) as { text?: string; reply_to?: string; attachments?: unknown; thread?: unknown };
        const files = ownerAttachments(attachments);
        if (files === null) return json({ error: "bad attachments" }, 400);
        if (files.some((p) => !existsSync(join(MEDIA, basename(p))))) return json({ error: "attachment not found" }, 400);
        if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
        const thread = inThread === true && /^T-/.test(reply_to ?? "");
        const ev = appendEvent({ from: "owner", kind: "owner", text, ref: reply_to, ...(files.length ? { attachments: files } : {}), ...(thread ? { thread } : {}) });
        await handleOwnerMessage(text, reply_to, false, { paths: files, key: ev.id, thread });
        return json(ev);
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
