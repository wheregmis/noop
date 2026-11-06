import { expect, spyOn, test } from "bun:test";
import { applyMachineRequest, delegateTaskControl, machineChannelToken, machineCommandRequest, startMachineBridge } from "../src/machine-bridge";
import { taskControlTicket, type TaskControl } from "../cloud/src/machine-requests";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P } from "../src/core";
import { readHubToml, writeHubToml, hubTomlPath } from "../src/sync";

const id = "12345678-1234-1234-1234-123456789abc";

test("the real machine bridge inspects its own project folder and retries only result upload", async () => {
  fs.mkdirSync(P(), { recursive: true });
  const config = P("config.toml"), prior = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : null;
  const folder = fs.mkdtempSync(join(tmpdir(), "noop-bridge-project-"));
  fs.writeFileSync(join(folder, "Cargo.toml"), "[package]\nname = 'fixture'\n");
  fs.writeFileSync(config, '[host]\nname = "worker"\n');
  const results = new Map(), uploads: any[] = [];
  let claims = 0, fail = true;
  const send = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { claims++; return { job: { method: "POST", path: "/api/machines/worker/project-folder-check", body: { path: folder } } }; }
    uploads.push(JSON.parse(String(init?.body))); return fail ? null : { ok: true };
  };
  try {
    await expect(applyMachineRequest(id, "worker", send, machineCommandRequest, results)).rejects.toThrow("confirm");
    expect(uploads[0]).toMatchObject({ status: 200, data: { host: "worker", requested_path: folder, requires: ["cli:cargo"] } });
    fs.rmSync(folder, { recursive: true });
    fail = false; await applyMachineRequest(id, "worker", send, machineCommandRequest, results);
    expect(claims).toBe(1); expect(uploads[1]).toEqual(uploads[0]); expect(results.size).toBe(0);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    if (prior === null) fs.rmSync(config); else fs.writeFileSync(config, prior);
  }
});

test("account command retries upload without running the machine operation twice", async () => {
  const results = new Map(), uploads: any[] = [];
  let claims = 0, runs = 0, fail = true;
  const send = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { claims++; return { job: { method: "POST", path: "/api/machines/mac/accounts", body: { cli: "codex", name: "work" } } }; }
    uploads.push(JSON.parse(String(init?.body))); return fail ? null : { ok: true };
  };
  const route = async (req: Request) => { runs++; expect(await req.json()).toEqual({ cli: "codex", name: "work" }); return Response.json({ host: "mac", accounts: [] }); };
  await expect(applyMachineRequest(id, "mac", send, route, results)).rejects.toThrow("confirm");
  fail = false; await applyMachineRequest(id, "mac", send, route, results);
  expect(runs).toBe(1); expect(claims).toBe(1); expect(uploads[1]).toEqual(uploads[0]); expect(results.size).toBe(0);
});

test("account commands reject another target and never expose a failing authorization code", async () => {
  let routed = 0, result: any;
  const wrong = async (_path: string, init?: RequestInit) => init?.method === "POST" ? { job: { method: "POST", path: "/api/machines/linux/accounts" } } : (result = JSON.parse(String(init?.body)), { ok: true });
  await applyMachineRequest(id, "mac", wrong, async () => { routed++; return Response.json({}); }, new Map());
  expect(routed).toBe(0); expect(result.status).toBe(400);
  const failing = async (_path: string, init?: RequestInit) => init?.method === "POST" ? { job: { method: "POST", path: "/api/machines/mac/accounts/claude/work/code", body: { id: "L-0001", code: "private-code" } } } : (result = JSON.parse(String(init?.body)), { ok: true });
  await applyMachineRequest(id, "mac", failing, async () => { throw new Error("private-code"); }, new Map());
  expect(result.status).toBe(500); expect(JSON.stringify(result)).not.toContain("private-code");
});

test("replayed account commands do not rerun after the server marks them done", async () => {
  let runs = 0;
  await applyMachineRequest(id, "mac", async () => ({ done: true }), async () => { runs++; return Response.json({}); }, new Map());
  expect(runs).toBe(0);
});

test("legacy credentials mint a separate local channel token and scoped credentials cannot change host", async () => {
  const calls: { url: string; auth: string | null }[] = [], token = "b".repeat(64);
  const fetcher = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json(String(input).endsWith("identity") ? { host: null, legacy: true } : { host: "mac", token: JSON.parse(String(init?.body)).token });
  }) as unknown as typeof fetch;
  const registered = await machineChannelToken({ cloud: { url: "http://fixture" }, server: { token: "legacy" }, host: { name: "mac" } }, fetcher);
  expect(registered).toMatch(/^[a-f0-9]{64}$/);
  expect(readHubToml().cloud.machine_token).toBe(registered); expect(calls).toHaveLength(2); expect(calls[0]!.auth).toBe("Bearer legacy");
  const wrongHost = (async () => Response.json({ host: "linux", legacy: false })) as unknown as typeof fetch;
  expect(await machineChannelToken({ cloud: { url: "http://fixture" }, server: { token }, host: { name: "mac" } }, wrongHost)).toBeNull();
});


