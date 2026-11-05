// noop's service worker: Web Push notifications for the owner's phone and desktop.
// Shipped next to the web package's index.html (build-web.sh copies it), so its scope is the whole app.
// The page's host (host.js) registers it and keeps the login session in IndexedDB for it.

const DB = "noop";
const STORE = "kv";

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function get(key) {
  const d = await db();
  return new Promise((resolve) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}

const ASKS = ["decision", "menu", "proposals", "login"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let p = {};
  try {
    p = e.data ? e.data.json() : {};
  } catch {
    p = { title: "Noop", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(show(p));
});

async function show(p) {
  const ask = ASKS.includes(p.kind);
  const options = Array.isArray(p.options) ? p.options : [];
  // Decisions get one-tap answers (the platforms show at most two actions), then "Open".
  const actions = ask && p.ref ? options.slice(0, 2).map((o) => ({ action: `answer:${o}`, title: label(o) })) : [];
  actions.push({ action: "open", title: "Open" });
  const scope = self.registration.scope;
  if (typeof p.badge === "number" && self.navigator.setAppBadge) {
    try {
      p.badge > 0 ? await self.navigator.setAppBadge(p.badge) : await self.navigator.clearAppBadge();
    } catch {}
  }
  await self.registration.showNotification(p.title || "Noop", {
    body: p.body || "",
    tag: p.tag || p.ref || undefined,
    renotify: ask && !!(p.tag || p.ref),
    requireInteraction: ask,
    icon: `${scope}icons/192.png`,
    badge: `${scope}icons/192.png`,
    data: { ref: p.ref || null, url: p.url || (p.ref ? `${scope}?ref=${encodeURIComponent(p.ref)}` : scope), kind: p.kind || "" },
    actions,
  });
}

function label(o) {
  const s = String(o);
  if (/^all$/i.test(s)) return "Approve all";
  if (/^none$/i.test(s)) return "None";
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}
/** "B: Upgrade" → "B"; "1 Write tests" → "1". */
function choice(o) {
  const m = String(o).match(/^\s*([A-Z]|\d+|all|none)\b/i);
  return m ? m[1] : String(o);
}

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  if (e.action && e.action.startsWith("answer:") && data.ref) {
    e.waitUntil(answer(data.ref, choice(e.action.slice(7))));
    return;
  }
  e.waitUntil(open(data));
});

async function answer(ref, value) {
  const session = await get("session");
  const origin = (await get("origin")) || new URL(self.registration.scope).origin;
  let ok = false;
  try {
    const r = await fetch(`${origin}/api/push/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ ref, answer: value }),
    });
    ok = r.ok;
  } catch {}
  await self.registration.showNotification(ok ? `Replied to ${ref}` : `Reply to ${ref} failed`, {
    body: ok ? `You chose ${value}` : "Tap here to open Noop and try again",
    tag: `answered:${ref}`,
    icon: `${self.registration.scope}icons/192.png`,
    data: { ref, url: `${self.registration.scope}?ref=${encodeURIComponent(ref)}` },
  });
  if (ok) setTimeout(() => clearTag(`answered:${ref}`), 4000);
}

async function clearTag(tag) {
  for (const n of await self.registration.getNotifications({ tag })) n.close();
}

async function open(data) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = all.find((c) => c.url.startsWith(self.registration.scope)) || all[0];
  if (client) {
    await client.focus();
    client.postMessage({ type: "open", ref: data.ref || null });
    return;
  }
  await self.clients.openWindow(data.url || self.registration.scope);
}

// The page asks to clear what is shown for a ref (answered or viewed), or every notification.
self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type !== "clear") return;
  e.waitUntil(
    self.registration.getNotifications().then((ns) => {
      for (const n of ns) if (!m.ref || n.tag === m.ref || (n.data && n.data.ref === m.ref)) n.close();
    }),
  );
});
