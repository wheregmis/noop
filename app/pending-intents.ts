import { createHash } from "crypto";
import { normalizeUrl } from "./hub";
import { readTaskReopenPreview, validTaskCreateRequest, validTaskReopenRequest, type TaskCreateRequest, type TaskReopenRequest, type TaskReopenPreview } from "../cloud/src/task-forms";
import { readArchivePreview, validArchiveRestoreRequest, type ArchiveRestoreRequest, type ArchivePreview } from "../cloud/src/archives";
import { readStopReviewPreview, stopUtf8Length, validStopResolveRequest, type StopResolveRequest, type StopReviewPreview } from "../cloud/src/stop-intents";
import { machineLearningPath, readLearningPreview, validLearningRunRequest, type LearningPreview, type LearningRunRequest } from "../cloud/src/learning";

export type PendingEntry =
  | { kind: "task"; key: string; at: string; request: TaskCreateRequest | TaskReopenRequest; preview?: TaskReopenPreview; known_id?: string }
  | { kind: "archive"; key: string; at: string; request: ArchiveRestoreRequest; preview: ArchivePreview }
  | { kind: "stop"; key: string; at: string; request: StopResolveRequest; preview?: StopReviewPreview }
  | { kind: "learning"; key: string; at: string; request: LearningRunRequest; preview: LearningPreview; known_id?: string };
export type PendingIO = { read(): Promise<string | null>; write(serialized: string, expected: string | null): Promise<void> };
export const PENDING_MAX_ENTRIES = 100, PENDING_MAX_BYTES = 1_000_000;
export class PendingIntentError extends Error {
  constructor(public code: "invalid" | "scope" | "full" | "storage" | "unloaded" | "conflict", message: string) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown, allowed: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const taskId = (value: unknown): value is string => typeof value === "string" && value.length <= 80 && /^T-[\w-]*\d{4}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

/** Reject functions, accessors, cycles and custom serialization rather than silently changing a saved authorization. */
function plain(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(value) && prototype === Array.prototype)) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  seen.add(value);
  const valid = Reflect.ownKeys(value).every((key) => typeof key === "string" && (!Array.isArray(value) || key === "length" || /^(?:0|[1-9]\d*)$/.test(key)) && (Array.isArray(value) && key === "length" || (() => {
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    return field.enumerable === true && !field.get && !field.set && plain(field.value, seen, depth + 1);
  })()));
  seen.delete(value); return valid;
}
function taskPreview(value: unknown): value is TaskReopenPreview {
  return keys(value, ["id", "digest", "state", "can_reopen", "conflicts", "warnings", "settings", "request", "repo", "learning_host", "learning_host_error"]) && !!readTaskReopenPreview(value);
}
function archivePreview(value: unknown): value is ArchivePreview {
  if (!keys(value, ["entry", "digest", "can_restore", "conflicts", "warnings", "routine", "member", "project", "plan"]) || !readArchivePreview(value)) return false;
  const fields: Record<string, string[]> = { routine: ["name", "every", "agent", "kind", "project", "prompt", "enabled"], member: ["title", "name", "about", "instructions"],
    project: ["id", "name", "host", "path", "instructions", "repo", "requires"], plan: ["id", "goal", "status", "agent", "project", "steps"] };
  return Object.entries(fields).every(([field, allowed]) => value[field] === undefined || keys(value[field], allowed));
}
function stopPreview(value: unknown): value is StopReviewPreview {
  return keys(value, ["owner", "operation_id", "target_id", "preview_digest", "target", "current", "related", "can_include", "include_reason"]) && !!readStopReviewPreview(value);
}
const identity = (entry: Pick<PendingEntry, "kind" | "key">) => `${entry.kind}:${entry.key}`;
function validKey(kind: PendingEntry["kind"], key: unknown): key is string {
  return kind === "task" ? key === "create" || taskId(key) : kind === "archive" ? hash(key) : kind === "learning" ? typeof key === "string" && machineLearningPath(`/api/machines/${key}/learning`)?.host === key
    : typeof key === "string" && /^(?:task:T-[\w-]*\d{4}|plan:PL-[A-Z]?\d+)$/.test(key) && key.length <= 90;
}

