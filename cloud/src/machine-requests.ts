import type { FilesSql } from "./files";
import { PROVIDER_IDS } from "./providers";
import { LEARNING_API, machineLearningPath, validLearningPreviewRequest, validLearningRunRequest, validLearningDiscardRequest, validLearningResult, type LearningPath } from "./learning";

export type MachineActor = "legacy" | { host: string } | { session: string };
export type MachineAccountPath = { host: string; cli?: string; name?: string; action?: string };
export type ProjectFolderCheck = { host: string; requested_path: string; path: string; repo: string; requires: string[]; checked: string };
export type TaskControl = { host: string; id: string; run_id: string; done: boolean };
export const TASK_CONTROL_API = 2;
export const validRunId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
const validTaskId = (id: unknown): id is string => typeof id === "string" && id.length <= 100 && /^T-[\w-]*\d{4}$/.test(id);
export function machineTaskPath(path: string): { host: string } | null {
  const match = path.match(/^\/api\/machines\/([^/]+)\/task-control$/);
  return match && validMachineHost(match[1]) ? { host: match[1] } : null;
}
export function machineProjectPath(path: string): { host: string } | null {
  const match = path.match(/^\/api\/machines\/([^/]+)\/project-folder-check$/);
  return match && validMachineHost(match[1]) ? { host: match[1] } : null;
}
export const validMachineHost = (host: unknown): host is string => typeof host === "string" && /^[a-zA-Z0-9][\w.-]{0,79}$/.test(host) && !["constructor", "prototype"].includes(host);
const accountName = (name: unknown): name is string => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name);
export const printableAccountName = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 200 && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(name);
export const encodeAccountSegment = (name: string): string => (name === "." || name === ".." || name.startsWith("~") ? "~" : "") + encodeURIComponent(name);
export function machineAccountPath(path: string): MachineAccountPath | null {
  const match = path.match(/^\/api\/machines\/([^/]+)\/accounts(?:\/([^/]+)\/([^/]+)(?:\/(login|code|cancel))?)?$/);
  if (!match || !validMachineHost(match[1]) || match[2] && !PROVIDER_IDS.includes(match[2])) return null;
  let name: string | undefined;
  if (match[3]) {
    try { name = decodeURIComponent(match[3].startsWith("~") ? match[3].slice(1) : match[3]); } catch { return null; }
    if (!printableAccountName(name) || encodeAccountSegment(name) !== match[3]) return null;
  }
  return { host: match[1], ...(match[2] ? { cli: match[2], name } : {}), ...(match[4] ? { action: match[4] } : {}) };
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const hash = async (token: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const pendingMs = 120_000, resultMs = 300_000, onlineMs = 180_000;
const primaryControlSession = "primary-task-control-v2";
const updateTaskMachine = "Update and reconnect the claiming machine to stop this task and its related work.";
const uncertain = { status: 409, data: { error: "This machine stopped before confirming the request. Check its status before trying again; a change may already have been applied." } };
const timedOut = { status: 408, data: { error: "This machine did not receive the request in time. Reconnect it and try again." } };

export function initMachineRequests(sql: FilesSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS machine_credentials (host TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, created INTEGER, seen INTEGER NOT NULL DEFAULT 0, account_api INTEGER NOT NULL DEFAULT 0, project_api INTEGER NOT NULL DEFAULT 0, task_api INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS machine_requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, target TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, job TEXT, result TEXT, kind TEXT NOT NULL DEFAULT 'accounts', requested_path TEXT, task_id TEXT, run_id TEXT, task_done INTEGER);
    CREATE INDEX IF NOT EXISTS machine_requests_target ON machine_requests (target, state);
    CREATE INDEX IF NOT EXISTS machine_requests_expires ON machine_requests (expires);`);
  const credentials = new Set(sql.exec("PRAGMA table_info(machine_credentials)").toArray().map((column) => String(column.name)));
  if (!credentials.has("project_api")) sql.exec("ALTER TABLE machine_credentials ADD COLUMN project_api INTEGER NOT NULL DEFAULT 0");
  if (!credentials.has("task_api")) sql.exec("ALTER TABLE machine_credentials ADD COLUMN task_api INTEGER NOT NULL DEFAULT 0");
  if (!credentials.has("learning_api")) sql.exec("ALTER TABLE machine_credentials ADD COLUMN learning_api INTEGER NOT NULL DEFAULT 0");
  const requests = new Set(sql.exec("PRAGMA table_info(machine_requests)").toArray().map((column) => String(column.name)));
  if (!requests.has("kind")) sql.exec("ALTER TABLE machine_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'accounts'");
  if (!requests.has("requested_path")) sql.exec("ALTER TABLE machine_requests ADD COLUMN requested_path TEXT");
  if (!requests.has("task_id")) sql.exec("ALTER TABLE machine_requests ADD COLUMN task_id TEXT");
  if (!requests.has("run_id")) sql.exec("ALTER TABLE machine_requests ADD COLUMN run_id TEXT");
  if (!requests.has("task_done")) sql.exec("ALTER TABLE machine_requests ADD COLUMN task_done INTEGER");
  if (!requests.has("learning_request")) sql.exec("ALTER TABLE machine_requests ADD COLUMN learning_request TEXT");
}
export async function identifyMachine(sql: FilesSql, token: string): Promise<{ host: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = sql.exec("SELECT host FROM machine_credentials WHERE hash = ?", await hash(token)).toArray()[0];
  return row ? { host: String(row.host) } : null;
}
/** Only owner-approved rotation can replace an already-bound host. Raw tokens are returned once. */
export async function mintMachineToken(sql: FilesSql, host: string, replace = false, proposed?: string): Promise<{ token: string; host: string } | null> {
  if (!validMachineHost(host)) return null;
  if (proposed !== undefined && !/^[a-f0-9]{64}$/.test(proposed)) return null;
  const token = proposed ?? [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const digest = await hash(token);
  // Recheck after hashing yields: simultaneous joins must never replace each other implicitly.
  const existing = sql.exec("SELECT hash FROM machine_credentials WHERE host = ?", host).toArray()[0];
  if (!replace && existing) return proposed && existing.hash === digest ? { token, host } : null;
  if (sql.exec("SELECT host FROM machine_credentials WHERE hash = ? AND host != ?", digest, host).toArray().length) return null;
  sql.exec("DELETE FROM machine_requests WHERE target = ?", host);
  sql.exec("INSERT OR REPLACE INTO machine_credentials (host, hash, created, seen, account_api) VALUES (?, ?, ?, 0, 0)", host, digest, Date.now());
  return { token, host };
}
export function pruneMachineRequests(sql: FilesSql, now = Date.now()) {
  sql.exec("DELETE FROM machine_requests WHERE state = 'done' AND expires <= ?", now);
  for (const row of sql.exec("SELECT id,task_id,run_id,state FROM machine_requests WHERE kind = 'task-control' AND state != 'done' AND expires <= ?", now).toArray()) {
    const pending = row.state === "pending";
    const result = { status: pending ? 408 : 409, data: { ok: false, id: row.task_id, run_id: row.run_id,
      error: pending ? "This machine did not receive the stop request in time. Reconnect it and check the task before retrying." : "This machine stopped confirming the request. Check the task before retrying; its agent may already have stopped.",
      ...(pending ? { retryable: true } : { uncertain: true }) } };
    sql.exec("UPDATE machine_requests SET state = 'done', job = NULL, result = ?, expires = ? WHERE id = ?", JSON.stringify(result), now + resultMs, row.id);
  }
  sql.exec("UPDATE machine_requests SET state = 'done', job = NULL, result = ?, expires = ? WHERE kind != 'task-control' AND state = 'pending' AND expires <= ?", JSON.stringify(timedOut), now + resultMs, now);
  sql.exec("UPDATE machine_requests SET state = 'done', job = NULL, result = ?, expires = ? WHERE kind != 'task-control' AND state = 'running' AND expires <= ?", JSON.stringify(uncertain), now + resultMs, now);
}
export function nextMachineRequestExpiry(sql: FilesSql): number | null {
  const row = sql.exec("SELECT MIN(expires) AS next FROM machine_requests").toArray()[0];
  return row?.next == null ? null : Number(row.next);
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const loginId = (id: unknown) => typeof id === "string" && /^L-\d{4,}$/.test(id) && id.length <= 128;
const shortText = (value: unknown, max = 500): value is string => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const isoDate = (value: unknown) => shortText(value, 40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
export function validTaskControl(value: unknown): value is TaskControl {
  return object(value) && keys(value, ["host", "id", "run_id", "done"]) && validMachineHost(value.host) && validTaskId(value.id) && validRunId(value.run_id) && typeof value.done === "boolean";
}
/** The same run and owner intent always address the same command, even after a lost POST reply. */
export async function taskControlTicket(control: TaskControl): Promise<string> {
  // Single-run confirmations cannot satisfy a family-aware stop request.
  const digest = await hash(JSON.stringify(["task-control", TASK_CONTROL_API, control.host, control.id, control.run_id, control.done]));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}
export function validTaskControlResult(value: unknown, control: Pick<TaskControl, "id" | "run_id" | "done">, status: number): boolean {
  if (!object(value) || value.id !== control.id || value.run_id !== control.run_id) return false;
  if (status === 200) return keys(value, ["ok", "id", "run_id", "result"]) && value.ok === true && value.result === (control.done ? "done" : "cancelled");
  return status >= 400 && keys(value, ["ok", "id", "run_id", "error", "result", "saved_locally", "uncertain", "retryable"]) && value.ok === false && shortText(value.error, 2000)
    && (value.result === undefined || shortText(value.result, 500)) && [value.saved_locally, value.uncertain, value.retryable].every((flag) => flag === undefined || typeof flag === "boolean");
}
function safeLogin(value: unknown, cli: string) {
  if (!object(value) || !keys(value, ["id", "url", "user_code", "needs_code", "expires", "status"])
    || typeof value.id !== "string" || !/^L-\d{4,}$/.test(value.id) || typeof value.needs_code !== "boolean" || !isoDate(value.expires)
    || typeof value.status !== "string" || !["starting", "waiting", "submitted", "complete", "failed", "cancelled", "expired"].includes(value.status)) return false;
  if (value.user_code !== undefined && (typeof value.user_code !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/.test(value.user_code))) return false;
  if (["complete", "failed", "cancelled", "expired"].includes(String(value.status)) && (value.url !== undefined || value.user_code !== undefined)) return false;
  if (value.url === undefined) return true;
  if (!shortText(value.url, 8192) || /sk-ant-|access_token|refresh_token|api_key/i.test(value.url)) return false;
  try {
    const url = new URL(value.url), domains = cli === "claude" ? ["claude.ai", "anthropic.com"] : cli === "codex" ? ["openai.com", "chatgpt.com"] : [];
    return url.protocol === "https:" && !url.username && !url.password && domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
function safeAccountResult(value: Record<string, unknown>, host: string, status: number) {
  if (status >= 400) return keys(value, ["error"]) && shortText(value.error, 1000);
  if (!keys(value, ["host", "providers", "accounts"]) || value.host !== host || !Array.isArray(value.providers) || value.providers.length > PROVIDER_IDS.length || !Array.isArray(value.accounts) || value.accounts.length > 100) return false;
  return value.providers.every((p) => object(p) && keys(p, ["id", "label", "installed", "available", "enabled", "reason", "host"])
      && typeof p.id === "string" && PROVIDER_IDS.includes(p.id) && shortText(p.label, 80) && [p.installed, p.available, p.enabled].every((v) => typeof v === "boolean")
      && (p.reason === undefined || shortText(p.reason)) && (p.host === undefined || p.host === host))
    && value.accounts.every((a) => object(a) && keys(a, ["cli", "name", "default", "state", "until", "login"])
      && typeof a.cli === "string" && PROVIDER_IDS.includes(a.cli) && printableAccountName(a.name) && typeof a.default === "boolean"
      && typeof a.state === "string" && ["unknown", "ok", "cooldown", "login"].includes(a.state)
      && (a.until === undefined || isoDate(a.until)) && (a.login === undefined || safeLogin(a.login, a.cli)));
}

/** A closed filesystem inspection result; it is never accepted as an account summary. */
export function validProjectFolderCheck(value: unknown, host: string, requestedPath: string): value is ProjectFolderCheck {
  return object(value) && keys(value, ["host", "requested_path", "path", "repo", "requires", "checked"]) && value.host === host && value.requested_path === requestedPath
    && shortText(value.path, 4096) && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.path) && shortText(value.repo, 1000) && (value.repo === "" || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo)) && isoDate(value.checked)
    && Array.isArray(value.requires) && value.requires.length <= 100 && value.requires.every((cap) => typeof cap === "string" && cap.length <= 200 && /^[\w:.-]+(?:\|[\w:.-]+)*$/.test(cap));
}

/** Only the owner session that requested this host/path can attach its completed, unexpired proof to a project write. */
export function projectFolderReceipt(sql: FilesSql, id: unknown, session: string, host: unknown, requestedPath: unknown): ProjectFolderCheck | null {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || !validMachineHost(host) || !shortText(requestedPath, 4096)) return null;
  const row = sql.exec("SELECT * FROM machine_requests WHERE id = ?", id).toArray()[0];
  if (!row || row.session !== session || row.target !== host || row.kind !== "project-folder-check" || row.requested_path !== requestedPath || row.state !== "done"
    || Number(row.expires) <= Date.now() || Date.now() - Number(row.created) > pendingMs + resultMs) return null;
  const result = JSON.parse(String(row.result));
  return result.status === 200 && validProjectFolderCheck(result.data, host, requestedPath) ? result.data : null;
}

async function primaryTaskControl(sql: FilesSql, req: Request, actor: MachineActor): Promise<Response> {
  if (actor !== "legacy") return json({ error: "primary machine credential required" }, 403);
  const path = new URL(req.url).pathname, ticket = path.match(/^\/api\/host\/task-controls\/([a-f0-9-]{36})$/);
  if (ticket) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const row = sql.exec("SELECT * FROM machine_requests WHERE id = ? AND kind = 'task-control' AND session = ?", ticket[1], primaryControlSession).toArray()[0];
    if (!row) return json({ error: "This stop request is no longer available. Check the task before retrying." }, 404);
    if (row.state !== "done") return json({ ticket: row.id }, 202);
    const result = JSON.parse(String(row.result)), response = json(result.data, result.status);
    response.headers.set("X-Noop-Confirmed", "1"); return response;
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "task control is too large" }, 413);
  let body: unknown; try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!validTaskControl(body)) return json({ error: "Choose the claiming machine, task, run and requested outcome" }, 400);
  const id = await taskControlTicket(body);
  pruneMachineRequests(sql);
  const existing = sql.exec("SELECT id,state FROM machine_requests WHERE id = ? AND kind = 'task-control' AND session = ?", id, primaryControlSession).toArray()[0];
  if (existing && existing.state !== "pending") return json({ ticket: id }, 202);
  const machine = sql.exec("SELECT seen, task_api FROM machine_credentials WHERE host = ?", body.host).toArray()[0];
  if (!machine || machine.task_api !== TASK_CONTROL_API) return json({ error: updateTaskMachine }, 409);
  if (Date.now() - Number(machine.seen) > onlineMs) return json({ error: "Connect the claiming machine before stopping this task." }, 503);
  if (existing) return json({ ticket: id }, 202);
  if (Number(sql.exec("SELECT COUNT(*) AS n FROM machine_requests WHERE target = ? AND state != 'done'", body.host).toArray()[0].n) >= 20)
    return json({ error: "Too many pending requests for this machine. Wait for its current requests to finish." }, 429);
  const now = Date.now(), control = { id: body.id, run_id: body.run_id, done: body.done };
  sql.exec("INSERT INTO machine_requests (id,session,target,created,expires,state,job,kind,task_id,run_id,task_done) VALUES (?,?,?,?,?,'pending',?,'task-control',?,?,?)",
    id, primaryControlSession, body.host, now, now + pendingMs, JSON.stringify({ method: "POST", path: `/api/machines/${body.host}/task-control`, body: control }), body.id, body.run_id, body.done ? 1 : 0);
  return json({ ticket: id }, 202);
}

/** Targeted commands never enter the global inbox, feed or file history. */
export async function machineRequestRoute(sql: FilesSql, req: Request, actor: MachineActor): Promise<Response | null> {
  const path = new URL(req.url).pathname, method = req.method;
  const ticket = path.match(/^\/api\/(host\/)?machine-requests\/([a-f0-9-]{36})$/);
  const account = machineAccountPath(path), project = machineProjectPath(path), task = machineTaskPath(path), learning = machineLearningPath(path);
  const primaryControl = path === "/api/host/task-controls" || /^\/api\/host\/task-controls\/[a-f0-9-]{36}$/.test(path);
  if (!ticket && !account && !project && !task && !learning && !primaryControl && path !== "/api/host/machine-inbox" && path !== "/api/host/machine-state") return null;
  pruneMachineRequests(sql);
  if (primaryControl) return primaryTaskControl(sql, req, actor);
  if (task) return json({ error: "Active task controls must be delegated by the primary machine" }, 403);
  const worker = actor !== "legacy" && "host" in actor ? actor : null;
  const owner = actor !== "legacy" && "session" in actor ? actor : null;
  if (path === "/api/host/machine-state" || path === "/api/host/machine-inbox") {
    if (!worker) return json({ error: "host-scoped machine credential required" }, 403);
    if (path.endsWith("machine-state")) {
      if (method !== "PUT") return json({ error: "method not allowed" }, 405);
      const b = await req.json().catch(() => null);
      if (!object(b) || !keys(b, ["account_api", "project_api", "task_api", "learning_api"]) || b.account_api !== 1 || b.project_api !== undefined && b.project_api !== 1 || b.task_api !== undefined && b.task_api !== 1 && b.task_api !== TASK_CONTROL_API
        || b.learning_api !== undefined && b.learning_api !== LEARNING_API) return json({ error: "invalid machine state" }, 400);
      sql.exec("UPDATE machine_credentials SET seen = ?, account_api = 1, project_api = ?, task_api = ?, learning_api = ? WHERE host = ?", Date.now(), b.project_api === 1 ? 1 : 0, b.task_api ?? 0, b.learning_api ?? 0, worker.host);
      return json({ ok: true });
    }
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    sql.exec("UPDATE machine_credentials SET seen = ? WHERE host = ? AND seen < ?", Date.now(), worker.host, Date.now() - 60_000);
    return json({ items: sql.exec("SELECT id FROM machine_requests WHERE target = ? AND state = 'pending' AND (kind != 'task-control' OR (SELECT task_api FROM machine_credentials WHERE host = ?) = ?) AND (kind NOT LIKE 'learning-%' OR (SELECT learning_api FROM machine_credentials WHERE host = ?) = ?) ORDER BY created LIMIT 50", worker.host, worker.host, TASK_CONTROL_API, worker.host, LEARNING_API).toArray().map((row) => ({ id: row.id })) });
  }
  if (ticket) {
    const machine = !!ticket[1], id = ticket[2];
    if (machine ? !worker : !owner) return json({ error: "forbidden" }, 403);
    if (machine ? !["POST", "PUT"].includes(method) : method !== "GET") return json({ error: "method not allowed" }, 405);
    const row = sql.exec("SELECT * FROM machine_requests WHERE id = ?", id).toArray()[0];
    if (!row) return machine ? json(method === "PUT" ? { ok: true } : { done: true }) : json({ error: "This account request is no longer available. Check the machine before trying again." }, 404);
    if (machine ? row.target !== worker!.host : row.kind === "task-control" || row.session !== owner!.session) return json({ error: "request not found" }, 404);
    if (!machine) {
      if (method !== "GET") return json({ error: "method not allowed" }, 405);
      if (row.state !== "done") return json({ ticket: id }, 202);
      const result = JSON.parse(row.result), response = json(row.kind === "project-folder-check" && result.status === 200 ? { ...result.data, probe_ticket: id } : result.data, result.status);
      response.headers.set("X-Noop-Confirmed", "1"); return response;
    }
    if (method === "PUT") {
      const text = await req.text();
      if (text.length > 100_000) return json({ error: "result is too large" }, 413);
      let result: any; try { result = JSON.parse(text); } catch { return json({ error: "invalid result" }, 400); }
      if (!object(result) || !keys(result, ["status", "data"]) || !Number.isInteger(result.status) || Number(result.status) < 200 || Number(result.status) > 599 || [202, 204, 205, 304].includes(Number(result.status)) || !object(result.data)
        || !(String(row.kind).startsWith("learning-") ? validLearningResult(result.data, { host: worker!.host, action: String(row.kind).slice(9) as LearningPath["action"] }, JSON.parse(String(row.learning_request)), Number(result.status))
          : row.kind === "task-control" ? validTaskControlResult(result.data, { id: String(row.task_id), run_id: String(row.run_id), done: row.task_done === 1 }, Number(result.status)) : row.kind === "project-folder-check"
          ? Number(result.status) >= 400 ? keys(result.data, ["error"]) && shortText(result.data.error, 8192) : Number(result.status) === 200 && validProjectFolderCheck(result.data, worker!.host, String(row.requested_path))
          : safeAccountResult(result.data, worker!.host, Number(result.status)))) return json({ error: "invalid result" }, 400);
      if (row.state === "pending") return json({ error: "request was not claimed" }, 409);
      if (row.state === "running") sql.exec("UPDATE machine_requests SET state = 'done', job = NULL, result = ?, expires = ? WHERE id = ?", JSON.stringify(result), Date.now() + resultMs, id);
      return json({ ok: true });
    }
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    if (row.state === "done") return json({ done: true });
    if (row.state === "running") {
      const result = row.kind === "task-control" ? { status: 409, data: { ok: false, id: row.task_id, run_id: row.run_id, uncertain: true,
        error: "This machine restarted before confirming the stop request. Check the task before retrying; its agent may already have stopped." } } : uncertain;
      sql.exec("UPDATE machine_requests SET state = 'done', job = NULL, result = ?, expires = ? WHERE id = ?", JSON.stringify(result), Date.now() + resultMs, id);
      return json({ done: true });
    }
    if (row.kind === "task-control" && sql.exec("SELECT task_api FROM machine_credentials WHERE host = ?", worker!.host).toArray()[0]?.task_api !== TASK_CONTROL_API)
      return json({ error: updateTaskMachine }, 409);
    if (String(row.kind).startsWith("learning-") && sql.exec("SELECT learning_api FROM machine_credentials WHERE host = ?", worker!.host).toArray()[0]?.learning_api !== LEARNING_API)
      return json({ error: "Update and reconnect this machine to use its learning controls." }, 409);
    const job = JSON.parse(row.job);
    sql.exec("UPDATE machine_requests SET state = 'running', job = NULL WHERE id = ?", id);
    return json({ job });
  }
  if (!owner) return json({ error: "owner session required" }, 403);
  const allowed = learning ? method === (learning.action === "status" ? "GET" : "POST") : project ? method === "POST" : account!.action ? method === "POST" : account!.cli ? method === "DELETE" : ["GET", "POST", "PUT"].includes(method);
  if (!allowed) return json({ error: "method not allowed" }, 405);
  if (learning && new URL(req.url).search) return json({ error: "Send learning controls in the form, without query parameters." }, 400);
  const target = (learning ?? project ?? account)!.host;
  const capable = (machine: Record<string, unknown>) => learning ? machine.learning_api === LEARNING_API : project ? machine.project_api === 1 : machine.account_api === 1;
  const host = sql.exec("SELECT hash, seen, account_api, project_api, learning_api FROM machine_credentials WHERE host = ?", target).toArray()[0];
  if (!host || !capable(host)) return json({ error: learning ? "Update and reconnect this machine to use its learning controls." : project ? "Update and reconnect this machine to check project folders." : "Update and reconnect this machine to manage its AI accounts." }, 409);
  if (Date.now() - Number(host.seen) > onlineMs) return json({ error: learning ? "Connect this machine to use its learning controls." : project ? "Connect this machine to check its project folders." : "Connect this machine to manage its AI accounts." }, 503);
  let body: unknown;
  if (method === "POST" || method === "PUT") {
    const text = await req.text();
    if (text.length > 16_384) return json({ error: "account form is too large" }, 413);
    try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }
    if (!object(body)) return json({ error: "invalid form" }, 400);
    if (learning) {
      if (!(learning.action === "preview" ? validLearningPreviewRequest(body) : learning.action === "discard" ? validLearningDiscardRequest(body) : validLearningRunRequest(body))) return json({ error: "Choose a current learning preview and the same saved run request." }, 400);
    } else if (project) {
      if (!keys(body, ["path"]) || !shortText(body.path, 4096) || !body.path.trim()) return json({ error: "Choose the project's folder on this machine" }, 400);
    } else if (method === "PUT") {
      if (!keys(body, ["cli", "names"]) || typeof body.cli !== "string" || !PROVIDER_IDS.includes(body.cli) || body.names !== null && (!Array.isArray(body.names) || body.names.length > 100 || body.names.some((name) => !printableAccountName(name)) || new Set(body.names).size !== body.names.length))
        return json({ error: "Choose a tool and unique selected account names, or null to restore file defaults" }, 400);
    } else if (!account!.cli) {
      if (!keys(body, ["cli", "name"]) || typeof body.cli !== "string" || !PROVIDER_IDS.includes(body.cli) || !accountName(body.name)) return json({ error: "Choose a supported tool and account name" }, 400);
    } else if (account!.action === "code") {
      if (!keys(body, ["id", "code"]) || !loginId(body.id) || typeof body.code !== "string" || !body.code.trim() || body.code.length > 8192 || /[\r\n\0]/.test(body.code)) return json({ error: "Provide the pending sign-in ID and its code" }, 400);
    } else if (account!.action === "cancel") {
      if (!keys(body, ["id"]) || !loginId(body.id)) return json({ error: "Provide the pending sign-in ID" }, 400);
    } else if (Object.keys(body).length) return json({ error: "Send an empty object to start sign-in" }, 400);
  }
  const current = sql.exec("SELECT hash, seen, account_api, project_api, learning_api FROM machine_credentials WHERE host = ?", target).toArray()[0];
  if (!current || current.hash !== host.hash || !capable(current) || Date.now() - Number(current.seen) > onlineMs)
    return json({ error: "This machine reconnected or changed its credential. Reload its controls before trying again." }, 409);
  if (Number(sql.exec("SELECT COUNT(*) AS n FROM machine_requests WHERE target = ? AND state != 'done'", target).toArray()[0].n) >= 20) return json({ error: "Too many pending requests for this machine. Wait for the current requests to finish." }, 429);
  const id = crypto.randomUUID(), now = Date.now();
  sql.exec("INSERT INTO machine_requests (id, session, target, created, expires, state, job, kind, requested_path, learning_request) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)", id, owner.session, target, now, now + pendingMs,
    JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) }), learning ? `learning-${learning.action}` : project ? "project-folder-check" : "accounts", project ? (body as { path: string }).path : null, learning ? JSON.stringify(body ?? null) : null);
  return json({ ticket: id }, 202);
}
