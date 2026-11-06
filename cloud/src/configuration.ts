import { DEFAULT_PROVIDERS, LEARNING_SOURCES, PROVIDER_IDS } from "./providers";
export const AUTONOMY_LEVELS = ["onboarding", "assisted", "autonomous"] as const;
export type AutonomyLevel = typeof AUTONOMY_LEVELS[number];
export const validAutonomyLevel = (value: unknown): value is AutonomyLevel => typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
export type AutonomyPolicy = {
  configured: AutonomyLevel | null; effective: AutonomyLevel;
  source: "ui" | "local_file" | "shared_file" | "default";
  file_default: AutonomyLevel | null; file_source: "local_file" | "shared_file" | "default";
  invalid?: boolean; file_invalid?: boolean;
};
/** Invalid explicit member settings never inherit a more permissive team level. */
export function autonomyLevel(cfg: Record<string, any>, agent?: string): AutonomyLevel {
  if (!object(cfg.autonomy)) return "onboarding";
  const team = validAutonomyLevel(cfg.autonomy.level) ? cfg.autonomy.level : "onboarding";
  if (!agent || !Object.hasOwn(cfg.autonomy, "agents")) return team;
  const members = cfg.autonomy.agents;
  if (!object(members)) return "onboarding";
  if (!Object.hasOwn(members, agent) || members[agent] === null) return team;
  return validAutonomyLevel(members[agent]) ? members[agent] : "onboarding";
}
// One list supplies the operational settings form and its server-side validation. Credentials are never included.
export type ConfigValue = string | number | boolean | string[] | null;
export type ConfigurationField = {
  path: string; group: "execution" | "fleet" | "resources" | "automation" | "approvals" | "owner" | "gates" | "onboarding"; label: string; hint: string;
  kind: "number" | "boolean" | "model" | "choice" | "hours" | "folders" | "names" | "name" | "github" | "patterns" | "providers" | "path";
  default: ConfigValue; min?: number; max?: number; integer?: boolean; options?: string[]; optionLabels?: Record<string, string>;
};
export const CONFIGURATION_GROUPS = { execution: "Execution", fleet: "Fleet scheduling", resources: "Resource limits", automation: "Background work", approvals: "Autonomy & approvals", owner: "Owner & attribution", gates: "Claude tool blocks", onboarding: "AI tools & onboarding" };
export const CONFIGURATION_FIELDS: ConfigurationField[] = [
  { path: "clis.enabled", group: "onboarding", label: "AI tools Noop may run", hint: "Select the tools Noop may use for tasks, chat, planning and automatic repair. Unselected tools are excluded from fallback too. Select none to pause new AI work; existing runs finish.", kind: "providers", default: DEFAULT_PROVIDERS, options: PROVIDER_IDS },
  { path: "learn.enabled", group: "onboarding", label: "Learn from local history", hint: "Allow learning routines to read only the selected sources below. Redacted digests stay on each machine; distilled lessons enter team memory. Turning this off stops future collection.", kind: "boolean", default: true },
  { path: "learn.sources", group: "onboarding", label: "History sources for onboarding and learning", hint: "Choose independently of execution tools. Unselected histories are never scanned. Selecting no sources stops collection. Configure history locations in each machine's Learning history settings. Learning follows the enabled learning routines' schedules.", kind: "providers", default: ["claude", "codex", "noop"], options: LEARNING_SOURCES },
  { path: "clis.hermes.model", group: "execution", label: "Hermes task model", hint: "Model ID accepted by Hermes. Blank uses its own configured default. Hermes uses its native tool permissions.", kind: "model", default: null },
  { path: "owner.name", group: "owner", label: "Your name", hint: "Used when the team addresses you and introduces its owner in agent prompts.", kind: "name", default: "the owner" },
  { path: "owner.github", group: "owner", label: "GitHub username for attribution", hint: "Used in the signature on external agent posts. Enter a username, for example your-name; a leading @ is accepted.", kind: "github", default: "owner" },
  { path: "gates.github_rest", group: "gates", label: "Keep GitHub REST tool blocks", hint: "Blocks standard gh api repos/users/orgs/search and --paginate calls in new standard Claude task runs. Turning this off removes those API blocks; built-in merge and publish blocks stay.", kind: "boolean", default: true },
  { path: "gates.extra", group: "gates", label: "Additional Claude tool blocks", hint: "One Claude permission pattern per line, for example Bash(kubectl delete:*) or Edit(./.env). Added to built-in blocks in new standard Claude task runs. An approved task override relaxes these blocks. Custom runner commands and Codex use their own permissions.", kind: "patterns", default: [] },
  { path: "autonomy.level", group: "approvals", label: "Team default autonomy", hint: "Learning asks before most self-generated work. Assisted starts routine work; Autonomous starts self-generated work. Member overrides take precedence; decision rules still apply.", kind: "choice", default: "onboarding", options: [...AUTONOMY_LEVELS] },
  { path: "autonomy.assisted_approve_followups", group: "approvals", label: "Approve follow-ups in Assisted mode", hint: "Require your approval for agent-created follow-up tasks when that member uses Assisted mode. Owner-requested work keeps running without re-approval.", kind: "boolean", default: false },
  { path: "autonomy.batch_minutes", group: "approvals", label: "Approval batch delay (minutes)", hint: "Wait for proposals to accumulate before asking. A batch of five or more is sent immediately. Zero asks at the next scheduler check.", kind: "number", default: 15, min: 0, max: 1440, integer: true },
  { path: "autonomy.renotify_hours", group: "approvals", label: "Approval refresh interval (hours)", hint: "How soon an unanswered batch may be rebuilt when proposals change. Zero allows a refresh at every scheduler check.", kind: "number", default: 3, min: 0, max: 168 },
  { path: "autonomy.auto_routines", group: "approvals", label: "Routines allowed without approval", hint: "One exact routine name per line. These routines bypass Learning-mode task approval, even if not marked read-only. Follow-ups still follow member autonomy rules. Leave empty to use each routine’s own approval setting.", kind: "names", default: [] },
  { path: "clis.timeout_minutes", group: "execution", label: "Run limit (minutes)", hint: "Maximum duration of an agent run. Applies to new runs.", kind: "number", default: 60, min: 1, max: 1440, integer: true },
  { path: "clis.stall_minutes", group: "execution", label: "Silence limit (minutes)", hint: "Stop and resume a run that produces no output for this long.", kind: "number", default: 20, min: 1, max: 1440, integer: true },
  { path: "clis.claude.model", group: "execution", label: "Claude task model", hint: "Model ID or alias accepted by Claude. Blank uses Noop's built-in default.", kind: "model", default: null },
  { path: "clis.claude.permission_mode", group: "execution", label: "Claude task tool permissions", hint: "Applies to new standard Claude task runs. Allow without prompts skips Claude's permission prompts; Deny unapproved tools rejects calls that would prompt. A Noop approval does not change this policy. Custom commands, chat, judges and automatic repair use their own permissions.", kind: "choice", default: "bypassPermissions", options: ["bypassPermissions", "dontAsk"], optionLabels: { bypassPermissions: "Allow without prompts", dontAsk: "Deny unapproved tools" } },
  { path: "clis.codex.model", group: "execution", label: "Codex task model", hint: "Model ID accepted by Codex. Blank uses the CLI's default.", kind: "model", default: null },
  { path: "judge.enabled", group: "execution", label: "Decision judge", hint: "Evaluate decisions under the team's autonomy rules. When off, decisions wait for you.", kind: "boolean", default: true },
  { path: "judge.cli", group: "execution", label: "Judge CLI", hint: "Also used for task placement and other short planning calls.", kind: "choice", default: "claude", options: PROVIDER_IDS },
  { path: "judge.model", group: "execution", label: "Claude judge model", hint: "Blank uses Noop's built-in Claude default.", kind: "model", default: null },
  { path: "judge.codex_model", group: "execution", label: "Codex judge model", hint: "Blank uses the Codex CLI's default.", kind: "model", default: null },
  { path: "judge.hermes_model", group: "execution", label: "Hermes judge model", hint: "Blank uses Hermes' configured model. Disabled or unavailable tools are skipped.", kind: "model", default: null },
  { path: "router.cli", group: "execution", label: "Preferred chat and routing tool", hint: "Disabled or unavailable tools are skipped. The remaining enabled tools are fallbacks.", kind: "choice", default: "claude", options: PROVIDER_IDS },
  { path: "router.model", group: "execution", label: "Chat and routing model", hint: "Blank uses the preferred tool's fast default, or Hermes' configured model.", kind: "model", default: null },
  { path: "router.timeout_seconds", group: "execution", label: "Chat response limit (seconds)", hint: "Maximum time for each short chat or routing call.", kind: "number", default: 45, min: 5, max: 300, integer: true },
  { path: "judge.timeout_minutes", group: "execution", label: "Judge limit (minutes)", hint: "Maximum duration of a short judge or planning call.", kind: "number", default: 10, min: 1, max: 120, integer: true },
  { path: "host.tick_seconds", group: "fleet", label: "Scheduler interval (seconds)", hint: "How often each machine checks its queue and syncs settings.", kind: "number", default: 60, min: 5, max: 3600, integer: true },
  { path: "cloud.poll_seconds", group: "fleet", label: "Hub polling interval (seconds)", hint: "Delay between hub status checks and machine commands. Applies after the next sync and polling cycle. Owner messages still use long polling; a larger value can delay machine actions.", kind: "number", default: 3, min: 1, max: 60, integer: true },
  { path: "fleet.offline_after_minutes", group: "fleet", label: "Offline after (minutes)", hint: "A machine with no heartbeat for this long is unavailable for placement.", kind: "number", default: 5, min: 1, max: 1440, integer: true },
  { path: "fleet.reap_after_minutes", group: "fleet", label: "Recover abandoned work after (minutes)", hint: "Requeue tasks left on a machine that went offline.", kind: "number", default: 20, min: 1, max: 10080, integer: true },
  { path: "fleet.prefer_wait_minutes", group: "fleet", label: "Preference wait (minutes)", hint: "How long to prefer an online matching machine before allowing another one. Zero disables the wait.", kind: "number", default: 10, min: 0, max: 1440, integer: true },
  { path: "fleet.plan_wait_minutes", group: "fleet", label: "Planning wait (minutes)", hint: "Allow unplanned tasks to start after this long if the planner is unavailable.", kind: "number", default: 3, min: 0, max: 120, integer: true },
  { path: "fleet.max_attempts", group: "fleet", label: "Task attempts", hint: "Maximum automatic attempts for failed tasks and plan steps.", kind: "number", default: 2, min: 1, max: 20, integer: true },
  { path: "fleet.max_followup_depth", group: "fleet", label: "Follow-up depth", hint: "Limit chains of agent-created follow-ups. Zero prevents further follow-ups.", kind: "number", default: 4, min: 0, max: 20, integer: true },
  { path: "github.min_remaining", group: "fleet", label: "GitHub quota reserved for you", hint: "Pause GitHub-heavy work when REST or GraphQL quota falls below this amount. Zero disables this pause. Quota readings are cached for up to five minutes.", kind: "number", default: 1000, min: 0, max: 1_000_000, integer: true },
  { path: "resources.mem_min_pct", group: "resources", label: "Minimum free memory (%)", hint: "Reduce new work below this amount of available memory.", kind: "number", default: 10, min: 1, max: 95, integer: true },
  { path: "resources.disk_hard_min_gb", group: "resources", label: "Minimum free disk (GB)", hint: "Stop adding work below this threshold.", kind: "number", default: 5, min: 1, max: 1000 },
  { path: "resources.load_mid", group: "resources", label: "Reduce concurrency at load ratio", hint: "Load divided by CPU cores. A ratio of 1 means one runnable job per core.", kind: "number", default: 0.7, min: 0.05, max: 16 },
  { path: "resources.load_high", group: "resources", label: "High load ratio", hint: "Reduce concurrency further above this ratio; must exceed the threshold above.", kind: "number", default: 0.9, min: 0.05, max: 32 },
  { path: "resources.heavy_max_load", group: "resources", label: "Heavy-work maximum load ratio", hint: "Heavy tasks wait for load below this ratio and for memory headroom.", kind: "number", default: 0.5, min: 0.05, max: 16 },
  { path: "resources.cleanup_enabled", group: "resources", label: "Automatic cache cleanup", hint: "Allow removal of safe caches on the monitored filesystem only when disk is low. Cleanup waits if disk measurement is unavailable. Scheduling limits still apply when this is off.", kind: "boolean", default: true },
  { path: "resources.disk_min_gb", group: "resources", label: "Cleanup target free disk (GB)", hint: "Cleanup starts below this amount, or below the free-disk percentage below.", kind: "number", default: 30, min: 1, max: 2000 },
  { path: "resources.disk_min_pct", group: "resources", label: "Cleanup target free disk (%)", hint: "Cleanup stops once both free-space targets are met.", kind: "number", default: 10, min: 1, max: 95, integer: true },
  { path: "resources.stale_repo_days", group: "resources", label: "Unused build-cache age (days)", hint: "Build targets in inactive repositories may be removed during cleanup. Source files stay.", kind: "number", default: 7, min: 1, max: 3650, integer: true },
  { path: "resources.work_dirs", group: "resources", label: "Repository parent folders", hint: "One absolute path per line. Cleanup scans repositories directly inside these folders. ~/work is evaluated in each machine's own home. Empty disables repository-cache cleanup.", kind: "folders", default: ["~/work"] },
  { path: "idle.enabled", group: "automation", label: "Suggest work when idle", hint: "The team proposes next actions after its queue becomes idle. Uses model quota.", kind: "boolean", default: true },
  { path: "idle.after_minutes", group: "automation", label: "Idle delay (minutes)", hint: "Wait this long before proposing next actions.", kind: "number", default: 20, min: 1, max: 1440, integer: true },
  { path: "idle.cooldown_minutes", group: "automation", label: "Suggestion cooldown (minutes)", hint: "Wait before replacing an unanswered next-actions menu.", kind: "number", default: 180, min: 1, max: 10080, integer: true },
  { path: "idle.quiet_hours", group: "automation", label: "Suggestion quiet hours", hint: "Local machine time, e.g. 23:30-08:30. Blank disables quiet hours. Existing tasks keep running.", kind: "hours", default: "" },
  { path: "notify.on_failure", group: "automation", label: "Report owner-task failures", hint: "Report a failed owner-requested or urgent task after its final attempt. Notification preferences still control delivery. Applies to new task runs.", kind: "boolean", default: true },
  { path: "medic.enabled", group: "automation", label: "Automatic self-repair", hint: "Use an agent to diagnose repeated daemon, installation or update failures.", kind: "boolean", default: true },
  { path: "medic.push", group: "automation", label: "Publish self-repair fixes", hint: "Allow the repair agent to create a branch and PR for framework fixes instead of keeping its work local.", kind: "boolean", default: true },
  { path: "medic.timeout_minutes", group: "automation", label: "Self-repair limit (minutes)", hint: "Maximum duration of the repair agent.", kind: "number", default: 30, min: 1, max: 1440, integer: true },
  { path: "update.enabled", group: "automation", label: "Automatic framework updates", hint: "Check for updates while the machine is idle. Manual updates remain available.", kind: "boolean", default: true },
  { path: "update.check_minutes", group: "automation", label: "Update check interval (minutes)", hint: "How often an idle machine checks for framework updates.", kind: "number", default: 30, min: 1, max: 10080, integer: true },
];

