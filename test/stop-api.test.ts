import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { ActionSyncError } from "../cloud/src/action-errors";
import { recordPath } from "../cloud/src/ui-requests";
import { taskInfo } from "../cloud/src/tools";
import { type PendingStops, type StopOwner } from "../cloud/src/stop-intents";
import { localStore } from "../src/brain";
import { DATA, HOME_DIR, P, readDoc, writeDoc } from "../src/core";
import { type Plan, readPlan, savePlan } from "../src/plans";
import { planRoute, recordRequest, setCancelTask, setStopDrainer, taskView } from "../src/server";
import { setSyncData, setTransport } from "../src/sync";
import { createStopDrainer, type StopDrainResult } from "../src/task-stops";

const host = "api-main", parent = "T-0800", child = "T-0801", planId = "PL-0800";
const io = { pull: async () => true, push: async () => true };
let run_id = "", parent_run = "", batch: PendingStops;
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://hub${path}`, {
  method, ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null); setStopDrainer(null); setCancelTask(async () => "not available");
  for (const dir of ["tasks", "plans", "journal", "agents"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("journal"), { recursive: true }); mkdirSync(P("agents/lead"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead"); writeFileSync(P("config.toml"), `[host]\nname='${host}'\n[fleet]\nprimary='${host}'\n`);
  run_id = crypto.randomUUID(); parent_run = crypto.randomUUID();
  batch = { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [{ id: child, host: "worker", run_id, done: false }], unresolved: [] };
});
afterEach(() => { setStopDrainer(null); setCancelTask(async () => "not available"); setSyncData(DATA, HOME_DIR); setTransport(null); });

function seed(owner: StopOwner = { kind: "task", id: parent }) {
  writeDoc(P("tasks/active", `${child}.md`), { id: child, title: "Running child", claimed_by: "worker", run_host: "worker", run_id,
    stop_intent: JSON.stringify({ operation_id: batch.operation_id, owner, host: "worker", run_id, done: false }) }, "Child request");
  if (owner.kind === "task") writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, title: "Stopped parent", run_host: host, run_id: parent_run, cancelled: new Date().toISOString(), pending_stops: JSON.stringify(batch) }, "Parent request");
}
const progress = (change: Partial<StopDrainResult> = {}): StopDrainResult => ({ owner: { kind: "task", id: parent }, operation_id: batch.operation_id,
  complete: false, synced: true, remaining: 1, pending: batch.pending, unresolved: [], pending_stops: batch,
  terminal: { id: parent, host, run_id: parent_run, result: "cancelled" }, ...change });
const cancelRequest = () => request("/api/tasks/cancel", { id: parent, host, run_id: parent_run });
function pendingRawHook() {
  setCancelTask(async () => { throw new ActionSyncError("Parent stopped; child confirmation pending", { id: parent, run_id: parent_run, result: "cancelled", saved_locally: true }); });
}
function seedPlan() {
  writeDoc(P("tasks/active", `${child}.md`), { id: child, title: "Plan step", claimed_by: "worker", run_host: "worker", run_id, plan: planId }, "Plan request");
  const plan: Plan = { id: planId, goal: "Finish the work", agent: "lead", status: "running", branch: "agent/plan-0800", created: new Date().toISOString(), notes: [], next_step: 1,
    steps: [{ id: "S1", title: "Run the step", details: "Do it", agent: "lead", checkpoint: false, status: "running", attempt: 1, task: child }] };
  savePlan(plan); return plan;
}

test("a raw parent partial becomes success only after synced matching terminal proof", async () => {
  seed(); pendingRawHook(); const calls: unknown[] = [];
  const complete = { ...batch, pending: [] };
  setStopDrainer(async (owner, operation) => { calls.push([owner, operation]); return progress({ complete: true, remaining: 0, pending: [], pending_stops: complete }); });
  const response = await recordRequest(cancelRequest());
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, id: parent, run_id: parent_run, result: "cancelled" });
  expect(calls).toEqual([[{ kind: "task", id: parent }, undefined]]);
  for (const terminal of [undefined, { id: "T-0999", host, run_id: parent_run, result: "cancelled" as const }, { id: parent, host: "other", run_id: parent_run, result: "cancelled" as const },
    { id: parent, host, run_id: crypto.randomUUID(), result: "cancelled" as const }, { id: parent, host, run_id: parent_run, result: "done" as const }]) {
    setStopDrainer(async () => progress({ complete: true, remaining: 0, pending: [], pending_stops: complete, terminal }));
    const rejected = await recordRequest(cancelRequest()); expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ id: parent, run_id: parent_run, saved_locally: true, error: "Parent stopped; child confirmation pending" });
  }
});