test("an interrupted registration retries the same pre-saved credential", async () => {
  const cfg = { cloud: { url: "http://fixture", machine_token: undefined as string | undefined }, server: { token: "legacy" }, host: { name: "mac" } };
  const proposed: string[] = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    if (String(input).endsWith("identity")) return new Headers(init?.headers).get("authorization") === "Bearer legacy" ? Response.json({ host: null, legacy: true }) : Response.json({}, { status: 401 });
    const body = JSON.parse(String(init?.body)); proposed.push(body.token);
    if (proposed.length === 1) throw new Error("response lost");
    return Response.json({ host: "mac", token: body.token });
  }) as unknown as typeof fetch;
  expect(await machineChannelToken(cfg, fetcher)).toBeNull();
  expect(readHubToml().cloud.machine_token).toBe(proposed[0]);
  expect(await machineChannelToken(cfg, fetcher)).toBe(proposed[0]);
  expect(proposed[1]).toBe(proposed[0]); expect(cfg.server.token).toBe("legacy");
});


test("failed channel credential replacement preserves the existing bootstrap file", () => {
  writeHubToml({ server: { token: "fixture-existing-credential" } });
  const file = hubTomlPath(), before = fs.readFileSync(file, "utf8"), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === file) throw new Error("fixture rename failure"); return rename(from, to); });
  try {
    expect(() => writeHubToml({ cloud: { machine_token: "c".repeat(64) } })).toThrow("rename failure");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  } finally { patch.mockRestore(); }
});


test("the bridge retries a claimed result even after it leaves the pending inbox", async () => {
  let claims = 0, uploads = 0, inboxReads = 0;
  const token = "e".repeat(64);
  const patch = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("identity")) return Response.json({ host: "mac", legacy: false });
    if (path.endsWith("machine-state")) return Response.json({ ok: true });
    if (path.endsWith("machine-inbox")) { inboxReads++; return Response.json({ items: inboxReads === 1 ? [{ id }] : [] }); }
    if (init?.method === "POST") { claims++; return Response.json({ job: { method: "GET", path: "/api/machines/other/accounts" } }); }
    uploads++; return uploads === 1 ? Response.json({ error: "temporary" }, { status: 503 }) : Response.json({ ok: true });
  }) as unknown as typeof fetch);
  const stop = startMachineBridge({ cloud: { url: "http://fixture", machine_token: token, poll_seconds: 1 }, server: { token }, host: { name: "mac" } });
  try {
    const end = Date.now() + 5000;
    while (uploads < 2 && Date.now() < end) await Bun.sleep(10);
    expect(uploads).toBe(2); expect(claims).toBe(1);
  } finally { stop(); patch.mockRestore(); }
});

test("a bridge preserves its account channel when an older Hub rejects project capability", async () => {
  const states: unknown[] = [];
  let inboxReads = 0, uploads = 0;
  const token = "f".repeat(64);
  const patch = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("identity")) return Response.json({ host: "mac", legacy: false });
    if (path.endsWith("machine-state")) {
      const state = JSON.parse(String(init?.body)); states.push(state);
      return state.project_api ? Response.json({ error: "invalid machine state" }, { status: 400 }) : Response.json({ ok: true });
    }
    if (path.endsWith("machine-inbox")) { inboxReads++; return Response.json({ items: inboxReads === 1 ? [{ id }] : [] }); }
    if (init?.method === "POST") return Response.json({ job: { method: "GET", path: "/api/machines/other/accounts" } });
    uploads++; return Response.json({ ok: true });
  }) as unknown as typeof fetch);
  const stop = startMachineBridge({ cloud: { url: "http://fixture", machine_token: token }, server: { token }, host: { name: "mac" } }, { taskReady: () => true });
  try {
    const end = Date.now() + 3000;
    while (!uploads && Date.now() < end) await Bun.sleep(10);
    expect(states).toEqual([{ account_api: 1, project_api: 1, task_api: 2, learning_api: 1 }, { account_api: 1, project_api: 1, task_api: 2 }, { account_api: 1, project_api: 1 }, { account_api: 1 }]);
    expect(uploads).toBe(1);
  } finally { stop(); patch.mockRestore(); }
});

