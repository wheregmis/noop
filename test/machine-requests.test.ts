import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { identifyMachine, initMachineRequests, encodeAccountSegment, machineAccountPath, machineProjectPath, machineTaskPath, printableAccountName, machineRequestRoute, mintMachineToken, nextMachineRequestExpiry, pruneMachineRequests, taskControlTicket, validRunId, type MachineActor, type TaskControl } from "../cloud/src/machine-requests";

async function hub() {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...bindings: any[]) {
    let rows: any[] = [];
    for (const part of query.split(";").map((q) => q.trim()).filter(Boolean)) {
      const stmt = db.query(part); if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings);
    }
    return { toArray: () => rows };
  } };
  initMachineRequests(sql);
  const mac = (await mintMachineToken(sql, "mac"))!, linux = (await mintMachineToken(sql, "linux"))!;
  const request = (path: string, method = "GET", body?: unknown, actor: MachineActor = { session: "owner" }) => machineRequestRoute(sql,
    new Request(`https://hub${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), actor);
  const ready = async (host: string) => { expect((await request("/api/host/machine-state", "PUT", { account_api: 1 }, { host }))!.status).toBe(200); };
  const submit = async (path = "/api/machines/mac/accounts", method = "GET", body?: unknown) => {
    const r = (await request(path, method, body))!; expect(r.status).toBe(202);
    return (await r.json() as { ticket: string }).ticket;
  };
  await ready("mac"); await ready("linux");
  return { sql, request, submit, ready, mac, linux };
}

test("account route whitelist rejects traversal, unknown providers and arbitrary actions", () => {
  expect(machineAccountPath("/api/machines/mac/accounts")).toEqual({ host: "mac" });
  expect(machineAccountPath("/api/machines/mac/accounts/claude/work/code")).toEqual({ host: "mac", cli: "claude", name: "work", action: "code" });
  for (const path of ["/api/machines/../accounts", "/api/machines/constructor/accounts", "/api/machines/mac/accounts/shell/work", "/api/machines/mac/accounts/claude/..", "/api/machines/mac/accounts/claude/%2f", "/api/machines/mac/accounts/claude/work/run", "/api/machines/mac/accounts/claude/work/login/extra"])
    expect(machineAccountPath(path)).toBeNull();
});

test("machine credentials are hashed, uniquely bound and rotated only explicitly", async () => {
  const h = await hub();
  expect(h.mac.token).not.toBe(h.linux.token);
  expect(await identifyMachine(h.sql, h.mac.token)).toEqual({ host: "mac" });
  expect(JSON.stringify(h.sql.exec("SELECT * FROM machine_credentials").toArray())).not.toContain(h.mac.token);
  expect(await mintMachineToken(h.sql, "mac")).toBeNull();
  const pending = await h.submit();
  const replacement = (await mintMachineToken(h.sql, "mac", true))!;
  expect(await identifyMachine(h.sql, h.mac.token)).toBeNull();
  expect(await identifyMachine(h.sql, replacement.token)).toEqual({ host: "mac" });
  expect(h.sql.exec("SELECT id FROM machine_requests WHERE id = ?", pending).toArray()).toHaveLength(0);
  expect((await h.request("/api/machines/mac/accounts"))!.status).toBe(409);
});

test("a client-proposed registration token recovers lost replies without rotating another binding", async () => {
  const h = await hub(), proposed = "a".repeat(64), other = "b".repeat(64);
  expect(await mintMachineToken(h.sql, "reliable", false, proposed)).toEqual({ host: "reliable", token: proposed });
  await h.ready("reliable");
  expect(await mintMachineToken(h.sql, "reliable", false, proposed)).toEqual({ host: "reliable", token: proposed });
  expect(h.sql.exec("SELECT account_api FROM machine_credentials WHERE host = 'reliable'").toArray()[0].account_api).toBe(1);
  expect(await mintMachineToken(h.sql, "reliable", false, other)).toBeNull();
  expect(await mintMachineToken(h.sql, "another-host", false, proposed)).toBeNull();
  expect(await identifyMachine(h.sql, proposed)).toEqual({ host: "reliable" });
  expect(await identifyMachine(h.sql, other)).toBeNull();
});

test("only the targeted machine receives a command and only its owner session sees the result", async () => {
  const h = await hub(), id = await h.submit(), poll = `/api/machine-requests/${id}`, claim = `/api/host/machine-requests/${id}`;
  expect(await (await h.request("/api/host/machine-inbox", "GET", undefined, { host: "mac" }))!.json()).toEqual({ items: [{ id }] });
  expect(await (await h.request("/api/host/machine-inbox", "GET", undefined, { host: "linux" }))!.json()).toEqual({ items: [] });
  for (const actor of ["legacy", { session: "owner" }] as MachineActor[]) expect((await h.request(claim, "POST", undefined, actor))!.status).toBe(403);
  expect((await h.request(claim, "POST", undefined, { host: "linux" }))!.status).toBe(404);
  expect((await h.request(poll, "GET", undefined, { session: "another-owner-session" }))!.status).toBe(404);
  expect((await h.request(poll, "GET", undefined, { host: "mac" }))!.status).toBe(403);
  const result = { status: 200, data: { host: "mac", providers: [], accounts: [] } };
  expect((await h.request(claim, "PUT", result, { host: "mac" }))!.status).toBe(409);
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toEqual({ job: { method: "GET", path: "/api/machines/mac/accounts" } });
  expect(h.sql.exec("SELECT job FROM machine_requests WHERE id = ?", id).toArray()[0].job).toBeNull();
  expect((await h.request(claim, "PUT", result, { host: "linux" }))!.status).toBe(404);
  expect((await h.request(claim, "PUT", result, { host: "mac" }))!.status).toBe(200);
  const confirmed = (await h.request(poll))!;
  expect(confirmed.headers.get("X-Noop-Confirmed")).toBe("1"); expect(await confirmed.json()).toEqual(result.data);
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toEqual({ done: true });
});

test("login codes are cleared at claim and timeout, and results expire within five minutes", async () => {
  const h = await hub(), secret = "test-only-sensitive-code";
  const id = await h.submit("/api/machines/mac/accounts/claude/work/code", "POST", { id: "L-0001", code: secret });
  expect(h.sql.exec("SELECT job FROM machine_requests WHERE id = ?", id).toArray()[0].job).toContain(secret);
  const claim = `/api/host/machine-requests/${id}`;
  expect((await h.request(claim, "POST", undefined, { host: "mac" }))!.status).toBe(200);
  expect(JSON.stringify(h.sql.exec("SELECT * FROM machine_requests WHERE id = ?", id).toArray())).not.toContain(secret);
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toEqual({ done: true });
  expect((await h.request(`/api/machine-requests/${id}`))!.status).toBe(409);
  const other = await h.submit("/api/machines/mac/accounts/claude/work/code", "POST", { id: "L-0002", code: secret });
  const expires = h.sql.exec("SELECT expires FROM machine_requests WHERE id = ?", other).toArray()[0].expires;
  pruneMachineRequests(h.sql, expires);
  expect(JSON.stringify(h.sql.exec("SELECT * FROM machine_requests WHERE id = ?", other).toArray())).not.toContain(secret);
  expect((await h.request(`/api/machine-requests/${other}`))!.status).toBe(408);
  pruneMachineRequests(h.sql, expires + 300_000);
  expect(h.sql.exec("SELECT * FROM machine_requests").toArray()).toHaveLength(0);
  expect(nextMachineRequestExpiry(h.sql)).toBeNull();
});

test("forms validate supported metadata and reject arbitrary credentials or paths", async () => {
  const h = await hub();
  for (const body of [{ cli: "shell", name: "work" }, { cli: "claude", name: "../work" }, { cli: "claude", name: "work", dir: "/private" }, { cli: "claude", name: "work", token: "secret" }, { cli: ["claude"], name: "work" }, []])
    expect((await h.request("/api/machines/mac/accounts", "POST", body))!.status).toBe(400);
  expect((await h.request("/api/machines/mac/accounts", "POST", { cli: "codex", name: "default" }))!.status).toBe(202);
  for (const body of [{ id: "L-0001", code: "" }, { id: "L-0001", code: "x\ny" }, { id: "L-0001", code: "x", extra: true }, { id: "../secret", code: "x" }])
    expect((await h.request("/api/machines/mac/accounts/claude/work/code", "POST", body))!.status).toBe(400);
  expect((await h.request("/api/machines/mac/accounts/claude/work/login", "POST", { command: "anything" }))!.status).toBe(400);
  expect((await h.request("/api/host/machine-state", "PUT", { account_api: 1, host: "linux" }, { host: "mac" }))!.status).toBe(400);
  for (const path of ["/api/host/machine-inbox", "/api/host/machine-state", "/api/machines/mac/accounts"])
    expect((await h.request(path, path.endsWith("state") ? "PUT" : "GET", undefined, "legacy"))!.status).toBe(403);
});

test("offline or outdated machines cannot accept requests and one host cannot exhaust an unbounded inbox", async () => {
  const h = await hub();
  expect((await h.request("/api/machines/unknown/accounts"))!.status).toBe(409);
  h.sql.exec("UPDATE machine_credentials SET seen = 0 WHERE host = 'mac'");
  expect((await h.request("/api/machines/mac/accounts"))!.status).toBe(503);
  await h.ready("mac");
  for (let i = 0; i < 20; i++) await h.submit();
  expect((await h.request("/api/machines/mac/accounts"))!.status).toBe(429);
});

test("result uploads whitelist safe account summaries and provider sign-in links", async () => {
  const h = await hub(), id = await h.submit(), path = `/api/host/machine-requests/${id}`;
  await h.request(path, "POST", undefined, { host: "mac" });
  const login = { id: "L-0001", needs_code: true, expires: new Date(Date.now() + 30_000).toISOString(), status: "waiting", url: "https://claude.ai/oauth/authorize?state=test-only-state" };
  const account = { cli: "claude", name: "work", default: false, state: "login", login };
  const data = { host: "mac", providers: [], accounts: [account] };
  for (const unsafe of [{ ...data, token: "raw-secret" }, { ...data, host: "linux" }, { ...data, accounts: [{ ...account, dir: "/private" }] },
    { ...data, accounts: [{ ...account, login: { ...login, token: "raw-secret" } }] }, { ...data, accounts: [{ ...account, login: { ...login, url: "https://evil.example/auth" } }] },
    { ...data, accounts: [{ ...account, login: { ...login, url: "https://claude.ai/oauth?access_token=raw-secret" } }] },
    { ...data, accounts: [{ ...account, login: { ...login, status: ["waiting"] } }] }])
    expect((await h.request(path, "PUT", { status: 200, data: unsafe }, { host: "mac" }))!.status).toBe(400);
  expect(JSON.stringify(h.sql.exec("SELECT * FROM machine_requests").toArray())).not.toContain("raw-secret");
  expect((await h.request(path, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(200);
  expect(await (await h.request(`/api/machine-requests/${id}`))!.json()).toEqual(data);
});

test("account reorder and reset forms use targeted PUT and reject malformed selections before enqueue", async () => {
  const h = await hub();
  for (const body of [{ cli: "claude", names: ["work", "default"] }, { cli: "codex", names: null }, { cli: "hermes", names: [] }]) {
    const id = await h.submit("/api/machines/mac/accounts", "PUT", body);
    expect(await (await h.request(`/api/host/machine-requests/${id}`, "POST", undefined, { host: "mac" }))!.json())
      .toEqual({ job: { method: "PUT", path: "/api/machines/mac/accounts", body } });
  }
  const count = h.sql.exec("SELECT COUNT(*) AS n FROM machine_requests").toArray()[0].n;
  for (const body of [null, [], {}, { cli: "shell", names: null }, { cli: "claude", names: "work" }, { cli: "claude", names: ["work", "work"] },
    { cli: "claude", names: ["bad\nname"] }, { cli: "claude", names: Array.from({ length: 101 }, (_, n) => `n${n}`) }, { cli: "claude", names: null, token: "private" }])
    expect((await h.request("/api/machines/mac/accounts", "PUT", body))!.status).toBe(400);
  expect(h.sql.exec("SELECT COUNT(*) AS n FROM machine_requests").toArray()[0].n).toBe(count);
  expect((await h.request("/api/machines/mac/accounts/claude/work/login", "PUT", {}))!.status).toBe(405);
  expect((await h.request("/api/machines/mac/accounts", "PUT", { cli: "claude", names: null }, { host: "mac" }))!.status).toBe(403);
});

test("legacy account labels round-trip exactly once through canonical paths and safe cloud views", async () => {
  const h = await hub(), names = ["Work", "Work account", "研究", "team/primary", "%2F", ".", "..", "~Special"];
  for (const name of names) {
    expect(printableAccountName(name)).toBe(true);
    const path = `/api/machines/mac/accounts/claude/${encodeAccountSegment(name)}`;
    expect(machineAccountPath(new URL(`https://hub${path}/login`).pathname)).toEqual({ host: "mac", cli: "claude", name, action: "login" });
    expect((await h.request(path + "/login", "POST", {}))!.status).toBe(202);
    expect((await h.request(path, "DELETE"))!.status).toBe(202);
    expect((await h.request("/api/machines/mac/accounts", "POST", { cli: "claude", name }))!.status).toBe(400);
  }
  expect(machineAccountPath("/api/machines/mac/accounts/claude/%252F")?.name).toBe("%2F");
  for (const path of ["/api/machines/mac/accounts/claude/%00/login", "/api/machines/mac/accounts/claude/%57ork/login", "/api/machines/mac/accounts/claude/~Work/login", "/api/machines/mac/accounts/claude/team/primary/login", "/api/machines/mac/accounts/claude/%2E%2E%2Fescape/login"])
    expect(machineAccountPath(path)).toBeNull();
  for (const name of ["", "a\nb", "x".repeat(201), "a\u0000b", "a\u2028b"]) expect(printableAccountName(name)).toBe(false);
  expect((await h.request("/api/machines/mac/accounts", "PUT", { cli: "claude", names: [...names].reverse() }))!.status).toBe(202);
  const id = await h.submit(), endpoint = `/api/host/machine-requests/${id}`;
  await h.request(endpoint, "POST", undefined, { host: "mac" });
  const data = { host: "mac", providers: [], accounts: names.map((name) => ({ cli: "claude", name, default: false, state: "unknown" })) };
  expect((await h.request(endpoint, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(200);
  expect(await (await h.request(`/api/machine-requests/${id}`))!.json()).toEqual(data);
});

test("project folder checks require their separate capability and reject arbitrary probe forms", async () => {
  const h = await hub(), path = "/api/machines/mac/project-folder-check";
  expect(machineProjectPath(path)).toEqual({ host: "mac" });
  expect(machineProjectPath(path + "/extra")).toBeNull(); expect(machineProjectPath("/api/machines/constructor/project-folder-check")).toBeNull();
  expect((await h.request(path, "POST", { path: "/fixture" }))!.status).toBe(409);
  expect((await h.request("/api/host/machine-state", "PUT", { account_api: 1, project_api: 1 }, { host: "mac" }))!.status).toBe(200);
  for (const body of [null, [], {}, { path: "" }, { path: "a\nb" }, { path: "/fixture", host: "linux" }, { path: "/fixture", command: "anything" }])
    expect((await h.request(path, "POST", body))!.status).toBe(400);
  expect((await h.request(path, "GET"))!.status).toBe(405);
  expect((await h.request(path, "POST", { path: "/fixture" }, { host: "mac" }))!.status).toBe(403);
  expect((await h.request(path, "POST", { path: "/fixture" }, "legacy"))!.status).toBe(403);
  expect((await h.request(path, "POST", { path: "/fixture" }))!.status).toBe(202);
  h.sql.exec("UPDATE machine_credentials SET seen = 0 WHERE host = 'mac'");
  expect((await h.request(path, "POST", { path: "/fixture" }))!.status).toBe(503);
  await h.ready("mac"); // An older daemon reporting account support must not retain stale project support.
  expect((await h.request(path, "POST", { path: "/fixture" }))!.status).toBe(409);
});

test("project results remain bound to their original kind, host and requested path after claim", async () => {
  const h = await hub();
  await h.request("/api/host/machine-state", "PUT", { account_api: 1, project_api: 1 }, { host: "mac" });
  const id = await h.submit("/api/machines/mac/project-folder-check", "POST", { path: "~/fixture" }), claim = `/api/host/machine-requests/${id}`;
  await h.request(claim, "POST", undefined, { host: "mac" });
  const row = h.sql.exec("SELECT job, kind, requested_path FROM machine_requests WHERE id = ?", id).toArray()[0];
  expect(row).toEqual({ job: null, kind: "project-folder-check", requested_path: "~/fixture" });
  const data = { host: "mac", requested_path: "~/fixture", path: "/home/owner/fixture", repo: "acme/fixture", requires: ["cli:cargo"], checked: new Date(0).toISOString() };
  for (const invalid of [{ host: "mac", providers: [], accounts: [] }, { ...data, host: "linux" }, { ...data, requested_path: "~/other" },
    { ...data, path: "relative" }, { ...data, repo: "https://private:credential@github.com/acme/fixture" }, { ...data, repo: "acme/fixture?token=private" },
    { ...data, requires: ["bad capability"] }, { ...data, token: "private" }, { ...data, probe_ticket: id }])
    expect((await h.request(claim, "PUT", { status: 200, data: invalid }, { host: "mac" }))!.status).toBe(400);
  expect((await h.request(claim, "PUT", { status: 200, data }, { host: "linux" }))!.status).toBe(404);
  expect((await h.request(claim, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(200);
  expect(await (await h.request(`/api/machine-requests/${id}`))!.json()).toEqual({ ...data, probe_ticket: id });
  expect(JSON.parse(h.sql.exec("SELECT result FROM machine_requests WHERE id = ?", id).toArray()[0].result).data).toEqual(data);
  const accountId = await h.submit(), accountClaim = `/api/host/machine-requests/${accountId}`;
  await h.request(accountClaim, "POST", undefined, { host: "mac" });
  expect((await h.request(accountClaim, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(400);
});

test("project channel migration preserves existing machine credentials and account requests", () => {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...bindings: any[]) {
    let rows: any[] = [];
    for (const part of query.split(";").map((q) => q.trim()).filter(Boolean)) {
      const stmt = db.query(part); if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings);
    }
    return { toArray: () => rows };
  } };
  sql.exec("CREATE TABLE machine_credentials (host TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, created INTEGER, seen INTEGER NOT NULL DEFAULT 0, account_api INTEGER NOT NULL DEFAULT 0)");
  sql.exec("CREATE TABLE machine_requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, target TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, job TEXT, result TEXT)");
  sql.exec("INSERT INTO machine_credentials (host,hash,created,seen,account_api) VALUES ('mac','fixture-hash',1,2,1)");
  sql.exec("INSERT INTO machine_requests (id,session,target,created,expires,state,job) VALUES ('existing','owner','mac',1,2,'pending','fixture-job')");
  initMachineRequests(sql); initMachineRequests(sql);
  expect(sql.exec("SELECT * FROM machine_credentials").toArray()).toEqual([{ host: "mac", hash: "fixture-hash", created: 1, seen: 2, account_api: 1, project_api: 0, task_api: 0, learning_api: 0 }]);
  expect(sql.exec("SELECT kind,requested_path,job,task_id,run_id,task_done FROM machine_requests").toArray()).toEqual([{ kind: "accounts", requested_path: null, job: "fixture-job", task_id: null, run_id: null, task_done: null }]);
  db.close();
});

const control: TaskControl = { host: "mac", id: "T-0099", run_id: "12345678-1234-4234-8234-123456789abc", done: false };
const taskState = { account_api: 1, project_api: 1, task_api: 2 };

test("single-run workers retain account/project channels but cannot enqueue or claim family stops", async () => {
  const h = await hub(), path = "/api/host/task-controls", legacyState = { ...taskState, task_api: 1 };
  for (const invalid of [0, 3, "2", null])
    expect((await h.request("/api/host/machine-state", "PUT", { ...taskState, task_api: invalid }, { host: "mac" }))!.status).toBe(400);
  expect((await h.request("/api/host/machine-state", "PUT", legacyState, { host: "mac" }))!.status).toBe(200);
  const refused = (await h.request(path, "POST", control, "legacy"))!;
  expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/update.*related work/i) });
  expect(h.sql.exec("SELECT id FROM machine_requests WHERE kind = 'task-control'").toArray()).toHaveLength(0);
  const account = await h.submit(), project = await h.submit("/api/machines/mac/project-folder-check", "POST", { path: "~/fixture" });
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  const id = (await (await h.request(path, "POST", control, "legacy"))!.json() as any).ticket;
  await h.request("/api/host/machine-state", "PUT", legacyState, { host: "mac" });
  expect((await h.request(path, "POST", control, "legacy"))!.status).toBe(409);
  expect(await (await h.request("/api/host/machine-inbox", "GET", undefined, { host: "mac" }))!.json()).toEqual({ items: [{ id: account }, { id: project }] });
  const claim = `/api/host/machine-requests/${id}`;
  expect((await h.request(claim, "POST", undefined, { host: "mac" }))!.status).toBe(409);
  expect(h.sql.exec("SELECT state,job FROM machine_requests WHERE id = ?", id).toArray()[0]).toMatchObject({ state: "pending", job: expect.any(String) });
  expect((await h.request(`/api/host/machine-requests/${account}`, "POST", undefined, { host: "mac" }))!.status).toBe(200);
  expect((await h.request(`/api/host/machine-requests/${project}`, "POST", undefined, { host: "mac" }))!.status).toBe(200);
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  expect(await (await h.request("/api/host/machine-inbox", "GET", undefined, { host: "mac" }))!.json()).toEqual({ items: [{ id }] });
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toMatchObject({ job: { path: "/api/machines/mac/task-control" } });
});

test("legacy single-run receipts cannot confirm a family-aware stop", async () => {
  const h = await hub();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["task-control", control.host, control.id, control.run_id, control.done]))))].map((n) => n.toString(16).padStart(2, "0")).join("");
  const oldId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  const oldSuccess = { status: 200, data: { ok: true, id: control.id, run_id: control.run_id, result: "cancelled" } };
  h.sql.exec("INSERT INTO machine_requests (id,session,target,created,expires,state,result,kind,task_id,run_id,task_done) VALUES (?,?,?,? ,?,'done',?,'task-control',?,?,0)",
    oldId, "primary-task-control", control.host, Date.now(), Date.now() + 300_000, JSON.stringify(oldSuccess), control.id, control.run_id);
  expect((await h.request(`/api/host/task-controls/${oldId}`, "GET", undefined, "legacy"))!.status).toBe(404);
  await h.request("/api/host/machine-state", "PUT", { ...taskState, task_api: 1 }, { host: "mac" });
  expect((await h.request("/api/host/task-controls", "POST", control, "legacy"))!.status).toBe(409);
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  const accepted = (await h.request("/api/host/task-controls", "POST", control, "legacy"))!;
  expect(accepted.status).toBe(202);
  const { ticket } = await accepted.json() as any;
  expect(ticket).toBe(await taskControlTicket(control)); expect(ticket).not.toBe(oldId);
  expect((await h.request(`/api/host/task-controls/${ticket}`, "GET", undefined, "legacy"))!.status).toBe(202);
});

