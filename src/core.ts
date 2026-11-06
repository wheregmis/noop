// noop core — shared files as the world (stigmergy; synced via the owner's Worker, src/sync.ts), task queue, agent runner, journal, memory.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as sync from "./sync";
import { enabledProviders, providerAvailable, providerHealth, type ProviderHealth } from "./providers";
import { MACHINE_LEARNING_FIELDS, MACHINE_RESOURCE_FIELDS, configAt, autonomyLevel, validAutonomyLevel, type AutonomyPolicy, type ConfigValue } from "../cloud/src/configuration";
import { hasPendingStops, taskHasStopIntent } from "../cloud/src/stop-intents";
import { PROVIDER_IDS, type ToolPolicy } from "../cloud/src/providers";
import { learningTaskBinding, learningTaskHostError } from "../cloud/src/learning";

/** Framework code (this repo, self-updating). */
export const CODE = resolve(import.meta.dir, "..");
/** Machine-local home: $NOOP_HOME, else ~/.noop if it exists, else ~/.noop (older installs) if it exists, else ~/.noop. */
export function homeDir(): string {
  if (process.env.NOOP_HOME) return resolve(process.env.NOOP_HOME.replace(/^~/, homedir()));
  for (const d of [".noop", ".agent-hub"]) if (existsSync(join(homedir(), d))) return join(homedir(), d);
  return join(homedir(), ".noop");
}
export const HOME_DIR = homeDir();
/** Fleet state: local mirror of the files shared by all machines through the owner's Worker (tasks, journal, decisions, agents, memory, config). */
export const DATA = resolve((process.env.HUB_DATA || join(HOME_DIR, "data")).replace(/^~/, homedir()));
export const ROOT = DATA;
export const P = (...p: string[]) => join(DATA, ...p);
// sync state (noop.toml, sync.json) lives in HOME_DIR; a custom HUB_DATA (tests, extra mirrors) keeps its own next to it
sync.setSyncData(DATA, process.env.HUB_DATA && !process.env.NOOP_HOME ? dirname(DATA) : HOME_DIR);

// ------------------------------------------------------------------ config
export type Cfg = Record<string, any>;
const policySources = new WeakMap<Cfg, { shared: Cfg; local: Cfg; ui: Cfg }>();
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalidToolPolicy = Symbol("invalid tool policy");
function toolSetting(cfg: Cfg, agent?: string): unknown {
  if (cfg.clis === undefined) return undefined;
  if (!object(cfg.clis)) return invalidToolPolicy;
  if (!agent) return cfg.clis.preference;
  if (cfg.clis.agents === undefined) return undefined;
  return object(cfg.clis.agents) ? cfg.clis.agents[agent] : invalidToolPolicy;
}
const validToolOrder = (value: unknown): value is string[] => Array.isArray(value) && value.length <= PROVIDER_IDS.length
  && value.every((id) => typeof id === "string" && PROVIDER_IDS.includes(id)) && new Set(value).size === value.length;
const invalidToolOrder = (value: unknown) => value !== undefined && value !== null && !validToolOrder(value);

/** Only tool-policy defaults are exposed; bootstrap values never enter the settings response. */
export function toolPolicy(cfg: Cfg, agent?: string): ToolPolicy {
  const sources = policySources.get(cfg);
  const local = sources ? toolSetting(sources.local, agent) : undefined;
  const shared = sources ? toolSetting(sources.shared, agent) : toolSetting(cfg, agent);
  const file = local !== undefined ? local : shared;
  const fileSource = local !== undefined ? "local_file" : shared !== undefined ? "shared_file" : "default";
  const saved = sources ? toolSetting(sources.ui, agent) : undefined;
  const value = toolSetting(cfg, agent);
  return { configured: invalidToolOrder(value) ? [] : value as string[] | null | undefined ?? null,
    effective: agent ? allowedClis({ agent }, cfg) : (invalidToolOrder(value) ? [] : value as string[] | null | undefined ?? enabledProviders(cfg)).filter((id) => enabledProviders(cfg).includes(id)),
    source: saved !== undefined ? "ui" : fileSource,
    file_default: invalidToolOrder(file) ? [] : file as string[] | null | undefined ?? null, file_source: fileSource,
    ...(invalidToolOrder(value) ? { invalid: true } : {}), ...(invalidToolOrder(file) ? { file_invalid: true } : {}) };
}

