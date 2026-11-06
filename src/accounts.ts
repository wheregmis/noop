// Multi-account rotation for Claude Code / Codex + remote-assisted login via Slack/Discord.
// Accounts are per machine (credentials never enter the shared data repo):
//   ~/.noop/accounts/<cli>-<name>/   → CLAUDE_CONFIG_DIR or CODEX_HOME for that account
//   ~/.noop/accounts/state.json      → cooldowns, auth status, pending logins
import { existsSync, linkSync, lstatSync, realpathSync, statSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Cfg, hostName, journal, HOME_DIR, loadConfig, setAccountAvailability } from "./core";
import { notify } from "./notify";
import { enabledProviders, providerAvailable } from "./providers";
import { PROVIDER_IDS } from "../cloud/src/providers";
import { printableAccountName } from "../cloud/src/machine-requests";

const HOME = join(HOME_DIR, "accounts");
const STATE = join(HOME, "state.json");
const LEGACY_STATE = join(HOME, "state.before-sources.json");
const CONFIG = join(HOME, "config.json");

export type Account = { cli: string; name: string; dir: string; default?: boolean };
export class AccountSourceError extends Error {
  constructor() { super("This account's credential source changed or is unavailable. Reload accounts before signing in or starting work."); }
}
type AState = { source?: string; cooldown_until?: string; needs_login?: boolean; last_error?: string; login_id?: string; token?: string; cred?: number; told?: string; verified_at?: string };
type State = { accounts: Record<string, AState>; seq: number; alerted?: Record<string, string> };

