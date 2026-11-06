// Remote forms use the primary's existing validators and filesystem APIs, over its outbound inbox.
import type { FilesSql } from "./files";
import { projectFolderReceipt, validMachineHost, type ProjectFolderCheck } from "./machine-requests";
import { validMessageKey } from "./message-receipts";
import { validStopReviewRequest, validStopResolveRequest } from "./stop-intents";
import { validArchiveListRequest, validArchivePreviewRequest, validArchiveRestoreRequest } from "./archives";
import { validTaskCreateRequest, validTaskReopenPreviewRequest, validTaskReopenRequest } from "./task-forms";
import { toolSettingsPatch } from "./providers";
import { autonomySettingsPatch } from "./configuration";

export function recordPath(path: string): { kind: string; id?: string; action?: string } | null {
  if (path === "/api/archive") return { kind: "archive" };
  if (path === "/api/archive/preview") return { kind: "archive", action: "preview" };
  if (path === "/api/archive/restore") return { kind: "archive", action: "restore" };
  if (path === "/api/stops/capabilities") return { kind: "stop-capabilities" };
  if (path === "/api/stops/review") return { kind: "stop-review" };
  if (path === "/api/stops/resolve") return { kind: "stop-resolve" };
  if (path === "/api/settings") return { kind: "settings" };
  if (path === "/api/documents") return { kind: "documents" };
  if (path === "/api/configuration") return { kind: "configuration" };
  if (path === "/api/learning/run") return { kind: "learning" };
  if (path === "/api/tasks/configure") return { kind: "task-config" };
  if (path === "/api/tasks/create") return { kind: "task-create" };
  if (path === "/api/tasks/reopen-preview") return { kind: "task-reopen-preview" };
  if (path === "/api/tasks/reopen") return { kind: "task-reopen" };
  if (path === "/api/tasks/cancel") return { kind: "task-cancel" };
  if (path === "/api/tasks/stops/retry") return { kind: "task-stop-retry" };
  const record = path.match(/^\/api\/(machines)\/([a-zA-Z0-9][\w.-]{0,79})(?:\/(configuration))?$/)
    ?? path.match(/^\/api\/(roles)(?:\/([a-z0-9][a-z0-9-]{0,39}))?$/)
    ?? path.match(/^\/api\/(members|projects)(?:\/([a-z0-9][a-z0-9-]{0,39}))?$/)
    ?? path.match(/^\/api\/(routines)(?:\/([a-zA-Z0-9][\w-]{0,79}))?$/)
    ?? path.match(/^\/api\/(plans)(?:\/(PL-[A-Z]?\d+)(?:\/(approve|pause|resume|retry|skip|cancel|continue|retry-stops))?)?$/);
  return record ? { kind: record[1], id: record[2], action: record[3] } : null;
}

export type UiJob = { method: string; path: string; body?: unknown; project_folder?: ProjectFolderCheck };
export type UiResult = { status: number; data: Record<string, unknown> };
const pendingMs = 2 * 60_000, retentionMs = 24 * 60 * 60_000;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const uncertain = { status: 409, data: { error: "The main machine stopped before confirming this change. Check the record before saving again; the change may already have been applied." } };

