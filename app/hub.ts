import { deviceTimeZone } from "./notify";
import { providerLabel, type ProviderStatus, type ToolPolicy, type ToolPolicyView } from "../cloud/src/providers";
import { validAutonomyLevel, type AutonomyLevel, type AutonomyPolicy } from "../cloud/src/configuration";
import { readLearningRunResult, readLearningDiscardResult, type LearningPreview, type LearningRunRequest } from "../cloud/src/learning";
import type { PendingStops, StopOwner, StopReviewAudit } from "../cloud/src/stop-intents";
// noop: the server's shapes and the pure logic of the timeline (no UI, no I/O), shared by App.tsx and the tests.

export type Kind = "notice" | "decision" | "menu" | "proposals" | "login" | "owner" | "system";

export type HubEvent = {
  id: string;
  ts: string;
  from: string;
  kind: Kind;
  text: string;
  ref?: string;
  priority?: string;
  /** Said inside a task's own conversation: on the task page, not in the main channel. */
  thread?: boolean;
  options?: string[];
  attachments?: string[];
};

export type HostInfo = {
  host: string; providers?: ProviderStatus[];
  caps: string[];
  online?: boolean; enabled?: boolean; max_parallel?: number | null; custom_caps?: string[];
  seen?: string;
  busy?: number;
  stats?: { loadRatio?: number; load1?: number; cores?: number; memFreePct?: number; diskFreeGB?: number; diskFreePct?: number; diskPath?: string; diskError?: string; [k: string]: unknown };
  os?: string;
  arch?: string;
  clis?: string[];
  accounts?: { cli: string; name: string; state: "unknown" | "ok" | "cooldown" | "login"; until?: string }[];
  running?: { id: string; title: string; agent: string; run_id?: string; started?: string; activity?: Activity }[];
  recent?: { id: string; title: string; state?: string; finished?: string }[];
  /** The code the machine runs: its git commit, and that commit on GitHub. */
  rev?: string;
  rev_url?: string;
  /** Its progress on the owner's latest "update every machine". */
  update?: { at: string; ts: string; state: string; detail?: string; from?: string };
};

/** A running agent's latest sign of life, and (Claude) the step it took. */
export type Activity = { at: string; step?: string; steps?: number };

/** "Recent: Bash · gh pr checks 814 · 2 minutes ago"; quiet for 10+ minutes reads as such (the fleet stops it at 20 and runs it again). */
export function activityLine(a: Activity | undefined, now = Date.now()): { text: string; quiet: boolean } | null {
  if (!a?.at) return null;
  const min = Math.max(0, Math.floor((now - Date.parse(a.at)) / 60_000));
  const when = min < 1 ? "just now" : `${plural(min, "minute")} ago`;
  if (min >= 10) return { text: `No activity for ${plural(min, "minute")}${a.step ? `; last step: ${a.step}` : ""}. After 20 silent minutes it is stopped and resumed automatically`, quiet: true };
  return { text: a.step ? `Recent: ${a.step} · ${when}` : `Recent output · ${when}`, quiet: false };
}

export type TaskInfo = {
  id: string; title: string; agent: string; host?: string; run_id?: string; state?: string; stops?: PendingStops; stops_error?: string; stop_owner?: StopOwner; stop_reviews?: StopReviewAudit[];
  learning_host?: string; learning_host_error?: string;
  /** state "nohost": what the task needs that no online machine has ("os:windows"). */
  needs?: string;
  requires?: string; target_host?: string; configured_cli?: string; priority?: string; prefer?: string; weight?: string; project?: string; repo?: string;
  started?: string; created?: string; finished?: string; updated?: string; attempt?: string; decision?: string; cli?: string; model?: string;
  request?: string;
  /** state "active": its agent's latest sign of life. */
  activity?: Activity;
  runs?: { ts: string; host: string; cli: string; status: string; summary: string }[];
  steps?: { day?: string; time?: string; host?: string; kind?: string; text: string }[];
};

