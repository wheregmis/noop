// Multi-account rotation for Claude Code / Codex + remote-assisted login via Slack/Discord.
// Accounts are per machine (credentials never enter the shared data repo):
//   ~/.noop/accounts/<cli>-<name>/   → CLAUDE_CONFIG_DIR or CODEX_HOME for that account
//   ~/.noop/accounts/state.json      → cooldowns, auth status, pending logins
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cfg, L, hostName, journal, HOME_DIR } from "./core";
import { notify } from "./notify";

const HOME = join(HOME_DIR, "accounts");
const STATE = join(HOME, "state.json");

export type Account = { cli: string; name: string; dir: string; default?: boolean };
type AState = { cooldown_until?: string; needs_login?: boolean; last_error?: string; login_id?: string; token?: string; cred?: number; told?: string };
type State = { accounts: Record<string, AState>; seq: number; alerted?: Record<string, string> };

const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { accounts: {}, seq: 0 });
const save = (s: State) => { mkdirSync(HOME, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 }); };
const key = (a: Account) => `${a.cli}-${a.name}`;

/** Configured accounts; a CLI with none configured uses its normal default login. */
export function accounts(cfg: Cfg, cli: string): Account[] {
  const list: Account[] = (cfg.accounts ?? []).filter((a: Account) => a.cli === cli)
    .map((a: Account) => ({ ...a, dir: (a.dir ?? join(HOME, `${a.cli}-${a.name}`)).replace(/^~/, homedir()) }));
  return list.length ? list : [{ cli, name: "default", dir: "", default: true }];
}

/** Claude Code can authenticate through an API gateway instead of an Anthropic OAuth login: the `env` block of
 *  settings.json (or the inherited environment) sets ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN. `claude
 *  setup-token` only performs the OAuth dance and cannot finish there, so an auth-shaped failure must not park
 *  the account behind a login link that can never complete. Returns what makes the account gateway-backed. */
export function gatewayAuth(dir: string, env: Record<string, string | undefined> = process.env): string | null {
  let fileEnv: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))?.env;
    if (parsed && typeof parsed === "object") fileEnv = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {}
  const merged = { ...fileEnv, ...env };
  if (merged.ANTHROPIC_AUTH_TOKEN) return "auth-token";
  if (merged.ANTHROPIC_API_KEY) return "api-key";
  const base = merged.ANTHROPIC_BASE_URL;
  return base && !/^https?:\/\/api\.anthropic\.com(\/|$)/.test(base) ? "base-url" : null;
}

function usesGateway(a: Account): boolean {
  if (a.cli !== "claude") return false;
  return !!gatewayAuth(a.default ? join(homedir(), ".claude") : a.dir);
}

/** When the CLI's login was last written: a new login (another account) changes it. */
function credStamp(a: Account): number {
  const dir = a.default ? join(homedir(), a.cli === "claude" ? ".claude" : ".codex") : a.dir;
  const f = join(dir, a.cli === "claude" ? ".credentials.json" : "auth.json");
  try { return statSync(f).mtimeMs; } catch { return 0; }
}