const invalidAutonomyPolicy = Symbol("invalid autonomy policy");
function autonomySetting(cfg: Cfg, agent: string): unknown {
  if (cfg.autonomy === undefined) return undefined;
  if (!object(cfg.autonomy)) return invalidAutonomyPolicy;
  if (!Object.hasOwn(cfg.autonomy, "agents")) return undefined;
  const members = cfg.autonomy.agents;
  if (!object(members)) return invalidAutonomyPolicy;
  return Object.hasOwn(members, agent) ? members[agent] === undefined ? invalidAutonomyPolicy : members[agent] : undefined;
}

export function autonomyPolicy(cfg: Cfg, agent: string): AutonomyPolicy {
  const sources = policySources.get(cfg);
  const local = sources ? autonomySetting(sources.local, agent) : undefined;
  const shared = sources ? autonomySetting(sources.shared, agent) : autonomySetting(cfg, agent);
  const file = sources ? autonomySetting(merge(sources.shared, sources.local), agent) : shared;
  const fileSource = file === undefined ? "default" : local !== undefined ? "local_file" : "shared_file";
  const localReplacement = sources && sources.ui.autonomy !== undefined && !object(sources.ui.autonomy) && sources.local.autonomy !== undefined;
  const saved = sources && !localReplacement ? autonomySetting(sources.ui, agent) : undefined;
  const value = autonomySetting(cfg, agent);
  const invalid = value !== undefined && value !== null && !validAutonomyLevel(value);
  const fileInvalid = file !== undefined && file !== null && !validAutonomyLevel(file);
  return { configured: invalid ? "onboarding" : value as AutonomyPolicy["configured"] | undefined ?? null,
    effective: autonomyLevel(cfg, agent), source: localReplacement ? "local_file" : saved !== undefined ? "ui" : fileSource,
    file_default: fileInvalid ? "onboarding" : file as AutonomyPolicy["file_default"] | undefined ?? null, file_source: fileSource,
    ...(invalid ? { invalid: true } : {}), ...(fileInvalid ? { file_invalid: true } : {}) };
}

function merge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {}))
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v) : v;
  return out;
}

export function loadConfig(applyConfiguration = true, applyMachineResources = true): Cfg {
  const read = (f: string) => (existsSync(P(f)) ? Bun.TOML.parse(readFileSync(P(f), "utf8")) : {});
  // noop.toml = machine-local bootstrap (Worker url + machine token), outside DATA because DATA itself comes from the Worker
  // Shared UI choices apply over the files: operational overrides first, then per-machine run settings.
  const ui = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const shared = merge(sync.readHubToml(), read("config.toml")), local = read("config.local.toml");
  const files: Cfg = merge(merge(shared, ui), local);
  const cfg: Cfg = applyConfiguration ? merge(files, ui.configuration ?? {}) : files;
  // These explicit UI choices beat machine files; resetting a leaf reveals the original file policy.
  if (object(ui.clis)) for (const key of ["preference", "agents"]) if (Object.hasOwn(ui.clis, key))
    cfg.clis = merge(object(cfg.clis) ? cfg.clis : {}, { [key]: ui.clis[key] });
  if (object(ui.autonomy) && Object.hasOwn(ui.autonomy, "agents"))
    cfg.autonomy = merge(object(cfg.autonomy) ? cfg.autonomy : {}, { agents: ui.autonomy.agents });
  policySources.set(cfg, { shared, local, ui });
  // routine tweaks from the UI: { routines: { <name>: { enabled, every } } }
  for (const r of cfg.routine ?? []) Object.assign(r, ui.routines?.[r.name] ?? {});
  cfg.resource_defaults = Object.fromEntries(MACHINE_RESOURCE_FIELDS.map((field) => [field.path, configAt(files, field.path) ?? field.default]));
  cfg.learning_defaults = Object.fromEntries(MACHINE_LEARNING_FIELDS.map((field) => [field.path, configAt(files, field.path) ?? field.default]));
  const machineSettings = cfg.machines?.[hostName(cfg)];
  if (machineSettings) {
    const { resources, learn, ...runSettings } = machineSettings;
    cfg.host = { ...cfg.host, ...runSettings };
    if (applyConfiguration && applyMachineResources) {
      cfg.resources = merge(cfg.resources ?? {}, resources ?? {});
      cfg.learn = merge(cfg.learn ?? {}, learn ?? {});
    }
  }
  cfg.notify ??= {};
  // the owner's own Cloudflare hub (hub cloud deploy) is the fixed address for clients and workers
  if (cfg.cloud?.url) { cfg.server ??= {}; cfg.server.url ??= cfg.cloud.url; cfg.server.public_url ??= cfg.cloud.url; }
  // public hub URL published by the primary's tunnel (fleet/hub.json) → workers and push links use it unless pinned locally
  if (existsSync(P("fleet", "hub.json"))) try {
    const { url } = JSON.parse(readFileSync(P("fleet", "hub.json"), "utf8"));
    cfg.server ??= {};
    if (url && !cfg.server.url) cfg.server.url = url;
    if (url && !cfg.server.public_url) cfg.server.public_url = url;
  } catch {}
  const envMap: Record<string, string> = {
    slack_bot_token: "HUB_SLACK_BOT_TOKEN", slack_channel: "HUB_SLACK_CHANNEL", slack_webhook: "HUB_SLACK_WEBHOOK",
    discord_bot_token: "HUB_DISCORD_BOT_TOKEN", discord_channel: "HUB_DISCORD_CHANNEL", discord_webhook: "HUB_DISCORD_WEBHOOK",
  };
  for (const [k, env] of Object.entries(envMap)) if (process.env[env]) cfg.notify[k] = process.env[env];
  return cfg;
}