test("only the primary can delegate an exact active run and lost replies reuse its deterministic command", async () => {
  const h = await hub(), path = "/api/host/task-controls";
  expect(machineTaskPath("/api/machines/mac/task-control")).toEqual({ host: "mac" });
  expect(machineTaskPath("/api/machines/constructor/task-control")).toBeNull();
  expect(validRunId(control.run_id)).toBe(true); expect(validRunId("T-0099")).toBe(false);
  for (const actor of [{ session: "owner" }, { host: "mac" }] as MachineActor[]) {
    expect((await h.request(path, "POST", control, actor))!.status).toBe(403);
    expect((await h.request(`${path}/${await taskControlTicket(control)}`, "GET", undefined, actor))!.status).toBe(403);
  }
  expect((await h.request(path, "GET", undefined, "legacy"))!.status).toBe(405);
  for (const invalid of [null, [], {}, { ...control, host: "constructor" }, { ...control, id: "../../T-0099" }, { ...control, run_id: "old-run" }, { ...control, done: "true" }, { ...control, token: "private" }])
    expect((await h.request(path, "POST", invalid, "legacy"))!.status).toBe(400);
  expect((await h.request(path, "POST", control, "legacy"))!.status).toBe(409);
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  h.sql.exec("UPDATE machine_credentials SET seen = 0 WHERE host = 'mac'");
  expect((await h.request(path, "POST", control, "legacy"))!.status).toBe(503);
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  const first = (await h.request(path, "POST", control, "legacy"))!;
  expect(first.status).toBe(202); const id = (await first.json() as any).ticket;
  expect(id).toBe(await taskControlTicket(control));
  initMachineRequests(h.sql);
  h.sql.exec("UPDATE machine_credentials SET seen = 0, task_api = 0 WHERE host = 'mac'");
  expect((await h.request(path, "POST", control, "legacy"))!.status).toBe(409);
  await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  expect(await (await h.request(path, "POST", { done: false, run_id: control.run_id, id: control.id, host: control.host }, "legacy"))!.json()).toEqual({ ticket: id });
  expect(h.sql.exec("SELECT id FROM machine_requests WHERE kind = 'task-control'").toArray()).toHaveLength(1);
  for (const altered of [{ ...control, done: true }, { ...control, host: "linux" }, { ...control, run_id: crypto.randomUUID() }]) expect(await taskControlTicket(altered)).not.toBe(id);
  for (const actor of ["legacy", { session: "owner" }, { host: "mac" }] as MachineActor[])
    expect((await h.request("/api/machines/mac/task-control", "POST", control, actor))!.status).toBe(403);
  expect((await h.request(`/api/machine-requests/${id}`))!.status).toBe(404);
  const accountId = await h.submit("/api/machines/linux/accounts");
  expect((await h.request(`${path}/${accountId}`, "GET", undefined, "legacy"))!.status).toBe(404);
});

