export type StopOwner = { kind: "plan" | "task"; id: string };
export type StopTarget = { id: string; host: string; run_id: string; done: boolean; error?: string };
export type UnresolvedStop = { id: string; error: string };
export type StopReviewAction = "include" | "exclude";
export type StopReviewState = "active" | "queued" | "terminal" | "missing" | "conflicting";
export type StopReviewedRecord = { state: string; title?: string; host?: string; run_id?: string };
export type StopReviewedIdentity = { state: StopReviewState; records: StopReviewedRecord[] };
export type StopReviewTarget = { kind: "pending" | "unresolved"; id: string; host?: string; run_id?: string; done?: boolean };
export type StopReviewRequest = { owner: StopOwner; operation_id: string; target_id: string };
export type StopResolveRequest = StopReviewRequest & { preview_digest: string; action: StopReviewAction; reason: string; request_id: string };
export type StopReviewPreview = StopReviewRequest & { preview_digest: string; target: StopReviewTarget; current: StopReviewedIdentity; related?: { id: string; current: StopReviewedIdentity }[]; can_include: boolean; include_reason?: string };
export type StopReviewAudit = StopResolveRequest & { review_id: string; at: string; original: StopReviewTarget; reviewed: StopReviewedIdentity; request_hash: string };
export type StopExclusion = { id: string; review_id: string; reason: string; at: string; reviewed: StopReviewedIdentity; stopped: false };
export type PendingStops = { operation_id: string; requested_at: string; done: boolean; pending: StopTarget[]; unresolved: UnresolvedStop[]; scope?: StopTarget[]; seen?: string[]; reviews?: StopReviewAudit[]; excluded?: StopExclusion[] };
export type StopResolveResult = StopResolveRequest & { review_id: string; review: StopReviewAudit; pending_stops: PendingStops; remaining: number; complete: boolean };
export type StopIntent = { operation_id: string; owner: StopOwner; host: string; run_id: string; done: boolean };
export const MAX_STOP_BATCH_BYTES = 750_000;
/** JSON and UTF-8 length without platform-specific globals, also used by the native UI. */
export function stopUtf8Length(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { length += 4; index++; }
    else length += 3;
  }
  return length;
}
export const stopRunId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
export const stopTaskId = (value: unknown): value is string => typeof value === "string" && value.length <= 100 && /^T-[\w-]*\d{4}$/.test(value);
export const stopHostId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][\w.-]{0,79}$/.test(value) && !["constructor", "prototype"].includes(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 2000 && !/[\x00-\x1f\x7f]/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
export const validStopOwner = (value: unknown): value is StopOwner => object(value) && keys(value, ["kind", "id"]) && (value.kind === "task" ? stopTaskId(value.id) : value.kind === "plan" && typeof value.id === "string" && /^PL-[A-Z]?\d+$/.test(value.id));
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const reason = (value: unknown): value is string => typeof value === "string" && value.length <= 500 && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value) && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
const reviewBase = (value: Record<string, unknown>) => validStopOwner(value.owner) && stopRunId(value.operation_id) && stopTaskId(value.target_id);
export const validStopReviewRequest = (value: unknown): value is StopReviewRequest => object(value) && keys(value, ["owner", "operation_id", "target_id"]) && reviewBase(value);
export const validStopResolveRequest = (value: unknown): value is StopResolveRequest => object(value) && keys(value, ["owner", "operation_id", "target_id", "preview_digest", "action", "reason", "request_id"])
  && reviewBase(value) && digest(value.preview_digest) && (value.action === "include" || value.action === "exclude") && reason(value.reason) && stopRunId(value.request_id);
