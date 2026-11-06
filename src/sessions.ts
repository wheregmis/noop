// Learn the owner: extract the owner's own words from selected local AI conversation history
// (instructions, corrections, vetoes, trade-offs, taste) into a redacted digest that an agent distills
// into memory/taste.md + principles. Raw transcripts never leave this machine; only the distilled
// principles are synced to the shared data.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { providerAvailable } from "./providers";
import { Database } from "bun:sqlite";
import { DEFAULT_PROVIDERS } from "../cloud/src/providers";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Cfg, P, list, readDoc, HOME_DIR, allowedClis, accountCanRun } from "./core";
import { feed } from "./server";

/** Owner's interactions inside noop since `since`: chat instructions + decisions (incl. overrides of the judge). */
function hubInteractions(since: string): { text: string; count: number } {
  const out: string[] = [];
  for (const e of feed(since, 2000)) if (e.kind === "owner") out.push(`- [${e.ts.slice(0, 16)} hub-chat${e.ref ? " ↳" + e.ref : ""}] ${redact(e.text)}`);
  for (const p of list(P("decisions", "closed"))) {
    const m = readDoc(p).meta;
    if (!m.answered || m.answered < since || !/^owner/.test(m.answered_by ?? "")) continue;
    const shadow = m.shadow_verdict ? ` · judge would have: ${m.shadow_verdict} "${m.shadow_answer ?? ""}"` : "";
    const over = m.overridden_judge ? ` · OVERRODE judge's "${m.overridden_judge}"` : "";
    out.push(`- [${m.answered.slice(0, 16)} hub-decision ${m.id} · ${m.agent ?? m.kind}] Q: ${redact(m.question ?? "")} · options: ${redact(m.options ?? m.items ?? "")} · recommended: ${m.recommendation ?? "-"} → owner: **${redact(m.answer ?? "")}**${shadow}${over}`);
  }
  for (const p of list(P("tasks", "rejected"), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if ((m.created ?? "") >= since) out.push(`- [hub-rejected] owner declined proposed task: ${redact(m.title ?? "")} (${m.agent})`);
  }
  return { text: out.join("\n"), count: out.length };
}

export const LEARNING_DIR = join(HOME_DIR, "learn");
const STATE = join(LEARNING_DIR, "state.json"), OUT = LEARNING_DIR;
export class LearningBusyError extends Error { constructor() { super("Another learning operation is running on this machine. Try again after it finishes."); } }
export function learningDirectory() {
  mkdirSync(OUT, { recursive: true, mode: 0o700 });
  const stat = lstatSync(OUT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe learning storage");
  chmodSync(OUT, 0o700);
}
export function learningCheckpoint(): string | null {
  let stat; try { stat = lstatSync(STATE); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_000_000) throw new Error("Unsafe learning checkpoint");
  return readFileSync(STATE, "utf8");
}
export function commitLearningCheckpoint(before: string | null, after: string) {
  if (learningCheckpoint() !== before) throw new Error("The learning checkpoint changed");
  learningDirectory();
  const temporary = `${STATE}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, after, { mode: 0o600, flag: "wx" }); renameSync(temporary, STATE); }
  finally { rmSync(temporary, { force: true }); }
}
/** SQLite owns the cross-process lock; a crash releases it without unsafe stale-PID cleanup. */
export function collectionLocked<T>(work: () => T): T {
  learningDirectory();
  const path = join(OUT, "collection.sqlite");
  for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe learning lock"); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  const db = new Database(path, { create: true });
  try { chmodSync(path, 0o600); db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
  catch { db.close(); throw new LearningBusyError(); }
  try { return work(); } finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
}
function sourcePath(value: string): string {
  let path = resolve(value.replace(/^~/, homedir())); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(path), ...suffix); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      let present = false; try { lstatSync(path); present = true; } catch (entry: any) { if (entry.code !== "ENOENT") throw entry; }
      if (present || dirname(path) === path) throw error;
      suffix.unshift(basename(path)); path = dirname(path);
    }
  }
}
export function learningRoots(cfg: Cfg): { claude?: string; codex?: string; hermes?: string } {
  const selected: string[] = cfg.learn?.sources ?? [...DEFAULT_PROVIDERS, "noop"], roots = cfg.learn ?? {};
  const hermesHome = process.env.HERMES_HOME ?? (process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "hermes") : join(homedir(), ".hermes"));
  return { ...(selected.includes("claude") ? { claude: sourcePath(roots.claude_dir ?? join(homedir(), ".claude", "projects")) } : {}),
    ...(selected.includes("codex") ? { codex: sourcePath(roots.codex_dir ?? join(homedir(), ".codex", "sessions")) } : {}),
    ...(selected.includes("hermes") ? { hermes: sourcePath(roots.hermes_db ?? join(hermesHome, "state.db")) } : {}) };
}
export type PreparedCollection = { before: string | null; after: string; content: string | null; turns: number; sessions: number; truncated: boolean };

export class LearningSourceError extends Error {
  constructor() { super("Could not read selected Hermes history. Check history permissions on this machine, or deselect Hermes in Settings → AI tools & onboarding."); this.name = "LearningSourceError"; }
}

type Turn = { ts: string; project: string; tool: "claude" | "codex" | "hermes"; text: string; prev?: string };

// ---------------------------------------------------------------- redaction
const SECRET = [
  /\b(sk-(?:ant|proj|live|test)?-?[\w-]{16,})/g, /\b(gh[pousr]_[A-Za-z0-9]{20,})/g, /\b(xox[abpr]-[\w-]{10,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g, /\b(eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, /\b[0-9a-f]{32,}\b/gi,
];
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET) out = out.replace(re, (_m, g1) => (typeof g1 === "string" && /[:=]\s*$/.test(g1) ? `${g1}[REDACTED]` : "[REDACTED]"));
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}

// ---------------------------------------------------------------- filters
const FLEET_PROMPT = /^You are \*\*[^*]+\*\*, a permanent member|You are the owner's JUDGE|^\[SYSTEM NOTIFICATION/;
const INJECTED = /^(<environment_context>|<user_instructions>|# AGENTS\.md|<permissions instructions>|<local-command|<command-name>|<command-message>|<task-notification>|<bash-|<agent-message|Caveat:|\[Request interrupted|This session is being continued)/;

function clean(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted]")
    .replace(/```[\s\S]{600,}?```/g, "[long code block]")
    .trim();
}

function ownerText(raw: string): string | null {
  if (!raw || FLEET_PROMPT.test(raw) || INJECTED.test(raw.trim())) return null;
  const t = clean(raw);
  if (t.length < 4 || /^\[pasted\]$/.test(t) || /^\[Image #\d+\]$/.test(t)) return null;
  return t.length > 1500 ? t.slice(0, 1500) + " …" : t;
}

// ---------------------------------------------------------------- readers
function readClaude(file: string, project: string): Turn[] {
  const out: Turn[] = [];
  let lastAssistant = "";
  let fleet = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let l: any; try { l = JSON.parse(line); } catch { continue; }
    if (l.type === "assistant") {
      const c = l.message?.content;
      const txt = Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ") : String(c ?? "");
      if (txt) lastAssistant = txt;
      continue;
    }
    if (l.type !== "user" || l.isMeta || l.isSidechain) continue;
    const c = l.message?.content;
    const raw = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n") : "";
    if (FLEET_PROMPT.test(raw)) { fleet = true; break; } // whole session is a fleet agent run
    const t = ownerText(raw);
    if (t) out.push({ ts: l.timestamp ?? "", project, tool: "claude", text: t, prev: lastAssistant.slice(-400) });
  }
  return fleet ? [] : out;
}

function readCodex(file: string): Turn[] {
  const out: Turn[] = [];
  let project = "codex", lastAssistant = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let l: any; try { l = JSON.parse(line); } catch { continue; }
    const p = l.payload ?? {};
    if (l.type === "session_meta" && p.cwd) project = basename(p.cwd);
    if (l.type === "turn_context" && p.cwd) project = basename(p.cwd);
    if (l.type !== "response_item" || p.type !== "message") continue;
    const txt = (p.content ?? []).map((x: any) => x.text ?? "").join("\n");
    if (p.role === "assistant") { lastAssistant = txt; continue; }
    if (p.role !== "user") continue;
    if (FLEET_PROMPT.test(txt)) return [];
    const t = ownerText(txt);
    if (t) out.push({ ts: l.timestamp ?? "", project, tool: "codex", text: t, prev: lastAssistant.slice(-400) });
  }
  return out;
}

/** Read only owner-facing Hermes sessions; the source DB is never migrated or written. */
function readHermes(file: string, state: Record<string, any>): { turns: Turn[]; sessions: number } {
  if (!existsSync(file)) return { turns: [], sessions: 0 };
  const db = new Database(file, { readonly: true, create: false });
  try {
    db.exec("BEGIN DEFERRED");
    const messageColumns = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((row) => row.name));
    const sessionColumns = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((row) => row.name));
    const active = messageColumns.has("active") ? " AND active = 1" : "";
    const observed = messageColumns.has("observed") ? " AND COALESCE(observed, 0) = 0" : "";
    // shortcut: summarize the latest 200 sessions and 1,000 messages per session; add paged backfill for larger archives.
    const rows = db.query(`SELECT s.id, ${sessionColumns.has("cwd") ? "s.cwd" : "NULL"} AS cwd, MAX(m.id) AS last_id
      FROM sessions s JOIN messages m ON m.session_id = s.id WHERE s.source IN ('cli', 'desktop')
      GROUP BY s.id HAVING MAX(CASE WHEN m.timestamp > 100000000000 THEN m.timestamp / 1000 ELSE m.timestamp END) < ? ORDER BY last_id DESC LIMIT 200`).all((Date.now() - 600_000) / 1000) as { id: string; cwd?: string; last_id: number }[];
    const turns: Turn[] = [], seen: Record<string, boolean> = state.__hermes_seen ?? {};
    let sessions = 0;
    for (const session of rows) {
      const key = `hermes:${file}:${session.id}`, previous = Number(state[key] ?? 0);
      if (previous >= session.last_id) continue;
      const first = db.query("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(session.id) as { content?: string } | null;
      if (FLEET_PROMPT.test(first?.content ?? "")) { state[key] = session.last_id; continue; }
      const messages = db.query(`SELECT id, role, content, timestamp FROM messages WHERE session_id = ?${active}${observed} ORDER BY id DESC LIMIT 1000`).all(session.id) as { id: number; role: string; content?: string; timestamp: number }[];
      let lastAssistant = "", count = 0;
      for (const message of messages.reverse()) {
        if (message.role === "assistant") { lastAssistant = message.content ?? ""; continue; }
        if (message.role !== "user" || message.id <= previous) continue;
        const text = ownerText(message.content ?? "");
        if (!text) continue;
        const fingerprint = new Bun.CryptoHasher("sha256").update(`${message.timestamp}\0${text}`).digest("hex");
        if (seen[fingerprint]) continue;
        seen[fingerprint] = true;
        const stamp = Number(message.timestamp);
        turns.push({ tool: "hermes", ts: new Date(stamp > 100000000000 ? stamp : stamp * 1000).toISOString(), project: session.cwd ? basename(session.cwd) : "hermes", text, prev: lastAssistant.slice(-400) });
        count++;
      }
      if (count) sessions++;
      state[key] = session.last_id;
    }
    state.__hermes_seen = Object.fromEntries(Object.entries(seen).slice(-20_000));
    return { turns, sessions };
  } finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
}

function walk(dir: string, re: RegExp, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, re, acc); else if (re.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Do not consume local history until a learning task can use it on this machine. */
export function learningBlockReason(cfg: Cfg, available: (cli: string) => boolean = (cli) => providerAvailable(cli) && accountCanRun(cli, cfg)): string | null {
  if (cfg.learn?.enabled === false) return "Learning is turned off in Settings → AI tools & onboarding.";
  if (Array.isArray(cfg.learn?.sources) && !cfg.learn.sources.length) return "Select a history source in Settings → AI tools & onboarding.";
  if (cfg.host?.enabled === false) return "This machine is paused. Resume it in Machines before learning from its history.";
  if (!existsSync(P("agents", "apprentice", "profile.md"))) return "Learning needs an apprentice member. Add one in Settings → Members.";
  const tools = allowedClis({ agent: "apprentice" }, cfg);
  if (!tools.length) return "Learning is paused. Enable an AI tool and select one for the apprentice member in Settings.";
  if (!tools.some(available)) return "No selected apprentice AI tool/account is available on this machine. Check its AI account settings in Machines and Settings → AI tools & onboarding.";
  return null;
}

/** Incrementally collect owner turns since the last run; writes a redacted digest file and returns its path. */
export function prepareCollection(cfg: Cfg, opts: { full?: boolean; maxChars?: number } = {}): PreparedCollection {
  const before = learningCheckpoint();
  const empty = { before, after: before ?? "{}", content: null, turns: 0, sessions: 0, truncated: false };
  if (cfg.learn?.enabled === false) return empty;
  const selected: string[] = cfg.learn?.sources ?? [...DEFAULT_PROVIDERS, "noop"];
  if (!selected.length) return empty;
  const state: Record<string, any> = !opts.full && before ? JSON.parse(before) : {};
  const roots = learningRoots(cfg), claudeDir = roots.claude!, codexDir = roots.codex!;
  const files = [...(selected.includes("claude") ? walk(claudeDir, /\.jsonl$/).map((f) => ["claude", f] as const) : []), ...(selected.includes("codex") ? walk(codexDir, /\.jsonl$/).map((f) => ["codex", f] as const) : [])];
  const turns: Turn[] = [];
  let sessions = 0;
  for (const [tool, f] of files) {
    const m = statSync(f).mtimeMs;
    if (typeof state[f] === "number" && state[f] >= m) continue;
    if (Date.now() - m < 10 * 60_000) continue; // skip live sessions
    const project = tool === "claude" ? basename(join(f, "..")).replace(/^-(home|Users)-[^-]+-/, "").replace(/^work-/, "").replace(/--claude-worktrees-.*$/, "") : "";
    const t = tool === "claude" ? readClaude(f, project) : readCodex(f);
    state[f] = m;
    if (t.length) { sessions++; turns.push(...t); }
  }
  if (selected.includes("hermes")) {
    const file = roots.hermes!;
    try {
      const pending = { ...state, __hermes_seen: { ...state.__hermes_seen } };
      const history = readHermes(file, pending); Object.assign(state, pending);
      turns.push(...history.turns); sessions += history.sessions;
    }
    catch (error) { console.warn(`Hermes learning source could not be read: ${error}`); throw new LearningSourceError(); }
  }
  const hubSince = opts.full ? "" : (state.__hub_since as unknown as string) ?? "";
  const hub = selected.includes("noop") ? hubInteractions(hubSince) : { text: "", count: 0 };
  if (selected.includes("noop")) (state as any).__hub_since = new Date().toISOString();
  const after = JSON.stringify(state);
  if (!turns.length && !hub.text) return { ...empty, after, sessions };
  turns.sort((a, b) => a.ts.localeCompare(b.ts));
  const requestedMax = opts.maxChars ?? cfg.learn?.max_digest_chars ?? 400_000;
  const max = Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : 400_000;
  const byProject = new Map<string, Turn[]>();
  for (const t of turns) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
  let body = "";
  for (const [proj, ts] of byProject) {
    body += `\n\n## ${proj}\n`;
    for (const t of ts) {
      const ctx = t.prev ? `  ↳ (after AI said: ${redact(t.prev).replace(/\s+/g, " ").slice(0, 220)})\n` : "";
      body += `\n- [${t.ts.slice(0, 16)} ${t.tool}] ${redact(t.text).replace(/\n/g, "\n  ")}\n${ctx}`;
    }
  }
  const hubPart = hub.text ? `\n\n## Noop (decisions & chat — how the owner judges the fleet's questions)\n${hub.text}\n` : "";
  const heading = `# Owner's own words from ${sessions} sessions (${turns.length + hub.count} turns, redacted)\n`;
  const content = redact(`${hubPart}${body}\n`), room = Math.max(0, max - heading.length);
  const omitted = "\n[Earlier digest content omitted to fit the configured limit.]\n";
  // shortcut: retain the combined digest's tail and advance all watermarks; page digests if every turn must be learned.
  const excerpt = content.length <= room ? content : room > omitted.length ? omitted + content.slice(-(room - omitted.length)) : omitted.slice(0, room);
  return { before, after, content: heading.slice(0, max) + excerpt, turns: turns.length + hub.count, sessions, truncated: content.length > room };
}

/** Compatibility collector; daemon, CLI and UI queue through the durable learning operation. */
export function collect(cfg: Cfg, opts: { full?: boolean; maxChars?: number; dry?: boolean; beforeCommit?: (digest: { file: string; turns: number; sessions: number }) => void } = {}): { file: string | null; turns: number; sessions: number } {
  if (cfg.learn?.enabled === false || Array.isArray(cfg.learn?.sources) && !cfg.learn.sources.length) return { file: null, turns: 0, sessions: 0 };
  return collectionLocked(() => {
    const prepared = prepareCollection(cfg, opts);
    const file = prepared.content === null ? null : join(OUT, `digest-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.md`);
    if (file) writeFileSync(file, prepared.content!, { mode: 0o600, flag: "wx" });
    const result = { file, turns: prepared.turns, sessions: prepared.sessions };
    if (!opts.dry) {
      if (file) opts.beforeCommit?.({ ...result, file });
      commitLearningCheckpoint(prepared.before, prepared.after);
    }
    return result;
  });
}

export const LEARN_PROMPT = (digest: string) => `Learn the owner. Read the redacted digest named:
${basename(digest)}
Resolve it under the machine-local Noop home's learn folder: $NOOP_HOME/learn when NOOP_HOME is set, otherwise ~/.noop/learn (or the existing legacy ~/.agent-hub/learn).
(local to this machine; never copy raw text or the file into the hub repo, never quote anything that looks like a secret or a private person's data).

Distill durable, actionable knowledge — how the owner works, judges and decides — and update the hub's memory:
1. memory/taste.md — the owner's taste as concrete rules with an example each: UI/UX/visual ("too slow, not delightful"), code
   ("delete this path", naming, API shape), product calls, quality bar, what they reject and why, phrases they use when unhappy.
2. memory/principles.md — decision principles (what they approve/decline, trade-offs they repeatedly pick, risk appetite, when they
   want to be asked vs. not). Each entry: the rule, evidence count, latest date, source "session:<project>/<date>".
3. memory/focus.md — only if the digest clearly shows a shift in what they work on now (dated).
4. memory/projects.md / memory/release-cadence.md / memory/owner.md — correct facts (repos, cadences, tools, people roles) the digest reveals.
5. agents/<id>/memory.md — role-specific lessons (e.g. reviewer: what the owner checks in PRs; maintainer: build/test habits).

6. From the Noop section: for each agent/decision category, how often did the owner pick the recommendation, override the
   judge, or reject proposals? Record per-category rules in memory/principles.md so the judge can decide them next time, and note in
   your summary which agents look ready for more autonomy (the architect proposes graduation; you never change config).

Rules: merge with existing entries (strengthen counts/dates) instead of appending duplicates; keep each file < 200 lines; date everything;
prefer patterns seen ≥ 2 times; mark single-observation items "(weak)". Owner's corrections of AI ("wrong", "don't", "revert", "too slow") are the
most valuable signal — capture what was wrong and what they wanted instead. Summary: top 5 new or strengthened insights.`;