const taskControl: TaskControl = { host: "mac", id: "T-0099", run_id: "12345678-1234-4234-8234-123456789abc", done: false };
const delegateConfig = { cloud: { url: "http://fixture" }, server: { token: "primary-fixture" } };

test("task stop upload retries preserve the exact run result without repeating the operation", async () => {
  let runs = 0, claims = 0, fail = true;
  const cache = new Map(), uploads: unknown[] = [], body = { id: taskControl.id, run_id: taskControl.run_id, done: false };
  const send = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { claims++; return { job: { method: "POST", path: "/api/machines/mac/task-control", body } }; }
    uploads.push(JSON.parse(String(init?.body))); return fail ? null : { ok: true };
  };
  const route = async (req: Request) => { runs++; expect(await req.json()).toEqual(body); return Response.json({ ok: true, id: body.id, run_id: body.run_id, result: "cancelled" }); };
  await expect(applyMachineRequest(id, "mac", send, route, cache)).rejects.toThrow("confirm");
  fail = false; await applyMachineRequest(id, "mac", send, route, cache);
  expect(runs).toBe(1); expect(claims).toBe(1); expect(uploads[1]).toEqual(uploads[0]);
  let failed: any;
  await applyMachineRequest(id, "mac", async (_path, init) => init?.method === "POST" ? { job: { method: "POST", path: "/api/machines/mac/task-control", body } } : (failed = JSON.parse(String(init?.body)), { ok: true }),
    async () => { throw new Error("private-path-and-token"); }, new Map());
  expect(failed).toMatchObject({ status: 500, data: { ok: false, id: body.id, run_id: body.run_id, uncertain: true } });
  expect(JSON.stringify(failed)).not.toContain("private-path-and-token");
});

test("primary delegation recovers a lost POST reply by polling the same deterministic run command", async () => {
  const ticket = await taskControlTicket(taskControl), paths: string[] = [];
  let starts = 0, polls = 0, clock = 0;
  const success = { ok: true, id: taskControl.id, run_id: taskControl.run_id, result: "cancelled" };
  const fetcher = (async (input: any, init?: RequestInit) => {
    paths.push(new URL(String(input)).pathname);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer primary-fixture");
    if (init?.method === "POST") { starts++; expect(JSON.parse(String(init.body))).toEqual(taskControl); throw new Error("POST reply lost after enqueue"); }
    polls++; return polls === 1 ? Response.json({ ticket }, { status: 202 }) : Response.json(success, { headers: { "X-Noop-Confirmed": "1" } });
  }) as unknown as typeof fetch;
  expect(await delegateTaskControl(delegateConfig, taskControl, { fetch: fetcher, now: () => clock, sleep: async (ms) => { clock += ms; } })).toEqual({ status: 200, data: success });
  expect(starts).toBe(1); expect(polls).toBe(2); expect(paths.slice(1)).toEqual([`/api/host/task-controls/${ticket}`, `/api/host/task-controls/${ticket}`]);
});

test("primary delegation safely retries a POST that never arrived and preserves confirmed partial failure", async () => {
  const ticket = await taskControlTicket(taskControl), partial = { ok: false, id: taskControl.id, run_id: taskControl.run_id, saved_locally: true, error: "Stopped, but sync was not confirmed" };
  let starts = 0, polls = 0, clock = 0;
  const fetcher = (async (_input: any, init?: RequestInit) => {
    if (init?.method === "POST") { starts++; if (starts === 1) throw new Error("not sent"); return Response.json({ ticket }, { status: 202 }); }
    polls++;
    if (polls === 1) return Response.json({ error: "missing command" }, { status: 404 });
    if (polls === 2) return Response.json({ error: "temporary proxy failure" }, { status: 503 });
    return Response.json(partial, { status: 503, headers: { "X-Noop-Confirmed": "1" } });
  }) as unknown as typeof fetch;
  expect(await delegateTaskControl(delegateConfig, taskControl, { fetch: fetcher, now: () => clock, sleep: async (ms) => { clock += ms; } })).toEqual({ status: 503, data: partial });
  expect(starts).toBe(2); expect(polls).toBe(3);
});