export function usable(a: Account): boolean {
  const all = load();
  const s = all.accounts[key(a)] ?? {};
  if ((s.needs_login || s.cooldown_until) && s.cred && credStamp(a) > s.cred) {
    // the owner logged in again (maybe another account): try it right away instead of waiting out the old limit
    all.accounts[key(a)] = { ...s, needs_login: false, cooldown_until: undefined, cred: undefined, told: undefined };
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

const OTHER_CLI: Record<string, string> = { claude: "codex", codex: "claude" };

/** After `failed` hit a quota/login wall (or nothing in `wanted` is usable when failed is null):
 *  another usable account of the same CLI first, else the other CLI (codex <-> claude) — for any agent. */
export function failoverAccount(cfg: Cfg, failed: Account | null, wanted: string[], installed: (cli: string) => boolean = (c) => !!Bun.which(c)): Account | null {
  const same = failed ? [failed.cli] : wanted;
  const first = same.filter(installed);
  for (const cli of first) for (const a of accounts(cfg, cli)) if (usable(a) && !(failed && key(a) === key(failed))) return a;
  const others = [...new Set(same.map((c) => OTHER_CLI[c]).filter((c) => c && !first.includes(c) && installed(c)))];
  return pickAccount(cfg, others);
}

export function accountEnv(a: Account): Record<string, string> {
  const env: Record<string, string> = {};
  if (a.default) return env;
  mkdirSync(a.dir, { recursive: true });
  if (a.cli === "claude") {
    env.CLAUDE_CONFIG_DIR = a.dir;
    const tok = load().accounts[key(a)]?.token;
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  if (a.cli === "codex") env.CODEX_HOME = a.dir;
  return env;
}

// ------------------------------------------------------------------ failure classification
// "try again at/in <time>" is a quota reset hint. A vague "try again in a moment" is what a gateway 5xx says
// ("a server-side issue, usually temporary"): counting it as quota put the account on a one-hour cooldown
// and moved all its work to the other CLI over a blip.
const QUOTA = /usage limit|rate[ -]?limit|limit reached|quota|credit balance is too low|no credits remaining|add credits to continue|too many requests|\b429\b|overloaded|hit your .*limit|try again (at|in)(?! (?:a|a few|some) (?:moments?|bit|while|seconds?|minutes?)\b)/i;
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
  const st = (s.accounts[key(a)] ??= {});
  const host = hostName(cfg);
  st.last_error = output.slice(-300);
  st.cred = credStamp(a);
  const gateway = kind === "auth" && usesGateway(a);
  if (kind === "quota") {
    st.cooldown_until = resetTime(output).toISOString();
    journal(host, `${key(a)} hit usage limit → cooldown until ${st.cooldown_until.slice(11, 16)}Z`);
    if (st.told !== st.cooldown_until) {
      st.told = st.cooldown_until;
      const others = (cfg.clis?.preference ?? ["claude", "codex"]).filter((c: string) => c !== a.cli && Bun.which(c) && accounts(cfg, c).some(usable));
      const at = new Date(st.cooldown_until).toLocaleTimeString(L("en-US", "zh-CN"), { hour: "2-digit", minute: "2-digit" });
      void notify([L(`${a.cli === "claude" ? "Claude" : "Codex"} (${host}) is out of quota, back around ${at}.`, `${a.cli === "claude" ? "Claude" : "Codex"}（${host}）额度用完了，约 ${at} 恢复。`),
        others.length ? L(`Until then tasks go to ${others.join(", ")}.`, `这期间任务先交给 ${others.join("、")} 做。`) : L("No AI is available until then, tasks will queue.", "这期间没有可用的 AI，任务会排队等着。"),
        L(`To recover now: run ${a.cli === "claude" ? "claude /login" : "codex login"} on this machine to switch account; it is picked up automatically.`, `想马上恢复：在这台机器上运行 ${a.cli === "claude" ? "claude /login" : "codex login"} 换个账号，登录后会自动接着用，不用等。`)].join("\n"),
        cfg, { kind: "notice" });
    }
  } else if (gateway) {
    // Gateway/API-key auth has no OAuth login to refresh. Retrying `claude setup-token` against a gateway 401s,
    // which used to mail a dead login link every 30 minutes while parking the account forever.
    st.needs_login = false;
    st.cooldown_until = new Date(Date.now() + 60 * 60_000).toISOString();
    const day = new Date().toISOString().slice(0, 10);
    if (st.told !== `gateway:${day}`) {
      st.told = `gateway:${day}`;
      journal(host, `${key(a)} gateway auth failed → cooldown 1h (no OAuth login for gateway accounts)`);
      void notify([L(`Claude (${host}) uses an API gateway (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN) and the gateway rejected the token. Tasks go to Codex for now. No login link will be sent: fix the gateway or the token in ~/.claude/settings.json.`,
        `Claude（${host}）使用 API 网关鉴权（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN），网关拒绝了令牌，任务暂时交给 Codex。这里不适用 OAuth 登录，不会再发登录链接；请检查网关是否在运行，以及 ~/.claude/settings.json 里的令牌。`)].join("\n"), cfg, { kind: "notice" });
    }
  } else {
    st.needs_login = true;
    journal(host, `🔑 ${key(a)} needs login`);
  }
  save(s);
  if (kind === "auth" && !gateway) await startLogin(a, cfg);
  await alertIfAllExhausted(cfg);
}

async function alertIfAllExhausted(cfg: Cfg) {
  const clis: string[] = cfg.clis?.preference ?? ["claude", "codex"];
  const installed = clis.filter((c) => Bun.which(c));
  if (pickAccount(cfg, installed)) return;
  const s = load();
  const last = s.alerted?.all ? Date.parse(s.alerted.all) : 0;
  if (Date.now() - last < 3 * 3600_000) return;
  (s.alerted ??= {}).all = new Date().toISOString();
  save(s);
  const lines = installed.flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = load().accounts[key(a)] ?? {};
    return L(`• ${key(a)}: ${st.needs_login ? "needs login" : st.cooldown_until ? `out of quota, back around ${new Date(st.cooldown_until).toLocaleTimeString()}` : "?"}`, `• ${key(a)}：${st.needs_login ? "需要登录" : st.cooldown_until ? `额度用尽，约 ${new Date(st.cooldown_until).toLocaleTimeString()} 恢复` : "?"}`);
  });
  await notify([L(`All AI accounts on ${hostName(cfg)} are unavailable, the fleet is paused:`, `${hostName(cfg)} 上所有 AI 账户都不可用，fleet 暂停中：`), ...lines,
    L(`Options: reply with a login code to finish a pending login, or add an account under [[accounts]] in config.local.toml.`, `可以：回复登录码完成待登录账户，或在 config.local.toml 的 [[accounts]] 加一个账户。`)].join("\n"), cfg);
}

