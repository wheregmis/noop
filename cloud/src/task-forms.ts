import { PROVIDER_IDS } from "./providers";
import { normalizeCaps } from "./tools";

export type TaskProjectGuard = { host: string; path: string; requires: string[] };
export type TaskRunSettings = { title: string; agent: string; cli: string; host: string; requires: string; priority: "urgent" | "high" | "normal" | "low"; prefer: string; weight: "normal" | "heavy"; project: string; project_guard?: TaskProjectGuard };
export type TaskCreateRequest = { request_id: string; instructions: string; settings: TaskRunSettings; confirm_only?: true };
export type TaskReopenPreviewRequest = { id: string };
export type TaskReopenPreview = { id: string; digest: string; state: "done" | "failed" | "cancelled"; can_reopen: boolean; conflicts: string[]; warnings: string[]; settings: TaskRunSettings; request: string; repo?: string; learning_host?: string; learning_host_error?: string };
export type TaskReopenRequest = { request_id: string; id: string; preview_digest: string; instructions: string; settings: TaskRunSettings; confirm_only?: true };
export type TaskFormResult = { request_id: string; action: "create" | "reopen"; id: string; applied: true; replayed: boolean; warnings: string[] };
export type TaskFormPending = Omit<TaskFormResult, "applied" | "replayed"> & { pending: true };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const line = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const multiline = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const task = (value: unknown): value is string => typeof value === "string" && /^T-[\w-]*\d{4}$/.test(value) && value.length <= 80;
const host = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][\w.-]{0,79}$/.test(value) && !["constructor", "prototype"].includes(value);
const slug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
const caps = (value: unknown): value is string => line(value, 1000) && normalizeCaps(value) !== null;
const messages = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every((item) => line(item, 2000));
function settings(value: unknown, preview = false): value is TaskRunSettings {
  return object(value) && keys(value, ["title", "agent", "cli", "host", "requires", "priority", "prefer", "weight", "project", "project_guard"])
    && line(value.title, 120) && !!value.title.trim() && slug(value.agent) && typeof value.cli === "string" && ["auto", ...PROVIDER_IDS].includes(value.cli)
    && (value.host === "any" || host(value.host)) && caps(value.requires) && caps(value.prefer) && ["urgent", "high", "normal", "low"].includes(String(value.priority))
    && ["normal", "heavy"].includes(String(value.weight)) && (value.project === "" || value.project === "__current__" || slug(value.project))
    && (value.project_guard === undefined || object(value.project_guard) && keys(value.project_guard, ["host", "path", "requires"]) && host(value.project_guard.host)
      && line(value.project_guard.path, 4096) && !!value.project_guard.path && Array.isArray(value.project_guard.requires) && value.project_guard.requires.length <= 80
      && value.project_guard.requires.every((cap) => line(cap, 100) && !!cap && caps(cap) && !cap.includes(",")))
    && (value.project && value.project !== "__current__" ? preview || value.project_guard !== undefined : value.project_guard === undefined);
}
export const validTaskRunSettings = (value: unknown): value is TaskRunSettings => settings(value);
export const validTaskCreateRequest = (value: unknown): value is TaskCreateRequest => object(value) && keys(value, ["request_id", "instructions", "settings", "confirm_only"])
  && uuid(value.request_id) && multiline(value.instructions, 20_000) && !!value.instructions.trim() && validTaskRunSettings(value.settings) && value.settings.project !== "__current__" && (value.confirm_only === undefined || value.confirm_only === true);
export const validTaskReopenPreviewRequest = (value: unknown): value is TaskReopenPreviewRequest => object(value) && keys(value, ["id"]) && task(value.id);
export const validTaskReopenRequest = (value: unknown): value is TaskReopenRequest => object(value) && keys(value, ["request_id", "id", "preview_digest", "instructions", "settings", "confirm_only"])
  && uuid(value.request_id) && task(value.id) && digest(value.preview_digest) && multiline(value.instructions, 20_000) && !!value.instructions.trim() && validTaskRunSettings(value.settings) && (value.confirm_only === undefined || value.confirm_only === true);
export function readTaskReopenPreview(value: unknown): TaskReopenPreview | undefined {
  return object(value) && task(value.id) && digest(value.digest) && ["done", "failed", "cancelled"].includes(String(value.state)) && typeof value.can_reopen === "boolean"
    && messages(value.conflicts) && messages(value.warnings) && (!value.can_reopen || !value.conflicts.length) && settings(value.settings, true)
    && (value.learning_host === undefined || host(value.learning_host) && value.learning_host !== "any" && value.settings.host === value.learning_host)
    && (value.learning_host_error === undefined || line(value.learning_host_error, 2000) && !!value.learning_host_error && !value.can_reopen && value.learning_host === undefined)
    && multiline(value.request, 20_000) && (value.repo === undefined || line(value.repo, 4096)) && (value.settings.project !== "__current__" || typeof value.repo === "string" && !!value.repo.trim()) ? value as TaskReopenPreview : undefined;
}
export const readTaskFormResult = (value: unknown): TaskFormResult | undefined => object(value) && uuid(value.request_id) && ["create", "reopen"].includes(String(value.action))
  && task(value.id) && value.applied === true && typeof value.replayed === "boolean" && messages(value.warnings) ? value as TaskFormResult : undefined;
