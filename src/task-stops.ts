import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type Cfg, P, _commitPush, _pull, isPrimary, list, loadConfig, locked, readDoc, writeDoc } from "./core";
import { listPlans, readPlan, savePlan, type Plan } from "./plans";
import { RequestError } from "./members";
import { assertStopOwnerSize, assertStopRecordSize, captureTaskStops, hasPendingStops, matchingStopIntent, pendingStopsError, readPendingStops, readStopIntent, readStopReviewAudit, stopDocText, stopHostId, stopRunId, stopTaskId, stopTaskPath, StopStorageError, STOP_TASK_DIRS, taskHasStopIntent, validStopOwner, validStopResolveRequest, validStopReviewRequest,
  type PendingStops, type StopOwner, type StopTarget, type UnresolvedStop, type StopResolveRequest, type StopResolveResult, type StopReviewAudit, type StopReviewPreview, type StopReviewRequest, type StopReviewedIdentity, type StopReviewTarget } from "./stop-intents";

export type StopDrainResult = { owner?: StopOwner; operation_id?: string; done?: boolean; complete: boolean; synced: boolean; remaining: number; pending: StopTarget[]; unresolved: UnresolvedStop[];
  pending_stops?: PendingStops; plan?: Plan; terminal?: { id: string; host?: string; run_id?: string; result: "done" | "cancelled" | "failed" }; error?: string };
export type StopControl = (id: string, done: boolean, expected: { host: string; run_id: string }) => Promise<string>;
export type StopDrainer = (owner?: StopOwner, expectedOperationId?: string) => Promise<StopDrainResult>;
type StopIO = { pull: () => Promise<boolean>; push: (message: string) => Promise<boolean> };
export * from "../cloud/src/stop-intents";

function ownerRecord(owner: StopOwner) {
  if (owner.kind === "plan") {
    const plan = readPlan(owner.id);
    return { raw: plan.pending_stops, plan, terminal: undefined, blocked: undefined, save: (batch: PendingStops) => { plan.pending_stops = batch; savePlan(plan); } };
  }
  if (!stopTaskPath(owner.id)) throw new RequestError(404, "No such task cleanup");
  const records = STOP_TASK_DIRS.map((state) => ({ state, path: P("tasks", state, `${owner.id}.md`) })).filter((item) => existsSync(item.path)).map((item) => ({ ...item, doc: readDoc(item.path) }));
  const outstanding = records.filter((item) => hasPendingStops(item.doc.meta.pending_stops));
  const selected = outstanding[0] ?? records.find((item) => readPendingStops(item.doc.meta.pending_stops)) ?? records[0];
  const { path, state, doc } = selected, batch = readPendingStops(doc.meta.pending_stops), active = records.find((item) => item.state === "active");
  const competing = outstanding.some((item) => item !== selected && readPendingStops(item.doc.meta.pending_stops)?.operation_id !== batch?.operation_id);
  const blocked = competing ? "This task has conflicting saved cleanup operations. Recover its owning machine and refresh before retrying."
    : active && records.some((item) => ["done", "failed", "rejected"].includes(item.state) && item.doc.meta.pending_stops) ? "This task still has an active copy alongside its terminal cleanup record. Recover its owning machine before cleanup can be confirmed."
    : active && doc.meta.pending_stops ? "This parent task is still active. Its own run must be stopped and confirmed before child cleanup can finish." : undefined;
  const terminal = !blocked && ["done", "failed", "rejected"].includes(state) ? { id: owner.id, host: doc.meta.run_host || doc.meta.claimed_by || undefined,
    run_id: doc.meta.run_id || undefined, result: (state === "rejected" ? "cancelled" : state) as "done" | "failed" | "cancelled" } : undefined;
  return { raw: doc.meta.pending_stops, plan: undefined, terminal, blocked, save: (batch: PendingStops) => {
    if (blocked) throw new RequestError(409, blocked);
    const meta = { ...doc.meta, pending_stops: JSON.stringify(batch) };
    assertStopRecordSize(stopDocText(meta, doc.body)); writeDoc(path, meta, doc.body);
  } };
}
function progress(owner: StopOwner, synced: boolean, error?: string): StopDrainResult {
  const record = ownerRecord(owner), batch = readPendingStops(record.raw), remaining = Math.max(record.blocked ? 1 : 0, batch ? batch.pending.length + batch.unresolved.length : hasPendingStops(record.raw) ? 1 : 0);
  return { owner, operation_id: batch?.operation_id, done: batch?.done, complete: synced && !record.blocked && remaining === 0, synced: synced && !record.blocked, remaining,
    pending: batch?.pending ?? [], unresolved: batch?.unresolved ?? [], pending_stops: batch, plan: record.plan, terminal: record.terminal, error: record.blocked ?? error ?? pendingStopsError(record.raw) };
}
function terminalProof(target: StopTarget): boolean {
  if (existsSync(P("tasks/active", `${target.id}.md`))) return false;
  return ["done", "failed", "rejected"].some((dir) => {
    const path = P("tasks", dir, `${target.id}.md`);
    if (!existsSync(path)) return false;
    const meta = readDoc(path).meta;
    return meta.run_id === target.run_id && (meta.run_host || meta.claimed_by) === target.host;
  });
}
function clearMarker(target: StopTarget, owner: StopOwner, operation: string) {
  for (const dir of ["done", "failed", "rejected"]) {
    const path = P("tasks", dir, `${target.id}.md`);
    if (!existsSync(path)) continue;
    const doc = readDoc(path), intent = readStopIntent(doc.meta);
    if (intent?.operation_id === operation && intent.owner.kind === owner.kind && intent.owner.id === owner.id && intent.host === target.host && intent.run_id === target.run_id)
      writeDoc(path, { ...doc.meta, stop_intent: undefined }, doc.body);
  }
}
const owners = (): StopOwner[] => [
  ...listPlans().filter((plan) => hasPendingStops(plan.pending_stops)).map((plan) => ({ kind: "plan" as const, id: plan.id })),
  ...new Set(STOP_TASK_DIRS.flatMap((dir) => list(P("tasks", dir), /^T-[\w-]*\d{4}\.md$/).filter((path) => hasPendingStops(readDoc(path).meta.pending_stops)).map((path) => readDoc(path).meta.id)))
].map((owner) => typeof owner === "string" ? { kind: "task" as const, id: owner } : owner);

