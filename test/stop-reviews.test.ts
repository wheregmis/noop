import { beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { P, locked, readDoc, writeDoc } from "../src/core";
import { readPlan, savePlan, type Plan } from "../src/plans";
import { captureTaskStops, hasPendingStops, pendingStopsView, readPendingStops, readStopReviewAudit, readStopReviewPreview, stopDocText, type PendingStops, type StopOwner, type StopResolveRequest, type StopReviewPreview } from "../src/stop-intents";
import { applyStopResolution, createStopDrainer, inspectStopReview, previewStop, readStopReviews, resolveStop, StopReviewSaveError } from "../src/task-stops";
import { MAX_FILE } from "../src/sync";

const owner: StopOwner = { kind: "plan", id: "PL-0810" }, id = "T-0811", main = "review-main", io = { pull: async () => true, push: async () => true };
let batch: PendingStops;
beforeEach(() => {
  for (const dir of ["tasks", "plans", "fleet", "journal"]) fs.rmSync(P(dir), { recursive: true, force: true });
  fs.writeFileSync(P("config.toml"), `[host]\nname='${main}'\n[fleet]\nprimary='${main}'\n`);
  for (const file of ["settings.json", "config.local.toml"]) fs.rmSync(P(file), { force: true });
  batch = { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [{ id, error: "Legacy run could not be verified" }] };
  save(batch);
});
function save(value = batch) {
  const plan: Plan = { id: owner.id, goal: "Review remaining stops", agent: "lead", status: "cancelled", branch: "fixture", created: new Date().toISOString(), notes: [], steps: [], next_step: 1, pending_stops: value };
  savePlan(plan);
}
function task(folder = "active", target = id, extra: Record<string, string> = {}) {
  const meta = { id: target, title: "Reviewed task", run_id: crypto.randomUUID(), run_host: "worker", ...(folder === "active" ? { claimed_by: "worker" } : {}), ...extra };
  const path = P("tasks", folder, `${target}.md`); writeDoc(path, meta, "Owner request"); return { path, meta };
}
const selection = () => ({ owner, operation_id: batch.operation_id, target_id: id });
const preview = () => inspectStopReview(selection());
const decision = (view: StopReviewPreview, action: "include" | "exclude" = "include", reason = "Reviewed this exact task and its current run."): StopResolveRequest => ({ ...selection(), preview_digest: view.preview_digest, action, reason, request_id: crypto.randomUUID() });
const stored = () => readPlan(owner.id).pending_stops!;
const auditPath = (request: StopResolveRequest) => P("fleet", "stop-reviews", `${owner.kind}-${owner.id}`, `${request.request_id}.json`);

test("a review can explicitly replace an old pending UUID with the currently displayed exact run", async () => {
  const old = crypto.randomUUID(), current = task();
  batch.pending = [{ id, host: "worker", run_id: old, done: false }]; batch.unresolved = []; batch.scope = [...batch.pending]; batch.seen = [id]; save();
  writeDoc(current.path, { ...current.meta, stop_intent: JSON.stringify({ operation_id: batch.operation_id, owner, host: "worker", run_id: old, done: false }) }, "Owner request");
  const view = preview(); expect(view.can_include).toBe(true); expect(readStopReviewPreview(view)).toEqual(view);
  const input = decision(view), result = applyStopResolution(input);
  expect(result.pending_stops.pending).toEqual([{ id, host: "worker", run_id: current.meta.run_id, done: false }]);
  expect(result.review.original.run_id).toBe(old); expect(result.review.reviewed.records[0].run_id).toBe(current.meta.run_id);
  expect(JSON.parse(readDoc(current.path).meta.stop_intent).run_id).toBe(current.meta.run_id); expect(readStopReviewAudit(result.review)).toEqual(result.review);
  const drained = await createStopDrainer({ fleet: { primary: main } }, main, async (target, _done, expected) => {
    expect(expected.run_id).toBe(current.meta.run_id); await locked(() => { const doc = readDoc(current.path); writeDoc(P("tasks/rejected", `${target}.md`), { ...doc.meta, claimed_by: undefined, cancelled: new Date().toISOString() }, doc.body); fs.unlinkSync(current.path); }); return "cancelled";
  }, io)(owner);
  expect(drained.complete).toBe(true); const history = readStopReviews(owner); expect(history).toHaveLength(1); expect(history[0].review_id).toBe(input.request_id);
  const newer = task(); const before = fs.readFileSync(newer.path, "utf8");
  expect(applyStopResolution(input).review).toEqual(result.review); expect(fs.readFileSync(newer.path, "utf8")).toBe(before); expect(stored().reviews).toHaveLength(1);
});

test("same-preview competing decisions fail after an identical-run include while exact request replay remains safe", () => {
  const current = task(); batch = captureTaskStops([id], owner, false)!; save();
  const marker = readDoc(current.path).meta.stop_intent, view = preview(), include = decision(view);
  applyStopResolution(include);
  expect(readDoc(current.path).meta.stop_intent).toBe(marker); // Only the target review revision changed.
  for (const action of ["include", "exclude"] as const) expect(() => applyStopResolution(decision(view, action))).toThrow("changed after the preview");
  expect(applyStopResolution(include).review_id).toBe(include.request_id); expect(stored().reviews).toHaveLength(1);
  expect(() => applyStopResolution({ ...include, reason: "A different reason with the same review ID" })).toThrow("different decision");
});

test("volatile task body, model and pending error updates do not invalidate a review, but placement and graph changes do", () => {
  const current = task(); batch.pending = [{ id, host: "worker", run_id: current.meta.run_id, done: false }]; batch.unresolved = []; save();
  const view = preview(); writeDoc(current.path, { ...current.meta, cli_used: "claude", model: "updated", account: "work" }, "New streaming activity and owner conversation");
  const value = readPlan(owner.id); value.pending_stops!.pending[0].error = "A newer connection error"; savePlan(value);
  expect(preview().preview_digest).toBe(view.preview_digest);
  writeDoc(current.path, { ...readDoc(current.path).meta, requires: "os:linux" }, "Same body");
  expect(() => applyStopResolution(decision(view))).toThrow("changed after the preview");
  const fresh = preview(); task("active", "T-0812", { parent: id, spawned_by_run: current.meta.run_id });
  expect(() => applyStopResolution(decision(fresh))).toThrow("changed after the preview"); expect(stored().reviews).toBeUndefined();
});

test("a reviewed queued task is terminalized with its queued descendants and exact active children captured", () => {
  const queued = task("inbox", id, { children: "T-0812,T-0813" }); task("waiting", "T-0812"); const active = task("active", "T-0813");
  const view = preview(); expect(view.related?.map((entry) => entry.id)).toEqual(["T-0812", "T-0813"]); expect(readStopReviewPreview(view)).toEqual(view);
  const input = decision(view), result = applyStopResolution(input);
  expect(result.review.reviewed.state).toBe("queued"); expect(fs.existsSync(queued.path)).toBe(false); expect(fs.existsSync(P("tasks/rejected/T-0811.md"))).toBe(true); expect(fs.existsSync(P("tasks/rejected/T-0812.md"))).toBe(true);
  expect(result.pending_stops.pending).toEqual([{ id: "T-0813", host: "worker", run_id: active.meta.run_id, done: false }]);
  expect(fs.existsSync(auditPath(input))).toBe(true);
});

test("queued body-only amendments and descendant marker conflicts reject stale or unsafe includes before writes", () => {
  const queued = task("inbox"), view = preview();
  writeDoc(queued.path, queued.meta, "New owner instructions added after review");
  expect(() => applyStopResolution(decision(view))).toThrow("changed after the preview"); expect(fs.existsSync(queued.path)).toBe(true);
  writeDoc(queued.path, { ...queued.meta, children: "T-0812" }, "Instructions"); task("active", "T-0812", { stop_intent: "not verified" });
  const fresh = preview(); expect(() => applyStopResolution(decision(fresh))).toThrow("unverified stop marker");
  expect(fs.existsSync(queued.path)).toBe(true); expect(stored().reviews).toBeUndefined();
});

test("terminal acceptance is explicit and missing/conflicting task records cannot be included", () => {
  let view = preview(); expect(view.can_include).toBe(false); expect(view.current.state).toBe("missing"); expect(() => applyStopResolution(decision(view))).toThrow("No task record");
  task("done"); view = preview(); expect(view.current.state).toBe("terminal"); expect(applyStopResolution(decision(view)).complete).toBe(true);
  batch = { ...batch, operation_id: crypto.randomUUID() }; save(); task("active"); view = preview();
  expect(view.current.state).toBe("conflicting"); expect(view.can_include).toBe(false); expect(() => applyStopResolution(decision(view))).toThrow("conflicting copies");
  const records = [P("tasks/active/T-0811.md"), P("tasks/done/T-0811.md")].map((path) => fs.readFileSync(path, "utf8"));
  const excluded = applyStopResolution(decision(view, "exclude")); expect(excluded.complete).toBe(true);
  expect([P("tasks/active/T-0811.md"), P("tasks/done/T-0811.md")].map((path) => fs.readFileSync(path, "utf8"))).toEqual(records);
});

test("accepting a reviewed terminal task still captures its live related descendants", () => {
  const terminal = task("done"), child = task("active", "T-0815", { parent: id, source: `followup:${id}`, spawned_by_run: terminal.meta.run_id });
  const view = preview(); expect(view.current.state).toBe("terminal"); expect(view.related?.map((entry) => entry.id)).toEqual([child.meta.id]);
  const before = fs.readFileSync(terminal.path, "utf8"), result = applyStopResolution(decision(view));
  expect(result.complete).toBe(false); expect(result.remaining).toBe(1); expect(result.pending_stops.pending).toEqual([{ id: child.meta.id, host: "worker", run_id: child.meta.run_id, done: false }]);
  expect(fs.readFileSync(terminal.path, "utf8")).toBe(before); expect(readDoc(child.path).meta.stop_intent).toBeDefined();
});

test("exclude leaves the reviewed run alive/unmodified apart from its own marker and is never rediscovered", async () => {
  const active = task(); batch = captureTaskStops([id], owner, false)!; save();
  const before = readDoc(active.path), input = decision(preview(), "exclude", "Keep this separately managed run running.");
  const result = applyStopResolution(input); expect(result.complete).toBe(true); expect(hasPendingStops(result.pending_stops)).toBe(false); expect(pendingStopsView(result.pending_stops)).toBeUndefined();
  expect(result.pending_stops.excluded?.[0]).toMatchObject({ id, review_id: input.request_id, stopped: false, reason: input.reason });
  const after = readDoc(active.path); expect(after.body).toBe(before.body); expect(after.meta.run_id).toBe(before.meta.run_id); expect(after.meta.stop_intent).toBeUndefined();
  task("active", "T-0814", { source: `followup:${id}` }); let calls = 0;
  expect(await createStopDrainer({ fleet: { primary: main } }, main, async () => { calls++; return "cancelled"; }, io)(owner)).toMatchObject({ complete: true, remaining: 0 });
  expect(calls).toBe(0); expect(stored().unresolved).toHaveLength(0); expect(readStopReviews(owner)[0].reason).toBe(input.reason);
});

test("foreign stop markers are never cleared by exclusion and conflicting outcomes cannot be included", () => {
  const current = task(), other = { operation_id: crypto.randomUUID(), owner: { kind: "task", id: "T-0820" }, host: "worker", run_id: current.meta.run_id, done: true };
  writeDoc(current.path, { ...current.meta, stop_intent: JSON.stringify(other) }, "Owner request");
  const view = preview(); expect(view.can_include).toBe(false); expect(() => applyStopResolution(decision(view))).toThrow("conflicting stop marker");
  applyStopResolution(decision(view, "exclude")); expect(JSON.parse(readDoc(current.path).meta.stop_intent)).toEqual(other);
});

test("failed refresh never records a review and a failed push preserves stable identity for replay", async () => {
  task(); await expect(previewStop(owner, batch.operation_id, id, { ...io, pull: async () => false })).rejects.toMatchObject({ status: 503 });
  const input = decision(preview(), "exclude");
  await expect(resolveStop(input, { ...io, pull: async () => false })).rejects.toMatchObject({ status: 503 }); expect(stored().reviews).toBeUndefined();
  const partial = await resolveStop(input, { ...io, push: async () => false }); expect(partial.synced).toBe(false); expect(partial.review_id).toBe(input.request_id);
  const retry = await resolveStop(input, io); expect(retry.synced).toBe(true); expect(retry.review).toEqual(partial.review); expect(stored().reviews).toHaveLength(1);
});

test("an audit file failure after the decision saves can be repaired without touching a newer task run", () => {
  task(); const input = decision(preview(), "exclude"), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === auditPath(input)) throw new Error("fixture audit rename failure"); return rename(from, to); });
  let partial: StopReviewSaveError | undefined;
  try { applyStopResolution(input); } catch (error) { if (error instanceof StopReviewSaveError) partial = error; else throw error; } finally { patch.mockRestore(); }
  expect(partial?.resolution.review_id).toBe(input.request_id); expect(stored().reviews).toHaveLength(1); expect(fs.existsSync(auditPath(input))).toBe(false);
  const newer = task(), before = fs.readFileSync(newer.path, "utf8");
  const replay = applyStopResolution(input); expect(replay.review_id).toBe(input.request_id); expect(fs.readFileSync(newer.path, "utf8")).toBe(before); expect(fs.existsSync(auditPath(input))).toBe(true); expect(stored().reviews).toHaveLength(1);
});