test("task command results retain immutable run and outcome binding after claim and preserve partial errors", async () => {
  const h = await hub(); await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  const id = (await (await h.request("/api/host/task-controls", "POST", control, "legacy"))!.json() as any).ticket;
  const claim = `/api/host/machine-requests/${id}`, poll = `/api/host/task-controls/${id}`;
  expect((await h.request(claim, "POST", undefined, { host: "linux" }))!.status).toBe(404);
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toEqual({ job: { method: "POST", path: "/api/machines/mac/task-control", body: { id: control.id, run_id: control.run_id, done: false } } });
  expect(h.sql.exec("SELECT job,kind,task_id,run_id,task_done FROM machine_requests WHERE id = ?", id).toArray()[0])
    .toEqual({ job: null, kind: "task-control", task_id: control.id, run_id: control.run_id, task_done: 0 });
  const success = { ok: true, id: control.id, run_id: control.run_id, result: "cancelled" };
  for (const data of [{ ...success, id: "T-0100" }, { ...success, run_id: crypto.randomUUID() }, { ...success, result: "done" }, { ...success, token: "private" }, { host: "mac", providers: [], accounts: [] }])
    expect((await h.request(claim, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(400);
  const partial = { ok: false, id: control.id, run_id: control.run_id, saved_locally: true, uncertain: true, error: "Stopped here, but task sync was not confirmed" };
  expect((await h.request(claim, "PUT", { status: 503, data: { ...partial, status: 503 } }, { host: "mac" }))!.status).toBe(400);
  expect((await h.request(claim, "PUT", { status: 503, data: partial }, { host: "mac" }))!.status).toBe(200);
  const result = (await h.request(poll, "GET", undefined, "legacy"))!;
  expect(result.status).toBe(503); expect(result.headers.get("X-Noop-Confirmed")).toBe("1"); expect(await result.json()).toEqual(partial);
  const done = { ...control, done: true }, doneId = (await (await h.request("/api/host/task-controls", "POST", done, "legacy"))!.json() as any).ticket;
  await h.request(`/api/host/machine-requests/${doneId}`, "POST", undefined, { host: "mac" });
  expect((await h.request(`/api/host/machine-requests/${doneId}`, "PUT", { status: 200, data: { ...success, result: "done" } }, { host: "mac" }))!.status).toBe(200);
  await h.request("/api/host/machine-state", "PUT", { account_api: 1 }, { host: "mac" });
  expect(await (await h.request("/api/host/task-controls", "POST", done, "legacy"))!.json()).toEqual({ ticket: doneId });
  expect(await (await h.request(`/api/host/task-controls/${doneId}`, "GET", undefined, "legacy"))!.json()).toEqual({ ...success, result: "done" });
});

test("timed-out task controls never execute later and restarted claims report run-specific uncertainty", async () => {
  const h = await hub(); await h.request("/api/host/machine-state", "PUT", taskState, { host: "mac" });
  const submit = async (c: TaskControl) => (await (await h.request("/api/host/task-controls", "POST", c, "legacy"))!.json() as any).ticket;
  const expired = await submit(control);
  h.sql.exec("UPDATE machine_requests SET expires = 0 WHERE id = ?", expired);
  expect(await (await h.request(`/api/host/machine-requests/${expired}`, "POST", undefined, { host: "mac" }))!.json()).toEqual({ done: true });
  const timedOut = (await h.request(`/api/host/task-controls/${expired}`, "GET", undefined, "legacy"))!;
  expect(timedOut.status).toBe(408); expect(await timedOut.json()).toMatchObject({ ok: false, id: control.id, run_id: control.run_id, retryable: true });
  expect(await submit(control)).toBe(expired);
  const next = { ...control, run_id: crypto.randomUUID() }, running = await submit(next), claim = `/api/host/machine-requests/${running}`;
  await h.request(claim, "POST", undefined, { host: "mac" });
  expect(await (await h.request(claim, "POST", undefined, { host: "mac" }))!.json()).toEqual({ done: true });
  const uncertain = (await h.request(`/api/host/task-controls/${running}`, "GET", undefined, "legacy"))!;
  expect(uncertain.status).toBe(409); expect(await uncertain.json()).toMatchObject({ ok: false, id: next.id, run_id: next.run_id, uncertain: true });
  expect(h.sql.exec("SELECT job FROM machine_requests WHERE id IN (?,?)", expired, running).toArray()).toEqual([{ job: null }, { job: null }]);
  const late = { ...control, run_id: crypto.randomUUID() }, lateId = await submit(late), lateClaim = `/api/host/machine-requests/${lateId}`;
  await h.request(lateClaim, "POST", undefined, { host: "mac" });
  h.sql.exec("UPDATE machine_requests SET expires = 0 WHERE id = ?", lateId);
  expect((await h.request(`/api/host/task-controls/${lateId}`, "GET", undefined, "legacy"))!.status).toBe(409);
  expect((await h.request(lateClaim, "PUT", { status: 200, data: { ok: true, id: late.id, run_id: late.run_id, result: "cancelled" } }, { host: "mac" }))!.status).toBe(200);
  expect((await h.request(`/api/host/task-controls/${lateId}`, "GET", undefined, "legacy"))!.status).toBe(409);
});


const learnRequest = { request_id: "12345678-1234-4234-8234-123456789abc", preview_digest: "a".repeat(64) };
const learningState = { account_api: 1, project_api: 1, task_api: 2, learning_api: 1 };

test("learning admission requires its own capability and never substitutes another machine", async () => {
  const h = await hub(), path = "/api/machines/mac/learning";
  expect((await h.request(path))!.status).toBe(409);
  for (const invalid of [0, 2, "1", null]) expect((await h.request("/api/host/machine-state", "PUT", { ...learningState, learning_api: invalid }, { host: "mac" }))!.status).toBe(400);
  await h.request("/api/host/machine-state", "PUT", learningState, { host: "mac" });
  for (const actor of ["legacy", { host: "mac" }] as MachineActor[]) expect((await h.request(path, "GET", undefined, actor))!.status).toBe(403);
  expect((await h.request(path, "POST", {}))!.status).toBe(405);
  expect((await h.request(path + "/preview", "GET"))!.status).toBe(405);
  expect((await h.request(path + "/run?full=true", "POST", learnRequest))!.status).toBe(400);
  h.sql.exec("UPDATE machine_credentials SET seen = 0 WHERE host = 'mac'");
  expect((await h.request(path))!.status).toBe(503);
  expect(h.sql.exec("SELECT * FROM machine_requests").toArray()).toHaveLength(0);
});

test("learning rejects arbitrary history controls before enqueue and gates downgraded claims", async () => {
  const h = await hub(), path = "/api/machines/mac/learning";
  await h.request("/api/host/machine-state", "PUT", learningState, { host: "mac" });
  for (const body of [null, [], { full: true }, { path: "/private" }, { sources: ["codex"] }]) expect((await h.request(path + "/preview", "POST", body))!.status).toBe(400);
  for (const body of [{}, { ...learnRequest, confirm_only: false }, { ...learnRequest, host: "linux" }, { ...learnRequest, preview_digest: "bad" }]) expect((await h.request(path + "/run", "POST", body))!.status).toBe(400);
  expect(h.sql.exec("SELECT * FROM machine_requests").toArray()).toHaveLength(0);
  const id = await h.submit(path + "/run", "POST", learnRequest);
  await h.ready("mac");
  expect(await (await h.request("/api/host/machine-inbox", "GET", undefined, { host: "mac" }))!.json()).toEqual({ items: [] });
  expect((await h.request(`/api/host/machine-requests/${id}`, "POST", undefined, { host: "mac" }))!.status).toBe(409);
  await h.request("/api/host/machine-state", "PUT", learningState, { host: "mac" });
  expect(await (await h.request(`/api/host/machine-requests/${id}`, "POST", undefined, { host: "mac" }))!.json())
    .toEqual({ job: { method: "POST", path: path + "/run", body: learnRequest } });
});

test("learning result uploads retain host and request binding after the private job is removed", async () => {
  const h = await hub(), path = "/api/machines/mac/learning";
  await h.request("/api/host/machine-state", "PUT", learningState, { host: "mac" });
  const counts = { turns: 3, sessions: 2, truncated: false };
  const forms = [
    { path, method: "GET", body: undefined, data: { host: "mac", learning_api: 1, sources: ["claude", "noop"], blocked_reason: null } },
    { path: path + "/preview", method: "POST", body: {}, data: { host: "mac", sources: ["claude"], preview_digest: learnRequest.preview_digest, ...counts } },
    { path: path + "/run", method: "POST", body: learnRequest, data: { host: "mac", ...learnRequest, ...counts, id: "T-mac-0001", applied: true, replayed: false } },
    { path: path + "/discard", method: "POST", body: learnRequest, data: { host: "mac", ...learnRequest, id: "T-mac-0001", discarded: true, replayed: false } },
  ];
  for (const form of forms) {
    const id = await h.submit(form.path, form.method, form.body), upload = `/api/host/machine-requests/${id}`;
    expect((await h.request(upload, "POST", undefined, { host: "linux" }))!.status).toBe(404);
    await h.request(upload, "POST", undefined, { host: "mac" });
    expect(h.sql.exec("SELECT job FROM machine_requests WHERE id = ?", id).toArray()[0].job).toBeNull();
    for (const data of [{ ...form.data, text: "private-canary" }, { ...form.data, host: "linux" }, { ...form.data, path: "/private/canary" }, { error: "failed", stack: "private-canary" }])
      expect((await h.request(upload, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(400);
    if (form.body === learnRequest) {
      for (const data of [{ ...form.data, request_id: "22345678-1234-4234-8234-123456789abc" }, { ...form.data, preview_digest: "b".repeat(64) }])
        expect((await h.request(upload, "PUT", { status: 200, data }, { host: "mac" }))!.status).toBe(400);
    }
    expect(JSON.stringify(h.sql.exec("SELECT * FROM machine_requests").toArray())).not.toContain("private-canary");
    expect((await h.request(upload, "PUT", { status: 200, data: form.data }, { host: "mac" }))!.status).toBe(200);
    expect((await h.request(`/api/machine-requests/${id}`, "GET", undefined, { session: "another" }))!.status).toBe(404);
    expect(await (await h.request(`/api/machine-requests/${id}`))!.json()).toEqual(form.data);
  }
});