let machine = "";
/** This machine's short name. macOS's `hostname` follows the network (ip-10-0-0-1…); its LocalHostName stays put. */
// scutil by full path: launchd's PATH doesn't include /usr/sbin.
export function machineName(): string {
  if (machine) return machine;
  const local = process.platform === "darwin" ? Bun.spawnSync(["/usr/sbin/scutil", "--get", "LocalHostName"]).stdout.toString().trim() : "";
  return (machine = local || hostname().split(".")[0]);
}

export const hostName = (cfg: Cfg): string =>
  process.env.HUB_HOST || cfg.host?.name || machineName();

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD local
export const hhmm = () => new Date().toLocaleTimeString("sv-SE").slice(0, 5);

// ------------------------------------------------------------------ data sync (src/sync.ts)
// All data mutations are serialized so parallel workers in one daemon never race on the mirror.
let chain: Promise<unknown> = Promise.resolve();
export function locked<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export const hasRemote = async () => (await sync.syncMode()) === "remote";

export const pull = () => locked(_pull);
/** Apply remote changes to DATA (remote wins on paths edited on both sides, except mergeable appends). */
export const _pull = (): Promise<boolean> => sync.pull();

/** Commit every local change via the Worker's compare-and-swap; false if we lost a race (or are offline). */
export const commitPush = (msg: string) => locked(() => _commitPush(msg));
export const _commitPush = (msg: string): Promise<boolean> => sync.commitPush(msg);

/** Discard local edits and re-pull. */
export const resetToUpstream = () => sync.resetToUpstream();

// ------------------------------------------------------------------ markdown docs w/ front-matter
export type Doc = { meta: Record<string, string>; body: string };

export function readDoc(path: string): Doc {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

export function writeDoc(path: string, meta: Record<string, string | undefined>, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  const head = Object.entries(meta).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
  writeFileSync(path, `---\n${head}\n---\n${body.trimEnd()}\n`);
}

export const list = (dir: string, re = /\.md$/) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];

/** Non-primary hosts mint IDs with a host letter (T-M0001) so two machines never create the same ID. */
let idTag = "";
export const setIdTag = (tag: string) => { idTag = tag; };

export function nextId(prefix: string, dir: string): string {
  let max = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      const m = e.name.match(new RegExp(`^${prefix}-${idTag}(\\d+)`));
      if (m) max = Math.max(max, +m[1]);
    }
  };
  if (existsSync(dir)) walk(dir);
  // Explicit forms reserve IDs before publication, so a failed request's Inspect link never aliases different work.
  if (prefix === "T" && resolve(dir) === P("tasks")) {
    const reserved = P("fleet", "task-ids"); let ready = true;
    for (const path of [P("fleet"), reserved]) {
      let stat; try { stat = lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") { ready = false; break; } throw error; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Task ID reservations must use real directories");
    }
    if (ready) walk(reserved);
  }
  // the local mirror can lag other hosts: never hand out an id whose file already exists in any state folder
  const taken = (id: string) => existsSync(dir) && readdirSync(dir, { withFileTypes: true })
    .some((e) => e.isDirectory() ? existsSync(join(dir, e.name, `${id}.md`)) : e.name === `${id}.md`);
  let n = max + 1;
  while (taken(`${prefix}-${idTag}${String(n).padStart(4, "0")}`)) n++;
  return `${prefix}-${idTag}${String(n).padStart(4, "0")}`;
}

