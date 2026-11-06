import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { _commitPush, _pull, hostName, loadConfig, locked, nextId, P, taskDocument, type Cfg } from "./core";
import { parseDoc } from "../cloud/src/tools";
import { RequestError } from "./members";
import { collectionLocked, commitLearningCheckpoint, learningBlockReason, learningCheckpoint, learningDirectory, learningRoots, LEARNING_DIR, LEARN_PROMPT, LearningBusyError, LearningSourceError, prepareCollection, type PreparedCollection } from "./sessions";
import { LEARNING_API, LEARNING_SOURCES, learningTaskBinding, machineLearningPath, readLearningDiscardResult, readLearningPending, readLearningPreview, validLearningDiscardRequest, validLearningPreviewRequest, validLearningRunRequest,
  type LearningDiscardResult, type LearningPending, type LearningPreview, type LearningRunRequest, type LearningRunResult, type LearningSource, type LearningStatus } from "../cloud/src/learning";

type Sync = { pull(): Promise<boolean>; push(message: string): Promise<boolean> };
type Preview = { version: 1; host: string; digest: string; settings: string; full: boolean; sources: LearningSource[]; collection: PreparedCollection };
type Receipt = { version: 1; host: string; request_id: string; preview_digest: string; id: string | null; state: "prepared" | "queued" | "applied" | "discarded";
  sources: LearningSource[]; turns: number; sessions: number; truncated: boolean; plan_hash: string };
