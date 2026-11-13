// Cloud bridge: connects the fleet to the owner's own Cloudflare Worker (cloud/). Outbound HTTPS only.
//   primary: mirrors every feed event up, pulls the owner's messages/settings down, pushes status + settings snapshots.
//   workers: forward events/media straight to the Worker (cfg.server.url points there).
// `hub cloud deploy` deploys the Worker into the owner's Cloudflare account (wrangler login once) and records the URL.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Jwk, newVapidKeys } from "../cloud/src/push";
import { ipAllowed, parseAllowList } from "../cloud/src/ipallow";
import { type Cfg, CODE, L, P, _commitPush, _pull, hostName, journal, locked, HOME_DIR } from "./core";
import { updateChannel } from "./channels";
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
  // One flush at a time: the mirror hook and the 3s loop both call this, and two overlapping runs post the same
  // pending[0] twice (the same message shows up twice in the chat) and shift() past an event that never went up.
  // The reset hangs off .finally (a microtask), never off the body: an empty queue drains synchronously, so a
  // try/finally inside would clear the flag before the assignment below stores it and the queue would stall — and an
  // event appended in that same tick would then wait for the next 3s poll. A failed upload sets `stalled` so the
  // re-kick below does not spin on a dead Worker; the poll retries it, as before.
  let flushing: Promise<void> | null = null, stalled = false;
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    return (flushing = (async () => {
      stalled = false;
      while (pending.length) {
        const e = pending[0];
        if (e.attachments?.length) {
          const urls = await Promise.all(e.attachments.map(upload));
          if (urls.some((u) => !u)) { stalled = true; return; } // retry on the next poll
          pending[0] = { ...e, attachments: urls as string[] };
        }
        if (!(await call(cfg, "/api/events", { method: "POST", body: JSON.stringify(pending[0]) }))) { stalled = true; return; }
        pending.shift();
      }
    })().finally(() => { flushing = null; if (!stalled && pending.length) void flush(); }));
  };
  setMirror((e) => { pending.push(e); void flush(); });

  // the inbox cursor and the ids already handled survive restarts: the Worker only drops a message once a later poll
  // acks it, so a daemon restarting mid-batch got the same owner messages again and made duplicate tasks (T-0641)
  const cursorFile = join(HOME_DIR, "cloud-inbox.json");
  const saved = (() => { try { return JSON.parse(readFileSync(cursorFile, "utf8")); } catch { return {}; } })();
  const sameHub = saved.url === base(cfg);
  const seen: string[] = Array.isArray(saved.seen) ? saved.seen : [];
  const saveCursor = () => { try { writeFileSync(cursorFile, JSON.stringify({ url: base(cfg), after, seen: seen.slice(-500) })); } catch {} };
  let after = sameHub ? Number(saved.after) || 0 : 0, n = 0, busy = false, lastStatus = "", lastShape = "", lastPush = 0;
  let watchers = 1; // owner clients connected (the Worker reports it); until it says otherwise, assume someone looks
  // push the dashboard at once when its shape changes (an answered decision must leave "待你决定" at once); live agent
  // activity alone is pushed at most once a minute and only while an owner client is open; an unchanged dashboard
  // every ~15 min (Cloudflare free plan: cloud/src/budget.ts)
  const pushStatus = async (force = false) => {
    const s = status();
    const st = JSON.stringify(s);
    const shape = JSON.stringify({ ...s, active: s.active.map(({ activity: _, ...t }) => t) });
    const due = shape !== lastShape || (watchers > 0 && st !== lastStatus && Date.now() - lastPush > 60_000) || force;
    if (!due) return;
    const r = await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ status: s, settings: settingsView() }) });
    if (r) { lastStatus = st; lastShape = shape; lastPush = Date.now(); if (typeof r.watchers === "number") watchers = r.watchers; }
  };
  // housekeeping every few seconds: mirror events up, push the dashboard (both cost nothing when nothing changed)
  const loop = async () => {
    if (busy) return; busy = true;
    try {
      await flush();
      await pushStatus(n++ % 300 === 0); // a forced re-push every ~15 min; the Worker skips unchanged writes
      if (!live && Date.now() - lastDrain > 60_000) void drain(); // no socket: poll the inbox once a minute
    } catch (err) { console.error(`cloud bridge: ${err}`); }
    busy = false;
  };
  // the owner→fleet inbox. A hibernating WebSocket carries a nudge per item (the Durable Object sleeps in between, and
  // pings are answered without waking it), then the items come over plain GETs, so the chat brain here gets an owner
  // message within milliseconds (the owner's model login never leaves this machine; only the message and the reply travel)
  let live = false, lastDrain = 0, draining = false, again = false;
  const handle = async (it: any) => {
    if (it.type === "message") {
      const e = it.event as Event;
      const fresh = claimInboxMessage(seen, e.id); // redelivered (restart, Worker switch): already handled
      after = it.seq; saveCursor(); // before handling, so a restart mid-message doesn't replay it
      if (!fresh) return;
      appendEvent(e, { mirror: false }); // keep the local record (learning reads it); the cloud already has it
      await handleOwnerMessage(e.text, e.ref, false, { paths: e.attachments, key: e.id, fetch: (p) => cloudMedia(cfg, p), sentAt: e.ts, thread: e.thread, channel: e.channel });
    } else if (it.type === "op" && it.op) {
      await applyOp(it.op);
    } else if (it.type === "cancel" && typeof it.id === "string") {
      await cancelTask(it.id, it.done === true);
    } else if (it.type === "channel" && typeof it.slug === "string") {
      await locked(async () => { if (typeof updateChannel(it.slug, it) !== "string") await _commitPush(`channel ${it.slug}`); });
    } else if (it.type === "update") {
      await updateFleet();
    } else if (it.type === "settings") {
      await saveSettings(it.patch);
      await call(cfg, "/api/host/state", { method: "PUT", body: JSON.stringify({ settings: settingsView() }) });
    }
    after = it.seq; saveCursor();
  };
  /** Fetch and handle inbox items until none are left (each call also acks what came before `after`). */
  const drain = async () => {
    if (draining) { again = true; return; }
    draining = true; lastDrain = Date.now();
    try {
      do {
        again = false;
        for (let page = 0; page < 20; page++) {
          const r = await call(cfg, `/api/host/inbox?after=${after}`);
          const items = r?.items ?? [];
          for (const it of items) await handle(it);
          if (!items.length) break;
          await pushStatus();
        }
      } while (again);
    } catch (err) { console.error(`cloud bridge inbox: ${err}`); }
    draining = false;
  };
  let backoff = 5_000;
  const connect = () => {
    const ws = new WebSocket(base(cfg).replace(/^http/i, "ws") + "/api/host/stream", { headers: { Authorization: `Bearer ${cfg.server?.token}` } } as any);
    let ping: ReturnType<typeof setInterval> | undefined, pong = Date.now();
    ws.onopen = () => {
      live = true; backoff = 5_000; pong = Date.now();
      // keep NAT paths open and notice a dead link; the Worker answers "ping" without waking up
      ping = setInterval(() => { if (Date.now() - pong > 150_000) ws.close(); else try { ws.send("ping"); } catch {} }, 60_000);
      void drain(); // whatever arrived while disconnected
    };
    ws.onmessage = (m) => {
      pong = Date.now();
      let d: any; try { d = JSON.parse(String(m.data)); } catch { return; } // "pong"
      if (d?.type === "inbox") void drain();
      else if (d?.type === "watchers" && typeof d.n === "number") { const was = watchers; watchers = d.n; if (d.n > was) void pushStatus(true); }
    };
    ws.onclose = () => {
      live = false; clearInterval(ping);
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5 * 60_000);
    };
    ws.onerror = () => {};
  };
  void loop();
  connect();
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

