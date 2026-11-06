import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArchiveItem, type ArchiveKind, type ArchivePreview, type ArchiveRestoreRequest, readArchiveList, readArchivePreview, readArchiveRestoreResult } from "../cloud/src/archives";
import { initMachineRequests, machineRequestRoute, mintMachineToken, type MachineActor } from "../cloud/src/machine-requests";
import { initUiRequests, recordPath, uiRequestRoute } from "../cloud/src/ui-requests";
import { DATA, HOME_DIR, P, allowedClis, list, loadConfig, readDoc, writeDoc } from "../src/core";
import { createMember, deleteMember } from "../src/members";
import { archivePlan, readPlan, savePlan } from "../src/plans";
import { createProject, deleteProject, readProject } from "../src/projects";
import { createRoutine, deleteRoutine, readRoutine } from "../src/routines";
import { recordRequest } from "../src/server";
import { setSyncData, setTransport } from "../src/sync";

const host = "archive-main", io = { pull: async () => true, push: async () => true };
const ids = { members: "archived-writer", routines: "archived-review", projects: "archived-site", plans: "PL-0950" } as const;
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://hub${path}`, {
  method, ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
});
let folder = "";
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null);
  for (const dir of ["tasks", "plans", "projects", "agents", "archive", "journal", "fleet"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("agents/lead"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\n");
  writeFileSync(P("config.toml"), `[host]\nname='${host}'\n[fleet]\nprimary='${host}'\n`);
  rmSync(P("config.local.toml"), { force: true }); rmSync(P("settings.json"), { force: true });
  folder = realpathSync(mkdtempSync(join(tmpdir(), "noop-archive-api-")));
});
afterEach(() => { rmSync(folder, { recursive: true, force: true }); setSyncData(DATA, HOME_DIR); setTransport(null); });

function seed() {
  const member = createMember({ title: "Archived writer", name: "Writer", about: "Writes reports", instructions: "Keep these original instructions." });
  expect(member).toBe(ids.members); writeFileSync(P("agents", member, "memory.md"), "Remember the owner's preferred format.\n");
  writeFileSync(P("settings.json"), JSON.stringify({ clis: { agents: { [member]: ["hermes"] } }, autonomy: { agents: { [member]: "autonomous" } } }));
  deleteMember(member, loadConfig());
  createRoutine({ name: ids.routines, every: "hourly", agent: "lead", prompt: "Keep this original routine.", enabled: true }); deleteRoutine(ids.routines);
  const project = createProject({ name: "Archived site", path: folder, instructions: "Keep these project instructions.", repo: "owner/site", requires: "os:macos" }, host);
  expect(project).toBe(ids.projects); deleteProject(project);
  savePlan({ id: ids.plans, goal: "Keep this completed plan", agent: "lead", status: "done", branch: "", created: new Date().toISOString(), notes: [], steps: [], next_step: 0 }); archivePlan(ids.plans);
}
async function archiveList(body: unknown = {}) {
  const response = await recordRequest(request("/api/archive", body), io); expect(response.status).toBe(200);
  const result = readArchiveList(await response.json()); expect(result).toBeDefined(); return result!;
}
async function preview(item: ArchiveItem) {
  const response = await recordRequest(request("/api/archive/preview", { key: item.key }), io); expect(response.status).toBe(200);
  const result = readArchivePreview(await response.json()); expect(result).toBeDefined(); return result!;
}
const restoration = (value: ArchivePreview): ArchiveRestoreRequest => ({ key: value.entry.key, digest: value.digest, request_id: crypto.randomUUID() });
const current = (kind: ArchiveKind) => kind === "members" ? existsSync(P("agents", ids.members, "profile.md"))
  : kind === "routines" ? (loadConfig().routine ?? []).some((routine: any) => routine.name === ids.routines)
  : existsSync(P(kind, `${ids[kind]}.${kind === "plans" ? "json" : "md"}`));

test("archive routes strictly validate methods, filters and nested restoration fields before refreshing", async () => {
  expect(recordPath("/api/archive")).toEqual({ kind: "archive" });
  expect(recordPath("/api/archive/preview")).toEqual({ kind: "archive", action: "preview" });
  expect(recordPath("/api/archive/restore")).toEqual({ kind: "archive", action: "restore" });
  for (const path of ["/api/archive/../config", "/api/archive/restore/extra", "/api/archives"]) expect(recordPath(path)).toBeNull();
  let pulls = 0; const checked = { ...io, pull: async () => { pulls++; return true; } };
  for (const [path, methods] of [["/api/archive", ["PUT", "DELETE"]], ["/api/archive/preview", ["GET", "PUT", "DELETE"]], ["/api/archive/restore", ["GET", "PUT", "DELETE"]]] as const)
    for (const method of methods) expect((await recordRequest(request(path, {}, method), checked)).status).toBe(405);
  for (const body of [null, [], { kind: "agents" }, { kind: "tasks" }, { query: "x".repeat(201) }, { offset: -1 }, { limit: 101 }, { path: "archive/routines" }])
    expect((await recordRequest(request("/api/archive", body), checked)).status).toBe(400);
  for (const body of [null, [], {}, { key: "../../config.toml" }, { key: "a".repeat(64), path: "config.toml" }])
    expect((await recordRequest(request("/api/archive/preview", body), checked)).status).toBe(400);
  const valid = { key: "a".repeat(64), digest: "b".repeat(64), request_id: crypto.randomUUID() };
  for (const body of [{ ...valid, digest: "old" }, { ...valid, request_id: "old" }, { ...valid, confirm_only: false }, { ...valid, destination: "/tmp" },
    { ...valid, project_folder: {} }, { ...valid, project: { host: "worker", path: "/work", context: {} } }, { ...valid, project: { host: "../worker", path: "/work" } }])
    expect((await recordRequest(request("/api/archive/restore", body), checked)).status).toBe(400);
  expect((await recordRequest(request("/api/archive?kind=members", undefined, "GET"), checked)).status).toBe(400);
  expect(pulls).toBe(0);
});

test("list paging and search are typed and previews do not publish or restore any archived record", async () => {
  seed(); let pushes = 0; const checked = { ...io, push: async () => { pushes++; return true; } };
  const get = await recordRequest(request("/api/archive", undefined, "GET"), checked); expect(get.status).toBe(200);
  const all = await archiveList(); expect(all.total).toBe(4); expect(new Set(all.items.map((item) => item.kind))).toEqual(new Set(Object.keys(ids) as ArchiveKind[]));
  for (const kind of Object.keys(ids) as ArchiveKind[]) {
    const filtered = await archiveList({ kind, query: ids[kind], limit: 1, offset: 0 }); expect(filtered.total).toBe(1); expect(filtered.items[0].id).toBe(ids[kind]);
    const response = await recordRequest(request("/api/archive/preview", { key: filtered.items[0].key }), checked), value = readArchivePreview(await response.json());
    expect(response.status).toBe(200); expect(value?.entry.kind).toBe(kind); expect(value?.digest).toMatch(/^[a-f0-9]{64}$/); expect(current(kind)).toBe(false);
  }
  const second = await archiveList({ limit: 2, offset: 2 }); expect(second.items).toHaveLength(2); expect(second.total).toBe(4); expect(second.offset).toBe(2);
  expect(pushes).toBe(0);
});

test("archive search finds saved human names and a later kind remains available beyond five thousand routine archives", async () => {
  seed();
  for (const [kind, query] of [["members", "Archived writer"], ["projects", "Archived site"], ["plans", "completed plan"]] as const) {
    const found = await archiveList({ kind, query }); expect(found.total).toBe(1); expect(found.items[0].id).toBe(ids[kind]);
  }
  try {
    for (let index = 0; index < 5001; index++) {
      const name = `filler-${String(index).padStart(4, "0")}`;
      writeFileSync(P("archive/routines", `${name}-20260101T000000000Z.toml`), `[[routine]]\nname='${name}'\nevery='hourly'\nagent='lead'\nprompt='Fixture routine'\nenabled=false\n`);
    }
    const plans = await archiveList({ kind: "plans", query: "completed plan", limit: 1 });
    expect(plans.total).toBe(1); expect(plans.items[0].id).toBe(ids.plans);
  } finally {
    for (const name of readdirSync(P("archive/routines")).filter((name) => name.startsWith("filler-"))) rmSync(P("archive/routines", name));
  }
});

test("all four restore actions preserve identity and content, keep routines paused and use current member defaults without starting tasks", async () => {
  seed(); const all = await archiveList();
  const archiveBytes = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => entry.isDirectory()
    ? archiveBytes(join(dir, entry.name)) : [`${join(dir, entry.name)}:${new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, entry.name))).digest("hex")}`]);
  const originals = archiveBytes(P("archive"));
  for (const item of all.items) {
    const input = restoration(await preview(item)), response = await recordRequest(request("/api/archive/restore", input), io), body = await response.json() as any;
    expect(response.status).toBe(200); expect(body.ok).toBe(true); expect(readArchiveRestoreResult(body)).toMatchObject({ ...input, kind: item.kind, id: item.id, restored: true, replayed: false });
    expect(current(item.kind)).toBe(true);
  }
  expect(readFileSync(P("agents", ids.members, "memory.md"), "utf8")).toContain("preferred format");
  expect(allowedClis({ agent: ids.members }, loadConfig())).toEqual(allowedClis({ agent: "lead" }, loadConfig()));
  expect(loadConfig().autonomy?.agents?.[ids.members]).toBeUndefined();
  expect(readRoutine(ids.routines)).toMatchObject({ name: ids.routines, enabled: false, prompt: "Keep this original routine." });
  expect(readProject(ids.projects)).toMatchObject({ id: ids.projects, host, path: folder, instructions: "Keep these project instructions." });
  expect(readPlan(ids.plans)).toMatchObject({ id: ids.plans, goal: "Keep this completed plan", status: "done" });
  expect(list(P("tasks/inbox"))).toHaveLength(0); expect((await archiveList()).total).toBe(4); expect(archiveBytes(P("archive"))).toEqual(originals);
});

