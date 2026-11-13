// noop coordination plane — runs in the owner's own Cloudflare account (free plan). Not a shared service.
// One Durable Object (SQLite) holds: chat feed, owner→fleet inbox, the fleet's status/settings snapshot, media.
// The machines (which run Claude/Codex) only make outbound HTTPS calls here; nothing needs to reach them.
//
// Client API (same shape as the local hub server):
//   GET /api/feed?since=  · WS /api/stream?token=  · POST /api/messages {text, reply_to?, attachments?: ["/media/<id>"]}
//   GET /api/status  · GET|PUT /api/settings  · POST /api/media (multipart) · GET /media/<id>
//   POST /api/uploads (multipart `file`; the owner's images for a message: image/*, ≤ 10 MB) → {url: "/media/<id>"}
// Fleet API (primary host):
//   POST /api/events (event)  · PUT /api/host/state {status, settings}  · GET /api/host/inbox?after=<seq>
//   POST /api/host/revoke-sessions (HUB_TOKEN only)
// Auth: HUB_TOKEN is the machine (fleet) credential. The owner logs in with an emailed one-time code:
//   POST /api/auth/start {email} → mail code · POST /api/auth/verify {email, code} → {session} · POST /api/auth/logout
// Web Push (owner session): GET /api/push/vapid · POST /api/push/subscribe {subscription, device_label}
//   · POST /api/push/unsubscribe {endpoint} · POST /api/push/test · POST /api/push/answer {ref, answer}
// Guest workers (low-trust shared machines): /api/guest/* and /api/guests/* — see guests.ts.
// MCP (Claude / ChatGPT connectors): /mcp + OAuth 2.1 at /oauth/* and /.well-known/oauth-* — see mcp.ts and docs/mcp.md.
// Every other /api/* and /media/* needs Bearer <HUB_TOKEN|session> (or ?token= for WebSocket / <img>).
import { DurableObject } from "cloudflare:workers";
import { b64dec, b64enc, handleFiles, handleReadFiles, initFilesSchema } from "./files";
import { FREE, LEAN, SHED, TARGET, latestOnly } from "./budget";
import { CHANNEL_SLUG, channelDigest, channelsView, taskHistory, taskInfo } from "./tools";
import { CODE_RE, newCode, normCode } from "./authcode";
import { newSecret, otpauthUri, totpMatch } from "./totp";
import { mediaHeaders, ownerAttachments, sniffImage, uploadId, uploadProblem } from "./uploads";
import { sendMail, type SmtpCfg } from "./smtp";
import { EmailMessage } from "cloudflare:email";