const recordStates = ["active", "inbox", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
const reviewed = (value: unknown): value is StopReviewedIdentity => object(value) && keys(value, ["state", "records"]) && ["active", "queued", "terminal", "missing", "conflicting"].includes(String(value.state))
  && Array.isArray(value.records) && value.records.length <= 8 && value.records.every((row) => object(row) && keys(row, ["state", "title", "host", "run_id"]) && recordStates.includes(String(row.state))
    && (row.title === undefined || text(row.title) && row.title.length <= 200) && (row.host === undefined || stopHostId(row.host)) && (row.run_id === undefined || stopRunId(row.run_id)));
const reviewTarget = (value: unknown): value is StopReviewTarget => object(value) && keys(value, ["kind", "id", "host", "run_id", "done"]) && stopTaskId(value.id)
  && (value.kind === "unresolved" && value.host === undefined && value.run_id === undefined && value.done === undefined || value.kind === "pending" && stopHostId(value.host) && stopRunId(value.run_id) && typeof value.done === "boolean");
export function readStopReviewPreview(value: unknown): StopReviewPreview | undefined {
  if (!object(value) || !keys(value, ["owner", "operation_id", "target_id", "preview_digest", "target", "current", "related", "can_include", "include_reason"]) || !reviewBase(value) || !digest(value.preview_digest)
    || !reviewTarget(value.target) || value.target.id !== value.target_id || !reviewed(value.current) || typeof value.can_include !== "boolean" || value.include_reason !== undefined && !text(value.include_reason)) return undefined;
  if (value.current.state === "active" && value.can_include && (value.current.records.length !== 1 || !stopHostId(value.current.records[0].host) || !stopRunId(value.current.records[0].run_id))) return undefined;
  if (value.current.state === "active" && (value.current.records.length !== 1 || value.current.records[0].state !== "active")) return undefined;
  if (value.current.state === "queued" && (value.current.records.length !== 1 || !["inbox", "waiting", "blocked", "proposed"].includes(value.current.records[0].state))) return undefined;
  if (value.current.state === "terminal" && (value.current.records.length !== 1 || !["done", "failed", "rejected"].includes(value.current.records[0].state))) return undefined;
  if (value.current.state === "missing" && value.current.records.length !== 0) return undefined;
  if (value.related !== undefined && (!Array.isArray(value.related) || value.related.length > 500 || !value.related.every((entry) => object(entry) && keys(entry, ["id", "current"]) && stopTaskId(entry.id) && entry.id !== value.target_id && reviewed(entry.current)))) return undefined;
  if (value.can_include && ["missing", "conflicting"].includes(value.current.state)) return undefined;
  return value as StopReviewPreview;
}
export function readStopReviewAudit(value: unknown): StopReviewAudit | undefined {
  return object(value) && keys(value, ["owner", "operation_id", "target_id", "preview_digest", "action", "reason", "request_id", "review_id", "at", "original", "reviewed", "request_hash"])
    && reviewBase(value) && stopRunId(value.request_id) && value.review_id === value.request_id && digest(value.preview_digest) && digest(value.request_hash)
    && (value.action === "include" || value.action === "exclude") && reason(value.reason) && typeof value.at === "string" && Number.isFinite(Date.parse(value.at))
    && reviewTarget(value.original) && value.original.id === value.target_id && reviewed(value.reviewed) ? value as StopReviewAudit : undefined;
}
const parsed = (value: unknown): unknown => { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return undefined; } };
export function readPendingStops(value: unknown): PendingStops | undefined {
  const batch = parsed(value);
  if (!object(batch) || !stopRunId(batch.operation_id) || typeof batch.requested_at !== "string" || !Number.isFinite(Date.parse(batch.requested_at)) || typeof batch.done !== "boolean"
    || !Array.isArray(batch.pending) || !Array.isArray(batch.unresolved) || batch.pending.length > 500 || batch.unresolved.length > 501) return undefined;
  if (!batch.pending.every((target) => object(target) && stopTaskId(target.id) && stopHostId(target.host) && stopRunId(target.run_id) && typeof target.done === "boolean" && (target.error === undefined || text(target.error)))
    || !batch.unresolved.every((target) => object(target) && stopTaskId(target.id) && text(target.error))) return undefined;
  if (batch.scope !== undefined && (!Array.isArray(batch.scope) || batch.scope.length > 1000 || !batch.scope.every((target) => object(target) && stopTaskId(target.id) && stopHostId(target.host) && stopRunId(target.run_id) && typeof target.done === "boolean"))) return undefined;
  if (batch.seen !== undefined && (!Array.isArray(batch.seen) || batch.seen.length > 501 || !batch.seen.every(stopTaskId))) return undefined;
  if (batch.reviews !== undefined && (!Array.isArray(batch.reviews) || batch.reviews.length > 500 || !batch.reviews.every((entry) => readStopReviewAudit(entry) && entry.operation_id === batch.operation_id))) return undefined;
  if (batch.excluded !== undefined && (!Array.isArray(batch.excluded) || batch.excluded.length > 500 || !batch.excluded.every((entry) => object(entry) && stopTaskId(entry.id) && stopRunId(entry.review_id) && reason(entry.reason)
    && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) && entry.stopped === false && reviewed(entry.reviewed)))) return undefined;
  if (stopUtf8Length(JSON.stringify(batch)) > MAX_STOP_BATCH_BYTES) return undefined;
  return batch as PendingStops;
}
export const hasPendingStops = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "") return false;
  const batch = readPendingStops(value);
  return !batch || !!(batch.pending.length || batch.unresolved.length);
};
export const pendingStopsView = (value: unknown): PendingStops | undefined => {
  const batch = readPendingStops(value);
  return batch && (batch.pending.length || batch.unresolved.length) ? batch : undefined;
};
export function readStopIntent(meta: Record<string, string>): StopIntent | undefined {
  const intent = parsed(meta.stop_intent);
  return object(intent) && stopRunId(intent.operation_id) && validStopOwner(intent.owner) && stopHostId(intent.host) && stopRunId(intent.run_id) && typeof intent.done === "boolean" ? intent as StopIntent : undefined;
}
export const taskHasStopIntent = (meta: Record<string, string>): boolean => !!meta.stop_intent;
export const matchingStopIntent = (meta: Record<string, string>): StopIntent | undefined => {
  const intent = readStopIntent(meta);
  return intent && intent.host === meta.claimed_by && intent.run_id === meta.run_id ? intent : undefined;
};

export const pendingStopsError = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "" || readPendingStops(value)) return undefined;
  const batch = parsed(value);
  if (batch && stopUtf8Length(JSON.stringify(batch)) > MAX_STOP_BATCH_BYTES) return "Saved cleanup information is too large to sync safely. Its targets have been kept; review the family before retrying.";
  return "Saved cleanup information is invalid. Refresh the team data and review this task family before running it again.";
};
