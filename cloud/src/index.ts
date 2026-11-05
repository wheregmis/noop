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
// MCP (Claude / ChatGPT connectors): /mcp + OAuth 2.1 at /oauth/* and /.well-known/oauth-* — see mcp.ts and docs/mcp.md.
// Every other /api/* and /media/* needs Bearer <HUB_TOKEN|session> (or ?token= for WebSocket / <img>).
import { DurableObject } from "cloudflare:workers";
import { b64dec, b64enc, handleFiles, handleReadFiles, initFilesSchema } from "./files";
import { taskHistory, taskInfo } from "./tools";
import { ownerAttachments, sniffImage, uploadId, uploadProblem } from "./uploads";
import { sendMail, type SmtpCfg } from "./smtp";
import { EmailMessage } from "cloudflare:email";

const b64 = (t: string) => btoa(String.fromCharCode(...new TextEncoder().encode(t)));
async function cfMail(binding: SendEmail, from: string, to: string, subject: string, text: string) {
  const raw = [`From: Noop <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(text)].join("\r\n");
  await binding.send(new EmailMessage(from, to, raw));
}
import { sendPush, type PushSub, type Vapid } from "./push";
import { CORS, Mcp } from "./mcp";
import { notificationFor, type NotifyRules } from "../../app/notify";

interface Env {
  HUB: DurableObjectNamespace<Hub>; HUB_TOKEN: string; ASSETS: Fetcher;
  HUB_OWNER_EMAIL?: string; // comma-separated allow-list
  HUB_SMTP?: string;        // JSON SmtpCfg
  EMAIL?: SendEmail;        // Cloudflare Email Routing binding (no SMTP needed)
  HUB_MAIL_FROM?: string;   // sender on a domain with Email Routing on, e.g. noop@example.com
  HUB_VAPID_PUBLIC?: string;  // b64url raw P-256 point
  HUB_VAPID_PRIVATE?: string; // JWK JSON
}

const json = (d: unknown, status = 200) => Response.json(d, { status });
const CHUNK = 1_000_000; // SQLite row limit is 2 MB
const MAX_MEDIA = 30_000_000;
const STALE_MS = 3 * 60_000;
/** Daily write budget (free plan: 100k rows_written/day per account, shared by every DO in it). */
const WRITE_LEAN = 40_000, WRITE_SHED = 70_000;
const SHEDDABLE = new Set(["system", "daemon", "notice"]);
const HOT = new Set(["status", "host_seen"]), HOT_PERSIST_MS = 5 * 60_000;
const CODE_TTL = 10 * 60_000, CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 10, SEEN_EVERY = 3600_000;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
function sameStr(a: string, b: string) { // constant-time for equal lengths
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function sixDigits() { // unbiased 000000–999999
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4_294_000_000);
  return String(a[0] % 1_000_000).padStart(6, "0");
}
const normEmail = (e: unknown) => typeof e === "string" ? e.trim().toLowerCase() : "";
const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const mcp = isMcpPath(url.pathname);
    if (mcp && req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!mcp && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/media/")) return env.ASSETS.fetch(req);
    if (!env.HUB_TOKEN) return json({ error: "HUB_TOKEN secret not set" }, 500);
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

const isMcpPath = (p: string) => p === "/mcp" || p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-") || p === "/.well-known/openid-configuration";

type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };

export class Hub extends DurableObject<Env> {
  sql: SqlStorage;
  mcp: Mcp;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
    this.mcp = new Mcp({
      sql: this.sql,
      status: () => this.statusView(),
      events: (after, limit) => this.sql.exec("SELECT seq, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit).toArray()
        .map((r) => ({ seq: r.seq as number, ev: JSON.parse(r.json as string) })),
      say: (text, ref) => this.ownerMessage(text, ref),
      enqueue: (op) => this.toInbox({ type: "op", op }),
      hostOnline: () => this.hostOnline(),
      startCode: async (email) => { const r = await this.auth("/api/auth/start", new Request("https://hub/api/auth/start", { method: "POST", body: JSON.stringify({ email }) })); return { status: r.status, body: await r.json() }; },
      checkCode: (email, code) => this.checkCode(email, code),
      newSession: (email, ua) => this.newSession(email, ua),
      dropSession: async (raw) => { this.sql.exec("DELETE FROM sessions WHERE id = ?", await sha256(raw)); },
    });
  }

  statusView() { return { ...(this.get("status") ?? {}), hub: { online: this.hostOnline(), seen: this.get("host_seen") } }; }

  /** Email-code check shared by /api/auth/verify and the OAuth sign-in page. */
  async checkCode(rawEmail: unknown, rawCode: unknown): Promise<{ email?: string; error?: string; status?: number }> {
    const email = normEmail(rawEmail), code = typeof rawCode === "string" ? rawCode.trim() : "";
    if (!validEmail(email) || !/^\d{6}$/.test(code)) return { error: "invalid request", status: 400 };
    const r = this.sql.exec("SELECT hash, expires, attempts FROM auth_codes WHERE email = ?", email).toArray()[0];
    if (!r || (r.expires as number) < Date.now()) return { error: "Invalid or expired code. Request a new one.", status: 401 };
    if ((r.attempts as number) >= CODE_TRIES) return { error: "Too many attempts. Request a new code.", status: 401 };
    this.sql.exec("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?", email);
    if (!sameStr(await sha256(`${email}:${code}`), r.hash as string)) return { error: "Wrong code.", status: 401 };
    this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
    this.sql.exec("DELETE FROM kv WHERE k = 'cli_code'");
    return { email };
  }
  async newSession(email: string, ua: string) {
    const session = hex(crypto.getRandomValues(new Uint8Array(32))), now = Date.now();
    this.sql.exec("INSERT INTO sessions (id, email, created, last_seen, ua) VALUES (?, ?, ?, ?, ?)", await sha256(session), email, now, now, ua.slice(0, 300));
    return session;
  }

  // ---- write budget. The free plan allows 100k rows_written a day per account; past that every DO write errors until
  // 00:00 UTC. Hot state lives in memory and is persisted lazily; a daily counter sheds non-essential writes well before the cap.
  mem = new Map<string, string>();
  flushed = new Map<string, number>();
  budget = { day: "", n: 0 };
  /** Estimated rows written today (a write statement counts ≥ 2: row + index/rowid). */
  spend(rows = 2) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.budget.day !== day) this.budget = { day, n: 0 };
    this.budget.n += rows;
  }
  /** Writes allowed today: "ok", "lean" (hot state persisted rarely) or "shed" (only owner-critical writes). */
  level(): "ok" | "lean" | "shed" {
    const day = new Date().toISOString().slice(0, 10);
    const n = this.budget.day === day ? this.budget.n : 0;
    return n < WRITE_LEAN ? "ok" : n < WRITE_SHED ? "lean" : "shed";
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
    this.spend();
    this.sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, s);
  }
  touchHost() { this.set("host_seen", Date.now()); }

  append(e: Partial<Ev>): Ev {
    const ev = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e } as Ev;
    this.spend(3);
    this.sql.exec("INSERT INTO events (ts, json) VALUES (?, ?)", ev.ts, JSON.stringify(ev));
    if (Math.random() < 0.02) this.sql.exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - 5000 FROM events)");
    const s = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch {}
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
    this.spend();
    this.sql.exec("INSERT INTO inbox (json) VALUES (?)", JSON.stringify(item));
    for (const w of [...this.inboxWaiters]) w();
  }

  ownerMessage(text: string, ref?: string, attachments?: string[], thread = false): Ev {
    const ev = this.append({ from: "owner", kind: "owner", text, ref, ...(attachments?.length ? { attachments } : {}), ...(thread ? { thread } : {}) });
    this.toInbox({ type: "message", event: ev });
    if (!this.hostOnline()) this.append({ from: "hub", kind: "system", text: "Got it. None of the team's computers are online right now; I'll pick this up as soon as one is.", ref: ev.id });
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

  async push(p: string, req: Request, who: "machine" | { session: string }): Promise<Response> {
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
      const r = await this.pushAll({ title: "Noop", body: "Test notification: phone push is on.", kind: "notice", url: "/", tag: "test", options: [], badge: 0 }, "normal", who.session);
      return json({ ok: true, ...r });
    }
    return json({ error: "not found" }, 404);
  }

  hostOnline() { const seen = this.get("host_seen"); return !!seen && Date.now() - seen < STALE_MS; }

  // ---- auth
  credential(req: Request, url: URL) {
    const h = req.headers.get("authorization") ?? "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : url.searchParams.get("token") ?? ""; // WebSocket / <img> can't send headers
  }
  /** "machine" for HUB_TOKEN, the session id for an owner session, null otherwise. */
  async who(req: Request, url: URL): Promise<"machine" | { session: string } | null> {
    const t = this.credential(req, url);
    if (!t) return null;
    if (sameStr(t, this.env.HUB_TOKEN)) return "machine";
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const id = await sha256(t); // store only hashes of session ids
    const r = this.sql.exec("SELECT last_seen FROM sessions WHERE id = ?", id).toArray()[0];
    if (!r) return null;
    if (Date.now() - (r.last_seen as number) > SEEN_EVERY) this.sql.exec("UPDATE sessions SET last_seen = ? WHERE id = ?", Date.now(), id);
    return { session: id };
  }

  async auth(p: string, req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const now = Date.now();
    if (p === "/api/auth/start") {
      const email = normEmail(body?.email);
      if (!validEmail(email)) return json({ error: "invalid email" }, 400);
      let smtp: SmtpCfg | null = null;
      try { smtp = this.env.HUB_SMTP ? JSON.parse(this.env.HUB_SMTP) : null; } catch {}
      // No email set up yet: the code is shown on the owner's own machine instead (`noop login`, needs the machine key).
      const cf = !smtp?.host && !!this.env.EMAIL && !!this.env.HUB_MAIL_FROM;
      const cli = !smtp?.host && !cf;
      this.sql.exec("DELETE FROM auth_sends WHERE ts < ?", now - 3600_000);
      // Per-email throttle applies to every address alike, so it reveals nothing about the allow-list.
      const recent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE email = ? AND ts > ?", email, now - RESEND_MS).one().n as number;
      if (recent) return json({ error: "Please wait a minute before requesting another code." }, 429);
      const sent = this.sql.exec("SELECT COUNT(*) AS n FROM auth_sends WHERE sent = 1").one().n as number;
      if (sent >= SENDS_PER_HOUR) return json({ error: "Too many codes sent. Try again in an hour." }, 429);
      const owners = (this.env.HUB_OWNER_EMAIL ?? "").split(",").map(normEmail).filter(Boolean);
      const isOwner = owners.includes(email) || (cli && !owners.length);
      this.sql.exec("INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, ?)", email, now, isOwner ? 1 : 0);
      if (!isOwner) return json(cli ? { ok: true, delivery: "cli" } : { ok: true });
      const code = sixDigits();
      this.sql.exec("INSERT OR REPLACE INTO auth_codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0)", email, await sha256(`${email}:${code}`), now + CODE_TTL);
      if (cli) { this.set("cli_code", { email, code, expires: now + CODE_TTL }); return json({ ok: true, delivery: "cli" }); }
      if (!isOwner) return json({ ok: true });
      try {
        const subject = `Noop sign-in code: ${code}`;
        const text = `Your Noop sign-in code is:\n\n    ${code}\n\nValid for 10 minutes.\n\nIf this wasn't you, ignore this email.\n`;
        if (cf) await cfMail(this.env.EMAIL!, this.env.HUB_MAIL_FROM!, email, subject, text);
        else await sendMail(smtp!, email, subject, text);
      } catch (err) {
        console.error(`auth mail failed: ${err}`);
        this.sql.exec("DELETE FROM auth_codes WHERE email = ?", email);
        return json({ error: "Couldn't send the code email. Try again later." }, 502);
      }
      return json({ ok: true });
    }
    if (p === "/api/auth/verify") {
      const r = await this.checkCode(body?.email, body?.code);
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
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;

    if (p.startsWith("/api/auth/")) return this.auth(p, req);
    if (isMcpPath(p)) return this.mcp.fetch(req, await this.who(req, url));
    const who = await this.who(req, url);
    if (!who) return json({ error: "unauthorized" }, 401);
    if (p.startsWith("/api/push/")) return this.push(p, req, who);
    if ((p === "/api/files/list" || p === "/api/files/read") && m === "GET") { // owner (and machine) read of READABLE prefixes
      const r = handleReadFiles(this.sql, url);
      if (r) return r;
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
    if (p === "/api/host/login-code") { // `noop login` on the owner's machine, when email isn't configured
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const c = this.get("cli_code");
      return c && c.expires > Date.now() ? json(c) : json({ error: "no pending code" }, 404);
    }
    if (p === "/api/host/join" && m === "POST") { // a new machine, approved by the owner's login, gets the machine key
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { host } = (await req.json().catch(() => ({}))) as { host?: string };
      this.append({ from: "hub", kind: "notice", text: `New machine ${String(host ?? "?").slice(0, 60)} joined the team.` });
      return json({ token: this.env.HUB_TOKEN });
    }
    if (p === "/api/host/revoke-sessions" && m === "POST") {
      await req.text().catch(() => ""); // drain body
      if (who !== "machine") return json({ error: "forbidden" }, 403);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM sessions").one().n;
      this.sql.exec("DELETE FROM sessions");
      this.sql.exec("DELETE FROM push_subs");
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
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000);
      const rows = this.sql.exec(`SELECT * FROM "${t}" ORDER BY rowid LIMIT ? OFFSET ?`, limit, offset).toArray().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
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
          const cols = Object.keys(r);
          const vals = cols.map((c) => { const v = r[c] as any; return v && typeof v === "object" && "$b64" in v ? b64dec(v.$b64) : v; });
          this.sql.exec(`INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...vals);
        }
      });
      return json({ ok: true, n: rows.length });
    }
    if (p === "/api/stream") {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "websocket expected" }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (p === "/api/feed") {
      const since = url.searchParams.get("since") ?? "";
      const rows = this.sql.exec("SELECT json FROM (SELECT seq, json FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 300) ORDER BY seq", since).toArray();
      return json({ events: rows.map((r) => JSON.parse(r.json as string)) });
    }

    if (p === "/api/messages" && m === "POST") {
      const { text = "", reply_to, attachments, thread } = (await req.json()) as { text?: string; reply_to?: string; attachments?: unknown; thread?: unknown };
      const files = ownerAttachments(attachments);
      if (files === null) return json({ error: "bad attachments" }, 400);
      if (files.some((f) => !this.sql.exec("SELECT 1 FROM media WHERE id = ? LIMIT 1", f.slice(7)).toArray().length))
        return json({ error: "attachment not found" }, 400);
      if (!text.trim() && !files.length) return json({ error: "text required" }, 400);
      return json(this.ownerMessage(text, reply_to, files, thread === true && /^T-/.test(reply_to ?? "")));
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
      const rows = this.sql.exec(`SELECT json FROM events WHERE json_extract(json, '$.ref') IN (${refs.map(() => "?").join(",")}) ORDER BY seq`, ...refs).toArray();
      return json({ ...t, events: rows.map((r) => JSON.parse(r.json as string)) });
    }
    if (p === "/api/tasks/cancel" && m === "POST") { // owner: cancel a task; the primary host acts on it
      if (who === "machine") return json({ error: "forbidden" }, 403);
      const { id, done } = (await req.json().catch(() => ({}))) as { id?: string; done?: boolean };
      if (!id || !/^T-[\w]*\d{4}$/.test(id)) return json({ error: "id required" }, 400);
      this.toInbox({ type: "cancel", id, done: done === true });
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
      return new Response(new Blob(parts), { headers: { "content-type": rows[0].type as string, "cache-control": "private, max-age=31536000" } });
    }

    // ---- fleet side
    if (p === "/api/events" && m === "POST") {
      const e = (await req.json()) as Partial<Ev>;
      // over budget, routine fleet chatter is dropped (still in the local journal); what the owner must see still goes through
      if (this.level() === "shed" && SHEDDABLE.has(String(e.kind ?? ""))) return json({ dropped: "write budget" });
      return json(this.append(e));
    }
    if (p === "/api/host/state" && m === "PUT") {
      const { status, settings } = (await req.json()) as { status?: unknown; settings?: unknown };
      if (status) { this.set("status", status); this.mcp.onChanged(["noop://status"]); }
      if (settings) this.set("settings", settings);
      this.touchHost();
      return json({ ok: true });
    }
    if (p === "/api/host/inbox") {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (after > this.acked) { this.sql.exec("DELETE FROM inbox WHERE seq <= ?", after); this.acked = after; this.spend(); } // acked
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

  webSocketMessage() {}
  webSocketClose(ws: WebSocket) { try { ws.close(); } catch {} }
}