test("changed archive bytes and existing records reject restoration without overwriting the current record", async () => {
  seed(); const item = (await archiveList({ kind: "routines" })).items[0], original = await preview(item);
  const path = list(P("archive/routines"), /\.toml$/)[0]; writeFileSync(path, readFileSync(path, "utf8").replace("original routine", "changed routine"));
  expect((await recordRequest(request("/api/archive/restore", restoration(original)), io)).status).toBe(409); expect(current("routines")).toBe(false);
  createRoutine({ name: ids.routines, every: "daily 08:00", agent: "lead", prompt: "Current instructions", enabled: false });
  const latest = await preview(item); expect(latest.can_restore).toBe(false);
  expect((await recordRequest(request("/api/archive/restore", restoration(latest)), io)).status).toBe(409);
  expect(readRoutine(ids.routines).prompt).toBe("Current instructions");
});

test("a routine with values the TOML editor cannot preserve is rejected during preview before any restoration is prepared", async () => {
  seed(); const item = (await archiveList({ kind: "routines" })).items[0], path = list(P("archive/routines"), /\.toml$/)[0];
  writeFileSync(path, `${readFileSync(path, "utf8")}extra = { nested = "unsupported" }\n`);
  const value = await preview(item); expect(value.can_restore).toBe(false); expect(value.conflicts.length).toBeGreaterThan(0);
  expect((await recordRequest(request("/api/archive/restore", restoration(value)), io)).status).toBe(409);
  expect(current("routines")).toBe(false); expect(loadConfig().routines?.[ids.routines]).toBeUndefined();
  expect(list(P("fleet/archive-restores"), /\.json$/)).toHaveLength(0);
});