/**
 * Whether `host` is the fleet's primary (runs routines, the judge, the server, mints untagged ids). Named by
 * [fleet] primary; with none named, a host is the primary only while it is alone: once another host's heartbeat
 * is in the data, it is a worker, so a machine that joined before its config synced never takes over.
 */
export function isPrimary(cfg: Cfg, host = hostName(cfg)): boolean {
  if (cfg.fleet?.primary) return cfg.fleet.primary === host;
  return !list(P("fleet", "hosts"), /\.json$/).some((p) => basename(p, ".json") !== host);
}

/** Id tag for a host: "" on the primary, else [host].id_tag or the host name's first letter, upper-cased. */
export function idTagFor(cfg: Cfg, host: string): string {
  if (isPrimary(cfg, host)) return "";
  return String(cfg.host?.id_tag ?? (host.replace(/[^a-z]/gi, "").charAt(0) || "W")).toUpperCase();
}

// ------------------------------------------------------------------ tasks
export type TaskOpts = {
  agent?: string; cli?: string; host?: string; requires?: string; prefer?: string; weight?: string; repo?: string; project?: string; priority?: string; source?: string;
  extra?: Record<string, string>;
};

/** Capabilities of this machine: os:<linux|macos|windows>, host:<name>, plus config [host].caps (e.g. gpu, docker, home). */
export function hostCaps(cfg: Cfg): string[] {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const clis = [...providerHealth(cfg).filter((provider) => provider.available && accountCanRun(provider.id, cfg)).map((provider) => provider.id), ...["gh", "cargo", "bun", "node"].filter((c) => Bun.which(c))].map((c) => `cli:${c}`);
  return [`os:${os}`, `host:${hostName(cfg)}`, `arch:${process.arch}`, ...clis, ...(cfg.host?.caps ?? [])];
}

/** One requirement; "a|b" means either cap will do (e.g. cli:bun|cli:node). */
export const capOk = (req: string, caps: string[]) => req.split("|").some((r) => caps.includes(r.trim()));

/** Toolchain from current manifests, or a saved project snapshot when its folder is on another machine. */
export function repoRequires(repo?: string, fallback = "", host?: string): string[] {
  if (!repo) return [];
  if (host && host !== "any" && host !== hostName(loadConfig())) return fallback.split(",").map((r) => r.trim()).filter(Boolean);
  const dir = resolve(repo.replace(/^~/, homedir()));
  if (!existsSync(dir)) return fallback.split(",").map((r) => r.trim()).filter(Boolean);
  const out: string[] = [];
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cli:cargo");
  if (existsSync(join(dir, "package.json"))) out.push("cli:bun|cli:node");
  return out;
}

/** Keep explicit project caps separate from the toolchain snapshot supplied by its own machine. */
export function projectRequires(project: Record<string, string>): string[] {
  const custom = project.custom_requires ?? project.requires ?? "";
  const detected = project.detected_requires ?? project.requires ?? "";
  return [...new Set([custom, ...repoRequires(project.path, detected, project.host)].join(",").split(",").map((r) => r.trim()).filter(Boolean))];
}

/** A task matches if every comma-separated requirement is in the host's caps (plus what its local repo needs). */
export function matches(meta: Record<string, string>, caps: string[], body = ""): boolean {
  const binding = learningTaskBinding(meta, body);
  if (learningTaskHostError(meta, body, meta.host || "any") || binding.learning_host && !caps.includes(`host:${binding.learning_host}`)) return false;
  const reqs = [meta.requires, meta.host && meta.host !== "any" ? `host:${meta.host}` : "", ...repoRequires(meta.repo, "", meta.host)]
    .join(",").split(",").map((s) => s.trim()).filter(Boolean);
  return reqs.every((r) => capOk(r, caps));
}

/** Hook set by the CLI so core stays free of policy imports. */
export let approvalGate: (source: string, agent?: string) => boolean = () => false;
export const setApprovalGate = (fn: (source: string, agent?: string) => boolean) => { approvalGate = fn; };

