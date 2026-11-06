// Against the isolated local production Worker; never invokes a real AI CLI or reads local accounts.
import { strict as assert } from "node:assert";
const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "This test only runs against an isolated local Worker");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const request = async (path: string, token = owner, method = "GET", body?: unknown, extra: Record<string, string> = {}) => {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, data: await response.json() as any };
};
assert.equal((await request("/api/host/import", legacy, "POST", { table: "sessions", rows: [{ id: hash, email: "machine-test@example.com", created: Date.now(), last_seen: Date.now(), ua: "machine-account-test" }] })).status, 200);
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, mac = `account-mac-${tag}`, linux = `account-linux-${tag}`;
try {
  const a = await request("/api/host/join", owner, "POST", { host: mac }), b = await request("/api/host/join", owner, "POST", { host: linux });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.match(a.data.token, /^[a-f0-9]{64}$/); assert.notEqual(a.data.token, b.data.token); assert.notEqual(a.data.token, legacy);
  assert.equal((await request("/api/host/join", owner, "POST", { host: mac })).status, 409);
  assert.equal((await request("/api/host/register", owner, "POST", { host: `owner-register-${tag}` })).status, 403);
  const registered = await request("/api/host/register", legacy, "POST", { host: `legacy-register-${tag}` });
  assert.equal(registered.status, 200);
  assert.equal((await request("/api/host/register", legacy, "POST", { host: `legacy-register-${tag}` })).status, 409);
  const proposed = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""), reliable = { host: `reliable-register-${tag}`, token: proposed };
  assert.equal((await request("/api/host/register", legacy, "POST", reliable)).status, 200);
  assert.equal((await request("/api/host/register", legacy, "POST", reliable)).status, 200);
  assert.equal((await request("/api/host/register", legacy, "POST", { ...reliable, token: "b".repeat(64) })).status, 409);
  assert.equal((await request("/api/host/register", legacy, "POST", { host: `another-register-${tag}`, token: proposed })).status, 409);
  assert.equal((await request("/api/host/register", legacy, "POST", { host: `owner-collision-${tag}`, token: owner })).status, 400);
  assert.equal((await request("/api/host/register", a.data.token, "POST", { host: `scoped-register-${tag}` })).status, 403);
  assert.deepEqual((await request("/api/host/identity", a.data.token, "GET", undefined, { "X-Noop-Host": linux })).data, { host: mac, legacy: false });
  assert.deepEqual((await request("/api/host/identity", legacy)).data, { host: null, legacy: true });
  assert.equal((await request("/api/host/identity")).status, 403);
  for (const path of ["/api/host/inbox", "/api/host/export", "/api/host/login-code", "/api/host/ui-requests/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "/mcp"])
    assert.equal((await request(path, a.data.token)).status, 403, path);
  assert.equal((await request("/api/host/state", a.data.token, "PUT", { status: {} })).status, 403);
  assert.equal((await request("/api/files/changes?since=0", a.data.token)).status, 200);
  assert.equal((await request("/api/host/machine-inbox", legacy)).status, 403);
  assert.equal((await request(`/api/machines/${mac}/accounts`, legacy)).status, 403);
  assert.equal((await request(`/api/machines/${mac}/accounts`)).status, 409);
  for (const token of [a.data.token, b.data.token]) assert.equal((await request("/api/host/machine-state", token, "PUT", { account_api: 1 })).status, 200);
  assert.equal((await request("/api/host/machine-state", a.data.token, "PUT", { account_api: 1, host: linux })).status, 400);
  const start = await request(`/api/machines/${mac}/accounts/claude/work/code`, owner, "POST", { id: "L-0001", code: "test-only-sensitive-code" });
  assert.equal(start.status, 202);
  const id = start.data.ticket, claim = `/api/host/machine-requests/${id}`, poll = `/api/machine-requests/${id}`;
  assert.deepEqual((await request("/api/host/machine-inbox", b.data.token, "GET", undefined, { "X-Noop-Host": mac })).data, { items: [] });
  assert((await request("/api/host/machine-inbox", a.data.token)).data.items.some((item: any) => item.id === id));
  assert.equal((await request(claim, legacy, "POST")).status, 403);
  assert.equal((await request(claim, b.data.token, "POST")).status, 404);
  assert.equal((await request(poll, a.data.token)).status, 403);
  const job = await request(claim, a.data.token, "POST");
  assert.equal(job.data.job.body.code, "test-only-sensitive-code"); assert.equal(job.data.job.path, `/api/machines/${mac}/accounts/claude/work/code`);
  const safe = { host: mac, providers: [], accounts: [] };
  assert.equal((await request(claim, b.data.token, "PUT", { status: 200, data: safe })).status, 404);
  assert.equal((await request(claim, a.data.token, "PUT", { status: 200, data: { ...safe, token: "must-not-leak" } })).status, 400);
  assert.equal((await request(claim, a.data.token, "PUT", { status: 200, data: safe })).status, 200);
  const done = await request(poll); assert.equal(done.headers.get("X-Noop-Confirmed"), "1"); assert.deepEqual(done.data, safe);
  assert.deepEqual((await request(claim, a.data.token, "POST")).data, { done: true });
  const tables = (await request("/api/host/export", legacy)).data.tables;
  for (const table of ["machine_requests", "machine_credentials"]) {
    assert(!Object.hasOwn(tables, table));
    assert.equal((await request(`/api/host/export?table=${table}`, legacy)).status, 404);
    assert.equal((await request("/api/host/import", legacy, "POST", { table, rows: [], reset: true })).status, 404);
  }
  assert.equal((await request("/api/host/import", legacy, "POST", { table: "kv", rows: [{ 'k") VALUES ("injection"); --': "forbidden" }] })).status, 400);
  const rotated = await request("/api/host/join", owner, "POST", { host: mac, replace: true });
  assert.equal(rotated.status, 200); assert.equal((await request("/api/host/identity", a.data.token)).status, 401);
  assert.deepEqual((await request("/api/host/identity", rotated.data.token)).data, { host: mac, legacy: false });
  console.log("Machine account channel: scoped registration, credential rotation, target-bound inbox/claims/results, safe summaries, global endpoint isolation and migration-table protection passed in workerd.");
} finally { await request("/api/auth/logout", owner, "POST", {}); }
