import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskFormResult, readTaskReopenPreview, type TaskCreateRequest, type TaskReopenRequest, type TaskRunSettings } from "../cloud/src/task-forms";
import { initUiRequests, recordPath, uiRequestRoute } from "../cloud/src/ui-requests";
import { appendTaskFollowUp } from "../src/cli";
import { DATA, HOME_DIR, P, claim, list, loadConfig, readDoc, writeDoc } from "../src/core";
import { receiveMessage } from "../src/message-receipts";
import { createProject, readProject } from "../src/projects";
import { drainInbound, handleOwnerMessage, recordRequest, setOwnerTask } from "../src/server";
import { setSyncData, setTransport } from "../src/sync";
import { applyUiRequest } from "../src/ui-requests";

const host = "task-form-main", id = "T-M0950", io = { pull: async () => true, push: async () => true };
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://hub${path}`, {
  method, ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
});
const settings = (): TaskRunSettings => ({ title: "Owner configured task", agent: "lead", cli: "auto", host: "any", requires: "", priority: "high", prefer: "", weight: "normal", project: "" });
const creation = (): TaskCreateRequest => ({ request_id: crypto.randomUUID(), instructions: "Keep these owner instructions.", settings: settings() });
let folder = "";
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null); setOwnerTask(async () => {});
  drainInbound();
  for (const name of ["tasks", "projects", "agents", "fleet", "journal", "decisions"]) rmSync(P(name), { recursive: true, force: true });
  mkdirSync(P("agents/lead"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\nFollow the owner's instructions.\n");
  writeFileSync(P("config.toml"), `[host]\nname='${host}'\n[fleet]\nprimary='${host}'\n[clis]\nenabled=['claude','codex','hermes']\n`);
  rmSync(P("config.local.toml"), { force: true }); rmSync(P("settings.json"), { force: true });
  folder = realpathSync(mkdtempSync(join(tmpdir(), "noop-task-form-api-")));
});
afterEach(() => { setOwnerTask(async () => {}); drainInbound(); setSyncData(DATA, HOME_DIR); setTransport(null); rmSync(folder, { recursive: true, force: true }); rmSync(P("fleet/task-ids"), { recursive: true, force: true }); });
function terminal(state: "done" | "failed" | "rejected" = "rejected", change: Record<string, unknown> = {}) {
  writeDoc(P("tasks", state, `${id}.md`), { id, title: "Earlier task", agent: "lead", cli: "codex", host: "old-worker", requires: "os:linux", priority: "low", prefer: "gpu", weight: "heavy",
    created: "2026-01-01T00:00:00Z", claimed_by: "old-worker", run_host: "old-worker", run_id: crypto.randomUUID(), started: "2026-01-01T01:00:00Z", finished: "2026-01-01T02:00:00Z",
    ...(state === "rejected" ? { cancelled: "2026-01-01T02:00:00Z" } : {}), attempt: "3", children: "T-M0951", wake_at: "2026-01-02T00:00:00Z", waiting_on: "Old result", wait_check: "false", ...change },
    "Original owner instructions.\n\n## Run 2026-01-01T02:00:00Z · old-worker · codex\n**done** — Earlier result.\n");
}
async function preview() {
  const response = await recordRequest(request("/api/tasks/reopen-preview", { id }), io); expect(response.status).toBe(200);
  const result = readTaskReopenPreview(await response.json()); expect(result).toBeDefined(); return result!;
}
const reopening = (digest: string): TaskReopenRequest => ({ request_id: crypto.randomUUID(), id, preview_digest: digest, instructions: "Continue with these revised instructions.", settings: settings() });