// ------------------------------------------------------------------ remote-assisted login
type Pending = { id: string; account: string; proc: ReturnType<typeof Bun.spawn>; started: number };
const pending = new Map<string, Pending>();

function loginCommand(a: Account): { cmd: string[]; needsCode: boolean } {
  if (a.cli === "codex") return { cmd: ["codex", "login", "--device-auth"], needsCode: false };
  // claude setup-token prints an OAuth URL, waits for the pasted code, then prints a long-lived token
  return { cmd: ["claude", "setup-token"], needsCode: true };
}

/** Wrap in `script` so TUIs think they have a terminal (headless box, no monitor). */
function withPty(cmd: string[]): string[] {
  const q = cmd.map((c) => `'${c}'`).join(" ");
  if (process.platform === "linux" && Bun.which("script")) return ["script", "-qfec", q, "/dev/null"];
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", ...cmd];
  return cmd;
}

export async function startLogin(a: Account, cfg: Cfg) {
  const k = key(a);
  if ([...pending.values()].some((p) => p.account === k)) return;
  const s = load();
  const id = `L-${String(++s.seq).padStart(4, "0")}`;
  s.accounts[k] = { ...(s.accounts[k] ?? {}), login_id: id };
  save(s);
  const { cmd, needsCode } = loginCommand(a);
  const proc = Bun.spawn(withPty(cmd), {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...accountEnv(a), BROWSER: "/bin/false", TERM: "xterm-256color", COLUMNS: "500" },
  });
  pending.set(id, { id, account: k, proc, started: Date.now() });
  let buf = "";
  let sent = false;
  const host = hostName(cfg);
  const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
  const onData = async (chunk: string) => {
    buf += strip(chunk);
    const url = buf.match(/https:\/\/\S+/)?.[0];
    const code = buf.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1]; // device code (codex)
    if (url && !sent && (needsCode || code || buf.length > 2000 || /enter|code/i.test(buf))) {
      sent = true;
      await notify([
        L(`🔑 *${id}* · the ${a.cli} account "${a.name}" on ${host} needs to log in again`, `🔑 *${id}* · ${host} 上的 ${a.cli} 账户「${a.name}」需要重新登录`),
        L(`1. Open: ${url}`, `1. 打开：${url}`),
        code ? L(`2. Enter the device code: \`${code}\` (takes effect automatically, no reply needed)`, `2. 输入设备码：\`${code}\`（完成后会自动生效，无需回复）`) : L(`2. After logging in, reply with the code the page gives you: \`${id} <code>\``, `2. 登录后把页面给出的授权码回复：\`${id} <code>\``),
      ].join("\n"), cfg);
      journal(host, `🔑 ${id} login link sent for ${k}`);
    }
    const token = buf.match(/\b(sk-ant-oat[\w-]+)/)?.[1];
    if (token) { const st = load(); st.accounts[k] = { ...st.accounts[k], token }; save(st); }
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of stream) await onData(dec.decode(c));
  };
  void Promise.all([pump(proc.stdout as ReadableStream), pump(proc.stderr as ReadableStream)]);
  proc.exited.then(async (code) => {
    pending.delete(id);
    const st = load();
    const ok = code === 0;
    st.accounts[k] = { ...st.accounts[k], needs_login: !ok, login_id: undefined, cooldown_until: undefined };
    save(st);
    journal(host, ok ? `${k} logged in (${id})` : `${k} login ${id} failed (exit ${code})`);
    await notify(ok ? L(`${k} logged in, the fleet continues`, `${k} 登录成功，fleet 继续运转`) : L(`${id} login did not finish (exit ${code}), a new link will follow`, `${id} 登录未完成（exit ${code}），稍后会再发新链接`), cfg);
  });
  setTimeout(() => { if (pending.has(id)) proc.kill(); }, 30 * 60_000); // link expiry
}