/** Returns a detached, validated DTO; transport-only confirmation flags and expired probe tickets are omitted. */
export function readPendingEntry(value: unknown): PendingEntry | undefined {
  if (!plain(value) || !object(value) || !["task", "archive", "stop", "learning"].includes(String(value.kind)) || !validKey(value.kind as PendingEntry["kind"], value.key) || !stamp(value.at)) return;
  if (value.kind === "learning") {
    const preview = readLearningPreview(value.preview);
    if (!keys(value, ["kind", "key", "at", "request", "preview", "known_id"]) || !validLearningRunRequest(value.request) || !preview
      || preview.host !== value.key || preview.preview_digest !== value.request.preview_digest || value.known_id !== undefined && !taskId(value.known_id)) return;
    const entry = clone(value) as Extract<PendingEntry, { kind: "learning" }>; delete entry.request.confirm_only; return entry;
  }
  if (value.kind === "task") {
    if (!keys(value, ["kind", "key", "at", "request", "preview", "known_id"]) || value.known_id !== undefined && !taskId(value.known_id)) return;
    if (value.key === "create") {
      if (!validTaskCreateRequest(value.request) || value.preview !== undefined) return;
    } else {
      if (!validTaskReopenRequest(value.request) || value.request.id !== value.key || value.known_id !== undefined && value.known_id !== value.key) return;
      if (value.preview !== undefined && (!taskPreview(value.preview) || value.preview.id !== value.request.id || value.preview.digest !== value.request.preview_digest)) return;
      if (taskPreview(value.preview) && value.preview.learning_host && value.request.settings.host !== value.preview.learning_host) return;
      if (value.request.settings.project === "__current__" && (!taskPreview(value.preview) || value.preview.settings.project !== "__current__" || value.request.settings.host !== value.preview.settings.host)) return;
    }
    const entry = clone(value) as Extract<PendingEntry, { kind: "task" }>; delete entry.request.confirm_only; return entry;
  }
  if (value.kind === "archive") {
    if (!keys(value, ["kind", "key", "at", "request", "preview"]) || !validArchiveRestoreRequest(value.request) || !archivePreview(value.preview)
      || value.key !== value.request.key || value.key !== value.preview.entry.key || value.request.digest !== value.preview.digest || value.preview.entry.kind !== "projects" && value.request.project !== undefined) return;
    const entry = clone(value) as Extract<PendingEntry, { kind: "archive" }>; delete entry.request.confirm_only; if (entry.request.project) delete entry.request.project.probe_ticket; return entry;
  }
  if (!keys(value, ["kind", "key", "at", "request", "preview"]) || !validStopResolveRequest(value.request) || value.key !== `${value.request.owner.kind}:${value.request.owner.id}`) return;
  if (value.preview !== undefined && (!stopPreview(value.preview) || value.preview.owner.kind !== value.request.owner.kind || value.preview.owner.id !== value.request.owner.id
    || value.preview.operation_id !== value.request.operation_id || value.preview.target_id !== value.request.target_id || value.preview.preview_digest !== value.request.preview_digest)) return;
  return clone(value) as Extract<PendingEntry, { kind: "stop" }>;
}