const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const reviewHash = (value: unknown) => new Bun.CryptoHasher("sha256").update(canonical(value)).digest("hex");
const reviewPath = (owner: StopOwner, id: string) => P("fleet", "stop-reviews", `${owner.kind}-${owner.id}`, `${id}.json`);
const taskRecords = (id: string) => STOP_TASK_DIRS.map((state) => ({ state, path: P("tasks", state, `${id}.md`) })).filter((record) => existsSync(record.path)).map((record) => ({ ...record, doc: readDoc(record.path) }));
const parentTask = (meta: Record<string, string>) => stopTaskId(meta.parent) ? meta.parent : meta.source?.match(/^followup:(T-[\w-]*\d{4})$/)?.[1];
const recordIdentity = (state: string, meta: Record<string, string>, body = "") => ({ state, ...Object.fromEntries([
  "id", "title", "claimed_by", "run_host", "run_id", "host", "requires", "prefer", "weight", "project", "repo", "cli", "agent", "children", "parent", "source", "spawned_by_run", "status",
].filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]])), stop_intent: readStopIntent(meta) ?? meta.stop_intent,
  ...(["inbox", "waiting", "blocked", "proposed"].includes(state) ? { request_hash: reviewHash(body) } : {}) });

function reviewInspection(input: StopReviewRequest) {
  if (!validStopReviewRequest(input)) throw new RequestError(400, "Choose the saved cleanup operation and target");
  const record = ownerRecord(input.owner), batch = readPendingStops(record.raw);
  if (!batch || batch.operation_id !== input.operation_id) throw new RequestError(409, "This cleanup operation changed. Refresh it before reviewing a target.");
  const pending = batch.pending.filter((target) => target.id === input.target_id), unresolved = batch.unresolved.filter((target) => target.id === input.target_id);
  if (pending.length + unresolved.length !== 1) throw new RequestError(409, "This target is no longer a unique pending cleanup row. Refresh its saved cleanup.");
  const original: StopReviewTarget = pending.length ? { kind: "pending", id: pending[0].id, host: pending[0].host, run_id: pending[0].run_id, done: pending[0].done } : { kind: "unresolved", id: input.target_id };
  const records = taskRecords(input.target_id);
  const state = records.length === 0 ? "missing" : records.length > 1 || records[0].doc.meta.id !== input.target_id ? "conflicting"
    : records[0].state === "active" ? "active" : ["done", "failed", "rejected"].includes(records[0].state) ? "terminal" : "queued";
  const current: StopReviewedIdentity = { state, records: records.map(({ state, doc }) => ({ state, title: String(doc.meta.title ?? input.target_id).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200),
    ...(stopHostId(doc.meta.claimed_by || doc.meta.run_host) ? { host: doc.meta.claimed_by || doc.meta.run_host } : {}), ...(stopRunId(doc.meta.run_id) ? { run_id: doc.meta.run_id } : {}) })) };
  const all = STOP_TASK_DIRS.flatMap((folder) => list(P("tasks", folder), /^T-[\w-]*\d{4}\.md$/).map((path) => ({ state: folder, doc: readDoc(path) })));
  const graph = new Set([input.target_id]), queue = [input.target_id];
  while (queue.length && graph.size <= 500) {
    const id = queue.shift()!;
    for (const item of all.filter((item) => item.doc.meta.id === id)) {
      const children = String(item.doc.meta.children ?? "").split(",").map((child) => child.trim()).filter(stopTaskId);
      for (const linked of all) if (parentTask(linked.doc.meta) === id && (!linked.doc.meta.spawned_by_run || linked.doc.meta.spawned_by_run === item.doc.meta.run_id)) children.push(linked.doc.meta.id);
      for (const child of children) if (stopTaskId(child) && !graph.has(child)) { graph.add(child); queue.push(child); }
    }
  }
  let includeReason = record.blocked;
  if (!includeReason && input.owner.kind === "task" && input.owner.id === input.target_id) includeReason = "Stop the parent task through its own controls before reviewing its child cleanup.";
  if (!includeReason && state === "missing") includeReason = "No task record is available to include. Exclude it only after reviewing why it is missing.";
  if (!includeReason && state === "conflicting") includeReason = "This task has conflicting copies. Inspect and recover its machine before including a run.";
  if (!includeReason && state === "active" && (!stopHostId(records[0].doc.meta.claimed_by) || !stopRunId(records[0].doc.meta.run_id))) includeReason = "This active task has no verifiable machine/run identity. Update and recover its machine first.";
  if (!includeReason && graph.size > 500) includeReason = "This task family exceeds the review limit. Inspect its related tasks before including it.";
  if (!includeReason && [...graph].some((id) => all.filter((item) => item.doc.meta.id === id).length > 1)) includeReason = "The reviewed task family contains conflicting copies. Recover those tasks before including it.";
  if (!includeReason && records[0]) {
    const meta = records[0].doc.meta, intent = readStopIntent(meta), own = intent?.operation_id === input.operation_id && intent.owner.kind === input.owner.kind && intent.owner.id === input.owner.id;
    if (taskHasStopIntent(meta) && (!intent || !own && !matchingStopIntent(meta) || intent.done !== batch.done)) includeReason = "This task has an unverified or conflicting stop marker. Review its existing cleanup before including it.";
    if (hasPendingStops(meta.pending_stops)) includeReason = "This task still owns another pending cleanup. Finish that cleanup before including this task.";
  }
  const identities = all.filter((item) => graph.has(item.doc.meta.id)).map((item) => recordIdentity(item.state, item.doc.meta, item.doc.body)).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const basis = { owner: input.owner, operation_id: input.operation_id, done: batch.done, target: original, owner_terminal: record.terminal, owner_blocked: record.blocked,
    records: records.map((item) => recordIdentity(item.state, item.doc.meta, item.doc.body)), graph: identities, scope: batch.scope?.filter((target) => graph.has(target.id)).map(({ id, host, run_id, done }) => ({ id, host, run_id, done })),
    excluded: batch.excluded?.filter((entry) => graph.has(entry.id)).map((entry) => ({ id: entry.id, review_id: entry.review_id })),
    reviews: batch.reviews?.filter((entry) => entry.target_id === input.target_id).map((entry) => ({ request_id: entry.request_id, request_hash: entry.request_hash })) };
  const related = [...graph].filter((id) => id !== input.target_id).sort().slice(0, 500).map((id) => {
    const found = all.filter((item) => item.doc.meta.id === id);
    const state = !found.length ? "missing" : found.length > 1 ? "conflicting" : found[0].state === "active" ? "active" : ["done", "failed", "rejected"].includes(found[0].state) ? "terminal" : "queued";
    return { id, current: { state, records: found.map(({ state, doc }) => ({ state, title: String(doc.meta.title ?? id).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200),
      ...(stopHostId(doc.meta.claimed_by || doc.meta.run_host) ? { host: doc.meta.claimed_by || doc.meta.run_host } : {}), ...(stopRunId(doc.meta.run_id) ? { run_id: doc.meta.run_id } : {}) })) } as StopReviewedIdentity };
  });
  const preview: StopReviewPreview = { ...input, preview_digest: reviewHash(basis), target: original, current, related, can_include: !includeReason, ...(includeReason ? { include_reason: includeReason } : {}) };
  assertStopRecordSize(JSON.stringify(preview));
  return { record, batch, preview, records };
}

