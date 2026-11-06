// hub init / install / update — out-of-the-box setup and self-update.
import { $ } from "bun";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODE, DATA, P, machineName } from "./core";
import { renderRoutine } from "./routines";

const STATE_DIRS = [
  "tasks/proposed", "tasks/rejected", "tasks/waiting", "tasks/inbox", "tasks/active", "tasks/blocked", "tasks/failed", "tasks/done",
  "decisions/open", "decisions/closed", "journal", "fleet/hosts", "reports/daily", "evolution", "reviews",
];

/** Copy template files that don't exist yet (never overwrite user-evolved agents/memory/policies). */
function seedTemplates() {
  const walk = (rel: string) => {
    for (const e of readdirSync(join(CODE, "templates", rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) { mkdirSync(P(r), { recursive: true }); walk(r); }
      else if (!existsSync(P(r))) cpSync(join(CODE, "templates", r), P(r));
    }
  };
  walk("");
  for (const d of STATE_DIRS) { mkdirSync(P(d), { recursive: true }); if (!readdirSync(P(d)).length) writeFileSync(P(d, ".gitkeep"), ""); }
}

/** Worker host: owner email login → POST /api/host/join → this machine's token. */
async function joinViaLogin(url: string, host: string): Promise<string | null> {
  const post = async (path: string, body: unknown, auth?: string) => {
    const r = await fetch(url + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }).catch(() => null);
    return { ok: !!r?.ok, status: r?.status ?? 0, json: (await r?.json().catch(() => ({}))) as any };
  };
  const email = (prompt("owner email:") ?? "").trim();
  if (!email) return null;
  const s = await post("/api/auth/start", { email });
  if (!s.ok) { console.error(`login failed (${s.status}): ${s.json?.error ?? ""}`); return null; }
  const code = (prompt("code from the email:") ?? "").trim();
  const v = await post("/api/auth/verify", { email, code });
  if (!v.ok || !v.json?.session) { console.error(`verification failed (${v.status}): ${v.json?.error ?? ""}`); return null; }
  const j = await post("/api/host/join", { host }, v.json.session);
  await post("/api/auth/logout", {}, v.json.session); // the session was only needed to mint the machine token
  if (!j.ok || !j.json?.token) { console.error(`join failed (${j.status}): ${j.json?.error ?? ""}; or use: noop init ${url} --token <machine-token>`); return null; }
  return String(j.json.token);
}

/** `hub init [<hub-url>] [--token <machine-token>]` (the default): join an existing hub as a worker and mirror its data.
 *  `hub init --primary`: the fleet's one primary: deploy your own Worker, seed templates, push them.
 *  A host already set up as the primary (or already joined) keeps its role when init runs again. */
