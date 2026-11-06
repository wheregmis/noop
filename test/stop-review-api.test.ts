import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { recordPath, initUiRequests, uiRequestRoute } from "../cloud/src/ui-requests";
import type { PendingStops, StopOwner } from "../cloud/src/stop-intents";
import { taskInfo } from "../cloud/src/tools";
import { localStore } from "../src/brain";
import { DATA, HOME_DIR, P, readDoc, writeDoc } from "../src/core";
import { readPlan, savePlan } from "../src/plans";
import { recordRequest, setCancelTask, setStopDrainer, taskView } from "../src/server";
import { setSyncData, setTransport } from "../src/sync";

const host = "review-main", parent = "T-0900", child = "T-0901", planId = "PL-0900";
const io = { pull: async () => true, push: async () => true };
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://hub${path}`, {
  method, ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
});
let batch: PendingStops, run_id: string, calls: number;
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null); setStopDrainer(null);
  calls = 0; setCancelTask(async () => { calls++; return "cancelled"; });
  for (const dir of ["tasks", "plans", "journal", "fleet"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("config.toml"), `[host]\nname='${host}'\n[fleet]\nprimary='${host}'\n`);
  rmSync(P("config.local.toml"), { force: true }); rmSync(P("settings.json"), { force: true });
  run_id = crypto.randomUUID();
  batch = { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [{ id: child, error: "The original run has no verifiable identity." }] };
});
afterEach(() => { setStopDrainer(null); setCancelTask(async () => "not available"); setSyncData(DATA, HOME_DIR); setTransport(null); });
const taskOwner: StopOwner = { kind: "task", id: parent };
function seed(owner: StopOwner = taskOwner) {
  if (owner.kind === "task") writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, title: "Stopped parent", cancelled: new Date().toISOString(), pending_stops: JSON.stringify(batch) }, "Keep this request.");
  else savePlan({ id: planId, goal: "Keep this plan", agent: "lead", status: "cancelled", branch: "", created: new Date().toISOString(), notes: [], next_step: 0, steps: [], pending_stops: batch });
}
const selection = (owner: StopOwner = taskOwner) => ({ owner, operation_id: batch.operation_id, target_id: child });
async function preview(owner: StopOwner = taskOwner) {
  const response = await recordRequest(request("/api/stops/review", selection(owner)), io);
  expect(response.status).toBe(200); return await response.json() as any;
}
const decision = (view: any, owner: StopOwner = taskOwner, action = "exclude") => ({ ...selection(owner), preview_digest: view.preview_digest,
  action, reason: "Reviewed the current task and accepted this decision.", request_id: crypto.randomUUID() });
const savedBatch = () => JSON.parse(readDoc(P("tasks/rejected", `${parent}.md`)).meta.pending_stops) as PendingStops;

test("stop review routes strictly validate method, payload and nested owner before refreshing", async () => {
  expect(recordPath("/api/stops/review")).toEqual({ kind: "stop-review" });
  expect(recordPath("/api/stops/resolve")).toEqual({ kind: "stop-resolve" });
  expect(recordPath("/api/stops/review/extra")).toBeNull();
  let pulls = 0; const checked = { ...io, pull: async () => { pulls++; return true; } };
  for (const path of ["/api/stops/review", "/api/stops/resolve"]) for (const method of ["GET", "PUT", "DELETE"])
    expect((await recordRequest(request(path, {}, method), checked)).status).toBe(405);
  const valid = selection(), resolve = { ...valid, preview_digest: "a".repeat(64), action: "exclude", reason: "Reviewed", request_id: crypto.randomUUID() };
  for (const body of [null, [], {}, { ...valid, target_id: "../task" }, { ...valid, operation_id: "old" }, { ...valid, host: "worker" }, { ...valid, owner: { ...taskOwner, extra: true } }])
    expect((await recordRequest(request("/api/stops/review", body), checked)).status).toBe(400);
  for (const body of [valid, { ...resolve, preview_digest: "x" }, { ...resolve, action: "kill" }, { ...resolve, reason: " " }, { ...resolve, reason: "a\nb" }, { ...resolve, reason: "a".repeat(501) }, { ...resolve, request_id: "old" }, { ...resolve, run_id }])
    expect((await recordRequest(request("/api/stops/resolve", body), checked)).status).toBe(400);
  expect(pulls).toBe(0); expect(calls).toBe(0);
});