export const pendingLoginIds = () => new Set(pending.keys());

export function submitLoginCode(id: string, code: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  const stdin = p.proc.stdin as import("bun").FileSink;
  stdin.write(code.trim() + "\r");
  stdin.flush();
  return true;
}

/** Periodically retry logins for accounts still flagged (e.g. after an expired link). */
const lastLoginTry = new Map<string, number>();
export async function retryLogins(cfg: Cfg) {
  const s = load();
  for (const cli of ["claude", "codex"]) for (const a of accounts(cfg, cli)) {
    const st = s.accounts[key(a)];
    if (!st?.needs_login || pending.size || !Bun.which(cli)) continue;
    if (usesGateway(a)) {
      // A gateway account signs in with its gateway token; setup-token can never finish. Clear a stale flag
      // (left by an older build) and let the next task try instead of sending another dead link.
      const cur = load();
      cur.accounts[key(a)] = { ...st, needs_login: false, told: undefined };
      save(cur);
      journal(hostName(cfg), `${key(a)} is gateway-authenticated; cleared the stale login flag instead of sending an OAuth link`);
      continue;
    }
    // back off: a login that exits immediately would otherwise send a new link every tick
    if (Date.now() - (lastLoginTry.get(key(a)) ?? 0) < 30 * 60_000) continue;
    lastLoginTry.set(key(a), Date.now());
    await startLogin(a, cfg);
  }
}

/** Structured account states for this machine (the app's machine page). */
export function accountsInfo(cfg: Cfg): { cli: string; name: string; state: "ok" | "cooldown" | "login"; until?: string }[] {
  const s = load();
  return ["claude", "codex"].filter((c) => Bun.which(c)).flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = s.accounts[key(a)] ?? {};
    const cool = !!st.cooldown_until && Date.parse(st.cooldown_until) > Date.now();
    return { cli: a.cli, name: a.name, state: st.needs_login ? "login" : cool ? "cooldown" : "ok", until: cool ? st.cooldown_until : undefined };
  });
}

export function accountsStatus(cfg: Cfg): string[] {
  const s = load();
  return ["claude", "codex"].filter((c) => Bun.which(c)).flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = s.accounts[key(a)] ?? {};
    const state = st.needs_login ? "needs login" : st.cooldown_until && Date.parse(st.cooldown_until) > Date.now()
      ? `cooldown → ${new Date(st.cooldown_until).toLocaleTimeString()}` : "ok";
    return `${key(a).padEnd(20)} ${state}`;
  });
}
