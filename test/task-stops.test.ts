import { beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { P, locked, readDoc, writeDoc } from "../src/core";
import { archivePlan, cancelPlan, continuePlan, readPlan, savePlan, summary, type Plan } from "../src/plans";
import { assertStopRecordSize, captureTaskStops, hasPendingStops, MAX_STOP_BATCH_BYTES, matchingStopIntent, pendingStopsError, pendingStopsView, readPendingStops, settleTaskStop, STOP_RECORD_MAX_BYTES, stopDocText, stopUtf8Length, taskHasStopIntent, type PendingStops, type StopOwner, type StopTarget } from "../src/stop-intents";
import { createStopDrainer, type StopControl } from "../src/task-stops";
import { MAX_FILE } from "../src/sync";

const host = "main", cfg = { fleet: { primary: host } }, owner: StopOwner = { kind: "plan", id: "PL-0900" };
const io = { pull: async () => true, push: async () => true };
beforeEach(() => { for (const dir of ["tasks", "plans", "archive", "fleet"]) rmSync(P(dir), { recursive: true, force: true }); });
function task(id: string, folder = "active", extra: Record<string, string> = {}) {
  const meta = { id, title: "Fixture", run_id: crypto.randomUUID(), claimed_by: "worker", run_host: "worker", ...extra };
  const path = P("tasks", folder, `${id}.md`); writeDoc(path, meta, "Keep the owner's request"); return { path, meta };
}
function plan(batch?: PendingStops): Plan {
  const value: Plan = { id: owner.id, goal: "Stop this family", agent: "lead", status: "cancelled", branch: "fixture", created: new Date().toISOString(), notes: [], steps: [], next_step: 1, pending_stops: batch };
  savePlan(value); return value;
}
function captured(ids: string[]): PendingStops { const batch = captureTaskStops(ids, owner, false)!; plan(batch); return batch; }
function finish(id: string, state = "rejected") {
  const source = P("tasks/active", `${id}.md`), doc = readDoc(source);
  writeDoc(P("tasks", state, `${id}.md`), { ...doc.meta, claimed_by: undefined, ...(state === "rejected" ? { cancelled: new Date().toISOString() } : { finished: new Date().toISOString() }) }, doc.body);
  unlinkSync(source);
}
const complete: StopControl = async (id) => { await locked(() => finish(id)); return "cancelled"; };

test("capture recursively stops queued descendants and binds active runs once before the plan loses step identities", () => {
  const child = task("T-0901", "active", { children: "T-0902,T-0903" });
  task("T-0902", "waiting", { children: "T-0903" });
  const grandchild = task("T-0903", "active", { children: "T-0901" });
  const value = plan(); value.status = "running"; value.steps = [{ id: "s1", title: "Step", details: "", agent: "lead", checkpoint: false, status: "running", attempt: 1, task: child.meta.id }]; savePlan(value);
  const cancelled = cancelPlan(owner.id).plan, batch = cancelled.pending_stops!;
  expect(cancelled.status).toBe("cancelled"); expect(cancelled.steps[0].status).toBe("stopped");
  expect(batch.pending.map((item) => item.id).sort()).toEqual([child.meta.id, grandchild.meta.id]);
  expect(existsSync(P("tasks/rejected/T-0902.md"))).toBe(true);
  const marker = matchingStopIntent(readDoc(child.path).meta)!;
  expect(marker).toMatchObject({ operation_id: batch.operation_id, owner, host: "worker", run_id: child.meta.run_id, done: false });
  expect(cancelPlan(owner.id).plan.pending_stops).toEqual(batch);
  expect(() => archivePlan(owner.id)).toThrow("pending task cleanup"); expect(() => continuePlan(owner.id, { instructions: "more" })).toThrow("pending task cleanup");
  expect(summary(cancelled).stops?.operation_id).toBe(batch.operation_id);
});

test("capture validates malformed markers before changing any queued task and preserves ancestor-owned intent", () => {
  const queued = task("T-0910", "inbox"), active = task("T-0911", "active", { stop_intent: "invalid" });
  expect(() => captureTaskStops([queued.meta.id, active.meta.id], owner, false)).toThrow("unverified stop marker");
  expect(existsSync(queued.path)).toBe(true); expect(existsSync(P("tasks/rejected/T-0910.md"))).toBe(false);
  writeDoc(active.path, { ...active.meta, stop_intent: undefined }, "Request");
  const original = captureTaskStops([active.meta.id], owner, false)!;
  const before = readDoc(active.path).meta.stop_intent;
  const other = captureTaskStops([active.meta.id], { kind: "task", id: "T-0912" }, false)!;
  expect(other.operation_id).not.toBe(original.operation_id); expect(readDoc(active.path).meta.stop_intent).toBe(before);
});

test("initial parent capture includes reverse-linked legacy followups without nesting the parent itself", () => {
  const parent = task("T-0913", "waiting", { children: "" }), child = task("T-0914", "active", { source: `followup:${parent.meta.id}` });
  const batch = captureTaskStops([], { kind: "task", id: parent.meta.id }, true)!;
  expect(batch.pending.map((target) => target.id)).toEqual([child.meta.id]);
  expect(batch.scope?.map((target) => target.id).sort()).toEqual([parent.meta.id, child.meta.id]);
  expect(existsSync(parent.path)).toBe(true);
});

test("failed refresh or initial sync keeps the operation visible and never invokes stop controls", async () => {
  const child = task("T-0920"), batch = captured([child.meta.id]); let calls = 0;
  for (const failure of [{ ...io, pull: async () => false }, { ...io, push: async () => false }]) {
    const result = await createStopDrainer(cfg, host, async () => { calls++; return "cancelled"; }, failure)(owner, batch.operation_id);
    expect(result).toMatchObject({ complete: false, synced: false, remaining: 1, operation_id: batch.operation_id });
  }
  expect(calls).toBe(0); expect(readPlan(owner.id).pending_stops?.pending[0].run_id).toBe(child.meta.run_id);
});

test("an empty background snapshot or terminal owner cannot claim confirmation after a failed refresh or push", async () => {
  const drain = createStopDrainer(cfg, host, complete, { ...io, pull: async () => false });
  expect(await drain()).toMatchObject({ complete: false, synced: false, remaining: 0 });
  task("T-0921", "rejected");
  expect(await createStopDrainer(cfg, host, complete, { ...io, push: async () => false })({ kind: "task", id: "T-0921" })).toMatchObject({ complete: false, synced: false });
});

test("HTTP success without a synced terminal tuple stays pending, and a newer retry is never stopped", async () => {
  const child = task("T-0930"), batch = captured([child.meta.id]); let calls = 0;
  const drain = createStopDrainer(cfg, host, async () => { calls++; return "cancelled"; }, io);
  expect(await drain(owner)).toMatchObject({ complete: false, synced: true, remaining: 1 }); expect(calls).toBe(1);
  const newer = task(child.meta.id);
  const conflict = await drain(owner, batch.operation_id);
  expect(conflict.remaining).toBe(1); expect(conflict.pending[0].run_id).toBe(child.meta.run_id); expect(conflict.pending[0].error).toContain("different run");
  expect(calls).toBe(1); expect(readDoc(newer.path).meta.run_id).toBe(newer.meta.run_id);
});

test("a stop whose terminal sync fails remains pending until a fresh drainer confirms it globally", async () => {
  const child = task("T-0940"), batch = captured([child.meta.id]); let pushes = 0, calls = 0;
  const control: StopControl = async (id) => { calls++; await locked(() => finish(id)); return "cancelled"; };
  const partial = await createStopDrainer(cfg, host, control, { ...io, push: async () => ++pushes !== 2 })(owner);
  expect(partial).toMatchObject({ complete: false, synced: false, remaining: 1 });
  const restored = await createStopDrainer(cfg, host, control, io)(owner, batch.operation_id);
  expect(restored).toMatchObject({ complete: true, synced: true, remaining: 0, operation_id: batch.operation_id }); expect(calls).toBe(1);
  expect(readDoc(P("tasks/rejected", `${child.meta.id}.md`)).meta.stop_intent).toBeUndefined();
  expect(readPlan(owner.id).pending_stops?.scope?.[0].run_id).toBe(child.meta.run_id); expect(pendingStopsView(readPlan(owner.id).pending_stops)).toBeUndefined();
  expect(() => archivePlan(owner.id)).not.toThrow();
});

test("owner operation conflicts cannot overwrite a newer cleanup after a control returns", async () => {
  const child = task("T-0950"), batch = captured([child.meta.id]);
  const newer = { ...batch, operation_id: crypto.randomUUID() };
  const drain = createStopDrainer(cfg, host, async () => { const value = readPlan(owner.id); value.pending_stops = newer; savePlan(value); return "cancelled"; }, io);
  await expect(drain(owner, batch.operation_id)).rejects.toMatchObject({ status: 409 });
  expect(readPlan(owner.id).pending_stops?.operation_id).toBe(newer.operation_id);
});

test("a lost capture CAS discovers a late reverse-linked grandchild from the original run before clearing its parent", async () => {
  const child = task("T-0960"), batch = captured([child.meta.id]); let pushes = 0, calls = 0;
  const raceIO = { ...io, push: async () => {
    if (++pushes === 1) { finish(child.meta.id, "done"); task("T-0961", "active", { parent: child.meta.id, source: `followup:${child.meta.id}`, spawned_by_run: child.meta.run_id }); }
    return true;
  } };
  const first = await createStopDrainer(cfg, host, async () => { calls++; return "cancelled"; }, raceIO)(owner);
  expect(first).toMatchObject({ complete: false, remaining: 1 }); expect(calls).toBe(0);
  expect(first.pending[0].id).toBe("T-0961"); expect(first.operation_id).toBe(batch.operation_id);
  const result = await createStopDrainer(cfg, host, complete, io)(owner, batch.operation_id);
  expect(result).toMatchObject({ complete: true, synced: true, remaining: 0 });
  expect(readPlan(owner.id).pending_stops?.scope?.map((item) => item.id).sort()).toEqual(["T-0960", "T-0961"]);
});

test("a late legacy reverse followup without run provenance stays unresolved after its parent naturally finishes", async () => {
  const child = task("T-0962"), batch = captured([child.meta.id]); let pushes = 0, calls = 0;
  const result = await createStopDrainer(cfg, host, async () => { calls++; return "Update the old machine"; }, { ...io, push: async () => {
    if (++pushes === 1) { finish(child.meta.id, "done"); task("T-0963", "active", { source: `followup:${child.meta.id}` }); }
    return true;
  } })(owner, batch.operation_id);
  expect(result).toMatchObject({ complete: false, synced: true, remaining: 1, operation_id: batch.operation_id });
  expect(result.pending).toHaveLength(0); expect(result.unresolved).toEqual([{ id: "T-0963", error: expect.stringContaining("Inspect") }]);
  expect(calls).toBe(0); expect(readDoc(P("tasks/active/T-0963.md")).meta.stop_intent).toBeUndefined();
  // Even a later separate cancellation cannot prove which historical run this unbound ID referred to.
  finish("T-0963");
  const retry = await createStopDrainer(cfg, host, complete, io)(owner, batch.operation_id);
  expect(retry).toMatchObject({ complete: false, remaining: 1, operation_id: batch.operation_id }); expect(retry.unresolved[0].id).toBe("T-0963");
});

test("a reverse followup with known different-run provenance is never captured or stopped by the older cleanup", async () => {
  const child = task("T-0964"), batch = captured([child.meta.id]); let pushes = 0, calls = 0;
  const other = crypto.randomUUID();
  const result = await createStopDrainer(cfg, host, async () => { calls++; return "cancelled"; }, { ...io, push: async () => {
    if (++pushes === 1) { finish(child.meta.id, "done"); task("T-0965", "active", { source: `followup:${child.meta.id}`, spawned_by_run: other }); }
    return true;
  } })(owner, batch.operation_id);
  expect(result).toMatchObject({ complete: true, synced: true, remaining: 0 }); expect(calls).toBe(0);
  expect(readDoc(P("tasks/active/T-0965.md")).meta.spawned_by_run).toBe(other); expect(readDoc(P("tasks/active/T-0965.md")).meta.stop_intent).toBeUndefined();
});

test("one bounded parallel pass shares concurrent owner retries and never holds the file lock during stops", async () => {
  const ids = Array.from({ length: 20 }, (_, n) => task(`T-${String(970 + n).padStart(4, "0")}`).meta.id), batch = captured(ids);
  let calls = 0, release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const control: StopControl = async (id) => { if (++calls === 16) release(); await barrier; await locked(() => finish(id)); return "cancelled"; };
  const drain = createStopDrainer(cfg, host, control, io);
  const results = await Promise.all([drain(owner, batch.operation_id), drain(owner, batch.operation_id)]);
  expect(calls).toBe(16); expect(results[0]).toEqual(results[1]); expect(results[0].remaining).toBe(4);
  expect(await createStopDrainer(cfg, host, complete, io)(owner)).toMatchObject({ complete: true, remaining: 0 });
});

test("legacy identities and malformed saved cleanup remain visible and cannot be silently removed", async () => {
  const child = task("T-0991", "active", { run_id: "legacy" }), batch = captured([child.meta.id]);
  expect(batch.pending).toHaveLength(0); expect(batch.unresolved[0].id).toBe(child.meta.id);
  expect(await createStopDrainer(cfg, host, complete, io)(owner)).toMatchObject({ complete: false, remaining: 1 });
  expect(hasPendingStops("not json")).toBe(true); expect(pendingStopsError("not json")).toContain("invalid"); expect(taskHasStopIntent({ stop_intent: "not json" })).toBe(true);
});

test("a scoped worker can settle its own targets but never delegates a different machine's run", async () => {
  const local = task("T-0994"), remote = task("T-0995", "active", { claimed_by: "another-worker", run_host: "another-worker" });
  captured([local.meta.id, remote.meta.id]); const calls: string[] = [];
  const result = await createStopDrainer(cfg, "worker", async (id) => { calls.push(id); await locked(() => finish(id)); return "cancelled"; }, io)(owner);
  expect(calls).toEqual([local.meta.id]); expect(result).toMatchObject({ complete: false, remaining: 1 });
  expect(result.pending[0]).toMatchObject({ id: remote.meta.id, run_id: remote.meta.run_id }); expect(result.pending[0].error).toContain("main machine");
});

test("late descendants revealed during terminal-proof sync stay pending in the same operation", async () => {
  const child = task("T-0996"), batch = captured([child.meta.id]); let pushes = 0;
  const result = await createStopDrainer(cfg, host, complete, { ...io, push: async () => {
    if (++pushes === 2) task("T-0997", "active", { source: `followup:${child.meta.id}`, spawned_by_run: child.meta.run_id });
    return true;
  } })(owner);
  expect(result).toMatchObject({ complete: false, synced: true, remaining: 1, operation_id: batch.operation_id });
  expect(result.pending[0].id).toBe("T-0997");
});

test("startup settles exact marked children and removes duplicate active owners without losing their batch", () => {
  const child = task("T-0992"), batch = captured([child.meta.id]);
  expect(settleTaskStop(child.path)).toBe(true); expect(existsSync(child.path)).toBe(false);
  const parent = task("T-0993"), pending = { ...batch, pending: [] };
  const doc = readDoc(parent.path); writeDoc(P("tasks/rejected/T-0993.md"), { ...doc.meta, claimed_by: undefined, pending_stops: JSON.stringify(pending), cancelled: new Date().toISOString() }, doc.body);
  expect(settleTaskStop(parent.path)).toBe(true); expect(existsSync(parent.path)).toBe(false);
  expect(readPendingStops(readDoc(P("tasks/rejected/T-0993.md")).meta.pending_stops)?.operation_id).toBe(batch.operation_id);
});

test("a duplicate active parent cannot hide its terminal batch or report cleanup complete", async () => {
  const parent = task("T-1100"), child = task("T-1101"), taskOwner: StopOwner = { kind: "task", id: parent.meta.id };
  const batch = captureTaskStops([child.meta.id], taskOwner, false)!;
  const doc = readDoc(parent.path);
  writeDoc(P("tasks/rejected", `${parent.meta.id}.md`), { ...doc.meta, claimed_by: undefined, pending_stops: JSON.stringify(batch), cancelled: new Date().toISOString() }, doc.body);
  let calls = 0; const drain = createStopDrainer(cfg, host, async () => { calls++; return "cancelled"; }, io);
  const result = await drain(taskOwner, batch.operation_id);
  expect(result).toMatchObject({ operation_id: batch.operation_id, complete: false, synced: false, remaining: 1 });
  expect(result.pending[0].id).toBe(child.meta.id); expect(result.terminal).toBeUndefined(); expect(result.error).toContain("active copy"); expect(calls).toBe(0);
  expect((await drain()).remaining).toBe(1);
  expect(settleTaskStop(parent.path)).toBe(true);
  expect(await createStopDrainer(cfg, host, complete, io)(taskOwner, batch.operation_id)).toMatchObject({ complete: true, synced: true, remaining: 0, terminal: { id: parent.meta.id, run_id: parent.meta.run_id } });
});

test("a terminal cleanup belonging to an older run is never rebound to the current active parent", async () => {
  const original = task("T-1102"), child = task("T-1103"), taskOwner: StopOwner = { kind: "task", id: original.meta.id };
  const batch = captureTaskStops([child.meta.id], taskOwner, true)!;
  const doc = readDoc(original.path); writeDoc(P("tasks/done", `${original.meta.id}.md`), { ...doc.meta, claimed_by: undefined, pending_stops: JSON.stringify(batch), finished: new Date().toISOString() }, doc.body);
  const newer = task(original.meta.id); let calls = 0;
  const result = await createStopDrainer(cfg, host, async () => { calls++; return "done"; }, io)(taskOwner, batch.operation_id);
  expect(result.complete).toBe(false); expect(result.terminal).toBeUndefined(); expect(result.operation_id).toBe(batch.operation_id);
  expect(calls).toBe(0); expect(readDoc(newer.path).meta.run_id).toBe(newer.meta.run_id);
});

test("the pure cleanup view works without structuredClone and counts UTF-8 like the file transport", () => {
  const child = task("T-1104"), batch = captured([child.meta.id]);
  const clone = spyOn(globalThis, "structuredClone").mockImplementation(() => { throw new Error("not provided by native UI"); });
  try { expect(pendingStopsView(JSON.stringify(batch))).toEqual(batch); expect(pendingStopsView(batch)).toEqual(batch); }
  finally { clone.mockRestore(); }
  for (const value of ["ASCII", "研究", "👩🏽‍💻", "e\u0301", "\ud800"]) expect(stopUtf8Length(value)).toBe(Buffer.byteLength(value));
});

test("a generated 500-target batch including bounded errors fits the shared file limit without dropping identities", () => {
  const ids = Array.from({ length: 500 }, (_, n) => task(`T-${String(2000 + n).padStart(4, "0")}`, "active", { claimed_by: "w".repeat(80), run_host: "w".repeat(80) }).meta.id);
  const batch = captured(ids); batch.pending = batch.pending.map((target) => ({ ...target, error: "e".repeat(256) }));
  expect(batch.pending).toHaveLength(500); expect(batch.scope).toHaveLength(500); expect(batch.seen).toHaveLength(500);
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(MAX_STOP_BATCH_BYTES);
  expect(STOP_RECORD_MAX_BYTES).toBe(MAX_FILE);
  expect(() => assertStopRecordSize(JSON.stringify({ ...readPlan(owner.id), pending_stops: batch }, null, 2))).not.toThrow();
});

test("oversized saved batches stay blocked and visible rather than being silently ignored by sync", async () => {
  const child = task("T-1105"), batch = captured([child.meta.id]);
  const oversized = { ...batch, pending: Array.from({ length: 500 }, (_, n) => ({ ...batch.pending[0], id: `T-${3000 + n}`, error: "研究".repeat(600) })) };
  // Simulate a pre-existing oversized record without routing it through the new guarded writer.
  writeDoc(P("tasks/rejected/T-1106.md"), { id: "T-1106", pending_stops: JSON.stringify(oversized) }, "Keep targets");
  expect(readPendingStops(oversized)).toBeUndefined(); expect(hasPendingStops(oversized)).toBe(true); expect(pendingStopsError(oversized)).toContain("too large");
  const before = readFileSync(P("tasks/rejected/T-1106.md"), "utf8");
  await expect(createStopDrainer(cfg, host, complete, io)({ kind: "task", id: "T-1106" }, batch.operation_id)).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(P("tasks/rejected/T-1106.md"), "utf8")).toBe(before);
});