export function initUiRequests(sql: FilesSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ui_requests (id TEXT PRIMARY KEY, session TEXT, created INTEGER, state TEXT, job TEXT, result TEXT, request_key TEXT);
    CREATE INDEX IF NOT EXISTS ui_requests_created ON ui_requests (created);`);
  if (!sql.exec("PRAGMA table_info(ui_requests)").toArray().some((column) => column.name === "request_key")) sql.exec("ALTER TABLE ui_requests ADD COLUMN request_key TEXT");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS ui_requests_key ON ui_requests (request_key)");
}

/** Returns null outside these routes. Owner tickets are session-scoped; only the fleet can claim or finish them. */
export async function uiRequestRoute(sql: FilesSql, req: Request, who: "machine" | { session: string },
  host: { online: () => boolean; supported: () => boolean; enqueue: (item: Record<string, unknown>) => void }): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const ticket = path.match(/^\/api\/(host\/)?ui-requests\/([a-f0-9-]{36})$/);
  if (ticket) {
    const machine = !!ticket[1], id = ticket[2];
    if (machine ? who !== "machine" : who === "machine") return json({ error: "forbidden" }, 403);
    const row = sql.exec("SELECT * FROM ui_requests WHERE id = ?", id).toArray()[0];
    if (!row) {
      // An old inbox item may outlive result retention: discard it instead of blocking every newer command.
      if (machine && req.method === "POST") return json({ done: true });
      if (machine && req.method === "PUT") return json({ ok: true });
      return json({ error: "This request is no longer available. Check the record before saving again." }, 404);
    }
    if (!machine && row.session !== (who as { session: string }).session) return json({ error: "request not found" }, 404);
    if (machine && req.method === "PUT") {
      const result = await req.json().catch(() => null) as UiResult | null;
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || [204, 205, 304].includes(result.status)
        || !result.data || typeof result.data !== "object" || Array.isArray(result.data) || JSON.stringify(result).length > 1_500_000)
        return json({ error: "invalid result" }, 400);
      if (row.state === "pending") return json({ error: "request was not claimed" }, 409);
      if (row.state !== "done") sql.exec("UPDATE ui_requests SET state = 'done', result = ? WHERE id = ? AND state = 'running'", JSON.stringify(result), id);
      return json({ ok: true });
    }
    if (req.method !== (machine ? "POST" : "GET")) return json({ error: "method not allowed" }, 405);
    if (row.state === "done") {
      const result = JSON.parse(row.result) as UiResult;
      if (machine) return json({ done: true });
      const response = json(result.data, result.status);
      response.headers.set("X-Noop-Confirmed", "1");
      return response;
    }
    if (machine && row.state === "running") {
      // A restarted primary must not repeat a create/delete whose result may have been lost.
      sql.exec("UPDATE ui_requests SET state = 'done', result = ? WHERE id = ?", JSON.stringify(uncertain), id);
      return json({ done: true });
    }
    const jobPath = JSON.parse(String(row.job)).path;
    const deadline = ["/api/tasks/cancel", "/api/tasks/stops/retry"].includes(jobPath) || /^\/api\/plans\/PL-[A-Z]?\d+\/(cancel|retry-stops)$/.test(jobPath) ? 5 * 60_000 : pendingMs;
    if (Date.now() - row.created > deadline) {
      const result = row.state === "running" ? uncertain : { status: 408, data: { error: "The main machine did not receive this request in time. Reconnect it and try again." } };
      sql.exec("UPDATE ui_requests SET state = 'done', result = ? WHERE id = ?", JSON.stringify(result), id);
      return machine ? json({ done: true }) : json(result.data, result.status);
    }
    if (machine) {
      sql.exec("UPDATE ui_requests SET state = 'running' WHERE id = ?", id);
      return json({ job: JSON.parse(row.job) });
    }
    return json({ ticket: id }, 202);
  }
  const record = recordPath(path);
  if (!record || path === "/api/settings" && req.method === "GET") return null;
  if (who === "machine") return json({ error: "owner session required" }, 403);
  if (record.kind === "settings" && req.method !== "PUT") return json({ error: "method not allowed" }, 405);
  if (["task-create", "task-reopen-preview", "task-reopen"].includes(record.kind) && req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (["task-create", "task-reopen-preview", "task-reopen"].includes(record.kind) && new URL(req.url).search) return json({ error: "Send task settings in the POST form" }, 400);
  if (record.kind === "archive" && !(record.action ? req.method === "POST" : ["GET", "POST"].includes(req.method))) return json({ error: "method not allowed" }, 405);
  if (record.kind === "archive" && new URL(req.url).search) return json({ error: "Send archive filters in the POST form" }, 400);
  if (["stop-review", "stop-resolve"].includes(record.kind) && req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!["GET", "POST", "PUT", "DELETE"].includes(req.method)) return json({ error: "method not allowed" }, 405);
  const key = record.kind === "task-cancel" && req.method === "POST" ? req.headers.get("Idempotency-Key") : null;
  if (key !== null && !validMessageKey(key)) return json({ error: "Use an Idempotency-Key of 8–128 letters, numbers, dots, underscores, colons or dashes" }, 400);
  let body: unknown;
  if (req.method !== "GET" && req.method !== "DELETE") {
    const text = await req.text();
    if (text.length > (path === "/api/documents" ? 800_000 : 65_536)) return json({ error: "form is too large" }, 413);
    try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }
  }
  if (record.kind === "settings") {
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Choose supported settings to change" }, 400);
    const settings = body as Record<string, unknown>;
    if (Object.hasOwn(settings, "tool_policy_version") && (settings.tool_policy_version !== 1 || !Object.hasOwn(settings, "clis")))
      return json({ error: "Use supported task tool policy controls" }, 400);
    if (Object.hasOwn(settings, "autonomy_policy_version") && (settings.autonomy_policy_version !== 1 || !Object.hasOwn(settings, "autonomy")))
      return json({ error: "Use supported member autonomy controls" }, 400);
    if (Object.hasOwn(settings, "clis")) {
      const checked = toolSettingsPatch(settings.clis);
      if ("error" in checked) return json({ error: checked.error }, 400);
      if ((Object.hasOwn(checked.values, "preference") || Object.hasOwn(settings.clis as object, "reset")) && settings.tool_policy_version !== 1)
        return json({ error: "Update the app to change the task tool policy" }, 400);
    }
    if (Object.hasOwn(settings, "autonomy")) {
      const checked = autonomySettingsPatch(settings.autonomy);
      if ("error" in checked) return json({ error: checked.error }, 400);
      if (Object.hasOwn(settings.autonomy as object, "reset") && settings.autonomy_policy_version !== 1)
        return json({ error: "Update the app to restore member autonomy settings" }, 400);
    }
  }
  if (record.kind === "stop-review" && !validStopReviewRequest(body) || record.kind === "stop-resolve" && !validStopResolveRequest(body))
    return json({ error: "Choose a supported cleanup review or decision" }, 400);
  if (record.kind === "archive" && !(record.action === "restore" ? validArchiveRestoreRequest(body)
    : record.action === "preview" ? validArchivePreviewRequest(body) : validArchiveListRequest(req.method === "GET" ? {} : body)))
    return json({ error: "Choose supported archive filters, a preview or a saved restoration" }, 400);
  if (record.kind === "task-create" && !validTaskCreateRequest(body) || record.kind === "task-reopen-preview" && !validTaskReopenPreviewRequest(body)
    || record.kind === "task-reopen" && !validTaskReopenRequest(body)) return json({ error: "Choose supported task settings and a current reopening preview" }, 400);
  const requestKey = key === null ? null : await hash(JSON.stringify([who.session, key]));
  const payload = requestKey === null ? "" : canonical({ method: req.method, path, body });
  const previous = (): Response | null => {
    if (requestKey === null) return null;
    const row = sql.exec("SELECT id,session,job FROM ui_requests WHERE request_key = ?", requestKey).toArray()[0];
    if (!row) return null;
    const job = JSON.parse(String(row.job)) as UiJob;
    return row.session === who.session && canonical({ method: job.method, path: job.path, body: job.body }) === payload
      ? json({ ticket: row.id }, 202) : json({ error: "This task-control key was already used for a different request. Check the original task before submitting another action." }, 409);
  };
  sql.exec("DELETE FROM ui_requests WHERE created < ?", Date.now() - retentionMs);
  const replay = previous();
  if (replay) return replay;
  if (!host.online()) return json({ error: "Connect the main machine to edit the team's members, projects, routines, machines and plans." }, 503);
  if (!host.supported()) return json({ error: "Update the main machine to use remote editing." }, 409);
  let projectFolder: ProjectFolderCheck | undefined;
  if (record.kind === "projects" && ["POST", "PUT"].includes(req.method) && body && typeof body === "object" && !Array.isArray(body)) {
    const input = body as Record<string, unknown>;
    if (Object.hasOwn(input, "project_folder") || Object.hasOwn(input, "context")) return json({ error: "Project folder verification cannot be supplied in the form" }, 400);
    if (input.probe_ticket !== undefined) {
      if (!validMachineHost(input.host) || typeof input.path !== "string") return json({ error: "Choose the checked machine and folder" }, 400);
      projectFolder = projectFolderReceipt(sql, input.probe_ticket, who.session, input.host, input.path) ?? undefined;
      if (!projectFolder) return json({ error: "Check this folder on the selected machine again before saving. Its verification is missing, changed or expired." }, 409);
    }
  }
  if (record.kind === "archive" && record.action === "restore" && validArchiveRestoreRequest(body) && !body.confirm_only && body.project?.probe_ticket !== undefined) {
    projectFolder = projectFolderReceipt(sql, body.project.probe_ticket, who.session, body.project.host, body.project.path) ?? undefined;
    if (!projectFolder) return json({ error: "Check this folder on the selected machine again before restoring. Its verification is missing, changed or expired. Use Check saved restore to confirm an earlier restoration." }, 409);
  }
  const id = crypto.randomUUID(), job: UiJob = { method: req.method, path, body, ...(projectFolder ? { project_folder: projectFolder } : {}) };
  try { sql.exec("INSERT INTO ui_requests (id, session, created, state, job, request_key) VALUES (?, ?, ?, 'pending', ?, ?)", id, who.session, Date.now(), JSON.stringify(job), requestKey); }
  catch (error) { const raced = previous(); if (raced) return raced; throw error; }
  host.enqueue({ type: "ui-request", id });
  return json({ ticket: id }, 202);
}