export type PlanStepInfo = { id: string; title: string; details: string; agent: string; checkpoint: boolean; status: "pending" | "running" | "done" | "stopped" | "skipped"; task?: string; result?: string };
export type PlanInfo = { id: string; goal: string; project?: string; agent: string; status: "drafting" | "review" | "running" | "paused" | "done" | "cancelled"; branch: string; notes: string[]; steps: PlanStepInfo[]; reason?: string; pending_stops?: PendingStops; stop_reviews?: StopReviewAudit[] };
export type PlanSummary = { id: string; goal: string; status: PlanInfo["status"]; project?: string; reason?: string; done: number; total: number };
/** What a plan's status says to the owner. */
export const PLAN_STATUS: Record<PlanInfo["status"], string> = { drafting: "Drafting", review: "Needs your review", running: "Running", paused: "Paused", done: "Done", cancelled: "Cancelled" };
export type Status = {
  plans?: PlanSummary[]; // absent from a hub that doesn't have them yet
  tasks: Record<"proposed" | "inbox" | "active" | "blocked" | "failed" | "done", number>;
  active: TaskInfo[];
  recent?: TaskInfo[];
  decisions: { id: string; kind: string; question?: string; held: boolean }[];
  hosts: HostInfo[];
  offline_hosts?: HostInfo[];
  /** The owner's latest "update every machine" request. */
  update?: { at: string };
};

/** An item id the owner answers: decisions, proposals (lists to approve) and logins. */
export const ITEM_ID = /^(?:[DP]-[A-Z]?\d{4}|L-\d{4,})$/;
const LEADING_ID = /^\s*((?:[DP]-[A-Z]?\d{4}|L-\d{4,}))\b/;

/** Events that ask the owner something, shown as a card with buttons. */
export function isAsk(e: HubEvent): boolean {
  return !!e.ref && ITEM_ID.test(e.ref) && ["decision", "menu", "proposals", "login"].includes(e.kind);
}

/** The one-tap answers of an ask: numbers (and all / none) for menus and proposals, letters for decisions. */
export function choicesOf(e: HubEvent): string[] {
  const o = e.options ?? [];
  if (e.kind === "menu" || e.kind === "proposals") {
    const nums = o.map((x) => (x.match(/^\s*(\d+|all|none)\b/i) ?? [])[1]).filter((x): x is string => !!x);
    const rank = (x: string) => (/^\d+$/.test(x) ? 0 : x.toLowerCase() === "all" ? 1 : 2);
    return [...new Set(nums.map((x) => (/^\d+$/.test(x) ? x : x.toLowerCase())))].sort((a, b) => rank(a) - rank(b));
  }
  return [...new Set(o.map((x) => (x.match(/^\s*([A-Z])\s*[:：.]/) ?? [])[1]).filter((x): x is string => !!x))];
}

/** The option the team recommends ("Recommendation: B" in the text), if any. */
export function recommended(e: HubEvent): string | null {
  const m = (e.text ?? "").match(/Recommendation:\s*\*?([^*\s]+)/);
  return m ? m[1].split(/[,，]/)[0] : null;
}

export const choiceLabel = (c: string) => (c === "all" ? "All" : c === "none" ? "None" : c);

/** The ids the owner has already answered, from the owner's own messages. */
export function answeredIds(events: HubEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (e.kind !== "owner") continue;
    if (e.ref) done.add(e.ref);
    const m = e.text.match(LEADING_ID);
    if (m) done.add(m[1]);
  }
  return done;
}

export const TAGS: Partial<Record<Kind, string>> = { decision: "Decision", menu: "Next step", proposals: "To approve", login: "Sign-in" };

export const isHub = (from: string) => /^hub/.test(from);
export const displayName = (from: string) => from.replace(/@.*/, "");
export const initials = (from: string) => (from || "?").replace(/@.*/, "").slice(0, 2).toUpperCase();
export const isVideo = (url: string) => /\.(mp4|webm|mov)(\?|$)/i.test(url);

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dayLabel(key: string, now = new Date()): string {
  if (key === dayKey(now.toISOString())) return "Today";
  const y = new Date(now.getTime() - 86400000);
  if (key === dayKey(y.toISOString())) return "Yesterday";
  const [yy, mm, dd] = key.split("-").map(Number);
  return yy === now.getFullYear() ? `${MONTHS[mm - 1]} ${dd}` : `${MONTHS[mm - 1]} ${dd}, ${yy}`;
}

/** The timeline's rows: the events with a separator before each new day. */
export type Row = { key: string; day: string } | { key: string; event: HubEvent };
export function rows(events: HubEvent[]): Row[] {
  const out: Row[] = [];
  let last = "";
  for (const e of events) {
    const d = dayKey(e.ts);
    if (d !== last) out.push({ key: `day:${d}`, day: d });
    last = d;
    out.push({ key: e.id, event: e });
  }
  return out;
}