test("failed refresh and worker access prevent archive reads and restoration", async () => {
  seed(); const item = (await archiveList({ kind: "members" })).items[0], input = restoration(await preview(item));
  for (const pull of [async () => false, async () => { throw new Error("offline"); }]) for (const [path, body] of [["/api/archive", {}], ["/api/archive/preview", { key: item.key }], ["/api/archive/restore", input]] as const)
    expect((await recordRequest(request(path, body), { ...io, pull })).status).toBe(503);
  writeFileSync(P("config.toml"), `[host]\nname='worker'\n[fleet]\nprimary='${host}'\n`);
  for (const [path, body] of [["/api/archive", {}], ["/api/archive/preview", { key: item.key }], ["/api/archive/restore", input]] as const)
    expect((await recordRequest(request(path, body), io)).status).toBe(409);
  expect(current("members")).toBe(false);
});

test("partial publication retains every restored identity and exact confirmation never reapplies a later-deleted member", async () => {
  seed(); const all = await archiveList();
  for (const item of all.items) {
    const input = restoration(await preview(item)), partial = await recordRequest(request("/api/archive/restore", input), { ...io, push: async () => false }), body = await partial.json() as any;
    expect(partial.status).toBe(503); expect(body).toMatchObject({ ok: false, saved_locally: true, id: item.id, request_id: input.request_id, restored: true });
    if (item.kind === "members") deleteMember(item.id, loadConfig());
    const confirmed = await recordRequest(request("/api/archive/restore", { ...input, confirm_only: true }), io), result = await confirmed.json() as any;
    expect(confirmed.status).toBe(200); expect(result).toMatchObject({ ok: true, id: item.id, request_id: input.request_id, replayed: true });
    if (item.kind === "members") expect(current("members")).toBe(false);
    expect((await recordRequest(request("/api/archive/restore", { ...input, digest: "c".repeat(64), confirm_only: true }), io)).status).toBe(409);
  }
});

