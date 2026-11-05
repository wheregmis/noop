// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `hub cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Jwk, newVapidKeys } from "../cloud/src/push";
import { type Cfg, CODE, P, _commitPush, _pull, hostName, journal, locked, HOME_DIR } from "./core";
import { writeHubToml } from "./sync";
import { ensureWebClient } from "./webclient";
import { type Event, MEDIA, appendEvent, applyOp, handleOwnerMessage, saveSettings, setMirror, settingsView, status, cancelTask, updateFleet } from "./server";

const base = (cfg: Cfg) => String(cfg.cloud?.url ?? "").replace(/\/$/, "");
const headers = (cfg: Cfg) => ({ Authorization: `Bearer ${cfg.server?.token}`, "Content-Type": "application/json" });

async function call(cfg: Cfg, path: string, init: RequestInit = {}, timeoutMs = 15_000) {
  const r = await fetch(base(cfg) + path, { ...init, headers: headers(cfg), signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json() as Promise<any>;
}

/** One of the Worker's media files ("/media/<id>": the owner's uploaded images), as bytes. */
export async function cloudMedia(cfg: Cfg, path: string): Promise<Uint8Array | null> {
  if (!/^\/media\/[\w.\-]+$/.test(path)) return null;
  const r = await fetch(base(cfg) + path, { headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}

/** Primary: run the bridge loop. */
export function startCloudBridge(cfg: Cfg) {
  if (!base(cfg) || !cfg.server?.token) return;
  const pending: Event[] = [];
  // an event's images live in this machine's media folder ("/media/<name>"): upload them first, then point the event at the copies
  const upload = async (url: string): Promise<string | null> => {
    const f = join(MEDIA, basename(url));
    if (!url.startsWith("/media/") || !existsSync(f)) return url;
    const fd = new FormData();
    fd.append("file", Bun.file(f), basename(f));
    const r = await fetch(base(cfg) + "/api/media", { method: "POST", body: fd, headers: { Authorization: `Bearer ${cfg.server?.token}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    return r?.ok ? ((await r.json()) as { url: string }).url : null;
  };
  const flush = async () => {
    while (pending.length) {
      const e = pending[0];
      if (e.attachments?.length) {
        const urls = await Promise.all(e.attachments.map(upload));
        if (urls.some((u) => !u)) return; // retry on the next poll
        pending[0] = { ...e, attachments: urls as string[] };
      }
      if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }))) return;
      pending.shift();
    }
  };
  setMirror((e) => { pending.push(e); void flush(); });

  let after = 0, n = 0, busy = false, lastStatus = "", lastShape = "", lastPush = 0;
  // push the dashboard at once when its shape changes (an answered decision must leave "Needs your decision" at once); live agent
  // activity alone is pushed at most once a minute, and an unchanged dashboard every ~5 min (Worker writes are budgeted)
  const pushStatus = async (force = false) => {
    const s = status();
    const st = JSON.stringify(s);
    const shape = JSON.stringify({ ...s, active: s.active.map(({ activity: _, ...t }) => t) });
    const due = shape !== lastShape || (st !== lastStatus && Date.now() - lastPush > 60_000) || force;
    if (!due) return;
    if (await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ status: s, settings: settingsView() }) })) {
      lastStatus = st; lastShape = shape; lastPush = Date.now();
    }
  };
  // housekeeping every few seconds: mirror events up, push the dashboard
  const loop = async () => {
    if (busy) return; busy = true;
    try {
      await flush();
      await pushStatus(n++ % 100 === 0); // a forced re-push every ~5 min; the Worker skips unchanged writes
    } catch (err) { console.error(`cloud bridge: ${err}`); }
    busy = false;
  };
  // the owner→fleet inbox, long-polled: the Worker holds the request until a message arrives, so the chat brain here
  // gets it within milliseconds (the owner's model login never leaves this machine; only the message and the reply travel)
  const inbox = async () => {
    for (;;) {
      const t0 = Date.now();
      try {
        const r = await call(cfg, `/api/host/inbox?after=${after}&wait=25`, {}, 40_000);
        for (const it of r?.items ?? []) {
          if (it.type === "message") {
            const e = it.event as Event;
            appendEvent(e, { mirror: false }); // keep the local record (learning reads it); the cloud already has it
            await handleOwnerMessage(e.text, e.ref, false, { paths: e.attachments, key: e.id, fetch: (p) => cloudMedia(cfg, p), sentAt: e.ts, thread: e.thread });
          } else if (it.type === "op" && it.op) {
            await applyOp(it.op);
          } else if (it.type === "cancel" && typeof it.id === "string") {
            await cancelTask(it.id, it.done === true);
          } else if (it.type === "update") {
            await updateFleet();
          } else if (it.type === "settings") {
            await saveSettings(it.patch);
            await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
          }
          after = it.seq;
        }
        if (r?.items?.length) await pushStatus();
      } catch (err) { console.error(`cloud bridge inbox: ${err}`); }
      // an older Worker (no long-poll) or an error answers at once: don't spin
      const left = (cfg.cloud?.poll_seconds ?? 3) * 1000 - (Date.now() - t0);
      if (left > 0) await Bun.sleep(left);
    }
  };
  void loop();
  void inbox();
  setInterval(loop, (cfg.cloud?.poll_seconds ?? 3) * 1000);
  console.log(`cloud bridge → ${base(cfg)}`);
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
