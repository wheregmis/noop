import { describe, expect, open as openNsh, test } from "nsh/test";
import { URL as ParsedURL } from "url";
import { CONFIGURATION_FIELDS, RESOURCE_FIELDS, MACHINE_RESOURCE_FIELDS, MACHINE_CONFIGURATION_FIELDS, type AutonomyLevel, type AutonomyPolicy, type ConfigValue } from "../cloud/src/configuration";
import { type ArchiveKind, type ArchivePreview, type ArchiveRestoreRequest } from "../cloud/src/archives";
import { type TaskCreateRequest, type TaskReopenRequest, type TaskReopenPreview, type TaskFormResult } from "../cloud/src/task-forms";
import { PROVIDER_IDS, providerOrders, type ToolPolicy } from "../cloud/src/providers";
import { learningTaskBinding, type LearningPending, type LearningRunResult } from "../cloud/src/learning";
import { intentScope, readPendingEntry, type PendingEntry } from "./pending-intents";

const URL = "http://hub.test:8787";
const STORAGE = { "hub.url": URL, "hub.token": "tok" };
// UI tests simulate acknowledged storage; separate platform probes exercise the real native and browser adapters.
function open(entry: Parameters<typeof openNsh>[0], options?: Parameters<typeof openNsh>[1]) {
  const saved = new Map<string, string>();
  return openNsh(entry, { ...options, host: { ...options?.host, handlers: {
    pendingRead: (args: any) => ({ scope: args.scope, text: saved.get(args.scope) ?? null }),
    pendingWrite: (args: any) => { if ((saved.get(args.scope) ?? null) !== args.expected) throw new Error("Saved requests changed; reload them first"); saved.set(args.scope, args.text); return { scope: args.scope, saved: true }; },
    ...options?.host?.handlers,
  } } });
}
const ts = (min: number) => new Date(Date.now() - (60 - min) * 60000).toISOString();

const events = [
  { id: "e1", ts: ts(1), from: "lead@mac", kind: "notice", text: "Started on `T-0007`, finishing *soon*" },
  {
    id: "e2", ts: ts(2), from: "hub", kind: "decision", ref: "D-0001",
    text: "Upgrade the dependencies? Recommendation: B", options: ["A: Don't upgrade", "B: Upgrade", "C: Evaluate first"],
  },
  {
    id: "e3", ts: ts(3), from: "hub", kind: "proposals", ref: "P-0002",
    text: "Approval list", options: ["1 Write tests", "2 Fix docs", "all", "none"],
  },
  { id: "e4", ts: ts(4), from: "owner", kind: "owner", text: "P-0002 1" },
  { id: "e5", ts: ts(5), from: "hub", kind: "system", text: "⚙️ Settings updated: {\"routines\":{}}" },
  { id: "e6", ts: ts(6), from: "dev@linux-box", kind: "notice", text: "T-0005 is fixed, see https://github.com/acme/app/pull/42" },
];
const status = {
  tasks: { proposed: 1, inbox: 2, active: 1, blocked: 0, failed: 0, done: 9 },
  active: [{ id: "T-0007", title: "Screenshot-check gallery", agent: "dev", host: "linux-box" }],
  decisions: [{ id: "D-0001", kind: "decision", question: "Upgrade the dependencies?", held: true }],
  recent: [{ id: "T-0005", title: "Fix login page", agent: "dev", host: "linux-box", state: "done", finished: ts(30), updated: ts(30) }],
  hosts: [{
    host: "linux-box", caps: ["os:linux", "arch:x64", "cli:claude"], seen: ts(59), busy: 1,
    stats: { loadRatio: 0.42, cores: 8, memFreePct: 40, diskFreeGB: 120, diskFreePct: 60 },
    os: "linux", arch: "x64", clis: ["claude"], accounts: [{ cli: "claude", name: "default", state: "ok" }],
    running: [{ id: "T-0007", title: "Screenshot-check gallery", agent: "dev", started: ts(50) }],
    recent: [{ id: "T-0005", title: "Fix login page", state: "done", finished: ts(30) }],
    rev: "c1cc0851234567890abcdef1234567890abcdef0", rev_url: "https://github.com/acme/noop/commit/c1cc0851234567890abcdef1234567890abcdef0",
  }],
};

const prDecision = {
  id: "e7", ts: ts(7), from: "hub", kind: "decision", ref: "D-H0003",
  text: "Merge nsh #747? Updated per D-H0002's feedback, see `nsh#1` and other#3\n\nRecommendation: *A*",
  options: ["A: squash merge https://github.com/acme/nsh/pull/747 — ships in the release", "B: Keep editing"],
};

function hub(posts: { text: string; reply_to?: string }[], extra: unknown[] = []) {
  return {
    [`GET ${URL}/api/stops/capabilities`]: { body: { family_stops: 1 } },
    [`GET ${URL}/api/feed`]: { body: { events: [...events, ...extra] } },
    [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
    [`GET ${URL}/api/status`]: { body: status },
    [`POST ${URL}/api/messages`]: (r: { body?: string | null }) => {
      const m = JSON.parse(r.body!);
      posts.push(m);
      return { body: { id: `o${posts.length}`, ts: new Date().toISOString(), from: "owner", kind: "owner", text: m.text, ref: m.reply_to } };
    },
  };
}

type Auth = { starts: unknown[]; verifies: unknown[]; logouts: number };
function auth(log: Auth, opts: { start?: number; code?: string } = {}) {
  return {
    [`POST ${URL}/api/auth/start`]: (r: { body?: string | null }) => {
      log.starts.push(JSON.parse(r.body!));
      return opts.start ? { status: opts.start, body: { error: opts.start === 429 ? "Too many requests" : "email not configured" } } : { body: { ok: true } };
    },
    [`POST ${URL}/api/auth/verify`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.verifies.push(b);
      return b.code === (opts.code ?? "123456") ? { body: { session: "sess" } } : { status: 401, body: { error: "bad code" } };
    },
    [`POST ${URL}/api/auth/logout`]: () => {
      log.logouts++;
      return { body: { ok: true } };
    },
  };
}
const newLog = (): Auth => ({ starts: [], verifies: [], logouts: 0 });

describe("login", () => {
  test("email, then the 6-digit code logs in and keeps the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { network: { ...hub([]), ...auth(log) } });
    await app.waitFor("Sign in to Noop");
    await app.clear("id:url");
    await app.type("id:url", "hub.test:8787/");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("id:code");
    expect(log.starts).toEqual([{ email: "ceo@example.com" }]);
    expect(app.shows("text:/Resend \\(\\d+s\\)/")).toBe(true);
    await app.type("id:code", "123456"); // auto-submits on the 6th digit
    await app.waitFor("id:composer");
    expect(log.verifies).toEqual([{ email: "ceo@example.com", code: "123456" }]);
    expect(app.storage()["hub.token"]).toBe("sess");
    expect(app.storage()["hub.url"]).toBe(URL);
    expect(app.storage()["hub.email"]).toBe("ceo@example.com");
  });

  test("served by the hub: no address field; a pasted code with spaces works", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      host: { handlers: { page: { origin: URL } } },
      storage: { "hub.email": "ceo@example.com" },
      network: { ...hub([]), ...auth(log) },
    });
    await app.waitFor("Sign in to Noop");
    expect(app.shows("id:url")).toBe(false);
    expect(app.value("id:email")).toBe("ceo@example.com");
    await app.submit("id:email");
    await app.waitFor("id:code");
    await app.paste("id:code", { text: "123 456" });
    await app.waitFor("id:composer");
  });

  test("a wrong code, rate limits and no email configured are explained", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: { ...hub([]), ...auth(log) } });
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.type("id:code", "000000");
    await app.waitFor("text:/code is wrong/");
    expect(app.value("id:code")).toBe("");

    const limited = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 429 }) });
    await limited.type("id:email", "ceo@example.com");
    await limited.press("id:send-code");
    await limited.waitFor("text:/Too many requests/");

    const noMail = await open("./App.tsx", { host: { handlers: { page: { origin: URL } } }, network: auth(newLog(), { start: 503 }) });
    await noMail.type("id:email", "ceo@example.com");
    await noMail.press("id:send-code");
    await noMail.waitFor("text:/no email sending configured/");
  });

  test("an unreachable server is told apart", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.clear("id:url");
    await app.type("id:url", "nowhere.test:1");
    await app.type("id:email", "ceo@example.com");
    await app.press("id:send-code");
    await app.waitFor("text:/Can't reach the server/");
  });

  test("a 401 sends you back to the login", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      network: { [`GET ${URL}/api/feed`]: { status: 401 }, [`GET ${URL}/api/status`]: { status: 401 } },
    });
    await app.waitFor("Your session expired. Please sign in again.");
    expect(app.storage()["hub.token"]).toBe(undefined);
  });

  test("Sign out calls logout and forgets the session", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), ...auth(log), [`GET ${URL}/api/settings`]: { status: 500 } },
    });
    await app.press("id:settings");
    await app.press("id:settings-tab-account");
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(log.logouts).toBe(1);
    expect(app.storage()["hub.token"]).toBe(undefined);
  });
});