test("task lifecycle routes validate methods and exact form fields before any refresh", async () => {
  expect(recordPath("/api/tasks/create")).toEqual({ kind: "task-create" }); expect(recordPath("/api/tasks/reopen-preview")).toEqual({ kind: "task-reopen-preview" }); expect(recordPath("/api/tasks/reopen")).toEqual({ kind: "task-reopen" });
  expect(recordPath("/api/tasks/reopen/extra")).toBeNull();
  let pulls = 0; const checked = { ...io, pull: async () => { pulls++; return true; } };
  for (const path of ["/api/tasks/create", "/api/tasks/reopen-preview", "/api/tasks/reopen"]) for (const method of ["GET", "PUT", "DELETE"])
    expect((await recordRequest(request(path, {}, method), checked)).status).toBe(405);
  for (const path of ["/api/tasks/create", "/api/tasks/reopen-preview", "/api/tasks/reopen"])
    expect((await recordRequest(request(`${path}?confirm_only=true`, {}, "POST"), checked)).status).toBe(400);
  const create = creation();
  for (const body of [null, [], {}, { ...create, request_id: "old" }, { ...create, instructions: "" }, { ...create, id }, { ...create, confirm_only: false },
    { ...create, settings: { ...create.settings, repo: folder } }, { ...create, settings: { ...create.settings, project: "__current__" } }, { ...create, settings: { ...create.settings, host: "../worker" } }])
    expect((await recordRequest(request("/api/tasks/create", body), checked)).status).toBe(400);
  for (const body of [{ id: "../../task" }, { id, context: {} }, []]) expect((await recordRequest(request("/api/tasks/reopen-preview", body), checked)).status).toBe(400);
  for (const body of [creation(), { ...reopening("a".repeat(64)), preview_digest: "old" }, { ...reopening("a".repeat(64)), run_id: crypto.randomUUID() }])
    expect((await recordRequest(request("/api/tasks/reopen", body), checked)).status).toBe(400);
  expect(pulls).toBe(0); expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("creation saves chosen run settings and instructions before queuing work", async () => {
  const input = creation(); input.settings = { ...input.settings, title: "Run on Mac", cli: "hermes", host, requires: "os:macos", prefer: "gpu", weight: "heavy", priority: "urgent" };
  const response = await recordRequest(request("/api/tasks/create", input), io), result = await response.json() as any;
  expect(response.status).toBe(200); expect(result.ok).toBe(true); expect(readTaskFormResult(result)).toMatchObject({ action: "create", request_id: input.request_id, applied: true, replayed: false });
  const { project: _, ...chosen } = input.settings;
  const doc = readDoc(P("tasks/inbox", `${result.id}.md`)); expect(doc.meta).toMatchObject({ ...chosen, source: "owner@ui", origin: "owner", form_request: input.request_id }); expect(doc.meta.planned).toBeTruthy(); expect(doc.body).toContain(input.instructions);
  expect(list(P("tasks/active"))).toHaveLength(0);
});

test("selected project snapshots must match the latest authoritative project before a task is created", async () => {
  const projectId = createProject({ name: "Selected site", path: folder, instructions: "Project guidance", requires: "os:macos" }, host), project = readProject(projectId);
  const input = creation(); input.settings = { ...input.settings, project: projectId, host: project.host, requires: project.requires.join(","), project_guard: { host: project.host, path: project.path, requires: project.requires } };
  const path = P("projects", `${projectId}.md`), doc = readDoc(path); writeDoc(path, { ...doc.meta, host: "other-worker" }, doc.body);
  expect((await recordRequest(request("/api/tasks/create", input), io)).status).toBe(409); expect(list(P("tasks/inbox"))).toHaveLength(0);
  writeDoc(path, doc.meta, doc.body);
  const response = await recordRequest(request("/api/tasks/create", input), io), result = await response.json() as any; expect(response.status).toBe(200);
  expect(readDoc(P("tasks/inbox", `${result.id}.md`)).meta).toMatchObject({ project: projectId, host, repo: project.path, requires: "os:macos" });
});

test("reopening a cancelled task preserves its identity and conversation while clearing the prior run state", async () => {
  terminal(); const view = await preview(); expect(view).toMatchObject({ id, state: "cancelled", can_reopen: true });
  const input = reopening(view.digest), response = await recordRequest(request("/api/tasks/reopen", input), io), result = await response.json() as any;
  expect(response.status).toBe(200); expect(result).toMatchObject({ ok: true, id, action: "reopen", request_id: input.request_id, applied: true }); expect(existsSync(P("tasks/rejected", `${id}.md`))).toBe(false);
  const doc = readDoc(P("tasks/inbox", `${id}.md`)); expect(doc.meta).toMatchObject({ id, title: input.settings.title, agent: "lead", host: "any", cli: "auto", form_request: input.request_id });
  expect(doc.body).toContain("Original owner instructions"); expect(doc.body).toContain("Earlier result"); expect(doc.body).toContain(input.instructions);
  for (const field of ["run_id", "run_host", "claimed_by", "started", "finished", "cancelled", "attempt", "children", "wake_at", "waiting_on", "wait_check"]) expect(doc.meta[field]).toBeUndefined();
});

test("a stale terminal preview, duplicate task copies and pending cleanup cannot reopen work", async () => {
  terminal(); const view = await preview(), path = P("tasks/rejected", `${id}.md`), doc = readDoc(path);
  writeDoc(path, doc.meta, `${doc.body}\nLater owner correction`); expect((await recordRequest(request("/api/tasks/reopen", reopening(view.digest)), io)).status).toBe(409);
  expect(list(P("tasks/inbox"))).toHaveLength(0);
  const batch = { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [{ id: "T-M0951", error: "Unknown run" }] };
  terminal("rejected", { pending_stops: JSON.stringify(batch) }); const stopping = await preview(); expect(stopping.can_reopen).toBe(false);
  expect((await recordRequest(request("/api/tasks/reopen", reopening(stopping.digest)), io)).status).toBe(409);
  writeDoc(P("tasks/active", `${id}.md`), { id, title: "Conflicting copy", agent: "lead", run_id: crypto.randomUUID(), claimed_by: host }, "Current work");
  expect((await recordRequest(request("/api/tasks/reopen-preview", { id }), io)).status).toBe(409);
});

test("failed refresh and worker routes cannot create or reopen tasks", async () => {
  terminal(); const input = creation(), reopen = reopening((await preview()).digest);
  for (const pull of [async () => false, async () => { throw new Error("offline"); }]) for (const [path, body] of [["/api/tasks/create", input], ["/api/tasks/reopen-preview", { id }], ["/api/tasks/reopen", reopen]] as const)
    expect((await recordRequest(request(path, body), { ...io, pull })).status).toBe(503);
  writeFileSync(P("config.toml"), `[host]\nname='worker'\n[fleet]\nprimary='${host}'\n`);
  for (const [path, body] of [["/api/tasks/create", input], ["/api/tasks/reopen-preview", { id }], ["/api/tasks/reopen", reopen]] as const)
    expect((await recordRequest(request(path, body), io)).status).toBe(409);
  expect(list(P("tasks/inbox"))).toHaveLength(0); expect(existsSync(P("tasks/rejected", `${id}.md`))).toBe(true);
});

test("partial create confirmation reuses its task after claim, completion and later deletion without creating work again", async () => {
  const input = creation(), partial = await recordRequest(request("/api/tasks/create", input), { ...io, push: async () => false }), body = await partial.json() as any;
  expect(partial.status).toBe(503); expect(body).toMatchObject({ ok: false, saved_locally: true, request_id: input.request_id, applied: true });
  const taskId = body.id, active = await claim(P("tasks/inbox", `${taskId}.md`), "worker"); expect(active).toBeTruthy(); const claimed = readFileSync(active!, "utf8");
  let confirmed = await recordRequest(request("/api/tasks/create", { ...input, confirm_only: true }), io); expect(confirmed.status).toBe(200); expect(await confirmed.json()).toMatchObject({ id: taskId, replayed: true }); expect(readFileSync(active!, "utf8")).toBe(claimed);
  mkdirSync(P("tasks/done"), { recursive: true }); renameSync(active!, P("tasks/done", `${taskId}.md`)); rmSync(P("tasks/done", `${taskId}.md`));
  confirmed = await recordRequest(request("/api/tasks/create", { ...input, confirm_only: true }), io); expect(confirmed.status).toBe(200); expect(list(P("tasks/inbox"))).toHaveLength(0); expect(list(P("tasks/active"))).toHaveLength(0);
  const reordered = { settings: Object.fromEntries(Object.entries(input.settings).reverse()), instructions: input.instructions, request_id: input.request_id, confirm_only: true };
  expect((await recordRequest(request("/api/tasks/create", reordered), io)).status).toBe(200);
  expect((await recordRequest(request("/api/tasks/create", { ...input, instructions: "Different intent", confirm_only: true }), io)).status).toBe(409);
});

test("reopen confirmation never requeues the task's replacement run, and unknown confirmation requests change nothing", async () => {
  terminal(); const input = reopening((await preview()).digest);
  expect((await recordRequest(request("/api/tasks/reopen", { ...input, confirm_only: true }), io)).status).toBe(404); expect(existsSync(P("tasks/rejected", `${id}.md`))).toBe(true);
  const partial = await recordRequest(request("/api/tasks/reopen", input), { ...io, push: async () => { throw new Error("offline"); } }); expect(partial.status).toBe(503); expect(await partial.json()).toMatchObject({ id, request_id: input.request_id, applied: true, saved_locally: true });
  const active = await claim(P("tasks/inbox", `${id}.md`), "worker"), before = readFileSync(active!, "utf8"), runId = readDoc(active!).meta.run_id;
  const confirmed = await recordRequest(request("/api/tasks/reopen", { ...input, confirm_only: true }), io); expect(confirmed.status).toBe(200); expect(await confirmed.json()).toMatchObject({ id, replayed: true, action: "reopen" }); expect(readFileSync(active!, "utf8")).toBe(before); expect(readDoc(active!).meta.run_id).toBe(runId); expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("a failed task authorization returns pending metadata without claiming an applied action", async () => {
  const input = creation(), receipt = P("fleet/task-forms", `${input.request_id}.json`), rename = fs.renameSync;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === receipt) throw new Error("fixture receipt failed"); return rename(from, to); });
  let response: Response;
  try { response = await recordRequest(request("/api/tasks/create", input), io); } finally { failure.mockRestore(); }
  const body = await response!.json() as any;
  expect(response!.status).toBe(503); expect(body).toMatchObject({ ok: false, pending: true, uncertain: true, action: "create", request_id: input.request_id }); expect(body.id).toMatch(/^T-/); expect(body.applied).toBeUndefined(); expect(body.replayed).toBeUndefined(); expect(list(P("tasks/inbox"))).toHaveLength(0);
  const confirmation = await recordRequest(request("/api/tasks/create", { ...input, confirm_only: true }), io), pending = await confirmation.json() as any;
  expect(confirmation.status).toBe(503); expect(pending).toMatchObject({ ok: false, pending: true, id: body.id, request_id: input.request_id }); expect(pending.applied).toBeUndefined(); expect(list(P("tasks/inbox"))).toHaveLength(0);
  expect((await recordRequest(request("/api/tasks/create", { ...input, instructions: "Changed orphan intent", confirm_only: true }), io)).status).toBe(409);
});

test("a prepared receipt can confirm an installed task after claim but cannot recreate it after deletion", async () => {
  for (const remove of [false, true]) {
    const input = creation(), receipt = P("fleet/task-forms", `${input.request_id}.json`), rename = fs.renameSync; let writes = 0;
    const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === receipt && ++writes === 2) throw new Error("fixture applied receipt failed"); return rename(from, to); });
    let partial: Response;
    try { partial = await recordRequest(request("/api/tasks/create", input), io); } finally { failure.mockRestore(); }
    const body = await partial!.json() as any; expect(partial!.status).toBe(503); expect(body).toMatchObject({ applied: true, uncertain: true, request_id: input.request_id });
    const active = await claim(P("tasks/inbox", `${body.id}.md`), "worker"), before = readFileSync(active!, "utf8");
    if (remove) rmSync(active!);
    const confirmed = await recordRequest(request("/api/tasks/create", input), io), result = await confirmed.json() as any;
    expect(confirmed.status).toBe(remove ? 503 : 200);
    if (remove) expect(result).toMatchObject({ ok: false, pending: true, uncertain: true, id: body.id });
    else { expect(result).toMatchObject({ ok: true, applied: true, replayed: true, id: body.id }); expect(readFileSync(active!, "utf8")).toBe(before); }
    expect(list(P("tasks/inbox"))).toHaveLength(0);
  }
});

