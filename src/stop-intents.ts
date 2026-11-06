import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { P, list, now, readDoc, writeDoc } from "./core";

export * from "../cloud/src/stop-intents";
import { MAX_STOP_BATCH_BYTES, stopUtf8Length, readPendingStops, readStopIntent, matchingStopIntent, taskHasStopIntent, stopRunId as uuid, stopTaskId as taskId, stopHostId as hostId, validStopOwner as ownerId, type PendingStops, type StopOwner, type StopTarget, type StopIntent } from "../cloud/src/stop-intents";
export const STOP_TASK_DIRS = ["active", "inbox", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
export const stopTaskPath = (id: string): string | undefined => taskId(id) ? STOP_TASK_DIRS.map((dir) => P("tasks", dir, `${id}.md`)).find(existsSync) : undefined;
export class StopStorageError extends Error {}
// Keep in step with sync.MAX_FILE; the limit applies to the complete owner/task record, not only its cleanup JSON.
export const STOP_RECORD_MAX_BYTES = 1_500_000;
export function assertStopRecordSize(value: string, reserve = 0) {
  if (stopUtf8Length(value) + reserve > STOP_RECORD_MAX_BYTES) throw new StopStorageError("This cleanup would exceed the task record's sync size limit. No additional cleanup was applied; its saved targets remain pending for review.");
}
export function stopDocText(meta: Record<string, string | undefined>, body: string): string {
  const head = Object.entries(meta).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${String(value).replace(/\n/g, " ")}`).join("\n");
  return `---\n${head}\n---\n${body.trimEnd()}\n`;
}
export function assertStopOwnerSize(owner: StopOwner, batch: PendingStops) {
  const encoded = JSON.stringify(batch);
  if (stopUtf8Length(encoded) > MAX_STOP_BATCH_BYTES) throw new StopStorageError("This cleanup batch is too large to sync safely. Its remaining targets have been kept for review.");
  if (owner.kind === "plan") {
    const path = P("plans", `${owner.id}.json`);
    if (existsSync(path)) assertStopRecordSize(JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), pending_stops: batch }, null, 2) + "\n", 2048);
  } else {
    const path = stopTaskPath(owner.id);
    if (path) { const doc = readDoc(path); assertStopRecordSize(stopDocText({ ...doc.meta, pending_stops: encoded }, doc.body), 2048); }
  }
}

function terminalize(path: string, done: boolean, note: string) {
  const { meta, body } = readDoc(path), id = meta.id;
  const next = { ...meta, run_host: meta.run_host || meta.claimed_by, claimed_by: undefined,
    status: done ? "done" : "cancelled", ...(done ? { finished: now() } : { cancelled: now() }), wake_at: undefined };
  const result = `${body}\n\n## ${done ? "Done" : "Cancelled"} ${now()}\n${note}\n`;
  assertStopRecordSize(stopDocText(next, result));
  writeDoc(P("tasks", done ? "done" : "rejected", `${id}.md`), next, result);
  unlinkSync(path);
}

/** Caller holds the refreshed file lock. Validate the whole graph before applying its markers and queued transitions. */
export function captureTaskStops(ids: string[], owner: StopOwner, done: boolean, previous?: PendingStops, options: { reviewed?: string[]; dryRun?: boolean } = {}): PendingStops | undefined {
  if (!ownerId(owner)) throw new Error("Invalid stop owner");
  if (previous && (!readPendingStops(previous) || previous.done !== done)) throw new Error("This cleanup already has a different outcome");
  const batch: PendingStops = previous ? structuredClone(previous) : { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done, pending: [], unresolved: [] };
  batch.scope ??= batch.pending.map(({ id, host, run_id, done }) => ({ id, host, run_id, done })); batch.seen ??= batch.scope.map((target) => target.id);
  const docs = STOP_TASK_DIRS.flatMap((dir) => list(P("tasks", dir), /^T-[\w-]*\d{4}\.md$/).map((path) => ({ path, dir, ...readDoc(path) })));
  const reviewed = new Set(options.reviewed ?? []), excluded = new Set(batch.excluded?.map((entry) => entry.id) ?? []);
  const queue = previous ? [...reviewed] : [...ids], visited = new Set([...(batch.seen ?? []), ...batch.scope.map((target) => target.id), ...batch.pending.map((target) => target.id), ...batch.unresolved.map((target) => target.id)]), changes: (() => void)[] = [];
  for (const id of reviewed) visited.delete(id);
  const scope = (target: StopTarget) => { if (!batch.scope!.some((item) => item.id === target.id && item.host === target.host && item.run_id === target.run_id)) batch.scope!.push(target); };
  const unresolved = (id: string, error: string) => { if (taskId(id) && batch.unresolved.length < 500 && !batch.unresolved.some((target) => target.id === id)) batch.unresolved.push({ id, error }); };
  const parentOf = (meta: Record<string, string>) => taskId(meta.parent) ? meta.parent : meta.source?.match(/^followup:(T-[\w-]*\d{4})$/)?.[1];
  const discover = (id: string, run_id: string, children: string) => {
    queue.push(...children.split(",").map((child) => child.trim()).filter(taskId));
    for (const doc of docs) if (taskId(doc.meta.id) && parentOf(doc.meta) === id && !excluded.has(doc.meta.id) && !visited.has(doc.meta.id) && !batch.unresolved.some((target) => target.id === doc.meta.id)) {
      if (!previous || doc.meta.spawned_by_run === run_id) queue.push(doc.meta.id);
      else if (!doc.meta.spawned_by_run) unresolved(doc.meta.id, "An older machine created this related task without parent-run proof. Inspect it and update its machine; cleanup cannot be confirmed automatically.");
    }
  };
  if (!previous && owner.kind === "task") {
    const root = docs.find((doc) => doc.meta.id === owner.id);
    for (const doc of docs) if (parentOf(doc.meta) === owner.id) queue.push(doc.meta.id);
    if (root && uuid(root.meta.run_id) && hostId(root.meta.claimed_by || root.meta.run_host)) {
      scope({ id: owner.id, host: root.meta.claimed_by || root.meta.run_host, run_id: root.meta.run_id, done });
      visited.add(owner.id); discover(owner.id, root.meta.run_id, root.meta.children ?? "");
    }
  }
  if (!previous && owner.kind === "plan") for (const doc of docs) if ([doc.meta.plan, doc.meta.plan_draft, doc.meta.parent].includes(owner.id)) queue.push(doc.meta.id);
  for (const target of batch.scope) {
    if (excluded.has(target.id)) continue;
    const doc = docs.find((item) => item.meta.id === target.id && item.meta.run_id === target.run_id);
    discover(target.id, target.run_id, doc?.meta.children ?? "");
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (!taskId(id) || excluded.has(id) || visited.has(id)) continue;
    if (visited.size >= 500) { unresolved(id, "This task family exceeds the cleanup limit. Its remaining runs need review."); break; }
    visited.add(id);
    const path = stopTaskPath(id);
    if (!path) { unresolved(id, "This task is missing, so its last running attempt cannot be verified."); continue; }
    const { meta, body } = readDoc(path);
    if (meta.id !== id) { unresolved(id, "This task record has a mismatched identity and needs review."); continue; }
    const runHost = meta.claimed_by || meta.run_host;
    if (uuid(meta.run_id) && hostId(runHost)) {
      scope({ id, host: runHost, run_id: meta.run_id, done });
      discover(id, meta.run_id, meta.children ?? "");
    } else discover(id, meta.run_id ?? "", meta.children ?? "");
    const folder = path.split(/[\\/]/).at(-2)!;
    if (["done", "failed", "rejected"].includes(folder)) continue;
    const oldIntent = readStopIntent(meta), replaceIntent = reviewed.has(id) && oldIntent?.operation_id === batch.operation_id && oldIntent.owner.kind === owner.kind && oldIntent.owner.id === owner.id
      && oldIntent.done === done && batch.scope.some((target) => target.id === id && target.host === oldIntent.host && target.run_id === oldIntent.run_id);
    if (taskHasStopIntent(meta) && !matchingStopIntent(meta) && !replaceIntent) throw new Error(`Task ${id} has an unverified stop marker; nothing was changed`);
    if (folder === "active") {
      if (!hostId(meta.claimed_by) || !uuid(meta.run_id)) { unresolved(id, "This active task has no verifiable machine/run identity. Update its machine and review its interrupted run."); continue; }
      const target: StopTarget = { id, host: meta.claimed_by, run_id: meta.run_id, done };
      batch.pending.push(target);
      if (!taskHasStopIntent(meta) || replaceIntent) {
        const intent: StopIntent = { operation_id: batch.operation_id, owner, host: target.host, run_id: target.run_id, done };
        assertStopRecordSize(stopDocText({ ...meta, stop_intent: JSON.stringify(intent) }, body));
        changes.push(() => writeDoc(path, { ...meta, stop_intent: JSON.stringify(intent) }, body));
      }
    } else {
      assertStopRecordSize(stopDocText(meta, body), 2048);
      changes.push(() => terminalize(path, done, `Its ${owner.kind} ${owner.id} was ${done ? "marked done" : "cancelled"} by the owner.`));
    }
  }
  batch.seen = [...visited];
  if (previous || batch.pending.length || batch.unresolved.length) assertStopOwnerSize(owner, batch);
  if (!options.dryRun) for (const change of changes) change();
  return previous || batch.pending.length || batch.unresolved.length ? batch : undefined;
}

/** Startup calls this only after the exact orphan process has been verified stopped. */
export function settleTaskStop(path: string): boolean {
  if (!existsSync(path)) return false;
  const { meta } = readDoc(path), intent = matchingStopIntent(meta);
  for (const dir of ["done", "rejected", "failed"]) {
    const terminal = P("tasks", dir, `${meta.id}.md`);
    if (!existsSync(terminal)) continue;
    const completed = readDoc(terminal).meta;
    if (completed.run_id === meta.run_id && (completed.run_host || completed.claimed_by) === meta.claimed_by && readPendingStops(completed.pending_stops)) { unlinkSync(path); return true; }
  }
  if (!intent) return false;
  terminalize(path, intent.done, `The owner requested this stop before the machine restarted (${intent.operation_id}).`);
  return true;
}