test("preview refreshes without writing and a changed current task invalidates its digest", async () => {
  seed(); const path = P("tasks/rejected", `${parent}.md`), before = readFileSync(path, "utf8");
  let pushes = 0;
  const response = await recordRequest(request("/api/stops/review", selection()), { ...io, push: async () => { pushes++; return true; } });
  const view = await response.json() as any;
  expect(view).toMatchObject({ ...selection(), current: { state: "missing" }, can_include: false });
  expect(view.preview_digest).toMatch(/^[a-f0-9]{64}$/); expect(pushes).toBe(0); expect(readFileSync(path, "utf8")).toBe(before);
  writeDoc(P("tasks/active", `${child}.md`), { id: child, title: "New attempt", claimed_by: "worker", run_host: "worker", run_id }, "Different work");
  const rejected = await recordRequest(request("/api/stops/resolve", decision(view)), io);
  expect(rejected.status).toBe(409); expect(savedBatch().unresolved).toHaveLength(1); expect(savedBatch().reviews).toBeUndefined(); expect(calls).toBe(0);
});

test("including a reviewed current run saves exact authorization but never reports its process stopped", async () => {
  seed(); writeDoc(P("tasks/active", `${child}.md`), { id: child, title: "Current child", claimed_by: "worker", run_host: "worker", run_id }, "Still running");
  const view = await preview(); expect(view.can_include).toBe(true);
  const input = decision(view, taskOwner, "include"), response = await recordRequest(request("/api/stops/resolve", input), io), body = await response.json() as any;
  expect(response.status).toBe(200); expect(body).toMatchObject({ ok: true, id: parent, owner: taskOwner, operation_id: batch.operation_id, target_id: child, action: "include", request_id: input.request_id, review_id: input.request_id,
    review: { request_id: input.request_id, action: "include", reason: input.reason, preview_digest: input.preview_digest }, cleanup: { operation_id: batch.operation_id, remaining: 1 }, task: { id: parent } });
  expect(body.stops.pending).toMatchObject([{ id: child, host: "worker", run_id, done: false }]);
  expect(JSON.parse(readDoc(P("tasks/active", `${child}.md`)).meta.stop_intent)).toMatchObject({ owner: taskOwner, operation_id: batch.operation_id, host: "worker", run_id });
  expect(savedBatch().reviews).toHaveLength(1); expect(calls).toBe(0);
});

test("body-only instructions added to a queued task invalidate its review before inclusion", async () => {
  seed(); const path = P("tasks/inbox", `${child}.md`);
  writeDoc(path, { id: child, title: "Queued child", agent: "lead" }, "Original instructions");
  const view = await preview(); expect(view.can_include).toBe(true);
  const doc = readDoc(path); writeDoc(path, doc.meta, `${doc.body}\nNew owner instructions`);
  const response = await recordRequest(request("/api/stops/resolve", decision(view, taskOwner, "include")), io);
  expect(response.status).toBe(409); expect(readDoc(path).body).toContain("New owner instructions");
  expect(savedBatch().unresolved).toHaveLength(1); expect(savedBatch().reviews).toBeUndefined(); expect(calls).toBe(0);
});

test("an unverified descendant stop marker rejects inclusion before any family mutation", async () => {
  seed(); const path = P("tasks/active", `${child}.md`);
  writeDoc(path, { id: child, title: "Current child", claimed_by: "worker", run_host: "worker", run_id, children: "T-0902" }, "Child request");
  writeDoc(P("tasks/active/T-0902.md"), { id: "T-0902", title: "Grandchild", claimed_by: "worker", run_host: "worker", run_id: crypto.randomUUID(), stop_intent: "broken" }, "Grandchild request");
  const input = decision(await preview(), taskOwner, "include"), response = await recordRequest(request("/api/stops/resolve", input), io);
  expect(response.status).toBe(409); expect(readDoc(path).meta.stop_intent).toBeUndefined(); expect(savedBatch().reviews).toBeUndefined(); expect(calls).toBe(0);
});

