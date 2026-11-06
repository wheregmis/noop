// Every machine consumes only its authenticated command inbox.
import { hostName, loadConfig, type Cfg } from "./core";
import { writeHubToml } from "./sync";
import { accountRequest } from "./account-ui";
import { machineAccountPath, machineProjectPath, machineTaskPath, TASK_CONTROL_API, taskControlTicket, validTaskControl, validTaskControlResult, type TaskControl } from "../cloud/src/machine-requests";
import { projectFolderRequest } from "./projects";
import { taskControlRequest } from "./server";
import { LEARNING_API, machineLearningPath } from "../cloud/src/learning";
import { learningRequest } from "./learning";

type Result = { status: number; data: Record<string, unknown> };
type Send = (path: string, init?: RequestInit) => Promise<any>;
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

/** An upload retry reuses the completed result, never the sign-in or mutation. */
export async function applyMachineRequest(id: string, host: string, send: Send,
  route: (req: Request) => Promise<Response>, results: Map<string, Result>) {
  if (!validId(id)) throw new Error("Invalid machine request");
  const endpoint = `/api/host/machine-requests/${id}`;
  let result = results.get(id);
  if (!result) {
    const claim = await send(endpoint, { method: "POST" });
    if (!claim) throw new Error("Could not claim machine request");
    if (claim.done) return;
    const job = claim.job, task = typeof job?.path === "string" ? machineTaskPath(job.path) : null;
    const target = typeof job?.path === "string" ? machineAccountPath(job.path) ?? machineProjectPath(job.path) ?? task ?? machineLearningPath(job.path) : null;
    if (!target || target.host !== host || !["GET", "POST", "PUT", "DELETE"].includes(job.method)) {
      result = { status: 400, data: { error: "Invalid command for this machine" } };
    } else {
      try {
        const response = await route(new Request(`http://machine${job.path}`, { method: job.method,
          ...(job.method === "GET" || job.method === "DELETE" ? {} : { body: JSON.stringify(job.body), headers: { "Content-Type": "application/json" } }) }));
        result = { status: response.status, data: await response.json() as Record<string, unknown> };
      } catch {
        result = { status: 500, data: { error: "This machine could not complete the request. Check its settings before retrying.",
          ...(task && validTaskControl({ ...job.body, host }) ? { ok: false, id: job.body.id, run_id: job.body.run_id, uncertain: true } : {}) } };
      }
    }
    results.set(id, result);
  }
  if (!(await send(endpoint, { method: "PUT", body: JSON.stringify(result) }))?.ok)
    throw new Error("Could not confirm machine result");
  results.delete(id);
}

/** Exchange a legacy fleet credential once; never overwrite the primary bridge's credential. */
export async function machineChannelToken(cfg: Cfg, fetcher: typeof fetch = fetch): Promise<string | null> {
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, ""), host = hostName(cfg);
  if (!url || !cfg.server?.token) return null;
  const request = async (token: string, path: string, body?: unknown) => {
    try {
      const response = await fetcher(url + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      return response.ok ? await response.json() as any : null;
    } catch { return null; }
  };
  const current = cfg.cloud?.machine_token;
  if (current) {
    const identity = await request(String(current), "/api/host/identity");
    if (identity && !identity.legacy) return identity.host === host ? String(current) : null;
  }
  const identity = await request(String(cfg.server.token), "/api/host/identity");
  if (!identity) return null;
  if (!identity.legacy) return identity.host === host ? String(cfg.server.token) : null;
  const candidate = current ?? [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (!/^[a-f0-9]{64}$/.test(candidate)) return null;
  if (!current) {
    writeHubToml({ cloud: { machine_token: candidate } });
    cfg.cloud.machine_token = candidate;
  }
  const registered = await request(String(cfg.server.token), "/api/host/register", { host, token: candidate });
  return registered?.host === host && registered?.token === candidate ? candidate : null;
}

/** Only the primary can delegate a specific claimed run; its worker returns the checked persistence result. */
export async function delegateTaskControl(cfg: Cfg, control: TaskControl,
  io: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Result> {
  const fail = (status: number, error: string, detail: Record<string, unknown> = {}): Result => ({ status, data: { ok: false, id: control.id, run_id: control.run_id, error, ...detail } });
  if (!validTaskControl(control)) return fail(400, "Choose the claiming machine, task, run and requested outcome");
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  if (!url || !cfg.server?.token) return fail(503, "Connect the main machine to the cloud hub before stopping a task on another machine.", { retryable: true });
  const fetcher = io.fetch ?? fetch, now = io.now ?? Date.now, sleep = io.sleep ?? Bun.sleep;
  const deadline = now() + 150_000, ticket = await taskControlTicket(control);
  let polling = false, acknowledged = false;
  while (now() < deadline) {
    let response: Response | null = null, data: Record<string, unknown> = {};
    try {
      response = await fetcher(url + "/api/host/task-controls" + (polling ? `/${ticket}` : ""), {
        method: polling ? "GET" : "POST", headers: { Authorization: `Bearer ${cfg.server.token}`, "Content-Type": "application/json" },
        ...(!polling ? { body: JSON.stringify(control) } : {}), signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now()))),
      });
      const value = await response.json();
      if (value && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>;
    } catch { response = null; }
    if (response) {
      if (response.status === 202 && data.ticket === ticket) { polling = true; acknowledged = true; }
      else if (polling && response.status === 404 && !acknowledged) polling = false;
      else if (polling && response.status >= 500 && response.headers.get("X-Noop-Confirmed") !== "1") { /* Keep the same command while its receipt is unreachable. */ }
      else if (validTaskControlResult(data, control, response.status)) return { status: response.status, data };
      else if (response.status >= 400) return fail(response.status, typeof data.error === "string" && data.error.length <= 2000 ? data.error : "The claiming machine could not confirm this stop request.", { ...(polling ? { uncertain: true } : {}) });
      else return fail(502, "The cloud hub returned an invalid stop confirmation. Update it and check the task before retrying.", { uncertain: true });
    } else polling = true; // A lost POST reply is recovered by the command's deterministic ticket.
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(1000, remaining));
  }
  return fail(503, "The claiming machine has not confirmed this stop request. Check the task before retrying; the same run will be checked again.", { uncertain: true, retryable: true });
}