import { GUEST_TOKEN, guestApi, guestJoin, guestWho, guestsAdmin, initGuestSchema } from "./guests";

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
async function cfMail(binding: SendEmail, from: string, to: string, subject: string, text: string) {
  const raw = [`From: Noop <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text)].join("\r\n");
  await binding.send(new EmailMessage(from, to, raw));
}
import { sendPush, type PushSub, type Vapid } from "./push";
import { CORS, Mcp } from "./mcp";
import { L, setLang } from "./i18n";
import { ipAllowed, parseAllowList } from "./ipallow";
import { notificationFor, type NotifyRules } from "../../app/notify";

interface Env {
  HUB: DurableObjectNamespace<Hub>; HUB_TOKEN: string; ASSETS: Fetcher;
  HUB_OWNER_EMAIL?: string; // comma-separated allow-list
  HUB_SMTP?: string;        // JSON SmtpCfg
  EMAIL?: SendEmail;        // Cloudflare Email Routing binding (no SMTP needed)
  HUB_MAIL_FROM?: string;   // sender on a domain with Email Routing on, e.g. noop@example.com
  HUB_VAPID_PUBLIC?: string;  // b64url raw P-256 point
  HUB_VAPID_PRIVATE?: string; // JWK JSON
  HUB_MOVED_TO?: string;    // the hub moved to another Worker (e.g. another account): forward every request there
  HUB_LANG?: string;        // [owner] language: "en" gives English text, otherwise Simplified Chinese
  HUB_ALLOW_IPS?: string;   // optional source-IP allow-list (IPs / CIDRs, comma or space separated); set → everyone else gets 403
}

const json = (d: unknown, status = 200) => Response.json(d, { status });
const CHUNK = 1_000_000; // SQLite row limit is 2 MB
const MAX_MEDIA = 30_000_000;
const STALE_MS = 3 * 60_000;
// Free-plan budget (cloud/src/budget.ts): every request and every row read/written is metered below.
const SHEDDABLE = new Set(["system", "daemon", "notice"]);
const HOT = new Set(["status", "host_seen"]), HOT_PERSIST_MS = 5 * 60_000;
const CODE_TTL = 10 * 60_000, CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 10, SEEN_EVERY = 3600_000;
// Wrong code guesses are capped per UTC day across every code (authcode.ts: 31^8 codes), so guessing can't add up over
// weeks. Past the cap nobody can verify until 00:00 UTC — a lockout, not a way in.
const FAILS_PER_DAY = 20;
// Owner sessions (app, browser, MCP access tokens) die after this long unused.
const SESSION_IDLE_MS = 30 * 86_400_000;
const TOTP_MISSING = () => L("2FA (authenticator app) is not bound yet, nobody can log in: run noop 2fa setup on your host first", "还没有绑定两步验证（验证器 App），任何人都无法登录：先在你的主机上运行 noop 2fa setup");

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
function sameStr(a: string, b: string) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const normEmail = (e: unknown) => typeof e === "string" ? e.trim().toLowerCase() : "";
const alertTime = () => L(`Time: ${new Date().toISOString()}`, `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）`);
const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    setLang(env.HUB_LANG);
    const url = new URL(req.url);
    // Moved: machines still pointing here keep working (and pick up the new [cloud] url from the shared config).
    // IP allow-list (HUB_ALLOW_IPS): checked before anything else, static assets included
    if (env.HUB_ALLOW_IPS?.trim()) {
      const { nets, bad } = parseAllowList(env.HUB_ALLOW_IPS);
      if (bad.length) console.error(`HUB_ALLOW_IPS: ignored ${bad.join(" ")}`);
      const ip = req.headers.get("cf-connecting-ip") ?? "";
      if (!ipAllowed(ip, nets)) return ipBlocked(req, ip);
    }
    if (env.HUB_MOVED_TO) return fetch(new Request(env.HUB_MOVED_TO.replace(/\/$/, "") + url.pathname + url.search, req));
    const mcp = isMcpPath(url.pathname);
    if (mcp && req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!mcp && HASHED.test(url.pathname) && req.method === "GET") return hashedAsset(req, env, url);
    if (!mcp && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) return env.ASSETS.fetch(req);
    if (!env.HUB_TOKEN) return json({ error: "HUB_TOKEN secret not set" }, 500);
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

/** Content-hashed files `nsh bundle` writes (`nsh.73cc16a15e.wasm`, `app.853c5dd616.js`): they never change, and the
 *  bundle ships a Brotli 11 / gzip 9 copy next to each. Workers Assets only compresses on the fly at low levels
 *  (the 14 MB runtime went out as 4.3 MB instead of 3.1 MB), so send the precompressed copy as is. */
const HASHED = /\.[0-9a-f]{10}\.(wasm|m?js|css)$/;
const TYPES: Record<string, string> = { wasm: "application/wasm", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const IMMUTABLE = "public, max-age=31536000, immutable";

async function hashedAsset(req: Request, env: Env, url: URL): Promise<Response> {
  const accept = req.headers.get("accept-encoding") ?? "";
  const accepted = new Map(accept.toLowerCase().split(",").map((part) => {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return [name.trim(), q === undefined ? 1 : Number(q.slice(2))] as const;
  }));
  const quality = (name: string) => accepted.get(name) ?? accepted.get("*") ?? 0;
  const type = TYPES[url.pathname.slice(url.pathname.lastIndexOf(".") + 1)];
  const variants = ([["br", "br"], ["gz", "gzip"]] as const).toSorted((a, b) => quality(b[1]) - quality(a[1]));
  for (const [ext, enc] of variants) {
    if (!(quality(enc) > 0)) continue;
    const res = await env.ASSETS.fetch(new Request(new URL(url.pathname + "." + ext, url), { headers: { "accept-encoding": "identity" } }));
    if (!res.ok || res.headers.get("content-type")?.toLowerCase().startsWith("text/html")) continue;
    const headers = new Headers({ "content-type": type, "content-encoding": enc, "cache-control": IMMUTABLE, vary: "accept-encoding" });
    const etag = res.headers.get("etag");
    if (etag) headers.set("etag", etag);
    // `manual`: the body is already encoded, the runtime must not compress it again.
    return new Response(res.body, { status: 200, headers, encodeBody: "manual" } as ResponseInit);
  }
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", IMMUTABLE);
  out.headers.append("vary", "accept-encoding");
  return out;
}

/** Turned away by HUB_ALLOW_IPS. The visitor sees its own public IP (nothing else), so the owner can add a phone's
 *  network from the phone itself: JSON for the app and API clients, a small page for a browser. */
function ipBlocked(req: Request, ip: string): Response {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const msg = L(`This network's public IP ${ip || "unknown"} is not on the allow-list (HUB_ALLOW_IPS)`, `这个网络的出口 IP ${ip || "未知"} 不在允许名单（HUB_ALLOW_IPS）里`);
  if (!(req.headers.get("accept") ?? "").includes("text/html"))
    return Response.json({ error: "ip_blocked", ip, message: msg }, { status: 403, headers });
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L("Noop: IP not allowed", "Noop：IP 未放行")}</title><style>:root{color-scheme:light dark}body{margin:0;font:16px/1.6 -apple-system,system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:420px;margin:18vh auto;padding:0 16px}h1{font-size:20px;margin:0 0 12px}.ip{font:600 24px/1.3 ui-monospace,Menlo,monospace;user-select:all;padding:12px 14px;border:1px solid #8884;border-radius:8px;word-break:break-all}
p{color:GrayText;font-size:14px}</style></head><body><main><h1>${L("This network is not allowed yet", "这个网络还没放行")}</h1><div class="ip">${esc(ip || L("unknown", "未知"))}</div>
<p>${L("This is your current network's public IP. To use Noop from here, add it to the Worker's HUB_ALLOW_IPS (ranges work, e.g. 1.2.3.0/24; mobile data often uses changing IPv6, so add its /64).", "这是你当前网络的出口 IP。要从这里使用 Noop，把它加到 Worker 的 HUB_ALLOW_IPS 里（可以写网段，如 1.2.3.0/24；手机流量常用 IPv6，地址会变，写它的 /64 网段）。")}</p></main></body></html>`,
    { status: 403, headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

const isMcpPath = (p: string) => p === "/mcp" || p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-") || p === "/.well-known/openid-configuration";

/** Per-route counters: [requests, rowsRead, rowsWritten]. */
type Usage = { day: string; requests: number; rowsRead: number; rowsWritten: number; routes: Record<string, [number, number, number]> };
/** "POST /api/files/commit": the route without ids, so a day's breakdown stays a few dozen keys. */
export const routeKey = (req: Request) => {
  const p = new URL(req.url).pathname.replace(/\/(T|D)-[\w-]+/g, "/:id").replace(/^\/media\/.*/, "/media/:id");
  return `${req.method} ${p.length > 40 ? p.slice(0, 40) : p}`;
};

type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };

export class Hub extends DurableObject<Env> {
  sql: SqlStorage;
  mcp: Mcp;
  /** Every cursor since the last settle(): their rowsRead / rowsWritten are what Cloudflare bills. */
  cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  usage: Usage = { day: "", requests: 0, rowsRead: 0, rowsWritten: 0, routes: {} };
  usageSaved = 0;
  /** Rows written since the counters were last persisted: a busy burst is saved before an eviction can drop it. */
  unsaved = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    setLang(env.HUB_LANG);
    const raw = ctx.storage.sql, cursors = this.cursors;
    this.sql = { exec: (q: string, ...b: SqlStorageValue[]) => { const c = raw.exec(q, ...b); cursors.push(c); return c; }, get databaseSize() { return raw.databaseSize; } } as unknown as SqlStorage;
    // a host keeps one hibernating socket open for "inbox has something"; its keepalive never wakes this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT);
      CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS media (id TEXT, n INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, n));
      CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY, hash TEXT, expires INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS auth_sends (email TEXT, ts INTEGER, sent INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT);
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, session TEXT, p256dh TEXT, auth TEXT, label TEXT, created INTEGER);`);
    initFilesSchema(this.sql);
    initGuestSchema(this.sql);
    // scope: "owner" (app / browser) or "mcp" (an OAuth access token for a Claude / ChatGPT connector: /mcp only)
    try { this.sql.exec("ALTER TABLE sessions ADD COLUMN scope TEXT"); } catch { /* exists */ }
    try { Object.assign(this.usage, JSON.parse(String(raw.exec("SELECT v FROM kv WHERE k = 'usage'").toArray()[0]?.v ?? "{}"))); } catch { /* fresh */ }
    // events.ref, indexed: a task's conversation is read by ref, never by scanning every event's JSON (rows_read is billed per row)
    try { this.sql.exec("ALTER TABLE events ADD COLUMN ref TEXT"); } catch { /* exists */ }
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_ref ON events (ref)");
    // Channel feeds use indexed room/ref lookups; opening a room never scans unrelated history.
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_channel ON events (json_extract(json, '$.channel')) WHERE json_extract(json, '$.channel') IS NOT NULL");
    // Indexed receipt lookup: one row per retry, no event scan or polling.
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_client_id ON events (json_extract(json, '$.client_id')) WHERE json_extract(json, '$.client_id') IS NOT NULL");
    // Event ids are the host's idempotency key (a retried POST must not store the event twice); indexed so every
    // upload checks one row, not the whole history.
    this.sql.exec("CREATE INDEX IF NOT EXISTS events_id ON events (json_extract(json, '$.id')) WHERE json_extract(json, '$.id') IS NOT NULL");
    if (this.sql.exec("SELECT v FROM kv WHERE k = 'events_ref_filled'").toArray().length === 0) {
      this.sql.exec("UPDATE events SET ref = json_extract(json, '$.ref') WHERE ref IS NULL");
      this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('events_ref_filled', '1')");
    }
    this.mcp = new Mcp({
      sql: this.sql,
      status: () => this.statusView(),
      events: (after, limit) => this.sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray()
        .map((r) => ({ seq: r.seq as number, ev: JSON.parse(r.json as string) })),
      say: (text, ref) => this.ownerMessage(text, ref),
      enqueue: (op) => this.toInbox({ type: "op", op }),
      hostOnline: () => this.hostOnline(),
      startCode: async (email) => { const r = await this.auth("/api/auth/start", new Request("https://hub/api/auth/start", { method: "POST", body: JSON.stringify({ email }) })); return { status: r.status, body: await r.json() }; },
      checkCode: (email, code, totp, ctx) => this.checkCode(email, code, totp, ctx),
      newSession: (email, ua) => this.newSession(email, ua),
      dropSession: async (raw) => { this.sql.exec("DELETE FROM sessions WHERE id = ?", await sha256(raw)); },
    });
  }

  statusView() { return { ...(this.get("status") ?? {}), hub: { online: this.hostOnline(), seen: this.get("host_seen") } }; }

  /** Sign-in check shared by /api/auth/verify and the OAuth sign-in page: the emailed code AND the authenticator's
   *  TOTP (mandatory; bound only from a machine with `noop 2fa setup`). A success is a new sign-in: the owners are told
   *  by email (and in the feed), so a sign-in they didn't make is noticed at once. */
  async checkCode(rawEmail: unknown, rawCode: unknown, rawTotp: unknown, ctx?: { req: Request; via: string }): Promise<{ email?: string; error?: string; status?: number }> {
    const email = normEmail(rawEmail), code = normCode(rawCode), totp = typeof rawTotp === "string" ? rawTotp.replace(/\s/g, "") : "";
    const tf = this.totp();
    if (!tf) return { error: TOTP_MISSING(), status: 403 };
    if (!validEmail(email) || !CODE_RE.test(code) || !/^\d{6}$/.test(totp)) return { error: L("Enter the email code and the 2FA code", "请填写邮箱验证码和两步验证码"), status: 400 };
    const r = this.sql.exec("SELECT hash, expires, attempts FROM auth_codes WHERE email = ?", email).toArray()[0];
    if (!r || (r.expires as number) < Date.now()) return { error: L("The code is invalid or expired, request a new one", "验证码无效或已过期，请重新获取"), status: 401 };
    if ((r.attempts as number) >= CODE_TRIES) return { error: L("Too many attempts, request a new code", "尝试次数太多，请重新获取验证码"), status: 401 };
    const day = new Date().toISOString().slice(0, 10), fails = this.get("auth_fails");
    const failed = fails?.day === day ? Number(fails.n) || 0 : 0;
    if (failed >= FAILS_PER_DAY) return { error: L("Too many failed verifications today, locked until 00:00 UTC", "今天验证失败次数太多，已锁定到 UTC 0 点"), status: 429 };
    this.sql.exec("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?", email);
    const fail = (error: string) => {
      this.set("auth_fails", { day, n: failed + 1 });
      if (failed + 1 >= FAILS_PER_DAY) {
        this.sql.exec("DELETE FROM auth_codes");
        this.alert(L("Login locked", "登录已锁定"), [L(`${FAILS_PER_DAY} failed verifications today, nobody can log in until 00:00 UTC.`, `今天验证已经错了 ${FAILS_PER_DAY} 次，到 UTC 0 点前任何人都无法登录。`), ...(ctx ? this.origin(ctx.req) : []),
          "", L("If this was not you, someone is guessing your codes. Existing logins are not affected.", "如果不是你本人在试：有人在猜你的验证码。已有的登录不受影响。")]);
      }
      return { error, status: 401 };
    };
    if (!sameStr(await sha256(`${email}:${code}`), r.hash as string)) return fail(L("The email code is wrong", "邮箱验证码不对"));
    // the email code was right: a wrong TOTP keeps it (within its CODE_TRIES), so the owner can retype just the TOTP
    const step = await totpMatch(tf.secret, totp, tf.last ?? -1);
    if (step === null) {
      if (ctx) this.alert(L("Wrong 2FA code", "两步验证码错误"), [L(`Someone entered the correct email code for ${email}, but the wrong 2FA code.`, `有人输对了 ${email} 的邮箱验证码，但两步验证码不对。`), ...this.origin(ctx.req),
        "", L("If this was not you, your mailbox may be compromised: change its password now.", "如果不是你本人：你的邮箱可能已经被盗，请立即修改邮箱密码。")]);
      return fail(L("The 2FA code is wrong (or already used), check the latest number in your authenticator app", "两步验证码不对（或已用过），请看验证器 App 上的最新数字"));
    }
    this.set("totp", { ...tf, last: step }); // each code works once
    this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
    this.sql.exec("DELETE FROM kv WHERE k = 'cli_code'");
    if (ctx) this.alert(L("New login", "新登录"), [L(`Account: ${email}`, `账号：${email}`), L(`Method: ${ctx.via}`, `方式：${ctx.via}`), ...this.origin(ctx.req),
      "", L("If this was you, nothing to do.", "如果是你本人，无需处理。"),
      L("If this was not you: run noop revoke-sessions on your host to sign out everything at once (phones, browsers, MCP connectors), then check whether this mailbox is compromised.", "如果不是你：在你的主机上运行 noop revoke-sessions，立即踢掉所有登录（手机、浏览器、MCP 连接器），再检查这个邮箱是否被盗。")]);
    return { email };
  }
  /** The bound authenticator, or null (then nobody can sign in). */
  totp(): { secret: string; last?: number; bound?: number } | null { const t = this.get("totp"); return t?.secret ? t : null; }
  async newSession(email: string, ua: string) {
    if (!this.ownerOk(email)) throw new Error("not an owner");
    const session = hex(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
    this.sql.exec("INSERT INTO sessions (id, email, created, last_seen, ua, scope) VALUES (?, ?, ?, ?, ?, ?)",
      await sha256(session), email, now, now, ua.slice(0, 300), ua.startsWith("mcp:") ? "mcp" : "owner");
    return session;
  }

  // ---- security alerts
  /** How to send mail, or null when email isn't set up (codes then go through `noop login`). */
  mailer(): ((to: string, subject: string, text: string) => Promise<void>) | null {
    let smtp: SmtpCfg | null = null;
    try { smtp = this.env.HUB_SMTP ? JSON.parse(this.env.HUB_SMTP) : null; } catch {}
    if (smtp?.host) return (to, subject, text) => sendMail(smtp!, to, subject, text);
    if (this.env.EMAIL && this.env.HUB_MAIL_FROM) return (to, subject, text) => cfMail(this.env.EMAIL!, this.env.HUB_MAIL_FROM!, to, subject, text);
    return null;
  }
  /** Where a request came from, for an alert: time, IP and place (Cloudflare's view), device. */
  origin(req: Request): string[] {
    const cf = (req as Request & { cf?: Record<string, unknown> }).cf ?? {};
    const place = [cf.country, cf.region, cf.city].filter(Boolean).join(" ");
    return [alertTime(),
      `IP: ${req.headers.get("cf-connecting-ip") ?? L("unknown", "未知")}${place ? ` (${place})` : ""}${cf.asOrganization ? ` · ${cf.asOrganization}` : ""}`,
      `${L("Device", "设备")}: ${(req.headers.get("user-agent") ?? L("unknown", "未知")).slice(0, 200)}`];
  }
  /** A security event: mailed to every HUB_OWNER_EMAIL address and put in the feed. Never blocks or fails the request. */
  alert(title: string, lines: string[]) {
    this.append({ from: "hub", kind: "notice", text: `🔐 ${title}\n${lines.filter(Boolean).join("\n")}` });
    const send = this.mailer();
    if (!send) return;
    const text = L(`Noop security alert: ${title}\n\n${lines.join("\n")}\n`, `Noop 安全提醒：${title}\n\n${lines.join("\n")}\n`);
    this.ctx.waitUntil(Promise.all(this.owners().map((to) => send(to, L(`Noop security alert: ${title}`, `Noop 安全提醒：${title}`), text)
      .catch((err) => console.error(`alert mail to ${to}: ${err}`)))));
  }

  // ---- free-plan budget. Past the daily allowance every DO operation of that kind errors until 00:00 UTC, so the Hub
  // meters itself (requests, and the rows each query really read and wrote) and gets frugal well before the cap:
  // "lean" persists hot state rarely, "shed" refuses fleet chatter (heartbeats, journals, routine notices).
  mem = new Map<string, string>();
  flushed = new Map<string, number>();
  today() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.usage.day !== day) this.usage = { day, requests: 0, rowsRead: 0, rowsWritten: 0, routes: {} };
    this.usage.routes ??= {};
    return this.usage;
  }
  /** Count the rows of every query since the last call, per route (what `/api/usage` shows so the biggest consumer is
   *  visible), and persist the counters every minute while busy or after a few hundred unsaved rows: an evicted object
   *  used to lose up to five minutes of counts on every wake, so the app read far below Cloudflare's own figures. */
  settle(requests = 1, route = "other") {
    const u = this.today();
    u.requests += requests;
    let r = 0, w = 0;
    for (const c of this.cursors.splice(0)) { r += c.rowsRead; w += c.rowsWritten; }
    u.rowsRead += r; u.rowsWritten += w; this.unsaved += w + r / 50;
    const k = u.routes[route] ??= [0, 0, 0];
    k[0] += requests; k[1] += r; k[2] += w;
    const since = Date.now() - this.usageSaved;
    if (since > 5 * 60_000 || (since > 60_000 && this.unsaved > 50) || this.unsaved > 300) {
      this.usageSaved = Date.now(); this.unsaved = 0;
      u.rowsWritten += 2; // this save: the kv row and its primary key (unmetered cursor, counted by hand)
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('usage', ?)", JSON.stringify(u));
    }
  }
  /** The tightest of today's allowances, as a fraction of the free plan. */
  used() { const u = this.today(); return Math.max(u.requests / FREE.requests, u.rowsRead / FREE.rowsRead, u.rowsWritten / FREE.rowsWritten); }
  level(): "ok" | "lean" | "shed" { const f = this.used(); return f < LEAN ? "ok" : f < SHED ? "lean" : "shed"; }
  usageView() {
    return { ...this.today(), level: this.level(), dbBytes: this.ctx.storage.sql.databaseSize, free: FREE, target: TARGET,
      sockets: { owner: this.ctx.getWebSockets("owner").length, host: this.ctx.getWebSockets("host").length } };
  }

  get(k: string): any {
    const m = this.mem.get(k);
    if (m !== undefined) return JSON.parse(m);
    const r = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    if (r) this.mem.set(k, r.v as string);
    return r ? JSON.parse(r.v as string) : null;
  }
  /** Writes only when the value changed. Hot keys (status, host_seen) are kept in memory and persisted at most every
   *  HOT_PERSIST_MS (longer when the budget is tight): losing a few minutes of them on eviction is harmless, the daemon re-sends. */
  set(k: string, v: unknown) {
    const s = JSON.stringify(v);
    if (this.mem.get(k) === s) return;
    if (!this.mem.has(k) && this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v === s) { this.mem.set(k, s); return; }
    this.mem.set(k, s);
    if (HOT.has(k)) {
      const lvl = this.level(), every = lvl === "ok" ? HOT_PERSIST_MS : lvl === "lean" ? HOT_PERSIST_MS * 6 : Infinity;
      if (Date.now() - (this.flushed.get(k) ?? 0) < every) return;
    }
    this.flushed.set(k, Date.now());
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, s);
  }
  touchHost() { this.set("host_seen", Date.now()); }

  append(e: Partial<Ev>): Ev {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e } as Ev;
    this.sql.exec("INSERT INTO events (ts, json, ref) VALUES (?, ?, ?)", ev.ts, JSON.stringify(ev), typeof ev.ref === "string" ? ev.ref : null);
    if (Math.random() < 0.02) this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - 5000 FROM events)");
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets("owner")) try { ws.send(s); } catch {}
    try { this.mcp.onEvent(ev); } catch (err) { console.error(`mcp: ${err}`); }
    this.pruneMedia();
    const n = this.notification(ev);
    if (n) this.ctx.waitUntil(this.pushAll(n.payload, n.urgency).catch((err) => console.error(`push: ${err}`)));
    return ev;
  }

  /** Media older than settings `media_days` (7, 14, 30 or 90; 7 by default) goes, checked at most hourly. Ids start with Date.now(). */
  pruneMedia(force = false) {
    const now = Date.now();
    if (!force && now - (this.get("media_pruned") ?? 0) < 3_600_000) return;
    this.set("media_pruned", now);
    const s = this.get("settings");
    const want = Number(s?.current?.media_days ?? s?.effective?.media_days);
    const days = [7, 14, 30, 90].includes(want) ? want : 7;
    this.sql.exec("DELETE FROM media WHERE instr(id, '-') = 14 AND CAST(substr(id, 1, 13) AS INTEGER) < ?", now - days * 86_400_000);
  }

  /** Owner→fleet inbox. A waiting long-poll from the primary daemon is answered at once (no polling delay). */
  inboxWaiters = new Set<() => void>();
  acked = 0;
  toInbox(item: Record<string, unknown>) {
    this.sql.exec("INSERT INTO inbox (json) VALUES (?)", JSON.stringify(item));
    for (const w of [...this.inboxWaiters]) w();
    for (const ws of this.ctx.getWebSockets("host")) try { ws.send('{"type":"inbox"}'); } catch {}
  }

  ownerMessage(text: string, ref?: string, attachments?: string[], thread = false, clientId?: string, channel?: string): Ev {
    if (clientId) {
      const previous = this.sql.exec("SELECT json FROM events WHERE json_extract(json, '$.client_id') = ? LIMIT 1", clientId).toArray()[0];
      if (previous) return JSON.parse(previous.json as string) as Ev;
    }
    const ev = this.append({ from: "owner", kind: "owner", text, ref, ...(clientId ? { client_id: clientId } : {}), ...(attachments?.length ? { attachments } : {}), ...(thread ? { thread } : {}), ...(channel ? { channel } : {}) });
    this.toInbox({ type: "message", event: ev });
    if (!this.hostOnline()) this.append({ from: "hub", kind: "system", text: L("Got it. The team's machines are all offline right now, this will be handled as soon as one is back.", "收到。团队的电脑暂时都不在线，上线后会马上处理。"), ref: ev.id, ...(channel ? { channel } : {}) });
    return ev;
  }

  // ---- web push
  vapid(): Vapid | null {
    const { HUB_VAPID_PUBLIC: pub, HUB_VAPID_PRIVATE: priv, HUB_OWNER_EMAIL: owner } = this.env;
    if (!pub || !priv) return null;
    try { return { publicKey: pub, privateJwk: JSON.parse(priv), subject: `mailto:${(owner ?? "").split(",")[0].trim() || "owner@example.com"}` }; } catch { return null; }
  }

  /** Which events become a phone notification, honoring settings.current.notify_prefs. */
  notification(ev: Ev): { payload: Record<string, unknown>; urgency: "normal" | "high" } | null {
    const kind = ev.kind;
    const note = notificationFor(ev, (this.get("settings")?.current?.notify_prefs ?? {}) as NotifyRules);
    if (!note) return null;
    const ref = typeof ev.ref === "string" ? ev.ref : undefined;
    const opts = Array.isArray(ev.options) ? (ev.options as unknown[]).map((o) => String(o).slice(0, 20)).slice(0, 3) : [];
    const decisions = (this.get("status")?.decisions ?? []) as { held?: boolean }[];
    return {
      urgency: kind === "decision" || kind === "login" ? "high" : "normal",
      payload: {
        ...note,
        ref, kind, options: kind === "decision" || kind === "menu" ? opts : [],
        url: ref ? `/?ref=${encodeURIComponent(ref)}` : "/", tag: ref ?? kind,
        badge: decisions.filter((d) => !d.held).length,
      },
    };
  }

  async pushAll(payload: unknown, urgency: "normal" | "high", only?: string) {
    const v = this.vapid();
    if (!v) return { sent: 0, removed: 0, error: "vapid not configured" };
    const rows = only ? this.sql.exec("SELECT * FROM push_subs WHERE session = ?", only).toArray() : this.sql.exec("SELECT * FROM push_subs").toArray();
    let sent = 0, removed = 0;
    await Promise.all(rows.map(async (r) => {
      const sub: PushSub = { endpoint: r.endpoint as string, keys: { p256dh: r.p256dh as string, auth: r.auth as string } };
      const tag = (payload as { tag?: string }).tag;
      const st = await sendPush(sub, payload, v, { ttl: 86400, urgency, topic: tag }).catch(() => 0);
      if (st === 404 || st === 410) { this.sql.exec("DELETE FROM push_subs WHERE endpoint = ?", sub.endpoint); removed++; }
      else if (st >= 200 && st < 300) sent++;
      else console.error(`push ${new URL(sub.endpoint).host}: HTTP ${st}`);
    }));
    return { sent, removed, total: rows.length };
  }

  async push(p: string, req: Request, who: "machine" | { session: string; scope: string }): Promise<Response> {
    if (p === "/api/push/vapid") { const v = this.vapid(); return v ? json({ publicKey: v.publicKey }) : json({ error: "push not configured" }, 503); }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const b = (await req.json().catch(() => ({}))) as any;
    if (p === "/api/push/answer") {
      const ref = typeof b?.ref === "string" ? b.ref.trim() : "", answer = typeof b?.answer === "string" ? b.answer.trim() : "";
      if (!ref || !answer) return json({ error: "ref and answer required" }, 400);
      return json(this.ownerMessage(`${ref} ${answer}`, ref));
    }
    if (who === "machine") return json({ error: "owner session required" }, 403);
    if (p === "/api/push/subscribe") {
      const s = b?.subscription;
      if (typeof s?.endpoint !== "string" || !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(s.endpoint) || typeof s?.keys?.p256dh !== "string" || typeof s?.keys?.auth !== "string")
        return json({ error: "invalid subscription" }, 400);
      this.sql.exec(`INSERT INTO push_subs (endpoint, session, p256dh, auth, label, created) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET session = excluded.session, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
        s.endpoint, who.session, s.keys.p256dh, s.keys.auth, String(b.device_label ?? "").slice(0, 80), Date.now());
      return json({ ok: true });
    }
    if (p === "/api/push/unsubscribe") {
      this.sql.exec("DELETE FROM push_subs WHERE endpoint = ? AND session = ?", String(b?.endpoint ?? ""), who.session);
      return json({ ok: true });
    }
    if (p === "/api/push/test") {
      const r = await this.pushAll({ title: "Noop", body: L("Test notification: phone push is working.", "测试通知：手机推送已开通。"), kind: "notice", url: "/", tag: "test", options: [], badge: 0 }, "normal", who.session);
      return json({ ok: true, ...r });
    }
    return json({ error: "not found" }, 404);
  }

  hostOnline() { if (this.ctx.getWebSockets("host").length) return true; const seen = this.get("host_seen"); return !!seen && Date.now() - seen < STALE_MS; }
  /** The primary pushes live agent activity only while someone looks: tell it when that changes. */
  tellWatchers() {
    const n = this.ctx.getWebSockets("owner").filter((ws) => ws.readyState === WebSocket.OPEN).length;
    for (const ws of this.ctx.getWebSockets("host")) try { ws.send(JSON.stringify({ type: "watchers", n })); } catch {}
  }
  /** Owner clients that asked for status frames (?v=2) get the dashboard pushed instead of polling for it. */
  pushStatus() {
    const s = JSON.stringify({ $status: this.statusView() });
    for (const ws of this.ctx.getWebSockets("v2")) try { ws.send(s); } catch {}
  }

  // ---- auth
  credential(req: Request, url: URL) {
    const h = req.headers.get("authorization") ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : url.searchParams.get("token") ?? ""; // WebSocket / <img> can't send headers
  }
  /** The owner allow-list (HUB_OWNER_EMAIL). Empty only before email is set up, when codes are shown by `noop login`. */
  owners() { return (this.env.HUB_OWNER_EMAIL ?? "").split(",").map(normEmail).filter(Boolean); }
  ownerOk(email: unknown) { const o = this.owners(); return !o.length || o.includes(normEmail(email)); }
  /** "machine" for HUB_TOKEN, the session for an owner session, null otherwise. A session whose email left the
   *  allow-list, or that went unused for SESSION_IDLE_MS, is deleted on sight. */
  async who(req: Request, url: URL): Promise<"machine" | { session: string; scope: "owner" | "mcp" } | null> {
    const t = this.credential(req, url);
    if (!t) return null;
    if (sameStr(t, this.env.HUB_TOKEN)) return "machine";
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const id = await sha256(t); // store only hashes of session ids
    const r = this.sql.exec("SELECT last_seen, email, ua, scope FROM sessions WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    const now = Date.now();
    if (!this.ownerOk(r.email) || now - (r.last_seen as number) > SESSION_IDLE_MS) {
      this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
      this.sql.exec("DELETE FROM push_subs WHERE session = ?", id);
      return null;
    }
    if (now - (r.last_seen as number) > SEEN_EVERY) this.sql.exec("UPDATE sessions SET last_seen = ? WHERE id = ?", now, id);
    const scope = r.scope === "mcp" || (r.scope == null && String(r.ua ?? "").startsWith("mcp:")) ? "mcp" : "owner";
    return { session: id, scope };
  }

  async auth(p: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const now = Date.now();
    if (p === "/api/auth/start") {
      const email = normEmail(body?.email);
      if (!validEmail(email)) return json({ error: "invalid email" }, 400);
      const owners = this.owners();
      // Only the allow-list may sign in: anyone else is told so at once, with no code, no mail and no row written.
      if (owners.length && !owners.includes(email)) return json({ error: L("This email is not allowed to log in", "这个邮箱不允许登录") }, 403);
      if (!this.totp()) return json({ error: "totp_not_setup", message: TOTP_MISSING() }, 403); // no mail for a sign-in that can't finish
      // No email set up yet: the code is shown on the owner's own machine instead (`noop login`, needs the machine key).
      const send = this.mailer(), cli = !send;
      this.sql.exec("DELETE FROM auth_sends WHERE ts < ?", now - 3600_000);
            const recent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE email = ? AND ts > ?", email, now - RESEND_MS).one().n as number;
      if (recent) return json({ error: L("Wait a minute before requesting another code", "请稍等一分钟再重新获取验证码") }, 429);
      const sent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE sent = 1").one().n as number;
      if (sent >= SENDS_PER_HOUR) return json({ error: L("Too many codes sent, try again in an hour", "验证码发送太频繁，请一小时后再试") }, 429);
      const isOwner = owners.includes(email) || (cli && !owners.length);
      this.sql.exec("INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, ?)", email, now, isOwner ? 1 : 0);
      if (!isOwner) return json({ error: L("This email is not allowed to log in", "这个邮箱不允许登录") }, 403); // no allow-list and email set up: nobody is the owner
      const code = newCode();
      this.sql.exec("INSERT OR REPLACE INTO auth_codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0)", email, await sha256(`${email}:${code}`), now + CODE_TTL);
      if (cli) { this.set("cli_code", { email, code, expires: now + CODE_TTL }); return json({ ok: true, delivery: "cli" }); }
      try {
        const subject = L(`Noop login code: ${code}`, `Noop 登录验证码：${code}`);
        const text = L(`Your Noop login code is:\n\n    ${code}\n\nValid for 10 minutes.\n\nIf this was not you, ignore this email.\n`, `你的 Noop 登录验证码是：\n\n    ${code}\n\n10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。\n`);
        await send!(email, subject, text);
      } catch (err) {
        console.error(`auth mail failed: ${err}`);
        this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
        return json({ error: L("Sending the code email failed, try again later", "验证码邮件发送失败，请稍后再试") }, 502);
      }
      return json({ ok: true });
    }
    if (p === "/api/auth/verify") {
      const r = await this.checkCode(body?.email, body?.code, (body as { totp?: unknown } | null)?.totp, { req, via: L("App / browser login", "App / 浏览器登录") });
      if (!r.email) return json({ error: r.error }, r.status ?? 401);
      return json({ session: await this.newSession(r.email, req.headers.get("user-agent") ?? "") });
    }
    if (p === "/api/auth/logout") {
      const w = await this.who(req, new URL(req.url));
      if (w && w !== "machine") {
        this.sql.exec("DELETE FROM sessions WHERE id = ?", w.session);
        this.sql.exec("DELETE FROM push_subs WHERE session = ?", w.session);
      }
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }

  async fetch(req: Request): Promise<Response> {
    try { return await this.handle(req); } finally { this.settle(1, routeKey(req)); }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;

    if (p.startsWith("/api/auth/")) return this.auth(p, req);
    // guest workers (guests.ts): a one-time code joins; a guest token reaches /api/guest/* and nothing else
    if (p === "/api/guest/join" && m === "POST") return guestJoin(this.sql, req, (text) => this.append({ from: "hub", kind: "notice", text }));
    const gt = this.credential(req, url);
    if (GUEST_TOKEN.test(gt)) {
      const g = await guestWho(this.sql, gt);
      if (!g) return json({ error: "unauthorized" }, 401);
      return guestApi(this.sql, req, url, g, (id, guest) => this.append({ from: "hub", kind: "notice", ref: id, text: L(`Guest machine ${guest} returned the result of ${id} (not reviewed).`, `访客机器 ${guest} 交回了 ${id} 的结果（未经审查）。`) }));
    }
    if (isMcpPath(p)) return this.mcp.fetch(req, await this.who(req, url));
    const who = await this.who(req, url);
    if (!who) return json({ error: "unauthorized" }, 401);
    // a connector's OAuth token is for /mcp only: never the owner API (settings, machine key via /api/host/join, …)
    if (who !== "machine" && who.scope === "mcp") return json({ error: "forbidden" }, 403);
    if (p.startsWith("/api/push/")) return this.push(p, req, who);
    const ga = await guestsAdmin(this.sql, req, url, who === "machine" ? "machine" : "owner");
    if (ga) return ga;
    if ((p === "/api/files/list" || p === "/api/files/read") && m === "GET") { // owner (and machine) read of READABLE prefixes
      const r = handleReadFiles(this.sql, url);
      if (r) return r;
    }
    if (p === "/api/files/commit" && m === "POST" && this.level() === "shed") { // over budget: heartbeats and journals wait
      const b = (await req.clone().json().catch(() => null)) as { changes?: { path?: string }[] } | null;
      if (b?.changes?.length && b.changes.every((c) => latestOnly(String(c.path ?? ""))))
        return Response.json({ error: "over the daily budget", retry_after: 600 }, { status: 429, headers: { "retry-after": "600" } });
    }
    if (p.startsWith("/api/files/")) {
      const ownerOnly = p === "/api/files/history" || p === "/api/files/revert";
      if (ownerOnly ? who === "machine" : who !== "machine") return json({ error: "forbidden" }, 403);
      const actor = who === "machine" ? (req.headers.get("x-noop-host") ?? "machine") : "owner";
      const rev0 = Number(this.sql.exec("SELECT COALESCE(MAX(rev), 0) AS n FROM files").one().n);
      const r = await handleFiles(this.sql, req, url, actor);
      if (r && m === "POST") { // tasks / decisions changed → MCP resources/updated
        const paths = this.sql.exec("SELECT path FROM files WHERE rev > ?", rev0).toArray().map((x) => String(x.path));
        const uris = new Set<string>();
        for (const f of paths) {
          const t = f.match(/^tasks\/[^/]+\/(T-[^/]+)\.md$/)?.[1];
          if (t) { uris.add(`noop://tasks/${t}`); uris.add("noop://status"); }
          if (f.startsWith("decisions/")) uris.add("noop://decisions");
        }
        if (uris.size) this.mcp.onChanged([...uris]);
      }
      if (r) return r;
    }
    // Two-factor binding, from a machine only (the machine key is the root of trust; a stolen mailbox can't bind):
    //   GET /api/host/2fa → {bound, since} · POST /api/host/2fa/setup → {secret, uri} (pending)
    //   POST /api/host/2fa/confirm {totp} → binds the pending secret once a code from the app matches it
    if (p.startsWith("/api/host/2fa")) {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const host = req.headers.get("x-noop-host") ?? L("a host holding the machine key", "持有机器密钥的主机");
      if (p === "/api/host/2fa" && m === "GET") { // also what `noop security` can't see from config.toml: the live allow-list
        const t = this.totp(), allow = parseAllowList(this.env.HUB_ALLOW_IPS);
        return json({ bound: !!t, since: t?.bound ?? null, allow_ips: this.env.HUB_ALLOW_IPS?.trim() ? allow.nets.length : null });
      }
      if (p === "/api/host/2fa/setup" && m === "POST") {
        const secret = newSecret();
        this.set("totp_pending", { secret, expires: Date.now() + 10 * 60_000 });
        return json({ secret, uri: otpauthUri(secret, this.owners()[0] ?? "owner") });
      }
      if (p === "/api/host/2fa/confirm" && m === "POST") {
        const { totp } = (await req.json().catch(() => ({}))) as { totp?: unknown };
        const pend = this.get("totp_pending");
        if (!pend?.secret || pend.expires < Date.now()) return json({ error: L("No binding waiting for confirmation (valid for 10 minutes), run noop 2fa setup again", "没有待确认的绑定（10 分钟内有效），重新运行 noop 2fa setup") }, 400);
        const step = await totpMatch(pend.secret, totp);
        if (step === null) return json({ error: L("The 2FA code is wrong: check your phone's clock and enter the latest number in the authenticator app", "两步验证码不对：确认手机时间准确，输入验证器 App 上的最新数字") }, 400);
        const was = !!this.totp();
        this.set("totp", { secret: pend.secret, last: step, bound: Date.now() });
        this.sql.exec("DELETE FROM kv WHERE k = 'totp_pending'"); this.mem.delete("totp_pending");
        this.alert(L(was ? "2FA re-bound" : "2FA turned on", was ? "两步验证已换绑" : "两步验证已开启"), [L(`By: ${host}`, `操作方：${host}`), alertTime(),
          "", L(was ? "The old authenticator no longer works. If this was not you, someone has your machine key: check your host now." : "From now on, logging in needs the email code and the 2FA code from your authenticator app.", was ? "旧的验证器从现在起失效。如果不是你本人操作：有人拿到了你的机器密钥，立即检查你的主机。" : "从现在起，登录需要邮箱验证码 + 验证器 App 上的两步验证码。")]);
        return json({ ok: true, replaced: was });
      }
      return json({ error: "not found" }, 404);
    }
    if (p === "/api/host/login-code") { // `noop login` on the owner's machine, when email isn't configured
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const c = this.get("cli_code");
      return c && c.expires > Date.now() ? json(c) : json({ error: "no pending code" }, 404);
    }
    if (p === "/api/host/join" && m === "POST") { // a new machine, approved by the owner's login, gets the machine key
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { host } = (await req.json().catch(() => ({}))) as { host?: string };
      this.append({ from: "hub", kind: "notice", text: L(`New machine ${String(host ?? "?").slice(0, 60)} joined the team.`, `新机器 ${String(host ?? "?").slice(0, 60)} 已加入团队。`) });
      return json({ token: this.env.HUB_TOKEN });
    }
    if (p === "/api/host/revoke-sessions" && m === "POST") {
      await req.text().catch(() => ""); // drain body
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n;
      this.sql.exec("DELETE FROM sessions");
      this.sql.exec("DELETE FROM push_subs");
      // connectors too: a refresh token would otherwise mint a fresh session right back
      this.sql.exec("DELETE FROM oauth_refresh");
      this.sql.exec("DELETE FROM oauth_codes");
      this.sql.exec("DELETE FROM auth_codes");
      this.alert(L("All logins revoked", "所有登录已撤销"), [L(`${n} login(s) (phones, browsers, MCP connectors) were signed out and need to log in again with an email code.`, `${n} 个登录（手机、浏览器、MCP 连接器）已被踢下线，需要重新用邮箱验证码登录。`), L(`By: ${req.headers.get("x-noop-host") ?? "a host holding the machine key"}`, `操作方：${req.headers.get("x-noop-host") ?? "持有机器密钥的主机"}`)]);
      return json({ ok: true, revoked: n });
    }
    // Moving the hub to another Cloudflare account, one page at a time (media blobs are large):
    //   GET /api/host/export → {tables: {name: rows}} · GET /api/host/export?table=t&offset=0&limit=50 → {rows}
    //   POST /api/host/import {table, rows, reset} (reset empties the table first)
    if (p === "/api/host/export" && m === "GET") {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const t = url.searchParams.get("table");
      const names = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name as string);
      if (!t) return json({ tables: Object.fromEntries(names.map((n) => [n, this.sql.exec(`SELECT COUNT(*) AS n FROM "${n}"`).one().n])) });
      if (!names.includes(t)) return json({ error: "no such table" }, 404);
      // ?after=<rowid of the last row> walks the table by key; ?offset= (old copiers) re-reads every skipped row
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000), after = url.searchParams.get("after");
      const rows = (after != null
        ? this.sql.exec(`SELECT rowid AS _rowid, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT ?`, Number(after), limit)
        : this.sql.exec(`SELECT rowid AS _rowid, * FROM "${t}" ORDER BY rowid LIMIT ? OFFSET ?`, limit, Number(url.searchParams.get("offset") ?? 0))).toArray().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
        [k, v instanceof ArrayBuffer ? { $b64: b64enc(new Uint8Array(v)) } : v])));
      return json({ rows });
    }
    if (p === "/api/host/import" && m === "POST") {
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const { table: t, rows, reset } = (await req.json()) as { table: string; rows: Record<string, unknown>[]; reset?: boolean };
      const known = new Set(this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray().map((r) => r.name as string));
      if (!known.has(t)) return json({ error: "no such table" }, 404);
      this.ctx.storage.transactionSync(() => {
        if (reset) this.sql.exec(`DELETE FROM "${t}"`);
        for (const r of rows) {
          const cols = Object.keys(r).filter((c) => c !== "_rowid"); // the export's paging key
          const vals = cols.map((c) => { const v = r[c] as any; return v && typeof v === "object" && "$b64" in v ? b64dec(v.$b64) : v; });
          this.sql.exec(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...vals);
        }
      });
      return json({ ok: true, n: rows.length });
    }
    if (p === "/api/stream") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      // ?v=2 clients take {"$status": …} frames, so they need not poll /api/status
      this.ctx.acceptWebSocket(server, url.searchParams.get("v") === "2" ? ["owner", "v2"] : ["owner"]);
      this.tellWatchers();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/api/usage" && m === "GET") return json(this.usageView());

    if (p === "/api/feed") {
      const since = url.searchParams.get("since") ?? "";
      const rows = this.sql.exec("SELECT json FROM (SELECT seq, json FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 300) ORDER BY seq", since).toArray();
      return json({ events: rows.map((r) => JSON.parse(r.json as string)) });
    }

    if (p === "/api/messages" && m === "POST") {
      const { text = "", reply_to, attachments, thread, client_id, channel } = (await req.json()) as { text?: string; reply_to?: string; attachments?: unknown; thread?: unknown; client_id?: unknown; channel?: unknown };
      const room = typeof channel === "string" && channel ? channelsView(this.mcp.store()).channels.find((c) => c.slug === channel)?.slug : undefined;
      if (channel !== undefined && channel !== "" && !room) return json({ error: "channel not found" }, 400);
      if (client_id !== undefined && (typeof client_id !== "string" || !/^[\w:-]{1,100}$/.test(client_id)))
        return json({ error: "bad client_id" }, 400);
      const files = ownerAttachments(attachments);
      if (files === null) return json({ error: "bad attachments" }, 400);
      if (files.some((f) => !this.sql.exec("SELECT 1 FROM media WHERE id = ? LIMIT 1", f.slice(7)).toArray().length))
        return json({ error: "attachment not found" }, 400);
      if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
      return json(this.ownerMessage(text, reply_to, files, thread === true && /^T-/.test(reply_to ?? ""), client_id as string | undefined, room));
    }

    // The owner's images for a message (paste / drop / pick in the app): images only, ≤ 10 MB, kept with the media.
    if (p === "/api/uploads" && m === "POST") {
      const f = (await req.formData().catch(() => null))?.get("file") as File | null;
      if (!f || typeof f === "string") return json({ error: "file required" }, 400);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const type = sniffImage(bytes.subarray(0, 16), f.type);
      const bad = uploadProblem(type, f.size);
      if (bad) return json({ error: bad.error }, bad.status);
      const id = uploadId(f.name);
      for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++)
        this.sql.exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, type, bytes.slice(i, i + CHUNK));
      return json({ url: `/media/${id}` });
    }

    if (p === "/api/status") return json(this.statusView());

    if (p === "/api/settings" && m === "GET") return json(this.get("settings") ?? { current: {}, effective: {}, options: {} });
    if (p === "/api/tasks" && m === "GET") {
      return json(taskHistory(this.mcp.store(), { query: url.searchParams.get("q") ?? "", offset: Number(url.searchParams.get("offset")), limit: Number(url.searchParams.get("limit")) }));
    }
    if (p === "/api/tasks/get" && m === "GET") {
      const t = taskInfo(this.mcp.store(), url.searchParams.get("id") ?? "");
      if (!t) return json({ error: "not found" }, 404);
      // its whole conversation, however far back: the feed the app holds only has the newest events
      const refs = [t.id, ...t.decisions];
      const rows = this.sql.exec(`SELECT json FROM events WHERE ref IN (${refs.map(() => "?").join(",")}) ORDER BY seq`, ...refs).toArray();
      return json({ ...t, events: rows.map((r) => JSON.parse(r.json as string)) });
    }
    if (p === "/api/tasks/cancel" && m === "POST") { // owner: cancel a task; the primary host acts on it
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { id, done } = (await req.json().catch(() => ({}))) as { id?: string; done?: boolean };
      if (!id || !/^T-[\w]*\d{4}$/.test(id)) return json({ error: "id required" }, 400);
      this.toInbox({ type: "cancel", id, done: done === true });
      return json({ ok: true });
    }
    if (p === "/api/channels" && m === "GET") return json(channelsView(this.mcp.store()));
    if (p === "/api/channels/feed" && m === "GET") { // the channel's digest, however far back the app's feed doesn't reach
      const c = channelsView(this.mcp.store()).channels.find((c) => c.slug === url.searchParams.get("slug"));
      if (!c) return json({ error: "not found" }, 404);
      const rows = this.sql.exec("SELECT json FROM events WHERE ref IN (SELECT value FROM json_each(?)) OR json_extract(json, '$.channel') = ? ORDER BY seq DESC LIMIT 5000", JSON.stringify(c.refs ?? []), c.slug).toArray().reverse();
      return json({ events: channelDigest(rows.map((r) => JSON.parse(r.json as string)), c.refs ?? [], c.slug) });
    }
    if (p === "/api/channels" && m === "POST") { // owner: edit a channel's goal / archive it; the primary writes the file
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { slug, goal, archived } = (await req.json().catch(() => ({}))) as { slug?: string; goal?: unknown; archived?: unknown };
      if (!slug || !CHANNEL_SLUG.test(slug)) return json({ error: "slug required" }, 400);
      this.toInbox({ type: "channel", slug, ...(typeof goal === "string" ? { goal: goal.slice(0, 500) } : {}), ...(typeof archived === "boolean" ? { archived } : {}) });
      return json({ ok: true });
    }
    if (p === "/api/fleet/update" && m === "POST") { // owner: every machine updates to the latest code; the primary acts on it
      if (who === "machine") return json({ error: "forbidden" }, 403);
      this.toInbox({ type: "update" });
      return json({ ok: true });
    }
    if (p === "/api/settings" && m === "PUT") {
      const patch = await req.json();
      this.toInbox({ type: "settings", patch });
      const view = this.get("settings") ?? { current: {} };
      const deep = (a: any, b: any): any => { const o = { ...a }; for (const [k, v] of Object.entries(b ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep(o[k] ?? {}, v) : v; return o; };
      view.current = deep(view.current ?? {}, patch);
      this.set("settings", view);
      if (patch && typeof patch === "object" && "media_days" in patch) this.pruneMedia(true);
      return json(view);
    }

    if (p === "/api/media" && m === "POST") {
      const f = (await req.formData()).get("file") as File | null;
      if (!f) return json({ error: "file required" }, 400);
      if (f.size > MAX_MEDIA) return json({ error: "file too large" }, 413);
      const id = `${Date.now()}-${f.name.replace(/[^\w.\-]/g, "_")}`;
      const buf = new Uint8Array(await f.arrayBuffer());
      for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++)
        this.sql.exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, f.type || "application/octet-stream", buf.slice(i, i + CHUNK));
      return json({ url: `/media/${id}` });
    }
    if (p.startsWith("/media/")) {
      const id = decodeURIComponent(p.slice(7));
      const rows = this.sql.exec("SELECT type, data FROM media WHERE id = ? ORDER BY n", id).toArray();
      if (!rows.length) return json({ error: "not found" }, 404);
      const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
      return new Response(new Blob(parts), { headers: mediaHeaders(rows[0].type as string, id) });
    }

    // ---- fleet side
    if (p === "/api/events" && m === "POST") {
      const e = (await req.json()) as Partial<Ev>;
      // over budget, routine fleet chatter is dropped (still in the local journal); what the owner must see still goes through
      if (this.level() === "shed" && SHEDDABLE.has(String(e.kind ?? ""))) return json({ dropped: "write budget" });
      // the event id is the idempotency key: a host that never saw the reply (timeout, Worker restart, a retry after a
      // dropped response) posts the same event again, and storing it twice shows the same message twice in the chat.
      // Same rule ownerMessage already applies to client_id. The check and the insert below run without an await in
      // between, so two requests carrying one id cannot both get past it.
      if (typeof e.id === "string" && this.sql.exec("SELECT 1 FROM events WHERE json_extract(json, '$.id') = ? LIMIT 1", e.id).toArray().length)
        return json({ duplicate: true });
      return json(this.append(e));
    }
    if (p === "/api/host/state" && m === "PUT") {
      const { status, settings } = (await req.json()) as { status?: unknown; settings?: unknown };
      // over budget the dashboard refreshes at most every 10 minutes
      const shed = this.level() === "shed" && Date.now() - (this.flushed.get("status_at") ?? 0) < 10 * 60_000;
      if (status && !shed) { this.flushed.set("status_at", Date.now()); this.set("status", status); this.mcp.onChanged(["noop://status"]); this.pushStatus(); }
      if (settings) this.set("settings", settings);
      this.touchHost();
      // watchers: owner clients connected right now. With none, the primary skips live-activity-only refreshes.
      return json({ ok: true, watchers: this.ctx.getWebSockets("owner").length, level: this.level() });
    }
    if (p === "/api/host/stream") { // the daemon's hibernating socket: a nudge per inbox item instead of a long-poll
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["host"]);
      this.touchHost();
      this.pushStatus();
      this.tellWatchers();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (p === "/api/host/inbox") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (after > this.acked) { this.sql.exec("DELETE FROM inbox WHERE seq <= ?", after); this.acked = after; } // acked
      this.touchHost();
      const read = () => this.sql.exec("SELECT seq, json FROM inbox ORDER BY seq LIMIT 50").toArray()
        .map((r) => ({ seq: r.seq as number, ...JSON.parse(r.json as string) }));
      let items = read();
      // long-poll (?wait=<s>, ≤ 25): hold the request until something arrives, so an owner message reaches the
      // daemon in milliseconds instead of on its next poll
      const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait")) || 0, 25)) * 1000;
      if (!items.length && wait) {
        await new Promise<void>((res) => {
          const done = () => { clearTimeout(t); this.inboxWaiters.delete(done); res(); };
          const t = setTimeout(done, wait);
          this.inboxWaiters.add(done);
          req.signal?.addEventListener?.("abort", done);
        });
        this.touchHost();
        items = read();
      }
      return json({ items });
    }
    return json({ error: "not found" }, 404);
  }

  webSocketMessage() { this.settle(1 / 20, "ws"); } // incoming frames bill as 1/20 of a request (pings are auto-answered)
  webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch {}
    const tags = this.ctx.getTags(ws);
    if (tags.includes("host")) { this.touchHost(); this.pushStatus(); }
    if (tags.includes("owner")) this.tellWatchers();
    this.settle(0, "ws");
  }
}