test("excluded task and plan targets retain review history when their remaining cleanup reaches zero", async () => {
  for (const owner of [taskOwner, { kind: "plan", id: planId } as StopOwner]) {
    seed(owner); const input = decision(await preview(owner), owner), response = await recordRequest(request("/api/stops/resolve", input), io), body = await response.json() as any;
    expect(response.status).toBe(200); expect(body).toMatchObject({ ok: true, owner, review_id: input.request_id, cleanup: { remaining: 0, pending: [], unresolved: [] } });
    expect(body.stops).toBeUndefined();
    if (owner.kind === "plan") {
      const plan = readPlan(planId); expect(plan.pending_stops?.reviews).toHaveLength(1);
      plan.pending_stops = undefined; savePlan(plan);
      const detail = await recordRequest(request(`/api/plans/${planId}`, undefined, "GET"), io);
      expect((await detail.json() as any).plan.stop_reviews).toHaveLength(1);
    }
    else {
      expect(taskView(P("tasks/rejected", `${parent}.md`), "cancelled", []).stop_reviews).toHaveLength(1);
      const current = readDoc(P("tasks/rejected", `${parent}.md`));
      writeDoc(P("tasks/rejected", `${parent}.md`), { ...current.meta, pending_stops: undefined }, current.body);
      const store = localStore({ acts: {}, status: () => ({}), feed: () => [] }); expect(taskInfo(store, parent)?.stop_reviews).toHaveLength(1);
    }
  }
  expect(calls).toBe(0);
});

test("failed refresh and worker-side review cannot mutate saved cleanup", async () => {
  seed(); const view = await preview(), input = decision(view), before = savedBatch();
  for (const pull of [async () => false, async () => { throw new Error("offline"); }]) for (const [path, body] of [["/api/stops/review", selection()], ["/api/stops/resolve", input]] as const)
    expect((await recordRequest(request(path, body), { ...io, pull })).status).toBe(503);
  writeFileSync(P("config.toml"), `[host]\nname='worker'\n[fleet]\nprimary='${host}'\n`);
  for (const [path, body] of [["/api/stops/review", selection()], ["/api/stops/resolve", input]] as const)
    expect((await recordRequest(request(path, body), io)).status).toBe(409);
  expect(savedBatch()).toEqual(before); expect(calls).toBe(0);
});

test("partial review keeps its stable identity and a repeated decision republishes without another audit", async () => {
  for (const push of [async () => false, async () => { throw new Error("offline"); }]) {
    seed(); const input = decision(await preview()), first = await recordRequest(request("/api/stops/resolve", input), { ...io, push }), partial = await first.json() as any;
    expect(first.status).toBe(503); expect(partial).toMatchObject({ ok: false, saved_locally: true, id: parent, request_id: input.request_id, review_id: input.request_id, cleanup: { remaining: 0 } });
    expect(savedBatch().reviews).toHaveLength(1);
    // Progress may change after authorization; replay still refers to its original decision.
    const current = readDoc(P("tasks/rejected", `${parent}.md`)), updated = savedBatch();
    updated.pending.push({ id: "T-0902", host: "worker", run_id: crypto.randomUUID(), done: false });
    writeDoc(P("tasks/rejected", `${parent}.md`), { ...current.meta, pending_stops: JSON.stringify(updated) }, current.body);
    const retry = await recordRequest(request("/api/stops/resolve", input), io), confirmed = await retry.json() as any;
    expect(retry.status).toBe(200); expect(confirmed).toMatchObject({ ok: true, review_id: input.request_id, request_id: input.request_id, cleanup: { remaining: 1 } });
    expect(confirmed.review).toEqual(partial.review); expect(savedBatch().reviews).toHaveLength(1);
    expect((await recordRequest(request("/api/stops/resolve", { ...input, reason: "Changed decision" }), io)).status).toBe(409);
    batch = { ...batch, operation_id: crypto.randomUUID() };
  }
  expect(calls).toBe(0);
});

test("changed cleanup identities and missing owners reject review without publication", async () => {
  seed(); let pushes = 0; const checked = { ...io, push: async () => { pushes++; return true; } };
  for (const body of [{ ...selection(), operation_id: crypto.randomUUID() }, { ...selection(), target_id: "T-0999" }])
    expect((await recordRequest(request("/api/stops/review", body), checked)).status).toBe(409);
  expect((await recordRequest(request("/api/stops/review", selection({ kind: "task", id: "T-0999" })), checked)).status).toBe(404);
  expect(pushes).toBe(0); expect(calls).toBe(0);
});