describe("channel", () => {
  test("virtualized timeline recycles messages and jumps to an off-screen decision", async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
      id: `long-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Long timeline message ${i}`,
    }));
    const app = await open("./App.tsx", { storage: STORAGE, width: 390, height: 800, platform: "ios", network: hub([], many) });
    await app.waitFor("Long timeline message 89");
    expect(app.shows("Long timeline message 0")).toBe(false);
    await app.scroll("id:timeline", -20000);
    await app.waitFor("Long timeline message 0");
    expect(app.shows("Long timeline message 89")).toBe(false);
    await app.scroll("id:timeline", 20000);
    await app.waitFor("Long timeline message 89");
    expect(app.shows("Long timeline message 0")).toBe(false);
  });
  test("a new message leaves a timeline scrolled up where it is; at the end it follows", async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ id: `tail-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Tail message ${i}` }));
    const later: unknown[] = [];
    const arrive = (text: string) => later.push({ id: text, ts: new Date().toISOString(), from: "agent", kind: "notice", text });
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 390, height: 800, platform: "ios",
      network: { ...hub([], many), [`GET ${URL}/api/feed?*`]: () => ({ body: { events: later.splice(0) } }) },
    });
    await app.waitFor("Tail message 89");
    expect(app.shows("label:Jump to latest")).toBe(false);

    // Just off the end, closer than a message: it stays put and counts what came below.
    await app.scroll("id:timeline", -40);
    await app.waitFor("Jump to latest");
    arrive("Below the fold");
    await app.waitFor("1 new message", { timeout: 10000 });
    await app.wait(300); // following would reach the end, and the end clears the count
    expect(app.shows("1 new message")).toBe(true);

    // Further up, what is on screen does not change.
    await app.scroll("id:timeline", -1500);
    const onScreen = () => app.texts().filter((t) => t.startsWith("Tail message"));
    const before = onScreen();
    expect(before.length).toBeGreaterThan(0);
    arrive("Further below");
    await app.waitFor("2 new messages", { timeout: 10000 });
    await app.wait(300);
    // Rows mounted around the viewport come and go; none from nearer the end may appear.
    expect(onScreen().filter((t) => !before.includes(t))).toEqual([]);

    // Back at the end, new messages show by themselves.
    await app.press("label:Jump to latest");
    await app.waitFor("Further below");
    await app.waitUntil(() => !app.shows("label:Jump to latest"));
    arrive("Followed");
    await app.waitFor("Followed", { timeout: 10000 });
    expect(app.shows("label:Jump to latest")).toBe(false);
  });

  test("proposal selection survives a recycled timeline cell", async () => {
    const proposal = { id: "proposal-long", ts: ts(8), from: "hub", kind: "proposals", ref: "P-0900", text: "Choose\n1. Save selection" };
    const many = Array.from({ length: 90 }, (_, i) => ({ id: `recycle-${i}`, ts: ts(10 + i / 100), from: "agent", kind: "notice", text: `Recycled message ${i}` }));
    const app = await open("./App.tsx", { storage: STORAGE, width: 390, height: 800, platform: "ios", network: hub([], [proposal, ...many]) });
    await app.waitFor("Recycled message 89");
    await app.scroll("id:timeline", -20000);
    await app.waitFor("id:proposal-P-0900-1");
    await app.press("id:proposal-P-0900-1");
    await app.waitFor("Approve selected (1)");
    await app.scroll("id:timeline", 20000);
    await app.waitFor("Recycled message 89");
    await app.scroll("id:timeline", -20000);
    await app.waitFor("Approve selected (1)");
  });

  test("a message's avatar sits in the name's row on a phone, and in its own column when wide", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 390, height: 800, platform: "ios" });
    await app.waitFor("text:/is fixed/");
    expect(app.shows("id:avatar-inline-e6")).toBe(true);
    expect(app.shows("id:avatar-column-e6")).toBe(false);
    await app.setViewport(1200, 800);
    await app.waitFor("id:avatar-column-e6");
    expect(app.shows("id:avatar-inline-e6")).toBe(false);
  });

  test("shows the timeline, cards and sidebar", async () => {
    const today = { id: "today", ts: new Date().toISOString(), from: "hub", kind: "notice", text: "Current-day message" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], [today]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("Upgrade the dependencies? Recommendation: B");
    expect(app.shows("Today")).toBe(true);
    expect(app.shows("Decision")).toBe(true);
    expect(app.shows("id:opt-D-0001-B")).toBe(true);
    expect(app.shows("All")).toBe(true);
    expect(app.shows("None")).toBe(true);
    expect(app.shows("↳ P-0002") || app.shows("P-0002")).toBe(true);
    // sidebar
    expect(app.shows("text:/Settings updated/")).toBe(false);
    await app.waitFor("Screenshot-check gallery");
    expect(app.shows("Needs your decision")).toBe(true);
    expect(app.shows("text:/linux-box/")).toBe(true);
    expect(app.shows("text:/Queued 2/")).toBe(true);
  });

  test("a task id is a chip that opens the task; a GitHub PR link is a plain link named repo#n", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:app#42");
    expect(app.shows("id:gh-chip-app-42")).toBe(false);
    expect(app.shows("text:/github\\.com\\/acme\\/app/")).toBe(false);
    await app.press("text:app#42");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/app/pull/42"]);
    await app.press("id:task-chip-T-0005");
    await app.waitFor("Task T-0005");
  });

  test("a task page is its conversation: what was said about it, and a box that adds to it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const said = [
      { id: "e10", ts: ts(10), from: "owner", kind: "owner", ref: "T-0005", text: "Check the login page on a phone too" },
      { id: "e11", ts: ts(11), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "Works on a phone too, screenshot attached" },
      { id: "e12", ts: ts(12), from: "hub", kind: "system", ref: "T-0005", text: "Got it, added to T-0005" },
    ];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, said), width: 1200, height: 800, platform: "macos" });
    await app.press("id:task-chip-T-0005 >> nth=0");
    await app.waitFor("id:task-talk");
    expect(app.shows("text:Check the login page on a phone too")).toBe(true);
    expect(app.shows("text:Works on a phone too, screenshot attached")).toBe(true);
    await app.type("id:task-composer", "Check on iPad too");
    await app.press("id:task-send");
    expect(app.value("id:task-composer")).toBe(""); // reads as sent before the hub answers
    expect(app.shows("Sending…")).toBe(false);
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Check on iPad too", reply_to: "T-0005", thread: true });
    await app.waitUntil(() => app.value("id:task-composer") === "");
    await app.waitFor("text:Check on iPad too");
  });

  test("a task's conversation stays on its page: the main channel skips it, old messages load, and its cards can be answered there", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const said = [
      { id: "e20", ts: ts(20), from: "owner", kind: "owner", ref: "T-0005", thread: true, text: "Said only inside the task" },
      { id: "e21", ts: ts(21), from: "hub", kind: "system", ref: "T-0005", thread: true, text: "Reply inside the task" },
      { id: "e22", ts: ts(22), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "Main results are in the main chat" },
    ];
    const net = {
      ...hub(posts, said),
      [`GET ${URL}/api/tasks/get?*`]: { body: { id: "T-0005", title: "t", agent: "lead", state: "done", decisions: ["D-0701"], events: [
        { id: "e1", ts: ts(1), from: "dev@linux-box", kind: "notice", ref: "T-0005", text: "A conversation from long ago" },
        { id: "e2", ts: ts(2), from: "dev@linux-box", kind: "decision", ref: "D-0701", text: "Merge it?", options: ["A: Merge", "B: Wait"] },
      ] } },
    };
    const app = await open("./App.tsx", { storage: STORAGE, network: net, width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:Main results are in the main chat");
    expect(app.shows("text:Said only inside the task")).toBe(false);
    expect(app.shows("text:Reply inside the task")).toBe(false);
    await app.press("id:task-chip-T-0005 >> nth=0");
    await app.waitFor("text:A conversation from long ago");
    expect(app.shows("text:Said only inside the task")).toBe(true);
    expect(app.shows("text:Reply inside the task")).toBe(true);
    await app.press("text:/A: Merge/");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0701 A", reply_to: "D-0701", thread: true });
  });

    test("a decision's PR references are links, host-lettered ids are chips, option buttons shorten PR links", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], [prDecision]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:/D-H0002/");
    expect(app.shows("id:gh-chip-nsh-747")).toBe(false);
    expect(app.shows("text:/A: squash merge nsh#747 — ships in the release/")).toBe(true);
    expect(app.shows("text:/github\\.com\\/acme\\/nsh/")).toBe(false);
    await app.press("text:nsh #747");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/nsh/issues/747"]);
    // repositories no link names stay text
    expect(app.shows("text:/other#3/")).toBe(true);
    // the recommendation marks its option instead of a line of its own
    expect(app.shows("text:/Recommendation:\\s*\\*?A/")).toBe(false);
    expect(app.shows("text:Recommended")).toBe(true);
  });

  test("a bare #746 links to the repository its thread names", async () => {
    const thread = [
      prDecision,
      { id: "e10", ts: ts(10), from: "owner", kind: "owner", ref: "T-0129", text: "Review NSH#746, 754 770" },
      { id: "e11", ts: ts(11), from: "lead@linux-box", kind: "notice", ref: "T-0129", text: "All reviewed. Safe to merge: #746 (rerun CI), #770 (wait for `#763` to land first)." },
    ];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], thread), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("text:#770");
    await app.press("text:#770");
    await app.press("text:NSH#746");
    expect(app.openedUrls()).toEqual(["https://github.com/acme/nsh/issues/770", "https://github.com/acme/nsh/issues/746"]);
  });

  test("an answer quotes the card it replies to; pressing the quote goes back to the card", async () => {
    const reply = { id: "e9", ts: ts(9), from: "owner", kind: "owner", ref: "D-0001", text: "B, but run the tests first" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([], [reply]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:reply-to-D-0001");
    expect(app.shows("text:Upgrade the dependencies? Recommendation: B >> nth=1")).toBe(true);
    await app.press("id:reply-to-D-0001");
  });

  test("answers a decision with one tap", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("id:opt-D-0001-B");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
    // the sidebar drops it at once, before the hub's status catches up
    expect(app.shows("text:Upgrade the dependencies?")).toBe(true);
    await app.waitUntil(() => !app.shows("text:Upgrade the dependencies?"));
  });

  test("replies to an agent's message: the reply names its task and quotes it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const kai = { id: "e9", ts: ts(9), from: "Kai@lb", kind: "notice", ref: "T-0125", text: "nsh #812 mainly fixes text layout\nDetails are in the PR" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [kai]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:reply-e9");
    expect(app.shows("id:reply-e1")).toBe(false); // a message with no task can't be replied to
    await app.hover("text:/mainly fixes text layout/");
    await app.press("id:reply-e9");
    await app.waitFor("id:reply-chip");
    expect(app.shows("text:Replying to Kai: nsh #812 mainly fixes text layout")).toBe(true);
    await app.type("id:composer", "Why are the images blurry for me?");
    await app.press("id:send");
    await app.waitUntil(() => posts.length === 1, { timeout: 10_000 });
    expect(posts[0]).toEqual({ text: "Why are the images blurry for me?", reply_to: "T-0125" });
    expect(app.shows("id:reply-chip")).toBe(false);
    await app.waitFor("id:reply-to-T-0125");
    expect(app.shows("text:/Kai: nsh #812 mainly fixes text layout/")).toBe(true);
  });

  test("a question can be ignored from its card or from the sidebar", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [prDecision]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:ignore-D-H0003");
    await app.press("id:ignore-D-H0003");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-H0003 Ignore" });
    await app.waitFor("text:/^Ignore$/");
    await app.rightClick("text:Upgrade the dependencies? >> nth=0");
    await app.press("id:side-ignore-D-0001");
    await app.waitUntil(() => posts.length === 2);
    expect(posts[1]).toEqual({ text: "D-0001 Ignore" });
    await app.waitUntil(() => !app.shows("id:ignore-D-0001"));
  });

  test("Other instructions replies to the item from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:opt-D-0001-B");
    await app.press("id:other-D-0001");
    await app.waitFor("Replying to D-0001");
    await app.type("id:composer", "Wait a week first");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Wait a week first", reply_to: "D-0001" });
    expect(app.value("id:composer")).toBe("");
  });

  test("a message's quick actions copy its text and reply to its task", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const done = { id: "e8", ts: ts(8), from: "lead@mac", kind: "notice", ref: "T-0009", text: "T-0009 is done, PR opened" };
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts, [done]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("id:copy-e8");
    await app.hover("text:/is done, PR opened/");
    await app.press("id:copy-e8");
    await app.waitUntil(() => app.clipboard() === "T-0009 is done, PR opened");
    await app.waitFor("label:Copied");
    // an open question answers through its card, so it has no reply action
    expect(app.shows("id:reply-e2")).toBe(false);
    await app.press("id:reply-e8");
    await app.waitFor("Replying to lead: T-0009 is done, PR opened");
    await app.type("id:composer", "Add a screenshot too");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Add a screenshot too", reply_to: "T-0009" });
  });

  test("a machine in the sidebar opens its page, and its tasks open theirs", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("Main chat");
    await app.press("label:Load 42% · Disk 120GB · 1 running");
    await app.waitFor("Machine linux-box");
    await app.waitFor("Running");
    await app.waitFor("60% used");
    await app.waitFor("Fix login page");
    await app.press("label:T-0005 Fix login page");
    await app.waitFor("Task T-0005");
  });

  test("machine run settings pause new work and save a per-machine limit", async () => {
    const changes: Record<string, unknown>[] = [];
    const value = { host: "linux-box", enabled: true, max_parallel: 3, caps: ["docker"] };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/machines/linux-box`]: { body: value },
      [`PUT ${URL}/api/machines/linux-box`]: (r: { body?: string | null }) => { changes.push(JSON.parse(r.body!)); return { body: { ...value, ...changes.at(-1) } }; },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running");
    await app.waitFor("id:machine-enabled");
    await app.press("id:machine-enabled");
    await app.press("id:parallel-inc");
    await app.clear("id:machine-caps");
    await app.type("id:machine-caps", "docker, gpu");
    await app.press("id:machine-settings-save");
    await app.waitFor("text:/Saved. This machine will apply/");
    expect(changes).toEqual([{ enabled: false, max_parallel: 4, caps: ["docker", "gpu"] }]);
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: machine resource settings save only overrides and reset to fleet defaults`, async () => {
      const defaults = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field.path, field.default]));
      defaults["resources.mem_min_pct"] = 20; defaults["resources.work_dirs"] = ["/srv/work"];
      let values = { ...defaults }, overrides: string[] = [];
      const puts: any[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/machines/linux-box`]: { body: { host: "linux-box", enabled: true, max_parallel: 3, caps: [] } },
        [`GET ${URL}/api/machines/linux-box/configuration`]: () => ({ body: { values, overrides } }),
        [`PUT ${URL}/api/machines/linux-box/configuration`]: (r: { body?: string | null }) => {
          const body = JSON.parse(r.body!); puts.push(body);
          for (const [key, value] of Object.entries(body.values ?? {})) { values[key] = value as any; if (!overrides.includes(key)) overrides.push(key); }
          for (const key of body.reset ?? []) { values[key] = defaults[key]; overrides = overrides.filter((path) => path !== key); }
          return { body: { values, overrides } };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-resources");
      await app.waitFor("id:configuration-resources-mem_min_pct");
      expect(app.value("id:configuration-resources-mem_min_pct")).toBe("20");
      expect(app.shows("id:configuration-clis-timeout_minutes")).toBe(false);
      await app.clear("id:configuration-resources-mem_min_pct"); await app.type("id:configuration-resources-mem_min_pct", "30");
      await app.clear("id:configuration-resources-work_dirs"); await app.type("id:configuration-resources-work_dirs", "~/projects");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(puts[0]).toEqual({ values: { "resources.mem_min_pct": 30, "resources.work_dirs": ["~/projects"] } });
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved");
      expect(app.value("id:configuration-resources-mem_min_pct")).toBe("20");
      expect(app.value("id:configuration-resources-work_dirs")).toBe("/srv/work");
    });
  }

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: machine learning history locations save, clear and reset independently`, async () => {
      const defaults = Object.fromEntries(MACHINE_CONFIGURATION_FIELDS.map((field) => [field.path, field.default]));
      defaults["learn.codex_dir"] = "/srv/original";
      let values = { ...defaults }, overrides: string[] = [];
      const puts: any[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/machines/linux-box`]: { body: { host: "linux-box", enabled: true, max_parallel: null, caps: [] } },
        [`GET ${URL}/api/machines/linux-box/configuration`]: () => ({ body: { values, overrides, learning_supported: true } }),
        [`PUT ${URL}/api/machines/linux-box/configuration`]: (r: { body?: string | null }) => {
          const body = JSON.parse(r.body!); puts.push(body);
          for (const [key, value] of Object.entries(body.values ?? {})) { values[key] = value as any; if (!overrides.includes(key)) overrides.push(key); }
          for (const key of body.reset ?? []) { values[key] = defaults[key]; overrides = overrides.filter((path) => path !== key); }
          return { body: { values, overrides, learning_supported: true } };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-resources");
      await app.waitFor("id:configuration-group"); await app.press("id:configuration-group"); await app.press("id:configuration-group-onboarding");
      await app.waitFor("id:configuration-learn-codex_dir"); expect(app.value("id:configuration-learn-codex_dir")).toBe("/srv/original");
      expect(app.shows("id:configuration-clis-enabled-claude")).toBe(false);
      await app.clear("id:configuration-learn-codex_dir"); await app.type("id:configuration-learn-codex_dir", "/srv/sessions");
      await app.type("id:configuration-learn-hermes_db", "~/.hermes/state.db");
      await app.clear("id:configuration-learn-max_digest_chars"); await app.type("id:configuration-learn-max_digest_chars", "200000");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(puts[0]).toEqual({ values: { "learn.codex_dir": "/srv/sessions", "learn.hermes_db": "~/.hermes/state.db", "learn.max_digest_chars": 200000 } });
      await app.clear("id:configuration-learn-codex_dir"); await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(puts[1]).toEqual({ values: { "learn.codex_dir": null } });
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved");
      expect(app.value("id:configuration-learn-codex_dir")).toBe("/srv/original");
      expect(app.value("id:configuration-learn-max_digest_chars")).toBe("400000");
      expect(puts[2].reset.every((path: string) => path.startsWith("learn."))).toBe(true);
    });
  }

  test("older machines explain why learning paths require an update", async () => {
    const values = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field.path, field.default]));
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/machines/linux-box`]: { body: { host: "linux-box", enabled: true, caps: [] } },
      [`GET ${URL}/api/machines/linux-box/configuration`]: { body: { values, overrides: [], learning_supported: false } },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-resources");
    await app.waitFor("id:configuration-group"); await app.press("id:configuration-group"); await app.press("id:configuration-group-onboarding");
    await app.waitFor("id:machine-learning-unsupported"); expect(app.shows("id:configuration-learn-codex_dir")).toBe(false);
    expect(app.enabled("id:configuration-save")).toBe(false);
  });

  test("offline machines remain reachable for configuration without becoming placement candidates", async () => {
    const changes: unknown[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, offline_hosts: [{ host: "old-linux", caps: ["os:linux"], online: false, seen: ts(1) }] } },
      [`GET ${URL}/api/machines/old-linux`]: { body: { host: "old-linux", enabled: true, max_parallel: null, caps: [] } },
      [`PUT ${URL}/api/machines/old-linux`]: (r: { body?: string | null }) => { changes.push(JSON.parse(r.body!)); return { body: { host: "old-linux" } }; },
    } });
    await app.waitFor("Offline");
    await app.press("label:Load 0% · Disk ?GB · 0 running");
    await app.waitFor("Machine old-linux");
    await app.waitFor("Last reported resources");
    await app.waitFor("id:machine-enabled");
    await app.press("id:machine-enabled");
    await app.press("id:machine-settings-save");
    await app.waitFor("text:/Saved. This machine will apply/");
    expect(changes).toEqual([{ enabled: false, max_parallel: null, caps: [] }]);
  });

  test("all tasks: older ones load page by page, and any of them opens", async () => {
    const row = (i: number) => ({ id: `T-${1000 + i}`, title: `Old task ${i}`, agent: "lead", state: "done", updated: ts(1) });
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/tasks?*`]: (r: { url: string }) => {
          const u = new ParsedURL(r.url), offset = Number(u.searchParams.get("offset"));
          if (u.searchParams.get("q")) return { body: { tasks: [row(70)], total: 1 } };
          return { body: { tasks: Array.from({ length: offset ? 20 : 50 }, (_, i) => row(i + offset)), total: 70 } };
        },
        [`GET ${URL}/api/tasks/get?*`]: { body: { ...row(1), request: "A request from long ago", runs: [{ ts: ts(1), host: "h", cli: "claude", status: "done", summary: "Finished long ago" }] } },
      },
    });
    await app.waitFor("Main chat");
    await app.press("label:All tasks");
    await app.waitFor("Old task 0");
    await app.waitFor("Load more (20 left)");
    await app.press("id:task-more");
    await app.waitFor("Old task 69");
    await app.press("label:T-1001 Old task 1");
    await app.waitFor("A request from long ago");
    await app.waitFor("Finished long ago");
  });

  test("a dropped connection stays quiet until reconnecting keeps failing", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]) });
    await app.waitFor("id:composer");
    expect(app.shows("text:/Lost the connection/")).toBe(false);
    await app.waitUntil(() => app.shows("text:/Lost the connection/"), { timeout: 30_000 });
  });

  test("a task no online machine can run says which machine it waits for", async () => {
    const changes: Record<string, unknown>[] = [];
    const nohost = { requires: "os:windows,docker", target_host: "any", configured_cli: "claude", id: "T-0097", title: "Test dragging a file onto Windows", agent: "reviewer", state: "nohost", needs: "os:windows", created: ts(40), updated: ts(40) };
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, hosts: [{ ...status.hosts[0], caps: [...status.hosts[0].caps, "docker"] }], recent: [nohost, ...status.recent] } },
        [`POST ${URL}/api/tasks/configure`]: (r: { body?: string | null }) => { changes.push(JSON.parse(r.body!)); return { body: { ok: true, data: { ok: true } } }; } },
    });
    await app.waitFor("Needs a Windows machine");
    await app.press("label:T-0097 · Waiting for machine");
    await app.waitFor("id:task-nohost");
    expect(app.shows("id:cancel-task")).toBe(true);
    expect(app.shows("id:finish-task")).toBe(true);
    expect(app.shows("Choose machine")).toBe(true);
    expect(app.shows("Nothing pending; the team is moving on its own")).toBe(false);
    await app.waitFor("id:task-placement");
    expect(app.shows("text:/No connected machine is accepting tasks/")).toBe(true);
    await app.press("id:task-os");
    await app.press("id:task-os-linux");
    await app.waitFor("Matching machines: linux-box");
    await app.press("id:task-placement-save");
    await app.waitFor("text:/Settings saved/");
    expect(changes).toEqual([{ id: "T-0097", requires: "docker,os:linux", host: "any", cli: "claude", agent: "reviewer", priority: "normal", title: "Test dragging a file onto Windows", prefer: "", weight: "normal", project: "" }]);
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: task run settings retain the draft when synchronization is unconfirmed`, async () => {
      const task = { id: "T-0944", title: "Review", agent: "reviewer", state: "inbox", configured_cli: "claude", created: ts(40) };
      const writes: any[] = []; let fail = true;
      const message = "Saved on the main machine, but synchronization was not confirmed. Check the task before retrying.";
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [task] } },
        [`POST ${URL}/api/tasks/configure`]: (r: { body?: string | null }) => {
          writes.push(JSON.parse(r.body!));
          return fail ? { status: 503, body: { ok: false, error: message, id: task.id, saved_locally: true, data: { ok: false, error: message, saved_locally: true } } } : { body: { ok: true, data: { ok: true, id: task.id } } };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:T-0944 · Queued"); await app.press("id:task-edit-run"); await app.waitFor("id:task-title");
      await app.clear("id:task-title"); await app.type("id:task-title", "Run here");
      await app.press("id:task-placement-save"); await app.waitFor(message);
      expect(app.shows("text:/^Settings saved/")).toBe(false); expect(app.value("id:task-title")).toBe("Run here");
      fail = false; await app.press("id:task-placement-save"); await app.waitFor("text:/Settings saved/");
      expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(writes[1].id).toBe(task.id);
    });
  }

  test("task run settings do not offer a matching machine for a paused member", async () => {
    const task = { id: "T-0943", title: "Review", agent: "reviewer", state: "inbox", configured_cli: "claude", created: ts(40) };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [task] } },
      [`GET ${URL}/api/settings`]: { body: { effective: { enabled_clis: ["claude"], agents: [
        { id: "reviewer", title: "Reviewer", clis: [], paused: true },
        { id: "dev", title: "Developer", clis: [], paused: false },
      ] } } },
    } });
    await app.press("label:T-0943 · Queued");
    await app.press("id:task-edit-run");
    await app.waitFor("This member is paused. Choose another member or enable its AI tools in Settings.");
    expect(app.shows("Matching machines: linux-box")).toBe(false);
    await app.press("id:task-agent");
    await app.press("id:task-agent-dev");
    await app.waitFor("Matching machines: linux-box"); // explicit CLI overrides a nonempty preference whose tools were globally disabled
  });

  test("task advanced settings select a project's machine and keep preferences soft", async () => {
    const changes: Record<string, unknown>[] = [];
    const task = { id: "T-0930", title: "Review", agent: "reviewer", state: "inbox", requires: "", created: ts(40) };
    const mac = { ...status.hosts[0], host: "mac", os: "macos", caps: ["os:macos", "cli:claude", "cli:bun"] };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, hosts: [mac], recent: [task] } },
      [`GET ${URL}/api/settings`]: { body: { effective: { agents: [{ id: "reviewer", clis: ["claude"] }], projects: [{ id: "web", name: "Web app", host: "mac", path: "/work/web", requires: ["cli:bun"] }] } } },
      [`POST ${URL}/api/tasks/configure`]: (r: { body?: string | null }) => { changes.push(JSON.parse(r.body!)); return { body: { ok: true, data: { ok: true } } }; },
    } });
    await app.press("label:T-0930 · Queued");
    await app.press("id:task-edit-run");
    await app.waitFor("id:task-project");
    await app.press("id:task-project");
    await app.press("id:task-project-web");
    await app.waitFor("Matching machines: mac");
    await app.clear("id:task-title");
    await app.type("id:task-title", "Review the web app");
    await app.press("id:task-advanced");
    await app.type("id:task-prefer", "gpu"); // the Mac has no GPU label: this must remain a preference
    expect(app.shows("Matching machines: mac")).toBe(true);
    await app.press("id:task-weight");
    await app.press("id:task-weight-heavy");
    await app.press("id:task-placement-save");
    await app.waitFor("text:/Settings saved/");
    expect(changes).toEqual([{ id: "T-0930", requires: "", host: "mac", cli: "auto", agent: "reviewer", priority: "normal", title: "Review the web app", prefer: "gpu", weight: "heavy", project: "web" }]);
  });

  test("a routine run waiting on something slow stays in the list, and can be cancelled", async () => {
    const parked = { id: "T-0236", title: "macos-check · 2026-11-04 10:00", agent: "rust-maintainer", state: "parked", started: ts(40), updated: ts(40) };
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [parked, ...status.recent] } } },
    });
    await app.waitFor("Waiting");
    await app.press("label:T-0236 · Waiting on result");
    await app.waitFor("id:cancel-task");
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: rejected cancel and finish requests show their error and restore the controls`, async () => {
      const run_id = "b187d49c-46d7-4e9c-97d9-a3def411fba1";
      const writes: unknown[] = [], message = "Task is running on linux-box; it could not be stopped from the main machine.";
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, active: [{ ...status.active[0], state: "active", run_id }] } },
        [`POST ${URL}/api/tasks/cancel`]: (r: { body?: string | null }) => { writes.push(JSON.parse(r.body!)); return { status: 409, body: { error: message, id: "T-0007" } }; },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:T-0007 · dev @ linux-box"); await app.waitFor("id:cancel-task");
      app.onDialog((d) => d.title === "Cancel T-0007?" ? "Cancel task" : "Mark done");
      await app.press("id:cancel-task"); await app.waitFor(message); await app.waitFor("id:cancel-task");
      expect(app.shows("Working…")).toBe(false);
      await app.press("id:finish-task"); await app.waitUntil(() => writes.length === 2); await app.waitFor("id:finish-task");
      expect(writes).toEqual([{ id: "T-0007", host: "linux-box", run_id }, { id: "T-0007", done: true, host: "linux-box", run_id }]); expect(app.shows(message)).toBe(true); expect(app.shows("Working…")).toBe(false);
    });
  }

  test("machines show the code they run, and settings updates them all after a confirm", async () => {
    let updates = 0;
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 }, [`POST ${URL}/api/fleet/update`]: () => { updates++; return { body: { ok: true } }; } },
    });
    await app.press("label:Load 42% · Disk 120GB · 1 running");
    await app.waitFor("id:rev-linux-box");
    expect(app.shows("c1cc085")).toBe(true);
    await app.press("id:settings");
    await app.press("id:settings-tab-version");
    await app.waitFor("id:version-linux-box");
    app.onDialog((d) => (d.title === "Update all machines?" ? "Cancel" : null));
    await app.press("id:update-fleet");
    await app.waitUntil(() => app.dialogs().length === 1);
    expect(updates).toBe(0);
    app.onDialog((d) => (d.title === "Update all machines?" ? "Update" : null));
    await app.press("id:update-fleet");
    await app.waitUntil(() => updates === 1);
  });

  test("while an update runs, each machine shows its progress and the button waits", async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const mk = (state: string, detail?: string) => ({ at, ts: new Date().toISOString(), state, detail });
    const hosts = [
      { ...status.hosts[0], update: mk("waiting", "Waiting for 1 task to finish, then restarting") },
      { ...status.hosts[0], host: "mac-mini", update: mk("done", "abc1234") },
      { ...status.hosts[0], host: "old-box", update: undefined },
      { ...status.hosts[0], host: "win-box", update: mk("failed", "Local changes or failing tests; still running old code") },
    ];
    const app = await open("./App.tsx", {
      storage: STORAGE, width: 1200, height: 800, platform: "macos",
      network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 }, [`GET ${URL}/api/status`]: { body: { ...status, hosts, update: { at } } } },
    });
    await app.press("id:settings");
    await app.press("id:settings-tab-version");
    await app.waitFor("Waiting for 1 task to finish, then restarting…");
    expect(app.shows("Updated to abc1234")).toBe(true);
    expect(app.shows("Waiting for a response…")).toBe(true);
    expect(app.shows("Update failed: Local changes or failing tests; still running old code")).toBe(true);
    expect(app.shows("Updating · 1/4 done · 1 with problems")).toBe(true);
    expect(app.shows("Updating…")).toBe(true);
  });

  test("sends a task with the button, and the drawer opens on phones", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.press("label:Menu");
    await app.waitFor("Needs your decision");
    await app.press("label:Close menu");
    await app.waitUntil(() => !app.shows("Needs your decision"));
    await app.type("id:composer", "Screenshot check\non both platforms");
    await app.press("id:send");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Screenshot check\non both platforms" });
  });
});

describe("task run controls", () => {
  const runId = "b187d49c-46d7-4e9c-97d9-a3def411fba1", newRunId = "b187d49c-46d7-4e9c-97d9-a3def411fba2";
  const ticket = "b187d49c-46d7-4e9c-97d9-a3def411fba3";
  function fixture(active = true) {
    const task: any = { id: "T-0901", title: "Control task", agent: "dev", host: "worker", run_id: active ? runId : undefined, state: active ? "active" : "inbox", created: ts(40) };
    const writes: any[] = [], keys: string[] = [];
    const collect = (r: { body?: string | null; headers: Record<string, string> }) => { const body = JSON.parse(r.body!); writes.push(body); keys.push(Object.entries(r.headers).find(([key]) => key.toLowerCase() === "idempotency-key")?.[1] ?? ""); return body; };
    const snapshot = () => ({ ...status, active: task.state === "active" ? [task] : [], recent: task.state === "active" ? [] : [task] });
    const network = {
      ...hub([]), [`GET ${URL}/api/status`]: () => ({ body: snapshot() }),
      [`GET ${URL}/api/tasks/get?id=T-0901`]: () => ({ body: { ...task, events: [], runs: [], request: "Fixture task" } }),
      [`POST ${URL}/api/tasks/cancel`]: (r: { body?: string | null; headers: Record<string, string> }) => { const body = collect(r); task.state = body.done ? "done" : "cancelled"; return { body: { ok: true, id: task.id, ...(body.run_id ? { run_id: body.run_id } : {}), result: body.done ? "done" : "cancelled" } }; },
    };
    return { task, writes, keys, collect, snapshot, network };
  }
  async function page(f: ReturnType<typeof fixture>, platform: "macos" | "ios" = "macos", extra: Record<string, unknown> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
    await app.press(f.task.state === "active" ? "label:T-0901 · dev @ worker" : "label:T-0901 · Queued"); await app.waitFor("Control task");
    app.onDialog((d) => d.title?.startsWith("Cancel") ? "Cancel task" : "Mark done");
    return app;
  }
  for (const platform of ["macos", "ios"] as const) for (const done of [false, true]) {
    test(`${platform}: confirmed ${done ? "Done" : "Cancel"} targets the displayed worker run`, async () => {
      const f = fixture(), app = await page(f, platform);
      await app.press(done ? "id:finish-task" : "id:cancel-task"); await app.waitFor(done ? "Marked done." : "Cancellation confirmed.");
      await app.waitUntil(() => !app.shows("id:cancel-task"));
      expect(f.writes).toEqual([{ id: "T-0901", ...(done ? { done: true } : {}), host: "worker", run_id: runId }]);
      expect(f.keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/); expect(app.shows("Working…")).toBe(false);
    });
  }
  test("legacy active tasks cannot be stopped without a known run identity", async () => {
    const f = fixture(); delete f.task.run_id; const app = await page(f);
    await app.press("id:cancel-task"); await app.waitFor("Refresh this task after updating its machine to use run-specific controls.");
    expect(f.writes).toHaveLength(0); expect(app.dialogs()).toHaveLength(0);
  });
  test("a missing snapshot identity is recovered from the exact task before confirmation", async () => {
    const f = fixture(), app = await page(f, "macos", { [`GET ${URL}/api/status`]: () => ({ body: { ...f.snapshot(), active: [{ ...f.task, run_id: undefined }] } }) });
    await app.press("id:cancel-task"); await app.waitFor("Cancellation confirmed.");
    expect(f.writes[0].run_id).toBe(runId);
  });
  test("a foreign task detail cannot supply run identity or cleanup to this task", async () => {
    const f = fixture(); delete f.task.run_id;
    const app = await page(f, "macos", { [`GET ${URL}/api/tasks/get?id=T-0901`]: { body: { ...f.task, id: "T-9999", host: "other", run_id: newRunId,
      stops: { operation_id: ticket, requested_at: ts(59), done: false, pending: [{ id: "T-9998", host: "other", run_id: newRunId, done: false }], unresolved: [] } } } });
    expect(app.shows("id:stop-progress")).toBe(false); await app.press("id:cancel-task"); await app.waitFor("Refresh this task after updating its machine to use run-specific controls.");
    expect(f.writes).toHaveLength(0); expect(app.dialogs()).toHaveLength(0);
  });
  test("an invalid success keeps the original confirmation ticket", async () => {
    const f = fixture(); let polls = 0;
    const app = await page(f, "macos", {
      [`POST ${URL}/api/tasks/cancel`]: (r: any) => { f.collect(r); return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; if (polls > 1) f.task.state = "cancelled"; return { body: { ok: true, id: f.task.id, run_id: polls === 1 ? newRunId : runId, result: "cancelled" } }; },
    });
    await app.press("id:cancel-task"); await app.waitFor("Could not confirm this task change. Check the same request before trying another run.");
    expect(app.shows("id:task-action-notice")).toBe(false); await app.press("id:task-control-check"); await app.waitFor("Cancellation confirmed.");
    expect(f.writes).toHaveLength(1); expect(polls).toBe(2);
  });
  test("a queued request with a lost receipt reuses its key and does not target the replacement run", async () => {
    const f = fixture(false), receipts = new Map<string, unknown>();
    const app = await page(f, "macos", { [`POST ${URL}/api/tasks/cancel`]: (r: any) => {
      const body = f.collect(r), key = f.keys.at(-1)!;
      if (receipts.has(key)) return { body: receipts.get(key) };
      const result = { ok: true, id: f.task.id, ...(body.run_id ? { run_id: body.run_id } : {}), result: "cancelled" }; receipts.set(key, result);
      if (f.writes.length === 1) { f.task.state = "active"; f.task.run_id = newRunId; return { body: {} }; }
      f.task.state = "cancelled"; return { body: result };
    } });
    await app.press("id:cancel-task"); await app.waitFor("id:task-control-check"); await app.press("id:task-control-check");
    await app.waitFor("Earlier request confirmed. This task has a newer run; review it before taking another action.");
    expect(f.writes).toEqual([{ id: "T-0901", queued: true }, { id: "T-0901", queued: true }]); expect(f.keys[1]).toBe(f.keys[0]);
    await app.press("id:cancel-task"); await app.waitFor("Cancellation confirmed.");
    expect(f.writes[2]).toEqual({ id: "T-0901", host: "worker", run_id: newRunId }); expect(f.keys[2]).not.toBe(f.keys[0]);
  });
  test("a queued task that starts during confirmation requires a fresh exact-run action", async () => {
    const f = fixture(false); let raced = false;
    const app = await page(f, "macos", { [`POST ${URL}/api/tasks/cancel`]: (r: any) => {
      if (!raced) { raced = true; f.collect(r); f.task.state = "active"; f.task.run_id = newRunId; return { status: 409, body: { error: "This task is now running. Refresh and confirm its run." } }; }
      return f.network[`POST ${URL}/api/tasks/cancel`](r);
    } });
    await app.press("id:cancel-task"); await app.waitFor("This task is now running. Refresh and confirm its run."); await app.waitFor("id:cancel-task");
    await app.press("id:cancel-task"); await app.waitFor("Cancellation confirmed.");
    expect(f.writes[0]).toEqual({ id: "T-0901", queued: true }); expect(f.writes[1]).toEqual({ id: "T-0901", host: "worker", run_id: newRunId });
  });
  test("fresh terminal detail replaces a stale active snapshot only for the same run", async () => {
    for (const replacement of [false, true]) {
      const f = fixture(), stale = { ...f.task };
      const app = await page(f, "macos", { [`GET ${URL}/api/status`]: () => ({ body: { ...status, active: [{ ...stale, ...(replacement && f.writes.length ? { run_id: newRunId } : {}) }], recent: [] } }) });
      await app.press("id:cancel-task"); await app.waitFor("id:task-action-notice");
      if (replacement) {
        await app.waitFor("id:cancel-task"); await app.waitFor("Earlier request confirmed. This task has a newer run; review it before taking another action.");
      } else {
        await app.waitUntil(() => !app.shows("id:cancel-task")); expect(app.shows("Cancelled")).toBe(true);
      }
    }
  });

  const batch = () => ({ operation_id: ticket, requested_at: ts(59), done: false,
    pending: [{ id: "T-0902", host: "worker", run_id: newRunId, done: false, error: "Worker is offline" }], unresolved: [] });
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: child cleanup keeps its retry after the last stop has an unconfirmed sync`, async () => {
      const f = fixture(), retries: unknown[] = []; let attempt = 0;
      const app = await page(f, platform, {
        [`POST ${URL}/api/tasks/cancel`]: (r: any) => {
          f.collect(r); f.task.state = "cancelled"; f.task.stops = batch();
          return { status: 503, body: { saved_locally: true, stops: f.task.stops, error: "One child stop is unconfirmed" } };
        },
        [`POST ${URL}/api/tasks/stops/retry`]: (r: any) => {
          retries.push(JSON.parse(r.body)); delete f.task.stops;
          const cleanup = { operation_id: ticket, remaining: 0, pending: [], unresolved: [] };
          return ++attempt === 1 ? { status: 503, body: { saved_locally: true, task: f.task, cleanup, error: "Cleanup sync is unconfirmed" } }
            : { body: { ok: true, id: f.task.id, task: f.task, cleanup } };
        },
      });
      await app.type("id:task-composer", "Keep this draft");
      await app.press("id:cancel-task"); await app.waitFor("id:stop-target-T-0902");
      await app.press("id:stop-retry"); await app.waitFor("Confirm cleanup synchronization");
      await app.press("id:stop-refresh"); expect(app.shows("id:stop-retry")).toBe(true);
      expect(app.shows("Cleanup sync is unconfirmed")).toBe(true);
      await app.press("id:stop-retry"); await app.waitUntil(() => !app.shows("id:stop-progress"));
      expect(retries).toEqual([{ id: f.task.id, operation_id: ticket }, { id: f.task.id, operation_id: ticket }]);
      expect(f.writes).toHaveLength(1); expect(app.shows("id:task-action-error")).toBe(false);
      expect(app.value("id:task-composer")).toBe("Keep this draft");
    });

    test(`${platform}: cleanup started elsewhere appears on an already-open task and links to its owner`, async () => {
      const f = fixture(), app = await page(f, platform, {
        [`GET ${URL}/api/tasks/get?id=T-0902`]: () => ({ body: { id: "T-0902", title: "Cleanup child", agent: "dev", state: "active", host: "worker", run_id: newRunId, stop_owner: { kind: "task", id: f.task.id }, events: [] } }),
      });
      expect(app.shows("id:stop-progress")).toBe(false);
      f.task.state = "cancelled"; f.task.stops = batch();
      await app.waitFor("id:stop-target-T-0902", { timeout: 6500 });
      await app.press("id:stop-target-T-0902"); await app.waitFor("Cleanup child");
      await app.press("id:stop-open-owner"); await app.waitFor("Control task"); await app.waitFor("id:stop-target-T-0902");
    });
  }

  test("malformed cleanup success keeps the confirmation ticket and the exact operation", async () => {
    const f = fixture(); f.task.stops = batch(); let posts = 0, reads = 0;
    const app = await page(f, "macos", {
      [`POST ${URL}/api/tasks/stops/retry`]: () => { posts++; return { status: 202, body: { ticket: runId } }; },
      [`GET ${URL}/api/ui-requests/${runId}`]: () => {
        const operation_id = ++reads === 1 ? newRunId : ticket;
        if (reads > 1) { delete f.task.stops; f.task.state = "cancelled"; }
        return { body: { ok: true, id: f.task.id, task: f.task, cleanup: { operation_id, remaining: 0, pending: [], unresolved: [] } } };
      },
    });
    await app.waitFor("id:stop-retry"); await app.press("id:stop-retry");
    await app.waitFor("Couldn't confirm cleanup. Retry to check the same cleanup request.");
    expect(app.shows("id:stop-progress")).toBe(true);
    await app.press("id:stop-retry"); await app.waitUntil(() => !app.shows("id:stop-progress"));
    expect(posts).toBe(1); expect(reads).toBe(2);
    expect(app.shows("id:cancel-task")).toBe(false);
  });

  test("invalid cleanup is visible and only offers refresh", async () => {
    const f = fixture(); f.task.stops_error = "Saved cleanup information is invalid.";
    const app = await page(f);
    await app.waitFor("id:stop-data-error"); expect(app.shows("id:stop-retry")).toBe(false);
    expect(app.shows("id:stop-refresh")).toBe(true);
    expect(app.shows("id:cancel-task")).toBe(false); expect(app.shows("id:finish-task")).toBe(false);
  });

  function reviewFixture(unresolved = false) {
    const f = fixture(), currentRun = "b187d49c-46d7-4e9c-97d9-a3def411fba4";
    f.task.stops = batch();
    if (unresolved) { f.task.stops.pending = []; f.task.stops.unresolved = [{ id: "T-0902", error: "Parent run proof is missing" }]; }
    const owner = { kind: "task", id: f.task.id }, reviews: any[] = [], writes: any[] = [], retry: any[] = [];
    const preview: any = { owner, operation_id: ticket, target_id: "T-0902", preview_digest: "a".repeat(64),
      target: unresolved ? { kind: "unresolved", id: "T-0902" } : { kind: "pending", id: "T-0902", host: "worker", run_id: newRunId, done: false },
      current: { state: "active", records: [{ state: "active", title: "Reviewed child", host: "worker", run_id: currentRun }] }, can_include: true };
    const reply = (body: any) => {
      const audit = { ...body, review_id: body.request_id, at: ts(59), original: preview.target, reviewed: preview.current, request_hash: "c".repeat(64) };
      const saved = reviews.find((r) => r.request_id === body.request_id) ?? audit;
      if (!reviews.includes(saved)) reviews.push(saved);
      f.task.state = "cancelled"; f.task.stop_reviews = [...reviews];
      const pending = body.action === "include" ? [{ id: "T-0902", host: "worker", run_id: preview.current.records[0]?.run_id, done: false }] : [];
      if (pending.length) f.task.stops = { ...batch(), pending, reviews: [...reviews] }; else delete f.task.stops;
      return { ok: true, id: f.task.id, owner, operation_id: ticket, target_id: "T-0902", action: body.action, request_id: body.request_id, review_id: body.request_id, review: saved, task: f.task,
        cleanup: { operation_id: ticket, remaining: pending.length, pending, unresolved: [] } };
    };
    const network = {
      [`GET ${URL}/api/tasks/get?id=T-0901`]: () => ({ body: { ...f.task, state: "cancelled", events: [] } }),
      [`POST ${URL}/api/stops/review`]: (r: any) => { writes.push({ preview: JSON.parse(r.body) }); return { body: preview }; },
      [`POST ${URL}/api/stops/resolve`]: (r: any) => { const body = JSON.parse(r.body); writes.push(body); return { body: reply(body) }; },
      [`POST ${URL}/api/tasks/stops/retry`]: (r: any) => { retry.push(JSON.parse(r.body)); delete f.task.stops; return { body: { ok: true, id: f.task.id, task: f.task, cleanup: { operation_id: ticket, remaining: 0, pending: [], unresolved: [] } } }; },
    };
    return { f, owner, preview, reviews, writes, retry, reply, network, currentRun };
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: an explicit review includes only the displayed run and then requests its cleanup`, async () => {
      const v = reviewFixture(), app = await page(v.f, platform, v.network);
      await app.press("id:stop-review-T-0902"); await app.waitFor("id:stop-review-run");
      expect(app.shows(`Run ${v.currentRun}`)).toBe(true); expect(app.enabled("id:stop-review-include")).toBe(false);
      await app.type("id:stop-review-reason", "This is the child I want stopped");
      app.onDialog(() => "Include reviewed task"); await app.press("id:stop-review-include");
      await app.waitUntil(() => v.retry.length === 1); await app.waitFor("id:stop-reviewed-T-0902");
      await app.waitUntil(() => !app.shows("id:stop-progress"));
      expect(v.writes[0]).toEqual({ preview: { owner: v.owner, operation_id: ticket, target_id: "T-0902" } });
      expect(v.writes[1]).toMatchObject({ owner: v.owner, operation_id: ticket, target_id: "T-0902", preview_digest: v.preview.preview_digest, action: "include", reason: "This is the child I want stopped" });
      expect(v.writes[1].request_id).toMatch(/^[a-f0-9-]{36}$/); expect(v.writes[1].run_id).toBeUndefined();
      expect(v.retry).toEqual([{ id: v.f.task.id, operation_id: ticket }]); expect(v.f.writes).toHaveLength(0);
    });

    test(`${platform}: excluding an unresolved child requires a reason and keeps its non-stop history visible`, async () => {
      const v = reviewFixture(true), app = await page(v.f, platform, v.network);
      await app.press("id:stop-review-T-0902"); await app.waitFor("id:stop-review-reason");
      expect(app.enabled("id:stop-review-exclude")).toBe(false);
      await app.type("id:stop-review-reason", "Keep the separate build running");
      app.onDialog((d) => { expect(d.message).toContain("may keep running"); return "Exclude from cleanup"; });
      await app.press("id:stop-review-exclude"); await app.waitFor("Excluded T-0902 from cleanup. The task may continue running.");
      expect(app.shows("Keep the separate build running")).toBe(true); expect(v.retry).toHaveLength(0); expect(v.f.writes).toHaveLength(0);
      expect(v.writes[1].action).toBe("exclude"); expect(app.shows("id:stop-progress")).toBe(false);
      await app.wait(4200);
      expect(app.shows("id:stop-review-history")).toBe(true);
    });
  }

  test("a partially published cleanup review keeps its request and reason locked for exact confirmation", async () => {
    const v = reviewFixture(true), requests: any[] = []; let first = true;
    const stale = { ...v.f.task };
    const app = await page(v.f, "macos", { ...v.network, [`GET ${URL}/api/status`]: () => ({ body: { ...status, active: [stale], recent: [] } }),
      [`GET ${URL}/api/tasks/get?id=T-0901`]: () => ({ body: { ...v.f.task, events: [] } }), [`POST ${URL}/api/stops/resolve`]: (r: any) => {
      const body = JSON.parse(r.body); requests.push(body); const data = v.reply(body);
      if (first) { first = false; return { status: 503, body: { ...data, ok: false, saved_locally: true, error: "Review saved locally; publication is pending" } }; }
      return { body: data };
    } });
    await app.type("id:task-composer", "Unsent parent message");
    await app.press("id:stop-review-T-0902"); await app.type("id:stop-review-reason", "Leave this reviewed child running");
    app.onDialog(() => "Exclude from cleanup"); await app.press("id:stop-review-exclude"); await app.waitFor("id:stop-review-check");
    expect(app.enabled("id:stop-review-reason")).toBe(false); expect(app.value("id:stop-review-reason")).toBe("Leave this reviewed child running");
    await app.press("id:stop-review-close"); await app.waitFor("id:stop-review-resume");
    await app.back(); await app.waitFor("id:composer"); await app.press("label:T-0901 · dev @ worker");
    await app.waitFor("id:stop-review-resume"); await app.press("id:stop-review-resume"); await app.waitFor("id:stop-review-check");
    expect(app.value("id:stop-review-reason")).toBe("Leave this reviewed child running");
    await app.press("id:stop-review-check"); await app.waitUntil(() => !app.shows("id:stop-review-dialog"));
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(v.reviews).toHaveLength(1);
    expect(app.value("id:task-composer")).toBe("Unsent parent message"); expect(app.shows("id:stop-progress")).toBe(false);
  });

  test("a changed review requires a fresh preview while preserving the explanation", async () => {
    const v = reviewFixture(), requests: any[] = []; let first = true;
    const app = await page(v.f, "macos", { ...v.network, [`POST ${URL}/api/stops/resolve`]: (r: any) => {
      const body = JSON.parse(r.body); requests.push(body);
      if (first) { first = false; v.preview.preview_digest = "b".repeat(64); v.preview.current.records[0].run_id = runId; return { status: 409, body: { error: "The reviewed task changed. Refresh this review." } }; }
      return { body: v.reply(body) };
    } });
    await app.press("id:stop-review-T-0902"); await app.type("id:stop-review-reason", "Review the current child");
    app.onDialog(() => "Include reviewed task"); await app.press("id:stop-review-include"); await app.waitFor("The reviewed task changed. Refresh this review.");
    expect(app.value("id:stop-review-reason")).toBe("Review the current child"); expect(v.retry).toHaveLength(0);
    expect(app.enabled("id:stop-review-include")).toBe(false); expect(app.enabled("id:stop-review-exclude")).toBe(false);
    await app.press("id:stop-review-refresh"); await app.waitFor(`Run ${runId}`); await app.press("id:stop-review-include");
    await app.waitUntil(() => v.retry.length === 1);
    expect(requests[0].preview_digest).toBe("a".repeat(64)); expect(requests[1].preview_digest).toBe("b".repeat(64)); expect(requests[1].request_id).not.toBe(requests[0].request_id);
  });

  test("malformed review success retains its ticket instead of discarding the decision", async () => {
    const v = reviewFixture(true); let posts = 0, reads = 0, accepted: any;
    const app = await page(v.f, "macos", { ...v.network,
      [`POST ${URL}/api/stops/resolve`]: (r: any) => { posts++; accepted = JSON.parse(r.body); return { status: 202, body: { ticket: runId } }; },
      [`GET ${URL}/api/ui-requests/${runId}`]: () => {
        const data = v.reply(accepted); reads++;
        if (reads === 1) return { body: { ...data, review_id: newRunId } };
        if (reads === 2) return { body: { ...data, review: { ...data.review, original: undefined } } };
        if (reads === 3) return { body: { ...data, cleanup: { ...data.cleanup, operation_id: newRunId } } };
        if (reads === 4) return { body: { ...data, task: { ...v.f.task, id: "T-0999" } } };
        return { body: data };
      },
    });
    await app.press("id:stop-review-T-0902"); await app.type("id:stop-review-reason", "Leave this separate task alone");
    app.onDialog(() => "Exclude from cleanup"); await app.press("id:stop-review-exclude");
    for (let index = 0; index < 4; index++) {
      await app.waitFor("Couldn't confirm this cleanup review. Retry the same decision before making another choice.");
      await app.press("id:stop-review-check");
    }
    await app.waitUntil(() => !app.shows("id:stop-review-dialog"));
    expect(posts).toBe(1); expect(reads).toBe(5); expect(v.reviews).toHaveLength(1);
  });

  test("an unverifiable preview cannot authorize either review action", async () => {
    const v = reviewFixture(), app = await page(v.f, "macos", { ...v.network, [`POST ${URL}/api/stops/review`]: { body: { ...v.preview, current: { state: "active", records: [{ state: "active", title: "Missing identity" }] } } } });
    await app.press("id:stop-review-T-0902"); await app.waitFor("Couldn't load this cleanup review. Refresh before making a decision.");
    expect(app.shows("id:stop-review-include")).toBe(false); expect(app.shows("id:stop-review-exclude")).toBe(false); expect(v.writes).toHaveLength(0);
  });

  test("a valid legacy review explains why inclusion is unavailable and still permits an explicit exclusion", async () => {
    const v = reviewFixture(true);
    v.preview.current = { state: "active", records: [{ state: "active", title: "Legacy child" }] }; v.preview.can_include = false; v.preview.include_reason = "Update this machine before including an exact run.";
    const app = await page(v.f, "macos", v.network);
    await app.press("id:stop-review-T-0902"); await app.waitFor(v.preview.include_reason);
    await app.type("id:stop-review-reason", "I will manage this legacy task separately");
    expect(app.enabled("id:stop-review-include")).toBe(false); expect(app.enabled("id:stop-review-exclude")).toBe(true);
    app.onDialog(() => "Exclude from cleanup"); await app.press("id:stop-review-exclude"); await app.waitFor("id:stop-reviewed-T-0902");
    expect(v.retry).toHaveLength(0);
  });

  test("an included review cannot retry a newer cleanup operation returned by its owner view", async () => {
    const v = reviewFixture(), changedOperation = "b187d49c-46d7-4e9c-97d9-a3def411fba5";
    v.preview.related = [{ id: "T-0903", current: { state: "queued", records: [{ state: "inbox", title: "Related queued work" }] } }];
    const app = await page(v.f, "macos", { ...v.network, [`POST ${URL}/api/stops/resolve`]: (r: any) => {
      const body = JSON.parse(r.body), data = v.reply(body);
      v.f.task.stops = { ...v.f.task.stops, operation_id: changedOperation };
      return { body: { ...data, task: v.f.task } };
    } });
    await app.press("id:stop-review-T-0902"); await app.waitFor("id:stop-review-related-T-0903");
    expect(app.shows("Related queued work")).toBe(true);
    await app.type("id:stop-review-reason", "Include the displayed task family"); app.onDialog(() => "Include reviewed task");
    await app.press("id:stop-review-include"); await app.waitFor("The cleanup operation changed. Review its latest progress before retrying.");
    expect(v.retry).toHaveLength(0); expect(app.shows("id:stop-progress")).toBe(true);
  });
});

describe("images", () => {
  const desk = { storage: STORAGE, width: 1200, height: 800, platform: "linux" as const };
  const here = (f: string) => decodeURIComponent(new (globalThis as any).URL(`./${f}`, import.meta.url).pathname);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  function withUploads(posts: { text: string; reply_to?: string; attachments?: string[] }[], uploads: string[]) {
    return {
      ...hub(posts),
      [`POST ${URL}/api/uploads`]: () => {
        uploads.push(`/media/shot-${uploads.length + 1}.png`);
        return { body: { url: uploads[uploads.length - 1] } };
      },
    };
  }

  test("retrying an image message reuses its request key and uploaded image", async () => {
    const uploads: string[] = [], messages: { body: any; key?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: {
      ...withUploads([], uploads),
      [`POST ${URL}/api/messages`]: (r: { headers: Record<string, string>; body?: string | null }) => {
        const key = Object.entries(r.headers).find(([name]) => name.toLowerCase() === "idempotency-key")?.[1];
        const body = JSON.parse(r.body!); messages.push({ body, key });
        return messages.length === 1 ? { status: 503, body: { error: "Connection interrupted while confirming this message" } } : { body: { id: "message-fixture", ts: ts(50), from: "owner", kind: "owner", text: body.text, attachments: body.attachments } };
      },
    } });
    await app.waitFor("id:composer"); app.onPick(() => [{ name: "a.png", type: "image/png", data: PNG }]);
    await app.press("id:attach"); await app.waitFor("id:attachment"); await app.type("id:composer", "Review this screenshot"); await app.press("id:send");
    await app.waitFor("Connection interrupted while confirming this message", { timeout: 8000 });
    await app.press("label:Retry sending"); await app.waitUntil(() => messages.length === 2);
    expect(uploads).toHaveLength(1); expect(messages[1]).toEqual(messages[0]);
    expect(messages[0]!.key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/); expect(messages[0]!.body.attachments).toEqual(["/media/shot-1.png"]);
    await app.waitUntil(() => !app.shows("label:Retry sending"));
  });

  test("a picked image shows as a thumbnail, can be removed, and is sent with the text", async () => {
    const posts: { text: string; attachments?: string[] }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    app.onPick(() => [{ name: "a.png", type: "image/png", data: PNG }, { name: "b.png", type: "image/png", data: PNG }]);
    await app.press("id:attach");
    await app.waitUntil(() => app.count("id:attachment") === 2);
    await app.press("label:Remove b.png");
    expect(app.count("id:attachment")).toBe(1);
    await app.type("id:composer", "Look at this error");
    await app.press("id:send");
    expect(app.count("id:attachment")).toBe(0);
    expect(app.shows("id:owner-images")).toBe(true); // the held bubble shows the image
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(uploads.length).toBe(1);
    expect(posts[0]).toEqual({ text: "Look at this error", attachments: ["/media/shot-1.png"] });
  });

  test("undo brings the image back to the composer; nothing is uploaded", async () => {
    const posts: { text: string }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    app.onPick(() => [{ name: "a.png", type: "image/png", data: PNG }]);
    await app.press("id:attach");
    await app.waitFor("id:attachment");
    await app.press("id:send"); // an image alone can be sent
    await app.keyboard.press("mod+z");
    expect(app.count("id:attachment")).toBe(1);
    await app.wait(6000);
    expect(uploads.length).toBe(0);
    expect(posts.length).toBe(0);
  });

  test("a pasted screenshot attaches; a non-image is refused", async () => {
    const posts: { text: string; attachments?: string[] }[] = [];
    const uploads: string[] = [];
    const app = await open("./App.tsx", { ...desk, network: withUploads(posts, uploads) });
    await app.waitFor("id:composer");
    await app.paste("id:composer", { files: [here("icon.png")] });
    await app.waitFor("id:attachment");
    await app.paste("id:composer", { files: [here("hub.ts")] });
    await app.waitFor("id:attach-note");
    expect(app.shows("Only images can be sent")).toBe(true);
    expect(app.count("id:attachment")).toBe(1);
    await app.submit("id:composer");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(posts[0]).toEqual({ text: "", attachments: ["/media/shot-1.png"] });
  });

  test("an unreadable dropped image explains how to recover", async () => {
    const app = await open("./App.tsx", { ...desk, network: withUploads([], []) });
    await app.waitFor("id:composer"); await app.dropFiles("id:composer-area", ["file:///missing/noop-image.png"]);
    await app.waitFor("text:/Try Attach or paste the image/");
    expect(app.count("id:attachment")).toBe(0);
  });

  test("an image file dropped on the composer attaches", async () => {
    const app = await open("./App.tsx", { ...desk, network: withUploads([], []) });
    await app.waitFor("id:composer");
    await app.dropFiles("id:composer-area", [`file://${here("icon.png")}`]);
    await app.waitFor("id:attachment");
    expect(app.count("id:attachment")).toBe(1);
  });
});

describe("keyboard", () => {
  const desk = { storage: STORAGE, width: 1200, height: 800, platform: "macos" as const };

  test("a sent message looks sent right away; only a failure shows, and retry sends at once", async () => {
    let fail = true;
    const posts: { text: string }[] = [];
    const ok = hub(posts);
    const network = { ...ok, [`POST ${URL}/api/messages`]: (r: { body?: string | null }) =>
      fail ? { status: 500, body: {} } : (ok as any)[`POST ${URL}/api/messages`](r) };
    const app = await open("./App.tsx", { ...desk, network });
    await app.waitFor("id:composer");
    await app.type("id:composer", "Check the logs");
    await app.submit("id:composer");
    await app.waitFor("text:Check the logs");
    expect(app.shows("About to send")).toBe(false);
    expect(app.shows("Sending…")).toBe(false);
    await app.waitFor("text:Send failed", { timeout: 8000 });
    fail = false;
    await app.press("label:Retry sending");
    await app.waitUntil(() => posts.length === 1, { timeout: 1000 }); // no second undo window
    await app.waitUntil(() => !app.shows("Send failed"));
  });

  test("a just-sent message can be recalled by its button: the words return and nothing is posted", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "Sent by mistake");
    await app.submit("id:composer");
    await app.waitFor("text:Sent by mistake");
    expect(app.shows("About to send")).toBe(false);
    await app.press("id:recall-send");
    await app.waitUntil(() => app.value("id:composer") === "Sent by mistake");
    await app.wait(6000);
    expect(posts.length).toBe(0);
  });

  test("the recall button goes away once the message has left", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "Take a look");
    await app.submit("id:composer");
    await app.waitFor("id:recall-send");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    await app.waitUntil(() => !app.shows("id:recall-send"));
  });

  test("unsend preserves a newer draft instead of replacing it", async () => {
    const posts: { text: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer"); await app.type("id:composer", "First message"); await app.submit("id:composer");
    await app.type("id:composer", "New draft"); await app.press("id:recall-send");
    expect(app.value("id:composer")).toBe("First message\n\nNew draft"); expect(posts.length).toBe(0);
  });

  test("Enter sends from the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "Check the logs");
    await app.submit("id:composer");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 }); // sent after the 5 s undo window
    expect(posts[0]).toEqual({ text: "Check the logs" });
    expect(app.value("id:composer")).toBe("");
  });

  test("number keys answer the pending decision; r replies to it", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:opt-D-0001-B");
    // P-0002 is answered (e4), so D-0001 is the pending one.
    await app.keyboard.press("2");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("Alt+number answers while the cursor is in the composer", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { ...desk, network: hub(posts) });
    await app.waitFor("id:opt-D-0001-B");
    await app.type("id:composer", "");
    await app.keyboard.press("alt+2");
    await app.waitUntil(() => posts.length === 1, { timeout: 8000 });
    expect(posts[0]).toEqual({ text: "D-0001 B" });
  });

  test("r replies, Escape cancels the reply, ? shows the shortcuts", async () => {
    const app = await open("./App.tsx", { ...desk, network: hub([]) });
    await app.waitFor("id:opt-D-0001-B");
    await app.keyboard.press("r");
    await app.waitFor("Replying to D-0001");
    await app.keyboard.press("escape");
    expect(app.shows("Replying to D-0001")).toBe(false);
    await app.keyboard.press("escape");
    await app.keyboard.press("shift+/");
    await app.waitFor("Keyboard shortcuts");
    await app.keyboard.press("escape");
    expect(app.shows("Keyboard shortcuts")).toBe(false);
  });

  test("mod+, opens team settings", async () => {
    const app = await open("./App.tsx", { ...desk, network: { ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 } } });
    await app.waitFor("id:composer");
    await app.keyboard.press("mod+,");
    await app.waitFor("Team settings");
    // Escape pops back to the channel, one page at a time.
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("Team settings"));
    expect(app.shows("Main chat")).toBe(true);
  });
});

describe("message write confirmation", () => {
  test("an unreadable success keeps the outgoing message and request key for confirmation", async () => {
    const keys: string[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: {
      ...hub([]), [`POST ${URL}/api/messages`]: (r: { headers: Record<string, string> }) => {
        keys.push(Object.entries(r.headers).find(([name]) => name.toLowerCase() === "idempotency-key")?.[1] ?? "");
        return { body: keys.length === 1 ? { ok: true } : { id: "confirmed", ts: ts(59), from: "owner", kind: "owner", text: "Confirm this request" } };
      },
    } });
    await app.waitFor("id:composer"); await app.type("id:composer", "Confirm this request"); await app.press("id:send");
    await app.waitFor("Couldn't confirm delivery. Retry to check the same request.", { timeout: 8000 });
    await app.press("label:Retry sending"); await app.waitUntil(() => keys.length === 2); await app.waitUntil(() => !app.shows("id:send-error"));
    expect(keys[0]).not.toBe(""); expect(keys[1]).toBe(keys[0]); expect(app.shows("Confirm this request")).toBe(true);
  });
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: a locally saved task remains inspectable after an unconfirmed send`, async () => {
      const task = { id: "T-0901", title: "Saved task", agent: "reviewer", state: "inbox", created: ts(40) };
      const keys: string[] = []; const message = "Task T-0901 was saved on the main machine, but synchronization was not confirmed. Check the task before starting another one.";
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, recent: [task] } },
        [`GET ${URL}/api/tasks/get?id=T-0901`]: { body: { ...task, request: "Review the saved task", events: [], runs: [], decisions: [] } },
        [`POST ${URL}/api/messages`]: (r: { headers: Record<string, string> }) => { keys.push(Object.entries(r.headers).find(([name]) => name.toLowerCase() === "idempotency-key")?.[1] ?? ""); return { status: 503, body: { error: message, id: task.id, saved_locally: true } }; },
      } });
      await app.waitFor("id:composer"); await app.type("id:composer", "Review the saved task"); await app.press("id:send");
      await app.waitFor(message, { timeout: 8000 }); await app.waitFor("Synchronization unconfirmed");
      await app.press("label:Check same request"); await app.waitUntil(() => keys.length === 2); await app.waitFor("id:send-inspect");
      expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,128}$/); expect(keys[1]).toBe(keys[0]);
      await app.press("id:send-inspect"); await app.waitFor("Saved task"); await app.waitFor("Edit run settings");
    });
    test(`${platform}: a locally saved plan opens its plan page`, async () => {
      const plan = { id: "PL-0901", goal: "Saved plan", status: "drafting", agent: "lead", steps: [], notes: [] };
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/plans`]: { body: { plans: [plan] } },
        [`GET ${URL}/api/plans/PL-0901`]: { body: { plan } },
        [`POST ${URL}/api/messages`]: { status: 503, body: { error: "Saved PL-0901 locally; synchronization unconfirmed.", id: plan.id, saved_locally: true } },
      } });
      await app.waitFor("id:composer"); await app.type("id:composer", "Plan the work"); await app.press("id:send");
      await app.waitFor("id:send-inspect", { timeout: 8000 }); await app.press("id:send-inspect");
      await app.waitFor("Saved plan"); await app.waitFor("id:plan-cancel");
    });
  }
});