test("primary delegation never reports a different run or outcome as success and has a bounded uncertain timeout", async () => {
  for (const data of [{ ok: true, id: taskControl.id, run_id: crypto.randomUUID(), result: "cancelled" }, { ok: true, id: taskControl.id, run_id: taskControl.run_id, result: "done" }]) {
    const result = await delegateTaskControl(delegateConfig, taskControl, { fetch: (async () => Response.json(data)) as unknown as typeof fetch });
    expect(result.status).toBe(502); expect(result.data).toMatchObject({ ok: false, id: taskControl.id, run_id: taskControl.run_id, uncertain: true });
  }
  const denied = await delegateTaskControl(delegateConfig, taskControl, { fetch: (async () => Response.json({ error: "Update the claiming machine" }, { status: 409 })) as unknown as typeof fetch });
  expect(denied).toEqual({ status: 409, data: { ok: false, id: taskControl.id, run_id: taskControl.run_id, error: "Update the claiming machine" } });
  let clock = 0;
  const result = await delegateTaskControl(delegateConfig, taskControl, { fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, now: () => clock, sleep: async (ms) => { clock += ms; } });
  expect(clock).toBe(150_000); expect(result.status).toBe(503); expect(result.data).toMatchObject({ ok: false, id: taskControl.id, run_id: taskControl.run_id, uncertain: true, retryable: true });
});

test("a task-ready bridge falls back to project and account capabilities on an older Hub", async () => {
  const states: unknown[] = [];
  let inboxReads = 0;
  const token = "c".repeat(64);
  const patch = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("identity")) return Response.json({ host: "mac", legacy: false });
    if (path.endsWith("machine-state")) {
      const state = JSON.parse(String(init?.body)); states.push(state);
      return state.task_api ? Response.json({ error: "unsupported task capability" }, { status: 400 }) : Response.json({ ok: true });
    }
    inboxReads++; return Response.json({ items: [] });
  }) as unknown as typeof fetch);
  const stop = startMachineBridge({ cloud: { url: "http://fixture", machine_token: token }, server: { token }, host: { name: "mac" } }, { taskReady: () => true });
  try {
    const end = Date.now() + 3000;
    while (!inboxReads && Date.now() < end) await Bun.sleep(10);
    expect(states).toEqual([{ account_api: 1, project_api: 1, task_api: 2, learning_api: 1 }, { account_api: 1, project_api: 1, task_api: 2 }, { account_api: 1, project_api: 1 }]);
  } finally { stop(); patch.mockRestore(); }
});


test("learning commands target one host and retry a lost result upload without recollecting", async () => {
  const body = { request_id: "12345678-1234-4234-8234-123456789abc", preview_digest: "a".repeat(64) };
  const data = { host: "mac", ...body, id: "T-mac-0001", turns: 1, sessions: 1, truncated: false, applied: true, replayed: false };
  const results = new Map(), uploads: unknown[] = [];
  let runs = 0, claims = 0, fail = true;
  const send = async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") { claims++; return { job: { method: "POST", path: "/api/machines/mac/learning/run", body } }; }
    uploads.push(JSON.parse(String(init?.body))); return fail ? null : { ok: true };
  };
  const route = async (req: Request) => { runs++; expect(await req.json()).toEqual(body); return Response.json(data); };
  await expect(applyMachineRequest(id, "mac", send, route, results)).rejects.toThrow("confirm");
  fail = false; await applyMachineRequest(id, "mac", send, route, results);
  expect(runs).toBe(1); expect(claims).toBe(1); expect(uploads).toEqual([{ status: 200, data }, { status: 200, data }]);
  let rejected: any;
  await applyMachineRequest(id, "mac", async (_path, init) => init?.method === "POST" ? { job: { method: "GET", path: "/api/machines/linux/learning" } } : (rejected = JSON.parse(String(init?.body)), { ok: true }),
    async () => { throw new Error("must not reach another host"); }, new Map());
  expect(rejected).toEqual({ status: 400, data: { error: "Invalid command for this machine" } });
});

test("rejecting only learning capability retains task, project and account channels", async () => {
  const states: unknown[] = [];
  let inboxReads = 0;
  const token = "d".repeat(64);
  const patch = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("identity")) return Response.json({ host: "mac", legacy: false });
    if (path.endsWith("machine-state")) {
      const state = JSON.parse(String(init?.body)); states.push(state);
      return state.learning_api ? Response.json({ error: "unsupported learning capability" }, { status: 400 }) : Response.json({ ok: true });
    }
    inboxReads++; return Response.json({ items: [] });
  }) as unknown as typeof fetch);
  const stop = startMachineBridge({ cloud: { url: "http://fixture", machine_token: token }, server: { token }, host: { name: "mac" } }, { taskReady: () => true });
  try {
    const end = Date.now() + 3000;
    while (!inboxReads && Date.now() < end) await Bun.sleep(10);
    expect(states).toEqual([{ account_api: 1, project_api: 1, task_api: 2, learning_api: 1 }, { account_api: 1, project_api: 1, task_api: 2 }]);
  } finally { await stop(); patch.mockRestore(); }
});