test("confirmation of an unknown restoration never applies it, and a thrown push retains its partial identity", async () => {
  seed(); const item = (await archiveList({ kind: "projects" })).items[0], input = restoration(await preview(item));
  expect((await recordRequest(request("/api/archive/restore", { ...input, confirm_only: true }), io)).status).toBe(404); expect(current("projects")).toBe(false);
  const response = await recordRequest(request("/api/archive/restore", input), { ...io, push: async () => { throw new Error("offline"); } });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ id: item.id, request_id: input.request_id, saved_locally: true }); expect(current("projects")).toBe(true);
});

test("a failed authorization write returns a pending identity without claiming that a record was restored", async () => {
  seed(); const item = (await archiveList({ kind: "members" })).items[0], input = restoration(await preview(item)), receipt = P("fleet/archive-restores", `${input.request_id}.json`);
  const rename = fs.renameSync, failure = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === receipt) throw new Error("fixture receipt write failed"); return rename(from, to); });
  let response: Response;
  try { response = await recordRequest(request("/api/archive/restore", input), io); } finally { failure.mockRestore(); }
  const body = await response!.json() as any;
  expect(response!.status).toBe(503); expect(body).toMatchObject({ ok: false, uncertain: true, pending: true, id: item.id, request_id: input.request_id });
  expect(body.restored).toBeUndefined(); expect(body.replayed).toBeUndefined(); expect(current("members")).toBe(false);
  expect((await recordRequest(request("/api/archive/restore", { ...input, confirm_only: true }), io)).status).toBe(404);
});

test("a record saved before its applied receipt fails can be confirmed without its original archive or another mutation", async () => {
  seed(); const item = (await archiveList({ kind: "members" })).items[0], input = restoration(await preview(item)), receipt = P("fleet/archive-restores", `${input.request_id}.json`);
  const source = join(P("archive/agents"), readdirSync(P("archive/agents"))[0]), rename = fs.renameSync; let writes = 0;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === receipt && ++writes === 2) throw new Error("fixture applied receipt failed"); return rename(from, to); });
  let response: Response;
  try { response = await recordRequest(request("/api/archive/restore", input), io); } finally { failure.mockRestore(); }
  const body = await response!.json() as any;
  expect(response!.status).toBe(503); expect(body).toMatchObject({ ok: false, uncertain: true, restored: true, id: item.id, request_id: input.request_id });
  const profile = readFileSync(P("agents", ids.members, "profile.md"), "utf8"); rmSync(source, { recursive: true });
  const confirmed = await recordRequest(request("/api/archive/restore", { ...input, confirm_only: true }), io);
  expect(confirmed.status).toBe(200); expect(await confirmed.json()).toMatchObject({ ok: true, restored: true, replayed: true, id: item.id, request_id: input.request_id });
  expect(readFileSync(P("agents", ids.members, "profile.md"), "utf8")).toBe(profile);
});