/** Merge newly fetched or pushed events into the timeline: no duplicates, ordered by time. */
export function merge(events: HubEvent[], incoming: HubEvent[]): HubEvent[] {
  if (!incoming.length) return events;
  const seen = new Set(events.map((e) => e.id));
  const add = incoming.filter((e) => !seen.has(e.id));
  if (!add.length) return events;
  const all = [...events, ...add];
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}

/** Decisions waiting for the owner (held decisions and proposals). */
export const waiting = (s: Status | null) => (s?.decisions ?? []).filter((d) => d.held || d.kind === "proposals");

export const osOf = (h: HostInfo) => (h.caps.find((c) => c.startsWith("os:")) ?? "").slice(3);
export const loadOf = (h: HostInfo) => Math.max(0, Math.min(100, Math.round((h.stats?.loadRatio ?? 0) * 100)));

export function greeting(hour = new Date().getHours()): string {
  return hour < 6 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** "http://x:8787/" → "http://x:8787"; adds http:// when no scheme is given. */
export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

export const wsUrl = (base: string, token: string) =>
  `${base.replace(/^http/i, "ws")}/api/stream?token=${encodeURIComponent(token)}`;

export const mediaUrl = (base: string, token: string, path: string) =>
  /^(blob|data):/i.test(path)
    ? path // a local preview of an image not sent yet
    : `${/^https?:/i.test(path) ? path : base + path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

// ---------------------------------------------------------------- attachments (images the owner sends with a message)

/** An image waiting in the composer (or in a held message): its bytes and a local URL that shows it. */
export type Attachment = { id: string; name: string; type: string; size: number; file: Blob; preview: string };

export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_COUNT = 10;
const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
};

/** The image type of a file, from its media type or else its name's extension; null when it is not an image (SVG is not taken). */
export function imageType(type: string | undefined, name: string): string | null {
  if (type && /^image\/[\w.+-]+$/i.test(type) && !/svg/i.test(type)) return type.toLowerCase();
  return IMAGE_EXT[(name.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase()] ?? null;
}

/** Why a file cannot be attached ("" when it can). */
export function attachProblem(type: string | null, size: number, count: number): string {
  if (!type) return "Only images can be sent";
  if (size > ATTACH_MAX_BYTES) return "Images can't exceed 10 MB";
  if (count >= ATTACH_MAX_COUNT) return `You can send at most ${ATTACH_MAX_COUNT} images at a time`;
  return "";
}

/** A `file:` URL as a local path ("file:///Users/a/My%20Shot.png" → "/Users/a/My Shot.png"; Windows drive paths too). */
export function filePath(uri: string): string {
  const p = decodeURIComponent(uri.replace(/^file:\/\/[^/]*/i, ""));
  return /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p;
}

// ---------------------------------------------------------------- team settings (GET / PUT /api/settings)

export type Autonomy = "onboarding" | "assisted" | "autonomous" | (string & {});
export type Project = { id: string; name: string; path: string; host: string; repo: string; instructions: string; exists: boolean | null; requires?: string[]; custom_repo?: string | null; custom_requires?: string[]; detected_repo?: string; detected_requires?: string[]; checked?: string };
export type SettingsView = {
  current: Record<string, unknown>;
  effective: {
    primary_host?: string;
    enabled_clis?: string[];
    agents: { id: string; title?: string; about?: string; clis: string[]; paused?: boolean; tool_policy?: ToolPolicy; autonomy: Autonomy; autonomy_inherited?: boolean; autonomy_policy?: AutonomyPolicy }[];
    tool_policy?: ToolPolicyView;
    autonomy_policy_version?: number;
    projects?: Project[]; // absent from a hub that doesn't have them yet
    autonomy: Autonomy;
    routines: { name: string; desc?: string; every: string; agent: string; enabled: boolean; readonly?: boolean; project?: string; kind?: string }[];
    max_parallel: number | null;
    media_days?: number;
  };
  options: { clis: string[][]; autonomy: string[] };
};

/** A cloud hub has no settings snapshot until its main machine connects. */
export function settingsSnapshot(value: unknown): value is SettingsView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<SettingsView>, e = v.effective, o = v.options;
  return !!v.current && typeof v.current === "object" && !Array.isArray(v.current) && !!e && !!o
    && Array.isArray(e.agents) && e.agents.every((agent) => !!agent && typeof agent.id === "string" && Array.isArray(agent.clis) && agent.clis.every((id) => typeof id === "string"))
    && Array.isArray(e.routines) && e.routines.every((routine) => !!routine && typeof routine.name === "string")
    && Array.isArray(o.clis) && o.clis.every((order) => Array.isArray(order) && order.every((id) => typeof id === "string")) && Array.isArray(o.autonomy);
}

const CLI_LABELS: Record<string, string> = {
  claude: "Claude only",
  "codex,claude": "Codex → Claude",
  "claude,codex": "Claude → Codex",
  codex: "Codex only",
};
export const cliKey = (clis: string[]) => clis.join(",");
export const cliLabel = (clis: string[]) => !clis.length ? "Paused" : Object.prototype.hasOwnProperty.call(CLI_LABELS, cliKey(clis)) ? CLI_LABELS[cliKey(clis)]! : clis.map(providerLabel).join(" → ");
export function readToolPolicy(value: unknown): ToolPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const order = (x: unknown): x is string[] => Array.isArray(x) && x.length <= 64 && x.every((id) => typeof id === "string" && id.length > 0 && id.length <= 80 && !/[\p{Cc}\p{Cs}]/u.test(id));
  if (!(v.configured === null || order(v.configured)) || !order(v.effective) || !(v.file_default === null || order(v.file_default))
    || typeof v.source !== "string" || !["ui", "local_file", "shared_file", "default"].includes(v.source) || typeof v.file_source !== "string" || !["local_file", "shared_file", "default"].includes(v.file_source)
    || v.invalid !== undefined && typeof v.invalid !== "boolean" || v.file_invalid !== undefined && typeof v.file_invalid !== "boolean") return null;
  return v as unknown as ToolPolicy;
}
export function readToolPolicyView(value: unknown): ToolPolicyView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { version?: unknown; team?: unknown }, team = readToolPolicy(v.team);
  return v.version === 1 && team ? { version: 1, team } : null;
}
export function readAutonomyPolicy(value: unknown): AutonomyPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(v.configured === null || validAutonomyLevel(v.configured)) || !validAutonomyLevel(v.effective) || !(v.file_default === null || validAutonomyLevel(v.file_default))
    || typeof v.source !== "string" || !["ui", "local_file", "shared_file", "default"].includes(v.source) || typeof v.file_source !== "string" || !["local_file", "shared_file", "default"].includes(v.file_source)
    || v.invalid !== undefined && typeof v.invalid !== "boolean" || v.file_invalid !== undefined && typeof v.file_invalid !== "boolean"
    || v.invalid === true && (v.configured !== "onboarding" || v.effective !== "onboarding") || v.file_invalid === true && v.file_default !== "onboarding"
    || v.configured !== null && v.effective !== v.configured) return null;
  return v as unknown as AutonomyPolicy;
}
/** A learning receipt must describe the exact machine, authorization, reviewed counts and any earlier task identity. */
export function learningReceipt(value: unknown, host: string, request: LearningRunRequest, preview: LearningPreview, knownId?: string) {
  const result = readLearningRunResult(value);
  return result && result.host === host && result.request_id === request.request_id && result.preview_digest === request.preview_digest
    && preview.host === host && preview.preview_digest === request.preview_digest && result.turns === preview.turns && result.sessions === preview.sessions && result.truncated === preview.truncated
    && (!knownId || result.id === knownId) && (result.id === null || result.id.length <= 80) ? result : undefined;
}
export function learningRelease(value: unknown, host: string, request: LearningRunRequest, knownId?: string) {
  const result = readLearningDiscardResult(value);
  return result && result.host === host && result.request_id === request.request_id && result.preview_digest === request.preview_digest
    && (!knownId || result.id === knownId) && (result.id === null || result.id.length <= 80) ? result : undefined;
}
export function learningTaskId(value: Record<string, unknown>, host: string, request: LearningRunRequest, knownId?: string) {
  return value.host === host && value.request_id === request.request_id && value.preview_digest === request.preview_digest
    && typeof value.id === "string" && value.id.length <= 80 && /^T-[\w-]*\d{4}$/.test(value.id) && (!knownId || value.id === knownId) ? value.id : undefined;
}
const AUTONOMY_LABELS: Record<string, string> = { onboarding: "Learning", assisted: "Assisted", autonomous: "Autonomous" };
export const autonomyLabel = (a: string) => Object.prototype.hasOwnProperty.call(AUTONOMY_LABELS, a) ? AUTONOMY_LABELS[a]! : a;
export const INTERVALS = ["15m", "30m", "1h", "2h", "6h", "1d"];
const DAYS: Record<string, string> = { MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday" };
/** A routine's schedule in words: "30m" → Every 30 minutes, "weekly FRI 17:00" → Every Friday 17:00. */
export function everyLabel(every: string): string {
  const e = every.trim();
  let m = e.match(/^(\d+)\s*([mhd])$/);
  if (m) return m[1] === "1" ? { m: "Every minute", h: "Every hour", d: "Every day" }[m[2]]! : `Every ${m[1]} ${{ m: "minutes", h: "hours", d: "days" }[m[2]]}`;
  if (e === "hourly") return "Every hour";
  if ((m = e.match(/^daily\s+(\d\d?:\d\d)$/))) return `Every day ${m[1]}`;
  if ((m = e.match(/^weekdays\s+(\d\d?:\d\d)$/))) return `Weekdays ${m[1]}`;
  if ((m = e.match(/^weekly\s+(\w{3})\s+(\d\d?:\d\d)$/i)) && DAYS[m[1].toUpperCase()]) return `Every ${DAYS[m[1].toUpperCase()]} ${m[2]}`;
  return e;
}
export const intervalsWith = (every: string) => (INTERVALS.includes(every) ? INTERVALS : [...INTERVALS, every]);

/** The PUT bodies the settings screen sends (whitelisted keys of the hub). */
/** How long images are kept, in days: the choices and the one in force (7 by default). */
export const MEDIA_DAYS = [7, 14, 30, 90];
export const mediaDaysOf = (v: SettingsView | null | undefined): number => {
  const d = Number(v?.current?.media_days ?? v?.effective?.media_days);
  return MEDIA_DAYS.includes(d) ? d : 7;
};

export const patches = {
  clis: (agent: string, clis: string[]) => ({ clis: { agents: { [agent]: clis } } }),
  toolOrder: (agent: string | undefined, order: string[] | null) => ({ tool_policy_version: 1, clis: agent ? { agents: { [agent]: order } } : { preference: order } }),
  toolReset: (agent?: string) => ({ tool_policy_version: 1, clis: { reset: [agent ? `agents.${agent}` : "preference"] } }),
  autonomyPolicy: (agent: string, level: AutonomyLevel | null) => ({ autonomy_policy_version: 1, autonomy: { agents: { [agent]: level } } }),
  autonomyReset: (agent: string) => ({ autonomy_policy_version: 1, autonomy: { reset: [`agents.${agent}`] } }),
  autonomy: (agent: string, level: string | null) => ({ autonomy: { agents: { [agent]: level } } }),
  routine: (name: string, change: { enabled?: boolean; every?: string }) => ({ routines: { [name]: change } }),
  maxParallel: (n: number) => ({ host: { max_parallel: n } }),
  mediaDays: (days: number) => ({ media_days: days }),
  /** The whole list: an array replaces the saved one. */
  commands: (list: Command[]) => ({ commands: list }),
};

// ---------------------------------------------------------------- commands (typed after "/" in the composer)

/** A command the owner saved: its name, and what it sends to the team. */
export type Command = { name: string; text: string };
/** What a command does: a built-in action of the app, or the owner's saved message. */
export type CommandItem = { id: string; name: string; detail: string; action?: "update-fleet"; text?: string };

export const BUILTIN_COMMANDS: CommandItem[] = [
  { id: "builtin:update-fleet", name: "update", detail: "Every machine pulls the latest code and restarts", action: "update-fleet" },
];

/** The owner's saved commands, as settings hold them (anything malformed is left out). */
export function savedCommands(view: SettingsView | null): Command[] {
  const list = (view?.current as { commands?: unknown } | undefined)?.commands;
  return Array.isArray(list) ? list.filter((c): c is Command => !!c && typeof c.name === "string" && typeof c.text === "string" && !!c.name.trim()) : [];
}

/** Built-ins first, then the saved ones; filtered by what follows the "/" (name or text contains it). */
export function commandItems(view: SettingsView | null, query = ""): CommandItem[] {
  const all = [...BUILTIN_COMMANDS, ...savedCommands(view).map((c, i) => ({ id: `saved:${i}`, name: c.name, detail: c.text, text: c.text }))];
  const q = query.trim().toLowerCase();
  return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q)) : all;
}

/** The query of a draft that is a command being typed ("/update" → "update"), else null. */
export function slashQuery(draft: string): string | null {
  const m = draft.match(/^\/([^\n]*)$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- notifications (PUT /api/settings notify_prefs; the rules are in notify.ts)

export const NOTIFY_KINDS = [
  ["decision", "Decisions"],
  ["menu", "Menus"],
  ["proposals", "Proposals"],
  ["login", "Sign-ins"],
  ["result", "Results"],
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number][0];
export type QuietHours = { start: string; end: string } | null;
export type NotifyPrefs = { kinds: Record<NotifyKind, boolean>; quiet_hours: QuietHours; tz: string };

export const QUIET_PRESETS: { label: string; value: QuietHours }[] = [
  { label: "Off", value: null },
  { label: "22:00–08:00", value: { start: "22:00", end: "08:00" } },
  { label: "23:00–07:00", value: { start: "23:00", end: "07:00" } },
  { label: "00:00–09:00", value: { start: "00:00", end: "09:00" } },
];
export const quietKey = (q: QuietHours) => (q ? `${q.start}-${q.end}` : "off");

/** The saved preferences (every kind on and no quiet hours until the owner changes them). */
export function notifyPrefsOf(view: SettingsView | null, tz = deviceTimeZone()): NotifyPrefs {
  const saved = (view?.current?.notify_prefs ?? {}) as Partial<Omit<NotifyPrefs, "quiet_hours">> & { quiet_hours?: QuietHours | string };
  const kinds = Object.fromEntries(NOTIFY_KINDS.map(([k]) => [k, saved.kinds?.[k] ?? true])) as Record<NotifyKind, boolean>;
  let quiet = saved.quiet_hours;
  if (typeof quiet === "string") {
    const range = quiet.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    quiet = range ? { start: `${range[1].padStart(2, "0")}:${range[2]}`, end: `${range[3].padStart(2, "0")}:${range[4]}` } : null;
  }
  return { kinds, quiet_hours: quiet ?? null, tz: saved.tz ?? tz };
}
export const notifyPatch = (prefs: NotifyPrefs) => ({ notify_prefs: prefs });

/** The event to draw "New messages" above: the first one from others after what was last seen. */
export function firstUnread(events: HubEvent[], seenTs: string | null): string | null {
  if (!seenTs) return null;
  const e = events.find((x) => x.ts > seenTs && x.kind !== "owner");
  return e ? e.id : null;
}

// ---------------------------------------------------------------- the team's rules and memory

export type DataFile = { path: string; size: number; updated?: string; version?: number };
export type RuleItem = { path: string; title: string; detail: string };
export type RuleGroup = { key: string; title: string; hint: string; items: RuleItem[] };

/** The prefixes listed, in the order shown. */
export const RULE_PREFIXES = ["policies/", "memory/", "agents/", "decisions/closed/"] as const;

const stem = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");

/** The four groups of the team rules and memory list, from what /api/files/list returned for each prefix. */
export function groupRules(lists: Record<string, DataFile[]>): RuleGroup[] {
  const md = (pre: string) => (lists[pre] ?? []).filter((f) => /\.md$/i.test(f.path));
  const day = (f: DataFile) => (f.updated ?? "").slice(0, 10);
  const plain = (f: DataFile, title = stem(f.path)) => ({ path: f.path, title, detail: day(f) });
  const agents = md("agents/")
    .map((f) => f.path.match(/^agents\/([^/]+)\/(profile|memory)\.md$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ path: m[0], title: `${m[1]} · ${m[2].toLowerCase() === "profile" ? "Profile" : "Memory"}`, detail: day(lists["agents/"]!.find((f) => f.path === m[0])!) }));
  return [
    { key: "policies", title: "Rules", hint: "Rules the whole team follows, including the ones you set per project.", items: md("policies/").map((f) => plain(f, f.path.slice("policies/".length).replace(/\.md$/i, ""))) },
    { key: "memory", title: "My preferences", hint: "Your preferences, principles and lessons the team has noted.", items: md("memory/").map((f) => plain(f, f.path.slice("memory/".length).replace(/\.md$/i, ""))) },
    { key: "agents", title: "Agents", hint: "Each member's profile and memory.", items: agents },
    { key: "decisions", title: "Decision precedents", hint: "Decisions already made; similar questions are handled the same way.", items: md("decisions/closed/").map((f) => plain(f)).sort((a, b) => (a.title < b.title ? 1 : -1)) },
  ];
}

/** The markdown body without its YAML front matter. */
export const stripFrontMatter = (s: string) => s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** A task's hard requirement as words: "os:windows" → "Windows machine". */
export function needsLabel(needs = ""): string {
  if (needs === "enabled-ai-tool") return "enabled AI tool (check AI tools & onboarding)";
  if (/^cli:[^,]+$/.test(needs)) return `machine with ${needs.split("|").map((part) => providerLabel(part.replace(/^cli:/, ""))).join(" or ")}`;
  if (needs === "accepting-tasks") return "machine accepting tasks";
  const os: Record<string, string> = { windows: "Windows", linux: "Linux", macos: "Mac", darwin: "Mac", ios: "iOS", android: "Android" };
  const parts = needs.split(",").map((x) => x.trim()).filter(Boolean);
  const o = parts.find((x) => x.startsWith("os:"));
  if (o && parts.length === 1) return `${os[o.slice(3)] ?? o.slice(3)} machine`;
  return `machine with ${parts.join(" + ")}`;
}

/** "1 minute", "2 minutes". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Not finished and not running now: queued, waiting on sub-tasks or something slow, or waiting for a machine that can run it. */
export const isQueued = (state?: string) => state === "inbox" || state === "waiting" || state === "parked" || state === "nohost";

/** A machine's line under Version while (and after) an update runs; `busy` while it is still on the way. */
export type UpdateLine = { text: string; tone: "muted" | "ok" | "bad" | "busy"; busy: boolean };

/** How long a machine may stay silent on an update request before it reads as not responding (old code never reports). */
const UPDATE_SILENT_MS = 3 * 60_000;
/** After this long, a finished update is history: the rows go back to showing only the commit. */
const UPDATE_SHOWN_MS = 30 * 60_000;

export function updateLine(h: HostInfo, request: string | undefined, now = Date.now()): UpdateLine | null {
  if (!request) return null;
  const age = now - Date.parse(request);
  const u = h.update?.at === request ? h.update : undefined;
  if (!u) {
    if (age > UPDATE_SHOWN_MS) return null;
    return age < UPDATE_SILENT_MS
      ? { text: "Waiting for a response…", tone: "busy", busy: true }
      : { text: "No response: it may still be running an old version that does not report progress; update this machine manually once", tone: "bad", busy: false };
  }
  const settled = ["done", "current", "failed"].includes(u.state);
  if (settled && now - Date.parse(u.ts) > UPDATE_SHOWN_MS) return null;
  switch (u.state) {
    case "updating": return { text: "Pulling and testing the new code…", tone: "busy", busy: true };
    case "waiting": return { text: `${u.detail ?? "Waiting for running tasks to finish, then restarting"}…`, tone: "busy", busy: true };
    case "restarting": return { text: "Restarting…", tone: "busy", busy: true };
    case "deploying": return { text: "Redeploying online…", tone: "busy", busy: true };
    case "done": return { text: `Updated to ${u.detail ?? h.rev?.slice(0, 7) ?? "latest"}`, tone: "ok", busy: false };
    case "current": return { text: u.detail ? `Up to date · ${u.detail}` : "Up to date", tone: "ok", busy: false };
    case "failed": return { text: `Update failed: ${u.detail ?? "unknown reason"}`, tone: "bad", busy: false };
    default: return { text: u.state, tone: "muted", busy: false };
  }
}

/** The fleet's update as one line: "Updating · 1/3 done", or null when nothing is on the way. */
export function updateSummary(s: Status | null | undefined, now = Date.now()): { text: string; busy: boolean } | null {
  const lines = (s?.hosts ?? []).map((h) => updateLine(h, s?.update?.at, now)).filter((l): l is UpdateLine => !!l);
  if (!lines.length) return null;
  const done = lines.filter((l) => l.tone === "ok").length, bad = lines.filter((l) => l.tone === "bad").length;
  const busy = lines.some((l) => l.busy);
  return { text: `${busy ? "Updating" : "Update finished"} · ${done}/${lines.length} done${bad ? ` · ${bad} with problems` : ""}`, busy };
}