export const RESOURCE_FIELDS = CONFIGURATION_FIELDS.filter((field) => field.group === "resources");
export const MACHINE_RESOURCE_FIELDS: ConfigurationField[] = [...RESOURCE_FIELDS,
  { path: "resources.disk_path", group: "resources", label: "Disk to monitor", hint: "Absolute path or ~ on this machine, including a disk root. Blank monitors its home folder. If unavailable, new work and automatic cleanup wait until disk measurement recovers.", kind: "path", default: null },
];
export const MACHINE_LEARNING_FIELDS: ConfigurationField[] = [
  { path: "learn.claude_dir", group: "onboarding", label: "Claude history folder", hint: "Absolute path or ~/path on this machine. Blank uses its own ~/.claude/projects folder. Only read when Claude learning is selected.", kind: "path", default: null },
  { path: "learn.codex_dir", group: "onboarding", label: "Codex history folder", hint: "Absolute path or ~/path on this machine. Blank uses its own ~/.codex/sessions folder. Only read when Codex learning is selected.", kind: "path", default: null },
  { path: "learn.hermes_db", group: "onboarding", label: "Hermes history database", hint: "Absolute path or ~/path to state.db on this machine. Blank follows its own HERMES_HOME or default Hermes folder. Only read when Hermes learning is selected.", kind: "path", default: null },
  { path: "learn.max_digest_chars", group: "onboarding", label: "Maximum learning digest characters", hint: "Limits the entire redacted local digest passed to the apprentice, including Noop chat. The default is 400,000 characters. Larger collections are shortened; omitted turns are not revisited automatically.", kind: "number", default: 400_000, min: 10_000, max: 2_000_000, integer: true },
];
export const MACHINE_CONFIGURATION_FIELDS = [...MACHINE_RESOURCE_FIELDS, ...MACHINE_LEARNING_FIELDS];