test("an unconfirmed applied restoration cannot recreate a member deleted before the same request is retried", async () => {
  seed(); const item = (await archiveList({ kind: "members" })).items[0], input = restoration(await preview(item)), receipt = P("fleet/archive-restores", `${input.request_id}.json`);
  const rename = fs.renameSync; let writes = 0;
  const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === receipt && ++writes === 2) throw new Error("fixture applied receipt failed"); return rename(from, to); });
  let partial: Response;
  try { partial = await recordRequest(request("/api/archive/restore", input), io); } finally { failure.mockRestore(); }
  expect(partial!.status).toBe(503); expect(current("members")).toBe(true);
  deleteMember(ids.members, loadConfig()); expect(current("members")).toBe(false);
  const retry = await recordRequest(request("/api/archive/restore", input), io);
  expect(retry.status).toBe(503); expect(await retry.json()).toMatchObject({ ok: false, pending: true, uncertain: true, id: item.id, request_id: input.request_id });
  expect(current("members")).toBe(false);
});

test("remote project restoration requires trusted folder context and confirmation needs neither that folder nor another proof", async () => {
  seed(); const item = (await archiveList({ kind: "projects" })).items[0], value = await preview(item);
  const input = { ...restoration(value), project: { host: "worker", path: "~/site", probe_ticket: crypto.randomUUID() } };
  expect((await recordRequest(request("/api/archive/restore", input), io)).status).toBe(409); expect(current("projects")).toBe(false);
  const check = { host: "worker", requested_path: "~/site", path: "/worker/site", repo: "worker/detected", requires: ["cli:cargo"], checked: new Date().toISOString() };
  expect((await recordRequest(request("/api/archive/restore", input), io, { ...check, host: "other" })).status).toBe(409);
  const response = await recordRequest(request("/api/archive/restore", input), io, check); expect(response.status).toBe(200);
  expect(readProject(ids.projects)).toMatchObject({ id: ids.projects, host: "worker", path: "/worker/site", exists: null });
  deleteProject(ids.projects); expect(current("projects")).toBe(false);
  const confirmed = await recordRequest(request("/api/archive/restore", { ...input, project: { ...input.project, probe_ticket: crypto.randomUUID() }, confirm_only: true }), io);
  expect(confirmed.status).toBe(200); expect(await confirmed.json()).toMatchObject({ ok: true, id: ids.projects, request_id: input.request_id, replayed: true });
  expect(current("projects")).toBe(false);
});

test("unknown archive keys and replaced symlink content cannot read or restore arbitrary local files", async () => {
  seed(); const item = (await archiveList({ kind: "members" })).items[0];
  expect((await recordRequest(request("/api/archive/preview", { key: "f".repeat(64) }), io)).status).toBe(404);
  const dir = join(P("archive/agents"), readdirSync(P("archive/agents"))[0]), memory = join(dir, "memory.md"), outside = join(folder, "outside.txt");
  writeFileSync(outside, "private outside archive contents"); rmSync(memory); symlinkSync(outside, memory);
  const response = await recordRequest(request("/api/archive/preview", { key: item.key }), io), body = await response.json();
  expect([400, 404, 409]).toContain(response.status); expect(JSON.stringify(body)).not.toContain("private outside"); expect(current("members")).toBe(false);
});

test("dangling destination symlinks are conflicts and restoration cannot write through them", async () => {
  seed();
  for (const kind of ["members", "projects", "plans"] as const) {
    const item = (await archiveList({ kind })).items[0], input = restoration(await preview(item));
    const destination = kind === "members" ? P("agents", ids.members) : P(kind, `${ids[kind]}.${kind === "projects" ? "md" : "json"}`);
    const outside = join(folder, `outside-${kind}`); symlinkSync(outside, destination);
    expect((await recordRequest(request("/api/archive/restore", input), io)).status).toBe(409);
    expect(existsSync(outside)).toBe(false); rmSync(destination);
  }
});

