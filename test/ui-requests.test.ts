import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initUiRequests, recordPath, uiRequestRoute, type UiResult } from "../cloud/src/ui-requests";
import { applyUiRequest } from "../src/ui-requests";
import { initMachineRequests, machineRequestRoute, mintMachineToken, type MachineActor } from "../cloud/src/machine-requests";

function sqlite(db: Database) {
  return { exec(query: string, ...bindings: any[]) {
    let rows: any[] = [];
    for (const part of query.split(";").map((s) => s.trim()).filter(Boolean)) {
      const stmt = db.query(part);
      if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings);
    }
    return { toArray: () => rows };
  } };
}
function hub() {
  const sql = sqlite(new Database(":memory:"));
  initUiRequests(sql); initMachineRequests(sql);
  const inbox: Record<string, unknown>[] = [];
  const host = { online: () => true, supported: () => true, enqueue: (item: Record<string, unknown>) => inbox.push(item) };
  const request = (path: string, method = "GET", body?: unknown, who: "machine" | { session: string } = { session: "owner" }, headers?: RequestInit["headers"]) =>
    uiRequestRoute(sql, new Request(`https://hub${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), who, host);
  const send = async (path: string, init: RequestInit) => {
    const r = await uiRequestRoute(sql, new Request(`https://hub${path}`, init), "machine", host);
    return r?.ok ? r.json() : null;
  };
  const submit = async (path: string, method = "POST", body: unknown = {}) => {
    const r = (await request(path, method, body))!;
    expect(r.status).toBe(202);
    return (await r.json() as { ticket: string }).ticket;
  };
  const machine = (path: string, method = "GET", body?: unknown, actor: MachineActor = { session: "owner" }) => machineRequestRoute(sql,
    new Request(`https://hub${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), actor);
  return { sql, host, inbox, request, send, submit, machine };
}

async function checkedFolder(h: ReturnType<typeof hub>) {
  await mintMachineToken(h.sql, "worker");
  await h.machine("/api/host/machine-state", "PUT", { account_api: 1, project_api: 1 }, { host: "worker" });
  const start = (await h.machine("/api/machines/worker/project-folder-check", "POST", { path: "~/work" }))!;
  const id = (await start.json() as any).ticket, claim = `/api/host/machine-requests/${id}`;
  await h.machine(claim, "POST", undefined, { host: "worker" });
  const data = { host: "worker", requested_path: "~/work", path: "/worker/home/work", repo: "acme/work", requires: ["cli:cargo"], checked: new Date().toISOString() };
  expect((await h.machine(claim, "PUT", { status: 200, data }, { host: "worker" }))!.status).toBe(200);
  return { id, data, body: { name: "Work", host: "worker", path: "~/work", instructions: "Keep changes focused", probe_ticket: id } };
}

test("remote form routes are restricted to team records and known plan actions", () => {
  for (const path of ["/api/members/lead", "/api/projects/site", "/api/routines/pr-review", "/api/plans/PL-M12/approve", "/api/tasks/configure", "/api/configuration", "/api/documents", "/api/settings", "/api/machines/mac/configuration"])
    expect(recordPath(path)).not.toBeNull();
  for (const path of ["/api/unknown", "/api/members/../config", "/api/members/a%2fb", "/api/plans/PL-12/shell", "https://evil/api/members"])
    expect(recordPath(path)).toBeNull();
});

test("remote tool policy validation rejects unsupported commands and conflicting choices before enqueue", async () => {
  const h = hub();
  for (const body of [null, [], { clis: null }, { clis: { preference: "claude" } }, { clis: { preference: ["claude", "claude"] } },
    { clis: { agents: { lead: ["unknown"] } } }, { clis: { claude: { command: ["sh"] } } }, { clis: { preference: null, reset: ["preference"] } },
    { clis: { reset: ["agents.constructor"] } }, { clis: { reset: [] } }, { clis: { preference: null } }, { clis: { preference: ["claude"] } },
    { clis: {}, tool_policy_version: 2 }, { clis: {}, tool_policy_version: "1" }, { tool_policy_version: 1 }])
    expect((await h.request("/api/settings", "PUT", body))!.status).toBe(400);
  expect(h.inbox).toHaveLength(0);
  expect(h.sql.exec("SELECT * FROM ui_requests").toArray()).toHaveLength(0);
  expect((await h.request("/api/settings", "POST", {}))!.status).toBe(405);
});

test("remote tool policy choices and file resets retain their version guard and exact authorization", async () => {
  const h = hub(), body = { tool_policy_version: 1, clis: { preference: ["hermes", "codex"], agents: { lead: null, reporter: [] }, reset: ["agents.writer"] } };
  const ticket = await h.submit("/api/settings", "PUT", body);
  const claimed = await h.send(`/api/host/ui-requests/${ticket}`, { method: "POST" }) as any;
  expect(claimed.job).toEqual({ method: "PUT", path: "/api/settings", body });
  expect((await h.request("/api/settings", "PUT", body, "machine"))!.status).toBe(403);
});

test("remote autonomy validation rejects invalid policies and unsafe resets before creating a ticket", async () => {
  const h = hub();
  for (const body of [{ autonomy: null }, { autonomy: { agents: null } }, { autonomy: { agents: { lead: "trusted" } } },
    { autonomy: { agents: { lead: false } } }, { autonomy: { agents: { constructor: null } } }, { autonomy: { enabled: true } },
    { autonomy: { reset: ["agents.lead"] } }, { autonomy_policy_version: 1 }, { autonomy_policy_version: "1", autonomy: {} },
    { autonomy_policy_version: 2, autonomy: {} }, { autonomy_policy_version: 1, autonomy: { reset: ["level"] } },
    { autonomy_policy_version: 1, autonomy: { agents: { lead: null }, reset: ["agents.lead"] } }])
    expect((await h.request("/api/settings", "PUT", body))!.status).toBe(400);
  expect(h.inbox).toHaveLength(0);
  expect(h.sql.exec("SELECT * FROM ui_requests").toArray()).toHaveLength(0);
  expect(await h.request("/api/settings")).toBeNull();
});

test("remote autonomy inheritance and reset keep their exact versioned request", async () => {
  const h = hub(), body = { autonomy_policy_version: 1, autonomy: { agents: { lead: null, reporter: "onboarding" }, reset: ["agents.writer"] } };
  const ticket = await h.submit("/api/settings", "PUT", body);
  expect((await h.send(`/api/host/ui-requests/${ticket}`, { method: "POST" }) as any).job).toEqual({ method: "PUT", path: "/api/settings", body });
  expect((await h.request("/api/settings", "PUT", body, "machine"))!.status).toBe(403);
});

test("project forms carry only authenticated host/path proof outside the owner's body", async () => {
  const h = hub(), probe = await checkedFolder(h);
  const ticket = await h.submit("/api/projects", "POST", probe.body);
  const claimed = await h.send(`/api/host/ui-requests/${ticket}`, { method: "POST" }) as any;
  expect(claimed.job.body).toEqual(probe.body);
  expect(claimed.job.body.project_folder).toBeUndefined();
  expect(claimed.job.project_folder).toEqual(probe.data);
  // A failed primary sync can retry an edit with the same proof until the proof expires.
  const retry = await h.submit("/api/projects/work", "PUT", probe.body);
  expect((await h.send(`/api/host/ui-requests/${retry}`, { method: "POST" }) as any).job.project_folder).toEqual(probe.data);
});

test("project forms reject forged, wrong-owner, wrong-host, changed-path and stale proofs without enqueue", async () => {
  const h = hub(), probe = await checkedFolder(h), initial = h.inbox.length;
  for (const body of [{ ...probe.body, probe_ticket: crypto.randomUUID() }, { ...probe.body, host: "other" }, { ...probe.body, path: "~/other" }])
    expect((await h.request("/api/projects", "POST", body))!.status).toBe(409);
  expect((await h.request("/api/projects", "POST", probe.body, { session: "someone-else" }))!.status).toBe(409);
  for (const body of [{ ...probe.body, project_folder: probe.data }, { ...probe.body, context: probe.data }])
    expect((await h.request("/api/projects", "POST", body))!.status).toBe(400);
  expect(h.inbox.length).toBe(initial);
  h.sql.exec("UPDATE machine_requests SET expires = ? WHERE id = ?", Date.now() - 1, probe.id);
  expect((await h.request("/api/projects", "POST", probe.body))!.status).toBe(409);
  h.sql.exec("UPDATE machine_requests SET expires = ?, created = 0 WHERE id = ?", Date.now() + 300_000, probe.id);
  expect((await h.request("/api/projects", "POST", probe.body))!.status).toBe(409);
  expect(h.inbox.length).toBe(initial);
});

test("an account ticket can never authorize a project folder", async () => {
  const h = hub();
  await mintMachineToken(h.sql, "worker");
  await h.machine("/api/host/machine-state", "PUT", { account_api: 1, project_api: 1 }, { host: "worker" });
  const first = (await h.machine("/api/machines/worker/accounts"))!, id = (await first.json() as any).ticket;
  await h.machine(`/api/host/machine-requests/${id}`, "POST", undefined, { host: "worker" });
  await h.machine(`/api/host/machine-requests/${id}`, "PUT", { status: 200, data: { host: "worker", providers: [], accounts: [] } }, { host: "worker" });
  expect((await h.request("/api/projects", "POST", { name: "Work", host: "worker", path: "~/work", probe_ticket: id }))!.status).toBe(409);
  expect(h.inbox).toHaveLength(0);
});

test("pending, running and failed folder checks cannot authorize project changes", async () => {
  const h = hub(), probe = await checkedFolder(h);
  for (const state of ["pending", "running"]) {
    h.sql.exec("UPDATE machine_requests SET state = ? WHERE id = ?", state, probe.id);
    expect((await h.request("/api/projects", "POST", probe.body))!.status).toBe(409);
  }
  h.sql.exec("UPDATE machine_requests SET state = 'done', result = ? WHERE id = ?", JSON.stringify({ status: 400, data: { error: "Missing folder" } }), probe.id);
  expect((await h.request("/api/projects", "POST", probe.body))!.status).toBe(409);
  expect(h.inbox).toHaveLength(0);
});

test("remote forms return the primary's real result, including validation errors, and survive reinitialization", async () => {
  const h = hub();
  for (const kind of ["members", "projects", "routines", "plans"]) {
    const id = await h.submit(`/api/${kind}`, "POST", { name: "new", prompt: "work" });
    const poll = `/api/ui-requests/${id}`;
    expect((await h.request(poll))!.status).toBe(202);
    expect(h.inbox.at(-1)).toEqual({ type: "ui-request", id });
    let calls = 0;
    const route = async (req: Request) => {
      calls++;
      expect(new URL(req.url).pathname).toBe(`/api/${kind}`);
      expect(await req.json()).toEqual({ name: "new", prompt: "work" });
      return Response.json({ error: "Choose the member who runs it" }, { status: 400 });
    };
    await applyUiRequest(id, h.send, route, new Map());
    initUiRequests(h.sql); // no in-memory completion state: a restarted Worker reads the same result
    const r = (await h.request(poll))!;
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "Choose the member who runs it" });
    await applyUiRequest(id, h.send, route, new Map());
    expect(calls).toBe(1);
  }
});

test("retrying a lost result upload does not run the form twice", async () => {
  const h = hub(), id = await h.submit("/api/members", "POST", { name: "writer" });
  const results = new Map<string, UiResult>();
  let calls = 0;
  const route = async () => { calls++; return Response.json({ id: "writer", view: { current: {} } }); };
  const failUpload = (path: string, init: RequestInit) => init.method === "PUT" ? Promise.resolve(null) : h.send(path, init);
  await expect(applyUiRequest(id, failUpload, route, results)).rejects.toThrow("confirm");
  expect(results.size).toBe(1);
  await applyUiRequest(id, h.send, route, results);
  expect(calls).toBe(1);
  expect(results.size).toBe(0);
  expect(await (await h.request(`/api/ui-requests/${id}`))!.json()).toEqual({ id: "writer", view: { current: {} } });
});

test("a restarted primary reports uncertainty instead of repeating a partially applied write", async () => {
  const h = hub(), id = await h.submit("/api/projects", "POST", { name: "site" });
  await h.send(`/api/host/ui-requests/${id}`, { method: "POST" });
  let calls = 0;
  await applyUiRequest(id, h.send, async () => { calls++; return Response.json({}); }, new Map());
  expect(calls).toBe(0);
  const r = (await h.request(`/api/ui-requests/${id}`))!;
  expect(r.status).toBe(409);
  expect((await r.json() as any).error).toContain("may already have been applied");
});

test("expired unclaimed requests cannot run later and cannot be completed by the fleet", async () => {
  const h = hub(), id = await h.submit("/api/routines", "POST", { name: "daily" });
  expect((await h.request(`/api/host/ui-requests/${id}`, "PUT", { status: 200, data: {} }, "machine"))!.status).toBe(409);
  h.sql.exec("UPDATE ui_requests SET created = 0 WHERE id = ?", id);
  expect((await h.request(`/api/ui-requests/${id}`))!.status).toBe(408);
  let calls = 0;
  await applyUiRequest(id, h.send, async () => { calls++; return Response.json({}); }, new Map());
  expect(calls).toBe(0);
});

test("family stop confirmations outlive targeted machine deadlines while other forms still expire", async () => {
  for (const path of ["/api/tasks/cancel", "/api/tasks/stops/retry", "/api/plans/PL-0099/cancel", "/api/plans/PL-0099/retry-stops"]) {
    const h = hub(), stop = await h.submit(path, "POST", { id: "T-0099" }), form = await h.submit("/api/routines", "POST", {});
    h.sql.exec("UPDATE ui_requests SET created = ?", Date.now() - 180_000);
    expect((await h.request(`/api/ui-requests/${stop}`))!.status).toBe(202);
    expect((await h.request(`/api/ui-requests/${form}`))!.status).toBe(408);
    expect((await h.send(`/api/host/ui-requests/${stop}`, { method: "POST" }) as any).job.path).toBe(path);
    h.sql.exec("UPDATE ui_requests SET created = ? WHERE id = ?", Date.now() - 301_000, stop);
    expect((await h.request(`/api/ui-requests/${stop}`))!.status).toBe(409);
  }
});

test("stop capability preflight reads the primary through an owner-scoped ticket", async () => {
  const h = hub();
  expect(recordPath("/api/stops/capabilities")).toEqual({ kind: "stop-capabilities" });
  const first = (await h.request("/api/stops/capabilities"))!, id = (await first.json() as any).ticket;
  expect(first.status).toBe(202);
  await applyUiRequest(id, h.send, async (req) => { expect(req.method).toBe("GET"); expect(new URL(req.url).pathname).toBe("/api/stops/capabilities"); return Response.json({ family_stops: 1 }); }, new Map());
  expect(await (await h.request(`/api/ui-requests/${id}`))!.json()).toEqual({ family_stops: 1 });
  expect((await h.request(`/api/ui-requests/${id}`, "GET", undefined, { session: "other" }))!.status).toBe(404);
  expect((await h.request("/api/stops/capabilities", "GET", undefined, "machine"))!.status).toBe(403);
});

test("concurrent task-cancel retries with a lost initial reply execute only the original queued intent", async () => {
  const h = hub(), body = { id: "T-0099", done: false }, headers = { "Idempotency-Key": "cancel-lost-response" };
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => h.request("/api/tasks/cancel", "POST", index % 2 ? { done: false, id: body.id } : body, { session: "owner" }, headers)));
  const tickets = await Promise.all(responses.map(async (response) => { expect(response!.status).toBe(202); return (await response!.json() as any).ticket; }));
  expect(new Set(tickets).size).toBe(1); expect(h.inbox).toHaveLength(1);
  const id = tickets[0]; let calls = 0;
  const route = async (req: Request) => { calls++; expect(await req.json()).toEqual(body); return Response.json({ ok: true, id: body.id, result: "cancelled" }); };
  await applyUiRequest(id, h.send, route, new Map());
  // A later task run must never turn an old id-only network retry into a new cancellation.
  initUiRequests(h.sql); h.host.online = () => false; h.host.supported = () => false;
  const replay = (await h.request("/api/tasks/cancel", "POST", body, { session: "owner" }, headers))!;
  expect(replay.status).toBe(202); expect(await replay.json()).toEqual({ ticket: id });
  await applyUiRequest(id, h.send, route, new Map());
  expect(calls).toBe(1); expect(h.inbox).toHaveLength(1);
  expect(await (await h.request(`/api/ui-requests/${id}`))!.json()).toEqual({ ok: true, id: body.id, result: "cancelled" });
});

test("task-cancel keys reject changed payloads, remain owner-scoped and leave legacy forms unchanged", async () => {
  const h = hub(), headers = { "Idempotency-Key": "cancel-owner-scoped" }, body = { id: "T-0099" };
  const first = (await h.request("/api/tasks/cancel", "POST", body, { session: "owner" }, headers))!;
  const id = (await first.json() as any).ticket;
  for (const changed of [{ id: "T-0100" }, { ...body, done: true }, { ...body, host: "worker", run_id: crypto.randomUUID() }])
    expect((await h.request("/api/tasks/cancel", "POST", changed, { session: "owner" }, headers))!.status).toBe(409);
  const another = (await h.request("/api/tasks/cancel", "POST", body, { session: "other-owner" }, headers))!;
  expect(another.status).toBe(202); expect((await another.json() as any).ticket).not.toBe(id);
  expect((await h.request("/api/tasks/cancel", "POST", body, "machine", headers))!.status).toBe(403);
  for (const key of ["", "short", "with a space", "x".repeat(129), "invalid/key"])
    expect((await h.request("/api/tasks/cancel", "POST", body, { session: "owner" }, { "Idempotency-Key": key }))!.status).toBe(400);
  expect(h.inbox).toHaveLength(2);
  const oldA = await h.submit("/api/tasks/cancel", "POST", body), oldB = await h.submit("/api/tasks/cancel", "POST", body);
  expect(oldA).not.toBe(oldB);
  for (let n = 0; n < 2; n++) expect((await h.request("/api/routines", "POST", { name: "daily" }, { session: "owner" }, headers))!.status).toBe(202);
  expect(h.inbox).toHaveLength(6);
  const rows = h.sql.exec("SELECT request_key FROM ui_requests WHERE request_key IS NOT NULL").toArray();
  expect(rows).toHaveLength(2); expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.request_key))).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(headers["Idempotency-Key"]);
  h.sql.exec("UPDATE ui_requests SET created = 0 WHERE id = ?", id);
  const renewed = (await h.request("/api/tasks/cancel", "POST", body, { session: "owner" }, headers))!;
  expect(renewed.status).toBe(202); expect((await renewed.json() as any).ticket).not.toBe(id);
});

test("task-cancel key migration preserves old jobs and deduplication survives a SQLite reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "noop-ui-keys-")), file = join(folder, "worker.sqlite");
  let db = new Database(file), sql = sqlite(db);
  const legacyJob = JSON.stringify({ method: "POST", path: "/api/routines", body: { name: "existing" } });
  sql.exec("CREATE TABLE ui_requests (id TEXT PRIMARY KEY, session TEXT, created INTEGER, state TEXT, job TEXT, result TEXT)");
  sql.exec("INSERT INTO ui_requests (id,session,created,state,job) VALUES ('legacy','owner',?,'pending',?)", Date.now(), legacyJob);
  initUiRequests(sql); initUiRequests(sql);
  expect(sql.exec("SELECT id,job,request_key FROM ui_requests WHERE id = 'legacy'").toArray()).toEqual([{ id: "legacy", job: legacyJob, request_key: null }]);
  const inbox: unknown[] = [], host = { online: () => true, supported: () => true, enqueue: (item: unknown) => inbox.push(item) };
  const request = () => new Request("https://hub/api/tasks/cancel", { method: "POST", headers: { "Idempotency-Key": "cancel-restart-safe" }, body: JSON.stringify({ id: "T-0099" }) });
  try {
    const first = (await uiRequestRoute(sql, request(), { session: "owner" }, host))!, result = await first.json();
    expect(first.status).toBe(202); db.close();
    db = new Database(file); sql = sqlite(db); initUiRequests(sql);
    const replay = (await uiRequestRoute(sql, request(), { session: "owner" }, host))!;
    expect(replay.status).toBe(202); expect(await replay.json()).toEqual(result); expect(inbox).toHaveLength(1);
    expect(sql.exec("SELECT id FROM ui_requests").toArray()).toHaveLength(2);
  } finally { db.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("remote request authorization, offline detection and runtime compatibility", async () => {
  const h = hub();
  expect((await h.request("/api/routines", "POST", {}, "machine"))!.status).toBe(403);
  h.host.online = () => false;
  expect((await h.request("/api/routines", "POST", {}))!.status).toBe(503);
  h.host.online = () => true; h.host.supported = () => false;
  expect((await h.request("/api/routines", "POST", {}))!.status).toBe(409);
  expect(h.inbox).toHaveLength(0);
  h.host.supported = () => true;
  const id = await h.submit("/api/routines");
  expect((await h.request(`/api/ui-requests/${id}`, "GET", undefined, { session: "someone-else" }))!.status).toBe(404);
  expect((await h.request(`/api/ui-requests/${id}`, "GET", undefined, "machine"))!.status).toBe(403);
  expect((await h.request(`/api/host/ui-requests/${id}`, "POST"))!.status).toBe(403);
  expect((await h.request(`/api/host/ui-requests/${id}`, "PUT", { status: 200, data: {} }))!.status).toBe(403);
  expect(await h.request("/api/settings")).toBeNull();
});


test("an inbox item whose result was pruned cannot block newer requests", async () => {
  const h = hub(), id = await h.submit("/api/routines");
  h.sql.exec("DELETE FROM ui_requests WHERE id = ?", id);
  let calls = 0;
  await applyUiRequest(id, h.send, async () => { calls++; return Response.json({}); }, new Map());
  expect(calls).toBe(0);
  const results = new Map<string, UiResult>([[id, { status: 200, data: { id: "old" } }]]);
  await applyUiRequest(id, h.send, async () => Response.json({}), results);
  expect(results.size).toBe(0);
});