test("owner and child size checks run before queued transitions or active markers are written", () => {
  const parent = task("T-1107"), child = task("T-1108"), queued = task("T-1109", "inbox");
  const body = "x".repeat(1_499_000); writeDoc(parent.path, parent.meta, body);
  expect(Buffer.byteLength(readFileSync(parent.path))).toBeLessThan(MAX_FILE);
  expect(() => captureTaskStops([queued.meta.id, child.meta.id], { kind: "task", id: parent.meta.id }, false)).toThrow("size limit");
  expect(existsSync(queued.path)).toBe(true); expect(readDoc(child.path).meta.stop_intent).toBeUndefined(); expect(readDoc(parent.path).body.trim()).toBe(body);
  writeDoc(parent.path, parent.meta, "Small parent");
  const largeChild = task("T-1110"); writeDoc(largeChild.path, largeChild.meta, "x".repeat(MAX_FILE - Buffer.byteLength(stopDocText(largeChild.meta, "")) - 64));
  expect(Buffer.byteLength(readFileSync(largeChild.path))).toBeLessThan(MAX_FILE);
  expect(() => captureTaskStops([queued.meta.id, largeChild.meta.id], { kind: "task", id: parent.meta.id }, false)).toThrow("size limit");
  expect(existsSync(queued.path)).toBe(true); expect(readDoc(largeChild.path).meta.stop_intent).toBeUndefined();
});