describe("team settings", () => {
  test("changes an agent's models, a routine and max parallel", async () => {
    const puts: unknown[] = [];
    let view = {
      current: {},
      effective: {
        agents: [{ id: "reporter", clis: ["codex", "claude"], autonomy: "onboarding" }],
        autonomy: "onboarding",
        routines: [{ name: "triage-inbound", desc: "Scan the inbox", every: "30m", agent: "lead", enabled: true }],
        max_parallel: 4,
      },
      options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
    };
    const app = await open("./App.tsx", {
      storage: STORAGE,
      width: 1200,
      height: 800,
      platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/settings`]: () => ({ body: view }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
          const p = JSON.parse(r.body!);
          puts.push(p);
          if (p.clis) view = { ...view, effective: { ...view.effective, agents: [{ ...view.effective.agents[0], clis: p.clis.agents.reporter }] } };
          if (p.host) view = { ...view, effective: { ...view.effective, max_parallel: p.host.max_parallel } };
          return { body: view };
        },
      },
    });
    await app.press("id:settings");
    await app.press("id:settings-tab-members");
    await app.waitFor("id:cli-reporter");
    await app.press("id:cli-reporter");
    await app.press("id:cli-reporter-claude");
    await app.waitUntil(() => puts.length === 1);
    await app.press("id:autonomy-reporter");
    await app.press("id:autonomy-reporter-assisted");
    await app.press("id:settings-tab-routines");
    await app.waitFor("text:Scan the inbox");
    await app.waitFor("text:Every 30 minutes");
    await app.press("id:routine-triage-inbound");
    await app.press("id:every-triage-inbound");
    await app.press("id:every-triage-inbound-1h");
    await app.press("id:settings-tab-parallel");
    await app.press("id:parallel-inc");
    await app.waitUntil(() => puts.length === 5);
    expect(puts).toEqual([
      { clis: { agents: { reporter: ["claude"] } } },
      { autonomy: { agents: { reporter: "assisted" } } },
      { routines: { "triage-inbound": { enabled: false } } },
      { routines: { "triage-inbound": { every: "1h" } } },
      { host: { max_parallel: 5 } },
    ]);
    await app.waitFor("text:5");
    await app.press("label:Back to Main chat");
    await app.waitFor("id:composer");
  });

  test("picks how long images are kept", async () => {
    const puts: unknown[] = [];
    let view = { current: {} as Record<string, unknown>, effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } };
    const app = await open("./App.tsx", {
      storage: STORAGE,
      width: 1200,
      height: 800,
      platform: "macos",
      network: {
        ...hub([]),
        [`GET ${URL}/api/settings`]: () => ({ body: view }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
          const p = JSON.parse(r.body!);
          puts.push(p);
          view = { ...view, current: { ...view.current, ...p } };
          return { body: view };
        },
      },
    });
    await app.press("id:settings");
    await app.press("id:settings-tab-storage");
    await app.waitFor("id:media-days-90");
    await app.press("id:media-days-30");
    await app.waitUntil(() => puts.length === 1);
    expect(puts).toEqual([{ media_days: 30 }]);
    expect(app.shows("text:14 days")).toBe(true);
  });
});

describe("notifications", () => {
  type Info = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };
  const device = (over: Partial<Info> = {}): Info => ({
    supported: true, ios: false, standalone: false, permission: "default", subscribed: false, endpoint: null, device: "Android · Chrome", ...over,
  });
  /** The browser host.js wraps (Notification, PushManager, the service worker), played by the test. */
  function browser(info: Info, permission = "granted") {
    let state = { ...info };
    return {
      page: { origin: URL },
      pushState: () => state,
      pushEnable: () => {
        state = { ...state, permission, subscribed: permission === "granted", endpoint: "https://push.test/e1" };
        return { permission, subscription: permission === "granted" ? { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } } : null, device: state.device };
      },
      pushDisable: () => {
        state = { ...state, subscribed: false };
        return { endpoint: "https://push.test/e1" };
      },
      setSession: {},
      setBadge: {},
      clearNotifications: {},
      vibrate: {},
    };
  }
  function server(log: { subs: unknown[]; unsubs: unknown[]; tests: number; puts: unknown[] }) {
    return {
      ...hub([]),
      [`GET ${URL}/api/push/vapid`]: { body: { publicKey: "BPublicKey" } },
      [`POST ${URL}/api/push/subscribe`]: (r: { body?: string | null }) => (log.subs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/unsubscribe`]: (r: { body?: string | null }) => (log.unsubs.push(JSON.parse(r.body!)), { body: { ok: true } }),
      [`POST ${URL}/api/push/test`]: () => (log.tests++, { body: { ok: true } }),
      [`GET ${URL}/api/settings`]: { body: { current: {}, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } },
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        log.puts.push(p);
        return { body: { current: p, effective: { agents: [], autonomy: "assisted", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } } };
      },
    };
  }
  const newLog = () => ({ subs: [] as unknown[], unsubs: [] as unknown[], tests: 0, puts: [] as unknown[] });

  test("enable on this device, send a test, turn a kind off, set quiet hours", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.waitFor("id:push-enable");
    expect(app.texts()).toContain("Off");
    await app.press("id:push-enable");
    await app.waitUntil(() => log.subs.length === 1);
    expect(log.subs[0]).toEqual({ subscription: { endpoint: "https://push.test/e1", keys: { p256dh: "k", auth: "a" } }, device_label: "Android · Chrome" });
    await app.waitFor("id:push-test");
    await app.press("id:push-test");
    await app.waitUntil(() => log.tests === 1);
    await app.waitFor("text:/Test notification sent/");
    await app.press("id:notify-result");
    await app.waitUntil(() => log.puts.length === 1);
    const p = log.puts[0] as { notify_prefs: { kinds: Record<string, boolean>; quiet_hours: unknown; tz: string } };
    expect(p.notify_prefs.kinds).toEqual({ decision: true, menu: true, proposals: true, login: true, result: false });
    expect(p.notify_prefs.quiet_hours).toBe(null);
    await app.press("id:quiet-22:00-08:00");
    await app.waitUntil(() => log.puts.length === 2);
    expect((log.puts[1] as typeof p).notify_prefs).toMatchObject({ quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } });
    await app.press("id:push-disable");
    await app.waitUntil(() => log.unsubs.length === 1);
    expect(log.unsubs[0]).toEqual({ endpoint: "https://push.test/e1" });
  });

  test("a refused permission is explained", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device(), "denied") }, network: server(newLog()) });
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.press("id:push-enable");
    await app.waitFor("text:/Notifications are blocked/");
  });

  test("iPhone in Safari: notification setup is in settings", async () => {
    const app = await open("./App.tsx", {
      storage: STORAGE,
      host: { handlers: browser(device({ supported: false, ios: true, permission: "unsupported", device: "iPhone · Safari" })) },
      network: server(newLog()),
    });
    await app.waitFor("id:composer");
    expect(app.shows("id:notify-banner")).toBe(false);
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.waitFor("text:/Choose Add to Home Screen/");
    expect(app.enabled("id:push-enable")).toBe(false);
  });

  test("notification setup enables from settings", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: STORAGE, host: { handlers: browser(device()) }, network: server(log) });
    await app.waitFor("id:composer");
    expect(app.shows("id:notify-banner")).toBe(false);
    await app.press("id:settings-top");
    await app.press("id:settings-notify");
    await app.press("id:push-enable");
    await app.waitUntil(() => log.subs.length === 1);
  });

  test("badge, unread divider, and a notification opening an event", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.lastSeen": events[0].ts, "hub.notifyAsked": "1" },
      host: { handlers: browser(device()) },
      network: server(newLog()),
      width: 1200, height: 800, platform: "macos",
    });
    await app.waitFor("New messages");
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "setBadge" && (c.data as { count: number }).count === 1));
    expect(app.host.calls().some((c) => c.name === "setSession" && (c.data as { session: string }).session === "tok")).toBe(true);
    await app.host.send("open", { ref: "D-0001" });
    await app.waitUntil(() => app.host.calls().some((c) => c.name === "clearNotifications" && (c.data as { ref: string }).ref === "D-0001"));
  });

  test("the unread divider skips an event the channel hides", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.lastSeen": events[3].ts, "hub.notifyAsked": "1" },
      network: hub([]),
      width: 1200, height: 800, platform: "macos",
    });
    await app.waitFor("New messages");
  });

  test("logging out turns this device's notifications off", async () => {
    const log = newLog();
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" },
      host: { handlers: browser(device({ subscribed: true, permission: "granted", endpoint: "https://push.test/e1" })) },
      network: { ...server(log), [`POST ${URL}/api/auth/logout`]: { body: { ok: true } } },
    });
    await app.press("id:settings-top");
    app.onDialog((d) => (d.title === "Sign out?" ? "Sign out" : null));
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(app.dialogs()[0].title).toBe("Sign out?");
    expect(log.unsubs).toEqual([{ endpoint: "https://push.test/e1" }]);
  });
});

describe("voice input", () => {
  test("the microphone dictates into the composer until pressed again; nothing is sent", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 1200, height: 800, platform: "macos" });
    await app.waitFor("label:Voice input");
    await app.type("id:composer", "Remind me:");
    await app.press("label:Voice input");
    await app.waitUntil(() => app.speechRequests().length === 1);
    expect(app.speechRequests()[0].lang).toBe("en-US");
    await app.waitFor("label:Stop voice input");
    expect(app.shows("text:Listening…")).toBe(true);

    // interim results replace each other; the words land after what was typed
    await app.hear("tomorrow");
    expect(app.value("id:composer")).toBe("Remind me: tomorrow");
    await app.hear("tomorrow morning meeting");
    expect(app.value("id:composer")).toBe("Remind me: tomorrow morning meeting");

    await app.press("label:Stop voice input");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("Remind me: tomorrow morning meeting");
    expect(app.shows("id:dictating")).toBe(false);
    expect(posts).toEqual([]);
  });

  test("sending while listening stops it; a refused microphone is explained", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, network: hub([]), width: 1200, height: 800, platform: "macos" });
    await app.press("label:Voice input");
    await app.hear("Check the logs");
    expect(app.value("id:composer")).toBe("Check the logs");
    await app.press("id:send");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("");

    await app.press("label:Voice input");
    await app.endSpeech("not-allowed");
    await app.waitFor("id:attach-note");
    expect(app.shows("text:/No microphone or speech recognition permission/")).toBe(true);
    expect(app.shows("label:Stop voice input")).toBe(false);
  });

  test("on a phone, listening shows a red stop button where the mic was; stopping keeps the words", async () => {
    const posts: { text: string; reply_to?: string }[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, network: hub(posts), width: 390, height: 844, platform: "ios" });
    await app.waitFor("label:Voice input");
    await app.press("label:Voice input");
    await app.waitFor("label:Stop voice input");
    expect(app.shows("id:dictate")).toBe(true);
    expect(app.shows("label:Voice input")).toBe(false);
    await app.hear("Deploy it");
    await app.press("label:Stop voice input");
    await app.waitFor("label:Voice input");
    expect(app.value("id:composer")).toBe("Deploy it");
    expect(posts).toEqual([]);
  });
});

test("clicking outside the macOS composer collapses an empty draft", async () => {
  const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 1100, height: 760, platform: "macos", network: hub([]) });
  await app.waitFor("id:composer");
  expect(app.shows("id:send")).toBe(false);
  await app.keyboard.press("mod+k");
  await app.waitFor("id:send");
  await app.press("label:Main chat");
  await app.waitUntil(() => !app.shows("id:send"));
});

describe("phones", () => {
  const view = () => ({
    current: {},
    effective: {
      agents: [{ id: "reporter", clis: ["codex", "claude"], autonomy: "onboarding" }],
      autonomy: "onboarding",
      routines: [{ name: "triage-inbound", every: "30m", agent: "lead", enabled: true }],
      max_parallel: 4,
    },
    options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
  });
  function settingsServer(puts: unknown[]) {
    let v = view();
    return {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: v }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        puts.push(p);
        if (p.clis) v = { ...v, effective: { ...v.effective, agents: [{ ...v.effective.agents[0], clis: p.clis.agents.reporter }] } };
        if (p.routines) v = { ...v, effective: { ...v.effective, routines: [{ ...v.effective.routines[0], ...p.routines["triage-inbound"] }] } };
        return { body: v };
      },
    };
  }

  test("phone settings checks a model immediately while saving", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { body: view(), delay: 5000 } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(true);
    expect(app.shows("id:settings-note")).toBe(false);
  });

  test("phone model keeps the accepted selection when effective settings are stale", async () => {
    const stale = { ...view(), current: { clis: { agents: { reporter: ["claude"] } } } };
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { body: stale } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    await app.wait(200);
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(true);
  });

  test("phone settings shows an error when saving fails", async () => {
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...settingsServer([]), [`PUT ${URL}/api/settings`]: { status: 500, body: "error" } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-reporter");
    await app.press("id:member-reporter");
    await app.waitFor("id:phone-member");
    await app.press("id:cli-reporter-claude");
    await app.waitFor("id:settings-note");
    expect(app.shows("id:settings-note")).toBe(true);
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(false);
  });

  test("phone settings waits for remote confirmation and retries the same model choice", async () => {
    const ticket = "abcdefab-1234-1234-1234-123456789cde";
    let submissions = 0, polls = 0;
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: {
      ...settingsServer([]),
      [`PUT ${URL}/api/settings`]: () => { submissions++; return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => ++polls === 1 ? { status: 503, body: { error: "temporary outage" } }
        : { body: { ...view(), current: { clis: { agents: { reporter: ["claude"] } } } } },
    } });
    await app.waitFor("id:composer"); await app.press("id:settings-top"); await app.press("id:member-reporter");
    await app.press("id:cli-reporter-claude");
    await app.waitFor("Connection lost while confirming. Try saving again to check the same request.");
    expect(app.shows("id:choice-check-cli-reporter-claude")).toBe(false);
    await app.press("id:cli-reporter-claude"); await app.waitUntil(() => polls === 2);
    await app.waitUntil(() => app.shows("id:choice-check-cli-reporter-claude"));
    expect(submissions).toBe(1);
  });

  test("phone member autonomy can return to the team default", async () => {
    let saved: any;
    const initial = view(); initial.effective.autonomy = "assisted";
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: {
      ...settingsServer([]), [`GET ${URL}/api/settings`]: { body: initial },
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        saved = JSON.parse(r.body!);
        return { body: { ...initial, current: saved, effective: { ...initial.effective, agents: [{ ...initial.effective.agents[0], autonomy: "assisted", autonomy_inherited: true }] } } };
      },
    } });
    await app.waitFor("id:composer"); await app.press("id:settings-top"); await app.press("id:member-reporter");
    await app.press("id:autonomy-reporter-inherit");
    await app.waitFor("id:choice-check-autonomy-reporter-inherit");
    expect(saved).toEqual({ autonomy: { agents: { reporter: null } } });
    expect(app.shows("Use team default (Assisted)")).toBe(true);
  });

  test("iOS settings allows logout", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: { ...settingsServer([]), ...auth(log) } });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    app.onDialog((d) => d.title === "Sign out?" ? "Sign out" : null);
    await app.press("id:logout");
    await app.waitFor("Sign in to Noop");
    expect(log.logouts).toBe(1);
  });

  for (const platform of ["ios", "android"] as const) {
    test(`${platform}: settings is a grouped list whose rows push pages; back returns to the channel`, async () => {
      const puts: unknown[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform, network: settingsServer(puts) });
      await app.waitFor("id:composer");
      await app.press("id:settings-top");
      await app.waitFor("id:phone-settings");
      for (const t of ["Notifications", "Members", "Routines", "Parallel", "Account", "Sign out"]) expect(app.shows(`id:phone-settings >> text:${t}`)).toBe(true);
      // A member pushes its page: models and autonomy as radio rows.
      await app.press("id:member-reporter");
      await app.waitFor("id:phone-member");
      await app.press("id:cli-reporter-claude");
      await app.waitUntil(() => puts.length === 1);
      await app.press("id:autonomy-reporter-assisted");
      await app.waitUntil(() => puts.length === 2);
      await app.back();
      await app.waitUntil(() => !app.shows("id:phone-member"));
      // A routine: a real switch and the interval.
      await app.press("id:routine-row-triage-inbound");
      await app.waitFor("id:phone-routine");
      await app.press("id:routine-triage-inbound");
      await app.press("id:every-triage-inbound-1h");
      await app.waitUntil(() => puts.length === 4);
      expect(puts).toEqual([
        { clis: { agents: { reporter: ["claude"] } } },
        { autonomy: { agents: { reporter: "assisted" } } },
        { routines: { "triage-inbound": { enabled: false } } },
        { routines: { "triage-inbound": { every: "1h" } } },
      ]);
      await app.back();
      await app.back();
      await app.waitUntil(() => !app.shows("id:phone-settings"));
      expect(app.shows("id:composer")).toBe(true);
    });
  }

  test("a horizontal swipe opens the phone sidebar", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: settingsServer([]) });
    await app.waitFor("id:composer");
    await app.drag("id:channel-swipe", { x: 0, y: -100 });
    expect(app.shows("id:drawer")).toBe(false);
    await app.drag("id:channel-swipe", { x: -100, y: 0 });
    expect(app.shows("id:drawer")).toBe(false);
    await app.drag("id:channel-swipe", { x: 100, y: 0 });
    await app.waitFor("id:drawer");
    await app.drag("id:drawer", { x: -100, y: 0 });
    await app.waitUntil(() => !app.shows("id:drawer"));
  });

  test("the sidebar opens from the left; a machine opens its page and back returns to the channel", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: hub([]) });
    await app.waitFor("id:composer");
    expect(app.shows("Needs your decision")).toBe(false);
    await app.press("label:Menu");
    await app.waitFor("Needs your decision");
    await app.press("label:Load 42% · Disk 120GB · 1 running");
    await app.waitFor("60% used");
    await app.waitUntil(() => !app.shows("Needs your decision"));
    await app.back();
    await app.waitUntil(() => !app.shows("60% used"));
    expect(app.shows("id:composer")).toBe(true);
  });

  test("a phone browser draws its own header with a back button", async () => {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "web", network: settingsServer([]) });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    await app.press("label:Back to Main chat");
    await app.waitUntil(() => !app.shows("id:phone-settings"));
    expect(app.shows("id:composer")).toBe(true);
  });
});

describe("rules and memory", () => {
  const enc = encodeURIComponent;
  const day = "2026-10-30T08:00:00.000Z";
  const files: Record<string, unknown[]> = {
    "policies/": [{ path: "policies/fleet.md", size: 10, updated: day }, { path: "policies/projects/app.md", size: 10, updated: day }],
    "memory/": [{ path: "memory/owner.md", size: 10, updated: day }],
    "agents/": [{ path: "agents/dev/profile.md", size: 1, updated: day }, { path: "agents/dev/memory.md", size: 1, updated: day }, { path: "agents/dev/notes.txt", size: 1, updated: day }],
    "decisions/closed/": [],
  };
  const docs: Record<string, string> = {
    "policies/fleet.md": "---\nid: fleet\n---\n# Team rules\n\n- Write tests before changing code",
    "agents/dev/profile.md": "# dev's profile\n\nWorks on the frontend",
  };
  function rulesServer(reads: string[]) {
    const routes: Record<string, any> = { ...hub([]) };
    for (const [pre, list] of Object.entries(files)) routes[`GET ${URL}/api/files/list?prefix=${enc(pre)}`] = { body: { files: list } };
    for (const [p, content] of Object.entries(docs)) {
      routes[`GET ${URL}/api/files/read?path=${enc(p)}`] = () => {
        reads.push(p);
        return { body: { path: p, content, size: content.length, updated: day, version: 1 } };
      };
    }
    return routes;
  }

  test("desktop: the sidebar opens the grouped list; an item renders its markdown", async () => {
    const reads: string[] = [];
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: rulesServer(reads) });
    await app.waitFor("id:composer");
    await app.press("label:Memory");
    await app.waitFor("id:rules-policies");
    for (const t of ["Rules", "My preferences", "Agents", "Decision precedents", "fleet", "projects/app", "owner", "dev · Profile", "dev · Memory", "Nothing here yet"]) expect(app.shows(`id:rules >> text:${t}`)).toBe(true);
    expect(app.shows("text:notes")).toBe(false);
    await app.press("id:rule-policies/fleet.md");
    await app.waitFor("Team rules");
    expect(app.shows("text:Write tests before changing code")).toBe(true);
    expect(app.shows("text:id: fleet")).toBe(false);
    expect(reads).toEqual(["policies/fleet.md"]);
    await app.press("label:Back to Memory");
    await app.waitFor("id:rules");
  });

  test("phone: settings opens the list; an agent's profile pushes a page; back walks down", async () => {
    const reads: string[] = [];
    const view = { current: {}, effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } };
    const app = await open("./App.tsx", {
      storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios",
      network: { ...rulesServer(reads), [`GET ${URL}/api/settings`]: { body: view } },
    });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:phone-settings");
    await app.press("id:settings-rules");
    await app.waitFor("id:rules-agents");
    await app.press("id:rule-agents/dev/profile.md");
    await app.waitFor("Works on the frontend");
    await app.back();
    await app.waitUntil(() => !app.shows("id:rule-doc"));
    expect(app.shows("id:rules")).toBe(true);
    await app.back();
    await app.waitFor("id:phone-settings");
  });

  test("desktop edits rules against the latest version and keeps a conflicted draft", async () => {
    let latest = docs["policies/fleet.md"], saved: any;
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...rulesServer([]),
      [`POST ${URL}/api/documents`]: () => ({ body: { content: latest } }),
      [`PUT ${URL}/api/documents`]: (r: { body?: string | null }) => {
        saved = JSON.parse(r.body!);
        if (saved.base !== latest) return { status: 409, body: { error: "Document changed. Your draft is kept." } };
        latest = "---\nid: fleet\n---\n" + saved.content;
        return { body: { content: latest } };
      },
    } });
    await app.waitFor("id:composer"); await app.press("label:Memory"); await app.press("id:rule-policies/fleet.md");
    await app.press("id:document-edit"); await app.waitFor("id:document-content");
    expect(app.value("id:document-content")).not.toContain("id: fleet");
    await app.clear("id:document-content"); await app.type("id:document-content", "Ask before deploying.");
    latest += "\nAgent-added rule.";
    await app.press("id:document-save"); await app.waitFor("Document changed. Your draft is kept.");
    expect(app.value("id:document-content")).toBe("Ask before deploying.");
    await app.press("id:document-reload"); await app.waitUntil(() => (app.value("id:document-content") ?? "").includes("Agent-added rule"));
    await app.clear("id:document-content"); await app.type("id:document-content", "Ask before deploying. Keep agent rule."); await app.press("id:document-save");
    await app.waitFor("id:document-note"); expect(saved.base).toContain("Agent-added rule.");
    expect(latest).toBe("---\nid: fleet\n---\nAsk before deploying. Keep agent rule.");
  });

  test("phone creates a preference from Memory and profiles remain in their own editor", async () => {
    let saved: any;
    const view = { current: {}, effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 }, options: { clis: [], autonomy: [] } };
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network: {
      ...rulesServer([]), [`GET ${URL}/api/settings`]: { body: view },
      [`GET ${URL}/api/files/read?path=memory%2Freview-style.md`]: { status: 404, body: {} },
      [`POST ${URL}/api/documents`]: { body: { content: null } },
      [`PUT ${URL}/api/documents`]: (r: { body?: string | null }) => { saved = JSON.parse(r.body!); return { body: { content: saved.content } }; },
    } });
    await app.waitFor("id:composer"); await app.press("id:settings-top"); await app.press("id:settings-rules");
    await app.press("id:document-add"); await app.press("id:document-folder"); await app.press("id:document-folder-memory");
    await app.clear("id:document-name"); await app.type("id:document-name", "review-style"); await app.press("id:document-create");
    await app.waitFor("id:document-content"); await app.clear("id:document-content"); await app.type("id:document-content", "Prefer concise reviews."); await app.press("id:document-save");
    await app.waitFor("id:document-note"); expect(saved).toEqual({ path: "memory/review-style.md", base: null, content: "Prefer concise reviews." });
    await app.back(); await app.press("id:rule-agents/dev/profile.md"); await app.waitFor("Works on the frontend");
    expect(app.shows("id:document-edit")).toBe(false);
  });


  test("knowledge editing preserves changes typed while remote confirmation is pending", async () => {
    let polls = 0;
    const submitted = "First saved version.";
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...rulesServer([]), [`POST ${URL}/api/documents`]: { body: { content: docs["policies/fleet.md"] } },
      [`PUT ${URL}/api/documents`]: { status: 202, body: { ticket: "12345678-1234-1234-1234-123456789bbb" } },
      [`GET ${URL}/api/ui-requests/12345678-1234-1234-1234-123456789bbb`]: () => ++polls === 1 ? { status: 202, body: { ticket: "12345678-1234-1234-1234-123456789bbb" } } : { body: { content: "---\nid: fleet\n---\n" + submitted } },
    } });
    await app.waitFor("id:composer"); await app.press("label:Memory"); await app.press("id:rule-policies/fleet.md");
    await app.press("id:document-edit"); await app.waitFor("id:document-content");
    await app.clear("id:document-content"); await app.type("id:document-content", submitted); await app.press("id:document-save");
    await app.waitUntil(() => polls > 0);
    await app.clear("id:document-content"); await app.type("id:document-content", "Additional edits.");
    await app.waitFor("Submitted version saved. You have additional unsaved edits.");
    expect(app.value("id:document-content")).toBe("Additional edits.");
  });

});

describe("commands", () => {
  const view = (commands: unknown[]) => ({
    current: { commands },
    effective: { agents: [], autonomy: "onboarding", routines: [], max_parallel: 2 },
    options: { clis: [], autonomy: [] },
  });
  function server(posts: { text: string; reply_to?: string }[], puts: unknown[], updates: { n: number }) {
    let v = view([{ name: "daily-report", text: "Summarize today's progress on each project into a daily report and send it to me" }]);
    return {
      ...hub(posts),
      [`GET ${URL}/api/settings`]: () => ({ body: v }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => {
        const p = JSON.parse(r.body!);
        puts.push(p);
        v = { ...v, current: { ...v.current, ...p } };
        return { body: v };
      },
      [`POST ${URL}/api/fleet/update`]: () => { updates.n++; return { body: { ok: true } }; },
    };
  }

  test("/ lists the commands; Return runs the first match: a saved one sends its text, the built-in updates the fleet", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-builtin:update-fleet");
    await app.waitFor("id:command-saved:0");
    await app.type("id:composer", "daily");
    await app.waitUntil(() => !app.shows("id:command-builtin:update-fleet"));
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Summarize today's progress on each project into a daily report and send it to me" });
    expect(app.value("id:composer")).toBe("");
    expect(app.shows("id:commands")).toBe(false);

    app.onDialog((d) => (d.title === "Update all machines?" ? "Update" : null));
    await app.type("id:composer", "/update");
    await app.press("id:command-builtin:update-fleet");
    await app.waitUntil(() => updates.n === 1);
    expect(posts.length).toBe(1);
  });

  test("the / list takes the keyboard: Down picks the next, Return runs it, Escape closes", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.waitFor("id:composer");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-saved:0");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:commands"));
    expect(app.value("id:composer")).toBe("");
    await app.type("id:composer", "/");
    await app.waitFor("id:command-saved:0");
    await app.keyboard.press("down");
    await app.keyboard.press("mod+enter");
    await app.waitUntil(() => posts.length === 1);
    expect(posts[0]).toEqual({ text: "Summarize today's progress on each project into a daily report and send it to me" });
    expect(updates.n).toBe(0);
  });

  test("settings adds, edits and deletes saved commands in an editor", async () => {
    const posts: { text: string; reply_to?: string }[] = [], puts: unknown[] = [], updates = { n: 0 };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: server(posts, puts, updates) });
    await app.press("id:settings");
    await app.press("id:settings-tab-commands");
    await app.waitFor("id:command-row-daily-report");
    // new: a name taken by another command is refused
    await app.press("id:command-new");
    await app.waitFor("id:command-editor");
    await app.type("id:command-name", "/daily-report");
    await app.type("id:command-text", "Summarize this week's progress\none section per project");
    await app.press("id:command-save");
    await app.waitFor("id:command-note");
    expect(puts.length).toBe(0);
    await app.clear("id:command-name");
    await app.type("id:command-name", "weekly-report");
    await app.press("id:command-save");
    await app.waitUntil(() => puts.length === 1);
    expect(puts[0]).toEqual({ commands: [{ name: "daily-report", text: "Summarize today's progress on each project into a daily report and send it to me" }, { name: "weekly-report", text: "Summarize this week's progress\none section per project" }] });
    await app.waitUntil(() => !app.shows("id:command-editor"));
    // edit: renaming keeps its place
    await app.press("id:command-row-daily-report");
    expect(app.value("id:command-name")).toBe("daily-report");
    await app.clear("id:command-name");
    await app.type("id:command-name", "today");
    await app.press("id:command-save");
    await app.waitUntil(() => puts.length === 2);
    expect(puts[1]).toEqual({ commands: [{ name: "today", text: "Summarize today's progress on each project into a daily report and send it to me" }, { name: "weekly-report", text: "Summarize this week's progress\none section per project" }] });
    // delete
    await app.waitFor("id:command-row-weekly-report");
    await app.press("id:command-row-weekly-report");
    await app.press("id:command-delete");
    await app.waitUntil(() => puts.length === 3);
    expect(puts[2]).toEqual({ commands: [{ name: "today", text: "Summarize today's progress on each project into a daily report and send it to me" }] });
  });

  test("command settings keeps an unsaved draft when the primary rejects it", async () => {
    const puts: unknown[] = [], network = server([], puts, { n: 0 });
    let attempts = 0;
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...network, [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => ++attempts === 1
        ? { status: 400, body: { error: "Commands are not ready" } } : network[`PUT ${URL}/api/settings`](r),
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-commands"); await app.press("id:command-new");
    await app.type("id:command-name", "weekly"); await app.type("id:command-text", "Review the week."); await app.press("id:command-save");
    await app.waitFor("Commands are not ready"); expect(app.value("id:command-text")).toBe("Review the week.");
    await app.press("id:command-save"); await app.waitUntil(() => !app.shows("id:command-editor"));
    expect(puts.length).toBe(1); expect(app.shows("/weekly")).toBe(true);
  });


  test("command settings preserves edits made while saving", async () => {
    const puts: unknown[] = [], network = server([], puts, { n: 0 });
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...network, [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => ({ ...network[`PUT ${URL}/api/settings`](r), delay: 1000 }),
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-commands"); await app.press("id:command-new");
    await app.type("id:command-name", "weekly"); await app.type("id:command-text", "First version."); await app.press("id:command-save");
    await app.clear("id:command-text"); await app.type("id:command-text", "More details.");
    await app.waitFor("Submitted version saved. You have additional unsaved edits.");
    expect(app.value("id:command-text")).toBe("More details.");
    await app.press("id:command-save"); await app.waitUntil(() => !app.shows("id:command-editor"));
    expect((puts[1] as any).commands.filter((c: any) => c.name === "weekly")).toEqual([{ name: "weekly", text: "More details." }]);
  });

});

describe("members", () => {
  function members() {
    const agent = (id: string, title: string) => ({ id, title, about: `${title} summary`, clis: ["claude"], autonomy: "onboarding" });
    const view = () => ({ current: {}, effective: { agents: list.map((a) => agent(a.id, a.title)), autonomy: "onboarding", routines: [], max_parallel: null, media_days: 7 }, options: { clis: [["claude"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] } });
    const list = [{ id: "lead", title: "Lead" }];
    const log: { creates: Record<string, string>[]; edits: Record<string, string>[]; deletes: string[]; blockDelete: boolean } = { creates: [], edits: [], deletes: [], blockDelete: false };
    const network = {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`POST ${URL}/api/members`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        if (b.title === "Taken (x)") return { status: 400, body: { error: "A role is one short line, without parentheses or dashes" } };
        log.creates.push(b);
        list.push({ id: "writer", title: b.title });
        return { body: { id: "writer", view: view() } };
      },
      [`GET ${URL}/api/members/writer`]: () => ({ body: { id: "writer", title: list[1]!.title, name: "Ada", about: "words", instructions: "Write well." } }),
      [`PUT ${URL}/api/members/writer`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        log.edits.push(b);
        list[1]!.title = b.title;
        return { body: { id: "writer", view: view() } };
      },
      [`DELETE ${URL}/api/members/writer`]: () => {
        if (log.blockDelete) return { status: 409, body: { error: "Can't delete yet: open tasks: T-0001" } };
        log.deletes.push("writer");
        list.pop();
        return { body: { id: "writer", view: view() } };
      },
    };
    return { log, network };
  }

  test("a member saved locally is retried as an edit instead of created twice", async () => {
    const { log, network } = members();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...network, [`POST ${URL}/api/members`]: (r: { body?: string | null }) => ({ status: 503, body: { ...network[`POST ${URL}/api/members`](r).body, saved_locally: true, error: "Saved on the main machine; sync is pending." } }),
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-members"); await app.press("id:member-new");
    await app.type("id:member-title", "Writer"); await app.type("id:member-instructions", "Write well."); await app.press("id:member-save");
    await app.waitFor("Saved on the main machine; sync is pending.");
    expect(app.value("id:member-instructions")).toBe("Write well.");
    await app.press("id:member-save"); await app.waitUntil(() => !app.shows("id:member-editor"));
    expect(log.creates.length).toBe(1); expect(log.edits.length).toBe(1);
  });

  test("settings adds, edits and deletes a member", async () => {
    const { log, network } = members();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings");
    await app.press("id:settings-tab-members");
    await app.waitFor("id:member-lead");
    // add: the server's refusal keeps the dialog open
    await app.press("id:member-new");
    await app.waitFor("id:member-editor");
    await app.type("id:member-title", "Taken (x)");
    await app.type("id:member-instructions", "Write well.");
    await app.press("id:member-save");
    await app.waitFor("id:member-note");
    expect(app.shows("id:member-editor")).toBe(true);
    await app.clear("id:member-title");
    await app.type("id:member-title", "Writer");
    await app.type("id:member-name", "Ada");
    await app.press("id:member-save");
    await app.waitFor("id:member-writer");
    await app.waitUntil(() => !app.shows("id:member-editor"));
    expect(log.creates).toEqual([{ title: "Writer", name: "Ada", about: "", instructions: "Write well." }]);
    // edit: opens with what's saved
    await app.press("id:member-edit-writer");
    await app.waitFor("id:member-editor");
    expect(app.value("id:member-instructions")).toBe("Write well.");
    expect(app.value("id:member-name")).toBe("Ada");
    await app.clear("id:member-title");
    await app.type("id:member-title", "Senior Writer");
    await app.press("id:member-save");
    await app.waitUntil(() => log.edits.length === 1);
    expect(log.edits[0]).toEqual({ title: "Senior Writer", name: "Ada", about: "words", instructions: "Write well." });
    await app.waitFor("Senior Writer");
    // delete asks first; cancelling keeps them; a refusal says why
    await app.press("id:member-edit-writer");
    await app.waitFor("id:member-delete");
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Cancel" : null));
    await app.press("id:member-delete");
    expect(log.deletes.length).toBe(0);
    log.blockDelete = true;
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Delete" : null));
    await app.press("id:member-delete");
    await app.waitFor("Can't delete yet: open tasks: T-0001");
    log.blockDelete = false;
    await app.press("id:member-delete");
    await app.waitUntil(() => log.deletes.length === 1);
    await app.waitUntil(() => !app.shows("id:member-writer"));
  });

  test("on a phone: add a member, then delete them from their page and return to the list", async () => {
    const { log, network } = members();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:member-new");
    await app.press("id:member-new");
    await app.waitFor("id:member-editor");
    await app.type("id:member-title", "Writer");
    await app.type("id:member-instructions", "Write well.");
    await app.press("id:member-save");
    await app.waitUntil(() => log.creates.length === 1);
    await app.waitFor("id:member-writer");
    // deleting from the member's page returns to the list
    await app.press("id:member-writer");
    await app.waitFor("id:phone-member");
    await app.press("id:member-edit-writer");
    await app.waitFor("id:member-delete");
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Delete" : null));
    await app.press("id:member-delete");
    await app.waitUntil(() => log.deletes.length === 1);
    await app.waitUntil(() => !app.shows("id:phone-member"));
  });

  test("a hub without the members API says so", async () => {
    const { network } = members();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...network, [`POST ${URL}/api/members`]: { status: 404, body: { error: "not found" } } } });
    await app.press("id:settings");
    await app.press("id:settings-tab-members");
    await app.press("id:member-new");
    await app.type("id:member-title", "Writer");
    await app.type("id:member-instructions", "Write well.");
    await app.press("id:member-save");
    await app.waitFor("Update the hub and main machine to edit members");
  });
});