/** Caller has checked primary authority and refreshed the shared mirror under locked(). */
export const inspectStopReview = (input: StopReviewRequest): StopReviewPreview => reviewInspection(input).preview;
const resolvePayload = (input: StopResolveRequest) => ({ owner: input.owner, operation_id: input.operation_id, target_id: input.target_id, preview_digest: input.preview_digest, action: input.action, reason: input.reason.trim() });
function resolutionResult(review: StopReviewAudit, batch: PendingStops): StopResolveResult {
  const remaining = batch.pending.length + batch.unresolved.length;
  return { owner: review.owner, operation_id: review.operation_id, target_id: review.target_id, preview_digest: review.preview_digest, action: review.action, reason: review.reason,
    request_id: review.request_id, review_id: review.review_id, review, pending_stops: batch, remaining, complete: remaining === 0 };
}
export class StopReviewSaveError extends Error {
  constructor(message: string, readonly resolution: StopResolveResult) { super(message); }
}
function existingAudit(owner: StopOwner, id: string): StopReviewAudit | undefined {
  const path = reviewPath(owner, id);
  if (!existsSync(path)) return undefined;
  let audit: StopReviewAudit | undefined;
  try { audit = readStopReviewAudit(JSON.parse(readFileSync(path, "utf8"))); } catch { /* Invalid immutable history must never authorize a replay. */ }
  if (!audit || audit.owner.kind !== owner.kind || audit.owner.id !== owner.id || audit.request_id !== id || reviewHash(resolvePayload(audit)) !== audit.request_hash)
    throw new RequestError(409, "The saved review audit cannot be verified. Refresh and inspect this cleanup before another decision.");
  return audit;
}
function saveAudit(audit: StopReviewAudit) {
  const previous = existingAudit(audit.owner, audit.request_id);
  if (previous) {
    if (canonical(previous) !== canonical(audit)) throw new RequestError(409, "This review ID already records a different decision");
    return;
  }
  const dir = P("fleet", "stop-reviews", `${audit.owner.kind}-${audit.owner.id}`), path = reviewPath(audit.owner, audit.request_id), temporary = `${path}.tmp`;
  const text = JSON.stringify(audit, null, 2) + "\n"; assertStopRecordSize(text); mkdirSync(dir, { recursive: true });
  try { writeFileSync(temporary, text); renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
}
export function readStopReviews(owner: StopOwner): StopReviewAudit[] {
  if (!validStopOwner(owner)) return [];
  const saved = list(P("fleet", "stop-reviews", `${owner.kind}-${owner.id}`), /^[a-f0-9-]{36}\.json$/i).flatMap((path) => {
    try { const value = readStopReviewAudit(JSON.parse(readFileSync(path, "utf8"))); return value && value.owner.kind === owner.kind && value.owner.id === owner.id ? [value] : []; } catch { return []; }
  });
  let current: StopReviewAudit[] = []; try { current = readPendingStops(ownerRecord(owner).raw)?.reviews ?? []; } catch { /* Archived owners still have immutable review history. */ }
  const byId = new Map(saved.map((review) => [review.request_id, review]));
  for (const review of current) if (!byId.has(review.request_id)) byId.set(review.request_id, review);
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at) || b.review_id.localeCompare(a.review_id)).slice(0, 500);
}
function removeReviewedMarker(owner: StopOwner, operation: string, id: string, allowed: StopTarget[], apply: boolean) {
  for (const { path, doc } of taskRecords(id)) {
    const intent = readStopIntent(doc.meta);
    if (!intent || intent.operation_id !== operation || intent.owner.kind !== owner.kind || intent.owner.id !== owner.id) continue;
    if (!allowed.some((target) => target.id === id && target.host === intent.host && target.run_id === intent.run_id)
      && !(intent.host === (doc.meta.claimed_by || doc.meta.run_host) && intent.run_id === doc.meta.run_id)) continue;
    assertStopRecordSize(stopDocText({ ...doc.meta, stop_intent: undefined }, doc.body));
    if (apply) writeDoc(path, { ...doc.meta, stop_intent: undefined }, doc.body);
  }
}

