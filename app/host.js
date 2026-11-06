// The web page's host (nsh.json `web.host`): what the app asks of the browser it runs in.
// - page: where the app was served from (it talks to the hub that serves it), `?theme=`, and `?ref=`
//   (a notification opened the app on an event).
// - Web Push: the service worker (sw.js, next to index.html), the permission, the subscription,
//   the login session kept in IndexedDB for the worker, the app badge and the document title.
// - Dictation: the browser's speech recognition (SpeechRecognition / webkitSpeechRecognition).
// Events to the app: `open` { ref } when a notification is clicked while the app is open;
// `speech` { text } with the whole transcript of the dictation so far (final and interim results)
// and `speechEnd` { error? } when it stops.

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
async function put(key, value) {
  const d = await db();
  return new Promise((resolve) => {
    const t = d.transaction(STORE, "readwrite");
    value == null ? t.objectStore(STORE).delete(key) : t.objectStore(STORE).put(value, key);
    t.oncomplete = () => resolve(true);
    t.onerror = () => resolve(false);
  });
}

/** Pending actions need a transaction acknowledgement, including abort/error, before they are sent. */
async function pendingDocument(scope, text, expected) {
  if (typeof scope !== "string" || !/^[a-f0-9]{64}$/.test(scope)) throw new Error("Invalid pending-action storage scope");
  if (text !== undefined && typeof text !== "string") throw new Error("Pending-action storage requires text");
  const writing = text !== undefined;
  if (writing && expected !== null && typeof expected !== "string") throw new Error("Pending-action storage requires its previous value");
  const d = await db();
  return new Promise((resolve, reject) => {
    let value, failure;
    const fail = (error) => { d.close(); reject(error ?? new Error("Pending-action storage transaction failed")); };
    try {
      const t = d.transaction(STORE, writing ? "readwrite" : "readonly");
      t.onabort = () => fail(failure ?? t.error ?? new Error("Pending-action storage transaction was aborted"));
      t.onerror = () => fail(t.error);
      t.oncomplete = () => {
        d.close();
        if (writing) resolve({ scope, saved: true });
        else if (value === undefined || value === null || typeof value === "string") resolve({ scope, text: value ?? null });
        else reject(new Error("Saved pending actions are not text"));
      };
      const store = t.objectStore(STORE), request = store.get(`pending:${scope}`);
      request.onsuccess = () => {
        value = request.result;
        if (!writing) return;
        try {
          if ((value ?? null) !== expected) throw new Error("Saved pending actions changed in another window. Reload before trying again.");
          store.put(text, `pending:${scope}`);
        } catch (error) { failure = error; t.abort(); }
      };
    } catch (error) { fail(error); }
  });
}

const ua = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);
const isIos = () => /iPhone|iPad|iPod/.test(ua()) || (/Macintosh/.test(ua()) && navigator.maxTouchPoints > 1);
const standalone = () =>
  (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function deviceLabel() {
  const u = ua();
  const device = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) || (isIos() && /Macintosh/.test(u)) ? "iPad" : /Android/.test(u) ? "Android" : /Mac OS X/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "Device";
  const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "Browser";
  return `${device} · ${standalone() ? "Home screen app" : browser}`;
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let registration = null;
async function sw() {
  if (registration) return registration;
  registration = await navigator.serviceWorker.register(new URL("sw.js", location.href).href, { scope: "./" });
  await navigator.serviceWorker.ready;
  return registration;
}

async function pushState() {
  const state = {
    supported: supported(),
    ios: isIos(),
    standalone: standalone(),
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    subscribed: false,
    endpoint: null,
    device: deviceLabel(),
  };
  if (!state.supported) return state;
  try {
    const reg = await navigator.serviceWorker.getRegistration("./");
    const sub = reg && (await reg.pushManager.getSubscription());
    state.subscribed = !!sub && state.permission === "granted";
    state.endpoint = sub ? sub.endpoint : null;
  } catch {}
  return state;
}

const Recognition = () =>
  typeof window === "undefined" ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;

let recognition = null;
function speechStart(player, lang) {
  const R = Recognition();
  if (!R) throw new Error("unsupported");
  if (recognition) recognition.abort();
  const r = new R();
  recognition = r;
  r.lang = lang || "zh-CN";
  r.continuous = true;
  r.interimResults = true;
  let error = null;
  r.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    player.hostEvent("speech", { text });
  };
  r.onerror = (e) => (error = e.error || "error");
  r.onend = () => {
    if (recognition === r) recognition = null;
    player.hostEvent("speechEnd", error && error !== "aborted" ? { error } : {});
  };
  r.start();
}

export function createHost(player) {
  const title = typeof document === "undefined" ? "" : document.title || "noop";
  if (supported()) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "open") player.hostEvent("open", { ref: e.data.ref ?? null });
    });
    // Keep the worker current (a new sw.js takes over at once: it skips waiting).
    navigator.serviceWorker.getRegistration("./").then((reg) => reg && reg.update()).catch(() => {});
  }
  return {
    async call(name, args = {}) {
      if (name === "pendingRead") return pendingDocument(args.scope);
      if (name === "pendingWrite") {
        if (typeof args.text !== "string") throw new Error("Pending-action storage requires text");
        return pendingDocument(args.scope, args.text, args.expected);
      }
      if (typeof location === "undefined") return {}; // headless test runs have no page
      switch (name) {
        case "page": {
          const q = new URLSearchParams(location.search);
          const ref = q.get("ref");
          if (ref) history.replaceState(null, "", location.pathname); // opened from a notification: once
          return { origin: location.origin, theme: q.get("theme"), ref };
        }
        case "pushState":
          return pushState();
        case "pushEnable": {
          // Called from the button's press: the permission prompt needs the user's gesture.
          if (!supported()) throw new Error("unsupported");
          const permission = await Notification.requestPermission();
          if (permission !== "granted") return { permission, subscription: null };
          const reg = await sw();
          let sub = await reg.pushManager.getSubscription();
          if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(args.publicKey) });
          return { permission, subscription: sub.toJSON(), device: deviceLabel() };
        }
        case "pushDisable": {
          const reg = supported() ? await navigator.serviceWorker.getRegistration("./") : null;
          const sub = reg && (await reg.pushManager.getSubscription());
          const endpoint = sub ? sub.endpoint : null;
          if (sub) await sub.unsubscribe();
          return { endpoint };
        }
        case "setSession":
          // The worker answers decisions from a notification with it.
          await put("session", args.session ?? null);
          await put("origin", args.origin ?? null);
          return {};
        case "setBadge": {
          const n = Number(args.count) || 0;
          document.title = n > 0 ? `(${n}) ${title}` : title;
          try {
            if (navigator.setAppBadge) n > 0 ? await navigator.setAppBadge(n) : await navigator.clearAppBadge();
          } catch {}
          return {};
        }
        case "clearNotifications": {
          const reg = supported() ? await navigator.serviceWorker.getRegistration("./") : null;
          reg?.active?.postMessage({ type: "clear", ref: args.ref ?? null });
          return {};
        }
        case "vibrate":
          try {
            navigator.vibrate?.(args.pattern ?? [40, 60, 40]);
          } catch {}
          return {};
        case "speechState":
          return { supported: !!Recognition() };
        case "speechStart":
          // Called from the microphone button's press: the permission prompt needs the user's gesture.
          speechStart(player, args.lang);
          return {};
        case "speechStop":
          // The words still being heard come as a last `speech`, then `speechEnd`.
          recognition?.stop();
          return {};
        case "speechAbort":
          recognition?.abort();
          return {};
        default:
          throw new Error(`unknown host function ${name}`);
      }
    },
  };
}