describe("built-in specialists", () => {
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: previews built-in instructions and adds a specialist with safe sync retry`, async () => {
      let calls = 0, installed = false;
      const list = () => [{ id: "apprentice", about: "Apprentice", installed }, { id: "writer", about: "Writer", installed: true }];
      const settings = () => ({ current: {}, effective: { agents: installed ? [{ id: "apprentice", title: "Apprentice", clis: ["claude"], autonomy: "onboarding" }] : [], projects: [], routines: [], autonomy: "onboarding", max_parallel: null }, options: { clis: [["claude"]], autonomy: ["onboarding"] } });
      const preview = (id: string) => ({ id, about: id === "apprentice" ? "Apprentice" : "Writer", installed: id === "writer" || installed, profile: `# ${id}\nSupplied instructions for ${id}.`, routines: [{ name: "learn-owner", every: "daily 09:00", enabled: false }] });
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: settings() }),
        [`GET ${URL}/api/roles`]: () => ({ body: { roles: list() } }),
        [`GET ${URL}/api/roles/apprentice`]: () => ({ body: preview("apprentice") }),
        [`GET ${URL}/api/roles/writer`]: () => ({ body: preview("writer") }),
        [`POST ${URL}/api/roles/apprentice`]: (r: { body?: string | null }) => {
          expect(JSON.parse(r.body!)).toEqual({}); calls++; installed = true;
          return calls === 1 ? { status: 503, body: { id: "apprentice", saved_locally: true, view: settings(), error: "Saved locally; sync not confirmed" } } : { body: { id: "apprentice", routines: [], view: settings() } };
        },
      } });
      if (platform === "ios") await app.press("id:settings-top"); else { await app.press("id:settings"); await app.press("id:settings-tab-members"); }
      await app.press("id:role-library-open"); await app.waitFor("id:role-profile"); await app.waitFor("text:/Supplied instructions for apprentice/");
      await app.waitFor("text:/Supplied routines .off when added./");
      await app.press("id:role-choice"); await app.press("id:role-choice-writer"); await app.waitFor("text:/Supplied instructions for writer/");
      expect(app.enabled("id:role-add")).toBe(true); expect(calls).toBe(0);
      await app.press("id:role-choice"); await app.press("id:role-choice-apprentice"); await app.waitFor("text:/Supplied instructions for apprentice/");
      await app.press("id:role-add"); await app.waitFor("Saved locally; sync not confirmed"); expect(app.shows("id:role-library")).toBe(true);
      await app.press("id:role-library-close"); await app.waitUntil(() => !app.shows("id:role-library"));
      await app.press("id:role-library-open"); await app.waitFor("id:role-profile"); await app.waitFor("Restore and sync");
      expect(app.enabled("id:role-add")).toBe(true);
      await app.press("id:role-add"); await app.waitUntil(() => !app.shows("id:role-library")); expect(calls).toBe(2);
      await app.waitFor("id:member-apprentice");
    });
  }

  test("an older hub explains unavailable specialist setup", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/settings`]: { body: { current: {}, effective: { agents: [], routines: [], projects: [], autonomy: "onboarding", max_parallel: null }, options: { clis: [["claude"]], autonomy: ["onboarding"] } } },
      [`GET ${URL}/api/roles`]: { status: 404, body: { error: "not found" } },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-members"); await app.press("id:role-library-open");
    await app.waitFor("Update the hub and main machine to add built-in specialists."); expect(app.enabled("id:role-add")).toBe(false);
  });
});

describe("projects", () => {
  function projects() {
    const list: { id: string; name: string; path: string; host: string; repo: string; instructions: string; exists: boolean }[] = [];
    const view = () => ({ current: {}, effective: { agents: [], projects: list, autonomy: "onboarding", routines: [], max_parallel: null, media_days: 7 }, options: { clis: [["claude"]], autonomy: ["onboarding"] } });
    const log: { creates: Record<string, string>[]; edits: Record<string, string>[]; deletes: number; block: boolean } = { creates: [], edits: [], deletes: 0, block: false };
    const network = {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        if (b.path === "/nope") return { status: 400, body: { error: "No folder at /nope on this machine" } };
        log.creates.push(b);
        list.push({ id: "site", name: b.name, path: b.path, host: "mac", repo: "acme/site", instructions: b.instructions, exists: true });
        return { body: { id: "site", view: view() } };
      },
      [`PUT ${URL}/api/projects/site`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        log.edits.push(b);
        Object.assign(list[0]!, b, { exists: false });
        return { body: { id: "site", view: view() } };
      },
      [`DELETE ${URL}/api/projects/site`]: () => {
        if (log.block) return { status: 409, body: { error: "Can't remove yet: open tasks: T-0001" } };
        log.deletes++;
        list.pop();
        return { body: { id: "site", view: view() } };
      },
    };
    return { log, network };
  }

  test("settings connects, edits and removes a project", async () => {
    const { log, network } = projects();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings");
    await app.press("id:settings-tab-projects");
    await app.press("id:project-new");
    await app.waitFor("id:project-editor");
    await app.type("id:project-name", "Site");
    await app.type("id:project-path", "/nope");
    await app.press("id:project-save");
    await app.waitFor("No folder at /nope on this machine");
    expect(app.shows("id:project-editor")).toBe(true);
    await app.clear("id:project-path");
    await app.type("id:project-path", "/code/site");
    await app.type("id:project-instructions", "Run the tests.");
    await app.press("id:project-save");
    await app.waitFor("id:project-site");
    await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(log.creates).toEqual([{ name: "Site", path: "/code/site", instructions: "Run the tests." }]);
    await app.waitFor("acme/site · /code/site");
    // edit opens with what's saved; a folder that's gone says so
    await app.press("id:project-site");
    await app.waitFor("id:project-editor");
    expect(app.value("id:project-instructions")).toBe("Run the tests.");
    await app.clear("id:project-path");
    await app.type("id:project-path", "/moved");
    await app.press("id:project-save");
    await app.waitUntil(() => log.edits.length === 1);
    await app.waitFor("Folder not found: /moved");
    // remove asks first; a refusal says why
    await app.press("id:project-site");
    await app.waitFor("id:project-delete");
    app.onDialog((d) => (d.title?.startsWith("Remove") ? "Cancel" : null));
    await app.press("id:project-delete");
    expect(log.deletes).toBe(0);
    log.block = true;
    app.onDialog((d) => (d.title?.startsWith("Remove") ? "Remove" : null));
    await app.press("id:project-delete");
    await app.waitFor("Can't remove yet: open tasks: T-0001");
    log.block = false;
    await app.press("id:project-delete");
    await app.waitUntil(() => log.deletes === 1);
    await app.waitUntil(() => !app.shows("id:project-site"));
  });

  test("a phone connects a project from settings, and an old hub says it can't", async () => {
    const { log, network } = projects();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:project-new");
    await app.press("id:project-new");
    await app.waitFor("id:project-editor");
    await app.type("id:project-name", "Site");
    await app.type("id:project-path", "/code/site");
    await app.press("id:project-save");
    await app.waitUntil(() => log.creates.length === 1);
    await app.waitFor("id:project-site");
    const old = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...network, [`POST ${URL}/api/projects`]: { status: 404, body: { error: "not found" } } } });
    await old.press("id:settings");
    await old.press("id:settings-tab-projects");
    await old.press("id:project-new");
    await old.type("id:project-name", "Site");
    await old.type("id:project-path", "/code/site");
    await old.press("id:project-save");
    await old.waitFor("Update the hub and main machine to edit projects");
  });
});

describe("worker projects", () => {
  const probeId = "b187d49c-46d7-4e9c-97d9-a3def411fba1";
  const probe = (path: string) => ({ host: "worker", requested_path: path, path: path.startsWith("~") ? "/worker/app" : path, repo: "acme/detected", requires: ["tool:rust"], checked: new Date().toISOString(), probe_ticket: probeId });
  function fixture(existing = false, offline = false) {
    const rows: any[] = existing ? [{ id: "worker-app", name: "Worker app", host: "worker", path: "/worker/app", repo: "acme/detected", custom_repo: null, detected_repo: "acme/detected", requires: ["tool:rust", "gpu"], custom_requires: ["gpu"], detected_requires: ["tool:rust"], instructions: "Original instructions", exists: null, checked: ts(59) }] : [];
    const view = () => ({ current: {}, effective: { primary_host: "main", agents: [], routines: [], projects: rows, autonomy: "onboarding", max_parallel: null }, options: { clis: [["claude"]], autonomy: ["onboarding"] } });
    const log = { probes: [] as any[], writes: [] as { method: string; body: any }[] };
    const save = (method: string, r: { body?: string | null }) => {
      const b = JSON.parse(r.body!); log.writes.push({ method, body: b });
      const p = { id: "worker-app", ...b, path: b.path.startsWith("~") ? "/worker/app" : b.path, repo: b.repo || "acme/detected", custom_repo: b.repo || null, detected_repo: "acme/detected", custom_requires: b.requires ? b.requires.split(",") : [], detected_requires: ["tool:rust"], exists: null, checked: new Date().toISOString() };
      rows.splice(0, rows.length, p);
      return { body: { id: p.id, view: view() } };
    };
    const worker = { host: "worker", caps: ["os:linux", "tool:rust"], online: !offline };
    const network = {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`GET ${URL}/api/status`]: { body: { ...status, hosts: [{ host: "main", caps: ["os:macos"], online: true }, ...(!offline ? [worker] : [])], offline_hosts: offline ? [worker] : [] } },
      [`POST ${URL}/api/machines/worker/project-folder-check`]: (r: { body?: string | null }) => { const b = JSON.parse(r.body!); log.probes.push(b); return { body: probe(b.path) }; },
      [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => save("POST", r),
      [`PUT ${URL}/api/projects/worker-app`]: (r: { body?: string | null }) => save("PUT", r),
    };
    return { rows, view, log, network };
  }
  async function openEditor(network: unknown, platform: "macos" | "ios" = "macos", existing = false) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network } as never);
    await app.waitFor("id:composer"); await app.press(platform === "ios" ? "id:settings-top" : "id:settings");
    if (platform === "macos") await app.press("id:settings-tab-projects");
    await app.press(existing ? "id:project-worker-app" : "id:project-new"); await app.waitFor("id:project-editor");
    return app;
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: selects a worker and saves its verified folder with custom project settings`, async () => {
      const f = fixture(), app = await openEditor(f.network, platform);
      await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker");
      await app.type("id:project-path", "~/app"); await app.press("id:project-check"); await app.waitFor("id:project-detected");
      expect(app.shows("text:/Detected requirements: tool:rust/")).toBe(true);
      await app.type("id:project-repo", "acme/custom"); await app.type("id:project-requires", "gpu"); await app.type("id:project-instructions", "Build on this worker.");
      await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
      expect(f.log.probes).toEqual([{ path: "~/app" }]);
      expect(f.log.writes).toEqual([{ method: "POST", body: { name: "Worker app", path: "~/app", host: "worker", repo: "acme/custom", requires: "gpu", instructions: "Build on this worker.", probe_ticket: probeId } }]);
      expect(app.shows("text:/Folder not found/")).toBe(false);
    });
  }
  test("an offline worker's saved settings can be edited without checking the primary's folder", async () => {
    const f = fixture(true, true), app = await openEditor(f.network, "macos", true);
    await app.waitFor("id:project-offline"); expect(app.value("id:project-repo")).toBe("");
    expect(app.value("id:project-requires")).toBe("gpu");
    await app.clear("id:project-requires"); await app.clear("id:project-instructions"); await app.type("id:project-instructions", "Updated offline.");
    await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.probes).toHaveLength(0);
    expect(f.log.writes[0]).toEqual({ method: "PUT", body: { name: "Worker app", path: "/worker/app", host: "worker", repo: "", requires: "", instructions: "Updated offline." } });
    expect(app.shows("text:/Folder not found/")).toBe(false);
  });
  test("an unavailable folder-check API keeps the project draft and does not create anything", async () => {
    const f = fixture(), message = "Update and reconnect worker to check its project folders.";
    const app = await openEditor({ ...f.network, [`POST ${URL}/api/machines/worker/project-folder-check`]: { status: 409, body: { error: message } } });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "~/app");
    await app.press("id:project-save"); await app.waitFor(message);
    expect(app.value("id:project-path")).toBe("~/app"); expect(f.log.writes).toHaveLength(0); expect(app.enabled("id:project-save")).toBe(true);
  });
  test("a folder check that finishes after the path changes cannot approve the new folder", async () => {
    const f = fixture(); let release = false, first = true, polls = 0;
    const app = await openEditor({ ...f.network,
      [`POST ${URL}/api/machines/worker/project-folder-check`]: (r: { body?: string | null }) => {
        if (first) { first = false; f.log.probes.push(JSON.parse(r.body!)); return { status: 202, body: { ticket: probeId } }; }
        return f.network[`POST ${URL}/api/machines/worker/project-folder-check`](r);
      },
      [`GET ${URL}/api/machine-requests/${probeId}`]: () => { polls++; return release ? { body: probe("/first") } : { status: 202, body: { ticket: probeId } }; },
    });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "/first");
    await app.press("id:project-check"); await app.waitUntil(() => polls > 0); await app.clear("id:project-path"); await app.type("id:project-path", "/second"); release = true;
    await app.waitUntil(() => app.enabled("id:project-check")); expect(app.shows("id:project-detected")).toBe(false);
    await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.probes).toEqual([{ path: "/first" }, { path: "/second" }]); expect(f.log.writes[0]!.body.path).toBe("/second");
  });
  test("an unconfirmed create retries its saved project as an edit", async () => {
    const f = fixture(), message = "Project saved locally; synchronization is unconfirmed.";
    const app = await openEditor({ ...f.network, [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => ({ status: 503, body: { ...f.network[`POST ${URL}/api/projects`](r).body, saved_locally: true, error: message } }) });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "~/app");
    await app.press("id:project-save"); await app.waitFor(message); await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.writes.map((w) => w.method)).toEqual(["POST", "PUT"]); expect(f.log.writes[1]!.body.path).toBe("/worker/app"); expect(f.log.writes[1]!.body.probe_ticket).toBeUndefined(); expect(f.log.probes).toHaveLength(1);
  });
  test("edits typed during project confirmation stay open and save to the created project", async () => {
    const f = fixture(); let release = false;
    const app = await openEditor({ ...f.network,
      [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => { f.network[`POST ${URL}/api/projects`](r); return { status: 202, body: { ticket: probeId } }; },
      [`GET ${URL}/api/ui-requests/${probeId}`]: () => release ? { body: { id: "worker-app", view: f.view() } } : { status: 202, body: { ticket: probeId } },
    });
    await app.type("id:project-name", "Worker app"); await app.type("id:project-path", "/main/app"); await app.type("id:project-instructions", "First instructions");
    await app.press("id:project-save"); await app.waitUntil(() => f.log.writes.length === 1);
    await app.clear("id:project-instructions"); await app.type("id:project-instructions", "Newer instructions"); release = true;
    await app.waitFor("The earlier version was saved. Your newer edits are still here; save again to apply them.");
    expect(app.value("id:project-instructions")).toBe("Newer instructions");
    await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.writes.map((w) => w.method)).toEqual(["POST", "PUT"]); expect(f.log.writes[1]!.body.instructions).toBe("Newer instructions");
  });
  test("a failed folder recheck invalidates its earlier successful proof", async () => {
    const f = fixture(); let checks = 0;
    const app = await openEditor({ ...f.network, [`POST ${URL}/api/machines/worker/project-folder-check`]: (r: { body?: string | null }) => {
      checks++; return checks === 1 ? f.network[`POST ${URL}/api/machines/worker/project-folder-check`](r) : { status: 400, body: { error: "The folder no longer exists on worker." } };
    } });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "~/app");
    await app.press("id:project-check"); await app.waitFor("id:project-detected"); await app.press("id:project-check"); await app.waitFor("The folder no longer exists on worker.");
    await app.press("id:project-save"); await app.waitUntil(() => checks === 3); await app.waitFor("The folder no longer exists on worker.");
    expect(f.log.writes).toHaveLength(0); expect(app.shows("id:project-detected")).toBe(false);
  });
  test("worker clock drift does not discard a newly received folder proof", async () => {
    const f = fixture(), app = await openEditor({ ...f.network, [`POST ${URL}/api/machines/worker/project-folder-check`]: { body: { ...probe("~/app"), checked: "2020-01-01T00:00:00.000Z" } } });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "~/app");
    await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.writes[0]!.body.probe_ticket).toBe(probeId);
  });
  test("a rejected folder proof is checked again before another save", async () => {
    const f = fixture(); let rejected = false;
    const app = await openEditor({ ...f.network, [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => {
      if (!rejected) { rejected = true; return { status: 409, body: { error: "The folder verification expired. Check again." } }; }
      return f.network[`POST ${URL}/api/projects`](r);
    } });
    await app.type("id:project-name", "Worker app"); await app.press("id:project-host"); await app.press("id:project-host-worker"); await app.type("id:project-path", "~/app");
    await app.press("id:project-save"); await app.waitFor("The folder verification expired. Check again."); await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.probes).toHaveLength(2); expect(f.log.writes).toHaveLength(1);
  });
  test("an old confirmation cannot replace a newly opened project draft", async () => {
    const f = fixture(); let release = false, pending = true;
    const app = await openEditor({ ...f.network,
      [`POST ${URL}/api/projects`]: (r: { body?: string | null }) => {
        const result = f.network[`POST ${URL}/api/projects`](r);
        if (pending) { pending = false; return { status: 202, body: { ticket: probeId } }; }
        return result;
      },
      [`GET ${URL}/api/ui-requests/${probeId}`]: () => release ? { body: { id: "worker-app", view: f.view() } } : { status: 202, body: { ticket: probeId } },
    });
    await app.type("id:project-name", "First project"); await app.type("id:project-path", "/main/first"); await app.press("id:project-save");
    await app.waitUntil(() => f.log.writes.length === 1); await app.press("id:project-cancel"); await app.press("id:project-new");
    await app.type("id:project-name", "Second project"); await app.type("id:project-path", "/main/second"); release = true;
    await app.waitUntil(() => app.enabled("id:project-save")); expect(app.value("id:project-name")).toBe("Second project");
    await app.press("id:project-save"); await app.waitUntil(() => !app.shows("id:project-editor"));
    expect(f.log.writes.map((w) => w.method)).toEqual(["POST", "POST"]); expect(f.log.writes[1]!.body.name).toBe("Second project");
  });
});

describe("plans", () => {
  type S = { id: string; title: string; details: string; agent: string; checkpoint: boolean; status: string; task?: string; result?: string };
  function plans() {
    const plan = { id: "PL-0001", goal: "Add dark mode", project: "site", agent: "lead", status: "drafting", branch: "agent/plan-PL-0001", notes: [] as string[], steps: [] as S[], reason: undefined as string | undefined };
    const log: { creates: Record<string, unknown>[]; puts: Record<string, unknown>[]; calls: string[]; refuse: boolean } = { creates: [], puts: [], calls: [], refuse: false };
    const list = () => (log.creates.length ? [plan] : []);
    const settings = { current: {}, effective: { agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "onboarding" }, { id: "writer", title: "Writer", clis: ["claude"], autonomy: "onboarding" }], projects: [{ id: "site", name: "Site", path: "/code/site", host: "mac", repo: "", instructions: "", exists: true }], autonomy: "onboarding", routines: [], max_parallel: null, media_days: 7 }, options: { clis: [["claude"]], autonomy: ["onboarding"] } };
    const action = (name: string, change: () => void) => ({
      [`POST ${URL}/api/plans/PL-0001/${name}`]: (r: { body?: string | null }) => {
        log.calls.push(name);
        if (log.refuse) return { status: 409, body: { error: "Plan PL-0001 is busy" } };
        if (name === "continue") plan.notes.push(JSON.parse(r.body!).instructions);
        change();
        return { body: name === "cancel" ? { ok: true, id: plan.id, plan, cleanup: { remaining: 0, pending: [], unresolved: [] } } : { plan } };
      },
    });
    const network = {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: settings }),
      [`GET ${URL}/api/status`]: () => ({ body: { ...status, plans: list().map((p) => ({ id: p.id, goal: p.goal, status: p.status, done: 0, total: p.steps.length })) } }),
      [`GET ${URL}/api/plans`]: () => ({ body: { plans: list() } }),
      [`POST ${URL}/api/plans`]: (r: { body?: string | null }) => { log.creates.push(JSON.parse(r.body!)); return { body: { plan } }; },
      [`GET ${URL}/api/plans/PL-0001`]: () => ({ body: { plan } }),
      [`PUT ${URL}/api/plans/PL-0001`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        log.puts.push(b);
        plan.steps = [...plan.steps.filter((s) => s.status !== "pending"), ...b.steps.map((s: Omit<S, "id" | "status">, i: number) => ({ ...s, id: `n${i}`, status: "pending" }))];
        return { body: { plan } };
      },
      [`DELETE ${URL}/api/plans/PL-0001`]: () => { log.calls.push("delete"); return { body: { ok: true } }; },
      ...action("approve", () => { plan.status = "running"; plan.steps[0]!.status = "running"; plan.steps[0]!.task = "T-0031"; }),
      ...action("pause", () => { plan.status = "paused"; plan.reason = "Paused by you"; }),
      ...action("resume", () => { plan.status = "running"; plan.reason = undefined; }),
      ...action("retry", () => { plan.status = "running"; plan.reason = undefined; plan.steps[0]!.status = "running"; }),
      ...action("skip", () => { plan.status = "running"; plan.reason = undefined; plan.steps[0]!.status = "skipped"; }),
      ...action("continue", () => { plan.status = "drafting"; }),
      ...action("cancel", () => { plan.status = "cancelled"; }),
    };
    const draft = (...titles: string[]) => {
      plan.status = "review";
      plan.steps = titles.map((title, i) => ({ id: `s${i + 1}`, title, details: `about ${title}`, agent: "lead", checkpoint: false, status: "pending" }));
    };
    return { plan, log, network, draft };
  }
  const desk = (network: unknown) => open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network } as never);

  test("a locally saved plan can be opened without creating a duplicate", async () => {
    const { log, network } = plans();
    const app = await desk({ ...network, [`POST ${URL}/api/plans`]: (r: { body?: string | null }) => ({ status: 503,
      body: { ...network[`POST ${URL}/api/plans`](r).body, saved_locally: true, error: "Plan saved on the main machine; sync is pending." } }) });
    await app.press("label:Plans"); await app.type("id:plan-goal", "Add dark mode"); await app.press("id:plan-create");
    await app.waitFor("Plan saved on the main machine; sync is pending."); await app.press("id:plan-open-saved");
    await app.waitFor("id:plan-page"); expect(log.creates.length).toBe(1);
  });

  test("a plan action saved locally updates its controls and keeps the sync warning across polls", async () => {
    const { plan, log, network, draft } = plans(); draft("One"); plan.status = "running"; log.creates.push({ goal: "Existing" });
    const app = await desk({ ...network, [`POST ${URL}/api/plans/PL-0001/pause`]: () => {
      log.calls.push("pause"); plan.status = "paused";
      return { status: 503, body: { plan, saved_locally: true, error: "Plan paused on the main machine; sync is pending." } };
    } });
    await app.press("label:Plans"); await app.press("id:plan-PL-0001"); await app.waitFor("id:plan-pause");
    await app.press("id:plan-pause"); await app.waitFor("id:plan-resume");
    await app.wait(2200); expect(app.shows("Plan paused on the main machine; sync is pending.")).toBe(true);
    expect(log.calls).toEqual(["pause"]);
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: cancelled plans keep exact child cleanup and confirm its final sync before removal`, async () => {
      const { plan, log, network, draft } = plans(); draft("One"); plan.status = "running"; log.creates.push({});
      const operation_id = "a187d49c-46d7-4e9c-97d9-a3def411fba1", run_id = "a187d49c-46d7-4e9c-97d9-a3def411fba2";
      const saved = plan as typeof plan & { pending_stops?: any }, retries: unknown[] = []; let attempts = 0;
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: {
        ...network,
        [`POST ${URL}/api/plans/PL-0001/cancel`]: () => {
          log.calls.push("cancel"); plan.status = "cancelled";
          saved.pending_stops = { operation_id, requested_at: ts(59), done: false, pending: [{ id: "T-0902", host: "worker", run_id, done: false, error: "Worker is offline" }], unresolved: [] };
          return { status: 503, body: { plan, saved_locally: true, error: "One stop remains" } };
        },
        [`GET ${URL}/api/tasks/get?id=T-0902`]: () => ({ body: { id: "T-0902", title: "Plan cleanup child", agent: "dev", state: "active", host: "worker", run_id, stop_owner: { kind: "plan", id: plan.id }, events: [] } }),
        [`POST ${URL}/api/plans/PL-0001/retry-stops`]: (r: any) => {
          retries.push(JSON.parse(r.body)); saved.pending_stops.pending = [];
          const cleanup = { operation_id, remaining: 0, pending: [], unresolved: [] };
          return ++attempts === 1 ? { status: 503, body: { plan, cleanup, saved_locally: true, error: "Final cleanup sync is unconfirmed" } }
            : { body: { ok: true, id: plan.id, plan, cleanup } };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Plans"); await app.press("id:plan-PL-0001"); await app.waitFor("id:plan-cancel");
      app.onDialog((d) => d.title === "Cancel this plan?" ? "Cancel plan" : "Remove");
      await app.press("id:plan-cancel"); await app.waitFor("id:stop-target-T-0902");
      await expect(app.press("id:plan-remove")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(log.calls.includes("delete")).toBe(false);
      expect(app.shows("id:plan-continue")).toBe(false);
      await app.press("id:stop-target-T-0902"); await app.waitFor("Plan cleanup child");
      await app.press("id:stop-open-owner"); await app.waitFor("id:plan-page"); await app.waitFor("id:stop-retry");
      await app.press("id:stop-retry"); await app.waitFor("Confirm cleanup synchronization");
      await app.press("id:stop-refresh"); await expect(app.press("id:plan-remove")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(log.calls.includes("delete")).toBe(false);
      expect(app.shows("Final cleanup sync is unconfirmed")).toBe(true);
      await app.press("id:stop-retry"); await app.waitUntil(() => !app.shows("id:stop-progress"));
      expect(app.shows("id:plan-error")).toBe(false);
      expect(retries).toEqual([{ operation_id }, { operation_id }]); expect(log.calls).toEqual(["cancel"]);
      await app.press("id:plan-remove"); await app.waitUntil(() => log.calls.includes("delete"));
    });
  }

  test("invalid plan cleanup blocks removal and offers refresh without retrying", async () => {
    const { plan, log, network } = plans(); plan.status = "cancelled"; log.creates.push({});
    (plan as any).pending_stops = { pending: [{ id: "T-0902" }] };
    const app = await desk(network); await app.press("label:Plans"); await app.press("id:plan-PL-0001");
    await app.waitFor("id:stop-data-error"); expect(app.shows("id:stop-retry")).toBe(false);
    await expect(app.press("id:plan-remove")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(log.calls.includes("delete")).toBe(false);
    expect(app.shows("id:stop-refresh")).toBe(true);
  });

  test("plan cleanup rejects wrong or contradictory owner views and confirms the same ticket on retry", async () => {
    const { plan, log, network } = plans(); plan.status = "cancelled"; log.creates.push({});
    const operation_id = "a187d49c-46d7-4e9c-97d9-a3def411fbc1", run_id = "a187d49c-46d7-4e9c-97d9-a3def411fbc2", ticket = "a187d49c-46d7-4e9c-97d9-a3def411fbc3";
    const saved = plan as typeof plan & { pending_stops?: any };
    saved.pending_stops = { operation_id, requested_at: ts(59), done: false, pending: [{ id: "T-0902", host: "worker", run_id, done: false }], unresolved: [] };
    let posts = 0, reads = 0;
    const app = await desk({ ...network,
      [`POST ${URL}/api/plans/PL-0001/retry-stops`]: () => { posts++; return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => {
        const stage = ++reads, cleanup = { operation_id, remaining: 0, pending: [], unresolved: [] };
        if (stage === 1) return { body: { ok: true, id: plan.id, cleanup, plan: { ...plan, id: "PL-9999", goal: "Wrong owner view", pending_stops: { ...saved.pending_stops, pending: [] } } } };
        if (stage === 2) return { body: { ok: true, id: plan.id, cleanup, plan } };
        saved.pending_stops.pending = []; return { body: { ok: true, id: plan.id, plan, cleanup } };
      },
    });
    await app.press("label:Plans"); await app.press("id:plan-PL-0001"); await app.waitFor("id:stop-retry");
    await app.press("id:stop-retry"); await app.waitFor("Couldn't confirm cleanup. Retry to check the same cleanup request.");
    expect(app.shows("Add dark mode")).toBe(true); expect(app.shows("Wrong owner view")).toBe(false);
    await expect(app.press("id:plan-remove")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
    await app.press("id:stop-retry"); await app.waitUntil(() => reads === 2);
    await app.waitFor("Couldn't confirm cleanup. Retry to check the same cleanup request.");
    await expect(app.press("id:plan-remove")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
    await app.press("id:stop-retry"); await app.waitUntil(() => !app.shows("id:stop-progress"));
    expect(posts).toBe(1); expect(reads).toBe(3); expect(app.enabled("id:plan-remove")).toBe(true);
  });

  test("a legacy capability response prevents plan cancellation before any dialog or mutation", async () => {
    const { plan, log, network, draft } = plans(); draft("One"); plan.status = "running"; log.creates.push({});
    let dialogs = 0;
    const app = await desk({ ...network, [`GET ${URL}/api/stops/capabilities`]: { status: 404, body: { error: "not found" } } });
    app.onDialog(() => { dialogs++; return "Cancel plan"; });
    await app.press("label:Plans"); await app.press("id:plan-PL-0001"); await app.waitFor("id:plan-cancel");
    await app.press("id:plan-cancel"); await app.waitFor("Connect or update the main machine to confirm task-family stops.");
    expect(dialogs).toBe(0); expect(log.calls).toEqual([]); expect(plan.status).toBe("running");
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: an excluded plan child remains in review history and removal waits for publication`, async () => {
      const { plan, log, network } = plans(); plan.status = "cancelled"; log.creates.push({});
      const owner = { kind: "plan", id: plan.id }, operation_id = "a187d49c-46d7-4e9c-97d9-a3def411fba7";
      const saved = plan as typeof plan & { pending_stops?: any; stop_reviews?: any[] }, writes: any[] = [];
      saved.pending_stops = { operation_id, requested_at: ts(59), done: false, pending: [], unresolved: [{ id: "T-0902", error: "Legacy child needs a review" }] };
      const preview = { owner, operation_id, target_id: "T-0902", preview_digest: "d".repeat(64), target: { kind: "unresolved", id: "T-0902" }, current: { state: "missing", records: [] }, can_include: false, include_reason: "No current task record is available." };
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: {
        ...network, [`POST ${URL}/api/stops/review`]: { body: preview },
        [`POST ${URL}/api/stops/resolve`]: (r: any) => {
          const body = JSON.parse(r.body); writes.push(body);
          const review = saved.stop_reviews?.[0] ?? { ...body, review_id: body.request_id, at: ts(59), original: preview.target, reviewed: preview.current, request_hash: "e".repeat(64) };
          saved.stop_reviews = [review]; saved.pending_stops = { ...saved.pending_stops, unresolved: [], reviews: [review], excluded: [{ id: "T-0902", review_id: review.review_id, reason: review.reason, at: review.at, reviewed: review.reviewed, stopped: false }] };
          const data = { ok: writes.length > 1, id: plan.id, owner, operation_id, target_id: body.target_id, action: body.action, request_id: body.request_id, review_id: review.review_id, review, plan,
            cleanup: { operation_id, remaining: 0, pending: [], unresolved: [] } };
          return writes.length === 1 ? { status: 503, body: { ...data, saved_locally: true, error: "Review publication is pending" } } : { body: data };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Plans"); await app.press("id:plan-PL-0001"); await app.press("id:stop-review-T-0902");
      await app.type("id:stop-review-reason", "The old child record is no longer part of this plan");
      expect(app.enabled("id:stop-review-include")).toBe(false);
      app.onDialog((d) => d.title?.startsWith("Exclude") ? "Exclude from cleanup" : "Remove");
      await app.press("id:stop-review-exclude"); await app.waitFor("id:stop-review-check"); await app.press("id:stop-review-close");
      expect(app.enabled("id:plan-remove")).toBe(false); expect(app.shows("The local stops have finished. Confirm that the team has received the result.")).toBe(false);
      await app.press("id:stop-review-resume"); await app.press("id:stop-review-check"); await app.waitUntil(() => !app.shows("id:stop-review-dialog"));
      await app.waitFor("Excluded T-0902 from cleanup. The task may continue running."); expect(app.shows("id:stop-progress")).toBe(false);
      expect(writes[1]).toEqual(writes[0]); await app.press("id:plan-remove"); await app.waitUntil(() => log.calls.includes("delete"));
    });
  }

  test("create from a goal, review and edit the steps, approve, and see it run", async () => {
    const { plan, log, network, draft } = plans();
    const app = await desk(network);
    await app.press("label:Plans");
    await app.waitFor("id:plans-page");
    await app.type("id:plan-goal", "Add dark mode");
    await app.press("id:plan-project");
    await app.press("id:plan-project-site");
    await app.press("id:plan-agent");
    await app.press("id:plan-agent-writer");
    await app.press("id:plan-create");
    await app.waitFor("id:plan-page");
    expect(log.creates).toEqual([{ goal: "Add dark mode", project: "site", agent: "writer" }]);
    await app.waitFor("id:plan-drafting");
    expect(app.shows("id:plan-approve")).toBe(false);
    // the poll picks up the drafted steps, ready to edit
    draft("Tokens", "Settings page", "Emails");
    await app.waitFor("id:draft-title-2", { timeout: 6000 });
    expect(app.value("id:draft-details-0")).toBe("about Tokens");
    await app.clear("id:draft-title-0");
    await app.type("id:draft-title-0", "Theme tokens");
    await app.press("id:draft-remove-2");
    await app.press("id:draft-checkpoint-1");
    await app.press("id:draft-agent-1");
    await app.press("id:draft-agent-1-writer");
    await app.press("id:draft-add");
    await app.type("id:draft-title-2", "Docs");
    await app.press("id:plan-approve");
    await app.waitUntil(() => log.calls.includes("approve"));
    expect(log.puts[0]).toEqual({ steps: [
      { title: "Theme tokens", details: "about Tokens", agent: "lead", checkpoint: false },
      { title: "Settings page", details: "about Settings page", agent: "writer", checkpoint: true },
      { title: "Docs", details: "", agent: "lead", checkpoint: false },
    ] });
    await app.waitFor("id:step-task-n0");
    await app.waitUntil(() => !app.shows("id:draft-title-0"));
    expect(app.shows("id:plan-pause")).toBe(true);
    expect(plan.status).toBe("running");
  });

  test("while running: pause, resume, edit what hasn't started, open a step's task", async () => {
    const { plan, log, network, draft } = plans();
    log.creates.push({});
    draft("One", "Two");
    plan.status = "running";
    plan.steps[0]!.status = "running";
    plan.steps[0]!.task = "T-0001";
    const app = await desk(network);
    await app.press("label:Plans");
    await app.press("id:plan-PL-0001");
    await app.waitFor("id:plan-pause");
    expect(app.shows("id:draft-title-0")).toBe(false);
    await app.press("id:plan-pause");
    await app.waitFor("id:plan-resume");
    await app.waitFor("id:plan-reason");
    await app.press("id:plan-resume");
    await app.waitFor("id:plan-pause");
    await app.press("id:plan-edit");
    await app.waitFor("id:draft-title-0");
    expect(app.value("id:draft-title-0")).toBe("Two");
    await app.clear("id:draft-title-0");
    await app.type("id:draft-title-0", "Two, better");
    await app.press("id:plan-edit-save");
    await app.waitUntil(() => log.puts.length === 1);
    expect(log.puts[0]).toEqual({ steps: [{ title: "Two, better", details: "about Two", agent: "lead", checkpoint: false }] });
    await app.press("id:step-task-s1");
    await app.waitFor("Task T-0001");
  });

  test("a stopped step says why and offers retry or skip; refusals show", async () => {
    const { plan, log, network, draft } = plans();
    log.creates.push({});
    draft("One", "Two");
    plan.status = "paused";
    plan.reason = "tests are red";
    plan.steps[0]!.status = "stopped";
    const app = await desk(network);
    await app.press("label:Plans");
    await app.press("id:plan-PL-0001");
    await app.waitFor("tests are red");
    expect(app.shows("id:plan-resume")).toBe(false);
    log.refuse = true;
    await app.press("id:plan-retry");
    await app.waitFor("Plan PL-0001 is busy");
    log.refuse = false;
    await app.press("id:plan-skip");
    await app.waitUntil(() => log.calls.includes("skip"));
    await app.waitFor("id:plan-pause");
  });

  test("continue with instructions; cancel and remove ask first", async () => {
    const { plan, log, network, draft } = plans();
    log.creates.push({});
    draft("One");
    plan.status = "done";
    plan.steps[0]!.status = "done";
    const app = await desk(network);
    await app.press("label:Plans");
    await app.press("id:plan-PL-0001");
    await app.press("id:plan-continue");
    await app.type("id:plan-instructions", "Also mobile");
    await app.press("id:plan-continue-send");
    await app.waitUntil(() => plan.notes.length === 1);
    expect(plan.notes).toEqual(["Also mobile"]);
    await app.waitFor("id:plan-drafting");
    app.onDialog((d) => (d.title === "Cancel this plan?" ? "Keep it" : null));
    await app.press("id:plan-cancel");
    expect(log.calls.includes("cancel")).toBe(false);
    app.onDialog((d) => (d.title === "Cancel this plan?" ? "Cancel plan" : null));
    await app.press("id:plan-cancel");
    await app.waitUntil(() => log.calls.includes("cancel"));
    await app.waitFor("id:plan-remove");
    app.onDialog((d) => (d.title === "Remove this plan?" ? "Remove" : null));
    await app.press("id:plan-remove");
    await app.waitUntil(() => log.calls.includes("delete"));
    await app.waitFor("id:plans-page");
  });

  test("open plans show in the sidebar and their id links from chat; an old hub says it can't", async () => {
    const { log, network, draft } = plans();
    log.creates.push({});
    draft("One");
    const app = await desk({ ...network, ...hub([], [{ id: "e9", ts: new Date().toISOString(), from: "hub", kind: "notice", text: "Plan PL-0001 is ready for your review" }]), [`GET ${URL}/api/status`]: network[`GET ${URL}/api/status`] });
    await app.waitFor("id:plan-chip-PL-0001");
    await app.press("id:plan-chip-PL-0001");
    await app.waitFor("id:plan-page");
    const old = await desk({ ...hub([]), [`GET ${URL}/api/settings`]: { status: 500 }, [`GET ${URL}/api/plans`]: { status: 404, body: { error: "not found" } } });
    await old.press("label:Plans");
    await old.waitFor("Update the hub and main machine to manage plans");
  });

  test("a phone reaches plans from the sidebar", async () => {
    const { log, network, draft } = plans();
    log.creates.push({});
    draft("One");
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network } as never);
    await app.waitFor("id:composer");
    await app.press("label:Menu");
    await app.press("label:Plans");
    await app.waitFor("id:plans-page");
    await app.press("id:plan-PL-0001");
    await app.waitFor("id:draft-title-0");
    await app.press("id:plan-approve");
    await app.waitUntil(() => log.calls.includes("approve"));
    await app.waitFor("id:plan-pause");
    await app.back();
    await app.waitFor("id:plans-page");
  });
});