test("a failed plan publication retains the review identity even when the refresh race removes its local owner", async () => {
  const owner: StopOwner = { kind: "plan", id: planId }; seed(owner);
  const input = decision(await preview(owner), owner);
  const response = await recordRequest(request("/api/stops/resolve", input), { ...io, push: async () => { rmSync(P("plans", `${planId}.json`)); return false; } });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, saved_locally: true, id: planId, owner, operation_id: batch.operation_id, request_id: input.request_id, review_id: input.request_id, plan: { id: planId } });
});

test("an audit file without its matching applied owner ledger cannot confirm or reapply a decision", async () => {
  seed(); const input = decision(await preview());
  expect((await recordRequest(request("/api/stops/resolve", input), io)).status).toBe(200);
  seed(); // A sync conflict restored the old owner while its immutable audit file survived.
  const response = await recordRequest(request("/api/stops/resolve", input), io);
  expect(response.status).toBe(409); expect(savedBatch().unresolved).toHaveLength(1); expect(savedBatch().reviews).toBeUndefined(); expect(calls).toBe(0);
});

test("a partial audit write returns its saved decision and the same request repairs publication without another mutation", async () => {
  seed(); const input = decision(await preview()), dir = P("fleet/stop-reviews", `task-${parent}`);
  mkdirSync(P("fleet/stop-reviews"), { recursive: true }); writeFileSync(dir, "block this audit directory");
  const partial = await recordRequest(request("/api/stops/resolve", input), io), body = await partial.json() as any;
  expect(partial.status).toBe(503); expect(body).toMatchObject({ ok: false, saved_locally: true, uncertain: true, id: parent,
    request_id: input.request_id, review_id: input.request_id, review: { reason: input.reason, action: input.action }, cleanup: { remaining: 0 } });
  expect(savedBatch().reviews).toHaveLength(1);
  rmSync(dir);
  const confirmed = await recordRequest(request("/api/stops/resolve", input), io);
  expect(confirmed.status).toBe(200); expect((await confirmed.json() as any).review).toEqual(body.review);
  expect(savedBatch().reviews).toHaveLength(1); expect(calls).toBe(0);
});

test("cloud admission accepts only validated owner review commands and keeps replay safe through distinct tickets", async () => {
  const db = new Database(":memory:");
  try {
    const sql = { exec(query: string, ...bindings: any[]) {
      let rows: any[] = [];
      for (const part of query.split(";").map((text) => text.trim()).filter(Boolean)) {
        const stmt = db.query(part); if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings);
      }
      return { toArray: () => rows };
    } };
    initUiRequests(sql); const inbox: unknown[] = [], host = { online: () => true, supported: () => true, enqueue: (item: unknown) => inbox.push(item) };
    const call = (path: string, body?: unknown, method = "POST", who: "machine" | { session: string } = { session: "owner" }) => uiRequestRoute(sql, request(path, body, method), who, host);
    for (const path of ["/api/stops/review", "/api/stops/resolve"]) {
      expect((await call(path, {}, "GET"))?.status).toBe(405); expect((await call(path, {}))?.status).toBe(400);
      expect((await call(path, selection(), "POST", "machine"))?.status).toBe(403);
    }
    expect(inbox).toHaveLength(0);
    const preview = (await call("/api/stops/review", selection()))!; expect(preview.status).toBe(202);
    const previewId = (await preview.json() as any).ticket;
    const claim = (await call(`/api/host/ui-requests/${previewId}`, undefined, "POST", "machine"))!;
    expect((await claim.json() as any).job).toEqual({ method: "POST", path: "/api/stops/review", body: selection() });
    const input = decision({ preview_digest: "a".repeat(64) });
    const first = (await call("/api/stops/resolve", input))!, retry = (await call("/api/stops/resolve", input))!;
    expect(first.status).toBe(202); expect(retry.status).toBe(202);
    expect((await first.json() as any).ticket).not.toBe((await retry.json() as any).ticket);
  } finally { db.close(); }
});
