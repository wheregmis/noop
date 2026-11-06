// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `hub cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Jwk, newVapidKeys } from "../cloud/src/push";
import { type Cfg, CODE, P, _commitPush, _pull, hostName, journal, locked, HOME_DIR, loadConfig } from "./core";
import { writeHubToml } from "./sync";
import { applyUiRequest } from "./ui-requests";
import type { UiResult } from "../cloud/src/ui-requests";
import { ensureWebClient } from "./webclient";
import { type Event, MEDIA, appendEvent, applyOp, feed, handleOwnerMessage, saveSettings, setMirror, settingsView, status, cancelTask, updateFleet, recordRequest } from "./server";
import { ActionSyncError } from "../cloud/src/action-errors";
import { receiveMessage } from "./message-receipts";

const base = (cfg: Cfg) => String(cfg.cloud?.url ?? "").replace(/\/$/, "");
const headers = (cfg: Cfg) => ({ Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" });

/** An inbox replay after a daemon restart must not create or amend the owner's work twice. */
export const applyCloudOwnerMessage = (event: Event, handle = handleOwnerMessage) => receiveMessage("cloud", event.id,
  { text: event.text, reply_to: event.ref, attachments: event.attachments ?? [], thread: event.thread === true }, () => event,
  async (ev, first) => {
    if (first) appendEvent(ev, { mirror: false });
    await handle(ev.text, ev.ref, false, { paths: ev.attachments, key: ev.id, sentAt: ev.ts, thread: ev.thread });
  });

function reportActionFailure(key: string, data: Record<string, unknown>, ref?: string) {
  const id = `action-warning-${key}`;
  if (feed("", 2000).some((event) => event.id === id)) return;
  appendEvent({ id, from: "hub", kind: "system", ref: typeof data.id === "string" ? data.id : ref, thread: true,
    text: String(data.error ?? "The change was not confirmed. Check the team's records before trying again.") });
}

async function call(cfg: Cfg, path: string, init: RequestInit = {}, timeoutMs = 15_000, signal?: AbortSignal) {
  const r = await fetch(base(cfg) + path, { ...init, headers: headers(cfg), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json() as Promise<any>;
}

/** One of the Worker's media files ("/media/<id>": the owner's uploaded images), as bytes. */
export async function cloudMedia(cfg: Cfg, path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (!/^\/media\/[\w.\-]+$/.test(path)) return null;
  const r = await fetch(base(cfg) + path, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]) }).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

// Read again after each cycle: settings from the UI arrive through the shared mirror without a daemon restart.
function pollMilliseconds() {
  try {
    const seconds = loadConfig().cloud?.poll_seconds;
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 60) return seconds * 1000;
  } catch { /* A temporarily unreadable config must not spin the bridge. */ }
  return 3000;
}

/** Primary: run the bridge loops; stop aborts transport and waits for any already-started owner action. */
export function startCloudBridge(cfg: Cfg) {
  if (!base(cfg) || !cfg.server?.token) return async () => {};
  const lifetime = new AbortController();
  // Finish an accepted message's images and final feed events while shutdown aborts new polling.
  const mirrorLifetime = new AbortController();
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, inboxTimer: ReturnType<typeof setTimeout> | undefined;
  let acceptingEvents = true;
  let wakeInbox: (() => void) | undefined, stopping: Promise<void> | undefined;
  const request = (path: string, init?: RequestInit, timeout?: number) => stopped ? Promise.resolve(null) : call(cfg, path, init, timeout, lifetime.signal);
  const pending: Event[] = [];
  // an event's images live in this machine's media folder ("/media/<name>"): upload them first, then point the event at the copies
  const upload = async (url: string): Promise<string | null> => {
    const f = join(MEDIA, basename(url));
    if (!url.startsWith("/media/") || !existsSync(f)) return url;
    const fd = new FormData();
    fd.append("file", Bun.file(f), basename(f));
    const r = await fetch(base(cfg) + "/api/media", { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.any([AbortSignal.timeout(60_000), mirrorLifetime.signal]) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { url: string }).url : null;
  };
  let flushing: Promise<void> | undefined;
  const flush = () => flushing ??= (async () => {
    while (pending.length) {
      const e = pending[0];
      if (e.attachments?.length) {
        const urls = await Promise.all(e.attachments.map(upload));
        if (urls.some((u) => !u)) return; // retry on the next poll
        pending[0] = { ...e, attachments: urls as string[] };
      }
      if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }, 15_000, mirrorLifetime.signal))) return;
      pending.shift();
    }
  })().finally(() => { flushing = undefined; });
  setMirror((e) => { if (acceptingEvents) { pending.push(e); void flush().catch((err) => console.error(`cloud bridge: ${err}`)); } });

  const uiResults = new Map<string, UiResult>();
  let after = 0, lastStatus = "", lastShape = "", lastPush = 0, pushing: Promise<void> | undefined;
  // push the dashboard at once when its shape changes (an answered decision must leave "Needs your decision" at once); live agent
  // activity alone is pushed at most once a minute, and an unchanged dashboard every ~5 min (Worker writes are budgeted)
  const pushStatus = () => pushing ??= (async () => {
    if (stopped) return;
    const s = status();
    const st = JSON.stringify(s);
    const shape = JSON.stringify({ ...s, active: s.active.map(({ activity: _, ...t }) => t) });
    const due = shape !== lastShape || (st !== lastStatus && Date.now() - lastPush > 60_000) || Date.now() - lastPush >= 300_000;
    if (!due) return;
    if (await request("/api/host/state", { method: "PUT", body: JSON.stringify({ status: s, settings: settingsView(), ui_api: 1 }) })) {
      lastStatus = st; lastShape = shape; lastPush = Date.now();
    }
  })().finally(() => { pushing = undefined; });
  // housekeeping every few seconds: mirror events up, push the dashboard
  const loop = async () => {
    if (stopped) return;
    try {
      await flush();
      await pushStatus();
    } catch (err) { if (!stopped) console.error(`cloud bridge: ${err}`); }
    if (!stopped) timer = setTimeout(() => { timer = undefined; loopRun = loop(); }, pollMilliseconds());
  };
  // the owner→fleet inbox, long-polled: the Worker holds the request until a message arrives, so the chat brain here
  // gets it within milliseconds (the owner's model login never leaves this machine; only the message and the reply travel)
  const inbox = async () => {
    while (!stopped) {
      const t0 = Date.now();
      try {
        const r = await request(`/api/host/inbox?after=${after}&wait=25`, {}, 40_000);
        for (const it of r?.items ?? []) {
          if (stopped) break;
          try {
          if (it.type === "message") {
            const e = it.event as Event;
            const result = await applyCloudOwnerMessage(e, (text, ref, amend, options) => handleOwnerMessage(text, ref, amend, { ...options, fetch: (p) => cloudMedia(cfg, p, mirrorLifetime.signal) }));
            if (result.status !== 200) throw new ActionSyncError(String(result.data.error), result.data);
          } else if (it.type === "ui-request" && typeof it.id === "string") {
            await applyUiRequest(it.id, request, (req, projectFolder) => recordRequest(req, undefined, projectFolder), uiResults);
          } else if (it.type === "op" && it.op) {
            const result = await applyOp(it.op) as { ok?: boolean; error?: string; data?: Record<string, unknown> } | null;
            if (!result || result.ok === false || result.data?.ok === false) throw new ActionSyncError(String(result?.error ?? result?.data?.error ?? "The action was not confirmed"), result?.data ?? { id: it.op.id });
            if (it.op.tool === "configure_task") {
              appendEvent({ id: crypto.randomUUID(), ts: new Date().toISOString(), from: "hub", kind: "system", ref: it.op.id, thread: true,
                text: "Run settings updated. The scheduler will use your chosen machine requirements." });
            }
          } else if (it.type === "cancel" && typeof it.id === "string") {
            const result = await cancelTask(it.id, it.done === true);
            if (result !== "cancelled" && result !== "done") throw new ActionSyncError(`Could not ${it.done ? "finish" : "cancel"} ${it.id}: ${result}`, { id: it.id });
          } else if (it.type === "update") {
            if (await updateFleet() !== "ok") throw new ActionSyncError("The fleet update could not be started. Reconnect the main machine and try again.");
          } else if (it.type === "settings") {
            await saveSettings(it.patch);
            await request("/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
          }
          } catch (error) {
            if (!(error instanceof ActionSyncError)) throw error;
            reportActionFailure(String(it.seq), error.data, it.event?.ref ?? it.op?.id ?? it.id);
            if (error.data.retryable === true) throw error;
          }
          after = it.seq;
        }
        if (r?.items?.length) await pushStatus();
      } catch (err) { if (!stopped) console.error(`cloud bridge inbox: ${err}`); }
      // an older Worker (no long-poll) or an error answers at once: don't spin
      const left = pollMilliseconds() - (Date.now() - t0);
      if (!stopped && left > 0) await new Promise<void>((resolve) => {
        wakeInbox = resolve;
        inboxTimer = setTimeout(() => { inboxTimer = undefined; wakeInbox = undefined; resolve(); }, left);
      });
    }
  };
  let loopRun = loop();
  const inboxRun = inbox();
  console.log(`cloud bridge → ${base(cfg)}`);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (inboxTimer) clearTimeout(inboxTimer);
    wakeInbox?.();
    lifetime.abort();
    return stopping ??= (async () => {
      await Promise.allSettled([loopRun, inboxRun, pushing]);
      // Let an owner action already underway publish its final feed events before closing the mirror.
      acceptingEvents = false;
      try { await flush(); }
      catch (err) { console.error(`cloud bridge: ${err}`); }
      finally { mirrorLifetime.abort(); pending.length = 0; }
    })();
  };
}