describe("routines", () => {
  function routines() {
    const list = [{ name: "daily-report", desc: "Daily", every: "daily 18:00", agent: "lead", enabled: true }] as { name: string; desc?: string; every: string; agent: string; enabled: boolean; kind?: string }[];
    const full: Record<string, Record<string, unknown>> = { "daily-report": { name: "daily-report", every: "daily 18:00", agent: "lead", project: "", prompt: "Write the report.", desc: "Daily", enabled: true, readonly: false, kind: "" }, learner: { name: "learner", every: "daily 04:00", agent: "", project: "", prompt: "", desc: "", enabled: false, readonly: false, kind: "learn" } };
    const view = () => ({ current: {}, effective: { agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "onboarding" }, { id: "writer", title: "Writer", clis: ["claude"], autonomy: "onboarding" }], projects: [{ id: "site", name: "Site", path: "/code/site", host: "mac", repo: "", instructions: "", exists: true }], autonomy: "onboarding", routines: list, max_parallel: null, media_days: 7 }, options: { clis: [["claude"]], autonomy: ["onboarding"] } });
    const log: { creates: Record<string, unknown>[]; edits: Record<string, unknown>[]; deletes: string[] } = { creates: [], edits: [], deletes: [] };
    const network = {
      ...hub([]),
      [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`POST ${URL}/api/routines`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        if (b.every === "soon") return { status: 400, body: { error: "Use a schedule like 30m" } };
        log.creates.push(b);
        list.push({ name: b.name, every: b.every, agent: b.agent, enabled: b.enabled });
        full[b.name] = b;
        return { body: { id: b.name, view: view() } };
      },
      [`GET ${URL}/api/routines/daily-report`]: () => ({ body: full["daily-report"] }),
      [`GET ${URL}/api/routines/weekly-deps`]: () => ({ body: full["weekly-deps"] }),
      [`GET ${URL}/api/routines/learner`]: () => ({ body: full.learner }),
      [`GET ${URL}/api/routines/*`]: (r: { url: string }) => { const value = full[r.url.split("/").pop()!]; return { status: value ? 200 : 404, body: value ?? { error: "not found" } }; },
      [`PUT ${URL}/api/routines/daily-report`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        log.edits.push(b);
        Object.assign(list[0]!, { every: b.every, enabled: b.enabled, desc: b.desc });
        return { body: { id: "daily-report", view: view() } };
      },
      [`PUT ${URL}/api/routines/*`]: (r: { url: string; body?: string | null }) => {
        const name = r.url.split("/").pop()!, body = JSON.parse(r.body!);
        log.edits.push(body);
        Object.assign(list.find((x) => x.name === name)!, body);
        full[body.name] = body;
        return { body: { id: body.name, view: view() } };
      },
      [`DELETE ${URL}/api/routines/weekly-deps`]: () => {
        log.deletes.push("weekly-deps");
        list.splice(list.findIndex((x) => x.name === "weekly-deps"), 1);
        return { body: { id: "weekly-deps", view: view() } };
      },
    };
    return { log, network, list };
  }

  test("retry after a remote confirmation server error checks the same request", async () => {
    const { network, log } = routines();
    const ticket = "abcdefab-1234-1234-1234-123456789abc";
    let polls = 0, submissions = 0, body = "";
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...network,
      [`POST ${URL}/api/routines`]: (r: { body?: string | null }) => { submissions++; body = r.body!; return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => ++polls === 1
        ? { status: 503, body: { error: "temporary server error" } }
        : network[`POST ${URL}/api/routines`]({ body }),
    } });
    await app.press("id:settings");
    await app.press("id:settings-tab-routines");
    await app.press("id:routine-new");
    await app.type("id:routine-name", "retry-check");
    await app.type("id:routine-prompt", "Review");
    await app.press("id:routine-save");
    await app.waitFor("Connection lost while confirming. Try saving again to check the same request.");
    await app.press("id:routine-save");
    await app.waitFor("id:routine-retry-check");
    expect(submissions).toBe(1);
    expect(log.creates.length).toBe(1);
  });

  test("remote forms wait for confirmation and keep validation errors editable", async () => {
    const { network, log } = routines();
    const ticket = "12345678-1234-1234-1234-123456789abc";
    let polls = 0, submissions = 0;
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...network,
      [`POST ${URL}/api/routines`]: () => { submissions++; return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => {
        polls++;
        if (polls === 1) return { status: 202, body: { ticket } };
        if (submissions === 1) return { status: 400, body: { error: "Choose a valid remote schedule" } };
        return network[`POST ${URL}/api/routines`]({ body: JSON.stringify({ name: "remote-check", every: "hourly", agent: "lead", prompt: "Check the project." }) });
      },
    } });
    await app.press("id:settings");
    await app.press("id:settings-tab-routines");
    await app.press("id:routine-new");
    await app.type("id:routine-name", "remote-check");
    await app.type("id:routine-prompt", "Check the project.");
    await app.press("id:routine-save");
    await app.waitUntil(() => polls === 1);
    expect(app.shows("id:routine-editor")).toBe(true);
    expect(log.creates.length).toBe(0);
    await app.waitFor("Choose a valid remote schedule");
    expect(app.value("id:routine-name")).toBe("remote-check");
    expect(app.value("id:routine-prompt")).toBe("Check the project.");
    await app.press("id:routine-save");
    await app.waitFor("id:routine-remote-check");
    await app.waitUntil(() => !app.shows("id:routine-editor"));
    expect(submissions).toBe(2);
    expect(log.creates.length).toBe(1);
  });

  test("advanced routine fields preserve resource, scheduling and detector settings", async () => {
    const { network, log } = routines();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings");
    await app.press("id:settings-tab-routines");
    await app.press("id:routine-new");
    await app.type("id:routine-name", "advanced-check");
    await app.type("id:routine-prompt", "Check the build.");
    await app.press("id:routine-advanced");
    await app.type("id:routine-prefer", "gpu");
    await app.type("id:routine-repo", "~/work/app");
    await app.type("id:routine-signal", "printf stable");
    await app.press("id:routine-weight");
    await app.press("id:routine-weight-heavy");
    await app.press("id:routine-scheduler");
    await app.press("id:routine-scheduler-each");
    await app.press("id:routine-save");
    await app.waitFor("id:routine-advanced-check");
    expect(log.creates[0]).toMatchObject({ prefer: "gpu", repo: "~/work/app", signal: "printf stable", weight: "heavy", scheduler: "each" });
    await app.press("id:routine-edit-advanced-check");
    await app.waitFor("id:routine-editor");
    // The advanced section may stay open between edits; save must round-trip it either way.
    await app.press("id:routine-save");
    await app.waitUntil(() => log.edits.length === 1);
    expect(log.edits[0]).toMatchObject({ prefer: "gpu", repo: "~/work/app", signal: "printf stable", weight: "heavy", scheduler: "each" });
  });

  test("settings creates, edits and deletes a routine", async () => {
    const { log, network } = routines();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings");
    await app.press("id:settings-tab-routines");
    await app.waitFor("id:routine-new");
    // create: the server's refusal keeps the dialog open
    await app.press("id:routine-new");
    await app.waitFor("id:routine-editor");
    await app.type("id:routine-name", "Weekly Deps");
    await app.clear("id:routine-every");
    await app.type("id:routine-every", "soon");
    await app.type("id:routine-prompt", "Check dependencies.");
    await app.press("id:routine-agent");
    await app.press("id:routine-agent-writer");
    await app.press("id:routine-project");
    await app.press("id:routine-project-site");
    await app.press("id:routine-save");
    await app.waitFor("Use a schedule like 30m");
    expect(app.shows("id:routine-editor")).toBe(true);
    await app.clear("id:routine-every");
    await app.type("id:routine-every", "weekly MON 09:00");
    await app.press("id:routine-readonly");
    await app.press("id:routine-os");
    await app.press("id:routine-os-macos");
    await app.press("id:routine-save");
    await app.waitFor("id:routine-weekly-deps");
    await app.waitUntil(() => !app.shows("id:routine-editor"));
    expect(log.creates).toEqual([{ name: "weekly-deps", every: "weekly MON 09:00", agent: "writer", project: "site", prompt: "Check dependencies.", desc: "", enabled: true, readonly: true, requires: "os:macos", host: "any", cli: "auto", priority: "normal", prefer: "", weight: "normal", repo: "", scheduler: "primary", signal: "" }]);
    // edit opens with what's saved, including the prompt
    await app.press("id:routine-edit-daily-report");
    await app.waitFor("id:routine-editor");
    expect(app.value("id:routine-prompt")).toBe("Write the report.");
    expect(app.value("id:routine-every")).toBe("daily 18:00");
    await app.press("id:routine-enabled");
    await app.press("id:routine-save");
    await app.waitUntil(() => log.edits.length === 1);
    expect(log.edits[0]).toMatchObject({ name: "daily-report", enabled: false, prompt: "Write the report." });
    // delete asks first
    await app.press("id:routine-edit-weekly-deps");
    await app.waitFor("id:routine-delete");
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Cancel" : null));
    await app.press("id:routine-delete");
    expect(log.deletes.length).toBe(0);
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Delete" : null));
    await app.press("id:routine-delete");
    await app.waitUntil(() => log.deletes.length === 1);
    await app.waitUntil(() => !app.shows("id:routine-weekly-deps"));
  });

  test("a learn routine hides what doesn't apply and can still be saved", async () => {
    const { log, network, list } = routines();
    list[0] = { name: "learner", every: "daily 04:00", agent: "", enabled: false, kind: "learn" };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...network, [`PUT ${URL}/api/routines/learner`]: (r: { body?: string | null }) => { log.edits.push(JSON.parse(r.body!)); return { body: { id: "learner", view: { current: {}, effective: { agents: [], routines: list, autonomy: "onboarding", max_parallel: null, media_days: 7 }, options: { clis: [], autonomy: [] } } } }; } } });
    await app.press("id:settings");
    await app.press("id:settings-tab-routines");
    await app.press("id:routine-edit-learner");
    await app.waitFor("id:routine-editor");
    expect(app.shows("id:routine-prompt")).toBe(false);
    expect(app.shows("id:routine-readonly")).toBe(false);
    await app.press("id:routine-save");
    await app.waitUntil(() => log.edits.length === 1);
  });

  test("a phone creates a routine and edits one from its page; an old hub says it can't", async () => {
    const { log, network } = routines();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network });
    await app.waitFor("id:composer");
    await app.press("id:settings-top");
    await app.waitFor("id:routine-new");
    await app.press("id:routine-new");
    await app.waitFor("id:routine-editor");
    await app.type("id:routine-name", "weekly-deps");
    await app.type("id:routine-prompt", "Check.");
    await app.press("id:routine-save");
    await app.waitUntil(() => log.creates.length === 1);
    await app.waitFor("id:routine-row-weekly-deps");
    await app.press("id:routine-row-weekly-deps");
    await app.waitFor("id:routine-edit-weekly-deps");
    await app.press("id:routine-edit-weekly-deps");
    await app.waitFor("id:routine-delete");
    app.onDialog((d) => (d.title?.startsWith("Delete") ? "Delete" : null));
    await app.press("id:routine-delete");
    await app.waitUntil(() => log.deletes.length === 1);
    await app.waitUntil(() => !app.shows("id:phone-routine"));
    const old = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...network, [`POST ${URL}/api/routines`]: { status: 404, body: { error: "not found" } } } });
    await old.press("id:settings");
    await old.press("id:settings-tab-routines");
    await old.press("id:routine-new");
    await old.type("id:routine-name", "x");
    await old.type("id:routine-prompt", "y");
    await old.press("id:routine-save");
    await old.waitFor("Update the hub and main machine to edit routines");
  });
});


describe("disabled provider annotations", () => {
  const warning = "Hermes is disabled for execution. Choose another tool or enable it in Settings → AI tools & onboarding.";
  const selected = { name: "hermes-check", every: "hourly", agent: "lead", enabled: true, cli: "hermes", host: "any", prompt: "Review the project.", requires: "", project: "", readonly: false };
  const settings = () => ({ current: {}, effective: { enabled_clis: ["claude"], agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "onboarding" }], projects: [], routines: [selected], autonomy: "onboarding", max_parallel: null, media_days: 7 }, options: { clis: [["claude"]], autonomy: ["onboarding"] } });
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: disabled Hermes task stays selected and points to onboarding settings`, async () => {
      const task = { id: "T-0949", title: "Disabled Hermes task", agent: "lead", state: "inbox", configured_cli: "hermes", created: ts(40) }, writes: any[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: {
        ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, active: [], recent: [task], hosts: [{ ...status.hosts[0], caps: [...status.hosts[0].caps, "cli:hermes"] }] } },
        [`GET ${URL}/api/settings`]: { body: settings() }, [`GET ${URL}/api/tasks/get?id=${task.id}`]: { body: { ...task, events: [] } },
        [`POST ${URL}/api/tasks/configure`]: (r: any) => { writes.push(JSON.parse(r.body)); return { body: { ok: true, data: { ok: true, id: task.id } } }; },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:T-0949 · Queued"); await app.press("id:task-edit-run"); await app.waitFor(warning);
      expect(app.shows("Matching machines: linux-box")).toBe(false); expect(app.shows("label:CLI: hermes")).toBe(true);
      await app.press("id:task-cli"); await app.waitFor("Disabled in AI tools & onboarding"); await app.keyboard.press("escape");
      await app.press("id:task-placement-save"); await app.waitUntil(() => writes.length === 1);
      expect(writes[0].cli).toBe("hermes"); expect(app.shows(warning)).toBe(true);
    });

    test(`${platform}: disabled Hermes routine stays selected and points to onboarding settings`, async () => {
      const writes: any[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: {
        ...hub([]), [`GET ${URL}/api/settings`]: { body: settings() }, [`GET ${URL}/api/routines/hermes-check`]: { body: selected },
        [`PUT ${URL}/api/routines/hermes-check`]: (r: any) => { writes.push(JSON.parse(r.body)); return { body: { id: selected.name, view: settings() } }; },
      } });
      await app.waitFor("id:composer"); await app.press(platform === "ios" ? "id:settings-top" : "id:settings");
      if (platform === "ios") { await app.waitFor("id:routine-row-hermes-check"); await app.press("id:routine-row-hermes-check"); }
      else await app.press("id:settings-tab-routines");
      await app.press("id:routine-edit-hermes-check"); await app.waitFor(warning);
      expect(app.shows("label:CLI: hermes")).toBe(true);
      await app.press("id:routine-cli"); await app.waitFor("Disabled in AI tools & onboarding"); await app.keyboard.press("escape");
      await app.press("id:routine-save"); await app.waitUntil(() => writes.length === 1);
      expect(writes[0]).toMatchObject({ name: "hermes-check", cli: "hermes" });
    });
  }
});

describe("operational configuration", () => {
  const defaults = () => Object.fromEntries(CONFIGURATION_FIELDS.map((f) => [f.path, Array.isArray(f.default) ? [...f.default] : f.default]));
  const settings = { current: {}, effective: { agents: [], routines: [], autonomy: "onboarding", max_parallel: null }, options: { clis: [["claude"]], autonomy: ["onboarding"] } };
  function server(file: Record<string, ConfigValue> = {}) {
    const base = { ...defaults(), ...file }, values = { ...base }, overrides = new Set<string>(), puts: any[] = [];
    const view = () => ({ values: { ...values }, overrides: [...overrides] });
    const network = {
      ...hub([]), [`GET ${URL}/api/settings`]: { body: settings },
      [`GET ${URL}/api/configuration`]: () => ({ body: view() }),
      [`PUT ${URL}/api/configuration`]: (r: { body?: string | null }) => {
        const body = JSON.parse(r.body!); puts.push(body);
        if (body.values?.["clis.timeout_minutes"] === 0) return { status: 400, body: { error: "Run limit must be at least 1" } };
        if (body.values?.["cloud.poll_seconds"] === 0) return { status: 400, body: { error: "Hub polling interval must be at least 1 second" } };
        for (const [key, value] of Object.entries(body.values ?? {})) { values[key] = value as any; overrides.add(key); }
        for (const key of body.reset ?? []) { values[key] = base[key]; overrides.delete(key); }
        return { body: view() };
      },
    };
    return { values, puts, view, network };
  }

  for (const platform of ["macos", "ios"] as const) {
    async function execution(f: ReturnType<typeof server>, extra: Record<string, any> = {}) {
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: { ...f.network, ...extra } });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-configuration"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-configuration"); }
      await app.waitFor("id:configuration-clis-timeout_minutes");
      return app;
    }

    test(`${platform}: Claude task tool permissions save dontAsk as the only changed setting`, async () => {
      const f = server(), app = await execution(f);
      expect(app.shows("label:Claude task tool permissions: Allow without prompts")).toBe(true);
      expect(app.shows("text:/Applies to new standard Claude task runs/")).toBe(true);
      expect(app.shows("text:/A Noop approval does not change this policy/")).toBe(true);
      expect(app.shows("text:/Custom commands, chat, judges and automatic repair use their own permissions/")).toBe(true);
      await app.press("id:configuration-clis-claude-permission_mode");
      await app.press("id:configuration-clis-claude-permission_mode-dontAsk");
      expect(app.shows("label:Claude task tool permissions: Deny unapproved tools")).toBe(true);
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts).toEqual([{ values: { "clis.claude.permission_mode": "dontAsk" } }]);
      expect(f.values["clis.claude.permission_mode"]).toBe("dontAsk");
    });

    test(`${platform}: Claude permission confirmation preserves later drafts and reset restores the file mode`, async () => {
      const f = server({ "clis.claude.permission_mode": "acceptEdits" }), ticket = "12345678-1234-1234-1234-123456789aab";
      let pending = true, polls = 0;
      const app = await execution(f, {
        [`PUT ${URL}/api/configuration`]: (r: { body?: string | null }) => {
          const result = f.network[`PUT ${URL}/api/configuration`](r);
          if (!pending) return result;
          pending = false; return { status: 202, body: { ticket } };
        },
        [`GET ${URL}/api/ui-requests/${ticket}`]: () => ++polls === 1 ? { status: 202, body: { ticket } } : { body: f.view() },
      });
      await app.press("id:configuration-clis-claude-permission_mode"); await app.press("id:configuration-clis-claude-permission_mode-dontAsk");
      await app.press("id:configuration-save"); await app.waitUntil(() => polls === 1);
      await app.type("id:configuration-clis-codex-model", "not-yet-saved");
      await app.waitFor("Submitted changes saved. You have additional unsaved edits.");
      expect(app.value("id:configuration-clis-codex-model")).toBe("not-yet-saved");
      expect(f.puts[0]).toEqual({ values: { "clis.claude.permission_mode": "dontAsk" } });
      await app.press("id:configuration-group"); await app.press("id:configuration-group-resources");
      await app.clear("id:configuration-resources-mem_min_pct"); await app.type("id:configuration-resources-mem_min_pct", "27");
      await app.press("id:configuration-group"); await app.press("id:configuration-group-execution");
      await app.press("id:configuration-reset"); await app.waitFor("Submitted changes saved. You have additional unsaved edits.");
      expect(app.shows("label:Claude task tool permissions: acceptEdits")).toBe(true);
      expect(f.values["clis.claude.permission_mode"]).toBe("acceptEdits");
      expect(app.value("id:configuration-clis-codex-model")).toBe("");
      expect(f.puts[1].reset).toContain("clis.claude.permission_mode");
      expect(f.puts[1].reset.every((path: string) => CONFIGURATION_FIELDS.find((field) => field.path === path)?.group === "execution")).toBe(true);
      await app.press("id:configuration-group"); await app.press("id:configuration-group-resources");
      expect(app.value("id:configuration-resources-mem_min_pct")).toBe("27");
      expect(f.values["resources.mem_min_pct"]).toBe(10);
      expect(app.shows("1 unsaved changes")).toBe(true);
    });

    test(`${platform}: unrelated execution saves preserve a visible legacy Claude permission mode`, async () => {
      const f = server({ "clis.claude.permission_mode": "acceptEdits" }), app = await execution(f);
      expect(app.shows("label:Claude task tool permissions: acceptEdits")).toBe(true);
      expect(app.enabled("id:configuration-save")).toBe(false);
      await app.type("id:configuration-clis-claude-model", "chosen-task-model");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts).toEqual([{ values: { "clis.claude.model": "chosen-task-model" } }]);
      expect(f.values["clis.claude.permission_mode"]).toBe("acceptEdits");
      expect(app.shows("label:Claude task tool permissions: acceptEdits")).toBe(true);
    });

    test(`${platform}: a prototype-named legacy Claude permission remains raw on unrelated save`, async () => {
      const f = server({ "clis.claude.permission_mode": "constructor" }), app = await execution(f);
      expect(app.shows("label:Claude task tool permissions: constructor")).toBe(true);
      expect(app.enabled("id:configuration-save")).toBe(false);
      await app.clear("id:configuration-clis-timeout_minutes"); await app.type("id:configuration-clis-timeout_minutes", "45");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts).toEqual([{ values: { "clis.timeout_minutes": 45 } }]);
      expect(f.values["clis.claude.permission_mode"]).toBe("constructor");
      expect(app.shows("label:Claude task tool permissions: constructor")).toBe(true);
    });

    test(`${platform}: older hubs cannot edit or reset an unreported Claude permission field`, async () => {
      const f = server(); delete f.values["clis.claude.permission_mode"];
      const app = await execution(f);
      await app.waitFor("id:configuration-unsupported");
      expect(app.shows("text:/Update the hub and main machine to configure: Claude task tool permissions/")).toBe(true);
      expect(app.shows("id:configuration-clis-claude-permission_mode")).toBe(false);
      expect(app.enabled("id:configuration-save")).toBe(false);
      await app.type("id:configuration-clis-claude-model", "supported-model");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts[0]).toEqual({ values: { "clis.claude.model": "supported-model" } });
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved");
      expect(f.puts[1].reset).not.toContain("clis.claude.permission_mode");
      expect(Object.prototype.hasOwnProperty.call(f.values, "clis.claude.permission_mode")).toBe(false);
      expect(app.shows("id:configuration-clis-claude-permission_mode")).toBe(false);
    });
  }

  test("desktop configuration validates, saves only edits and resets one section", async () => {
    const { network, puts } = server();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings");
    await app.press("id:settings-tab-configuration");
    await app.waitFor("id:configuration-clis-timeout_minutes");
    await app.clear("id:configuration-clis-timeout_minutes");
    await app.type("id:configuration-clis-timeout_minutes", "0");
    await app.press("id:configuration-save");
    await app.waitFor("Run limit must be at least 1");
    expect(app.value("id:configuration-clis-timeout_minutes")).toBe("0");
    await app.clear("id:configuration-clis-timeout_minutes");
    await app.type("id:configuration-clis-timeout_minutes", "45");
    await app.type("id:configuration-clis-claude-model", "chosen-model");
    await app.press("id:configuration-save");
    await app.waitFor("text:/Saved. Settings apply/");
    expect(puts[1]).toEqual({ values: { "clis.timeout_minutes": 45, "clis.claude.model": "chosen-model" } });
    await app.press("id:configuration-group");
    await app.press("id:configuration-group-resources");
    await app.press("id:configuration-resources-cleanup_enabled");
    await app.clear("id:configuration-resources-mem_min_pct");
    await app.type("id:configuration-resources-mem_min_pct", "25");
    await app.press("id:configuration-save");
    await app.waitFor("text:/Saved. Settings apply/");
    expect(puts[2]).toEqual({ values: { "resources.mem_min_pct": 25, "resources.cleanup_enabled": false } });
    await app.press("id:configuration-reset");
    await app.waitFor("All changes saved");
    expect(app.value("id:configuration-resources-mem_min_pct")).toBe("10");
    await app.press("id:configuration-group");
    await app.press("id:configuration-group-execution");
    expect(app.value("id:configuration-clis-timeout_minutes")).toBe("45");
    expect(app.value("id:configuration-clis-claude-model")).toBe("chosen-model");
  });


  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: quota reserve, failure reports and polling interval save and reset independently`, async () => {
      const f = server(), app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: f.network });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-configuration"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-configuration"); }
      await app.waitFor("id:configuration-group"); await app.press("id:configuration-group"); await app.press("id:configuration-group-fleet");
      expect(app.value("id:configuration-github-min_remaining")).toBe("1000"); expect(app.value("id:configuration-cloud-poll_seconds")).toBe("3");
      await app.clear("id:configuration-github-min_remaining"); await app.type("id:configuration-github-min_remaining", "1500");
      await app.clear("id:configuration-cloud-poll_seconds"); await app.type("id:configuration-cloud-poll_seconds", "0"); await app.press("id:configuration-save"); await app.waitFor("Hub polling interval must be at least 1 second");
      expect(app.value("id:configuration-github-min_remaining")).toBe("1500"); await app.clear("id:configuration-cloud-poll_seconds"); await app.type("id:configuration-cloud-poll_seconds", "60");
      await app.press("id:configuration-group"); await app.press("id:configuration-group-automation"); await app.press("id:configuration-notify-on_failure"); await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts[1]).toEqual({ values: { "github.min_remaining": 1500, "cloud.poll_seconds": 60, "notify.on_failure": false } });
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved"); expect(f.values["notify.on_failure"]).toBe(true); expect(f.values["github.min_remaining"]).toBe(1500);
      await app.press("id:configuration-group"); await app.press("id:configuration-group-fleet"); expect(app.value("id:configuration-cloud-poll_seconds")).toBe("60");
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved"); expect(app.value("id:configuration-github-min_remaining")).toBe("1000"); expect(app.value("id:configuration-cloud-poll_seconds")).toBe("3");
    });
  }

  test("configuration keeps edits made while a remote save is being confirmed", async () => {
    const s = server(), ticket = "12345678-1234-1234-1234-123456789aaa";
    let polls = 0, first: any;
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...s.network,
      [`PUT ${URL}/api/configuration`]: (r: { body?: string | null }) => { first = JSON.parse(r.body!); return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => ++polls === 1 ? { status: 202, body: { ticket } } : { body: { values: { ...s.values, ...first.values }, overrides: Object.keys(first.values) } },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-configuration");
    await app.waitFor("id:configuration-clis-timeout_minutes");
    await app.clear("id:configuration-clis-timeout_minutes"); await app.type("id:configuration-clis-timeout_minutes", "45");
    await app.press("id:configuration-save");
    await app.waitUntil(() => polls === 1);
    await app.type("id:configuration-clis-codex-model", "later-model");
    await app.waitFor("Submitted changes saved. You have additional unsaved edits.");
    expect(app.value("id:configuration-clis-codex-model")).toBe("later-model");
    expect(app.shows("1 unsaved changes")).toBe(true);
    expect(first).toEqual({ values: { "clis.timeout_minutes": 45 } });
  });

  test("phone configuration reaches background controls and switches judge providers", async () => {
    const { network, puts } = server();
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: 390, height: 844, platform: "ios", network });
    await app.press("id:settings-top"); await app.press("id:settings-configuration");
    await app.waitFor("id:configuration-page");
    await app.press("id:configuration-judge-cli"); await app.press("id:configuration-judge-cli-codex");
    await app.waitFor("id:configuration-judge-codex_model");
    expect(app.shows("id:configuration-judge-model")).toBe(false);
    await app.type("id:configuration-judge-codex_model", "judge-model");
    await app.press("id:configuration-group"); await app.press("id:configuration-group-automation");
    await app.press("id:configuration-update-enabled");
    await app.press("id:configuration-save");
    await app.waitFor("text:/Saved. Settings apply/");
    expect(puts[0]).toEqual({ values: { "judge.cli": "codex", "judge.codex_model": "judge-model", "update.enabled": false } });
    await app.back(); await app.waitFor("id:phone-settings");
  });

  test("desktop approval settings save team autonomy, follow-up approval and batching", async () => {
    const { network, puts } = server();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network });
    await app.press("id:settings"); await app.press("id:settings-tab-configuration");
    await app.waitFor("id:configuration-group"); await app.press("id:configuration-group"); await app.press("id:configuration-group-approvals");
    await app.press("id:configuration-autonomy-level"); await app.press("id:configuration-autonomy-level-assisted");
    await app.press("id:configuration-autonomy-assisted_approve_followups");
    await app.clear("id:configuration-autonomy-batch_minutes"); await app.type("id:configuration-autonomy-batch_minutes", "0");
    await app.clear("id:configuration-autonomy-renotify_hours"); await app.type("id:configuration-autonomy-renotify_hours", "0.5");
    await app.type("id:configuration-autonomy-auto_routines", "pr-review\nfocus-check");
    await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
    expect(puts[0]).toEqual({ values: { "autonomy.level": "assisted", "autonomy.assisted_approve_followups": true, "autonomy.batch_minutes": 0, "autonomy.renotify_hours": 0.5, "autonomy.auto_routines": ["pr-review", "focus-check"] } });
    await app.press("id:configuration-reset"); await app.waitFor("All changes saved");
    expect(app.value("id:configuration-autonomy-batch_minutes")).toBe("15");
    expect(app.value("id:configuration-autonomy-auto_routines")).toBe("");
  });


  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: owner attribution and Claude blocks are configurable from the UI`, async () => {
      const { network, puts } = server();
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-configuration"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-configuration"); }
      await app.waitFor("id:configuration-group"); await app.press("id:configuration-group"); await app.press("id:configuration-group-owner");
      await app.clear("id:configuration-owner-name"); await app.type("id:configuration-owner-name", "Jamie Example");
      await app.clear("id:configuration-owner-github"); await app.type("id:configuration-owner-github", "jamie-example");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(puts[0]).toEqual({ values: { "owner.name": "Jamie Example", "owner.github": "jamie-example" } });
      await app.press("id:configuration-group"); await app.press("id:configuration-group-gates");
      await app.press("id:configuration-gates-github_rest");
      await app.type("id:configuration-gates-extra", "Bash(kubectl delete:*)\nEdit(./.env)");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(puts[1]).toEqual({ values: { "gates.github_rest": false, "gates.extra": ["Bash(kubectl delete:*)", "Edit(./.env)"] } });
      await app.press("id:configuration-reset"); await app.waitFor("All changes saved");
      expect(app.value("id:configuration-gates-extra")).toBe("");
      await app.press("id:configuration-group"); await app.press("id:configuration-group-owner");
      expect(app.value("id:configuration-owner-name")).toBe("Jamie Example");
    });
  }


  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: onboarding adds the apprentice and refreshes learning readiness`, async () => {
      const fixture = server(); let installed = false;
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...fixture.network,
        [`GET ${URL}/api/configuration`]: () => ({ body: { ...fixture.view(), learning: { host: "mac", blocked_reason: installed ? null : "Learning needs an apprentice member." } } }),
        [`GET ${URL}/api/machines/mac/learning`]: () => ({ body: { host: "mac", learning_api: 1, sources: ["claude"], blocked_reason: installed ? null : "Learning needs an apprentice member." } }),
        [`GET ${URL}/api/roles`]: () => ({ body: { roles: [{ id: "apprentice", about: "Apprentice", installed }] } }),
        [`GET ${URL}/api/roles/apprentice`]: () => ({ body: { id: "apprentice", about: "Apprentice", installed, profile: "# Apprentice\nLearn durable preferences.", routines: [{ name: "learn-owner", every: "daily 09:00", enabled: false }] } }),
        [`POST ${URL}/api/roles/apprentice`]: () => { installed = true; return { body: { id: "apprentice", routines: ["learn-owner"], view: settings } }; },
      } });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-onboarding"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-onboarding"); }
      await app.waitFor("id:learning-run"); expect(app.enabled("id:learning-run")).toBe(false);
      await app.press("id:role-library-open"); await app.waitFor("id:role-profile"); await app.press("id:role-add");
      await app.waitUntil(() => !app.shows("id:role-library"));
      await app.waitUntil(() => app.enabled("id:learning-preview"));
      expect(app.enabled("id:learning-run")).toBe(false);
      expect(app.shows("id:learning-blocked")).toBe(false); expect(installed).toBe(true);
    });

    test(`${platform}: onboarding starts learning on the main machine and reports confirmation failures`, async () => {
      const fixture = server();
      let calls = 0, fail = false, blocked: string | null = null, previewNumber = 0;
      const previews = new Map<string, { turns: number; sessions: number; truncated: boolean }>();
      const view = () => ({ ...fixture.view(), learning: { host: "mac", blocked_reason: blocked } });
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...fixture.network,
        [`GET ${URL}/api/configuration`]: () => ({ body: view() }),
        [`PUT ${URL}/api/configuration`]: (r: { body?: string | null }) => {
          Object.assign(fixture.values, JSON.parse(r.body!).values);
          return { body: view() };
        },
        [`GET ${URL}/api/machines/mac/learning`]: () => ({ body: { host: "mac", learning_api: 1, sources: ["claude"], blocked_reason: blocked } }),
        [`POST ${URL}/api/machines/mac/learning/preview`]: (r: any) => {
          expect(JSON.parse(r.body)).toEqual({}); const digest = String(++previewNumber).repeat(64), counts = { turns: previewNumber === 2 ? 0 : 3, sessions: previewNumber === 2 ? 0 : 2, truncated: false };
          previews.set(digest, counts); return { body: { host: "mac", preview_digest: digest, sources: ["claude"], ...counts } };
        },
        [`POST ${URL}/api/machines/mac/learning/run`]: (r: { body?: string | null }) => {
          const body = JSON.parse(r.body!); calls++; expect(typeof body.request_id).toBe("string"); expect(previews.has(body.preview_digest)).toBe(true);
          if (fail) return { status: 503, body: { error: "Learning task T-0002 was created on mac, but sync could not be confirmed.", id: "T-0002", host: "mac", request_id: body.request_id, preview_digest: body.preview_digest, saved_locally: true } };
          return { body: { host: "mac", request_id: body.request_id, preview_digest: body.preview_digest, id: calls === 1 ? "T-0001" : null, applied: true, replayed: false, ...previews.get(body.preview_digest) } };
        },
      } });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-onboarding"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-onboarding"); }
      await app.waitFor("id:learning-run");
      await app.press("id:configuration-learn-sources-hermes");
      expect(app.enabled("id:learning-run")).toBe(false);
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      await app.press("id:learning-preview"); await app.press("id:learning-run"); await app.waitFor("Learning task T-0001 queued on mac from 3 owner turns in 2 provider sessions.");
      await app.press("id:learning-preview"); await app.press("id:learning-run"); await app.waitFor("text:/No new selected history on mac/");
      fail = true;
      await app.press("id:learning-preview"); await app.press("id:learning-run"); await app.waitFor("text:/Learning task T-0002 was created on mac, but sync could not be confirmed/");
      blocked = "Learning is paused. Enable an AI tool in Settings.";
      await app.press("id:configuration-reload-saved"); await app.waitFor("id:learning-blocked");
      expect(app.enabled("id:learning-run")).toBe(false);
      expect(calls).toBe(3);
    });

    test(`${platform}: onboarding selects execution tools and learning sources independently`, async () => {
      const fixture = server();
      const health = [{ id: "hermes", label: "Hermes", installed: true, available: false, enabled: false, host: "mac", reason: "Launcher failed; repair the installation" }];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...fixture.network,
        [`GET ${URL}/api/configuration`]: () => ({ body: { values: fixture.values, overrides: [], provider_status: health } }),
      } });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-onboarding"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-onboarding"); }
      await app.waitFor("id:configuration-clis-enabled-hermes");
      await app.waitFor("text:/Launcher failed; repair the installation/");
      await app.press("id:configuration-clis-enabled-claude"); await app.press("id:configuration-clis-enabled-hermes");
      await app.press("id:configuration-learn-sources-codex"); await app.press("id:configuration-learn-sources-hermes");
      await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(fixture.puts[0]).toEqual({ values: { "clis.enabled": ["codex", "hermes"], "learn.sources": ["claude", "noop", "hermes"] } });
      await app.press("id:configuration-learn-enabled"); await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(fixture.puts[1]).toEqual({ values: { "learn.enabled": false } });
    });
  }

});