/** Records authorization only. The existing drainer separately performs any newly included exact stop. */
export function applyStopResolution(input: StopResolveRequest): StopResolveResult {
  if (!validStopResolveRequest(input)) throw new RequestError(400, "Choose a current review, a supported decision and a reason up to 500 characters");
  const record = ownerRecord(input.owner), batch = readPendingStops(record.raw), payloadHash = reviewHash(resolvePayload(input));
  if (!batch || batch.operation_id !== input.operation_id) throw new RequestError(409, "This cleanup operation changed. Refresh it before recording a decision.");
  const replay = batch.reviews?.find((review) => review.request_id === input.request_id);
  const file = existingAudit(input.owner, input.request_id);
  if (replay) {
    if (replay.request_hash !== payloadHash || file && canonical(file) !== canonical(replay)) throw new RequestError(409, "This review ID was already used for a different decision");
    const result = resolutionResult(replay, batch);
    try { saveAudit(replay); } catch (error) { if (error instanceof RequestError) throw error; throw new StopReviewSaveError("The review was saved, but its audit file could not be confirmed. Retry this same review request.", result); }
    return result;
  }
  if (file) throw new RequestError(409, file.request_hash === payloadHash ? "A saved audit exists without its owner decision. Refresh and make a new explicit review; this request will not be applied blindly." : "This review ID was already used for a different decision");
  if (record.blocked) throw new RequestError(409, record.blocked);
  const inspection = reviewInspection({ owner: input.owner, operation_id: input.operation_id, target_id: input.target_id });
  if (inspection.preview.preview_digest !== input.preview_digest) throw new RequestError(409, "This task or its related runs changed after the preview. Refresh the review before deciding.");
  if (input.action === "include" && !inspection.preview.can_include) throw new RequestError(409, inspection.preview.include_reason!);
  if ((batch.reviews?.length ?? 0) >= 500) throw new StopStorageError("This cleanup has reached its review history limit. Its remaining targets have been kept for review.");
  const review: StopReviewAudit = { ...input, reason: input.reason.trim(), review_id: input.request_id, at: new Date().toISOString(), original: inspection.preview.target, reviewed: inspection.preview.current, request_hash: payloadHash };
  let next: PendingStops = { ...structuredClone(batch), pending: batch.pending.filter((target) => target.id !== input.target_id), unresolved: batch.unresolved.filter((target) => target.id !== input.target_id),
    seen: [...new Set([...(batch.seen ?? []), ...(batch.scope?.map((target) => target.id) ?? []), ...batch.pending.map((target) => target.id), ...batch.unresolved.map((target) => target.id), input.target_id])], reviews: [...(batch.reviews ?? []), review] };
  if (input.action === "exclude") {
    next.excluded = [...(batch.excluded ?? []), { id: input.target_id, review_id: review.review_id, reason: review.reason, at: review.at, reviewed: review.reviewed, stopped: false }];
  }
  const authorization = structuredClone(next);
  const include = input.action === "include";
  if (include) {
    try { next = captureTaskStops([], input.owner, batch.done, next, { reviewed: [input.target_id], dryRun: true })!; }
    catch (error) { if (error instanceof StopStorageError || error instanceof RequestError) throw error; throw new RequestError(409, error instanceof Error ? error.message : "The related task graph could not be verified"); }
  }
  if (!readPendingStops(next)) throw new StopStorageError("This review would exceed the cleanup's safety or history limits. No targets were changed.");
  assertStopOwnerSize(input.owner, next);
  removeReviewedMarker(input.owner, input.operation_id, input.target_id, batch.scope ?? batch.pending, false);
  try {
    if (include) {
      next = captureTaskStops([], input.owner, batch.done, authorization, { reviewed: [input.target_id] })!;
      if (inspection.preview.current.state !== "active") removeReviewedMarker(input.owner, input.operation_id, input.target_id, next.scope ?? [], true);
    }
    else removeReviewedMarker(input.owner, input.operation_id, input.target_id, batch.scope ?? batch.pending, true);
    record.save(next);
    saveAudit(review);
  } catch (error) {
    if (error instanceof RequestError || error instanceof StopStorageError) throw error;
    throw new StopReviewSaveError("Some review changes could not be confirmed. Retry this same request; if its task snapshot changed, refresh and make a new explicit review.", resolutionResult(review, next));
  }
  return resolutionResult(review, next);
}