/** Build the complete task before publishing it, so forms can validate its size and save their receipt first. */
export function taskDocument(id: string, title: string, body = "", o: TaskOpts = {}) {
  // a project decides where the work happens: its folder, on the machine that has it
  const project = o.project && existsSync(P("projects", `${o.project}.md`)) ? readDoc(P("projects", `${o.project}.md`)).meta : null;
  if (project) { o = { ...o, repo: project.path, host: project.host, requires: [o.requires, ...projectRequires(project)].filter(Boolean).join(","), extra: { ...o.extra, project: o.project! } }; }
  return { meta: {
    id, title, agent: o.agent ?? "lead", cli: o.cli ?? "auto", host: o.host ?? "any",
    // stored at creation so hosts without the repo checked out still know what it needs
    requires: [...new Set([...(o.requires ?? "").split(","), ...repoRequires(o.repo, "", o.host)].map((x) => x.trim()).filter(Boolean))].join(","), prefer: o.prefer ?? "", weight: o.weight ?? "normal", repo: o.repo ?? "", priority: o.priority ?? "normal", source: o.source ?? "owner",
    created: now(), ...(o.extra ?? {}),
  }, body: body || title };
}
export function newTask(title: string, body = "", o: TaskOpts = {}): string {
  const id = nextId("T", P("tasks"));
  // work the owner asked for (directly or via a delegated parent) never needs re-approval
  const folder = o.extra?.origin !== "owner" && approvalGate(o.source ?? "owner", o.agent ?? "lead") ? "proposed" : "inbox";
  const doc = taskDocument(id, title, body, o);
  writeDoc(P("tasks", folder, `${id}.md`), doc.meta, doc.body);
  return id;
}

export const which = (bin: string) => Bun.which(bin) !== null;

/** Explicit task/member/team choices keep their order; the planner ranks only automatic defaults. */
export function allowedClis(meta: Record<string, string>, cfg: Cfg): string[] {
  const enabled = enabledProviders(cfg);
  const member = toolSetting(cfg, meta.agent || "lead"), team = toolSetting(cfg);
  if (invalidToolOrder(member) || Array.isArray(member) && !member.length) return [];
  const pinned = meta.cli && meta.cli !== "auto";
  const requested: string[] = pinned ? [meta.cli] : validToolOrder(member) ? member : validToolOrder(team) ? team : invalidToolOrder(team) ? [] : enabled;
  const allowed = requested.filter((cli) => enabled.includes(cli));
  return !pinned && member == null && team == null && meta.planned_cli && allowed.includes(meta.planned_cli)
    ? [meta.planned_cli, ...allowed.filter((cli) => cli !== meta.planned_cli)] : allowed;
}

/** Account policy is installed by the local account module after core initialization. */
let accountAvailability: (cli: string, cfg: Cfg) => boolean = () => true;
export const setAccountAvailability = (available: (cli: string, cfg: Cfg) => boolean) => { accountAvailability = available; };
export const accountCanRun = (cli: string, cfg: Cfg) => accountAvailability(cli, cfg);

export function chooseCli(meta: Record<string, string>, cfg: Cfg): string | null {
  return allowedClis(meta, cfg).find((cli) => providerAvailable(cli) && accountCanRun(cli, cfg)) ?? null;
}

// ------------------------------------------------------------------ fleet presence (heartbeats)
export type HostBeat = { host: string; caps: string[]; enabled?: boolean; max_parallel?: number | null; custom_caps?: string[]; resource_defaults?: Record<string, ConfigValue>; disk_path_supported?: boolean; learning_defaults?: Record<string, ConfigValue>; providers?: ProviderHealth[]; seen: string; busy: number; version: string; stats?: any;
  /** The noop code this host runs: its commit and that commit's page. */ rev?: string; rev_url?: string;
  /** How this host is doing with the owner's latest "update every machine". */ update?: UpdateState;
  /** Per running task: when its agent last showed a sign of life and what it was doing. */ activity?: Record<string, Activity> };

/** A running agent's latest sign of life: any output; for Claude also the step it took ("Bash · gh pr checks 814"). */
export type Activity = { at: string; step?: string; steps: number };
/** This process's running agents (written by runAgent, published in the heartbeat). */
export const agentActivity = new Map<string, Activity>();