describe("machine accounts", () => {
  const providers = ["claude", "codex", "hermes"].map((id) => ({ id, label: id, installed: true, available: true, enabled: true }));
  const row = (cli: string, name = "default") => ({ cli, name, default: name === "default", state: "unknown", login: undefined as any });
  const base = `${URL}/api/machines/linux-box/accounts`;
  const accountView = (accounts: ReturnType<typeof row>[]) => ({ host: "linux-box", providers, accounts });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: account setup and authorization stay on the selected machine`, async () => {
      let accounts = [row("claude"), row("codex"), row("hermes")];
      const writes: { method: string; path: string; body?: any }[] = [], posts: { text: string }[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub(posts), [`GET ${base}`]: () => ({ body: accountView(accounts) }),
        [`POST ${base}`]: (r: { body?: string | null }) => { const body = JSON.parse(r.body!); writes.push({ method: "POST", path: base, body }); if (!accounts.some((a) => a.cli === body.cli && a.name === body.name)) accounts.push(row(body.cli, body.name)); return { body: accountView(accounts) }; },
        [`POST ${base}/claude/work/login`]: () => { writes.push({ method: "POST", path: "work/login" }); accounts.find((a) => a.name === "work")!.login = { id: "L-123456789012345678901234567890", url: "https://claude.ai/oauth/authorize?state=fixture", needs_code: true, expires: "2099-01-01T00:00:00Z", status: "waiting" }; return { body: accountView(accounts) }; },
        [`POST ${base}/claude/work/code`]: (r: { body?: string | null }) => { const body = JSON.parse(r.body!); writes.push({ method: "POST", path: "work/code", body }); const a = accounts.find((a) => a.name === "work")!; a.state = "ok"; a.login = { ...a.login, url: undefined, status: "complete" }; return { body: accountView(accounts) }; },
        [`DELETE ${base}/claude/work`]: () => { writes.push({ method: "DELETE", path: "work" }); accounts = accounts.filter((a) => a.name !== "work"); return { body: accountView(accounts) }; },
        [`DELETE ${base}/claude/default`]: () => { writes.push({ method: "DELETE", path: "default" }); accounts = accounts.filter((a) => a.cli !== "claude"); return { body: accountView(accounts) }; },
        [`POST ${base}/codex/default/login`]: () => { const a = accounts.find((a) => a.cli === "codex")!; a.login = { id: "L-99999999999999999999999999999", url: "https://auth.openai.com/codex/device", user_code: "ABCD-EFGH", needs_code: false, expires: "2099-01-01T00:00:00Z", status: "waiting" }; return { body: accountView(accounts) }; },
        [`POST ${base}/codex/default/cancel`]: (r: { body?: string | null }) => { writes.push({ method: "POST", path: "codex/cancel", body: JSON.parse(r.body!) }); const a = accounts.find((a) => a.cli === "codex")!; a.login = { ...a.login, url: undefined, user_code: undefined, status: "cancelled" }; return { body: accountView(accounts) }; },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open");
      await app.waitFor("AI accounts on linux-box"); await app.waitFor("id:account-name"); await app.waitFor("Not checked");
      await app.type("id:account-name", "work"); await app.press("id:account-add"); await app.waitFor("id:account-claude-work");
      expect(writes[0]).toEqual({ method: "POST", path: base, body: { cli: "claude", name: "work" } });
      await app.press("id:account-login-claude-work"); await app.waitFor("id:login-code-claude-work");
      expect(app.enabled("id:account-remove-claude-work")).toBe(false);
      await app.type("id:login-code-claude-work", "test-one-time-code"); await app.press("id:login-submit-claude-work");
      await app.waitFor("text:/Sign-in L-123456789012345678901234567890: complete/");
      expect(app.shows("id:login-code-claude-work")).toBe(false);
      expect(writes.find((entry) => entry.path === "work/code")!.body).toEqual({ id: "L-123456789012345678901234567890", code: "test-one-time-code" });
      app.onDialog((dialog) => dialog.title?.startsWith("Remove") ? "Remove" : null);
      await app.press("id:account-remove-claude-work"); await app.waitUntil(() => !app.shows("id:account-claude-work"));
      await app.press("id:account-remove-claude-default"); await app.waitFor("id:accounts-empty-claude");
      await app.clear("id:account-name"); await app.type("id:account-name", "default"); await app.press("id:account-add"); await app.waitFor("id:account-claude-default");
      await app.press("id:account-login-codex-default"); await app.waitFor("id:login-device-codex-default");
      expect(app.shows("id:login-code-codex-default")).toBe(false);
      await app.press("id:login-cancel-codex-default"); await app.waitFor("text:/Sign-in L-99999999999999999999999999999: cancelled/");
      expect(app.shows("id:login-device-codex-default")).toBe(false); expect(posts).toHaveLength(0);
    });
  }

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: account priority and file defaults are configurable without recreating accounts`, async () => {
      let accounts = [row("claude"), row("claude", "work"), row("claude", "personal"), row("codex")];
      const changes: any[] = [];
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${base}`]: () => ({ body: accountView(accounts) }),
        [`PUT ${base}`]: (r: { body?: string | null }) => {
          const body = JSON.parse(r.body!); changes.push(body);
          const selected = accounts.filter((account) => account.cli === body.cli);
          const reordered = body.names === null ? [row(body.cli, "file-account")] : body.names.map((name: string) => selected.find((account) => account.name === name)!);
          accounts = [...reordered, ...accounts.filter((account) => account.cli !== body.cli)];
          return { body: accountView(accounts) };
        },
      } });
      await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
      await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open"); await app.waitFor("id:account-up-claude-default");
      expect(app.enabled("id:account-up-claude-default")).toBe(false); expect(app.enabled("id:account-down-claude-personal")).toBe(false);
      await app.press("id:account-up-claude-personal"); await app.waitUntil(() => changes.length === 1);
      expect(changes[0]).toEqual({ cli: "claude", names: ["default", "personal", "work"] });
      await app.press("id:account-up-claude-personal"); await app.waitUntil(() => changes.length === 2);
      expect(changes[1].names).toEqual(["personal", "default", "work"]);
      await app.press("id:account-down-claude-personal"); await app.waitUntil(() => changes.length === 3);
      expect(changes[2].names).toEqual(["default", "personal", "work"]);
      await app.press("id:accounts-defaults-claude"); await app.waitFor("id:account-claude-file-account");
      expect(changes[3]).toEqual({ cli: "claude", names: null });
      expect(app.shows("id:account-claude-work")).toBe(false); expect(app.shows("id:account-codex-default")).toBe(true);
    });
  }

  test("file defaults cannot discard a pending sign-in", async () => {
    const account = row("claude", "work"); account.login = { id: "L-12345678901234567890", needs_code: true, status: "waiting", expires: "2099-01-01T00:00:00Z", url: "https://claude.ai/oauth/authorize" };
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${base}`]: () => ({ body: accountView([account]) }),
      [`PUT ${base}`]: { status: 409, body: { error: "Cancel the pending sign-in before restoring file defaults" } },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open"); await app.waitFor("id:login-code-claude-work");
    await app.press("id:accounts-defaults-claude"); await app.waitFor("Cancel the pending sign-in before restoring file defaults");
    expect(app.shows("id:login-code-claude-work")).toBe(true); expect(app.shows("id:account-claude-work")).toBe(true);
  });

  test("legacy account labels remain usable without becoming machine paths", async () => {
    let accounts = [row("claude", "Work account"), row("claude", "Personal/Office"), row("claude", ".."), row("codex")];
    const paths: string[] = [], orders: string[][] = [];
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${base}`]: () => ({ body: accountView(accounts) }),
      [`PUT ${base}`]: (r: { body?: string | null }) => { const body = JSON.parse(r.body!); orders.push(body.names); accounts = [...body.names.map((name: string) => accounts.find((account) => account.cli === body.cli && account.name === name)!), ...accounts.filter((account) => account.cli !== body.cli)]; return { body: accountView(accounts) }; },
      [`POST ${base}/claude/Work%20account/login`]: () => { paths.push("Work%20account/login"); return { body: accountView(accounts) }; },
      [`POST ${base}/claude/~../login`]: () => { paths.push("~../login"); return { body: accountView(accounts) }; },
      [`DELETE ${base}/claude/Personal%2FOffice`]: () => { paths.push("Personal%2FOffice"); accounts = accounts.filter((account) => account.name !== "Personal/Office"); return { body: accountView(accounts) }; },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open"); await app.waitFor("id:account-claude-Work%20account");
    await app.press("id:account-up-claude-Personal%2FOffice"); await app.waitUntil(() => orders.length === 1); expect(orders[0]).toEqual(["Personal/Office", "Work account", ".."]);
    await app.press("id:account-login-claude-Work%20account"); await app.waitUntil(() => paths.length === 1);
    app.onDialog((dialog) => dialog.title?.startsWith("Remove") ? "Remove" : null);
    await app.press("id:account-remove-claude-Personal%2FOffice"); await app.waitUntil(() => paths.length === 2);
    await app.press("id:account-login-claude-~.."); await app.waitUntil(() => paths.length === 3);
    expect(paths).toEqual(["Work%20account/login", "Personal%2FOffice", "~../login"]); expect(app.shows("id:account-claude-Work%20account")).toBe(true);
  });

  test("older machines explain unsupported account priority changes", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${base}`]: () => ({ body: accountView([row("claude")]) }),
      [`PUT ${base}`]: { status: 405, body: { error: "method not allowed" } },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open"); await app.waitFor("id:accounts-defaults-claude");
    await app.press("id:accounts-defaults-claude"); await app.waitFor("Update this machine to change account priority or restore file defaults.");
    expect(app.shows("id:account-claude-default")).toBe(true);
  });

  test("account confirmation uses its private ticket and recovers without repeating sign-in", async () => {
    const accounts = [row("claude")], ticket = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    let starts = 0, polls = 0;
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${base}`]: () => ({ body: accountView(accounts) }),
      [`POST ${base}/claude/default/login`]: () => { starts++; return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/machine-requests/${ticket}`]: () => { polls++; return polls === 1 ? { status: 503, body: { error: "temporary" } } : { body: accountView(accounts), headers: { "X-Noop-Confirmed": "1" } }; },
    } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open"); await app.waitFor("id:account-login-claude-default");
    await app.press("id:account-login-claude-default"); await app.waitFor("id:accounts-confirm");
    await app.press("id:accounts-confirm"); await app.waitFor("Confirmed on this machine."); expect(starts).toBe(1); expect(polls).toBe(2);
    expect(app.shows("id:accounts-confirm")).toBe(false);
  });

  test("older hubs explain unavailable account controls", async () => {
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...hub([]), [`GET ${base}`]: { status: 404, body: { error: "not found" } } } });
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.press("id:machine-accounts-open");
    await app.waitFor("Update the hub and this machine to manage its AI accounts."); expect(app.shows("id:account-add")).toBe(false);
  });
});