export async function previewStop(owner: StopOwner, operation_id: string, target_id: string, io: StopIO = { pull: _pull, push: _commitPush }): Promise<StopReviewPreview> {
  return locked(async () => {
    let fresh = false; try { fresh = await io.pull(); } catch { /* Fail closed before inspecting stale records. */ }
    if (!fresh) throw new RequestError(503, "Could not refresh this cleanup. Nothing was changed.");
    if (!isPrimary(loadConfig())) throw new RequestError(409, "Open the main machine to review this cleanup");
    return inspectStopReview({ owner, operation_id, target_id });
  });
}
export async function resolveStop(input: StopResolveRequest, io: StopIO = { pull: _pull, push: _commitPush }): Promise<StopResolveResult & { synced: boolean }> {
  return locked(async () => {
    let fresh = false; try { fresh = await io.pull(); } catch { /* No decision may use a stale snapshot. */ }
    if (!fresh) throw new RequestError(503, "Could not refresh this cleanup. Nothing was changed.");
    if (!isPrimary(loadConfig())) throw new RequestError(409, "Open the main machine to review this cleanup");
    const result = applyStopResolution(input);
    let synced = false; try { synced = await io.push(`cleanup review ${result.review_id}`); } catch { /* Preserve the stable saved review identity. */ }
    return { ...result, synced };
  });
}

