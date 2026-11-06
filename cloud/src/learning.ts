export const LEARNING_API = 1;
export const LEARNING_SOURCES = ["claude", "codex", "hermes", "noop"] as const;
export type LearningSource = typeof LEARNING_SOURCES[number];
export type LearningPath = { host: string; action: "status" | "preview" | "run" | "discard" };
export type LearningCounts = { turns: number; sessions: number; truncated: boolean };
export type LearningPending = LearningCounts & { request_id: string; preview_digest: string; id: string | null; sources: LearningSource[] };
export type LearningStatus = { host: string; learning_api: 1; sources: LearningSource[]; blocked_reason: string | null; pending?: LearningPending };
export type LearningPreview = LearningCounts & { host: string; preview_digest: string; sources: LearningSource[] };
export type LearningRunRequest = { request_id: string; preview_digest: string; confirm_only?: true };
export type LearningRunResult = LearningCounts & { host: string; request_id: string; preview_digest: string; id: string | null; applied: true; replayed: boolean };
export type LearningDiscardRequest = Pick<LearningRunRequest, "request_id" | "preview_digest">;
export type LearningDiscardResult = LearningDiscardRequest & { host: string; id: string | null; discarded: true; replayed: boolean };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
const host = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][\w.-]{0,79}$/.test(v) && !["constructor", "prototype"].includes(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 2000 && !/[\x00-\x1f\x7f]/.test(v);
const task = (v: unknown): v is string | null => v === null || typeof v === "string" && /^T-[\w-]*\d{4}$/.test(v) && v.length <= 100;
const sources = (v: unknown): v is LearningSource[] => Array.isArray(v) && v.length <= LEARNING_SOURCES.length && new Set(v).size === v.length && v.every((s) => LEARNING_SOURCES.includes(s));
const counts = (v: Record<string, unknown>) => [v.turns, v.sessions].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) && typeof v.truncated === "boolean";

export type LearningTaskBinding = { learning_host?: string; learning_host_error?: string };
const unknownLearningHost = "This learning task has no verified source machine. Create replacement learning work with a full history rescan on the original machine (noop learn --full).";
/** Private digests stay on their source machine even after reassignment or task reopening. */
export function learningTaskBinding(meta: Record<string, unknown>, body = ""): LearningTaskBinding {
  if (Object.hasOwn(meta, "learning_host")) return host(meta.learning_host) && meta.learning_host !== "any" ? { learning_host: meta.learning_host } : { learning_host_error: unknownLearningHost };
  if (["learning_request_id", "learning_preview"].some((key) => Object.hasOwn(meta, key))) return { learning_host_error: unknownLearningHost };
  const legacy = /^Learn the owner\. Read the redacted digest(?: of the owner's own messages to AI coding agents)? (?:at:|named:)\r?\n/.test(body)
    && body.includes("local to this machine; never copy raw text or the file into the hub repo");
  if (!legacy) return {};
  const source = typeof meta.source === "string" ? meta.source.replace(/^(?:approved:)+/, "") : "";
  const origin = source.startsWith("owner@") ? source.slice(6) : undefined;
  return host(origin) && !["any", "ui", "chat", "mcp"].includes(origin) ? { learning_host: origin } : { learning_host_error: unknownLearningHost };
}
export function learningTaskHostError(meta: Record<string, unknown>, body: string, proposedHost: string): string | undefined {
  const binding = learningTaskBinding(meta, body);
  return binding.learning_host_error ?? (binding.learning_host && proposedHost !== binding.learning_host
    ? `This learning task must run on ${binding.learning_host}, where its private history digest is stored. Start a fresh learning run on another machine instead.` : undefined);
}

export function machineLearningPath(path: string): LearningPath | null {
  const match = path.match(/^\/api\/machines\/([^/]+)\/learning(?:\/(preview|run|discard))?$/);
  return match && host(match[1]) ? { host: match[1], action: (match[2] || "status") as LearningPath["action"] } : null;
}
export const validLearningPreviewRequest = (v: unknown): v is Record<string, never> => object(v) && Object.keys(v).length === 0;
export const validLearningRunRequest = (v: unknown): v is LearningRunRequest => object(v) && keys(v, ["request_id", "preview_digest", "confirm_only"])
  && uuid(v.request_id) && digest(v.preview_digest) && (v.confirm_only === undefined || v.confirm_only === true);
export const validLearningDiscardRequest = (v: unknown): v is LearningDiscardRequest => object(v) && keys(v, ["request_id", "preview_digest"]) && uuid(v.request_id) && digest(v.preview_digest);
export const readLearningPending = (v: unknown): LearningPending | undefined => object(v) && keys(v, ["request_id", "preview_digest", "id", "sources", "turns", "sessions", "truncated"])
  && uuid(v.request_id) && digest(v.preview_digest) && task(v.id) && sources(v.sources) && counts(v) ? v as LearningPending : undefined;
export const readLearningStatus = (v: unknown): LearningStatus | undefined => object(v) && keys(v, ["host", "learning_api", "sources", "blocked_reason", "pending"])
  && host(v.host) && v.learning_api === LEARNING_API && sources(v.sources) && (v.blocked_reason === null || text(v.blocked_reason))
  && (v.pending === undefined || !!readLearningPending(v.pending)) ? v as LearningStatus : undefined;
export const readLearningPreview = (v: unknown): LearningPreview | undefined => object(v) && keys(v, ["host", "preview_digest", "sources", "turns", "sessions", "truncated"])
  && host(v.host) && digest(v.preview_digest) && sources(v.sources) && counts(v) ? v as LearningPreview : undefined;
export const readLearningRunResult = (v: unknown): LearningRunResult | undefined => object(v) && keys(v, ["host", "request_id", "preview_digest", "id", "applied", "replayed", "turns", "sessions", "truncated"])
  && host(v.host) && uuid(v.request_id) && digest(v.preview_digest) && task(v.id) && v.applied === true && typeof v.replayed === "boolean" && counts(v) ? v as LearningRunResult : undefined;
export const readLearningDiscardResult = (v: unknown): LearningDiscardResult | undefined => object(v) && keys(v, ["host", "request_id", "preview_digest", "id", "discarded", "replayed"])
  && host(v.host) && uuid(v.request_id) && digest(v.preview_digest) && task(v.id) && v.discarded === true && typeof v.replayed === "boolean" ? v as LearningDiscardResult : undefined;

/** Only counts and exact operation identity may cross the machine channel. */
export function validLearningResult(v: unknown, path: LearningPath, request: unknown, status: number): boolean {
  if (!object(v)) return false;
  if (status >= 400) return keys(v, ["error", "host", "request_id", "preview_digest", "id", "uncertain", "retryable", "saved_locally"])
    && text(v.error) && (v.host === undefined || v.host === path.host)
    && (v.request_id === undefined || validLearningRunRequest(request) && v.request_id === request.request_id)
    && (v.preview_digest === undefined || validLearningRunRequest(request) && v.preview_digest === request.preview_digest)
    && (v.id === undefined || validLearningRunRequest(request) && task(v.id)) && [v.uncertain, v.retryable, v.saved_locally].every((flag) => flag === undefined || typeof flag === "boolean");
  if (status !== 200 || v.host !== path.host) return false;
  if (path.action === "status") return !!readLearningStatus(v);
  if (path.action === "preview") return !!readLearningPreview(v);
  return (path.action === "run" && !!readLearningRunResult(v) || !!readLearningDiscardResult(v)) && validLearningRunRequest(request) && v.request_id === request.request_id && v.preview_digest === request.preview_digest;
}