describe("notification timezone", () => {
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: quiet-hour timezone preserves its saved choice, validates and round-trips`, async () => {
      const puts: any[] = [];
      let current: Record<string, any> = { notify_prefs: { tz: "Europe/London", quiet_hours: { start: "22:00", end: "08:00" }, kinds: { result: false } } };
      const settings = () => ({ current, effective: { agents: [], projects: [], routines: [], autonomy: "assisted", max_parallel: 2 }, options: { clis: [], autonomy: [] } });
      const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, platform, network: {
        ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: settings() }),
        [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => { const patch = JSON.parse(r.body!); puts.push(patch); current = { ...current, ...patch }; return { body: settings() }; },
      } });
      if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-notify"); }
      else { await app.press("id:settings"); await app.press("id:settings-tab-notify"); }
      await app.waitFor("id:notify-timezone"); expect(app.value("id:notify-timezone")).toBe("Europe/London");
      await app.clear("id:notify-timezone"); await app.type("id:notify-timezone", "Mars/Olympus"); await app.press("id:notify-timezone-save");
      await app.waitFor("Enter a valid IANA time zone, for example America/Toronto or UTC."); expect(puts).toHaveLength(0);
      await app.clear("id:notify-timezone"); await app.type("id:notify-timezone", "America/Toronto"); await app.press("id:notify-timezone-save"); await app.waitFor("Time zone saved.");
      expect(puts[0].notify_prefs).toEqual({ tz: "America/Toronto", quiet_hours: { start: "22:00", end: "08:00" }, kinds: { decision: true, menu: true, proposals: true, login: true, result: false } });
      expect(app.value("id:notify-timezone")).toBe("America/Toronto");
      await app.press("id:quiet-23:00-07:00"); await app.waitUntil(() => puts.length === 2); expect(puts[1].notify_prefs.tz).toBe("America/Toronto");
    });
  }
});


describe("notification timezone recovery", () => {
  test("time zone edits typed while confirmation is pending are preserved", async () => {
    let current: any = { notify_prefs: { tz: "Europe/London" } }, submitted: any, polls = 0, release = false;
    const ticket = "92929292-9292-9292-9292-929292929292";
    const settings = () => ({ current, effective: { agents: [], routines: [], projects: [], autonomy: "assisted", max_parallel: 2 }, options: { clis: [], autonomy: [] } });
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: settings() }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => { submitted = JSON.parse(r.body!); return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; if (!release) return { status: 202, body: { ticket } }; current = { ...current, ...submitted }; return { body: settings(), headers: { "X-Noop-Confirmed": "1" } }; },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-notify"); await app.waitFor("id:notify-timezone");
    await app.clear("id:notify-timezone"); await app.type("id:notify-timezone", "America/Toronto"); await app.press("id:notify-timezone-save"); await app.waitUntil(() => polls > 0);
    await app.clear("id:notify-timezone"); await app.type("id:notify-timezone", "America/New_York"); release = true;
    await app.waitFor("Submitted time zone saved. Your additional unsaved entry is kept.");
    expect(app.value("id:notify-timezone")).toBe("America/New_York"); expect(current.notify_prefs.tz).toBe("America/Toronto");
    expect(app.enabled("id:notify-timezone-save")).toBe(true);
  });

  test("a failed timezone save retains the entry for retry", async () => {
    let fail = true, current: any = { notify_prefs: { tz: "Europe/London" } };
    const settings = () => ({ current, effective: { agents: [], routines: [], projects: [], autonomy: "assisted", max_parallel: 2 }, options: { clis: [], autonomy: [] } });
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: settings() }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => { if (fail) return { status: 503, body: { error: "Could not sync preferences" } }; current = { ...current, ...JSON.parse(r.body!) }; return { body: settings() }; },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-notify"); await app.waitFor("id:notify-timezone");
    await app.clear("id:notify-timezone"); await app.type("id:notify-timezone", "America/Toronto"); await app.press("id:notify-timezone-save");
    await app.waitFor("Couldn't save the time zone. Your entry is kept; check the settings message and retry."); expect(app.value("id:notify-timezone")).toBe("America/Toronto");
    fail = false; await app.press("id:notify-timezone-save"); await app.waitFor("Time zone saved."); expect(current.notify_prefs.tz).toBe("America/Toronto");
  });
});


describe("notification timezone device recovery", () => {
  test("the device timezone can replace an old stored default in one action", async () => {
    let current: any = { notify_prefs: { tz: "Asia/Singapore", quiet_hours: { start: "22:00", end: "08:00" } } };
    const puts: any[] = [], settings = () => ({ current, effective: { agents: [], routines: [], projects: [], autonomy: "assisted", max_parallel: 2 }, options: { clis: [], autonomy: [] } });
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: settings() }),
      [`PUT ${URL}/api/settings`]: (r: { body?: string | null }) => { const patch = JSON.parse(r.body!); puts.push(patch); current = { ...current, ...patch }; return { body: settings() }; },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-notify"); await app.waitFor("id:notify-timezone");
    expect(app.value("id:notify-timezone")).toBe("Asia/Singapore"); await app.press("id:notify-timezone-device"); await app.waitFor("Time zone saved.");
    expect(puts).toHaveLength(1); expect(puts[0].notify_prefs.tz).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(app.value("id:notify-timezone")).toBe(puts[0].notify_prefs.tz); expect(puts[0].notify_prefs.quiet_hours).toEqual({ start: "22:00", end: "08:00" });
  });
});

describe("archive restoration", () => {
  const kinds: ArchiveKind[] = ["routines", "members", "projects", "plans"];
  function archives() {
    const previews: ArchivePreview[] = kinds.map((kind, index) => ({
      entry: { key: String(index + 1).repeat(64), kind, id: ["weekly-check", "writer", "site", "PL-0101"][index], name: ["Weekly check", "Writer", "Site", "Ship the release"][index], archived_at: "2026-11-05T12:00:00Z", files: kind === "members" ? 2 : 1, bytes: 240 },
      digest: String(index + 5).repeat(64), can_restore: true, conflicts: [], warnings: [],
      ...(kind === "routines" ? { routine: { name: "weekly-check", every: "weekly MON 09:00", agent: "lead", kind: "", project: "", prompt: "Review the dependency updates", enabled: false as const } } : {}),
      ...(kind === "members" ? { member: { title: "Writer", name: "Ada", about: "Writes documentation", instructions: "Keep the saved writing style." }, warnings: ["Current model and autonomy settings apply."] } : {}),
      ...(kind === "projects" ? { project: { id: "site", name: "Site", host: "worker", path: "/worker/site", instructions: "Run the project tests", repo: "acme/site", requires: ["docker"] } } : {}),
      ...(kind === "plans" ? { plan: { id: "PL-0101", goal: "Ship the release", status: "done" as const, agent: "lead", steps: 2 } } : {}),
    }));
    const effective: any = { primary_host: "mac", agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "assisted" }], routines: [], projects: [], autonomy: "assisted", enabled_clis: ["claude"], max_parallel: 2, media_days: 7 };
    const view = () => ({ current: {}, effective, options: { clis: [["claude"]], autonomy: ["assisted"] } });
    const calls: ArchiveRestoreRequest[] = [], lists: any[] = [], probes: any[] = [], receipts = new Map<string, any>();
    const restored = (body: ArchiveRestoreRequest) => {
      const old = receipts.get(body.request_id); if (old) return { ...old, replayed: true };
      const p = previews.find((p) => p.entry.key === body.key)!;
      const result = { key: body.key, digest: body.digest, request_id: body.request_id, kind: p.entry.kind, id: p.entry.id, restored: true, replayed: false, warnings: [] };
      receipts.set(body.request_id, result);
      if (p.routine) effective.routines.push({ ...p.routine, desc: "", readonly: false });
      if (p.member) effective.agents.push({ id: p.entry.id, ...p.member, clis: ["claude"], autonomy: "assisted" });
      if (p.project) effective.projects.push({ ...p.project, ...body.project, path: body.project?.path ?? p.project.path, exists: true, custom_repo: p.project.repo, custom_requires: p.project.requires });
      return result;
    };
    const network = {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`GET ${URL}/api/status`]: () => ({ body: { ...status, hosts: [{ host: "mac", caps: ["os:macos", "cli:claude"], online: true }, { host: "worker", caps: ["os:linux", "cli:claude"], online: true }] } }),
      [`POST ${URL}/api/archive`]: (r: any) => {
        const body = JSON.parse(r.body); lists.push(body);
        const rows = previews.map((p) => p.entry).filter((entry) => (!body.kind || entry.kind === body.kind) && (!body.query || `${entry.id} ${entry.name}`.toLowerCase().includes(body.query.toLowerCase())));
        return { body: { items: rows.slice(body.offset, body.offset + body.limit), total: rows.length, offset: body.offset, limit: body.limit, warnings: [] } };
      },
      [`POST ${URL}/api/archive/preview`]: (r: any) => ({ body: previews.find((p) => p.entry.key === JSON.parse(r.body).key) }),
      [`POST ${URL}/api/archive/restore`]: (r: any) => {
        const body = JSON.parse(r.body); calls.push(body);
        if (body.confirm_only && !receipts.has(body.request_id)) return { status: 404, body: { error: "No saved restoration is available. Retry the original request." } };
        return { body: { ok: true, ...restored(body) } };
      },
      [`POST ${URL}/api/machines/worker/project-folder-check`]: (r: any) => {
        const body = JSON.parse(r.body); probes.push(body);
        return { body: { host: "worker", requested_path: body.path, path: body.path, repo: "acme/site", requires: ["cli:cargo"], checked: new Date().toISOString(), probe_ticket: "c187d49c-46d7-4e9c-97d9-a3def411fba1" } };
      },
      [`POST ${URL}/api/machines/mac/project-folder-check`]: (r: any) => {
        const body = JSON.parse(r.body); probes.push(body);
        return { body: { host: "mac", requested_path: body.path, path: body.path, repo: "acme/site", requires: ["cli:cargo"], checked: new Date().toISOString() } };
      },
      [`GET ${URL}/api/projects/site`]: () => ({ body: effective.projects.find((p: any) => p.id === "site") }),
      [`GET ${URL}/api/members/writer`]: () => ({ body: effective.agents.find((member: any) => member.id === "writer") }),
      [`GET ${URL}/api/routines/weekly-check`]: () => ({ body: effective.routines.find((routine: any) => routine.name === "weekly-check") }),
      [`GET ${URL}/api/plans/PL-0101`]: () => ({ body: { plan: { ...previews[3].plan, branch: "agent/plan-PL-0101", notes: [], steps: [] } } }),
    };
    return { previews, effective, view, calls, lists, probes, restored, receipts, network };
  }
  async function page(f: ReturnType<typeof archives>, platform: "macos" | "ios" = "macos", extra: Record<string, unknown> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
    await app.press("id:settings"); await app.press(platform === "ios" ? "id:settings-archive" : "id:settings-tab-archive");
    await app.waitFor("id:archive-page"); await app.waitFor(`id:archive-item-${f.previews[0].entry.key}`);
    app.onDialog((d) => d.buttons.includes("Restore paused") ? "Restore paused" : d.buttons.includes("Restore") ? "Restore" : "Refresh preview");
    return app;
  }
  for (const platform of ["macos", "ios"] as const) for (const kind of kinds) {
    test(`${platform}: previews and restores an archived ${kind} record with its original identity`, async () => {
      const f = archives(), p = f.previews.find((p) => p.entry.kind === kind)!, app = await page(f, platform);
      await app.press(`id:archive-item-${p.entry.key}`); await app.waitFor("id:archive-restore");
      expect(app.shows(p.entry.name)).toBe(true);
      if (kind === "routines") expect(app.shows("Restores paused. Enable it in Routines when you are ready.")).toBe(true);
      if (kind === "members") expect(app.shows("Keep the saved writing style.")).toBe(true);
      if (kind === "plans") expect(app.shows("Restores history only. No work starts automatically.")).toBe(true);
      if (kind === "projects") {
        await app.press("id:archive-project-host"); await app.press("id:archive-project-host-mac");
        await app.clear("id:archive-project-path"); await app.type("id:archive-project-path", "/mac/site");
      }
      await app.press("id:archive-restore"); await app.waitFor("Restoration confirmed.");
      expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ key: p.entry.key, digest: p.digest }); expect(f.calls[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
      if (kind === "routines") expect(f.effective.routines[0].enabled).toBe(false);
      if (kind === "projects") {
        expect(f.calls[0].project).toEqual({ host: "mac", path: "/mac/site" }); expect(f.probes).toEqual([{ path: "/mac/site" }]);
        await app.press("id:archive-open"); await app.waitFor("id:project-editor"); expect(app.value("id:project-path")).toBe("/mac/site");
      } else {
        await app.press("id:archive-open"); await app.waitFor(kind === "members" ? "id:phone-member" : kind === "routines" ? "id:phone-routine" : "id:plan-page");
      }
    });
  }
  test("archive filtering and pagination never append rows from an unapplied search", async () => {
    const f = archives(), base = f.previews[0];
    for (let index = 10; index < 37; index++) f.previews.push({ ...base, entry: { ...base.entry, key: index.toString(16).padStart(64, "0"), id: `routine-${index}`, name: `Routine ${index}` }, routine: { ...base.routine!, name: `routine-${index}` } });
    const app = await page(f); await app.press("id:archive-more"); await app.waitUntil(() => f.lists.length === 2);
    expect(f.lists[1].offset).toBe(25);
    await app.type("id:archive-search", "Writer"); await app.press("id:archive-refresh"); await app.waitFor(`id:archive-item-${f.previews[1].entry.key}`);
    expect(f.lists.at(-1).offset).toBe(0); expect(f.lists.at(-1).query).toBe("Writer"); expect(app.shows(`id:archive-item-${base.entry.key}`)).toBe(false);
    await app.press("id:archive-kind"); await app.press("id:archive-kind-members"); await app.waitUntil(() => f.lists.at(-1).kind === "members");
  });
  test("a conflicted preview remains readable and cannot restore over the current record", async () => {
    const f = archives(); f.previews[0].can_restore = false; f.previews[0].conflicts = ["A routine with this name already exists."];
    const app = await page(f); await app.press(`id:archive-item-${f.previews[0].entry.key}`); await app.waitFor("A routine with this name already exists.");
    expect(app.enabled("id:archive-restore")).toBe(false); expect(f.calls).toHaveLength(0); expect(app.shows("Review the dependency updates")).toBe(true);
  });
  test("partial restore confirmation survives navigation and never submits a second restore intent", async () => {
    const f = archives(), p = f.previews[0]; let first = true;
    const app = await page(f, "macos", { [`POST ${URL}/api/archive/restore`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push(body); const value = f.restored(body);
      if (first) { first = false; return { status: 503, body: { ...value, ok: false, saved_locally: true, error: "Restore saved locally; synchronization is pending" } }; }
      return { body: { ok: true, ...value } };
    } });
    await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-restore"); await app.waitFor("id:archive-confirm");
    await app.press("id:archive-close"); await app.press("id:settings-tab-notify"); await app.press("id:settings-tab-archive");
    await app.press(`id:archive-item-${p.entry.key}`); await app.waitFor("id:archive-confirm"); await app.press("id:archive-confirm");
    await app.waitFor("Earlier restoration confirmed. Open the record to check its current state.");
    expect(f.calls).toHaveLength(2); expect(f.calls[1]).toEqual({ ...f.calls[0], confirm_only: true }); expect(f.receipts.size).toBe(1); expect(f.effective.routines).toHaveLength(1);
  });
  test("a stale project archive keeps the chosen machine and folder when refreshing its preview", async () => {
    const f = archives(), p = f.previews[2]; let first = true;
    const app = await page(f, "macos", { [`POST ${URL}/api/archive/restore`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push(body);
      if (first) { first = false; p.digest = "a".repeat(64); return { status: 409, body: { error: "The archived record changed. Preview it again." } }; }
      return { body: { ok: true, ...f.restored(body) } };
    } });
    await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-project-host"); await app.press("id:archive-project-host-mac");
    await app.clear("id:archive-project-path"); await app.type("id:archive-project-path", "/mac/new-site"); await app.press("id:archive-restore");
    await app.waitFor("The archived record changed. Preview it again."); expect(app.enabled("id:archive-restore")).toBe(false);
    await app.press("id:archive-preview-refresh"); await app.waitFor("id:archive-restore"); expect(app.value("id:archive-project-path")).toBe("/mac/new-site");
    await app.press("id:archive-restore"); await app.waitFor("Restoration confirmed."); expect(f.calls[1].digest).toBe(p.digest); expect(f.calls[1].project?.host).toBe("mac");
  });
  test("an offline worker's completed restore can be confirmed without rechecking its former folder", async () => {
    const f = archives(), p = f.previews[2]; let first = true;
    const app = await page(f, "macos", { [`POST ${URL}/api/archive/restore`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push(body); const value = f.restored(body);
      if (first) { first = false; return { status: 503, body: { ...value, ok: false, saved_locally: true, error: "Saved restore; publication is pending" } }; }
      return { body: { ok: true, ...value } };
    } });
    await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-restore"); await app.waitFor("id:archive-confirm"); await app.press("id:archive-confirm");
    await app.waitFor("Earlier restoration confirmed. Open the record to check its current state.");
    expect(f.probes).toHaveLength(1); expect(f.calls[0].project?.probe_ticket).toBeDefined(); expect(f.calls[1].project).toEqual({ host: "worker", path: "/worker/site" });
    expect(f.calls[1].request_id).toBe(f.calls[0].request_id);
  });
  test("malformed restoration success retains its ticket and exact request", async () => {
    const f = archives(), p = f.previews[0], ticket = "c187d49c-46d7-4e9c-97d9-a3def411fba2"; let request: any, posts = 0, reads = 0;
    const app = await page(f, "macos", {
      [`POST ${URL}/api/archive/restore`]: (r: any) => { posts++; request = JSON.parse(r.body); return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => { const value = f.restored(request); return { body: ++reads === 1 ? { ...value, ok: true, id: "another-routine" } : { ...value, ok: true } }; },
    });
    await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-restore"); await app.waitFor("Couldn't confirm this restoration. Check the saved restore before starting another request.");
    await app.press("id:archive-retry"); await app.waitFor("Earlier restoration confirmed. Open the record to check its current state.");
    expect(posts).toBe(1); expect(reads).toBe(2); expect(f.receipts.size).toBe(1);
  });
  test("older archive APIs show an update message without offering a restore", async () => {
    const f = archives();
    const app = await open("./App.tsx", { storage: STORAGE, width: 1200, height: 800, platform: "macos", network: { ...f.network, [`POST ${URL}/api/archive`]: { status: 404, body: { error: "not found" } } } });
    await app.press("id:settings"); await app.press("id:settings-tab-archive"); await app.waitFor("Update the hub and main machine to browse and restore archives.");
    expect(app.shows("id:archive-restore")).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test("a preview must describe the selected list identity before a restore can be authorized", async () => {
    const f = archives(), p = f.previews[0];
    const app = await page(f, "macos", { [`POST ${URL}/api/archive/preview`]: { body: { ...f.previews[1], entry: { ...f.previews[1].entry, key: p.entry.key } } } });
    await app.press(`id:archive-item-${p.entry.key}`); await app.waitFor("Couldn't preview this archive.");
    expect(app.shows("id:archive-restore")).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test("archive paging advances by consumed rows even when new archives shift a page into duplicate keys", async () => {
    const f = archives(), base = f.previews[0]; let count = 0;
    const rows = Array.from({ length: 25 }, (_, index) => ({ ...base.entry, key: (index + 10).toString(16).padStart(64, "0"), id: `routine-${index}`, name: `Routine ${index}` }));
    const app = await page(f, "macos", { [`POST ${URL}/api/archive`]: (r: any) => {
      const body = JSON.parse(r.body); f.lists.push(body); count++;
      return { body: { items: count === 1 ? [base.entry, ...rows.slice(1)] : count === 2 ? rows : rows.map((row) => ({ ...row, key: `f${row.key.slice(1)}` })), total: 75, offset: body.offset, limit: body.limit, warnings: [] } };
    } });
    await app.press("id:archive-more"); await app.waitUntil(() => count === 2); await app.press("id:archive-more"); await app.waitUntil(() => count === 3);
    expect(f.lists.map((body) => body.offset)).toEqual([0, 25, 50]); expect(app.shows("id:archive-more")).toBe(false);
  });
  test("restored plan history can be viewed while a deleted planner blocks new work", async () => {
    const f = archives(), p = f.previews[3]; p.plan!.agent = "retired-planner"; p.warnings = ["The planner is no longer on the team. Restore it before continuing."];
    const app = await page(f); await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-restore"); await app.waitFor("Restoration confirmed.");
    await app.press("id:archive-open"); await app.waitFor("Restore or add member retired-planner before continuing this plan.");
    expect(app.enabled("id:plan-continue")).toBe(false); expect(app.shows("id:plan-page")).toBe(true);
  });
  test("a prepared restore without proof needs a fresh preview and a new authorization", async () => {
    const f = archives(), p = f.previews[0]; let preparedId = "";
    const app = await page(f, "macos", { [`POST ${URL}/api/archive/restore`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push(body);
      preparedId ||= body.request_id;
      if (body.request_id === preparedId) {
        return { status: 503, body: { key: body.key, digest: body.digest, request_id: body.request_id, kind: p.entry.kind, id: p.entry.id, pending: true, uncertain: true, saved_locally: true, error: "A restore was prepared; no applied record is confirmed." } };
      }
      return { body: { ok: true, ...f.restored(body) } };
    } });
    await app.press(`id:archive-item-${p.entry.key}`); await app.press("id:archive-restore"); await app.waitFor("A restore was prepared; no applied record is confirmed.");
    expect(app.shows("Restoration confirmed.")).toBe(false); expect(f.effective.routines).toHaveLength(0);
    await app.press("id:archive-confirm"); await app.waitFor("A restore was prepared; no applied record is confirmed.");
    await app.press("id:archive-retry"); await app.waitFor("A restore was prepared; no applied record is confirmed.");
    expect(f.effective.routines).toHaveLength(0);
    await app.press("id:archive-preview-refresh"); await app.waitFor("id:archive-restore"); await app.press("id:archive-restore"); await app.waitFor("Restoration confirmed.");
    expect(f.calls.slice(0, 3).map((body) => body.request_id)).toEqual([preparedId, preparedId, preparedId]); expect(f.calls[3].request_id).not.toBe(preparedId); expect(f.effective.routines).toHaveLength(1);
  });
});

describe("explicit task forms", () => {
  function fixture() {
    const run = { title: "Review the release", agent: "lead", cli: "claude", host: "any", requires: "", priority: "normal" as const, prefer: "", weight: "normal" as const, project: "" };
    const terminal: any = { id: "T-M0501", title: run.title, agent: "lead", state: "cancelled", configured_cli: "claude", target_host: "any", request: "Earlier release review", updated: ts(20) };
    const preview: TaskReopenPreview = { id: terminal.id, digest: "a".repeat(64), state: "cancelled", can_reopen: true, conflicts: [], warnings: [], settings: run, request: terminal.request };
    const effective: any = { primary_host: "mac", agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "assisted" }, { id: "writer", title: "Writer", clis: ["hermes"], autonomy: "assisted" }],
      projects: [{ id: "site", name: "Site", host: "mac", path: "/work/site", requires: ["cli:bun"], instructions: "", repo: "acme/site", exists: true }], routines: [], enabled_clis: ["claude", "codex", "hermes"], autonomy: "assisted", max_parallel: 2, media_days: 7 };
    const calls: { action: "create" | "reopen"; body: TaskCreateRequest | TaskReopenRequest }[] = [], receipts = new Map<string, TaskFormResult>(), tasks = new Map<string, any>([[terminal.id, terminal]]);
    let serial = 700;
    const apply = (action: "create" | "reopen", body: TaskCreateRequest | TaskReopenRequest) => {
      const old = receipts.get(body.request_id); if (old) return { ...old, replayed: true };
      const id = action === "reopen" ? (body as TaskReopenRequest).id : `T-M${String(++serial).padStart(4, "0")}`;
      tasks.set(id, { id, ...body.settings, configured_cli: body.settings.cli, target_host: body.settings.host, state: "inbox", request: action === "reopen" ? `${terminal.request}\n${body.instructions}` : body.instructions });
      const result: TaskFormResult = { action, id, request_id: body.request_id, applied: true, replayed: false, warnings: [] }; receipts.set(body.request_id, result); return result;
    };
    const mutate = (action: "create" | "reopen", r: any) => {
      const body = JSON.parse(r.body); calls.push({ action, body });
      if (body.confirm_only && !receipts.has(body.request_id)) return { status: 404, body: { error: "No task request has been completed." } };
      return { body: { ok: true, ...apply(action, body) } };
    };
    const network = {
      ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: { current: {}, effective, options: { clis: [["claude"], ["hermes"]], autonomy: ["assisted"] } } }),
      [`GET ${URL}/api/status`]: () => ({ body: { ...status, active: [], recent: [...tasks.values()], hosts: [{ host: "mac", caps: ["os:macos", "cli:claude", "cli:codex", "cli:hermes", "cli:bun"], online: true, enabled: true }], offline_hosts: [{ host: "old-linux", caps: ["os:linux", "cli:claude"], online: false }] } }),
      [`GET ${URL}/api/tasks?*`]: () => ({ body: { tasks: [...tasks.values()], total: tasks.size } }),
      [`GET ${URL}/api/tasks/get?*`]: (r: any) => {
        const id = new ParsedURL(r.url).searchParams.get("id")!, task = tasks.get(id);
        return task ? { body: task } : { status: 404, body: { error: "Task is no longer available." } };
      },
      [`POST ${URL}/api/tasks/reopen-preview`]: () => ({ body: preview }),
      [`POST ${URL}/api/tasks/create`]: (r: any) => mutate("create", r),
      [`POST ${URL}/api/tasks/reopen`]: (r: any) => mutate("reopen", r),
    };
    return { run, terminal, preview, effective, calls, receipts, tasks, apply, network };
  }
  async function history(f: ReturnType<typeof fixture>, platform: "macos" | "ios" = "macos", extra: Record<string, unknown> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
    await app.press("label:All tasks"); await app.waitFor("id:task-new"); return app;
  }
  async function task(app: any, f: ReturnType<typeof fixture>) {
    await app.press(`label:${f.terminal.id} ${f.terminal.title}`); await app.waitFor("id:task-reopen");
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: creates a task with explicit project, provider and run settings`, async () => {
      const f = fixture(), app = await history(f, platform); await app.press("id:task-new"); await app.waitFor("id:task-form-instructions");
      await app.type("id:task-form-instructions", "Check the release with the selected project"); await app.type("id:task-title", "Release verification");
      await app.press("id:task-project"); await app.press("id:task-project-site");
      await app.press("id:task-cli"); await app.press("id:task-cli-hermes"); await app.press("id:task-agent"); await app.press("id:task-agent-writer");
      await app.press("id:task-os"); await app.press("id:task-os-macos"); await app.press("id:task-priority"); await app.press("id:task-priority-high");
      await app.press("id:task-advanced"); await app.type("id:task-prefer", "arch:arm64"); await app.press("id:task-weight"); await app.press("id:task-weight-heavy");
      await app.waitFor("Matching machines: mac"); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings.");
      expect(f.calls).toHaveLength(1); expect(f.calls[0].action).toBe("create"); expect(f.calls[0].body.instructions).toBe("Check the release with the selected project");
      expect(f.calls[0].body.settings).toEqual({ title: "Release verification", agent: "writer", cli: "hermes", host: "mac", requires: "os:macos", priority: "high", prefer: "arch:arm64", weight: "heavy", project: "site", project_guard: { host: "mac", path: "/work/site", requires: ["cli:bun"] } });
      await app.press("id:task-form-open"); await app.waitFor("id:task-composer"); expect(f.tasks.size).toBe(2);
    });
    test(`${platform}: cancelled tasks reopen explicitly with their original ID`, async () => {
      const f = fixture(), app = await history(f, platform); await task(app, f);
      expect(app.shows("id:task-composer")).toBe(false); await app.press("id:task-reopen"); await app.waitFor("id:task-form-state");
      await app.type("id:task-form-instructions", "Continue checking the release"); await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings.");
      expect(f.calls).toHaveLength(1); expect(f.calls[0].action).toBe("reopen"); expect((f.calls[0].body as TaskReopenRequest).id).toBe(f.terminal.id); expect((f.calls[0].body as TaskReopenRequest).preview_digest).toBe(f.preview.digest);
      expect(f.tasks.size).toBe(1); await app.press("id:task-form-open"); await app.waitFor("id:task-composer"); await app.waitFor("text:/Continue checking the release/");
    });
  }
  test("unsupported OS is an explicit queue choice before creation", async () => {
    const f = fixture(), app = await history(f); await app.press("id:task-new"); await app.type("id:task-form-instructions", "Build on Linux when it connects"); await app.type("id:task-title", "Linux build");
    await app.press("id:task-os"); await app.press("id:task-os-linux"); await app.waitFor("No connected machine is accepting tasks with these settings. Change them, resume a paused machine, or connect a matching machine.");
    await app.waitFor("Queue until a matching machine is available"); expect(f.calls).toHaveLength(0); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings.");
    expect(f.calls[0].body.settings.requires).toBe("os:linux");
  });
  test("a missing member or disabled tool must be changed before submission", async () => {
    const f = fixture(); f.preview.settings.agent = "deleted"; f.preview.settings.cli = "hermes"; f.effective.enabled_clis = ["claude"];
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Choose an available member before starting this task."); await app.type("id:task-form-instructions", "Resume with an available member");
    await expect(app.press("id:task-form-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(f.calls).toHaveLength(0);
    await app.press("id:task-agent"); await app.press("id:task-agent-lead"); await app.waitFor("Choose an enabled AI tool before starting this task."); await expect(app.press("id:task-form-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(f.calls).toHaveLength(0);
    await app.press("id:task-cli"); await app.press("id:task-cli-claude"); await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings.");
  });
  test("hard cleanup conflicts cannot authorize reopening", async () => {
    const f = fixture(); f.preview.can_reopen = false; f.preview.conflicts = ["Finish related-run cleanup before reopening this task."];
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor(f.preview.conflicts[0]); await app.type("id:task-form-instructions", "Resume after cleanup");
    await expect(app.press("id:task-form-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(f.calls).toHaveLength(0);
  });
  test("a mismatched preview cannot authorize another task", async () => {
    const f = fixture(), app = await history(f, "macos", { [`POST ${URL}/api/tasks/reopen-preview`]: { body: { ...f.preview, id: "T-M9999" } } });
    await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Couldn't verify this task for reopening."); await expect(app.press("id:task-form-submit")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" }); expect(f.calls).toHaveLength(0);
  });
  test("partial creation keeps its exact request across modal closure and navigation", async () => {
    const f = fixture(); let partial = true;
    const app = await history(f, "macos", { [`POST ${URL}/api/tasks/create`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push({ action: "create", body }); const result = f.apply("create", body);
      return partial ? { status: 503, body: { ok: false, ...result, saved_locally: true, error: "Task saved locally; publication is unconfirmed." } } : { body: { ok: true, ...result } };
    } });
    await app.press("id:task-new"); await app.type("id:task-form-instructions", "Only one task should exist"); await app.type("id:task-title", "Preserve this task"); await app.press("id:task-form-submit"); await app.waitFor("Task saved locally; publication is unconfirmed.");
    await app.press("id:task-form-close"); await app.press("label:Main chat"); await app.press("label:All tasks"); await app.press("id:task-new"); await app.waitFor("id:task-form-confirm");
    expect(app.value("id:task-title")).toBe("Preserve this task"); partial = false; await app.press("id:task-form-confirm"); await app.waitFor("Earlier task request confirmed. Open the task to check its current run.");
    expect(f.calls).toHaveLength(2); expect(f.calls[1].body).toEqual({ ...f.calls[0].body, confirm_only: true }); expect(f.tasks.size).toBe(2);
  });
  test("a stale reopen preview preserves instructions and settings for fresh review", async () => {
    const f = fixture(); let stale = true;
    const app = await history(f, "macos", { [`POST ${URL}/api/tasks/reopen`]: (r: any) => { const body = JSON.parse(r.body); f.calls.push({ action: "reopen", body }); return stale ? { status: 409, body: { error: "This terminal task changed. Refresh its preview." } } : { body: { ok: true, ...f.apply("reopen", body) } }; } });
    await task(app, f); await app.press("id:task-reopen"); await app.waitFor("id:task-form-state"); await app.type("id:task-form-instructions", "Keep my follow-up"); await app.clear("id:task-title"); await app.type("id:task-title", "Revised release review");
    await app.press("id:task-form-submit"); await app.waitFor("This terminal task changed. Refresh its preview."); stale = false; f.preview.digest = "b".repeat(64);
    await app.press("id:task-form-refresh"); await app.waitFor("id:task-form-state"); expect(app.value("id:task-title")).toBe("Revised release review"); expect(app.value("id:task-form-instructions")).toBe("Keep my follow-up");
    await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings."); expect((f.calls[1].body as TaskReopenRequest).preview_digest).toBe(f.preview.digest); expect(f.calls[1].body.request_id).not.toBe(f.calls[0].body.request_id);
  });
  test("malformed success retains the original transport ticket and request identity", async () => {
    const f = fixture(), ticket = "f1ec4673-d37b-4edb-ac9e-7a862d4650d9"; let confirmations = 0;
    const app = await history(f, "macos", { [`POST ${URL}/api/tasks/create`]: (r: any) => { const body = JSON.parse(r.body); f.calls.push({ action: "create", body }); f.apply("create", body); return { status: 202, body: { ticket } }; },
      [`GET ${URL}/api/ui-requests/${ticket}`]: () => { confirmations++; const result = [...f.receipts.values()][0]; return { body: confirmations === 1 ? { ok: true, ...result, applied: false } : { ok: true, ...result, replayed: true } }; } });
    await app.press("id:task-new"); await app.type("id:task-title", "One confirmed task"); await app.type("id:task-form-instructions", "Recover my task receipt"); await app.press("id:task-form-submit"); await app.waitFor("Couldn't confirm this task request. Check the same request before starting another one.");
    await app.press("id:task-form-retry"); await app.waitFor("Earlier task request confirmed. Open the task to check its current run."); expect(f.calls).toHaveLength(1); expect(confirmations).toBe(2);
  });
  test("legacy hubs explain missing task form APIs without submitting work", async () => {
    const f = fixture(), app = await history(f, "macos", { [`POST ${URL}/api/tasks/create`]: { status: 404, body: { error: "not found" } } });
    await app.press("id:task-new"); await app.type("id:task-title", "Wait for an update"); await app.type("id:task-form-instructions", "Do not lose this instruction"); await app.press("id:task-form-submit");
    await app.waitFor("Update the hub and main machine to create and reopen tasks from this form."); expect(app.value("id:task-form-instructions")).toBe("Do not lose this instruction"); expect(f.calls).toHaveLength(0);
  });
  test("legacy current folders stay on their original machine unless explicitly detached", async () => {
    const f = fixture(); f.preview.settings.project = "__current__"; f.preview.settings.host = "mac"; f.preview.repo = "/legacy/release";
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Folder: /legacy/release. Choose None to use a different machine.");
    await app.type("id:task-form-instructions", "Continue in the saved folder"); await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings.");
    expect(f.calls[0].body.settings.project).toBe("__current__"); expect(f.calls[0].body.settings.host).toBe("mac"); expect(f.calls[0].body.settings.project_guard).toBeUndefined();
  });
  test("choosing another machine detaches a legacy folder before reopening", async () => {
    const f = fixture(); f.preview.settings.project = "__current__"; f.preview.settings.host = "mac"; f.preview.repo = "/legacy/release";
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("id:task-form-state"); await app.type("id:task-form-instructions", "Run elsewhere without that folder");
    await app.press("id:task-machine"); await app.press("id:task-machine-old-linux"); expect(app.shows("Folder: /legacy/release. Choose None to use a different machine.")).toBe(false);
    await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings."); expect(f.calls[0].body.settings.project).toBe(""); expect(f.calls[0].body.settings.host).toBe("old-linux");
  });
  test("a prepared task request cannot be silently replaced or reapplied", async () => {
    const f = fixture(); let uncertain = true;
    const app = await history(f, "macos", { [`POST ${URL}/api/tasks/create`]: (r: any) => {
      const body = JSON.parse(r.body); f.calls.push({ action: "create", body });
      return uncertain ? { status: 503, body: { ok: false, request_id: body.request_id, action: "create", id: "T-M0701", pending: true, saved_locally: true, error: "This task request is prepared; no applied task is confirmed." } } : { body: { ok: true, ...f.apply("create", body) } };
    } });
    app.onDialog((d) => d.title === "Start a fresh task request?" ? "Start fresh" : "Keep pending request");
    await app.press("id:task-new"); await app.type("id:task-title", "Keep the authorization clear"); await app.type("id:task-form-instructions", "Only create after review"); await app.press("id:task-form-submit"); await app.waitFor("This task request is prepared; no applied task is confirmed.");
    await app.press("id:task-form-confirm"); await app.waitFor("This task request is prepared; no applied task is confirmed."); await app.press("id:task-form-retry"); await app.waitFor("This task request is prepared; no applied task is confirmed.");
    expect(f.tasks.size).toBe(1); expect(f.calls.slice(0, 3).every((call) => call.body.request_id === f.calls[0].body.request_id)).toBe(true);
    await app.press("id:task-form-refresh"); uncertain = false; expect(app.value("id:task-form-instructions")).toBe("Only create after review"); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings.");
    expect(f.calls[3].body.request_id).not.toBe(f.calls[0].body.request_id); expect(f.tasks.size).toBe(2);
  });

  test("invalid settings keep task creation blocked until a successful reload", async () => {
    const f = fixture(); let valid = false;
    const app = await history(f, "macos", { [`GET ${URL}/api/settings`]: () => ({ body: { effective: valid ? f.effective : { agents: null, projects: [] } } }) });
    await app.press("id:task-new"); await app.waitFor("Couldn't load members and projects. Reconnect and reload settings before starting work.");
    await app.type("id:task-title", "Keep my draft"); await app.type("id:task-form-instructions", "Wait for valid settings"); expect(app.enabled("id:task-form-submit")).toBe(false);
    valid = true; await app.press("id:task-form-refresh"); await app.waitFor("Matching machines: mac"); expect(app.value("id:task-title")).toBe("Keep my draft");
    await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings."); expect(f.calls).toHaveLength(1);
  });

  test("empty default task tools explain policy while an explicit tool can use the online Mac", async () => {
    const f = fixture(); f.effective.agents[0].clis = []; f.effective.agents[0].paused = false;
    const app = await history(f); await app.press("id:task-new"); await app.type("id:task-title", "Use an explicit tool"); await app.type("id:task-form-instructions", "Check this on the connected Mac");
    await app.waitFor("No enabled default task tools for this member. Choose an explicit task tool or change Settings → Members.");
    expect(app.shows("Matching machines: mac")).toBe(false);
    await app.press("id:task-cli"); await app.press("id:task-cli-claude"); await app.waitFor("Matching machines: mac");
    await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings."); expect(f.calls[0].body.settings.cli).toBe("claude");
  });

  test("invalid member policy blocks explicit tools in create, reopen and run settings", async () => {
    const f = fixture(); f.effective.agents[0].clis = []; f.effective.agents[0].paused = false;
    f.effective.agents[0].tool_policy = { configured: [], effective: [], source: "local_file", file_default: [], file_source: "local_file", invalid: true, file_invalid: true };
    const issue = "This member's task tool setting is invalid. Fix it in Settings → Members before running work.";
    const app = await history(f); await app.press("id:task-new"); await app.type("id:task-title", "Do not queue invalid policy"); await app.type("id:task-form-instructions", "Wait for member policy repair");
    await app.press("id:task-cli"); await app.press("id:task-cli-claude"); await app.waitFor(issue);
    expect(app.shows("Matching machines: mac")).toBe(false); expect(app.enabled("id:task-form-submit")).toBe(false); expect(f.calls).toHaveLength(0);
    await app.press("id:task-form-close"); await task(app, f); await app.press("id:task-reopen"); await app.type("id:task-form-instructions", "Resume after member repair"); await app.waitFor(issue);
    expect(app.enabled("id:task-form-submit")).toBe(false); await app.press("id:task-form-close");
    f.terminal.state = "inbox"; await app.press("label:All tasks"); await app.press(`label:${f.terminal.id} ${f.terminal.title}`); await app.waitFor("id:task-edit-run"); await app.press("id:task-edit-run"); await app.waitFor(issue);
    expect(app.shows("Matching machines: mac")).toBe(false); expect(app.enabled("id:task-placement-save")).toBe(false); expect(f.calls).toHaveLength(0);
  });

  test("globally disabled execution points task owners to onboarding", async () => {
    const f = fixture(); f.effective.enabled_clis = []; f.effective.agents[0].clis = []; f.effective.agents[0].paused = false;
    const app = await history(f); await app.press("id:task-new"); await app.waitFor("AI execution is disabled for the team. Enable tools in Settings → AI tools & onboarding.");
    expect(app.shows("Matching machines: mac")).toBe(false);
  });

  test("a refreshed legacy folder cannot silently keep its former machine", async () => {
    const f = fixture(); f.preview.settings.project = "__current__"; f.preview.settings.host = "mac"; f.preview.repo = "/legacy/release";
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("id:task-form-state"); await app.type("id:task-form-instructions", "Keep my work on the verified machine");
    f.preview.settings.host = "old-linux"; f.preview.digest = "b".repeat(64); await app.press("id:task-form-refresh"); await app.waitFor("The folder's machine changed. Use its current machine, or select None to use another machine.");
    expect(app.enabled("id:task-form-submit")).toBe(false); await app.press("id:task-folder-machine"); await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings.");
    expect(f.calls[0].body.settings.host).toBe("old-linux"); expect((f.calls[0].body as TaskReopenRequest).preview_digest).toBe(f.preview.digest);
  });

  test("a later terminal attempt gets a fresh reopen preview and new instructions", async () => {
    const f = fixture(), app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("id:task-form-state"); await app.type("id:task-form-instructions", "First new attempt");
    await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings."); await app.press("id:task-form-open"); await app.waitFor("id:task-composer");
    const current = f.tasks.get(f.terminal.id)!; current.state = "done"; f.preview.state = "done"; f.preview.digest = "c".repeat(64);
    await app.waitFor("id:task-reopen", { timeout: 6500 }); await app.type("id:task-composer", "Latest unsent instructions"); await app.press("id:task-reopen"); await app.waitFor("Previous state: Done");
    expect(app.value("id:task-form-instructions")).toBe("Latest unsent instructions"); expect(app.shows("id:task-form-submit")).toBe(true);
    await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings."); expect(f.calls).toHaveLength(2); expect(f.calls[1].body.request_id).not.toBe(f.calls[0].body.request_id);
    expect((f.calls[1].body as TaskReopenRequest).preview_digest).toBe(f.preview.digest);
  });
  test("a slow initial catalog cannot replace a newer explicit reload", async () => {
    const f = fixture(); let reads = 0;
    const old = { ...f.effective, projects: f.effective.projects.map((p: any) => ({ ...p })) }; f.effective.projects[0].path = "/work/new-site";
    const app = await history(f, "macos", { [`GET ${URL}/api/settings`]: () => ++reads === 1 ? { body: { effective: old }, delay: 1000 } : { body: { effective: f.effective } } });
    await app.press("id:task-new"); await app.type("id:task-title", "Use latest settings"); await app.type("id:task-form-instructions", "Keep the latest folder selection"); await app.press("id:task-form-refresh"); await app.waitFor("Matching machines: mac"); await app.wait(1200);
    await app.press("id:task-project"); await app.press("id:task-project-site"); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings.");
    expect(f.calls[0].body.settings.project_guard?.path).toBe("/work/new-site"); expect(reads).toBeGreaterThan(1);
  });

  test("a machine with unavailable disk monitoring is an explicit wait choice", async () => {
    const f = fixture(), app = await history(f, "macos", { [`GET ${URL}/api/status`]: { body: { ...status, active: [], recent: [f.terminal], hosts: [{ host: "mac", caps: ["os:macos", "cli:claude"], stats: { diskFreeGB: 0, diskError: "Disk monitoring is unavailable" } }] } } });
    await app.press("id:task-new"); await app.type("id:task-title", "Wait for disk recovery"); await app.type("id:task-form-instructions", "Run after monitoring is fixed"); await app.waitFor("Queue until a matching machine is available");
    expect(app.shows("Matching machines: mac")).toBe(false); await app.press("id:task-machine"); await app.waitFor("Disk monitoring unavailable"); await app.keyboard.press("escape");
    expect(f.calls).toHaveLength(0); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings."); expect(f.calls).toHaveLength(1);
  });

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: learning task settings repair the target to its offline history source without losing ordinary edits`, async () => {
      const f = fixture(), writes: any[] = []; f.terminal.state = "inbox"; f.terminal.target_host = "mac"; f.terminal.learning_host = "old-linux";
      f.effective.projects.push({ id: "worker-site", name: "Worker site", host: "old-linux", path: "/work/private-site", requires: [], instructions: "", repo: "acme/private", exists: true });
      const app = await history(f, platform, { [`POST ${URL}/api/tasks/configure`]: (r: any) => { writes.push(JSON.parse(r.body)); return { body: { ok: true, data: { ok: true } } }; } });
      await app.press(`label:${f.terminal.id} ${f.terminal.title}`); await app.press("id:task-edit-run"); await app.waitFor("Learning source: old-linux · Offline");
      expect(app.shows("id:task-machine")).toBe(false); expect(app.shows("Matching machines: mac")).toBe(false); await app.waitFor("The saved target is mac. Saving returns this learning task to old-linux.");
      await app.clear("id:task-title"); await app.type("id:task-title", "Keep my learning edits"); await app.type("id:task-requires", "docker");
      await app.press("id:task-cli"); await app.press("id:task-cli-codex"); await app.press("id:task-agent"); await app.press("id:task-agent-writer");
      await app.press("id:task-project"); expect(app.shows("id:task-project-site")).toBe(false); await app.press("id:task-project-worker-site");
      await app.press("id:task-project"); await app.press("id:task-project-none"); await app.press("id:task-placement-save");
      await app.waitFor("Settings saved. This learning task waits for old-linux to accept its run settings.");
      expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ id: f.terminal.id, host: "old-linux", title: "Keep my learning edits", requires: "docker", cli: "codex", agent: "writer", project: "" });
      expect(Object.hasOwn(writes[0], "learning_host")).toBe(false);
    });

    test(`${platform}: reopening learning work waits for its source and offers only projects on that machine`, async () => {
      const f = fixture(); f.terminal.learning_host = "old-linux"; f.preview.learning_host = "old-linux"; f.preview.settings.host = "old-linux";
      f.effective.projects.push({ id: "worker-site", name: "Worker site", host: "old-linux", path: "/work/private-site", requires: [], instructions: "", repo: "acme/private", exists: true });
      const app = await history(f, platform); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Learning source: old-linux · Offline");
      expect(app.shows("id:task-machine")).toBe(false); expect(app.shows("Matching machines: mac")).toBe(false); await app.type("id:task-form-instructions", "Continue learning on the original machine");
      await app.press("id:task-project"); expect(app.shows("id:task-project-site")).toBe(false); await app.press("id:task-project-worker-site");
      await app.waitFor("Reopen and wait for old-linux"); await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings.");
      const body = f.calls[0].body as TaskReopenRequest; expect(body.id).toBe(f.terminal.id); expect(body.settings.host).toBe("old-linux");
      expect(body.settings.project_guard).toEqual({ host: "old-linux", path: "/work/private-site", requires: [] });
      expect(Object.hasOwn(body, "learning_host")).toBe(false); expect(Object.hasOwn(body.settings, "learning_host")).toBe(false);
    });

    test(`${platform}: unverifiable learning provenance disables configuration and reopening`, async () => {
      const error = learningTaskBinding({ learning_request_id: "12345678-1234-1234-1234-123456789da3" }).learning_host_error!, f = fixture(); f.terminal.state = "inbox"; f.terminal.learning_host_error = error;
      const first = await history(f, platform); await first.press(`label:${f.terminal.id} ${f.terminal.title}`); await first.press("id:task-edit-run"); await first.waitFor("id:task-learning-error");
      expect(first.enabled("id:task-title")).toBe(false); expect(first.enabled("id:task-placement-save")).toBe(false); expect(first.shows("id:task-machine")).toBe(false); first.dispose();
      f.terminal.state = "cancelled"; f.preview.learning_host_error = error; f.preview.can_reopen = false; f.preview.conflicts = [error];
      const second = await history(f, platform); await task(second, f); await second.press("id:task-reopen"); await second.waitFor("id:task-learning-error");
      await second.waitFor("text:/noop learn --full/"); expect(second.enabled("id:task-form-instructions")).toBe(false);
      expect(second.enabled("id:task-form-submit")).toBe(false); expect(second.shows("id:task-machine")).toBe(false); expect(f.calls).toHaveLength(0);
    });
  }

  test("an online learning source matches normally while a conflicting saved project must be detached", async () => {
    const f = fixture(), writes: any[] = []; f.terminal.state = "inbox"; f.terminal.learning_host = "mac"; f.terminal.target_host = "old-linux"; f.terminal.project = "foreign";
    f.effective.projects.push({ id: "foreign", name: "Foreign project", host: "old-linux", path: "/work/foreign", requires: [], instructions: "", repo: "acme/foreign", exists: true });
    const app = await history(f, "macos", { [`POST ${URL}/api/tasks/configure`]: (r: any) => { writes.push(JSON.parse(r.body)); return { body: { ok: true, data: { ok: true } } }; } });
    await app.press(`label:${f.terminal.id} ${f.terminal.title}`); await app.press("id:task-edit-run"); await app.waitFor("Learning source: mac · Online");
    await app.waitFor("This folder belongs to another machine. Choose None or a project on mac; the private learning history stays there."); expect(app.enabled("id:task-placement-save")).toBe(false);
    await app.clear("id:task-title"); await app.type("id:task-title", "Retain this correction"); await app.press("id:task-project"); expect(app.shows("id:task-project-foreign")).toBe(false); await app.press("id:task-project-none");
    await app.waitFor("Matching machines: mac"); expect(app.value("id:task-title")).toBe("Retain this correction"); await app.press("id:task-placement-save"); await app.waitUntil(() => writes.length === 1);
    expect(writes[0]).toMatchObject({ host: "mac", project: "", title: "Retain this correction" });
  });

  test("saved reopen previews preserve the learning host and reject contradictory new authorizations", async () => {
    const f = fixture(); f.preview.learning_host = "old-linux"; f.preview.settings.host = "old-linux";
    const entry: PendingEntry = { kind: "task", key: f.terminal.id, at: "2026-11-06T12:00:00.000Z", known_id: f.terminal.id, preview: f.preview,
      request: { request_id: "12345678-1234-1234-1234-123456789da1", id: f.terminal.id, preview_digest: f.preview.digest, instructions: "Continue the original collection", settings: { ...f.preview.settings } } };
    expect(readPendingEntry(entry)).toEqual(entry);
    expect(readPendingEntry({ ...entry, request: { ...entry.request, settings: { ...entry.request.settings, host: "mac" } } })).toBe(undefined);
    const oldPreview = { ...f.preview }; delete oldPreview.learning_host; oldPreview.settings = { ...f.preview.settings, host: "mac" };
    expect(readPendingEntry({ ...entry, preview: oldPreview, request: { ...entry.request, settings: { ...entry.request.settings, host: "mac" } } })).toBeDefined();
  });

  test("a recovered learning reopen preserves its source marker and checks the exact original request", async () => {
    const f = fixture(), requestId = "12345678-1234-1234-1234-123456789da2", scope = intentScope(URL, "tok"); let previewCalls = 0;
    f.terminal.learning_host = "old-linux"; f.preview.learning_host = "old-linux"; f.preview.settings.host = "old-linux";
    const request: TaskReopenRequest = { request_id: requestId, id: f.terminal.id, preview_digest: f.preview.digest, instructions: "Keep the reviewed source", settings: { ...f.preview.settings } };
    const entry: PendingEntry = { kind: "task", key: f.terminal.id, at: "2026-11-06T12:00:00.000Z", known_id: f.terminal.id, request, preview: f.preview };
    const docs = new Map([[scope, JSON.stringify({ version: 1, scope, entries: [entry] })]]);
    f.receipts.set(requestId, { request_id: requestId, action: "reopen", id: f.terminal.id, applied: true, replayed: false, warnings: [] });
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform: "macos", width: 1200, height: 1000,
      host: { handlers: { pendingRead: (args: any) => ({ scope: args.scope, text: docs.get(args.scope) ?? null }), pendingWrite: (args: any) => {
        if ((docs.get(args.scope) ?? null) !== args.expected) throw new Error("Fixture CAS conflict"); docs.set(args.scope, args.text); return { scope: args.scope, saved: true };
      } } }, network: { ...f.network, [`POST ${URL}/api/tasks/reopen-preview`]: () => { previewCalls++; return { body: f.preview }; } } });
    await app.waitFor("id:composer"); await app.press("label:All tasks"); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Learning source: old-linux · Offline");
    expect(app.shows("id:task-machine")).toBe(false); expect(f.calls).toHaveLength(0); expect(previewCalls).toBe(0);
    await app.press("id:task-form-confirm"); await app.waitFor("Earlier task request confirmed. Open the task to check its current run.");
    expect(f.calls[0].body).toEqual({ ...request, confirm_only: true }); expect(f.tasks.get(f.terminal.id)?.state).toBe("cancelled");
    expect(JSON.parse(docs.get(scope)!).entries).toHaveLength(0);
  });

  test("a fresh learning preview that detaches a folder requires None while preserving the other draft edits", async () => {
    const f = fixture(); f.preview.learning_host = "mac"; f.preview.settings.host = "mac"; f.preview.settings.project = "__current__"; f.preview.repo = "/legacy/source-folder";
    const app = await history(f); await task(app, f); await app.press("id:task-reopen"); await app.waitFor("Learning source: mac · Online");
    await app.type("id:task-form-instructions", "Preserve these instructions"); await app.clear("id:task-title"); await app.type("id:task-title", "Preserve the title");
    f.preview.settings.project = ""; delete f.preview.repo; f.preview.digest = "b".repeat(64); await app.press("id:task-form-refresh");
    await app.waitFor("This folder belongs to another machine. Choose None or a project on mac; the private learning history stays there."); expect(app.enabled("id:task-form-submit")).toBe(false);
    expect(app.value("id:task-title")).toBe("Preserve the title"); expect(app.value("id:task-form-instructions")).toBe("Preserve these instructions");
    await app.press("id:task-project"); expect(app.shows("id:task-project-current")).toBe(false); await app.press("id:task-project-none");
    await app.press("id:task-form-submit"); await app.waitFor("Task reopened with these run settings."); expect(f.calls[0].body.settings).toMatchObject({ host: "mac", project: "", title: "Preserve the title" });
  });

});

describe("disk monitoring configuration", () => {
  function fixture(supported = true, error = false) {
    const defaults = Object.fromEntries(MACHINE_RESOURCE_FIELDS.map((f) => [f.path, f.default])); defaults["resources.disk_path"] = "/srv/data";
    const values = { ...defaults }, overrides = new Set<string>(), puts: any[] = [];
    const view = () => ({ values: { ...values }, overrides: [...overrides], disk_path_supported: supported, learning_supported: false });
    const network = {
      ...hub([]), [`GET ${URL}/api/status`]: { body: { ...status, hosts: [{ ...status.hosts[0], stats: { ...status.hosts[0].stats, ...(error ? { diskFreeGB: 0, diskFreePct: 0, diskPath: "/missing-volume", diskError: "Disk monitoring failed on /missing-volume: path unavailable." } : { diskPath: "/srv/data" }) } }] } },
      [`GET ${URL}/api/machines/linux-box`]: { body: { host: "linux-box", enabled: true, max_parallel: 2, caps: [] } },
      [`GET ${URL}/api/machines/linux-box/configuration`]: () => ({ body: view() }),
      [`PUT ${URL}/api/machines/linux-box/configuration`]: (r: any) => {
        const body = JSON.parse(r.body); puts.push(body);
        for (const [key, value] of Object.entries(body.values ?? {})) { values[key] = value as any; overrides.add(key); }
        for (const path of body.reset ?? []) { values[path] = defaults[path]; overrides.delete(path); }
        return { body: view() };
      },
    };
    return { defaults, values, overrides, puts, network };
  }
  async function page(f: ReturnType<typeof fixture>, platform: "macos" | "ios" = "macos", error = false, extra: Record<string, unknown> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 800, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
    await app.press(error ? "label:Load 42% · Disk unavailable · 1 running" : "label:Load 42% · Disk 120GB · 1 running"); return app;
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: disk roots, home defaults and resets remain machine-specific`, async () => {
      const f = fixture(), app = await page(f, platform); await app.waitFor("Monitoring: /srv/data"); await app.press("id:machine-resources"); await app.waitFor("id:configuration-resources-disk_path");
      expect(app.value("id:configuration-resources-disk_path")).toBe("/srv/data"); await app.clear("id:configuration-resources-disk_path"); await app.type("id:configuration-resources-disk_path", "/"); await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts[0]).toEqual({ values: { "resources.disk_path": "/" } }); await app.clear("id:configuration-resources-disk_path"); await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/");
      expect(f.puts[1]).toEqual({ values: { "resources.disk_path": null } }); await app.press("id:configuration-reset"); await app.waitFor("All changes saved"); expect(app.value("id:configuration-resources-disk_path")).toBe("/srv/data");
      expect(f.puts[2].reset).toContain("resources.disk_path"); expect(f.puts[2].reset.every((path: string) => path.startsWith("resources."))).toBe(true);
    });
  }
  test("older machines cannot edit or reset an unsupported disk location", async () => {
    const f = fixture(false); f.overrides.add("resources.disk_path"); f.overrides.add("resources.mem_min_pct"); f.values["resources.mem_min_pct"] = 25;
    const app = await page(f); await app.press("id:machine-resources"); await app.waitFor("id:machine-disk-path-unsupported"); expect(app.shows("id:configuration-resources-disk_path")).toBe(false);
    await app.press("id:configuration-reset"); await app.waitFor("All changes saved"); expect(f.puts[0].reset).not.toContain("resources.disk_path"); expect(f.overrides.has("resources.disk_path")).toBe(true); expect(f.values["resources.disk_path"]).toBe("/srv/data");
  });
  test("unavailable disk telemetry is reported without claiming zero free space", async () => {
    const f = fixture(true, true), app = await page(f, "macos", true); await app.waitFor("id:machine-disk-error"); await app.waitFor("Monitoring: /missing-volume");
    expect(app.shows("Unavailable")).toBe(true); expect(app.shows("0 GB free")).toBe(false); expect(app.shows("text:/New tasks wait until disk monitoring is available/")).toBe(true);
    await app.press("id:machine-resources"); await app.waitFor("id:configuration-resources-disk_path");
  });
  test("a failed path save retains its entry for an exact retry", async () => {
    const f = fixture(); let fail = true; const requests: any[] = [];
    const app = await page(f, "macos", false, { [`PUT ${URL}/api/machines/linux-box/configuration`]: (r: any) => {
      requests.push(JSON.parse(r.body)); return fail ? { status: 503, body: { error: "Disk settings publication is unconfirmed. Reload before another edit." } } : f.network[`PUT ${URL}/api/machines/linux-box/configuration`](r);
    } });
    await app.press("id:machine-resources"); await app.waitFor("id:configuration-resources-disk_path"); await app.clear("id:configuration-resources-disk_path"); await app.type("id:configuration-resources-disk_path", "~/external-data"); await app.press("id:configuration-save");
    await app.waitFor("Disk settings publication is unconfirmed. Reload before another edit."); expect(app.value("id:configuration-resources-disk_path")).toBe("~/external-data"); fail = false;
    await app.press("id:configuration-save"); await app.waitFor("text:/Saved. Settings apply/"); expect(requests[1]).toEqual(requests[0]);
  });
});

describe("task tool policies", () => {
  function fixture() {
    const f = { enabled: ["claude", "codex"], teamFile: ["codex", "claude"] as string[] | null, memberFile: ["hermes", "claude"] as string[] | null,
      invalidMember: false, legacy: false, current: {} as any, puts: [] as any[] };
    const policy = (member = false): ToolPolicy => {
      const values = member ? f.current.clis?.agents : f.current.clis;
      const key = member ? "reporter" : "preference", overridden = !!values && Object.prototype.hasOwnProperty.call(values, key);
      const configured = overridden ? values[key] as string[] | null : member ? f.memberFile : f.teamFile;
      const invalid = member && !overridden && f.invalidMember;
      const effective = invalid ? [] : (configured ?? (member ? policy().effective : f.enabled)).filter((id: string) => f.enabled.includes(id));
      return { configured: invalid ? [] : configured, effective, source: overridden ? "ui" : member ? "local_file" : "shared_file",
        file_default: member && f.invalidMember ? [] : member ? f.memberFile : f.teamFile, file_source: member ? "local_file" : "shared_file",
        ...(invalid ? { invalid: true } : {}), ...(member && f.invalidMember ? { file_invalid: true } : {}) };
    };
    const view = () => {
      const p = policy(true);
      return JSON.parse(JSON.stringify({ current: f.current, effective: { primary_host: "mac", enabled_clis: f.enabled, autonomy: "onboarding", max_parallel: 2,
        projects: [], routines: [], ...(!f.legacy ? { tool_policy: { version: 1, team: policy() } } : {}), agents: [{ id: "reporter", title: "Reporter", clis: p.effective,
          paused: !p.invalid && Array.isArray(p.configured) && p.configured.length === 0, autonomy: "onboarding", ...(!f.legacy ? { tool_policy: p } : {}) }] },
        options: { clis: providerOrders(f.enabled), autonomy: ["onboarding", "assisted", "autonomous"] } }));
    };
    const apply = (body: any) => {
      f.current.clis ??= {};
      if (Object.prototype.hasOwnProperty.call(body.clis ?? {}, "preference")) f.current.clis.preference = body.clis.preference;
      if (body.clis?.agents) f.current.clis.agents = { ...f.current.clis.agents, ...body.clis.agents };
      for (const path of body.clis?.reset ?? []) {
        if (path === "preference") delete f.current.clis.preference;
        else if (path === "agents.reporter") delete f.current.clis.agents?.reporter;
      }
      return view();
    };
    const network = { ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`PUT ${URL}/api/settings`]: (r: any) => { const body = JSON.parse(r.body); f.puts.push(body); return { body: apply(body) }; } };
    return Object.assign(f, { policy, view, apply, network });
  }
  async function page(f: ReturnType<typeof fixture>, platform: "macos" | "ios", extra: Record<string, any> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 900, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer");
    if (platform === "ios") await app.press("id:settings-top");
    else { await app.press("id:settings"); await app.press("id:settings-tab-members"); }
    await app.waitFor(platform === "ios" ? "id:member-reporter" : "id:cli-reporter");
    return app;
  }
  async function member(app: Awaited<ReturnType<typeof open>>, platform: "macos" | "ios") {
    if (platform === "ios") { await app.press("id:member-reporter"); await app.waitFor("id:phone-member"); }
  }
  async function choose(app: Awaited<ReturnType<typeof open>>, platform: "macos" | "ios", id: string, choice: string) {
    if (id === "team-tools" || platform === "macos") {
      await app.press(`id:${id}`);
      if (app.shows(`id:${id}-options`)) {
        try { await app.scroll(`id:${id}-options`, -10000); } catch (error) { if (!String(error).includes("cannot scroll by")) throw error; }
        const index = choice === "inherit" ? 0 : providerOrders(PROVIDER_IDS).findIndex((tools) => tools.join(",") === choice) + 1;
        if (index > 3) await app.scroll(`id:${id}-options`, Math.max(0, index * 68 - 100));
      }
    }
    await app.press(`id:${id}-${choice}`);
  }

  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: team task order, Automatic, member inheritance and file resets are distinct`, async () => {
      const f = fixture(), app = await page(f, platform);
      await choose(app, platform, "team-tools", "hermes,codex"); await app.waitUntil(() => f.puts.length === 1);
      expect(f.puts[0]).toEqual({ tool_policy_version: 1, clis: { preference: ["hermes", "codex"] } });
      await app.waitFor("text:/Hermes disabled for execution; kept in this selection/"); expect(f.policy().effective).toEqual(["codex"]);
      await choose(app, platform, "team-tools", "inherit"); await app.waitUntil(() => f.puts.length === 2);
      expect(f.puts[1]).toEqual({ tool_policy_version: 1, clis: { preference: null } });
      await app.press("id:team-tools-reset"); await app.waitUntil(() => f.puts.length === 3);
      expect(f.puts[2]).toEqual({ tool_policy_version: 1, clis: { reset: ["preference"] } }); expect(f.policy().configured).toEqual(["codex", "claude"]);
      await member(app, platform); await choose(app, platform, "cli-reporter", "inherit"); await app.waitUntil(() => f.puts.length === 4);
      expect(f.puts[3]).toEqual({ tool_policy_version: 1, clis: { agents: { reporter: null } } }); expect(f.policy(true).effective).toEqual(["codex", "claude"]);
      await app.waitFor("id:cli-reporter-reset"); await app.press("id:cli-reporter-reset"); await app.waitUntil(() => f.puts.length === 5);
      expect(f.puts[4]).toEqual({ tool_policy_version: 1, clis: { reset: ["agents.reporter"] } });
      expect(f.policy(true)).toMatchObject({ configured: ["hermes", "claude"], effective: ["claude"], source: "local_file" });
      await app.waitFor("text:/Main machine's local configuration file/"); expect(app.shows("text:/Other machines use their own files after a reset/")).toBe(true);
    });

    test(`${platform}: disabled configured tools remain selected and differ from an explicit member pause`, async () => {
      const f = fixture(); f.memberFile = ["codex"]; f.enabled = ["claude"];
      const app = await page(f, platform); await member(app, platform);
      await app.waitFor("text:/No selected task tools are enabled/"); expect(f.view().effective.agents[0].paused).toBe(false);
      await choose(app, platform, "cli-reporter", ""); await app.waitUntil(() => f.puts.length === 1);
      expect(f.puts[0]).toEqual({ tool_policy_version: 1, clis: { agents: { reporter: [] } } });
      await app.waitFor("This member is paused for new work, including tasks pinned to a tool.");
      await choose(app, platform, "cli-reporter", "codex"); await app.waitUntil(() => f.puts.length === 2);
      expect(f.policy(true)).toMatchObject({ configured: ["codex"], effective: [] }); expect(f.view().effective.agents[0].paused).toBe(false);
      await app.waitFor("text:/No selected task tools are enabled/");
      expect(app.shows("This member is paused for new work, including tasks pinned to a tool.")).toBe(false);
    });

    test(`${platform}: invalid file policy is not a pause and cannot be restored over a valid override`, async () => {
      const f = fixture(); f.invalidMember = true;
      const app = await page(f, platform); await member(app, platform);
      await app.waitFor("text:/The saved task tool setting is invalid/"); expect(app.enabled("id:cli-reporter-reset")).toBe(false);
      expect(app.shows("text:/local configuration file · Pause this member/")).toBe(false);
      await choose(app, platform, "cli-reporter", "claude"); await app.waitUntil(() => f.puts.length === 1);
      await app.waitFor("text:/Main machine reports enabled task tools: Claude only/");
      expect(app.enabled("id:cli-reporter-reset")).toBe(false); expect(f.policy(true).invalid).toBeUndefined();
    });

    test(`${platform}: old hubs keep legacy explicit member orders without pretending to support policy resets`, async () => {
      const f = fixture(); f.legacy = true;
      const app = await page(f, platform); expect(app.shows("id:team-tools")).toBe(false);
      await member(app, platform); expect(app.shows("id:cli-reporter-inherit")).toBe(false); expect(app.shows("id:cli-reporter-reset")).toBe(false);
      await app.waitFor("id:cli-reporter-unsupported"); await choose(app, platform, "cli-reporter", "codex,claude"); await app.waitUntil(() => f.puts.length === 1);
      expect(f.puts[0]).toEqual({ clis: { agents: { reporter: ["codex", "claude"] } } });
    });

    test(`${platform}: later tool selections remain pending while earlier confirmations update only confirmed policy`, async () => {
      const f = fixture(), tickets = ["12345678-1234-1234-1234-123456789aa1", "12345678-1234-1234-1234-123456789aa2"];
      const release = [false, false], polls = [0, 0], results: any[] = [];
      const routes: Record<string, any> = { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 202, body: { ticket: tickets[f.puts.length - 1] } }; } };
      tickets.forEach((ticket, index) => { routes[`GET ${URL}/api/ui-requests/${ticket}`] = () => { polls[index]++; if (!release[index]) return { status: 202, body: { ticket } }; return { body: results[index] ??= f.apply(f.puts[index]) }; }; });
      const app = await page(f, platform, routes); await member(app, platform);
      await choose(app, platform, "cli-reporter", "claude"); await app.waitUntil(() => polls[0] > 0);
      await choose(app, platform, "cli-reporter", "hermes,codex"); await app.waitFor("text:/Saving selection: Hermes → Codex/"); expect(f.puts).toHaveLength(1);
      expect(app.shows("text:/Main machine's local configuration file/")).toBe(true);
      release[0] = true; await app.waitUntil(() => polls[1] > 0);
      await app.waitFor("text:/Main machine reports enabled task tools: Claude only/"); expect(app.shows("text:/Saving selection: Hermes → Codex/")).toBe(true);
      release[1] = true; await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.puts).toEqual([{ tool_policy_version: 1, clis: { agents: { reporter: ["claude"] } } }, { tool_policy_version: 1, clis: { agents: { reporter: ["hermes", "codex"] } } }]);
      expect(f.policy(true)).toMatchObject({ configured: ["hermes", "codex"], effective: ["codex"] });
    });

    test(`${platform}: a lost tool confirmation retries the original ticket without another policy write`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789aa3"; let recover = false;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 202, body: { ticket } }; },
        [`GET ${URL}/api/ui-requests/${ticket}`]: () => recover ? { body: f.apply(f.puts[0]) } : { status: 503, body: { error: "offline" } } });
      await member(app, platform); await choose(app, platform, "cli-reporter", "inherit"); await app.waitFor("id:cli-reporter-retry");
      expect(app.shows("text:/Selection not confirmed: Use team default/")).toBe(true);
      recover = true; await app.press("id:cli-reporter-retry"); await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.puts).toHaveLength(1); expect(f.policy(true).configured).toBe(null);
    });

    test(`${platform}: a downgraded primary rejects the policy guard and retains the exact reset selection`, async () => {
      const f = fixture(); f.current = { clis: { agents: { reporter: ["codex"] } } };
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 400, body: { error: "Choose supported settings to change" } }; } });
      await member(app, platform); await app.press("id:cli-reporter-reset"); await app.waitFor("id:cli-reporter-retry");
      expect(app.shows("text:/Selection not confirmed: Restore file setting/")).toBe(true); expect(f.policy(true).configured).toEqual(["codex"]);
      await app.press("id:cli-reporter-retry"); await app.waitUntil(() => f.puts.length === 2);
      expect(f.puts[0]).toEqual({ tool_policy_version: 1, clis: { reset: ["agents.reporter"] } }); expect(f.puts[1]).toEqual(f.puts[0]);
    });

    test(`${platform}: a later successful tool selection clears only its superseded policy error`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789aa5"; let memberWrites = 0, release = false, polls = 0;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => {
        const body = JSON.parse(r.body); f.puts.push(body);
        if (Object.hasOwn(body.clis, "preference")) return { status: 400, body: { error: "Team order could not be saved" } };
        if (++memberWrites === 1) return { status: 202, body: { ticket } };
        return { body: f.apply(body) };
      }, [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; return release ? { status: 400, body: { error: "Earlier member order could not be saved" } } : { status: 202, body: { ticket } }; } });
      await choose(app, platform, "team-tools", "claude"); await app.waitFor("Team order could not be saved"); await member(app, platform);
      await choose(app, platform, "cli-reporter", "claude"); await app.waitUntil(() => polls > 0);
      await choose(app, platform, "cli-reporter", "codex"); release = true; await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.policy(true).configured).toEqual(["codex"]); expect(app.shows("Earlier member order could not be saved")).toBe(false);
      expect(app.shows("Team order could not be saved")).toBe(true);
      if (platform === "ios") await app.back();
      expect(app.shows("id:team-tools-retry")).toBe(true);
    });

    test(`${platform}: a stale successful response cannot confirm a changed tool policy`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789aa4"; let recover = false, polls = 0;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 202, body: { ticket } }; },
        [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; return { body: recover ? f.apply(f.puts[0]) : f.view() }; } });
      await member(app, platform); await choose(app, platform, "cli-reporter", "inherit");
      await app.waitFor("Couldn't confirm this task tool setting. Retry the same selection or reopen Settings to reload confirmed policy.");
      expect(app.shows("id:cli-reporter-retry")).toBe(true); expect(f.policy(true).configured).toEqual(["hermes", "claude"]);
      recover = true; await app.press("id:cli-reporter-retry"); await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.puts).toHaveLength(1); expect(polls).toBe(2); expect(f.policy(true).configured).toBe(null);
    });

    test(`${platform}: explicitly discarding an unconfirmed tool selection releases only its stale ticket`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789aa6"; let polls = 0;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => {
        const body = JSON.parse(r.body); f.puts.push(body);
        if (Object.hasOwn(body.clis, "preference")) return { status: 400, body: { error: "Keep this unrelated team selection" } };
        return f.puts.filter((put) => put.clis.agents).length === 1 ? { status: 202, body: { ticket } } : { body: f.apply(body) };
      }, [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; return { body: f.view() }; } });
      await choose(app, platform, "team-tools", "claude"); await app.waitFor("Keep this unrelated team selection"); await member(app, platform);
      await choose(app, platform, "cli-reporter", "inherit"); await app.waitFor("id:cli-reporter-discard");
      app.onDialog((dialog) => dialog.title === "Discard unconfirmed selection?" ? "Discard selection" : "Keep selection");
      await app.press("id:cli-reporter-discard"); await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.policy(true).configured).toEqual(["hermes", "claude"]); expect(app.shows("Keep this unrelated team selection")).toBe(true);
      await choose(app, platform, "cli-reporter", "inherit"); await app.waitUntil(() => f.policy(true).configured === null);
      expect(f.puts).toHaveLength(3); expect(f.puts[2]).toEqual(f.puts[1]); expect(polls).toBe(1);
      if (platform === "ios") await app.back(); expect(app.shows("id:team-tools-retry")).toBe(true);
    });
  }

  test("an empty cloud settings snapshot explains main-machine setup and preserves the last valid view", async () => {
    const f = fixture(); let ready = false;
    const app = await open("./App.tsx", { storage: STORAGE, platform: "macos", width: 1200, height: 900,
      network: { ...f.network, [`GET ${URL}/api/settings`]: () => ({ body: ready ? f.view() : { current: {}, effective: {}, options: {} } }) } });
    await app.waitFor("id:composer"); await app.press("id:settings"); await app.press("id:settings-tab-members");
    await app.waitFor("Connect the main machine to load team settings, then reopen Settings."); expect(app.shows("id:cli-reporter")).toBe(false);
    ready = true; await app.press("label:Main chat"); await app.press("id:settings"); await app.waitFor("id:cli-reporter");
    ready = false; await app.press("label:Main chat"); await app.press("id:settings"); await app.waitFor("Connect the main machine to load team settings, then reopen Settings.");
    expect(app.shows("id:cli-reporter")).toBe(true); expect(f.puts).toHaveLength(0);
  });

  for (const legacy of [false, true]) {
    test(`narrow desktop keeps member names and ${legacy ? "legacy" : "rich"} tool controls accessible`, async () => {
      const f = fixture(); f.legacy = legacy;
      const app = await open("./App.tsx", { storage: STORAGE, platform: "macos", width: 900, height: 900,
        network: { ...f.network, [`GET ${URL}/api/members/reporter`]: { body: { id: "reporter", title: "Reporter", instructions: "Check the facts." } } } });
      await app.press("id:settings"); await app.press("id:settings-tab-members"); await app.waitFor("Reporter");
      await choose(app, "macos", "cli-reporter", "codex"); await app.waitUntil(() => f.puts.length === 1); expect(app.shows("Reporter")).toBe(true);
      await app.press("id:autonomy-reporter"); await app.press("id:autonomy-reporter-assisted"); await app.waitUntil(() => f.puts.length === 2);
      await app.press("id:member-edit-reporter"); await app.waitFor("id:member-editor"); expect(app.value("id:member-title")).toBe("Reporter");
    });
  }
});

describe("member autonomy policies", () => {
  function fixture() {
    const f = { team: "assisted" as AutonomyLevel, file: "autonomous" as AutonomyLevel | null, fileSource: "local_file" as AutonomyPolicy["file_source"],
      invalidFile: false, version: 1 as number | undefined, malformed: false, current: {} as any, raw: undefined as any, puts: [] as any[] };
    const policy = (): AutonomyPolicy => {
      const values = f.current.autonomy?.agents, overridden = !!values && Object.hasOwn(values, "reporter");
      const invalid = f.invalidFile && !overridden, configured = overridden ? values.reporter as AutonomyLevel | null : f.invalidFile ? "onboarding" : f.file;
      return { configured, effective: invalid ? "onboarding" : configured ?? f.team, source: overridden ? "ui" : f.fileSource,
        file_default: f.invalidFile ? "onboarding" : f.file, file_source: f.fileSource, ...(invalid ? { invalid: true } : {}), ...(f.invalidFile ? { file_invalid: true } : {}) };
    };
    const tools = (member: boolean): ToolPolicy => {
      const configured = (member ? f.current.clis?.agents?.reporter : f.current.clis?.preference) ?? ["claude"];
      return { configured, effective: configured, source: "ui", file_default: ["claude"], file_source: "shared_file" };
    };
    const view = () => {
      const p = policy();
      return JSON.parse(JSON.stringify({ current: f.raw ?? f.current, effective: { primary_host: "mac", enabled_clis: ["claude", "codex"], autonomy: f.team, max_parallel: 2, projects: [], routines: [],
        tool_policy: { version: 1, team: tools(false) }, ...(f.version !== undefined ? { autonomy_policy_version: f.version } : {}), agents: [{ id: "reporter", title: "Reporter", clis: tools(true).effective, tool_policy: tools(true), autonomy: p.effective,
          autonomy_inherited: p.configured === null && !p.invalid, ...(f.version !== undefined ? { autonomy_policy: f.malformed ? { ...p, configured: "constructor" } : p } : {}) }] },
        options: { clis: providerOrders(["claude", "codex"]), autonomy: ["onboarding", "assisted", "autonomous"] } }));
    };
    const apply = (body: any) => {
      if (body.autonomy?.agents) { f.current.autonomy ??= {}; f.current.autonomy.agents = { ...f.current.autonomy.agents, ...body.autonomy.agents }; }
      if (body.autonomy?.reset?.includes("agents.reporter")) delete f.current.autonomy?.agents?.reporter;
      if (body.clis?.agents) { f.current.clis ??= {}; f.current.clis.agents = { ...f.current.clis.agents, ...body.clis.agents }; }
      return view();
    };
    const network = { ...hub([]), [`GET ${URL}/api/settings`]: () => ({ body: view() }),
      [`GET ${URL}/api/members/reporter`]: { body: { id: "reporter", title: "Reporter", instructions: "Check the facts." } },
      [`PUT ${URL}/api/settings`]: (r: any) => { const body = JSON.parse(r.body); f.puts.push(body); return { body: apply(body) }; } };
    return Object.assign(f, { policy, view, apply, network });
  }
  async function page(f: ReturnType<typeof fixture>, platform: "macos" | "ios", extra: Record<string, any> = {}, width = 1200) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : width, height: platform === "ios" ? 844 : 1000, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer");
    if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:member-reporter"); await app.waitFor("id:phone-member"); }
    else { await app.press("id:settings"); await app.press("id:settings-tab-members"); await app.waitFor("id:autonomy-reporter"); }
    return app;
  }
  async function choose(app: Awaited<ReturnType<typeof open>>, platform: "macos" | "ios", choice: string) {
    if (platform === "macos") await app.press("id:autonomy-reporter");
    await app.press(`id:autonomy-reporter-${choice}`);
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: member autonomy inheritance and restoring local files remain distinct`, async () => {
      const f = fixture(), app = await page(f, platform);
      await app.waitFor("text:/Main machine's local configuration file · Autonomous/"); await app.waitFor("Main machine reports Autonomous.");
      expect(app.shows("text:/Owner-requested tasks still run; tool permissions remain separate/")).toBe(true);
      await choose(app, platform, "inherit"); await app.waitUntil(() => f.puts.length === 1);
      expect(f.puts[0]).toEqual({ autonomy_policy_version: 1, autonomy: { agents: { reporter: null } } });
      await app.waitFor("Main machine reports Assisted from the team default."); await app.press("id:autonomy-reporter-reset"); await app.waitUntil(() => f.puts.length === 2);
      expect(f.puts[1]).toEqual({ autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } });
      await app.waitFor("Main machine reports Autonomous."); expect(f.policy()).toMatchObject({ configured: "autonomous", source: "local_file" });
      expect(app.shows("text:/Other machines use their own files after a reset/")).toBe(true);
      await choose(app, platform, "autonomous"); await app.waitUntil(() => f.puts.length === 3);
      expect(f.puts[2]).toEqual({ autonomy_policy_version: 1, autonomy: { agents: { reporter: "autonomous" } } }); await app.waitFor("Saved UI setting · Autonomous");
    });

    test(`${platform}: invalid autonomy metadata stays conservative despite contradictory raw preferences`, async () => {
      const f = fixture(); f.invalidFile = true; f.team = "autonomous"; f.raw = { autonomy: { agents: { reporter: "autonomous" } } };
      const app = await page(f, platform); await app.waitFor("The saved autonomy setting is invalid. This member uses Learning until it is repaired.");
      expect(app.enabled("id:autonomy-reporter-reset")).toBe(false); expect(app.shows("id:choice-check-autonomy-reporter-autonomous")).toBe(false);
      await choose(app, platform, "assisted"); await app.waitFor("Main machine reports Assisted.");
      expect(f.policy().configured).toBe("assisted"); expect(app.enabled("id:autonomy-reporter-reset")).toBe(false);
      expect(app.shows("Main machine reports Autonomous.")).toBe(false);
    });

    test(`${platform}: old hubs retain legacy autonomy choices without raw preference overlays`, async () => {
      const f = fixture(); f.version = undefined; f.file = "onboarding"; f.raw = { autonomy: { agents: { reporter: "constructor" } } };
      const app = await page(f, platform); await app.waitFor("id:autonomy-reporter-unsupported"); expect(app.shows("id:autonomy-reporter-reset")).toBe(false);
      if (platform === "ios") expect(app.shows("id:choice-check-autonomy-reporter-onboarding")).toBe(true);
      else expect(app.shows("label:Autonomy: Learning")).toBe(true);
      await choose(app, platform, "assisted"); await app.waitUntil(() => f.puts.length === 1);
      expect(f.puts[0]).toEqual({ autonomy: { agents: { reporter: "assisted" } } }); expect(f.policy().effective).toBe("assisted");
    });

    test(`${platform}: unknown autonomy capability or malformed metadata cannot enable file resets`, async () => {
      const f = fixture(); f.version = 2;
      const app = await page(f, platform); await app.waitFor("id:autonomy-reporter-unsupported"); expect(app.shows("id:autonomy-reporter-reset")).toBe(false);
      f.version = 1; f.malformed = true;
      if (platform === "ios") { await app.back(); await app.back(); await app.press("id:settings-top"); await app.press("id:member-reporter"); }
      else { await app.press("label:Main chat"); await app.press("id:settings"); }
      await app.waitFor("id:autonomy-reporter-unsupported"); expect(app.shows("id:autonomy-reporter-reset")).toBe(false); expect(f.puts).toHaveLength(0);
    });

    test(`${platform}: later autonomy edits stay pending while earlier confirmation updates only the confirmed level`, async () => {
      const f = fixture(), tickets = ["12345678-1234-1234-1234-123456789ba1", "12345678-1234-1234-1234-123456789ba2"];
      const release = [false, false], polls = [0, 0], results: any[] = [];
      const routes: Record<string, any> = { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 202, body: { ticket: tickets[f.puts.length - 1] } }; } };
      tickets.forEach((ticket, index) => { routes[`GET ${URL}/api/ui-requests/${ticket}`] = () => { polls[index]++; return !release[index] ? { status: 202, body: { ticket } } : { body: results[index] ??= f.apply(f.puts[index]) }; }; });
      const app = await page(f, platform, routes); await choose(app, platform, "onboarding"); await app.waitUntil(() => polls[0] > 0);
      await choose(app, platform, "assisted"); await app.waitFor("text:/Saving selection: Assisted/"); expect(f.puts).toHaveLength(1); expect(app.shows("Main machine reports Autonomous.")).toBe(true);
      release[0] = true; await app.waitUntil(() => polls[1] > 0); await app.waitFor("Main machine reports Learning."); expect(app.shows("text:/Saving selection: Assisted/")).toBe(true);
      release[1] = true; await app.waitUntil(() => !app.shows("id:autonomy-reporter-pending")); await app.waitFor("Main machine reports Assisted.");
      expect(f.puts).toEqual([{ autonomy_policy_version: 1, autonomy: { agents: { reporter: "onboarding" } } }, { autonomy_policy_version: 1, autonomy: { agents: { reporter: "assisted" } } }]);
    });

    test(`${platform}: lost autonomy confirmation retries its exact ticket across navigation`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789ba3"; let recover = false;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 202, body: { ticket } }; },
        [`GET ${URL}/api/ui-requests/${ticket}`]: () => recover ? { body: f.apply(f.puts[0]) } : { status: 503, body: { error: "offline" } } });
      await choose(app, platform, "inherit"); await app.waitFor("id:autonomy-reporter-retry");
      if (platform === "ios") { await app.back(); await app.press("id:member-reporter"); } else { await app.press("label:Main chat"); await app.press("id:settings"); }
      await app.waitFor("id:autonomy-reporter-retry"); recover = true; await app.press("id:autonomy-reporter-retry"); await app.waitUntil(() => !app.shows("id:autonomy-reporter-pending"));
      expect(f.puts).toHaveLength(1); expect(f.policy().configured).toBe(null);
    });

    test(`${platform}: stale autonomy success stays unconfirmed until explicit discard permits a fresh request`, async () => {
      const f = fixture(), ticket = "12345678-1234-1234-1234-123456789ba4"; let polls = 0;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { const body = JSON.parse(r.body); f.puts.push(body); return f.puts.length === 1 ? { status: 202, body: { ticket } } : { body: f.apply(body) }; },
        [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; return { body: f.view() }; } });
      await choose(app, platform, "inherit"); await app.waitFor("Couldn't confirm this member autonomy setting. Retry the same selection or reopen Settings to reload confirmed policy.");
      expect(f.policy().configured).toBe("autonomous"); await app.press("id:autonomy-reporter-retry"); await app.waitUntil(() => polls === 2); expect(f.puts).toHaveLength(1);
      app.onDialog((d) => d.title === "Discard unconfirmed selection?" ? "Discard selection" : "Keep selection"); await app.press("id:autonomy-reporter-discard"); await app.waitUntil(() => !app.shows("id:autonomy-reporter-pending"));
      await choose(app, platform, "inherit"); await app.waitUntil(() => f.policy().configured === null); expect(f.puts).toHaveLength(2); expect(f.puts[1]).toEqual(f.puts[0]);
    });

    test(`${platform}: a downgraded primary cannot silently accept autonomy file reset`, async () => {
      const f = fixture(); f.current = { autonomy: { agents: { reporter: "onboarding" } } };
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => { f.puts.push(JSON.parse(r.body)); return { status: 400, body: { error: "Choose supported settings to change" } }; } });
      await app.press("id:autonomy-reporter-reset"); await app.waitFor("id:autonomy-reporter-retry"); expect(app.shows("text:/Selection not confirmed: Restore file setting/")).toBe(true);
      await app.press("id:autonomy-reporter-retry"); await app.waitUntil(() => f.puts.length === 2);
      expect(f.puts[0]).toEqual({ autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } }); expect(f.puts[1]).toEqual(f.puts[0]); expect(f.policy().configured).toBe("onboarding");
    });

    for (const kind of ["autonomy", "tools"] as const) {
      test(`${platform}: choosing ${kind} A again after confirmed B never reuses A's earlier uncertain ticket`, async () => {
        const f = fixture(), ticket = "12345678-1234-1234-1234-123456789ba5"; let earlier: any, recovered = false, polls = 0;
        const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => {
          const body = JSON.parse(r.body); f.puts.push(body); const result = f.apply(body);
          if (f.puts.length === 1) { earlier = result; return { status: 202, body: { ticket } }; }
          return { body: result };
        }, [`GET ${URL}/api/ui-requests/${ticket}`]: () => { polls++; return recovered ? { body: earlier } : { status: 503, body: { error: "lost reply" } }; } });
        const pick = async (value: string) => {
          if (kind === "autonomy") await choose(app, platform, value);
          else { if (platform === "macos") await app.press("id:cli-reporter"); await app.press(`id:cli-reporter-${value}`); }
        };
        const a = kind === "autonomy" ? "onboarding" : "", b = kind === "autonomy" ? "autonomous" : "claude", base = kind === "autonomy" ? "autonomy-reporter" : "cli-reporter";
        await pick(a); await app.waitFor(`id:${base}-retry`); await pick(b); await app.waitUntil(() => !app.shows(`id:${base}-pending`));
        recovered = true; await pick(a); await app.waitUntil(() => !app.shows(`id:${base}-pending`));
        expect(f.puts).toHaveLength(3); expect(f.puts[2]).toEqual(f.puts[0]); expect(polls).toBe(1);
        if (kind === "autonomy") expect(f.policy().configured).toBe("onboarding"); else expect(f.current.clis.agents.reporter).toEqual([]);
      });
    }

    test(`${platform}: discarding autonomy uncertainty preserves another policy's recovery ticket and error`, async () => {
      const f = fixture(), toolTicket = "12345678-1234-1234-1234-123456789ba6", autonomyTicket = "12345678-1234-1234-1234-123456789ba7";
      let toolResult: any, toolRecover = false, toolPolls = 0;
      const app = await page(f, platform, { [`PUT ${URL}/api/settings`]: (r: any) => {
        const body = JSON.parse(r.body); f.puts.push(body);
        if (body.clis) { toolResult = f.apply(body); return { status: 202, body: { ticket: toolTicket } }; }
        return { status: 202, body: { ticket: autonomyTicket } };
      }, [`GET ${URL}/api/ui-requests/${toolTicket}`]: () => { toolPolls++; return toolRecover ? { body: toolResult } : { status: 503, body: { error: "tool confirmation lost" } }; },
        [`GET ${URL}/api/ui-requests/${autonomyTicket}`]: () => ({ body: f.view() }) });
      if (platform === "macos") await app.press("id:cli-reporter"); await app.press("id:cli-reporter-"); await app.waitFor("id:cli-reporter-retry");
      await choose(app, platform, "inherit"); await app.waitFor("id:autonomy-reporter-discard");
      app.onDialog((d) => d.title === "Discard unconfirmed selection?" ? "Discard selection" : "Keep selection"); await app.press("id:autonomy-reporter-discard");
      await app.waitUntil(() => !app.shows("id:autonomy-reporter-pending")); expect(app.shows("id:cli-reporter-retry")).toBe(true);
      expect(app.shows("Connection lost while confirming. Try saving again to check the same request.")).toBe(true);
      toolRecover = true; await app.press("id:cli-reporter-retry"); await app.waitUntil(() => !app.shows("id:cli-reporter-pending"));
      expect(f.puts).toHaveLength(2); expect(toolPolls).toBe(2);
    });
  }

  test("narrow desktop autonomy provenance keeps member names, tool controls and editing accessible", async () => {
    const f = fixture(); f.file = null; f.fileSource = "default";
    const app = await page(f, "macos", {}, 900); await app.waitFor("Reporter"); expect(app.shows("text:/Built-in default · Use team default/" )).toBe(true);
    await choose(app, "macos", "assisted"); await app.waitFor("Saved UI setting · Assisted"); expect(app.shows("Reporter")).toBe(true);
    await app.press("id:cli-reporter"); await app.press("id:cli-reporter-codex"); await app.waitUntil(() => f.puts.length === 2);
    await app.press("id:member-edit-reporter"); await app.waitFor("id:member-editor"); expect(app.value("id:member-title")).toBe("Reporter");
  });
});