const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { accounts: {}, seq: 0 });
function saveLocal(file: string, value: unknown) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
const save = (s: State) => saveLocal(STATE, s);
export const validAccountName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name);
function accountConfig(): Record<string, string[]> {
  const value = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([cli, names]) => !PROVIDER_IDS.includes(cli) || !Array.isArray(names) || names.some((name) => !printableAccountName(name)))) throw new Error("Invalid local account selections");
  return value;
}
export function setAccountNames(cli: string, names: string[] | null) {
  if (!PROVIDER_IDS.includes(cli) || names !== null && (!Array.isArray(names) || names.some((name) => !printableAccountName(name)))) throw new Error("Invalid account selection");
  const local = accountConfig();
  if (names === null) delete local[cli]; else local[cli] = [...new Set(names)];
  saveLocal(CONFIG, local);
}
const key = (a: Account) => `${a.cli}-${a.name}`;
const sources = new WeakMap<Account, { home: string; fingerprint: string }>();
function credentialHome(directory: string): string {
  let parent = resolve(directory.replace(/^~(?=$|[/\\])/, homedir()));
  const missing: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(parent);
      if (!statSync(real).isDirectory()) throw new Error("An account credential home must be a directory");
      return join(real, ...missing);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      let exists = false;
      try { lstatSync(parent); exists = true; } catch (entry: any) { if (entry.code !== "ENOENT") throw entry; }
      if (exists) throw error;
      const next = dirname(parent); if (next === parent) throw error;
      missing.unshift(basename(parent)); parent = next;
    }
  }
}
function source(a: Account) {
  let value = sources.get(a);
  if (!value) {
    const directory = a.default ? a.cli === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
      : a.cli === "codex" ? process.env.CODEX_HOME ?? join(homedir(), ".codex") : process.env.HERMES_HOME ?? join(homedir(), ".hermes") : a.dir;
    const home = credentialHome(directory);
    value = { home, fingerprint: createHash("sha256").update(JSON.stringify([a.cli, a.default === true, home])).digest("hex") };
    sources.set(a, value);
  }
  return value;
}
const capture = (a: Account): Account => { try { source(a); } catch { /* Invalid homes remain removable; execution fails closed. */ } return a; };
const identity = (a: Account) => `${key(a)}:${source(a).fingerprint}`;
function currentSource(a: Account): boolean {
  try {
    const current = accounts(loadConfig(), a.cli).find((item) => item.name === a.name);
    return !!current && source(current).fingerprint === source(a).fingerprint;
  } catch { return false; }
}
function preserveLegacyState(all: State) {
  const legacy = Object.entries(all.accounts).filter(([, entry]) => !(typeof entry.source === "string" && /^[a-f0-9]{64}$/.test(entry.source)) && Object.keys(entry).length);
  if (!legacy.length) return;
  if (!existsSync(LEGACY_STATE)) {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const temporary = `${LEGACY_STATE}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, readFileSync(STATE, "utf8"), { flag: "wx", mode: 0o600 });
      try { linkSync(temporary, LEGACY_STATE); } catch (error: any) { if (error.code !== "EEXIST") throw error; }
    } finally { rmSync(temporary, { force: true }); }
  }
  const info = lstatSync(LEGACY_STATE);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("The private legacy account backup could not be verified; cached credentials were kept unchanged");
  const backup = JSON.parse(readFileSync(LEGACY_STATE, "utf8"));
  const same = (a: object, b: object) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  if (!backup || typeof backup !== "object" || !backup.accounts || typeof backup.accounts !== "object" || Array.isArray(backup.accounts)
    || legacy.some(([name, entry]) => !backup.accounts[name] || !same(entry, backup.accounts[name])))
    throw new Error("The private legacy account backup does not match the cached credentials; they were kept unchanged");
}
/** Bind cached credentials to their exact selected source; old runs must never rebind a replacement account. */
function accountState(a: Account, all = load()): AState | undefined {
  if (!currentSource(a)) return;
  const fingerprint = source(a).fingerprint;
  if (all.accounts[key(a)]?.source !== fingerprint) {
    preserveLegacyState(all);
    all.accounts[key(a)] = { source: fingerprint };
    save(all);
    for (const item of pending.values()) if (item.account === key(a) && item.source !== fingerprint) {
      item.stop = "cancelled"; item.view = { id: item.view.id, needs_code: item.view.needs_code, expires: item.view.expires, status: "cancelled" }; item.proc.kill();
    }
  }
  return all.accounts[key(a)]!;
}

function managedDirectory(cli: string, name: string): string {
  const basename = validAccountName(name) ? `${cli}-${name}` : `${cli}-legacy-${createHash("sha256").update(name).digest("hex")}`;
  return join(HOME, basename);
}

/** File-defined accounts, or the CLI's normal login when none are configured. */
export function fileAccounts(cfg: Cfg, cli: string): Account[] {
  const configured: Account[] = (cfg.accounts ?? []).filter((a: Account) => a.cli === cli)
    .map((a: Account) => {
      // Keep existing nested homes too, provided resolution stays inside the local account folder.
      const candidate = resolve(HOME, `${a.cli}-${a.name}`), within = relative(HOME, candidate);
      const safe = within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within) && within.split(sep).every((part) => Buffer.byteLength(part) <= 240);
      return { ...a, dir: (a.dir ?? (safe ? candidate : managedDirectory(a.cli, a.name))).replace(/^~/, homedir()) };
    });
  return configured.length ? configured : [{ cli, name: "default", dir: "", default: true }];
}

/** A local UI selection overrides only that tool; other tools keep following the files. */
export function accounts(cfg: Cfg, cli: string): Account[] {
  const configured = fileAccounts(cfg, cli), local = accountConfig();
  // A file-defined account may itself be named "default"; selection must not redirect its credentials.
  if (Object.hasOwn(local, cli)) return local[cli]!.map((name) => capture(configured.find((a) => a.name === name)
    ?? (name === "default" ? { cli, name, dir: "", default: true } : { cli, name, dir: managedDirectory(cli, name) })));
  return configured.map(capture);
}

/** When the CLI's login was last written: a new login (another account) changes it. */
function credStamp(a: Account): number {
  const dir = source(a).home;
  const files = a.cli === "hermes" ? ["auth.json", ".env", "config.yaml"] : [a.cli === "claude" ? ".credentials.json" : "auth.json"];
  return Math.max(0, ...files.map((name) => { try { return statSync(join(dir, name)).mtimeMs; } catch { return 0; } }));
}

export function usable(a: Account): boolean {
  const all = load();
  const s = accountState(a, all);
  if (!s) return false;
  if ((s.needs_login || s.cooldown_until) && s.cred && credStamp(a) > s.cred) {
    // the owner logged in again (maybe another account): try it right away instead of waiting out the old limit
    all.accounts[key(a)] = { ...s, needs_login: false, cooldown_until: undefined, cred: undefined, told: undefined, verified_at: undefined };
    save(all);
    return true;
  }
  if (s.needs_login) return false;
  return !s.cooldown_until || Date.parse(s.cooldown_until) < Date.now();
}

/** Pick an available (cli, account) honoring preference order. */
export function pickAccount(cfg: Cfg, clis: string[]): Account | null {
  for (const cli of clis) for (const a of accounts(cfg, cli)) if (usable(a)) return a;
  return null;
}

/** Retry within the current provider order and each provider's selected account order. */
export function failoverAccount(cfg: Cfg, failed: Account | null, wanted: string[], installed: (cli: string) => boolean = (cli) => !!Bun.which(cli)): Account | null {
  const allowed = wanted.filter((cli) => enabledProviders(cfg).includes(cli) && installed(cli));
  for (const cli of allowed) for (const account of accounts(cfg, cli)) if (usable(account) && !(failed && key(account) === key(failed))) return account;
  return null;
}

export function accountEnv(a: Account): Record<string, string> {
  const state = accountState(a);
  if (!state) throw new AccountSourceError();
  const env: Record<string, string> = {};
  if (a.cli === "claude") {
    const token = state.token;
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
  const variable = a.cli === "claude" ? "CLAUDE_CONFIG_DIR" : a.cli === "codex" ? "CODEX_HOME" : "HERMES_HOME";
  if (a.default) { if (process.env[variable] !== undefined) env[variable] = source(a).home; return env; }
  mkdirSync(source(a).home, { recursive: true, mode: 0o700 });
  env[variable] = source(a).home;
  if (a.cli === "claude") env.CLAUDE_CODE_OAUTH_TOKEN ??= "";
  return env;
}

/** Only an observed authenticated run or completed login marks an account signed in. */
export function markAccountSuccess(a: Account) {
  const all = load();
  const state = accountState(a, all); if (!state) return;
  all.accounts[key(a)] = { ...state, verified_at: new Date().toISOString(), needs_login: false, cooldown_until: undefined, last_error: undefined };
  save(all);
}

// ------------------------------------------------------------------ failure classification
const QUOTA = /usage limit|rate[ -]?limit|limit reached|quota|credit balance is too low|too many requests|\b429\b|overloaded|hit your .*limit|try again (at|in)/i;
const AUTH = /not logged in|please run \/login|invalid api key|authentication[_ ]error|\b401\b|oauth token (has )?expired|login required|unauthorized|codex login/i;

export type Failure = "quota" | "auth" | null;

export function classify(output: string): Failure {
  const tail = output.slice(-4000);
  if (AUTH.test(tail)) return "auth";
  if (QUOTA.test(tail)) return "quota";
  return null;
}

/** Try to read the reset time from messages like "resets at 3pm", "try again in 2h 13m". */
function resetTime(output: string): Date {
  const m = output.match(/\bin\s+(?=\d)(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (m && (m[1] || m[2])) return new Date(Date.now() + ((+m[1] || 0) * 60 + (+m[2] || 0) + 2) * 60_000);
  const at = output.match(/(?:resets?|again) at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let h = +at[1] % 12 + (at[3]?.toLowerCase() === "pm" ? 12 : at[3] ? 0 : +at[1] >= 12 ? 12 : 0);
    if (!at[3]) h = +at[1];
    const d = new Date(); d.setHours(h, +(at[2] ?? 0) + 2, 0, 0);
    if (d < new Date()) d.setDate(d.getDate() + 1);
    return d;
  }
  return new Date(Date.now() + 60 * 60_000);
}

export async function reportFailure(a: Account, kind: Failure, output: string, cfg: Cfg) {
  if (!kind) return;
  const s = load();
  const st = accountState(a, s); if (!st) return;
  const host = hostName(cfg);
  st.last_error = output.slice(-300);
  st.cred = credStamp(a);
  if (kind === "quota") {
    st.cooldown_until = resetTime(output).toISOString();
    journal(host, `${key(a)} hit usage limit → cooldown until ${st.cooldown_until.slice(11, 16)}Z`);
    if (st.told !== st.cooldown_until) {
      st.told = st.cooldown_until;
      const others = enabledProviders(cfg).filter((c) => c !== a.cli && Bun.which(c) && accounts(cfg, c).some(usable));
      const at = new Date(st.cooldown_until).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      void notify([`${a.cli === "claude" ? "Claude" : a.cli === "hermes" ? "Hermes" : "Codex"}(${host}) hit its usage limit; back around ${at}.`,
        others.length ? `Other eligible tasks can use ${others.join(", ")}.` : "No AI is available meanwhile; tasks will queue.",
        `To resume now: run ${a.cli === "claude" ? "claude /login" : a.cli === "hermes" ? "hermes model" : "codex login"} on this machine with another account; it picks up automatically after you sign in.`].join("\n"),
        cfg, { kind: "notice" });
    }
  } else {
    st.needs_login = true; st.verified_at = undefined;
    journal(host, `🔑 ${key(a)} needs login`);
  }
  const fresh = load();
  if (!currentSource(a) || fresh.accounts[key(a)]?.source !== source(a).fingerprint) return;
  fresh.accounts[key(a)] = st; save(fresh);
  if (kind === "auth" && a.cli !== "hermes") await startLogin(a, cfg);
  else if (kind === "auth") await notify(`Hermes on ${host} needs authentication. Complete its native model setup, or select another available execution tool in Settings → AI tools & onboarding.`, cfg, { kind: "notice" });
  await alertIfAllExhausted(loadConfig());
}

async function alertIfAllExhausted(cfg: Cfg) {
  const clis = enabledProviders(cfg);
  const installed = clis.filter((c) => Bun.which(c));
  if (pickAccount(cfg, installed)) return;
  const s = load();
  const last = s.alerted?.all ? Date.parse(s.alerted.all) : 0;
  if (Date.now() - last < 3 * 3600_000) return;
  (s.alerted ??= {}).all = new Date().toISOString();
  save(s);
  const lines = installed.flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = accountState(a) ?? {};
    return `• ${key(a)}: ${st.needs_login ? "needs sign-in" : st.cooldown_until ? `usage limit hit, back around ${new Date(st.cooldown_until).toLocaleTimeString()}` : "?"}`;
  });
  await notify([`All AI accounts on ${hostName(cfg)} are unavailable; the fleet is paused:`, ...lines,
    `You can reply with a login code to finish a pending sign-in, or add an account under [[accounts]] in config.local.toml.`].join("\n"), cfg);
}

// ------------------------------------------------------------------ remote-assisted login
export type LoginView = { id: string; url?: string; user_code?: string; needs_code: boolean; expires: string; status: "starting" | "waiting" | "submitted" | "complete" | "failed" | "cancelled" | "expired" };
type Pending = { account: string; source: string; ref: Account; proc: ReturnType<typeof Bun.spawn>; view: LoginView; stop?: "cancelled" | "expired" };
const pending = new Map<string, Pending>();
const recentLogin = new Map<string, LoginView>();
const activeLogin = (p: Pending) => {
  if (p.stop || Date.parse(p.view.expires) <= Date.now()) return false;
  if (currentSource(p.ref)) return true;
  p.stop = "cancelled"; p.view = { id: p.view.id, needs_code: p.view.needs_code, expires: p.view.expires, status: "cancelled" }; p.proc.kill(); return false;
};
export function loginInfo(a: Account): LoginView | undefined {
  if (!currentSource(a)) return;
  const p = [...pending.values()].find((item) => item.account === key(a) && item.source === source(a).fingerprint);
  const view = p?.view ?? recentLogin.get(identity(a));
  return view ? { ...view } : undefined;
}
export const hasPendingLogin = (a: Account) => { try { return [...pending.values()].some((p) => p.account === key(a) && p.source === source(a).fingerprint); } catch { return false; } };

function loginCommand(a: Account): { cmd: string[]; needsCode: boolean } {
  if (a.cli === "codex") return { cmd: ["codex", "login", "--device-auth"], needsCode: false };
  return { cmd: ["claude", "setup-token"], needsCode: true };
}

/** Wrap in `script` so TUIs think they have a terminal (headless box, no monitor). */
function withPty(cmd: string[]): string[] {
  const q = cmd.map((c) => `'${c}'`).join(" ");
  if (process.platform === "linux" && Bun.which("script")) return ["script", "-qfec", q, "/dev/null"];
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", ...cmd];
  return cmd;
}

function loginUrl(buffer: string, cli: string): string | undefined {
  for (const match of buffer.matchAll(/https:\/\/[^\s<>"']+/g)) try {
    const url = new URL(match[0].replace(/[),.;]+$/, ""));
    const hosts = cli === "claude" ? ["claude.ai", "anthropic.com"] : ["openai.com", "chatgpt.com"];
    if (!url.username && !url.password && hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      && !/sk-ant-|access_token|refresh_token|api_key/i.test(url.href)) return url.href;
  } catch { /* ignore incomplete output until its next chunk */ }
}

export async function startLogin(a: Account, cfg: Cfg, opts: { notify?: boolean } = {}): Promise<string> {
  if (a.cli === "hermes") throw new Error("Hermes authentication uses its native model setup");
  if (!["claude", "codex"].includes(a.cli)) throw new Error("Unsupported AI tool");
  const s = load(), bound = accountState(a, s);
  if (!bound) throw new AccountSourceError();
  const k = key(a), existing = [...pending.values()].find((p) => p.account === k && p.source === source(a).fingerprint);
  if (existing) return existing.view.id;
  const id = `L-${BigInt(`0x${randomBytes(16).toString("hex")}`).toString().padStart(39, "0")}`;
  lastLoginTry.set(identity(a), Date.now());
  const { cmd, needsCode } = loginCommand(a);
  const proc = Bun.spawn(withPty(cmd), {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...accountEnv(a), BROWSER: "/bin/false", TERM: "xterm-256color", COLUMNS: "500" },
  });
  s.accounts[k] = { ...(s.accounts[k] ?? {}), login_id: id };
  try { save(s); } catch (error) { proc.kill(); throw error; }
  const item: Pending = { account: k, source: source(a).fingerprint, ref: a, proc, view: { id, needs_code: needsCode, expires: new Date(Date.now() + 30 * 60_000).toISOString(), status: "starting" } };
  pending.set(id, item); recentLogin.delete(identity(a));
  let buffer = "", sent = false, token = "";
  const host = hostName(cfg);
  const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
  const onData = async (chunk: string) => {
    buffer = (buffer + strip(chunk)).slice(-32_000);
    const url = loginUrl(buffer, a.cli), code = a.cli === "codex" ? buffer.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1] : undefined;
    if (url && activeLogin(item)) {
      item.view.url = url; item.view.user_code = code;
      if (item.view.status === "starting") item.view.status = "waiting";
      if (!sent && (needsCode || code)) {
        sent = true;
        if (opts.notify !== false) await notify([
          `🔑 *${id}* · ${a.cli} account "${a.name}" on ${host} needs to sign in again`, `1. Open: ${url}`,
          code ? `2. Enter the device code: \`${code}\` (it takes effect automatically, no reply needed)` : `2. After signing in, reply with the authorization code the page shows: \`${id} <code>\``,
        ].join("\n"), cfg);
      }
    }
    token = buffer.match(/\b(sk-ant-oat[\w-]+)/)?.[1] ?? token;
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) await onData(dec.decode(chunk, { stream: true }));
    await onData(dec.decode());
  };
  const streams = Promise.all([pump(proc.stdout as ReadableStream), pump(proc.stderr as ReadableStream)]);
  const timer = setTimeout(() => { if (pending.has(id)) { item.stop = "expired"; item.view = { id, needs_code: needsCode, expires: item.view.expires, status: "expired" }; proc.kill(); } }, 30 * 60_000);
  timer.unref();
  void (async () => {
    const exit = await proc.exited;
    await streams;
    const st = load(), state = accountState(a, st);
    if (!state || state.source !== item.source) return;
    const ok = !item.stop && exit === 0 && (a.cli !== "claude" || !!token);
    if (ok && token) (st.accounts[k] ??= {}).token = token;
    st.accounts[k] = { ...st.accounts[k], login_id: undefined, ...(!item.stop ? { needs_login: !ok, cooldown_until: undefined, verified_at: ok ? new Date().toISOString() : undefined } : {}) };
    save(st);
    item.view = { id, needs_code: needsCode, expires: item.view.expires, status: item.stop ?? (ok ? "complete" : "failed") };
    recentLogin.set(identity(a), item.view);
    if (opts.notify !== false) {
      journal(host, ok ? `${k} logged in (${id})` : `${k} login ${id} ended`);
      await notify(ok ? `${k} signed in; the fleet is running again` : `${id} sign-in didn't finish; start sign-in again when ready`, cfg);
    }
  })().catch((error) => { console.error("account login failed", error); recentLogin.set(identity(a), { id, needs_code: needsCode, expires: item.view.expires, status: "failed" }); })
    .finally(() => { clearTimeout(timer); pending.delete(id); });
  return id;
}