export async function init(opts: { worker?: string; token?: string; primary?: boolean } = {}) {
  const { commitPush, pull, loadConfig, hostName } = await import("./core");
  const { readHubToml, syncMode, writeHubToml } = await import("./sync");
  mkdirSync(DATA, { recursive: true });
  const me = machineName();
  const joined = readHubToml().cloud?.url;
  const primaryHere = existsSync(P("config.toml")) && new RegExp(`^\\s*primary\\s*=\\s*"${me}"`, "m").test(readFileSync(P("config.toml"), "utf8"));
  if (!opts.primary && !primaryHere) {
    const url = (opts.worker || joined || (prompt("your noop URL (e.g. https://noop.example.com; set up the first machine with --primary):") ?? "")).trim().replace(/\/$/, "");
    if (!url) { console.error("no noop URL: run init <noop-url>, or init --primary on the machine that hosts it"); process.exitCode = 1; return; }
    const token = opts.token ?? (url === joined ? readHubToml().server?.token : undefined) ?? await joinViaLogin(url, me);
    if (!token) return;
    writeHubToml({ cloud: { url }, server: { token } });
    if (!(await pull())) { console.error(`could not sync from ${url} (check the URL / token)`); process.exitCode = 1; return; }
    writeLocalConfig(me);
    console.log(`✔ joined ${url}; data mirrored to ${DATA}\n  next: hub install   (runs the daemon as a service)`);
    return;
  }
  if (await syncMode() === "remote") await pull(); // re-running init: start from what the Worker has
  seedTemplates();
  const cfgPath = P("config.toml");
  let cfg = readFileSync(cfgPath, "utf8");
  if (cfg.includes('primary = "__PRIMARY__"')) {
    cfg = cfg.replace('primary = "__PRIMARY__"', `primary = "${me}"`)
      .replace('# url = "__URL__"', `url = "http://${me}:8787"`);
    writeFileSync(cfgPath, cfg);
    console.log(`this host (${me}) is the fleet primary`);
  }
  // the machine token is the Worker's HUB_TOKEN; it stays machine-local (noop.toml), not in the shared data
  if (!readHubToml().server?.token && !loadConfig().server?.token) writeHubToml({ server: { token: crypto.randomUUID().replace(/-/g, "") } });
  writeLocalConfig(me);
  const c = loadConfig();
  if ((c.fleet?.primary ?? "") === hostName(c) && !c.cloud?.url && !process.env.HUB_SYNC && !process.env.HUB_SYNC_FAKE) {
    const { cloudDeploy } = await import("./cloud"); // the owner's own fixed endpoint on Cloudflare (free)
    await cloudDeploy(c);
    if (!readHubToml().cloud?.url) console.log("Worker not deployed yet; data stays local until you run: hub cloud deploy");
  }
  if (await syncMode() === "remote" && !(await commitPush(`[${me}] init`))) console.error("could not push the initial data; it will sync on the next daemon tick");
  console.log(`✔ data: ${DATA}\n  next: hub install   (runs the daemon as a service)`);
}

function writeLocalConfig(me: string) {
  if (!existsSync(P("config.local.toml")))
    writeFileSync(P("config.local.toml"), `# per-machine overrides & secrets (never synced)\n[host]\n# name = "${me}"\n# caps = []\n# max_parallel = 3\n\n[notify]\n# slack_bot_token = ""\n# discord_bot_token = ""\n`);
}