function cloudHub() {
  const db = new Database(":memory:");
  const sql = { exec(query: string, ...bindings: any[]) {
    let rows: any[] = [];
    for (const part of query.split(";").map((text) => text.trim()).filter(Boolean)) {
      const stmt = db.query(part); if (/^(SELECT|PRAGMA)/i.test(part)) rows = stmt.all(...bindings); else stmt.run(...bindings);
    }
    return { toArray: () => rows };
  } };
  initUiRequests(sql); initMachineRequests(sql);
  const inbox: unknown[] = [], online = { online: () => true, supported: () => true, enqueue: (item: unknown) => inbox.push(item) };
  const call = (path: string, body?: unknown, method = "POST", who: "machine" | { session: string } = { session: "owner" }) => uiRequestRoute(sql, request(path, body, method), who, online);
  const machine = (path: string, body?: unknown, method = "POST", who: MachineActor = { session: "owner" }) => machineRequestRoute(sql, request(path, body, method), who);
  return { db, sql, inbox, call, machine };
}
async function folderProof(h: ReturnType<typeof cloudHub>) {
  await mintMachineToken(h.sql, "worker");
  await h.machine("/api/host/machine-state", { project_api: 1, account_api: 1 }, "PUT", { host: "worker" });
  const start = (await h.machine("/api/machines/worker/project-folder-check", { path: "~/site" }))!, ticket = (await start.json() as any).ticket;
  await h.machine(`/api/host/machine-requests/${ticket}`, undefined, "POST", { host: "worker" });
  const check = { host: "worker", requested_path: "~/site", path: "/worker/site", repo: "owner/site", requires: ["cli:cargo"], checked: new Date().toISOString() };
  expect((await h.machine(`/api/host/machine-requests/${ticket}`, { status: 200, data: check }, "PUT", { host: "worker" }))?.status).toBe(200);
  return { ticket, check };
}

test("cloud admission authenticates nested restore project proofs and forwards only trusted context outside the form", async () => {
  const h = cloudHub();
  try {
    const proof = await folderProof(h), input = { key: "a".repeat(64), digest: "b".repeat(64), request_id: crypto.randomUUID(), project: { host: "worker", path: "~/site", probe_ticket: proof.ticket } };
    for (const body of [{ ...input, project: { ...input.project, path: "~/different" } }, { ...input, project: { ...input.project, host: "other" } }, { ...input, project: { ...input.project, probe_ticket: crypto.randomUUID() } }])
      expect((await h.call("/api/archive/restore", body))?.status).toBe(409);
    expect((await h.call("/api/archive/restore", input, "POST", { session: "other-owner" }))?.status).toBe(409); expect(h.inbox).toHaveLength(0);
    const start = (await h.call("/api/archive/restore", input))!; expect(start.status).toBe(202);
    const ticket = (await start.json() as any).ticket, claim = (await h.call(`/api/host/ui-requests/${ticket}`, undefined, "POST", "machine"))!, job = (await claim.json() as any).job;
    expect(job.body).toEqual(input); expect(job.body.project_folder).toBeUndefined(); expect(job.project_folder).toEqual(proof.check);
    h.sql.exec("UPDATE machine_requests SET expires = ? WHERE id = ?", Date.now() - 1, proof.ticket);
    expect((await h.call("/api/archive/restore", input))?.status).toBe(409);
    const confirmation = (await h.call("/api/archive/restore", { ...input, confirm_only: true }))!; expect(confirmation.status).toBe(202);
    const confirmationId = (await confirmation.json() as any).ticket, confirmClaim = (await h.call(`/api/host/ui-requests/${confirmationId}`, undefined, "POST", "machine"))!;
    expect((await confirmClaim.json() as any).job.project_folder).toBeUndefined();
  } finally { h.db.close(); }
});

test("cloud archive admission rejects machines, unsupported methods and untrusted form fields before enqueue", async () => {
  const h = cloudHub();
  try {
    for (const [path, body] of [["/api/archive", {}], ["/api/archive/preview", { key: "a".repeat(64) }], ["/api/archive/restore", { key: "a".repeat(64), digest: "b".repeat(64), request_id: crypto.randomUUID() }]] as const) {
      expect((await h.call(path, body, "POST", "machine"))?.status).toBe(403);
      expect((await h.call(path, body, "PUT"))?.status).toBe(405);
      expect((await h.call(path, { ...body, context: {} }))?.status).toBe(400);
    }
    expect((await h.call("/api/archive?limit=2", undefined, "GET"))?.status).toBe(400); expect(h.inbox).toHaveLength(0);
    const response = (await h.call("/api/archive", { kind: "plans", query: "release", offset: 2, limit: 5 }))!; expect(response.status).toBe(202);
    const id = (await response.json() as any).ticket, claim = (await h.call(`/api/host/ui-requests/${id}`, undefined, "POST", "machine"))!;
    expect((await claim.json() as any).job.body).toEqual({ kind: "plans", query: "release", offset: 2, limit: 5 });
  } finally { h.db.close(); }
});