describe("machine learning controls", () => {
  function fixture() {
    const host = "linux-box", endpoint = `${URL}/api/machines/${host}/learning`, scope = intentScope(URL, "tok"), digest = "a".repeat(64);
    const documents = new Map<string, string>(), receipts = new Map<string, LearningRunResult>(), calls: { body: any; saved: PendingEntry[] }[] = [], inspections: string[] = [];
    const f = { statusCode: 200, blocked: null as string | null, pending: undefined as LearningPending | undefined, previewBody: undefined as any, statusReads: 0, previews: 0, starts: 0,
      counts: { turns: 3, sessions: 2, truncated: true }, runReply: undefined as ((body: any) => any) | undefined, storageFails: false, writeBlock: undefined as (() => Promise<void>) | undefined };
    const entries = () => JSON.parse(documents.get(scope) ?? '{"entries":[]}').entries as PendingEntry[];
    const store = (entries: PendingEntry[]) => documents.set(scope, JSON.stringify({ version: 1, scope, entries }));
    const handlers = { pendingRead: (args: any) => ({ scope: args.scope, text: documents.get(args.scope) ?? null }),
      pendingWrite: async (args: any) => { if (f.writeBlock) await f.writeBlock(); if (f.storageFails) throw new Error("Fixture storage unavailable"); if ((documents.get(args.scope) ?? null) !== args.expected) throw new Error("Fixture CAS conflict"); documents.set(args.scope, args.text); return { scope: args.scope, saved: true }; } };
    const apply = (body: any) => {
      const previous = receipts.get(body.request_id); if (previous) return { ...previous, replayed: true };
      f.starts++; const result: LearningRunResult = { host, request_id: body.request_id, preview_digest: body.preview_digest, id: f.counts.turns ? "T-W0801" : null, applied: true, replayed: false, ...f.counts };
      receipts.set(body.request_id, result); f.pending = undefined; return result;
    };
    const network = { ...hub([]),
      [`GET ${URL}/api/machines/${host}`]: { body: { host, enabled: true, max_parallel: 2, caps: [] } },
      [`GET ${endpoint}`]: () => { f.statusReads++; return f.statusCode === 200 ? { body: { host, learning_api: 1, sources: ["codex"], blocked_reason: f.blocked, ...(f.pending ? { pending: f.pending } : {}) } }
        : { status: f.statusCode, body: { error: f.statusCode === 503 ? `${host} is offline. Reconnect that machine; no other machine will run this collection.` : "Update this machine" } }; },
      [`POST ${endpoint}/preview`]: (r: any) => { expect(JSON.parse(r.body)).toEqual({}); f.previews++; return { body: f.previewBody ?? { host, preview_digest: digest, sources: ["codex"], ...f.counts } }; },
      [`POST ${endpoint}/run`]: (r: any) => {
        const body = JSON.parse(r.body); calls.push({ body, saved: entries() }); const special = f.runReply?.(body); if (special) return special;
        if (body.confirm_only && !receipts.has(body.request_id)) return { status: 404, body: { error: "No saved learning receipt", host, request_id: body.request_id, preview_digest: body.preview_digest } };
        return { body: apply(body) };
      },
      [`GET ${URL}/api/tasks/get?*`]: (r: any) => { const id = new ParsedURL(r.url).searchParams.get("id")!; inspections.push(id); return { body: { id, title: "Learning fixture", agent: "apprentice", state: "inbox", request: "Fixture learning task" } }; },
    };
    return Object.assign(f, { host, endpoint, scope, digest, documents, receipts, calls, inspections, entries, store, handlers, apply, network });
  }
  async function page(f: ReturnType<typeof fixture>, platform: "macos" | "ios", extra: Record<string, any> = {}) {
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform, width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 1000,
      host: { handlers: f.handlers }, network: { ...f.network, ...extra } });
    await app.waitFor("id:composer"); if (platform === "ios") await app.press("label:Menu");
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.waitFor("id:learning-controls"); return app;
  }
  for (const platform of ["macos", "ios"] as const) {
    test(`${platform}: machine learning reads status passively and runs only its saved count preview`, async () => {
      const f = fixture(), app = await page(f, platform); await app.waitFor("id:learning-preview");
      expect(f.statusReads).toBe(1); expect(f.previews).toBe(0); expect(f.calls).toHaveLength(0); expect(app.enabled("id:learning-run")).toBe(false);
      await app.press("id:learning-preview"); await app.waitFor("id:learning-preview-counts"); await app.waitFor("text:/Counts describe the full prepared collection/");
      expect(f.previews).toBe(1); expect(f.calls).toHaveLength(0); await app.press("id:learning-run"); await app.waitFor("text:/Learning task T-W0801 queued on linux-box/");
      expect(f.calls).toHaveLength(1); const call = f.calls[0]; expect(call.body.preview_digest).toBe(f.digest); expect(call.saved[0].kind).toBe("learning");
      expect(call.saved[0].request.request_id).toBe(call.body.request_id); expect((call.saved[0] as Extract<PendingEntry, { kind: "learning" }>).preview).toMatchObject({ host: f.host, ...f.counts });
      expect(f.starts).toBe(1); expect(f.entries()).toHaveLength(0); await app.waitUntil(() => app.enabled("id:learning-inspect")); await app.press("id:learning-inspect");
      await app.waitUntil(() => f.inspections.length > 0); expect(f.inspections.every((id) => id === "T-W0801")).toBe(true);
    });

    test(`${platform}: old or offline workers explain learning availability without falling back to another host`, async () => {
      const f = fixture(); f.statusCode = 409; const app = await page(f, platform); await app.waitFor("id:learning-unsupported");
      expect(app.shows("id:learning-preview")).toBe(false); f.statusCode = 503; await app.press("id:learning-refresh"); await app.waitFor(`${f.host} is offline. Reconnect that machine; no other machine will run this collection.`);
      expect(f.previews).toBe(0); expect(f.calls).toHaveLength(0); expect(f.entries()).toHaveLength(0);
    });

    test(`${platform}: a stale learning success cannot clear its authorization and Check never starts a second task`, async () => {
      const f = fixture(); let wrong = true;
      f.runReply = (body) => { const result = f.apply(body); return { body: wrong ? { ...result, turns: result.turns + 1 } : result }; };
      const app = await page(f, platform); await app.press("id:learning-preview"); await app.press("id:learning-run");
      await app.waitFor("Couldn't confirm this learning run. Check the saved run before authorizing another one."); const entry = f.entries()[0]; expect(entry.kind).toBe("learning");
      wrong = false; await app.press("id:learning-check"); await app.waitFor("Earlier learning run confirmed. Inspect the task to check its current state.");
      expect(f.calls[1].body).toEqual({ ...entry.request, confirm_only: true }); expect(f.starts).toBe(1); expect(f.entries()).toHaveLength(0);
    });

    test(`${platform}: server-reported unfinished learning is reviewed into recovery without reading history`, async () => {
      const f = fixture(), request = { request_id: "12345678-1234-1234-1234-123456789ca1", preview_digest: f.digest };
      f.pending = { ...request, id: "T-W0801", sources: ["codex"], ...f.counts }; f.blocked = "An unfinished collection needs review.";
      f.receipts.set(request.request_id, { ...request, host: f.host, id: "T-W0801", applied: true, replayed: true, ...f.counts });
      const app = await page(f, platform); await app.waitFor("id:learning-server-pending"); expect(f.calls).toHaveLength(0); expect(f.previews).toBe(0); expect(f.entries()).toHaveLength(0);
      await app.press("id:learning-adopt"); await app.waitFor("id:learning-check"); expect(f.calls).toHaveLength(0); expect(f.entries()[0].request).toEqual(request);
      await app.press("id:learning-check"); await app.waitFor("Earlier learning run confirmed. Inspect the task to check its current state."); expect(f.calls[0].body).toEqual({ ...request, confirm_only: true }); expect(f.starts).toBe(0);
    });
  }

  test("a learning preview cannot contain another host or private history paths", async () => {
    const f = fixture(); f.previewBody = { host: "mac", preview_digest: f.digest, sources: ["codex"], ...f.counts };
    const app = await page(f, "macos"); await app.press("id:learning-preview"); await app.waitFor("Couldn't verify a count-only learning preview for this machine. Refresh status and try again.");
    expect(app.enabled("id:learning-run")).toBe(false); f.previewBody = { host: f.host, preview_digest: f.digest, sources: ["codex"], ...f.counts, path: "/private/history" };
    await app.press("id:learning-preview"); await app.waitFor("Couldn't verify a count-only learning preview for this machine. Refresh status and try again.");
    expect(app.shows("text:/private\/history/")).toBe(false); expect(f.calls).toHaveLength(0); expect(f.entries()).toHaveLength(0);
  });

  test("a different local learning authorization blocks adoption until explicit local forgetting", async () => {
    const f = fixture(), oldId = "12345678-1234-1234-1234-123456789ca2", nextId = "12345678-1234-1234-1234-123456789ca3";
    f.store([{ kind: "learning", key: f.host, at: "2026-11-06T12:00:00.000Z", request: { request_id: oldId, preview_digest: f.digest },
      preview: { host: f.host, preview_digest: f.digest, sources: ["codex"], ...f.counts } }]);
    f.pending = { request_id: nextId, preview_digest: "b".repeat(64), id: "T-W0802", sources: ["codex"], ...f.counts }; f.blocked = "An unfinished collection needs review.";
    const app = await page(f, "macos"); await app.waitFor("id:learning-pending-conflict"); expect(app.enabled("id:learning-adopt")).toBe(false); expect(f.entries()[0].request.request_id).toBe(oldId);
    app.onDialog((d) => d.title === "Forget this saved learning run?" ? "Forget saved run" : "Keep saved run"); await app.press("id:learning-forget"); await app.waitUntil(() => app.enabled("id:learning-adopt"));
    await app.press("id:learning-adopt"); await app.waitFor("id:learning-check"); expect(f.entries()[0].request.request_id).toBe(nextId); expect(f.calls).toHaveLength(0); expect(f.previews).toBe(0);
  });

  test("Noop owner turns can be reviewed and run with zero provider sessions", async () => {
    const f = fixture(); f.counts = { turns: 4, sessions: 0, truncated: false }; f.previewBody = { host: f.host, preview_digest: f.digest, sources: ["noop"], ...f.counts };
    const app = await page(f, "macos"); await app.press("id:learning-preview"); await app.waitFor("Reviewed sources: Noop chat and decisions"); await app.waitFor("text:/4 owner turns · 0 provider sessions/");
    expect(app.enabled("id:learning-run")).toBe(true); await app.press("id:learning-run"); await app.waitFor("text:/Learning task T-W0801 queued/"); expect(f.starts).toBe(1);
  });

  test("leaving a slow learning preview cannot restore it into a later visit", async () => {
    const f = fixture(), ticket = "12345678-1234-1234-1234-123456789ca4"; let release = false, polls = 0;
    const app = await page(f, "macos", { [`POST ${f.endpoint}/preview`]: () => ({ status: 202, body: { ticket } }),
      [`GET ${URL}/api/machine-requests/${ticket}`]: () => { polls++; return release ? { body: { host: f.host, preview_digest: f.digest, sources: ["codex"], ...f.counts } } : { status: 202, body: { ticket } }; } });
    await app.press("id:learning-preview"); await app.waitUntil(() => polls > 0); await app.press("label:Main chat");
    await app.press("label:Load 42% · Disk 120GB · 1 running"); await app.waitFor("id:learning-preview"); release = true; await app.wait(1200);
    expect(app.shows("id:learning-preview-counts")).toBe(false); expect(app.enabled("id:learning-run")).toBe(false); expect(f.calls).toHaveLength(0);
  });

  test("learning waits for the recovery write acknowledgement before posting its run", async () => {
    const f = fixture(), app = await page(f, "macos"); await app.press("id:learning-preview");
    let entered = false, release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.writeBlock = async () => { entered = true; await barrier; };
    const pressing = app.press("id:learning-run"); await app.waitUntil(() => entered); expect(f.calls).toHaveLength(0); expect(f.entries()).toHaveLength(0);
    f.writeBlock = undefined; release(); await pressing; await app.waitFor("text:/Learning task T-W0801 queued/");
    expect(f.calls[0].saved[0].request.request_id).toBe(f.calls[0].body.request_id);
  });

  test("a rejected recovery write sends no learning request and keeps the reviewed preview", async () => {
    const f = fixture(), app = await page(f, "macos"); await app.press("id:learning-preview"); f.storageFails = true;
    await app.press("id:learning-run"); await app.waitFor("text:/Could not update saved requests safely/");
    expect(f.calls).toHaveLength(0); expect(f.entries()).toHaveLength(0); expect(app.shows("id:learning-preview-counts")).toBe(true); expect(app.enabled("id:learning-run")).toBe(false);
  });

  test("a main-machine change remounts learning before an earlier machine's preview can arrive", async () => {
    const ticket = "12345678-1234-1234-1234-123456789ca5", digest = "a".repeat(64); let host = "mac", release = false, polls = 0;
    const values = Object.fromEntries(CONFIGURATION_FIELDS.map((field) => [field.path, field.default])), statusHosts: string[] = [];
    const app = await open("./App.tsx", { storage: { ...STORAGE, "hub.notifyAsked": "1" }, platform: "macos", width: 1200, height: 1000, network: {
      ...hub([]), [`GET ${URL}/api/configuration`]: () => ({ body: { values, overrides: [], learning: { host, blocked_reason: null } } }),
      [`GET ${URL}/api/machines/mac/learning`]: () => { statusHosts.push("mac"); return { body: { host: "mac", learning_api: 1, sources: ["codex"], blocked_reason: null } }; },
      [`GET ${URL}/api/machines/worker/learning`]: () => { statusHosts.push("worker"); return { body: { host: "worker", learning_api: 1, sources: ["codex"], blocked_reason: null } }; },
      [`POST ${URL}/api/machines/mac/learning/preview`]: () => ({ status: 202, body: { ticket } }),
      [`GET ${URL}/api/machine-requests/${ticket}`]: () => { polls++; return release ? { body: { host: "mac", preview_digest: digest, sources: ["codex"], turns: 9, sessions: 3, truncated: false } } : { status: 202, body: { ticket } }; },
    } });
    await app.press("id:settings"); await app.press("id:settings-tab-onboarding"); await app.waitFor("id:learning-preview"); await app.press("id:learning-preview"); await app.waitUntil(() => polls > 0);
    host = "worker"; await app.press("id:configuration-reload-saved"); await app.waitFor("Learning on worker"); await app.waitFor("id:learning-preview"); release = true; await app.wait(1200);
    expect(statusHosts).toEqual(["mac", "worker"]); expect(app.shows("id:learning-preview-counts")).toBe(false); expect(app.enabled("id:learning-run")).toBe(false);
  });
});