type Outcome = LearningRunResult | LearningDiscardResult;
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const keys = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const MAX_PRIVATE = 20_000_000;
const FOLDERS = ["proposed", "rejected", "waiting", "inbox", "active", "blocked", "failed", "done"];
const privatePath = (kind: "previews" | "requests", id: string) => join(LEARNING_DIR, kind, `${id}.json`);
const counts = (v: { turns: number; sessions: number; truncated: boolean }) => ({ turns: v.turns, sessions: v.sessions, truncated: v.truncated });
const selectedSources = (cfg: Cfg): LearningSource[] => {
  const value = cfg.learn?.sources ?? ["claude", "codex", "noop"];
  return Array.isArray(value) && value.length <= 4 && value.every((source) => LEARNING_SOURCES.includes(source)) && new Set(value).size === value.length ? value : [];
};
function blocked(cfg: Cfg) {
  return learningTaskBinding({ learning_host: hostName(cfg) }).learning_host_error
    ? "This machine needs a valid, specific name before learning can run. Update its machine name; 'any' cannot identify a private history source."
    : !selectedSources(cfg).length ? "Select valid history sources in Settings → AI tools & onboarding." : learningBlockReason(cfg);
}
function directories() {
  learningDirectory();
  for (const kind of ["previews", "requests"]) {
    const path = join(LEARNING_DIR, kind); mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe learning storage");
  }
}
function publicDirectory(...parts: string[]) {
  for (let count = 0; count <= parts.length; count++) {
    const path = P(...parts.slice(0, count)); let stat;
    try { stat = lstatSync(path); } catch (error: any) { if (error.code !== "ENOENT") throw error; mkdirSync(path); stat = lstatSync(path); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe learning task storage");
  }
}
function readPrivate(path: string, max = MAX_PRIVATE): string | null {
  let stat; try { stat = lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("Unsafe learning record");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), data = readFileSync(fd), after = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || after.mtimeMs !== opened.mtimeMs || data.length !== opened.size) throw new Error("Learning record changed");
    return data.toString("utf8");
  } finally { closeSync(fd); }
}
function savePrivate(path: string, value: unknown, exclusive = false) {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > MAX_PRIVATE) throw new Error("Learning record is too large");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); if (exclusive) linkSync(temporary, path); else renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}
function receipt(request: Pick<LearningRunRequest, "request_id" | "preview_digest">): Receipt | null {
  const text = readPrivate(privatePath("requests", request.request_id)); if (!text) return null;
  const value = JSON.parse(text);
  if (!object(value) || !keys(value, ["version", "host", "request_id", "preview_digest", "id", "state", "sources", "turns", "sessions", "truncated", "plan_hash"])
    || value.version !== 1 || value.request_id !== request.request_id || !["prepared", "queued", "applied", "discarded"].includes(value.state)
    || typeof value.host !== "string" || machineLearningPath(`/api/machines/${value.host}/learning`)?.host !== value.host || !digest(value.plan_hash)
    || !readLearningPending({ request_id: value.request_id, preview_digest: value.preview_digest, id: value.id, sources: value.sources, ...counts(value as any) })) throw new Error("Invalid learning receipt");
  if (value.preview_digest !== request.preview_digest) throw new RequestError(409, "This learning request ID already belongs to a different preview.");
  return value as Receipt;
}
function outcome(value: Receipt, replayed: boolean): Outcome {
  const binding = { host: value.host, request_id: value.request_id, preview_digest: value.preview_digest, id: value.id, replayed };
  return value.state === "discarded" ? { ...binding, discarded: true } : { ...binding, ...counts(value), applied: true };
}
function pending(value: Receipt): LearningPending { return { request_id: value.request_id, preview_digest: value.preview_digest, id: value.id, sources: value.sources, ...counts(value) }; }
class LearningPendingError extends Error {
  constructor(public value: Receipt, message: string, public status = 409) { super(message); }
}
function unresolved() {
  const folder = join(LEARNING_DIR, "requests");
  for (const path of [LEARNING_DIR, folder]) {
    try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe learning storage"); }
    catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  }
  let entries; try { entries = readdirSync(folder, { withFileTypes: true }); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  const values: Receipt[] = [];
  for (const entry of entries) if (entry.name.endsWith(".json")) {
    const id = entry.name.slice(0, -5); if (!entry.isFile() || !uuid(id)) throw new Error("Unsafe learning receipt");
    const raw = JSON.parse(readPrivate(join(folder, entry.name))!);
    const value = receipt({ request_id: id, preview_digest: raw.preview_digest });
    if (value && (value.state === "prepared" || value.state === "queued")) values.push(value);
  }
  return values;
}
function settingsHash(cfg: Cfg, full: boolean) {
  return hash(JSON.stringify({ host: hostName(cfg), sources: selectedSources(cfg), roots: learningRoots(cfg), max: cfg.learn?.max_digest_chars ?? 400_000, full }));
}
function plan(value: Receipt): Preview {
  const text = readPrivate(privatePath("previews", value.preview_digest));
  if (!text || hash(text) !== value.plan_hash) throw new LearningPendingError(value, "The reviewed private learning batch is missing or changed. Release this saved collection before making a new preview.");
  return parsePreview(text, value.host, value.preview_digest);
}
function parsePreview(text: string, host: string, id: string): Preview {
  const value = JSON.parse(text);
  if (!object(value) || !keys(value, ["version", "host", "digest", "settings", "full", "sources", "collection"]) || value.version !== 1 || value.host !== host || value.digest !== id || !digest(value.settings) || typeof value.full !== "boolean"
    || !object(value.collection) || ![null, "string"].includes(value.collection.before === null ? null : typeof value.collection.before)
    || !keys(value.collection, ["before", "after", "content", "turns", "sessions", "truncated"])
    || typeof value.collection.after !== "string" || value.collection.content !== null && typeof value.collection.content !== "string"
    || !readLearningPreview({ host, preview_digest: id, sources: value.sources, ...counts(value.collection as any) })) throw new Error("Invalid learning preview");
  return value as Preview;
}
function taskProof(value: Receipt): boolean {
  if (!value.id) return false;
  const copies = FOLDERS.flatMap((folder) => {
    const file = P("tasks", folder, `${value.id}.md`); let stat;
    try { stat = lstatSync(file); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) return [false];
    const { meta } = parseDoc(readPrivate(file, 1_500_000)!);
    return [meta.id === value.id && meta.learning_request_id === value.request_id && meta.learning_preview === value.preview_digest && meta.learning_host === value.host];
  });
  return copies.length === 1 && copies[0] === true;
}
function finish(value: Receipt): Outcome {
  if (value.state === "applied" || value.state === "discarded") return outcome(value, true);
  const reviewed = plan(value);
  if (value.state === "prepared") {
    if (value.id && !taskProof(value)) throw new LearningPendingError(value, "This saved collection could not prove whether its task was created. Inspect the task or release this uncertain collection; checking never creates it again.");
    value.state = "queued"; savePrivate(privatePath("requests", value.request_id), value);
  }
  const current = learningCheckpoint();
  if (current === reviewed.collection.before) commitLearningCheckpoint(current, reviewed.collection.after);
  else if (current !== reviewed.collection.after) throw new LearningPendingError(value, "The learning checkpoint changed before this collection was confirmed. Release this saved collection to keep the current checkpoint; its existing task is preserved.");
  value.state = "applied"; savePrivate(privatePath("requests", value.request_id), value);
  return outcome(value, true);
}
function blockOutstanding(host: string) {
  const value = unresolved().find((saved) => saved.host === host);
  if (value) throw new LearningPendingError(value, "Check or release the saved collection before making a new learning preview.");
}
function prepare(cfg: Cfg, full = false): LearningPreview {
  const reason = blocked(cfg); if (reason) throw new RequestError(409, reason);
  blockOutstanding(hostName(cfg));
  const id = randomBytes(32).toString("hex"), collection = prepareCollection(cfg, { full });
  const value: Preview = { version: 1, host: hostName(cfg), digest: id, settings: settingsHash(cfg, full), full, sources: selectedSources(cfg), collection };
  savePrivate(privatePath("previews", id), value, true);
  return { host: value.host, preview_digest: id, sources: value.sources, ...counts(collection) };
}
function run(cfg: Cfg, input: LearningRunRequest, source: string): Outcome {
  const previous = receipt(input);
  if (previous) {
    if (previous.host !== hostName(cfg)) throw new RequestError(409, "This saved collection belongs to another machine.");
    return finish(previous);
  }
  if (input.confirm_only) throw new RequestError(404, "No saved learning operation matches this request. Checking did not read history or create a task.");
  const reason = blocked(cfg); if (reason) throw new RequestError(409, reason);
  blockOutstanding(hostName(cfg));
  const text = readPrivate(privatePath("previews", input.preview_digest));
  if (!text) throw new RequestError(409, "This learning preview is unavailable. Make a fresh preview before collecting history.");
  const reviewed = parsePreview(text, hostName(cfg), input.preview_digest);
  if (reviewed.settings !== settingsHash(cfg, reviewed.full)) throw new RequestError(409, "The learning settings or source location changed. Make a fresh preview before collecting history.");
  if (learningCheckpoint() !== reviewed.collection.before) throw new RequestError(409, "The learning checkpoint changed. Make a fresh preview before collecting history.");
  const id = reviewed.collection.content === null ? null : nextId("T", P("tasks"));
  const value: Receipt = { version: 1, host: hostName(cfg), request_id: input.request_id, preview_digest: input.preview_digest, id, state: "prepared", sources: reviewed.sources, ...counts(reviewed.collection), plan_hash: hash(text) };
  if (id) {
    publicDirectory("fleet", "task-ids");
    writeFileSync(P("fleet", "task-ids", `${id}.json`), JSON.stringify({ id, kind: "learning", host: value.host, request_id: value.request_id }), { flag: "wx" });
  }
  // Reserve the identity and private receipt before any digest/task/checkpoint effect.
  savePrivate(privatePath("requests", input.request_id), value, true);
  try {
    if (id) {
      for (const folder of FOLDERS) { try { lstatSync(P("tasks", folder, `${id}.md`)); throw new LearningPendingError(value, "The reserved learning task ID conflicts with another record. Release this saved collection before making a new preview."); } catch (error: any) { if (error.code !== "ENOENT") throw error; } }
      const name = `digest-${input.request_id}.md`, file = join(LEARNING_DIR, name);
      writeFileSync(file, reviewed.collection.content!, { mode: 0o600, flag: "wx" });
      const doc = taskDocument(id, `learn the owner · ${value.host} · ${value.sessions} sessions`, LEARN_PROMPT(name), {
        agent: "apprentice", host: value.host, source, priority: source.startsWith("routine:") ? "normal" : "high",
        extra: { learning_request_id: input.request_id, learning_preview: input.preview_digest, learning_host: value.host },
      });
      publicDirectory("tasks", "inbox");
      writeFileSync(P("tasks", "inbox", `${id}.md`), `---\n${Object.entries(doc.meta).map(([key, v]) => `${key}: ${v}`).join("\n")}\n---\n${doc.body}`, { flag: "wx" });
    }
    const result = finish(value); return { ...result, replayed: false };
  } catch (error) {
    if (error instanceof LearningPendingError) throw error;
    throw new LearningPendingError(value, "This learning collection was saved locally but its final state was not confirmed. Check this saved request before starting another one.", 503);
  }
}

/** Called inside the daemon/CLI mirror lock; the same SQLite lock also guards UI collection. */
export function queueLearning(cfg: Cfg, options: { source?: string; full?: boolean } = {}): LearningRunResult {
  try {
    return collectionLocked(() => {
      directories(); const preview = prepare(cfg, options.full), request_id = randomUUID();
      return run(cfg, { request_id, preview_digest: preview.preview_digest }, options.source ?? `owner@${hostName(cfg)}`) as LearningRunResult;
    });
  } catch (error) {
    if (error instanceof LearningPendingError || error instanceof RequestError || error instanceof LearningBusyError || error instanceof LearningSourceError) throw error;
    throw new RequestError(503, "This machine could not prepare its private learning collection. Check its storage and try again.");
  }
}
export function previewLearning(cfg: Cfg, full = false): LearningPreview {
  return collectionLocked(() => { directories(); return prepare(cfg, full); });
}

function errorResponse(error: unknown, host: string, request?: LearningRunRequest) {
  if (error instanceof LearningPendingError) return Response.json(request?.request_id === error.value.request_id && request.preview_digest === error.value.preview_digest
    ? { host, request_id: error.value.request_id, preview_digest: error.value.preview_digest, id: error.value.id, error: error.message, uncertain: true, saved_locally: true }
    : { host, error: "A saved learning collection needs checking or release. Open this machine's learning status before collecting again." }, { status: error.status });
  if (error instanceof RequestError) return Response.json({ host, ...(request ? { request_id: request.request_id, preview_digest: request.preview_digest } : {}), error: error.message }, { status: error.status });
  return Response.json({ host, ...(request ? { request_id: request.request_id, preview_digest: request.preview_digest } : {}), error: error instanceof LearningBusyError ? error.message : error instanceof LearningSourceError ? error.message : "This machine could not access its private learning state. Check its storage and try again.", retryable: true }, { status: error instanceof LearningBusyError ? 409 : error instanceof LearningSourceError ? 500 : 503 });
}

export async function learningRequest(req: Request, io: Sync = { pull: _pull, push: _commitPush }): Promise<Response> {
  const route = machineLearningPath(new URL(req.url).pathname);
  if (!route) return Response.json({ error: "Not found" }, { status: 404 });
  if (new URL(req.url).search) return Response.json({ error: "Send learning options in the request body" }, { status: 400 });
  if (req.method !== (route.action === "status" ? "GET" : "POST")) return Response.json({ error: "method not allowed" }, { status: 405 });
  let input: unknown;
  if (route.action !== "status") {
    const text = await req.text(); if (text.length > 4096) return Response.json({ error: "Learning request is too large" }, { status: 413 });
    try { input = JSON.parse(text); } catch { return Response.json({ error: "Invalid learning request" }, { status: 400 }); }
    if (!(route.action === "preview" ? validLearningPreviewRequest(input) : route.action === "discard" ? validLearningDiscardRequest(input) : validLearningRunRequest(input)))
      return Response.json({ error: "Choose a supported saved learning request" }, { status: 400 });
  }
  const request = validLearningRunRequest(input) ? input : undefined;
  try {
    return await locked(async () => {
      if (hostName(loadConfig()) !== route.host) throw new RequestError(409, "Open the cloud hub to manage learning on the selected machine.");
      let refreshed = false; try { refreshed = await io.pull(); } catch {}
      if (!refreshed) throw new RequestError(503, "Could not refresh this machine's learning settings. Nothing was collected.");
      const cfg = loadConfig(); if (hostName(cfg) !== route.host) throw new RequestError(409, "This machine identity changed. Reload the selected machine.");
      if (route.action === "status") {
        const outstanding = unresolved().find((value) => value.host === route.host);
        const status: LearningStatus = { host: route.host, learning_api: LEARNING_API, sources: selectedSources(cfg), blocked_reason: outstanding ? "A saved learning collection needs checking or release before collecting again." : blocked(cfg), ...(outstanding ? { pending: pending(outstanding) } : {}) };
        return Response.json(status);
      }
      const result = collectionLocked(() => {
        directories();
        if (route.action === "preview") return prepare(cfg);
        if (route.action === "discard" && request) {
          const value = receipt(request); if (!value) throw new RequestError(404, "No saved learning collection matches this request.");
          if (value.host !== route.host) throw new RequestError(409, "This saved collection belongs to another machine.");
          if (value.state === "applied") throw new RequestError(409, "This collection was already applied. Its task and checkpoint were preserved.");
          const replayed = value.state === "discarded"; value.state = "discarded"; savePrivate(privatePath("requests", value.request_id), value);
          return outcome(value, replayed);
        }
        return run(cfg, request!, `owner@${route.host}`);
      });
      if (route.action === "preview" || readLearningDiscardResult(result)) return Response.json(result);
      let synced = false; try { synced = await io.push(`[learning] ${request!.request_id} on ${route.host}`); } catch {}
      if (!synced) return Response.json({ host: route.host, request_id: request!.request_id, preview_digest: request!.preview_digest, id: (result as Outcome).id, saved_locally: true, uncertain: true, error: "The learning task was saved on this machine, but sync is not confirmed. Check this same saved request before collecting again." }, { status: 503 });
      return Response.json(result);
    });
  } catch (error) { return errorResponse(error, route.host, request); }
}

/** Older clients still collect the latest selection; new clients retain a host-bound request identity. */
export async function legacyLearningRequest(req: Request, io: Sync = { pull: _pull, push: _commitPush }): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (!validLearningPreviewRequest(await req.json().catch(() => null))) return Response.json({ error: "Send an empty object to learn from the selected sources" }, { status: 400 });
  let host = hostName(loadConfig());
  try {
    return await locked(async () => {
      let refreshed = false; try { refreshed = await io.pull(); } catch {}
      if (!refreshed) throw new RequestError(503, "Could not refresh this machine's learning settings. Nothing was collected.");
      const cfg = loadConfig(); host = hostName(cfg);
      const value = queueLearning(cfg);
      let synced = false; try { synced = await io.push(`[learning] ${value.request_id} on ${host}`); } catch {}
      const result = { id: value.id, host, turns: value.turns, sessions: value.sessions };
      return Response.json(synced ? result : { ...result, saved_locally: true, error: "Saved on this machine, but sync was not confirmed. Check the learning task before starting another run." }, { status: synced ? 200 : 503 });
    });
  } catch (error) { return errorResponse(error, host); }
}