test("a failed owner write after marker changes requires a fresh review and never blindly replays the original snapshot", () => {
  const current = task(), input = decision(preview()), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === P("plans", `${owner.id}.json`)) throw new Error("fixture owner save failed"); return rename(from, to); });
  try { expect(() => applyStopResolution(input)).toThrow(StopReviewSaveError); } finally { patch.mockRestore(); }
  expect(stored().reviews).toBeUndefined(); expect(stored().unresolved[0].id).toBe(id); expect(readDoc(current.path).meta.stop_intent).toBeDefined();
  expect(fs.existsSync(auditPath(input))).toBe(false); expect(() => applyStopResolution(input)).toThrow("changed after the preview");
  const repaired = applyStopResolution(decision(preview())); expect(repaired.pending_stops.pending[0].run_id).toBe(current.meta.run_id); expect(stored().reviews).toHaveLength(1);
});

test("a lost push race cannot authorize a review against a newer owner operation or task UUID", async () => {
  task(); const input = decision(preview(), "exclude"), newerOp = crypto.randomUUID(); let newRun = "";
  const partial = await resolveStop(input, { ...io, push: async () => { newRun = task().meta.run_id; save({ ...batch, operation_id: newerOp }); return false; } });
  expect(partial.synced).toBe(false); expect(partial.review_id).toBe(input.request_id);
  await expect(resolveStop(input, io)).rejects.toMatchObject({ status: 409 }); expect(stored().operation_id).toBe(newerOp); expect(readDoc(P("tasks/active", `${id}.md`)).meta.run_id).toBe(newRun);
});