export function intentScope(url: string, token: string): string {
  return createHash("sha256").update(normalizeUrl(url)).update("\0").update(token).digest("hex");
}
type Envelope = { version: 1; scope: string; entries: PendingEntry[] };
export function createPendingStore(io: PendingIO, scope: string) {
  if (!hash(scope)) throw new PendingIntentError("scope", "Saved request scope is invalid. Reconnect to the correct hub before continuing.");
  let loaded = false, current: PendingEntry[] = [], rawLoaded: string | null = null, queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run); queue = result.catch(() => {}); return result;
  };
  const ready = () => { if (!loaded) throw new PendingIntentError("unloaded", "Load and review saved requests before submitting another action."); };
  const encode = (entries: PendingEntry[]) => {
    if (entries.length > PENDING_MAX_ENTRIES) throw new PendingIntentError("full", "Saved requests are full. Confirm or explicitly dismiss older requests before submitting another action.");
    const text = JSON.stringify({ version: 1, scope, entries } satisfies Envelope);
    if (stopUtf8Length(text) > PENDING_MAX_BYTES) throw new PendingIntentError("full", "Saved requests exceed the storage size limit. Confirm or explicitly dismiss older requests before continuing.");
    return text;
  };
  const save = async (next: PendingEntry[], expected = rawLoaded) => {
    const text = encode(next);
    try { await io.write(text, expected); } catch { loaded = false; throw new PendingIntentError("storage", "Could not update saved requests safely. Reload them before submitting or dismissing another action."); }
    current = next; rawLoaded = text; loaded = true;
  };
  return {
    load: () => enqueue(async () => {
      loaded = false;
      let raw: string | null;
      try { raw = await io.read(); } catch { throw new PendingIntentError("storage", "Could not read saved requests. Reconnect storage or explicitly reset the local recovery cache."); }
      if (raw === null) { current = []; rawLoaded = null; loaded = true; return []; }
      if (typeof raw !== "string" || stopUtf8Length(raw) > PENDING_MAX_BYTES) throw new PendingIntentError("invalid", "Saved requests are oversized or unreadable. Inspect current records before explicitly resetting this cache.");
      let value: unknown; try { value = JSON.parse(raw); } catch { throw new PendingIntentError("invalid", "Saved requests are unreadable. Their actions may already have happened; inspect records before resetting this cache."); }
      if (!plain(value) || !keys(value, ["version", "scope", "entries"]) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > PENDING_MAX_ENTRIES)
        throw new PendingIntentError("invalid", "The saved request format is unsupported. No cached requests were replayed or discarded.");
      if (value.scope !== scope) throw new PendingIntentError("scope", "These saved requests belong to another hub or sign-in. They were not loaded or replayed.");
      const entries = value.entries.map(readPendingEntry), ids = new Set<string>();
      for (const entry of entries) {
        if (!entry || ids.has(identity(entry))) throw new PendingIntentError("invalid", "Some saved requests are invalid or duplicated. No cached requests were replayed or discarded.");
        ids.add(identity(entry));
      }
      current = entries as PendingEntry[]; rawLoaded = raw; loaded = true; return clone(current);
    }),
    put: (value: PendingEntry) => {
      const entry = readPendingEntry(value);
      if (!entry) return Promise.reject(new PendingIntentError("invalid", "This request does not match its saved preview and identity. Review it again before submitting."));
      return enqueue(async () => {
        ready(); const index = current.findIndex((previous) => identity(previous) === identity(entry)), previous = current[index];
        if (previous && (previous.request.request_id !== entry.request.request_id || canonical(previous.request) !== canonical(entry.request)
          || (previous.kind === "task" && entry.kind === "task" || previous.kind === "learning" && entry.kind === "learning") && previous.known_id && entry.known_id && previous.known_id !== entry.known_id))
          throw new PendingIntentError("conflict", "Confirm or explicitly dismiss the existing saved request before replacing it with another authorization.");
        const next = [...current];
        if (previous) next[index] = { ...previous, ...entry, at: previous.at, preview: previous.preview ?? entry.preview,
          ...(previous.kind === "task" && entry.kind === "task" || previous.kind === "learning" && entry.kind === "learning" ? { known_id: entry.known_id ?? previous.known_id } : {}) } as PendingEntry;
        else next.push(entry);
        await save(next);
      });
    },
    remove: (kind: PendingEntry["kind"], key: string, expectedRequestId: string) => enqueue(async () => {
      ready(); if (!validKey(kind, key) || !uuid(expectedRequestId)) throw new PendingIntentError("invalid", "Choose the exact saved request to dismiss.");
      const previous = current.find((entry) => entry.kind === kind && entry.key === key);
      if (!previous) return;
      if (previous.request.request_id !== expectedRequestId) throw new PendingIntentError("conflict", "This saved request changed. Its newer authorization was kept.");
      await save(current.filter((entry) => entry !== previous));
    }),
    reset: () => enqueue(async () => {
      loaded = false;
      let raw: string | null;
      try { raw = await io.read(); } catch { throw new PendingIntentError("storage", "Could not read the latest saved requests. Reload them before resetting this cache."); }
      if (raw !== null && typeof raw !== "string") throw new PendingIntentError("invalid", "Saved request storage returned an invalid document. Nothing was reset.");
      await save([], raw);
    }),
    entries: (): PendingEntry[] => { ready(); return clone(current); },
  };
}