test("host-tagged task replies retain explicit thread context and cancelled threads return a durable readable conflict before brain or attachments", async () => {
  const calls: unknown[] = []; setOwnerTask(async (text, options) => { calls.push([text, options]); });
  await expect(handleOwnerMessage("New work", "T-invalid", false, { thread: true })).rejects.toThrow("valid task thread"); expect(calls).toHaveLength(0);
  await handleOwnerMessage("Owner follow-up", "T-WORK-0001", false, { thread: true }); expect(calls).toEqual([["Owner follow-up", { reply: "T-WORK-0001", answered: undefined, sentAt: undefined, thread: true }]]);
  terminal(); let downloads = 0, applied = 0; const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), from: "owner", kind: "owner" as const, text: "Continue please", ref: id, thread: true };
  const send = () => receiveMessage(`cancelled-thread-${event.id}`, "task-thread-request", event, () => event, async () => {
    applied++; await handleOwnerMessage(event.text, id, false, { thread: true, paths: ["/media/fixture.png"], fetch: async () => { downloads++; return new Uint8Array([1]); } });
  });
  const rejected = await send(); expect(rejected).toMatchObject({ status: 409, data: { message_id: event.id, ok: false } }); expect(String(rejected.data.error)).toContain("Reopen task"); expect(rejected.data.uncertain).toBeUndefined();
  expect(await send()).toEqual(rejected); expect(applied).toBe(1); expect(calls).toHaveLength(1); expect(downloads).toBe(0); expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("checked daemon follow-ups reject cancelled, missing and stopping tasks without creating alternatives or publishing a false success", async () => {
  terminal(); let pushes = 0; const checked = { ...io, push: async () => { pushes++; return true; } };
  for (const taskId of [id, "T-M9999"]) { const result = await appendTaskFollowUp(loadConfig(), host, taskId, "Do more work", checked); expect(result.ok).toBe(false); expect(result.error).toBeTruthy(); }
  writeDoc(P("tasks/active/T-M0951.md"), { id: "T-M0951", title: "Stopping child", agent: "lead", stop_intent: "broken" }, "Original child instructions");
  const before = readFileSync(P("tasks/active/T-M0951.md"), "utf8");
  const stopping = await appendTaskFollowUp(loadConfig(), host, "T-M0951", "Late owner instruction", checked); expect(stopping.ok).toBe(false); expect(readFileSync(P("tasks/active/T-M0951.md"), "utf8")).toBe(before); expect(pushes).toBe(0); expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("checked follow-ups preserve queued host-tagged task identity and queue an existing decision answer", async () => {
  writeDoc(P("tasks/inbox", `${id}.md`), { id, title: "Existing task", agent: "lead" }, "Original instructions");
  const appended = await appendTaskFollowUp(loadConfig(), host, id, "Keep this correction", io); expect(appended).toMatchObject({ ok: true, id }); expect(list(P("tasks/inbox"))).toHaveLength(1); expect(readDoc(P("tasks/inbox", `${id}.md`)).body).toContain("Keep this correction");
  rmSync(P("tasks/inbox", `${id}.md`)); writeDoc(P("tasks/blocked", `${id}.md`), { id, title: "Existing decision", agent: "lead", decision: "D-M0950" }, "Original blocked instructions"); writeDoc(P("decisions/open/D-M0950.md"), { id: "D-M0950", task: id }, "Choose A or B");
  const answered = await appendTaskFollowUp(loadConfig(), host, id, "A", io); expect(answered).toMatchObject({ ok: true, id, queued: true }); expect(drainInbound()).toMatchObject([{ id: "D-M0950", answer: "A" }]); expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("cloud admission and result upload replay preserve exact task settings and execute a lost result only once", async () => {
  const db = new Database(":memory:");
  try {
    const sql = { exec(query: string, ...bindings: any[]) { let rows: any[] = []; for (const part of query.split(";").map((text) => text.trim()).filter(Boolean)) { const stmt = db.query(part); if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings); } return { toArray: () => rows }; } };
    initUiRequests(sql); const inbox: unknown[] = [], host = { online: () => true, supported: () => true, enqueue: (item: unknown) => inbox.push(item) };
    const call = (path: string, body?: unknown, method = "POST", who: "machine" | { session: string } = { session: "owner" }) => uiRequestRoute(sql, request(path, body, method), who, host);
    for (const path of ["/api/tasks/create", "/api/tasks/reopen-preview", "/api/tasks/reopen"]) {
      expect((await call(path, {}, "GET"))?.status).toBe(405); expect((await call(path, {}))?.status).toBe(400); expect((await call(path, {}, "POST", "machine"))?.status).toBe(403);
      expect((await call(`${path}?confirm_only=true`, {}))?.status).toBe(400);
    }
    expect(inbox).toHaveLength(0); const input = creation(), start = (await call("/api/tasks/create", input))!; expect(start.status).toBe(202); const ticket = (await start.json() as any).ticket;
    let lost = true, executions = 0; const results = new Map();
    const send = async (path: string, init: RequestInit) => { if (init.method === "PUT" && lost) { lost = false; return null; } const response = await uiRequestRoute(sql, new Request(`http://hub${path}`, init), "machine", host); return response?.ok ? response.json() : null; };
    const route = async (req: Request) => { executions++; expect(await req.clone().json()).toEqual(input); return recordRequest(req, io); };
    await expect(applyUiRequest(ticket, send, route, results)).rejects.toThrow("confirm"); await applyUiRequest(ticket, send, route, results); expect(executions).toBe(1);
    const confirmed = (await call(`/api/ui-requests/${ticket}`, undefined, "GET"))!; expect(confirmed.status).toBe(200); expect(confirmed.headers.get("X-Noop-Confirmed")).toBe("1"); expect(readTaskFormResult(await confirmed.json())).toMatchObject({ action: "create", request_id: input.request_id }); expect(list(P("tasks/inbox"))).toHaveLength(1);
  } finally { db.close(); }
});