const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
export const configAt = (cfg: Record<string, any>, path: string): any => path.split(".").reduce((v, k) => object(v) && Object.hasOwn(v, k) ? v[k] : undefined, cfg);
export function configurationValues(cfg: Record<string, any>, fields = CONFIGURATION_FIELDS): Record<string, ConfigValue> {
  return Object.fromEntries(fields.map((f) => [f.path, configAt(cfg, f.path) === undefined ? f.default : configAt(cfg, f.path)]));
}
function set(cfg: Record<string, any>, path: string, value: ConfigValue | undefined) {
  const parts = path.split("."), key = parts.pop()!;
  let node = cfg;
  for (const p of parts) { if (!object(node[p])) node[p] = {}; node = node[p]; }
  if (value === undefined) delete node[key]; else node[key] = value;
}

/** Only known operational fields may be overridden. Existing file settings and credentials stay outside this object. */
export function configurationPatch(input: unknown, previous: Record<string, any>, baseline: Record<string, any>, fields = CONFIGURATION_FIELDS): { configuration: Record<string, any> } | { error: string } {
  if (!object(input) || Object.keys(input).some((k) => k !== "values" && k !== "reset") || (input.values !== undefined && !object(input.values))
    || (input.reset !== undefined && (!Array.isArray(input.reset) || input.reset.some((p: unknown) => typeof p !== "string")))) return { error: "Send values to change or paths to reset" };
  const next: Record<string, any> = {};
  for (const f of fields) { const value = configAt(previous, f.path); if (value !== undefined) set(next, f.path, value); }
  // Dropping legacy autonomy barriers on an unrelated edit could silently grant more autonomy.
  if (fields.some((field) => field.path === "autonomy.level") && Object.hasOwn(previous, "autonomy")) {
    if (!object(previous.autonomy)) next.autonomy = previous.autonomy;
    else if (Object.hasOwn(previous.autonomy, "agents")) { next.autonomy ??= {}; next.autonomy.agents = previous.autonomy.agents; }
  }
  const touched = new Set<string>();
  for (const [path, raw] of Object.entries(input.values ?? {})) {
    const f = fields.find((f) => f.path === path);
    if (!f) return { error: `Unknown setting: ${path}` };
    let value = raw as ConfigValue;
    if (f.kind === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < f.min! || value > f.max! || f.integer && !Number.isInteger(value)))
      return { error: `${f.label} must be ${f.integer ? "a whole number" : "a number"} between ${f.min} and ${f.max}` };
    if (f.kind === "boolean" && typeof value !== "boolean") return { error: `${f.label} must be on or off` };
    if (f.kind === "choice" && (typeof value !== "string" || !f.options!.includes(value))) return { error: `Choose a valid ${f.label.toLowerCase()}` };
    if (f.kind === "providers") {
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !f.options!.includes(id))) return { error: `Choose supported tools for ${f.label.toLowerCase()}` };
      value = [...new Set(value)];
    }
    if (f.kind === "name") {
      if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) return { error: "Your name must be one line, up to 80 characters" };
      value = value.trim();
    }
    if (f.kind === "github") {
      if (typeof value !== "string") return { error: "Enter a GitHub username" };
      value = value.trim().replace(/^@/, "");
      if (value.length > 39 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(value) || value.includes("--")) return { error: "GitHub attribution uses a username with letters, numbers and single dashes, up to 39 characters" };
    }
    if (f.kind === "patterns") {
      if (!Array.isArray(value) || value.length > 64 || value.some((pattern) => typeof pattern !== "string" || pattern.length > 500 || /[\x00-\x1f\x7f]/.test(pattern)
        || !/^[a-zA-Z_*][a-zA-Z0-9_.:*-]*(?:\(.+\))?$/.test(pattern))) return { error: "Use Claude tool patterns, one per line, up to 64 patterns of 500 characters" };
      if (value.some((pattern) => /^(?:Write|NotebookEdit|MultiEdit|Glob|Grep)\((?!\*\)$).+\)$/.test(pattern)))
        return { error: "Use Edit(path) for scoped file-write blocks and Read(path) for scoped read/search blocks" };
      value = [...new Set(value)];
    }
    if (f.kind === "model") {
      if (value !== null && (typeof value !== "string" || value.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(value.trim()))) return { error: `${f.label} must be a model ID or blank` };
      value = typeof value === "string" && value.trim() ? value.trim() : null;
    }
    if (f.kind === "path") {
      if (value !== null && (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value))) return { error: `${f.label} must be an absolute path or blank` };
      value = typeof value === "string" ? value.trim() || null : null;
      const diskPath = f.path === "resources.disk_path";
      if (value !== null && (value.length > 1000 || /[$`]|%[a-zA-Z_][a-zA-Z0-9_]*%/.test(value)
        || !(diskPath && value === "~") && !/^(?:~[/\\]|\/|[a-zA-Z]:[/\\]|\\\\[^\\]+\\[^\\]+)/.test(value)
        || !diskPath && /^(?:~[/\\]?|\/+|[a-zA-Z]:[/\\]?)$/.test(value) || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value)))
        return { error: `${f.label} must be an absolute path${diskPath ? " or ~" : " below a home or disk root"}, without environment variables or shell expressions` };
    }
    if (f.kind === "hours" && (typeof value !== "string" || value !== "" && !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value))) return { error: "Quiet hours use HH:MM-HH:MM, or leave them blank" };
    if (f.kind === "names") {
      if (!Array.isArray(value) || value.length > 50 || value.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9][\w-]{0,79}$/.test(name))) return { error: `${f.label} uses exact routine names, one per line` };
      value = [...new Set(value)];
    }
    if (f.kind === "folders") {
      if (!Array.isArray(value) || value.length > 20 || value.some((p) => typeof p !== "string" || p.length > 1000 || /[\r\n\0]/.test(p)
        || !/^(?:~[/\\]|\/|[a-zA-Z]:[/\\])/.test(p) || /^(?:~[/\\]?|\/+|[a-zA-Z]:[/\\]?)$/.test(p) || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(p))) return { error: "Repository parent folders must be absolute paths below a home or disk root" };
      value = [...new Set(value.map((p) => p.trim()))];
    }
    set(next, path, value); touched.add(path);
  }
  for (const path of input.reset ?? []) {
    if (!fields.some((f) => f.path === path)) return { error: `Unknown setting: ${path}` };
    if (touched.has(path)) return { error: `Choose either a value or a reset for ${path}` };
    set(next, path, undefined); touched.add(path);
  }
  const values = configurationValues(baseline, fields);
  for (const f of fields) { const value = configAt(next, f.path); if (value !== undefined) values[f.path] = value; }
  const pairs = [
    ["clis.stall_minutes", "clis.timeout_minutes", "Silence limit cannot exceed the run limit", false],
    ["fleet.offline_after_minutes", "fleet.reap_after_minutes", "Recovery must wait at least as long as offline detection", false],
    ["resources.disk_hard_min_gb", "resources.disk_min_gb", "Cleanup target must be at least the minimum free disk threshold", false],
    ["resources.load_mid", "resources.load_high", "High load ratio must exceed the concurrency-reduction ratio", true],
  ] as const;
  for (const [low, high, error, strict] of pairs) if ((touched.has(low) || touched.has(high)) && (strict ? Number(values[low]) >= Number(values[high]) : Number(values[low]) > Number(values[high]))) return { error };
  return { configuration: next };
}

/** Legacy shared autonomy fields and member edits share validation with the operational form. */
export function autonomySettingsPatch(input: unknown): { values: Record<string, any>; reset: string[] } | { error: string } {
  if (!object(input)) return { error: "Choose valid autonomy settings" };
  const member = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id);
  const shared = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "agents" && key !== "reset").map(([key, value]) => [`autonomy.${key}`, value]));
  const checked = configurationPatch({ values: shared }, {}, {});
  if ("error" in checked) return checked;
  const values: Record<string, any> = { ...(checked.configuration.autonomy ?? {}) };
  if (Object.hasOwn(input, "agents")) {
    if (!object(input.agents) || Object.entries(input.agents).some(([id, value]) => !member(id) || value !== null && !validAutonomyLevel(value)))
      return { error: "Choose a valid member autonomy level or the team default" };
    values.agents = { ...input.agents };
  }
  if (Object.hasOwn(input, "reset") && (!Array.isArray(input.reset) || input.reset.some((path: unknown) => typeof path !== "string" || !path.startsWith("agents.") || !member(path.slice(7)))
    || new Set(input.reset).size !== input.reset.length)) return { error: "Choose each member autonomy setting to restore once" };
  const reset = [...(input.reset ?? [])] as string[];
  if (reset.some((path) => Object.hasOwn(values.agents ?? {}, path.slice(7)))) return { error: "Choose either a member autonomy value or a file reset" };
  return { values, reset };
}