/** One host's progress on an update request (`at` names the request), shown per machine in Settings › Version. */
export type UpdateState = {
  at: string; ts: string;
  state: "updating" | "waiting" | "restarting" | "deploying" | "done" | "current" | "failed";
  detail?: string;
  /** The commit it ran when the update started (a restart onto another commit means it updated). */ from?: string;
};
const STARTED = Date.now();
const UPDATE_STATE = () => join(HOME_DIR, "update-state.json"); // machine-local: survives the restart it reports on
export function setUpdateState(u: Omit<UpdateState, "ts">) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(UPDATE_STATE(), JSON.stringify({ ...u, ts: now() }, null, 2));
}
/** This host's update progress; a restart that finished turns "restarting" into "done" (or "failed" on the same commit). */
export function updateState(): UpdateState | undefined {
  let u: UpdateState;
  try { u = JSON.parse(readFileSync(UPDATE_STATE(), "utf8")); } catch { return undefined; }
  // written by the process before this one: the restart it waited for has happened
  if ((u.state === "restarting" || u.state === "waiting") && Date.parse(u.ts) < STARTED) {
    const rev = runningRev().rev;
    if (rev && rev !== u.from) setUpdateState({ at: u.at, state: "done", detail: rev.slice(0, 7), from: u.from });
    else setUpdateState({ at: u.at, state: "failed", detail: "Still the old code after restart", from: u.from });
    return updateState();
  }
  return u;
}

/** The commit of the code this process runs (read once: an update restarts the daemon) and its GitHub page. */
let codeRev: { rev?: string; rev_url?: string } | undefined;
export function runningRev(): { rev?: string; rev_url?: string } {
  if (codeRev) return codeRev;
  const git = (...a: string[]) => { try { return Bun.spawnSync(["git", "-C", CODE, ...a], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; } };
  const rev = git("rev-parse", "HEAD") || undefined;
  const repo = git("remote", "get-url", "origin").match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1];
  return (codeRev = { rev, rev_url: rev && repo ? `https://github.com/${repo}/commit/${rev}` : undefined });
}

/** The owner's "update every machine" (fleet/update.json, synced): each host updates once per request. */
export const UPDATE_REQUEST = () => P("fleet", "update.json");