/** Only the primary invokes remote controls. Its progress is derived from refreshed task records, never an HTTP success alone. */
export function createStopDrainer(cfg: Cfg, host: string, control: StopControl, io: StopIO = { pull: _pull, push: _commitPush }): StopDrainer {
  const inflight = new Map<string, Promise<StopDrainResult>>();
  let cursor = 0;
  const checked = (owner: StopOwner, expected?: string) => {
    const record = ownerRecord(owner), batch = readPendingStops(record.raw);
    if (hasPendingStops(record.raw) && !batch) throw new RequestError(409, pendingStopsError(record.raw)!);
    if (expected && batch?.operation_id !== expected) throw new RequestError(409, "This cleanup operation changed. Refresh it before retrying.");
    return { record, batch };
  };
  const push = async (message: string) => { try { return await io.push(message); } catch { return false; } };
  const pull = async () => { try { return await io.pull(); } catch { return false; } };
  const perform = async (owner: StopOwner, expected?: string): Promise<StopDrainResult> => {
    const snapshot = await locked(async () => {
      if (!await pull()) return { result: progress(owner, false, "Could not refresh this cleanup. Its saved targets have been kept.") };
      const { record, batch } = checked(owner, expected);
      if (record.blocked) return { result: progress(owner, false, record.blocked) };
      if (!batch) {
        const synced = await push(`[${host}] confirm task state ${owner.id}`);
        return { result: progress(owner, synced, synced ? undefined : "The task state is saved locally but sync was not confirmed.") };
      }
      const expanded = captureTaskStops([], owner, batch.done, batch)!;
      record.save(expanded);
      if (!await push(`[${host}] record cleanup ${owner.id}`)) return { result: progress(owner, false, "Cleanup was saved locally but sync was not confirmed.") };
      const current = checked(owner, batch.operation_id).batch!;
      return { batch: current, targets: current.pending.filter((target) => !terminalProof(target)).slice(0, 16) };
    });
    if (snapshot.result) return snapshot.result;
    const operation = snapshot.batch!.operation_id, errors = new Map<string, string>();
    await Promise.all(snapshot.targets!.map(async (target) => {
      const key = `${target.id}:${target.run_id}`;
      const authorized = await locked(() => {
        const record = ownerRecord(owner), current = readPendingStops(record.raw);
        return !record.blocked && current?.operation_id === operation && !current.excluded?.some((entry) => entry.id === target.id)
          && current.pending.some((item) => item.id === target.id && item.host === target.host && item.run_id === target.run_id && item.done === target.done);
      });
      if (!authorized) { errors.set(key, "This stop was removed or reviewed before dispatch. An earlier dispatched stop may still finish."); return; }
      const path = P("tasks/active", `${target.id}.md`);
      if (!existsSync(path)) { errors.set(key, "No synced terminal record confirms this exact run stopped."); return; }
      const meta = readDoc(path).meta;
      if (meta.run_id !== target.run_id || meta.claimed_by !== target.host) { errors.set(key, "This task now has a different run. The older cleanup will not stop its new attempt."); return; }
      if (target.host !== host && !isPrimary(cfg, host)) { errors.set(key, "The main machine must confirm this remote run stopped."); return; }
      try {
        const result = await control(target.id, target.done, { host: target.host, run_id: target.run_id });
        if (result !== "done" && result !== "cancelled") errors.set(key, String(result).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256));
      } catch { errors.set(key, "The machine could not confirm this run stopped. Check its status and retry cleanup."); }
    }));
    return locked(async () => {
      if (!await pull()) return progress(owner, false, "Could not refresh stop confirmations. The saved targets remain pending.");
      let { record, batch } = checked(owner, operation);
      batch = captureTaskStops([], owner, batch!.done, batch)!;
      // Flush any locally stopped terminal task before treating its record as shared proof.
      record.save(batch);
      if (!await push(`[${host}] sync stopped runs for ${owner.id}`)) return progress(owner, false, "Stopped runs or cleanup progress were saved locally but sync was not confirmed.");
      ({ record, batch } = checked(owner, operation));
      batch = captureTaskStops([], owner, batch!.done, batch)!; // A conflict pull during push may have revealed late descendants.
      const remaining: StopTarget[] = [];
      for (const target of batch!.pending) {
        if (terminalProof(target)) clearMarker(target, owner, operation);
        else remaining.push({ ...target, error: errors.get(`${target.id}:${target.run_id}`) || target.error || "No synced terminal record confirms this exact run stopped." });
      }
      record.save({ ...batch!, pending: remaining });
      const synced = await push(`[${host}] cleanup progress ${owner.id}`);
      checked(owner, operation);
      return progress(owner, synced, synced ? undefined : "Cleanup progress was saved locally but sync was not confirmed.");
    });
  };
  const drainOwner = async (owner: StopOwner, expected?: string) => {
    const key = `${owner.kind}:${owner.id}`, running = inflight.get(key);
    if (running) {
      const result = await running;
      if (expected && result.operation_id !== expected) throw new RequestError(409, "This cleanup operation changed. Refresh it before retrying.");
      return result;
    }
    const job = perform(owner, expected).catch((error) => { if (error instanceof StopStorageError) return progress(owner, false, error.message); throw error; }); inflight.set(key, job);
    try { return await job; } finally { if (inflight.get(key) === job) inflight.delete(key); }
  };
  return async (owner, expected) => {
    if (owner) return drainOwner(owner, expected);
    const snapshot = await locked(async () => ({ refreshed: await pull(), all: owners() })), all = snapshot.all;
    if (!snapshot.refreshed) {
      const known = all.map((item) => progress(item, false));
      return { complete: false, synced: false, remaining: known.reduce((sum, item) => sum + item.remaining, 0), pending: known.flatMap((item) => item.pending),
        unresolved: known.flatMap((item) => item.unresolved), error: "Could not refresh saved cleanup operations. Their targets have been kept." };
    }
    if (!all.length) return { complete: true, synced: true, remaining: 0, pending: [], unresolved: [] };
    const selected = all[cursor++ % all.length], result = await drainOwner(selected);
    const rest = await locked(() => owners().filter((item) => item.kind !== selected.kind || item.id !== selected.id).map((item) => progress(item, false)));
    return { complete: result.complete && !rest.length, synced: result.synced, remaining: result.remaining + rest.reduce((sum, item) => sum + item.remaining, 0),
      pending: [...result.pending, ...rest.flatMap((item) => item.pending)], unresolved: [...result.unresolved, ...rest.flatMap((item) => item.unresolved)], error: result.error };
  };
}