export const machineCommandRequest = (req: Request) => {
  const path = new URL(req.url).pathname;
  return machineLearningPath(path) ? learningRequest(req) : machineTaskPath(path) ? taskControlRequest(req) : machineProjectPath(path) ? projectFolderRequest(req) : accountRequest(req);
};

function pollMilliseconds() {
  try {
    const seconds = loadConfig().cloud?.poll_seconds;
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 60) return seconds * 1000;
  } catch { /* Invalid direct-file edits must not spin the command channel. */ }
  return 3000;
}

/** Returns a stop function for shutdown/tests. Persistent provider credentials never enter this channel. */
export function startMachineBridge(cfg: Cfg, options: { taskReady?: () => boolean } = {}) {
  if (!cfg.cloud?.url || !cfg.server?.token) return async () => {};
  const url = String(cfg.cloud.url).replace(/\/$/, ""), host = hostName(cfg), results = new Map<string, Result>();
  const lifetime = new AbortController();
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, token: string | null = null, lastState = 0;
  const fetcher = (async (input, init = {}) => {
    if (stopped) throw new Error("Machine channel stopped");
    const response = await fetch(input, { ...init, signal: AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]) });
    if (stopped) throw new Error("Machine channel stopped");
    return response;
  }) as typeof fetch;
  const send: Send = async (path, init = {}) => {
    try {
      const response = await fetcher(url + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const loop = async () => {
    try {
      token ??= await machineChannelToken(cfg, fetcher);
      if (token && !stopped) {
        if (Date.now() - lastState >= 30000) {
          const compatible = { account_api: 1, project_api: 1, ...(options.taskReady?.() ? { task_api: TASK_CONTROL_API } : {}) };
          const ready = await send("/api/host/machine-state", { method: "PUT", body: JSON.stringify({ ...compatible, learning_api: LEARNING_API }) })
            ?? await send("/api/host/machine-state", { method: "PUT", body: JSON.stringify(compatible) })
            ?? (compatible.task_api ? await send("/api/host/machine-state", { method: "PUT", body: JSON.stringify({ account_api: 1, project_api: 1 }) }) : null)
            ?? await send("/api/host/machine-state", { method: "PUT", body: JSON.stringify({ account_api: 1 }) });
          if (ready) lastState = Date.now();
        }
        // Claimed requests leave the pending inbox; retry their cached results independently.
        for (const id of results.keys()) {
          if (stopped) break;
          await applyMachineRequest(id, host, send, machineCommandRequest, results);
        }
        const inbox = await send("/api/host/machine-inbox");
        for (const item of inbox?.items ?? []) {
          if (stopped) break;
          await applyMachineRequest(item.id, host, send, machineCommandRequest, results);
        }
      }
    } catch { if (!stopped) console.error("Machine account channel could not confirm a request; it will retry."); }
    if (!stopped) timer = setTimeout(() => { timer = undefined; running = loop(); }, token ? pollMilliseconds() : 30000);
  };
  let running = loop();
  return () => { stopped = true; if (timer) clearTimeout(timer); lifetime.abort(); return running; };
}
