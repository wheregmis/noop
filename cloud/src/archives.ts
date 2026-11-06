export type ArchiveKind = "routines" | "members" | "projects" | "plans";
export type ArchiveListRequest = { kind?: ArchiveKind; query?: string; offset?: number; limit?: number };
export type ArchiveItem = { key: string; kind: ArchiveKind; id: string; name: string; archived_at: string; files: number; bytes: number };
export type ArchiveList = { items: ArchiveItem[]; total: number; offset: number; limit: number; warnings: string[] };
export type ArchivePreview = { entry: ArchiveItem; digest: string; can_restore: boolean; conflicts: string[]; warnings: string[];
  routine?: { name: string; every: string; agent: string; kind: string; project: string; prompt: string; enabled: false };
  member?: { title: string; name: string; about: string; instructions: string };
  project?: { id: string; name: string; host: string; path: string; instructions: string; repo: string | null; requires: string[] };
  plan?: { id: string; goal: string; status: "done" | "cancelled"; agent: string; project?: string; steps: number };
};
export type ArchivePreviewRequest = { key: string };
export type ArchiveRestoreRequest = { key: string; digest: string; request_id: string; confirm_only?: true; project?: { host: string; path: string; probe_ticket?: string } };
export type ArchiveRestoreResult = { key: string; kind: ArchiveKind; id: string; digest: string; request_id: string; restored: true; replayed: boolean; warnings: string[] };
export const ARCHIVE_KINDS: ArchiveKind[] = ["routines", "members", "projects", "plans"];
export const ARCHIVE_MAX_FILES = 128, ARCHIVE_MAX_BYTES = 1_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const multiline = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !value.includes("\0");
const host = (value: unknown): value is string => text(value, 80) && /^[A-Za-z0-9][\w.-]{0,79}$/.test(value) && !["constructor", "prototype"].includes(value);
const kind = (value: unknown): value is ArchiveKind => typeof value === "string" && ARCHIVE_KINDS.includes(value as ArchiveKind);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every((item) => text(item, 2000));
export const validArchiveListRequest = (value: unknown): value is ArchiveListRequest => object(value) && keys(value, ["kind", "query", "offset", "limit"])
  && (value.kind === undefined || kind(value.kind)) && (value.query === undefined || text(value.query, 200))
  && (value.offset === undefined || Number.isInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= 100_000)
  && (value.limit === undefined || Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100);
export const validArchivePreviewRequest = (value: unknown): value is ArchivePreviewRequest => object(value) && keys(value, ["key"]) && digest(value.key);
export const validArchiveRestoreRequest = (value: unknown): value is ArchiveRestoreRequest => object(value) && keys(value, ["key", "digest", "request_id", "confirm_only", "project"])
  && digest(value.key) && digest(value.digest) && uuid(value.request_id) && (value.confirm_only === undefined || value.confirm_only === true)
  && (value.project === undefined || object(value.project) && keys(value.project, ["host", "path", "probe_ticket"]) && host(value.project.host) && text(value.project.path, 4096) && !!value.project.path.trim()
    && (value.project.probe_ticket === undefined || uuid(value.project.probe_ticket)));
const item = (value: unknown): value is ArchiveItem => object(value) && keys(value, ["key", "kind", "id", "name", "archived_at", "files", "bytes"]) && digest(value.key) && kind(value.kind)
  && text(value.id, 100) && !!value.id && text(value.name, 200) && text(value.archived_at, 40) && Number.isFinite(Date.parse(value.archived_at)) && Number.isInteger(value.files) && Number(value.files) >= 0 && Number.isInteger(value.bytes) && Number(value.bytes) >= 0;
export const readArchiveList = (value: unknown): ArchiveList | undefined => object(value) && Array.isArray(value.items) && value.items.length <= 100 && value.items.every(item) && Number.isInteger(value.total)
  && Number(value.total) >= 0 && Number.isInteger(value.offset) && Number(value.offset) >= 0 && Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100
  && value.items.length <= Number(value.limit) && (value.items.length === 0 || Number(value.total) >= Number(value.offset) + value.items.length) && strings(value.warnings) ? value as ArchiveList : undefined;
export function readArchivePreview(value: unknown): ArchivePreview | undefined {
  if (!object(value) || !item(value.entry) || !digest(value.digest) || typeof value.can_restore !== "boolean" || !strings(value.conflicts) || !strings(value.warnings)) return undefined;
  if (value.routine !== undefined && (!object(value.routine) || !text(value.routine.name, 80) || !text(value.routine.every, 100) || !text(value.routine.agent, 80) || !text(value.routine.kind, 40) || !text(value.routine.project, 80) || !multiline(value.routine.prompt, 20_000) || value.routine.enabled !== false)) return undefined;
  if (value.member !== undefined && (!object(value.member) || !text(value.member.title, 60) || !text(value.member.name, 40) || !text(value.member.about, 200) || !multiline(value.member.instructions, 20_000))) return undefined;
  if (value.project !== undefined && (!object(value.project) || !text(value.project.id, 80) || !text(value.project.name, 60) || !text(value.project.host, 80) || !text(value.project.path, 4096) || !multiline(value.project.instructions, 20_000)
    || value.project.repo !== null && !text(value.project.repo, 200) || !strings(value.project.requires))) return undefined;
  if (value.plan !== undefined && (!object(value.plan) || !text(value.plan.id, 80) || !multiline(value.plan.goal, 4000) || !["done", "cancelled"].includes(String(value.plan.status)) || !text(value.plan.agent, 80) || value.plan.project !== undefined && !text(value.plan.project, 80) || !Number.isInteger(value.plan.steps) || Number(value.plan.steps) < 0 || Number(value.plan.steps) > 20)) return undefined;
  const field = ({ routines: "routine", members: "member", projects: "project", plans: "plan" } as const)[value.entry.kind];
  if (["routine", "member", "project", "plan"].some((key) => key !== field && value[key] !== undefined) || value.can_restore && (!object(value[field]) || value.conflicts.length > 0)) return undefined;
  if (value.routine && value.routine.name !== value.entry.id || value.project && value.project.id !== value.entry.id || value.plan && value.plan.id !== value.entry.id) return undefined;
  return value as ArchivePreview;
}
export const readArchiveRestoreResult = (value: unknown): ArchiveRestoreResult | undefined => object(value) && digest(value.key) && digest(value.digest) && kind(value.kind) && text(value.id, 100) && !!value.id
  && uuid(value.request_id) && value.restored === true && typeof value.replayed === "boolean" && strings(value.warnings) ? value as ArchiveRestoreResult : undefined;