test("an exclusion recorded before dispatch removes authorization for future selected stop callbacks", async () => {
  task(); batch = captureTaskStops([id], owner, false)!; save(); const input = decision(preview(), "exclude");
  let queued: Promise<unknown> | undefined, calls = 0, pushes = 0;
  const result = await createStopDrainer({ fleet: { primary: main } }, main, async () => { calls++; return "cancelled"; }, { ...io, push: async () => {
    if (++pushes === 1) queued = locked(() => applyStopResolution(input));
    return true;
  } })(owner);
  await queued;
  expect(calls).toBe(0); expect(result.complete).toBe(true); expect(stored().excluded?.[0].review_id).toBe(input.request_id); expect(fs.existsSync(P("tasks/active", `${id}.md`))).toBe(true);
});

test("a saved audit alone cannot reapply a lost owner decision or override a new cleanup operation", () => {
  const input = decision(preview(), "exclude"); applyStopResolution(input); save(batch);
  expect(() => applyStopResolution(input)).toThrow("without its owner decision"); expect(stored().unresolved).toHaveLength(1);
  save({ ...batch, operation_id: crypto.randomUUID() }); expect(() => applyStopResolution(input)).toThrow("operation changed"); expect(stored().reviews).toBeUndefined();
  expect(readStopReviews(owner)).toHaveLength(1);
});

test("review history survives clearing the owner batch and does not become authority for replay", () => {
  const input = decision(preview(), "exclude"); const result = applyStopResolution(input);
  const value = readPlan(owner.id); value.pending_stops = undefined; savePlan(value);
  expect(readStopReviews(owner)[0]).toEqual(result.review); expect(() => applyStopResolution(input)).toThrow("operation changed");
});

test("oversized owner/audit history limits reject a decision before changing target markers", () => {
  const current = task(), input = decision(preview(), "exclude");
  const value = readPlan(owner.id); value.goal = "x".repeat(MAX_FILE - Buffer.byteLength(JSON.stringify(value, null, 2)) - 80);
  fs.writeFileSync(P("plans", `${owner.id}.json`), JSON.stringify(value, null, 2) + "\n"); const before = fs.readFileSync(P("plans", `${owner.id}.json`), "utf8"), target = fs.readFileSync(current.path, "utf8");
  expect(() => applyStopResolution(input)).toThrow("size limit"); expect(fs.readFileSync(P("plans", `${owner.id}.json`), "utf8")).toBe(before); expect(fs.readFileSync(current.path, "utf8")).toBe(target); expect(fs.existsSync(auditPath(input))).toBe(false);
});