export const pendingLoginIds = () => new Set([...pending].filter(([, p]) => activeLogin(p)).map(([id]) => id));

export function submitLoginCode(id: string, code: string, account?: Account): boolean {
  const p = pending.get(id);
  if (!p || !activeLogin(p) || !p.view.needs_code || account && (p.account !== key(account) || p.source !== source(account).fingerprint) || typeof code !== "string" || !code.trim() || code.length > 8192 || /[\r\n\0]/.test(code)) return false;
  const stdin = p.proc.stdin as import("bun").FileSink;
  stdin.write(code.trim() + "\r"); stdin.flush(); p.view.status = "submitted";
  return true;
}

export function cancelLogin(a: Account, id: string): boolean {
  const p = pending.get(id);
  try { if (!p || p.account !== key(a) || p.source !== source(a).fingerprint) return false; } catch { return false; }
  p.stop = "cancelled"; p.view = { id, needs_code: p.view.needs_code, expires: p.view.expires, status: "cancelled" }; p.proc.kill();
  return true;
}

/** Periodically retry logins for accounts still flagged (e.g. after an expired link). */
const lastLoginTry = new Map<string, number>();
export async function retryLogins(cfg: Cfg) {
  for (const cli of enabledProviders(cfg).filter((id) => id !== "hermes")) for (const a of accounts(cfg, cli)) {
    const st = accountState(a);
    if (!st) continue;
    // back off: a login that exits immediately would otherwise send a new link every tick
    if (Date.now() - (lastLoginTry.get(identity(a)) ?? 0) < 30 * 60_000) continue;
    if (st?.needs_login && !pending.size && Bun.which(cli)) { lastLoginTry.set(identity(a), Date.now()); await startLogin(a, cfg); }
  }
}