export function heartbeat(cfg: Cfg, busy: number, stats?: unknown) {
  const host = hostName(cfg);
  const f = P("fleet", "hosts", `${host}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ host, caps: hostCaps(cfg), seen: now(), busy, version: "1", enabled: cfg.host?.enabled !== false, max_parallel: cfg.host?.max_parallel ?? null, custom_caps: cfg.host?.caps ?? [], resource_defaults: cfg.resource_defaults, disk_path_supported: true, learning_defaults: cfg.learning_defaults, providers: providerHealth(cfg), stats, ...runningRev(), update: updateState(), activity: agentActivity.size ? Object.fromEntries(agentActivity) : undefined } satisfies HostBeat, null, 2));
}

export const knownHosts = (): HostBeat[] => list(P("fleet", "hosts"), /\.json$/).map((p) => JSON.parse(readFileSync(p, "utf8")) as HostBeat);

export function onlineHosts(cfg: Cfg): HostBeat[] {
  const staleMs = (cfg.fleet?.offline_after_minutes ?? 5) * 60_000;
  return knownHosts().filter((h) => Date.now() - Date.parse(h.seen) < staleMs);
}

/** Connected machines accepting work; paused machines keep heartbeating and finish their current tasks. */
export const schedulableHosts = (cfg: Cfg) => onlineHosts(cfg).filter((h) => cfg.machines?.[h.host]?.enabled ?? h.enabled ?? true);

const reqList = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Should this host leave the task for a preferred, currently-online host? */
function yieldToPreferred(meta: Record<string, string>, caps: string[], cfg: Cfg): boolean {
  const prefer = reqList(meta.prefer);
  if (!prefer.length || prefer.every((r) => capOk(r, caps))) return false;
  const waitMs = (cfg.fleet?.prefer_wait_minutes ?? 10) * 60_000;
  if (Date.now() - Date.parse(meta.created) > waitMs) return false; // waited long enough
  return schedulableHosts(cfg).some((h) => h.host !== hostName(cfg) && matches(meta, h.caps) && allowedClis(meta, cfg).some((cli) => h.caps.includes(`cli:${cli}`)) && prefer.every((r) => capOk(r, h.caps)));
}

/** Heavy work goes to the least-loaded capable online host. */
function yieldHeavy(meta: Record<string, string>, cfg: Cfg, myLoad: number, heavyOk: boolean): boolean {
  if (meta.weight !== "heavy") return false;
  if (!heavyOk) return true;
  const me = hostName(cfg);
  return schedulableHosts(cfg).some((h) => h.host !== me && matches(meta, h.caps) && allowedClis(meta, cfg).some((cli) => h.caps.includes(`cli:${cli}`)) && h.stats
    && h.stats.loadRatio + 0.2 < myLoad && h.busy === 0);
}

export function pickTask(cfg: Cfg, myLoad = 0, heavyOk = true): string | null {
  if (cfg.host?.enabled === false) return null;
  const caps = hostCaps(cfg);
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const cands = list(P("tasks", "inbox"), /^T-.*\.md$/)
    .map((p) => { const doc = readDoc(p); return { p, m: doc.meta, body: doc.body }; })
    // the planner decides where a task runs first; unplanned tasks wait for it (at most plan_wait_minutes)
    .filter(({ m, body }) => !taskHasStopIntent(m) && !hasPendingStops(m.pending_stops) && (m.planned || Date.now() - Date.parse(m.created ?? "") > (cfg.fleet?.plan_wait_minutes ?? 3) * 60_000) && matches(m, caps, body) && chooseCli(m, cfg) && !yieldToPreferred(m, caps, cfg) && !yieldHeavy(m, cfg, myLoad, heavyOk))
    .sort((a, b) => (rank[a.m.priority] ?? 2) - (rank[b.m.priority] ?? 2) || a.p.localeCompare(b.p));
  return cands[0]?.p ?? null;
}

/** Move inbox → active and push. The Worker's compare-and-swap commit is the distributed lock between machines. */
export const claim = (path: string, host: string) => locked(() => _claim(path, host));
async function _claim(path: string, host: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const { meta, body } = readDoc(path);
  if (learningTaskHostError(meta, body, meta.host || "any") || learningTaskHostError(meta, body, host)) return null;
  const dest = P("tasks", "active", `${meta.id}.md`);
  writeDoc(dest, { ...meta, ...learningTaskBinding(meta, body), claimed_by: host, run_host: host, run_id: crypto.randomUUID(), started: now(), host_caps: hostCaps(loadConfig()).join(",") }, body);
  unlinkSync(path);
  if (await _commitPush(`[${host}] claim ${meta.id}: ${meta.title}`)) return dest;
  // undo only our claim (other pending local results stay queued); after a lost race the pull already applied the winner
  sync.revertLocal([relative(DATA, dest), relative(DATA, path)]);
  return null;
}

// ------------------------------------------------------------------ journal & memory
export function journal(host: string, line: string) {
  const f = P("journal", `${today()}.md`);
  if (!existsSync(f)) writeFileSync(f, `# Journal ${today()}\n\n`);
  appendFileSync(f, `- ${hhmm()} \`${host}\` ${line}\n`);
}

export function remember(agent: string, lessons: string[] | undefined, source: string) {
  if (!lessons?.length) return;
  const f = P("agents", agent, "memory.md");
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `# ${agent} memory\n\n`); }
  appendFileSync(f, lessons.map((l) => `- ${l} _(${source}, ${today()})_\n`).join(""));
}

export const readIf = (p: string, tail = 12000) => (existsSync(p) ? readFileSync(p, "utf8").slice(-tail) : "");

export const readAll = (dir: string, tail = 12000) =>
  list(dir).map((p) => `### ${p.split("/").pop()}\n${readFileSync(p, "utf8").trim()}`).join("\n\n").slice(-tail);

export const recentJournal = (days = 2) =>
  list(P("journal")).slice(-days).map((p) => readFileSync(p, "utf8").slice(-4000)).join("\n");

export function precedents(n = 30): string {
  return list(P("decisions", "closed")).slice(-n).map((p) => {
    const { meta } = readDoc(p);
    return `- ${meta.id} [${meta.agent}] Q: ${meta.question}\n  → **${meta.answer}** (by ${meta.answered_by})`;
  }).join("\n");
}

export function signature(agent: string, host: string, cfg: Cfg) {
  return `🤖 [Noop](https://github.com/wheregmis/noop) (${agent}) · AI agent acting for @${cfg.owner?.github ?? "owner"}`;
}

export function agentName(agent: string): string {
  const p = P("agents", agent, "profile.md");
  const m = existsSync(p) ? readFileSync(p, "utf8").match(/^Name:\s*(.+)$/m) : null;
  return m ? m[1].trim() : agent;
}