/** Web Push VAPID keypair: generated once, kept in ~/.noop/vapid.json (0600) so redeploys keep phones subscribed. */
async function vapidKeys(): Promise<{ publicKey: string; privateJwk: Jwk }> {
  const f = join(HOME_DIR, "vapid.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const k = await newVapidKeys();
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(k), { mode: 0o600 });
  return k;
}

/** Why the last cloudDeploy returned false (for the journal: a daemon's console is out of the owner's sight). */
export let lastDeployError = "";

/** Deploy the Worker into the owner's Cloudflare account; set the token secret; record the URL (noop.toml + shared config). */
export async function cloudDeploy(cfg: Cfg) {
  lastDeployError = "";
  const fail = (why: string) => { lastDeployError = why; console.log(why); return false as const; };
  const dir = join(CODE, "cloud");
  const wr = ["bunx", "wrangler"];
  // a login with several accounts can't deploy non-interactively: [cloud] account (or CLOUDFLARE_ACCOUNT_ID) picks one
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || cfg.cloud?.account;
  const env = { ...process.env, ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
  const who = await $`${wr} whoami`.cwd(dir).env(env).quiet().nothrow();
  if (!/logged in/i.test(who.stdout.toString())) {
    return fail("Sign in to your own Cloudflare account first (the free plan is enough):\n  bunx wrangler login\nThen run again: hub cloud deploy");
  }
  if (!cfg.server?.token) return fail("Missing [server] token; run hub init first");
  if (!(await ensureWebClient())) return fail("Downloading the web client failed, so the Worker wasn't deployed. Check your network and run again: noop cloud deploy");
  const name = cfg.cloud?.name ?? "noop";
  console.log(`Deploying to your Cloudflare account (Worker: ${name})…`);
  const dep = await $`${wr} deploy --name ${name}`.cwd(dir).env(env).quiet().nothrow();
  const out = dep.stdout.toString() + dep.stderr.toString();
  if (dep.exitCode !== 0) return fail(out.slice(-1500));
  const url = out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  const secrets: Record<string, string> = { HUB_TOKEN: cfg.server.token };
  const e = cfg.email ?? {};
  if (e.to && e.host) {
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_SMTP = JSON.stringify({ host: e.host, port: e.port ?? 465, secure: e.secure ?? (e.port ?? 465) === 465, user: e.user, pass: e.pass, from: e.from ?? e.user });
  } else if (e.to && e.from) { // Cloudflare Email Routing: no SMTP, `from` is an address on a domain with Email Routing on
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_MAIL_FROM = String(e.from).match(/<([^>]+)>/)?.[1] ?? String(e.from);
  } else console.log("No email configured: sign-in codes can't be sent. Fill in [email] in the shared config.toml and run noop cloud deploy again");
  const vapid = await vapidKeys();
  secrets.HUB_VAPID_PUBLIC = vapid.publicKey;
  secrets.HUB_VAPID_PRIVATE = JSON.stringify(vapid.privateJwk);
  // `secret bulk` reads JSON from stdin — values never touch argv or the console.
  const sec = Bun.spawn([...wr, "secret", "bulk", "--name", name], { cwd: dir, env, stdin: new Blob([JSON.stringify(secrets)]), stdout: "pipe", stderr: "pipe" });
  if ((await sec.exited) !== 0) return fail("Setting the Worker secrets failed:\n" + (await new Response(sec.stderr).text()).slice(-800));
  if (!url) return fail("Deployed, but the URL wasn't detected; put the workers.dev address in [cloud] url in config.toml");
  // ---- record the URL (machine-local noop.toml first: the data sync itself goes through this Worker)
  writeHubToml({ cloud: { url, name, ...(account ? { account } : {}) } });
  await locked(async () => {
    await _pull();
    const f = P("config.toml");
    let s = readFileSync(f, "utf8");
    s = /^\[cloud\]/m.test(s) ? s.replace(/^\[cloud\][^\[]*/m, `[cloud]\nurl = "${url}"\nname = "${name}"\n\n`) : `${s.trimEnd()}\n\n[cloud]\nurl = "${url}"\nname = "${name}"\n`;
    writeFileSync(f, s);
    writeFileSync(P("README.md"), `# noop data\n\nPrivate data (stored in your own Cloudflare Worker): tasks, decisions, memory, logs.\n\n## Client\n\nAddress: **${url}**\n\nOpen it and paste the token to connect (or sign in with an emailed code; the machine token is in ~/.noop/noop.toml on the host). This address is deployed in your own Cloudflare account and stays fixed.\n`);
    journal(hostName(cfg), `☁️ cloud hub deployed: ${url}`);
    await _commitPush(`cloud hub ${url}`);
  });
  console.log(`✓ Deployed: ${url}`);
  return url;
}