/** [cloud] allow_ips (a string or a list of IPs / CIDRs) → the HUB_ALLOW_IPS secret ("" = no IP restriction).
 *  undefined when config.toml has no allow_ips at all: a deploy then leaves the Worker's list as it is, so a machine
 *  whose config is behind (not synced yet) cannot switch the allow-list off by redeploying. */
export function allowIps(cfg: Cfg): string | undefined {
  if (!cfg.cloud || !("allow_ips" in cfg.cloud)) return undefined;
  const v = cfg.cloud?.allow_ips;
  return (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean).join(",");
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
    return fail(L("Log in to your own Cloudflare account first (the free plan is enough):\n  bunx wrangler login\nThen run again: hub cloud deploy", "先登录你自己的 Cloudflare 账号（免费版即可）：\n  bunx wrangler login\n然后重新运行：hub cloud deploy"));
  }
  if (!cfg.server?.token) return fail(L("[server] token is missing, run hub init first", "缺少 [server] token，先运行 hub init"));
  if (!(await ensureWebClient())) return fail(L("Downloading the web client failed, the Worker was not deployed. Check the network and run again: noop cloud deploy", "客户端网页下载失败，Worker 没有部署。请检查网络后重新运行：noop cloud deploy"));
  const name = cfg.cloud?.name ?? "noop";
  // IP allow-list: refuse a list that doesn't parse, or that would shut out the very machine deploying it
  const allow = allowIps(cfg);
  if (allow) {
    const { nets, bad } = parseAllowList(allow);
    if (bad.length) return fail(L(`[cloud] allow_ips has entries that cannot be parsed: ${bad.join(" ")}`, `[cloud] allow_ips 里有无法识别的项：${bad.join(" ")}`));
    const prev = String(cfg.cloud?.domain ? `https://${cfg.cloud.domain}` : cfg.cloud?.url ?? "").replace(/\/$/, "");
    const mine = prev ? (await fetch(`${prev}/cdn-cgi/trace`).then((r) => r.text()).catch(() => "")).match(/^ip=(.+)$/m)?.[1]?.trim() : undefined;
    if (mine && !ipAllowed(mine, nets)) return fail(L(`This machine's public IP ${mine} is not in [cloud] allow_ips: it could not reach the Worker after deploying. Add it first.`, `本机出口 IP ${mine} 不在 [cloud] allow_ips 里：部署后这台机器会连不上 Worker。先把它加进去再部署。`));
  }
  console.log(L(`Deploying to your Cloudflare account (Worker: ${name})…`, `部署到你的 Cloudflare 账号（Worker：${name}）…`));
  // [cloud] domain (e.g. noop.example.com on a zone in the same account) attaches a Custom Domain and becomes the URL
  const domain = String(cfg.cloud?.domain ?? "").trim();
  const deploy = () => $`${wr} deploy --name ${name} ${domain ? ["--domain", domain] : []}`.cwd(dir).env(env).quiet().nothrow();
  let dep = await deploy();
  let out = dep.stdout.toString() + dep.stderr.toString();
  // a brand-new Cloudflare account has no workers.dev subdomain yet, and wrangler can only ask for one with a
  // terminal in front of it — we run it quietly, so on that first deploy hand the user's terminal over for that
  // one-time question, then deploy quietly again to capture the URL (a custom domain never needs workers.dev)
  if (dep.exitCode !== 0 && !domain && /register a workers\.dev subdomain/i.test(out)) {
    const link = out.match(/https:\/\/dash\.cloudflare\.com\/\S+\/workers\/onboarding/)?.[0];
    if (!process.stdin.isTTY)
      return fail(L(`This Cloudflare account has no workers.dev subdomain yet (every account registers one before its first Worker deploy).\nRegister at: ${link ?? "Cloudflare dashboard → Workers & Pages"}\nor run bunx wrangler deploy once interactively in cloud/ and follow the prompts.\nThen run again: hub cloud deploy`, `这个 Cloudflare 账号还没有 workers.dev 子域名（账号第一次部署 Worker 都要先注册一个）。\n注册入口：${link ?? "Cloudflare 控制台 → Workers & Pages"}\n或在 cloud/ 目录交互式运行一次 bunx wrangler deploy，按提示注册。\n然后重新运行：hub cloud deploy`));
    console.log(L("This account has no workers.dev subdomain yet: register one at wrangler's next prompt (one time; every Worker on this account uses it as its prefix)…", "账号还没有 workers.dev 子域名：按 wrangler 接下来的提示注册一个（一次性，之后这个账号的 Worker 都用它做前缀）…"));
    const ask = Bun.spawn([...wr, "deploy", "--name", name], { cwd: dir, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if ((await ask.exited) !== 0) return fail(L("The workers.dev subdomain was not registered. Register it, then run again: hub cloud deploy", "workers.dev 子域名没有注册成；注册好之后重新运行：hub cloud deploy"));
    dep = await deploy();
    out = dep.stdout.toString() + dep.stderr.toString();
  }
  if (dep.exitCode !== 0) return fail(out.slice(-1500));
  const url = domain ? `https://${domain}` : out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
  const secrets: Record<string, string> = { HUB_TOKEN: cfg.server.token, ...(allow !== undefined ? { HUB_ALLOW_IPS: allow } : {}) };
  const e = cfg.email ?? {};
  if (e.to && e.host) {
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_SMTP = JSON.stringify({ host: e.host, port: e.port ?? 465, secure: e.secure ?? (e.port ?? 465) === 465, user: e.user, pass: e.pass, from: e.from ?? e.user });
  } else if (e.to && e.from) { // Cloudflare Email Routing: no SMTP, `from` is an address on a domain with Email Routing on
    secrets.HUB_OWNER_EMAIL = String(e.to);
    secrets.HUB_MAIL_FROM = String(e.from).match(/<([^>]+)>/)?.[1] ?? String(e.from);
  } else console.log(L("Email is not configured, login codes cannot be sent: fill in [email] in the shared config.toml and run noop cloud deploy again", "还没配置邮箱：登录验证码发不出去，在共享的 config.toml 里填 [email] 后重新运行 noop cloud deploy"));
  if (cfg.owner?.language) secrets.HUB_LANG = String(cfg.owner.language);
  const vapid = await vapidKeys();
  secrets.HUB_VAPID_PUBLIC = vapid.publicKey;
  secrets.HUB_VAPID_PRIVATE = JSON.stringify(vapid.privateJwk);
  // `secret bulk` reads JSON from stdin — values never touch argv or the console.
  const sec = Bun.spawn([...wr, "secret", "bulk", "--name", name], { cwd: dir, env, stdin: new Blob([JSON.stringify(secrets)]), stdout: "pipe", stderr: "pipe" });
  if ((await sec.exited) !== 0) return fail(L("Setting the Worker secrets failed:\n", "设置 Worker 密钥失败：\n") + (await new Response(sec.stderr).text()).slice(-800));
  if (!url) return fail(L("Deployed, but the address was not detected: put the workers.dev address in [cloud] url in config.toml", "部署成功，但没识别到地址；请把 workers.dev 地址写进 config.toml 的 [cloud] url"));
  // ---- record the URL (machine-local noop.toml first: the data sync itself goes through this Worker)
  writeHubToml({ cloud: { url, name, ...(account ? { account } : {}), ...(domain ? { domain } : {}) } });
  await locked(async () => {
    await _pull();
    const f = P("config.toml");
    let s = readFileSync(f, "utf8");
    // keep the account too: without it the primary's next redeploy (on every update) may land in another account
    const block = `[cloud]\nurl = "${url}"\nname = "${name}"\n${account ? `account = "${account}"\n` : ""}${domain ? `domain = "${domain}"\n` : ""}${allow !== undefined ? `allow_ips = "${allow}"\n` : ""}`;
    s = /^\[cloud\]/m.test(s) ? s.replace(/^\[cloud\][^\[]*/m, `${block}\n`) : `${s.trimEnd()}\n\n${block}`;
    writeFileSync(f, s);
    writeFileSync(P("README.md"), L(`# noop data\n\nPrivate data (kept in your own Cloudflare Worker): tasks, decisions, memory, logs.\n\n## Client\n\nAddress: **${url}**\n\nOpen it and paste the token to connect (or log in with an email code; the machine token is in ~/.noop/noop.toml on the host). This address is deployed in your own Cloudflare account and does not change.\n`, `# noop data\n\n私有数据（保存在你自己的 Cloudflare Worker 里）：任务、决策、记忆、日志。\n\n## 客户端\n\n地址：**${url}**\n\n打开后粘贴 token 连接（或用邮箱验证码登录；机器 token 在主机的 ~/.noop/noop.toml 里）。这个地址部署在你自己的 Cloudflare 账号里，固定不变。\n`));
    journal(hostName(cfg), `☁️ cloud hub deployed: ${url}`);
    await _commitPush(`cloud hub ${url}`);
  });
  console.log(L(`✓ Deployed: ${url}`, `✓ 已部署：${url}`));
  return url;
}

/** Record an owner message id as handled; false when it was already handled (a replay after a restart or Worker switch). */
export function claimInboxMessage(seen: string[], id?: string): boolean {
  if (!id) return true;
  if (seen.includes(id)) return false;
  seen.push(id);
  return true;
}
