import { describe, expect, open, test, type App, type Dialog, type StubRequest, type StubResponse } from "nsh/test";
import { URL as ParsedURL } from "url";
import { createPendingStore, intentScope, readPendingEntry, type PendingEntry } from "./pending-intents";
import type { TaskRunSettings } from "../cloud/src/task-forms";
import type { StopResolveRequest } from "../cloud/src/stop-intents";

const HUB = "http://saved.test:8787", TOKEN = "saved-fixture-session", SCOPE = intentScope(HUB, TOKEN);
const AT = "2026-11-06T12:00:00.000Z", DIGEST = "a".repeat(64), OTHER = "b".repeat(64);
const uuid = (index: number) => `12345678-1234-1234-1234-${index.toString(16).padStart(12, "0")}`;
const run = (): TaskRunSettings => ({ title: "Recover the exact task", agent: "lead", cli: "claude", host: "any", requires: "", priority: "normal", prefer: "", weight: "normal", project: "" });
function create(): Extract<PendingEntry, { kind: "task" }> {
  return { kind: "task", key: "create", at: AT, known_id: "T-M0701", request: { request_id: uuid(1), instructions: "Keep the original creation", settings: run() } };
}
function reopen(): Extract<PendingEntry, { kind: "task" }> {
  return { kind: "task", key: "T-M0001", at: AT, known_id: "T-M0001", request: { request_id: uuid(2), id: "T-M0001", preview_digest: DIGEST, instructions: "Keep the original reopening", settings: run() },
    preview: { id: "T-M0001", digest: DIGEST, state: "cancelled", can_reopen: true, conflicts: [], warnings: [], settings: run(), request: "Earlier work" } };
}
function archive(): Extract<PendingEntry, { kind: "archive" }> {
  return { kind: "archive", key: DIGEST, at: AT, request: { request_id: uuid(3), key: DIGEST, digest: OTHER, project: { host: "offline-worker", path: "/offline/repo" } },
    preview: { entry: { key: DIGEST, kind: "projects", id: "repo", name: "Offline project", archived_at: AT, files: 1, bytes: 100 }, digest: OTHER, can_restore: true, conflicts: [], warnings: [],
      project: { id: "repo", name: "Offline project", host: "offline-worker", path: "/offline/repo", instructions: "Preserve project settings", repo: null, requires: [] } } };
}
function stop(): Extract<PendingEntry, { kind: "stop" }> {
  const request: StopResolveRequest = { owner: { kind: "plan", id: "PL-0001" }, operation_id: uuid(10), target_id: "T-M0002", preview_digest: DIGEST, action: "exclude", reason: "Reviewed the missing original target", request_id: uuid(4) };
  return { kind: "stop", key: "plan:PL-0001", at: AT, request, preview: { owner: request.owner, operation_id: request.operation_id, target_id: request.target_id, preview_digest: DIGEST,
    target: { kind: "unresolved", id: request.target_id }, current: { state: "missing", records: [] }, can_include: false } };
}
function learning(): Extract<PendingEntry, { kind: "learning" }> {
  return { kind: "learning", key: "offline-worker", at: AT, request: { request_id: uuid(5), preview_digest: DIGEST }, known_id: "T-W0801",
    preview: { host: "offline-worker", preview_digest: DIGEST, sources: ["codex"], turns: 3, sessions: 2, truncated: true } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function storage(entries: PendingEntry[] = []) {
  const documents = new Map<string, string>();
  if (entries.length) documents.set(SCOPE, JSON.stringify({ version: 1, scope: SCOPE, entries }));
  const writes: { scope: string; text: string; expected: string | null }[] = [];
  let mode: "ok" | "fail" | "ambiguous" | "fail-clear" = "ok";
  let barrier: (() => Promise<void>) | undefined;
  const handlers = {
    pendingRead: (args: any) => ({ scope: args.scope, text: documents.get(args.scope) ?? null }),
    pendingWrite: async (args: any) => {
      writes.push(args);
      if ((documents.get(args.scope) ?? null) !== args.expected) throw new Error("Saved requests changed in another context");
      if (barrier) await barrier();
      if (mode === "fail" || mode === "fail-clear" && JSON.parse(args.text).entries.length === 0) throw new Error("Fixture storage unavailable");
      documents.set(args.scope, args.text);
      if (mode === "ambiguous") throw new Error("Fixture lost storage acknowledgement");
      return { scope: args.scope, saved: true };
    },
  };
  return { documents, writes, handlers, entries: () => JSON.parse(documents.get(SCOPE) ?? '{"entries":[]}').entries as PendingEntry[],
    mode: (value: typeof mode) => { mode = value; }, barrier: (value?: () => Promise<void>) => { barrier = value; } };
}
function fixture(cache = storage()) {
  const posts: { path: string; body: any; saved: PendingEntry[] }[] = [], inspections: string[] = [];
  const tasks = new Map<string, any>([
    ["T-M0001", { id: "T-M0001", title: "Earlier cancelled task", agent: "lead", state: "cancelled", configured_cli: "claude", target_host: "any", request: "Earlier work", updated: AT }],
    ["T-M0701", { id: "T-M0701", title: "Original created task", agent: "lead", state: "inbox", configured_cli: "claude", target_host: "any", request: "Original creation", updated: AT }],
  ]);
  const effective = { primary_host: "mac", agents: [{ id: "lead", title: "Lead", clis: ["claude"], autonomy: "assisted" }], projects: [], routines: [], enabled_clis: ["claude"], autonomy: "assisted", max_parallel: 2, media_days: 7 };
  let serial = 701, probes = 0;
  let override: ((path: string, body: any) => StubResponse | undefined) | undefined;
  const post = (path: string, r: StubRequest): StubResponse => {
    const body = JSON.parse(r.body!); posts.push({ path, body, saved: cache.entries() });
    const special = override?.(path, body); if (special) return special;
    if (/\/learning\/(?:run|discard)$/.test(path)) {
      const entry = cache.entries().find((e): e is Extract<PendingEntry, { kind: "learning" }> => e.kind === "learning" && e.request.request_id === body.request_id) ?? learning();
      const identity = { host: entry.key, request_id: body.request_id, preview_digest: body.preview_digest, id: entry.known_id ?? "T-W0801", replayed: true };
      return { body: path.endsWith("discard") ? { ...identity, discarded: true } : { ...identity, applied: true, turns: entry.preview.turns, sessions: entry.preview.sessions, truncated: entry.preview.truncated } };
    }
    if (path === "/api/archive/restore") return { body: { ok: true, key: body.key, digest: body.digest, request_id: body.request_id, kind: "projects", id: "repo", restored: true, replayed: true, warnings: [] } };
    if (path === "/api/stops/resolve") return { body: { ok: true, ...body, id: body.owner.id, review_id: body.request_id,
      review: { ...body, review_id: body.request_id, at: AT, original: { kind: "unresolved", id: body.target_id }, reviewed: { state: "missing", records: [] }, request_hash: OTHER },
      plan: { id: body.owner.id, status: "cancelled" }, cleanup: { operation_id: body.operation_id, remaining: 0, pending: [], unresolved: [] } } };
    const action = path.endsWith("reopen") ? "reopen" : "create", id = action === "reopen" ? body.id : body.request_id === uuid(1) ? "T-M0701" : `T-M${String(++serial).padStart(4, "0")}`;
    if (!body.confirm_only) tasks.set(id, { id, ...body.settings, configured_cli: body.settings.cli, target_host: body.settings.host, state: "inbox", request: body.instructions, updated: AT });
    return { body: { ok: true, request_id: body.request_id, action, id, applied: true, replayed: body.confirm_only === true, warnings: [] } };
  };
  const network: Record<string, StubResponse | ((request: StubRequest) => StubResponse | Promise<StubResponse>)> = {
    [`GET ${HUB}/api/feed`]: { body: { events: [] } }, [`GET ${HUB}/api/feed?*`]: { body: { events: [] } },
    [`GET ${HUB}/api/status`]: () => ({ body: { tasks: { proposed: 0, inbox: 1, active: 0, waiting: 0, blocked: 0, failed: 0, done: 0 }, active: [], decisions: [], recent: [...tasks.values()],
      hosts: [{ host: "mac", caps: ["os:macos", "cli:claude"], online: true, enabled: true, busy: 0 }], offline_hosts: [] } }),
    [`GET ${HUB}/api/settings`]: { body: { current: {}, effective, options: { clis: [["claude"]], autonomy: ["assisted"] } } },
    [`GET ${HUB}/api/tasks?*`]: () => ({ body: { tasks: [...tasks.values()], total: tasks.size } }),
    [`GET ${HUB}/api/tasks/get?*`]: (r: StubRequest) => { const id = new ParsedURL(r.url).searchParams.get("id")!; inspections.push(id); return { body: tasks.get(id) ?? { id, title: "Fixture task", agent: "lead", state: "done", request: "Fixture", updated: AT } }; },
    [`POST ${HUB}/api/tasks/create`]: (r: StubRequest) => post("/api/tasks/create", r),
    [`POST ${HUB}/api/tasks/reopen`]: (r: StubRequest) => post("/api/tasks/reopen", r),
    [`POST ${HUB}/api/archive/restore`]: (r: StubRequest) => post("/api/archive/restore", r),
    [`POST ${HUB}/api/stops/resolve`]: (r: StubRequest) => post("/api/stops/resolve", r),
    [`POST ${HUB}/api/machines/offline-worker/learning/run`]: (r: StubRequest) => post("/api/machines/offline-worker/learning/run", r),
    [`POST ${HUB}/api/machines/offline-worker/learning/discard`]: (r: StubRequest) => post("/api/machines/offline-worker/learning/discard", r),
    [`POST ${HUB}/api/tasks/reopen-preview`]: () => { probes++; return { body: reopen().preview }; },
    [`POST ${HUB}/api/machines/*/project-folder-check`]: () => { probes++; return { status: 503, body: { error: "The fixture worker is offline" } }; },
  };
  return { cache, network, posts, tasks, inspections, probes: () => probes, override: (value: typeof override) => { override = value; } };
}
async function launch(f: ReturnType<typeof fixture>, platform: "macos" | "ios" = "macos", token = TOKEN) {
  const app = await open("./App.tsx", { storage: { "hub.url": HUB, "hub.token": token, "hub.notifyAsked": "1" }, platform,
    width: platform === "ios" ? 390 : 1200, height: platform === "ios" ? 844 : 900, host: { handlers: f.cache.handlers }, network: f.network });
  await app.waitFor("id:composer"); return app;
}
async function saved(app: App, platform: "macos" | "ios" = "macos") {
  if (app.shows("id:saved-requests-banner")) await app.press("id:saved-requests-banner");
  else if (platform === "ios") { await app.press("id:settings-top"); await app.press("id:settings-saved"); }
  else { await app.press("id:settings"); await app.press("id:settings-tab-saved"); }
  await app.waitFor("id:saved-requests-page");
}
async function newTask(app: App, platform: "macos" | "ios" = "macos") {
  if (platform === "ios") await app.press("label:Menu");
  await app.press("label:All tasks"); await app.waitFor("id:task-new"); await app.press("id:task-new"); await app.waitFor("id:task-form-instructions");
}
async function fill(app: App) {
  await app.clear("id:task-title"); await app.type("id:task-title", "Fresh reviewed task");
  await app.clear("id:task-form-instructions"); await app.type("id:task-form-instructions", "Only the freshly reviewed instructions");
}

describe("saved request recovery", () => {
  for (const platform of ["macos", "ios"] as const) test(`${platform}: restart hydrates all supported requests without sending them and confirms an exact task receipt`, async () => {
    const entries = [create(), reopen(), archive(), stop(), learning()], f = fixture(storage(entries));
    const first = await launch(f, platform); await saved(first, platform);
    for (const entry of entries) expect(first.shows(`id:saved-request-${entry.request.request_id}`)).toBe(true);
    expect(f.posts).toHaveLength(0); expect(f.probes()).toBe(0); first.dispose();
    const second = await launch(f, platform); await saved(second, platform); expect(f.posts).toHaveLength(0);
    const entry = platform === "macos" ? create() : reopen();
    await second.press(`id:saved-request-${entry.request.request_id}`); await second.press("id:saved-request-check");
    await second.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(f.posts.map((p) => p.body)).toEqual([{ ...entry.request, confirm_only: true }]); expect(f.probes()).toBe(0);
    expect(f.cache.entries().map((e) => e.request.request_id)).not.toContain(entry.request.request_id);
  });

  test("completed project restoration confirms after restart with its worker offline and no fresh folder probe", async () => {
    const entry = archive(), f = fixture(storage([entry])), app = await launch(f); await saved(app);
    await app.press(`id:saved-request-${entry.request.request_id}`); await app.press("id:saved-request-check");
    await app.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(f.posts[0].body).toEqual({ ...entry.request, confirm_only: true }); expect(f.probes()).toBe(0); expect(f.cache.entries()).toHaveLength(0);
  });

  test("cleanup recovery warns before a manual retry and confirms authorization without claiming a process stopped", async () => {
    const entry = stop(), f = fixture(storage([entry])), app = await launch(f); await saved(app);
    await app.press(`id:saved-request-${entry.request.request_id}`); expect(app.shows("id:saved-request-check")).toBe(false);
    const dialogs: Dialog[] = []; app.onDialog((d) => { dialogs.push(d); return "Back"; });
    await app.press("id:saved-request-retry"); await app.waitUntil(() => dialogs.length === 1);
    expect(dialogs[0].message).toContain("may be applied now"); expect(f.posts).toHaveLength(0);
    app.onDialog(() => "Retry same decision"); await app.press("id:saved-request-retry");
    await app.waitFor("Earlier cleanup decision confirmed. This does not prove that the task was stopped.");
    expect(f.posts.map((p) => p.body)).toEqual([entry.request]); expect(f.cache.entries()).toHaveLength(0); expect(app.shows("Task stopped")).toBe(false);
  });

  test("write-ahead storage acknowledgement is awaited before a new task HTTP request", async () => {
    const f = fixture(), app = await launch(f); await newTask(app); await fill(app);
    const entered = deferred(), release = deferred(); f.cache.barrier(async () => { entered.resolve(); await release.promise; });
    const pressing = app.press("id:task-form-submit"); await entered.promise;
    expect(f.posts).toHaveLength(0); expect(f.cache.entries()).toHaveLength(0);
    f.cache.barrier(); release.resolve(); await pressing; await app.waitFor("Task created with these run settings.");
    expect(f.posts).toHaveLength(1); expect(f.posts[0].saved[0].request.request_id).toBe(f.posts[0].body.request_id);
  });

  test("storage rejection sends no HTTP and preserves the unsent task draft", async () => {
    const f = fixture(), app = await launch(f); await newTask(app); await fill(app); f.cache.mode("fail");
    await app.press("id:task-form-submit"); await app.waitFor("text:/Could not update saved requests safely/");
    expect(f.posts).toHaveLength(0); expect(f.cache.entries()).toHaveLength(0);
    expect(app.value("id:task-form-instructions")).toBe("Only the freshly reviewed instructions");
    expect(app.enabled("id:task-form-submit")).toBe(false);
  });

  test("committed but rejected storage acknowledgement reloads as the same manual authorization", async () => {
    const f = fixture(), app = await launch(f); await newTask(app); await fill(app); f.cache.mode("ambiguous");
    await app.press("id:task-form-submit"); await app.waitFor("text:/Could not update saved requests safely/");
    expect(f.posts).toHaveLength(0); const original = f.cache.entries()[0]; expect(original.kind).toBe("task");
    await app.press("id:task-form-close"); f.cache.mode("ok"); await saved(app); await app.press("id:saved-requests-reload");
    await app.waitFor(`id:saved-request-${original.request.request_id}`); expect(f.posts).toHaveLength(0);
    await app.press(`id:saved-request-${original.request.request_id}`); await app.press("id:saved-request-retry");
    await app.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(f.posts[0].body).toEqual(original.request); expect(f.cache.entries()).toHaveLength(0);
  });

  test("server success with a failed cache clear keeps the original request recoverable after another restart", async () => {
    const entry = create(), f = fixture(storage([entry])); f.cache.mode("fail-clear");
    const first = await launch(f); await saved(first); await first.press(`id:saved-request-${entry.request.request_id}`); await first.press("id:saved-request-check");
    await first.waitFor("text:/local recovery copy could not be cleared/"); expect(f.cache.entries()[0].request.request_id).toBe(entry.request.request_id); first.dispose();
    f.cache.mode("ok"); const second = await launch(f); await saved(second); expect(f.posts).toHaveLength(1);
    await second.press(`id:saved-request-${entry.request.request_id}`); await second.press("id:saved-request-check"); await second.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(f.posts.map((p) => p.body)).toEqual([{ ...entry.request, confirm_only: true }, { ...entry.request, confirm_only: true }]); expect(f.cache.entries()).toHaveLength(0);
  });

  test("a different sign-in cannot load or send the previous session's recovery document", async () => {
    const f = fixture(storage([create()])), raw = f.cache.documents.get(SCOPE);
    const app = await launch(f, "macos", "another-session"); await saved(app);
    await app.waitFor("No unconfirmed requests"); expect(f.posts).toHaveLength(0); expect(f.cache.documents.get(SCOPE)).toBe(raw);
  });

  test("corrupt recovery data needs explicit warned reset before a fresh action can be saved", async () => {
    const f = fixture(); f.cache.documents.set(SCOPE, "{bad-json"); const app = await launch(f); await saved(app);
    await app.waitFor("id:saved-requests-error"); expect(f.posts).toHaveLength(0); expect(f.cache.documents.get(SCOPE)).toBe("{bad-json");
    app.onDialog((d) => d.title === "Reset local saved requests?" ? "Reset local copies" : null);
    await app.press("id:saved-requests-reset"); await app.waitFor("No unconfirmed requests");
    expect(f.posts).toHaveLength(0); expect(f.cache.entries()).toHaveLength(0);
    await newTask(app); await fill(app); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings."); expect(f.posts).toHaveLength(1);
  });

  for (const page of ["form", "saved"] as const) test(`${page}: wrong known task IDs in success and partial replies retain the original Inspect target`, async () => {
    const entry = create(), f = fixture(storage([entry])); let replies = 0;
    f.override((_path, body) => ({ status: ++replies === 1 ? 200 : 503, body: { ok: replies === 1, request_id: body.request_id, action: "create", id: "T-M9999", applied: true, replayed: true, warnings: [],
      ...(replies > 1 ? { saved_locally: true, error: "Wrong task partial fixture" } : {}) } }));
    const app = await launch(f);
    if (page === "form") await newTask(app); else { await saved(app); await app.press(`id:saved-request-${entry.request.request_id}`); }
    const check = page === "form" ? "id:task-form-confirm" : "id:saved-request-check";
    await app.press(check); await app.waitUntil(() => replies === 1); await app.wait(20);
    expect((f.cache.entries()[0] as Extract<PendingEntry, { kind: "task" }>).known_id).toBe(entry.known_id); expect(app.shows(check)).toBe(true);
    await app.press(check); await app.waitFor("Wrong task partial fixture"); expect((f.cache.entries()[0] as Extract<PendingEntry, { kind: "task" }>).known_id).toBe(entry.known_id);
    await app.press(page === "form" ? "id:task-form-open" : "id:saved-request-inspect"); await app.waitUntil(() => f.inspections.length > 0);
    expect(f.inspections.every((id) => id === entry.known_id)).toBe(true); expect(f.cache.entries()[0].request.request_id).toBe(entry.request.request_id);
  });

  test("a late saved-record inspection cannot leave Settings and permits inspection after returning to Saved requests", async () => {
    const entry = create(), f = fixture(storage([entry])), ticket = uuid(90);
    let ready = false, polls = 0;
    f.network[`GET ${HUB}/api/tasks/get?*`] = { status: 202, body: { ticket } };
    f.network[`GET ${HUB}/api/ui-requests/${ticket}`] = () => {
      polls++; return ready ? { body: f.tasks.get(entry.known_id!) } : { status: 202, body: { ticket } };
    };
    const app = await launch(f); await saved(app); await app.press(`id:saved-request-${entry.request.request_id}`);
    await app.press("id:saved-request-inspect"); await app.waitUntil(() => polls >= 2);
    await app.press("id:settings"); await app.waitFor("id:settings-tab-saved"); ready = true; await app.wait(1200);
    expect(app.shows("id:settings-tab-saved")).toBe(true); expect(app.shows("id:task-composer")).toBe(false);
    await app.press("id:settings-tab-saved"); await app.waitFor(`id:saved-request-${entry.request.request_id}`); await app.press(`id:saved-request-${entry.request.request_id}`);
    expect(app.enabled("id:saved-request-inspect")).toBe(true);
    await app.press("id:saved-request-inspect"); await app.waitFor("id:task-composer"); expect(f.posts).toHaveLength(0);
  });

  for (const operation of ["confirm", "forget"] as const) test(`${operation}: recovered creation clears request-bound state before a genuinely fresh creation`, async () => {
    const entry = create(), f = fixture(storage([entry])), app = await launch(f); await saved(app); await app.press(`id:saved-request-${entry.request.request_id}`);
    if (operation === "confirm") { await app.press("id:saved-request-check"); await app.waitFor("Earlier request confirmed. Open the record to check its current state."); }
    else { app.onDialog(() => "Forget saved request"); await app.press("id:saved-request-forget"); await app.waitFor("No unconfirmed requests"); }
    await newTask(app);
    if (operation === "confirm") await app.press("id:task-form-refresh");
    await fill(app); await app.press("id:task-form-submit"); await app.waitFor("Task created with these run settings.");
    const last = f.posts[f.posts.length - 1]; expect(last.body.request_id).not.toBe(entry.request.request_id); expect(last.body.confirm_only).toBe(undefined);
    expect(last.saved[0].kind).toBe("task"); expect((last.saved[0] as Extract<PendingEntry, { kind: "task" }>).known_id).toBe(undefined);
    expect(f.cache.entries()).toHaveLength(0);
  });

  for (const platform of ["macos", "ios"] as const) test(`${platform}: a saved learning run checks only its original worker receipt after restart`, async () => {
    const entry = learning(), f = fixture(storage([entry]));
    const first = await launch(f, platform); await saved(first, platform); expect(f.posts).toHaveLength(0); first.dispose();
    const second = await launch(f, platform); await saved(second, platform); await second.press(`id:saved-request-${entry.request.request_id}`);
    await second.waitFor("text:/Counts describe the full prepared collection/"); await second.press("id:saved-request-check");
    await second.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(f.posts.map((p) => [p.path, p.body])).toEqual([["/api/machines/offline-worker/learning/run", { ...entry.request, confirm_only: true }]]);
    expect(f.posts[0].saved[0]).toEqual(entry); expect(f.probes()).toBe(0); expect(f.cache.entries()).toHaveLength(0);
    await second.press("id:saved-request-inspect"); await second.waitUntil(() => f.inspections.length > 0); expect(f.inspections.every((id) => id === entry.known_id)).toBe(true);
  });

  test("a lost learning release reply can be confirmed after restart without reading or queuing history", async () => {
    const entry = learning(), f = fixture(storage([entry])); let released = false;
    f.override((path, body) => {
      if (path.endsWith("/discard")) { released = true; return { status: 503, body: { error: "Release reply lost", host: entry.key, request_id: body.request_id, preview_digest: body.preview_digest, id: entry.known_id, uncertain: true } }; }
      if (released && path.endsWith("/run")) return { body: { host: entry.key, request_id: body.request_id, preview_digest: body.preview_digest, id: entry.known_id, discarded: true, replayed: true } };
    });
    const first = await launch(f); await saved(first); await first.press(`id:saved-request-${entry.request.request_id}`);
    const dialogs: Dialog[] = []; first.onDialog((d) => { dialogs.push(d); return "Release collection"; });
    await first.press("id:saved-request-release"); await first.waitFor("Release reply lost");
    expect(dialogs[0].message).toContain("leaves tasks and current learning progress unchanged"); expect(f.cache.entries()[0]).toEqual(entry); first.dispose();
    const second = await launch(f); await saved(second); await second.press(`id:saved-request-${entry.request.request_id}`); await second.press("id:saved-request-check");
    await second.waitFor("Earlier collection release confirmed. Tasks and learning progress were left unchanged.");
    expect(f.posts.map((p) => p.path)).toEqual(["/api/machines/offline-worker/learning/discard", "/api/machines/offline-worker/learning/run"]);
    expect(f.posts[1].body).toEqual({ ...entry.request, confirm_only: true }); expect(f.cache.entries()).toHaveLength(0); expect(f.probes()).toBe(0);
  });

  for (const wrong of ["host", "request", "digest", "counts", "task"] as const) test(`learning ${wrong} mismatch cannot clear recovery or retarget Inspect`, async () => {
    const entry = learning(), f = fixture(storage([entry]));
    f.override((_path, body) => ({ body: { host: wrong === "host" ? "mac" : entry.key, request_id: wrong === "request" ? uuid(77) : body.request_id,
      preview_digest: wrong === "digest" ? OTHER : body.preview_digest, id: wrong === "task" ? "T-W9999" : entry.known_id, applied: true, replayed: true,
      turns: wrong === "counts" ? 999 : entry.preview.turns, sessions: entry.preview.sessions, truncated: entry.preview.truncated } }));
    const app = await launch(f); await saved(app); await app.press(`id:saved-request-${entry.request.request_id}`); await app.press("id:saved-request-check");
    await app.waitFor("Couldn't confirm this learning run. Check the saved run before authorizing another one."); expect(f.cache.entries()[0]).toEqual(entry);
    await app.press("id:saved-request-inspect"); await app.waitUntil(() => f.inspections.length > 0); expect(f.inspections.every((id) => id === entry.known_id)).toBe(true);
  });

  test("learning recovery stores only bound public previews and never weakens a known task identity", async () => {
    const entry = learning(), cache = storage([entry]);
    const store = createPendingStore({ read: async () => cache.documents.get(SCOPE) ?? null,
      write: async (text, expected) => { await cache.handlers.pendingWrite({ scope: SCOPE, text, expected }); } }, SCOPE);
    await store.load(); await store.put({ ...entry, known_id: undefined }); expect(store.entries()[0]).toEqual(entry);
    await expect(store.put({ ...entry, known_id: "T-W9999" })).rejects.toMatchObject({ code: "conflict" });
    expect(readPendingEntry({ ...entry, key: "mac" })).toBe(undefined);
    expect(readPendingEntry({ ...entry, request: { ...entry.request, preview_digest: OTHER } })).toBe(undefined);
    expect(readPendingEntry({ ...entry, preview: { ...entry.preview, path: "/private/history" } })).toBe(undefined);
    expect(readPendingEntry({ ...entry, preview: { ...entry.preview, turns: -1 } })).toBe(undefined);
    expect(readPendingEntry({ ...entry, request: { ...entry.request, confirm_only: true } })).toEqual(entry);
  });

  test("an explicit learning check starts a fresh transport attempt while retaining the same domain authorization", async () => {
    const entry = learning(), f = fixture(storage([entry])), firstTicket = uuid(91); let submissions = 0, polls = 0;
    f.network[`POST ${HUB}/api/machines/offline-worker/learning/run`] = (r: StubRequest) => {
      const body = JSON.parse(r.body!); f.posts.push({ path: "/api/machines/offline-worker/learning/run", body, saved: f.cache.entries() });
      if (++submissions === 1) return { status: 202, body: { ticket: firstTicket } };
      return { body: { host: entry.key, ...entry.request, id: entry.known_id, applied: true, replayed: true, turns: entry.preview.turns, sessions: entry.preview.sessions, truncated: entry.preview.truncated } };
    };
    f.network[`GET ${HUB}/api/machine-requests/${firstTicket}`] = () => { polls++; return { status: 503, body: { error: "old transport unavailable" } }; };
    const app = await launch(f); await saved(app); await app.press(`id:saved-request-${entry.request.request_id}`); await app.press("id:saved-request-check");
    await app.waitFor("Connection lost while confirming. Try again to check the same request."); await app.press("id:saved-request-check");
    await app.waitFor("Earlier request confirmed. Open the record to check its current state.");
    expect(submissions).toBe(2); expect(polls).toBe(1); expect(f.posts[0].body).toEqual({ ...entry.request, confirm_only: true }); expect(f.posts[1].body).toEqual(f.posts[0].body);
  });
});