/** Structured account states for this machine (the app's machine page). */
export function accountStatus(a: Account): { state: "unknown" | "ok" | "cooldown" | "login"; until?: string } {
  const st = accountState(a) ?? {};
  const cool = !!st.cooldown_until && Date.parse(st.cooldown_until) > Date.now();
  return { state: hasPendingLogin(a) || st.needs_login ? "login" : cool ? "cooldown" : st.verified_at ? "ok" : "unknown", until: cool ? st.cooldown_until : undefined };
}
export function accountsInfo(cfg: Cfg): { cli: string; name: string; state: "unknown" | "ok" | "cooldown" | "login"; until?: string }[] {
  return PROVIDER_IDS.filter(providerAvailable).flatMap((cli) => accounts(cfg, cli)).map((a) => ({ cli: a.cli, name: a.name, ...accountStatus(a) }));
}

export function accountsStatus(cfg: Cfg): string[] {
  const s = load();
  return PROVIDER_IDS.filter(providerAvailable).flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = accountState(a, s) ?? {};
    const state = st.needs_login ? "needs login" : st.cooldown_until && Date.parse(st.cooldown_until) > Date.now()
      ? `cooldown → ${new Date(st.cooldown_until).toLocaleTimeString()}` : st.verified_at ? "ok" : "not checked";
    return `${key(a).padEnd(20)} ${state}`;
  });
}

export function accountCanRun(cli: string, cfg: Cfg): boolean { return pickAccount(cfg, [cli]) !== null; }
setAccountAvailability(accountCanRun);