// ------------------------------------------------------------------ optional roles
const ROLES = join(CODE, "roles");
/** The optional specialists in roles/ (not seeded, so a new team stays small). */
export function listRoles() {
  return readdirSync(ROLES, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]{0,39}$/.test(d.name) && existsSync(join(ROLES, d.name, "profile.md"))).map(({ name: id }) => ({
    id, about: readFileSync(join(ROLES, id, "profile.md"), "utf8").split("\n")[0].replace(/^#\s*/, ""), installed: existsSync(P("agents", id, "profile.md")),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

type RoleRoutine = Record<string, unknown> & { name: string; every: string; enabled?: boolean };
function roleData(id: string) {
  const role = listRoles().find((r) => r.id === id);
  if (!role) throw new Error(`no optional role "${id}": see noop role list`);
  const file = join(ROLES, id, "routines.toml");
  const routines = existsSync(file) ? (Bun.TOML.parse(readFileSync(file, "utf8")) as { routine?: RoleRoutine[] }).routine ?? [] : [];
  if (!Array.isArray(routines) || routines.some((r) => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.name) || typeof r.every !== "string")) throw new Error("Invalid built-in role routines");
  return { ...role, profile: readFileSync(join(ROLES, id, "profile.md"), "utf8"), routines: routines.map((r) => ({ ...r, enabled: false as const })) };
}

/** Preview the shipped instructions; installing never replaces a profile the owner has already changed. */
export function readRole(id: string) {
  const role = roleData(id);
  return { ...role, routines: role.routines.map((r) => ({ name: String(r.name), every: String(r.every), enabled: false as const })) };
}

/** Adds an optional role without overwriting profiles or existing routines. New routines always start switched off. */
export function addRole(id: string): string[] {
  const role = roleData(id), file = P("config.toml");
  const config = role.routines.length ? readFileSync(file, "utf8") : "";
  const current = role.routines.length ? (Bun.TOML.parse(config) as { routine?: Record<string, unknown>[] }).routine ?? [] : [];
  const have = new Set(current.map((r) => r.name));
  const fresh = role.routines.filter((r) => { if (have.has(r.name)) return false; have.add(r.name); return true; });
  const next = `${config.trimEnd()}\n\n${fresh.map(renderRoutine).join("\n")}\n`;
  if (fresh.length && !Bun.deepEquals((Bun.TOML.parse(next) as any).routine, [...current, ...fresh])) throw new Error("Cannot safely add this role's routines");
  const preferencesFile = P("settings.json");
  const preferencesBefore = fresh.length && existsSync(preferencesFile) ? readFileSync(preferencesFile, "utf8") : null;
  const preferences = preferencesBefore === null ? {} : JSON.parse(preferencesBefore);
  let staleOverrides = false;
  // An old UI preference must not turn a newly installed routine back on.
  for (const routine of fresh) if (Object.hasOwn(preferences.routines ?? {}, routine.name)) { delete preferences.routines[routine.name]; staleOverrides = true; }
  const profile = P("agents", id, "profile.md"), profileTemp = `${profile}.${crypto.randomUUID()}.tmp`, configTemp = `${file}.${crypto.randomUUID()}.tmp`, preferencesTemp = `${preferencesFile}.${crypto.randomUUID()}.tmp`;
  let createdProfile = false, changedPreferences = false;
  // shortcut: separate file renames roll back errors; use durable receipts if crash recovery must be atomic.
  try {
    if (fresh.length) writeFileSync(configTemp, next, { flag: "wx", mode: 0o600 });
    if (staleOverrides) writeFileSync(preferencesTemp, JSON.stringify(preferences, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    mkdirSync(P("agents", id), { recursive: true });
    const needsProfile = !existsSync(profile);
    if (needsProfile) writeFileSync(profileTemp, role.profile, { flag: "wx", mode: 0o600 });
    if (staleOverrides) { renameSync(preferencesTemp, preferencesFile); changedPreferences = true; }
    if (needsProfile) {
      try { linkSync(profileTemp, profile); createdProfile = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (fresh.length) renameSync(configTemp, file);
  } catch (error) {
    if (createdProfile) rmSync(profile, { force: true });
    if (changedPreferences) {
      writeFileSync(preferencesTemp, preferencesBefore!, { flag: "wx", mode: 0o600 });
      renameSync(preferencesTemp, preferencesFile);
    }
    throw error;
  } finally { rmSync(profileTemp, { force: true }); rmSync(configTemp, { force: true }); rmSync(preferencesTemp, { force: true }); }
  return fresh.map((r) => String(r.name));
}

// ------------------------------------------------------------------ self-update
/** Fast-forward framework code if origin has new commits that pass tests. Returns true if updated. */
export async function selfUpdate(opts: { busy?: number; force?: boolean; deploy?: boolean } = {}): Promise<boolean> {
  // never swap code (and then restart) under running work: defer until this host is idle
  if ((opts.busy ?? 0) > 0 && !opts.force) return false;
  const g = (...a: string[]) => $`git ${a}`.cwd(CODE).quiet().nothrow();
  if (!existsSync(join(CODE, ".git"))) return false;
  if ((await g("status", "--porcelain", "--untracked-files=no")).stdout.toString().trim()) return false; // local edits → skip
  await g("fetch", "-q", "origin");
  const head = (await g("rev-parse", "HEAD")).stdout.toString().trim();
  const up = (await g("rev-parse", "@{u}")).stdout.toString().trim();
  if (!up || head === up) return false;
  // upstream history may have been rewritten (e.g. scrubbed); with no local edits, follow it — tests below still guard the switch
  if ((await g("merge-base", "--is-ancestor", "HEAD", "@{u}")).exitCode !== 0) {
    // diverged: follow upstream only when it already has every local commit's change (a rewrite); unpushed work stays
    if ((await g("cherry", "@{u}", "HEAD")).stdout.toString().split("\n").some((l) => l.startsWith("+"))) return false;
    await g("reset", "--hard", "-q", "@{u}");
  }
  else await g("merge", "--ff-only", "-q", "@{u}");
  const deps = await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
  const test = await $`bun test`.cwd(CODE).quiet().nothrow();
  if (deps.exitCode !== 0 || test.exitCode !== 0) {
    await g("reset", "--hard", "-q", head); // roll back a bad release
    await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
    console.error(`self-update to ${up.slice(0, 7)} failed tests → rolled back to ${head.slice(0, 7)}`);
    const { medic } = await import("./medic");
    const { loadConfig } = await import("./core");
    void medic(`self-update ${head.slice(0, 7)} → ${up.slice(0, 7)} failed (deps exit ${deps.exitCode}, tests exit ${test.exitCode}); rolled back.\n${test.stdout.toString().slice(-3000)}${test.stderr.toString().slice(-3000)}`,
      loadConfig(), { auto: true, kind: "update" });
    return false;
  }
  seedTemplates(); // new template agents/policies appear; existing ones untouched
  { // primary keeps its own Cloudflare hub in step with the code (Worker or app changed)
    const { loadConfig, hostName } = await import("./core");
    const c = loadConfig();
    const changed = (await g("diff", "--name-only", head, up)).stdout.toString();
    if (c.cloud?.url && c.fleet?.primary === hostName(c) && (opts.deploy || /^(cloud|app)\//m.test(changed))) {
      const { cloudDeploy } = await import("./cloud");
      await cloudDeploy(c);
    }
  }
  console.log(`self-updated ${head.slice(0, 7)} → ${up.slice(0, 7)}`);
  return true;
}

// ------------------------------------------------------------------ service install
/** Machines installed before the rename keep their service name. */
export const SERVICE = existsSync(join(homedir(), ".config/systemd/user/agent-hub.service")) || existsSync(join(homedir(), "Library/LaunchAgents/com.agent-hub.daemon.plist")) ? "agent-hub" : "noop";
const LABEL = SERVICE === "agent-hub" ? "com.agent-hub.daemon" : "dev.noop.daemon";
export async function install() {
  const bun = Bun.which("bun") ?? join(homedir(), ".bun/bin/bun");
  const cli = join(CODE, "src", "cli.ts");
  const path = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), join(homedir(), "go/bin"), join(homedir(), ".local/share/mise/shims"),
    join(homedir(), ".local/share/mise/command-wrappers/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  if (process.platform === "linux") {
    const unit = join(homedir(), `.config/systemd/user/${SERVICE}.service`);
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, `[Unit]
Description=Noop fleet daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bun} ${cli} daemon
Restart=always
RestartSec=10
# stopping lets running agents finish (the daemon drains), so a restart never throws work away.
# The stop timeout must outlast the longest agent run (clis.timeout_minutes, default 60), or systemd
# SIGKILLs the agents mid-run and the restarted daemon redoes them.
KillMode=mixed
TimeoutStopSec=90min
Environment=PATH=${path}
Environment=HUB_DATA=${DATA}
Nice=5
# keep the box awake while the fleet runs
ExecStartPre=-/usr/bin/true

[Install]
WantedBy=default.target
`);
    await $`systemctl --user daemon-reload`.nothrow();
    await $`systemctl --user enable --now ${SERVICE}.service`.nothrow();
    await $`loginctl enable-linger ${process.env.USER ?? ""}`.nothrow(); // run without a login session / monitor
    console.log(`✔ systemd user service installed: ${unit}
  logs:   journalctl --user -u ${SERVICE} -f
  24/7:   linger enabled (runs with no one logged in). To prevent sleep on this always-on box:
          sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`);
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${bun}</string><string>${cli}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HUB_DATA</key><string>${DATA}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
</dict></plist>
`);
    mkdirSync(join(DATA, "logs"), { recursive: true });
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    await $`launchctl bootstrap gui/${process.getuid!()} ${plist}`.nothrow();
    console.log(`✔ launchd agent installed: ${plist} (caffeinate -i keeps it awake while plugged in; when the lid closes the fleet simply continues without this Mac)`);
  } else if (process.platform === "win32") {
    const cmd = `"${bun}" "${cli}" daemon`;
    await $`schtasks /Create /F /SC ONLOGON /RL LIMITED /TN ${SERVICE} /TR ${cmd}`.nothrow();
    await $`schtasks /Run /TN ${SERVICE}`.nothrow();
    console.log("✔ Scheduled Task '${SERVICE}' installed (runs at logon, restarts with the daemon's own loop). Disable sleep: powercfg /change standby-timeout-ac 0");
  }
}