test("unsynced or uncertain cleanup cannot leave a successful cancellation response", async () => {
  seed(); setCancelTask(async () => "cancelled");
  for (const change of [{ synced: false, complete: true, remaining: 0, pending: [] }, { complete: false }]) {
    setStopDrainer(async () => progress(change));
    const response = await recordRequest(cancelRequest()), body = await response.json() as any;
    expect(response.status).toBe(503); expect(body.ok).toBe(false); expect(body).toMatchObject({ id: parent, run_id: parent_run, saved_locally: true });
    expect(body.stops.operation_id).toBe(batch.operation_id);
  }
  setCancelTask(async () => { throw new ActionSyncError("Process stop is uncertain", { id: parent, run_id: parent_run, uncertain: true }); });
  setStopDrainer(async () => ({ complete: true, synced: true, remaining: 0, pending: [], unresolved: [] }));
  const response = await recordRequest(cancelRequest()); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ uncertain: true, error: "Process stop is uncertain" });
});

test("task cleanup retry validates strict input and rejects a changed operation without invoking controls", async () => {
  seed(); let calls = 0;
  setStopDrainer(createStopDrainer({ fleet: { primary: host } }, host, async () => { calls++; return "offline"; }, io));
  expect(recordPath("/api/tasks/stops/retry")).toEqual({ kind: "task-stop-retry" });
  expect(recordPath(`/api/plans/${planId}/retry-stops`)).toMatchObject({ kind: "plans", action: "retry-stops" });
  for (const method of ["GET", "PUT", "DELETE"]) expect((await recordRequest(request("/api/tasks/stops/retry", {}, method))).status).toBe(405);
  for (const body of [null, [], "", {}, { id: "../../task", operation_id: batch.operation_id }, { id: parent, operation_id: "old" }, { id: parent, operation_id: batch.operation_id, host: "worker" }])
    expect((await recordRequest(request("/api/tasks/stops/retry", body))).status).toBe(400);
  expect((await recordRequest(request("/api/tasks/stops/retry", { id: parent, operation_id: crypto.randomUUID() }))).status).toBe(409);
  expect(calls).toBe(0); expect(existsSync(P("tasks/active", `${child}.md`))).toBe(true);
  const pending = await recordRequest(request("/api/tasks/stops/retry", { id: parent, operation_id: batch.operation_id })), body = await pending.json() as any;
  expect(pending.status).toBe(503); expect(body.cleanup).toMatchObject({ operation_id: batch.operation_id, remaining: 1 });
  expect(body.stops.pending).toMatchObject([{ id: child, host: "worker", run_id }]); expect(calls).toBe(1);
});

test("plan cancellation persists partial stops and retries only its saved operation to confirmed completion", async () => {
  seedPlan(); let online = false, calls = 0;
  setStopDrainer(createStopDrainer({ fleet: { primary: host } }, host, async (id, done, expected) => {
    calls++; expect([id, done, expected]).toEqual([child, false, { host: "worker", run_id }]);
    if (!online) return "worker offline";
    const path = P("tasks/active", `${child}.md`), doc = readDoc(path);
    writeDoc(P("tasks/rejected", `${child}.md`), { ...doc.meta, claimed_by: undefined, run_host: "worker", cancelled: new Date().toISOString() }, doc.body); unlinkSync(path);
    return "cancelled";
  }, io));
  let response = await planRoute(request(`/api/plans/${planId}/cancel`, {}), planId, "cancel", io), body = await response.json() as any;
  expect(response.status).toBe(503); expect(body).toMatchObject({ saved_locally: true, plan: { id: planId, status: "cancelled" } });
  const operation_id = body.cleanup.operation_id;
  expect(body.cleanup.remaining).toBe(1); expect(calls).toBe(1);
  expect(taskView(P("tasks/active", `${child}.md`), "active", []).stop_owner).toEqual({ kind: "plan", id: planId });
  for (const bad of [null, [], {}, { operation_id: "bad" }, { operation_id, id: planId }])
    expect((await planRoute(request(`/api/plans/${planId}/retry-stops`, bad), planId, "retry-stops", io)).status).toBe(400);
  expect((await planRoute(request(`/api/plans/${planId}/retry-stops`, { operation_id: crypto.randomUUID() }), planId, "retry-stops", io)).status).toBe(409);
  expect(calls).toBe(1);
  online = true;
  response = await planRoute(request(`/api/plans/${planId}/retry-stops`, { operation_id }), planId, "retry-stops", io); body = await response.json() as any;
  expect(response.status).toBe(200); expect(body.ok).toBe(true); expect(body.cleanup).toMatchObject({ operation_id, remaining: 0 }); expect(body.stops).toBeUndefined();
  expect(readPlan(planId).pending_stops?.pending).toHaveLength(0); expect(readDoc(P("tasks/rejected", `${child}.md`)).meta.run_id).toBe(run_id);
  expect(calls).toBe(2);
});

test("failed plan persistence does not invoke controls and missing hooks report the saved progress", async () => {
  seedPlan(); let calls = 0; setStopDrainer(async () => { calls++; return progress(); });
  const partial = await planRoute(request(`/api/plans/${planId}/cancel`, {}), planId, "cancel", { ...io, push: async () => false });
  expect(partial.status).toBe(503); expect((await partial.json() as any).saved_locally).toBe(true); expect(calls).toBe(0);
  const operation_id = readPlan(planId).pending_stops!.operation_id;
  setStopDrainer(null);
  const unavailable = await planRoute(request(`/api/plans/${planId}/retry-stops`, { operation_id }), planId, "retry-stops", io), body = await unavailable.json() as any;
  expect(unavailable.status).toBe(503); expect(body.cleanup).toMatchObject({ operation_id, remaining: 1 }); expect(body.stops.pending).toHaveLength(1);
  expect((await planRoute(request(`/api/plans/${planId}/retry-stops`, { operation_id: crypto.randomUUID() }), planId, "retry-stops", io)).status).toBe(409);
  seed(); const task = await recordRequest(request("/api/tasks/stops/retry", { id: parent, operation_id: batch.operation_id })), taskBody = await task.json() as any;
  expect(task.status).toBe(503); expect(taskBody.cleanup).toMatchObject({ operation_id: batch.operation_id, remaining: 1 });
  expect(taskBody.stops.pending).toMatchObject([{ id: child, run_id }]);
  expect((await recordRequest(request("/api/tasks/stops/retry", { id: parent, operation_id: crypto.randomUUID() }))).status).toBe(409);
});

test("local and cloud task views expose the same cleanup owner, progress and corrupt-state error", () => {
  seed(); const store = localStore({ acts: {}, status: () => ({}), feed: () => [] });
  const path = P("tasks/rejected", `${parent}.md`), local = taskView(path, "cancelled", []), cloud = taskInfo(store, parent);
  expect(local.stops).toEqual(batch); expect(cloud?.stops).toEqual(batch);
  expect(taskView(P("tasks/active", `${child}.md`), "active", []).stop_owner).toEqual({ kind: "task", id: parent });
  expect(taskInfo(store, child)?.stop_owner).toEqual({ kind: "task", id: parent });
  writeDoc(path, { ...readDoc(path).meta, pending_stops: "broken" }, "Parent request");
  expect(taskView(path, "cancelled", []).stops_error).toContain("invalid"); expect(taskInfo(store, parent)?.stops_error).toContain("invalid");
});

test("family-stop capability is read-only and available only after runtime hooks are installed", async () => {
  expect(recordPath("/api/stops/capabilities")).toEqual({ kind: "stop-capabilities" });
  const get = () => recordRequest(request("/api/stops/capabilities", undefined, "GET"));
  expect((await get()).status).toBe(503);
  let calls = 0; setCancelTask(async () => { calls++; return "cancelled"; });
  setStopDrainer(async () => { calls++; return progress(); });
  const ready = await get(); expect(ready.status).toBe(200); expect(await ready.json()).toEqual({ family_stops: 1, family_reviews: 1 });
  expect((await recordRequest(request("/api/stops/capabilities", {}))).status).toBe(405); expect(calls).toBe(0);
  setStopDrainer(null); expect((await get()).status).toBe(503);
});
