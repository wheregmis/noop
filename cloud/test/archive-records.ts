// Production Worker + real RemoteFiles primary/worker mirrors; all records, accounts and folders are fixtures.
import { strict as assert } from "node:assert";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-archive-records-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const otherOwner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, primary = `archive-primary-${tag}`;
async function request(path: string, method = "GET", body?: unknown, token = owner) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(50); }
}
async function machineResult(ticket: string) {
  let result: Awaited<ReturnType<typeof request>>;
  await until(async () => { result = await request(`/api/machine-requests/${ticket}`); return result.status !== 202; }, "Machine request was not confirmed");
  return result!;
}
type Machine = { host: string; dir: string; home: string; data: string; token: string; url: string; proc: ReturnType<typeof Bun.spawn>; output: Promise<string[]> };
let worker: Machine | undefined;
async function machine(): Promise<Machine> {
  const host = `archive-worker-${tag}`, dir = join(root, "worker"), home = join(dir, "home"), data = join(dir, "data");
  for (const folder of [home, data, join(home, "accounts")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined));
  const token = joined.data.token, entry = join(dir, "bridge.ts");
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\npoll_seconds = 0.1\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
  writeFileSync(entry, `
    import {writeFileSync,appendFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {loadConfig,locked,_pull,hasRemote} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    if(!await hasRemote()||!await _pull())throw new Error('Fixture requires real RemoteFiles');
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      const ticket=path.match(/^\\/api\\/host\\/machine-requests\\/([a-f0-9-]{36})$/);
      if(ticket&&init?.method==='PUT')appendFileSync(${JSON.stringify(join(dir, "results.jsonl"))},JSON.stringify({ticket:ticket[1],result:JSON.parse(String(init.body))})+'\\n');
      return originalFetch(input,init);
    };
    const cfg=loadConfig();let stopBridge=startMachineBridge(cfg);
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      const path=new URL(req.url).pathname;
      if(path==='/fixture/pull')return Response.json({ok:await locked(_pull)});
      if(path==='/fixture/pause'){stopBridge();return Response.json({ok:true});}
      if(path==='/fixture/resume'){stopBridge();stopBridge=startMachineBridge(cfg);return Response.json({ok:true});}
      return Response.json({error:'fixture route not found'},{status:404});
    }});
    writeFileSync(${JSON.stringify(join(dir, "server.json"))},JSON.stringify({url:server.url.origin}));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopBridge();server.stop(true);process.exit(0);});
  `);
  const proc = Bun.spawn([process.execPath, entry], { env: { PATH: "/usr/bin:/bin", NOOP_HOME: home, HUB_DATA: data, HUB_CONF: join(home, "noop.toml"), HUB_HOST: host, HUB_SYNC: "", HUB_SYNC_FAKE: "", TMPDIR: dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const result: Machine = { host, dir, home, data, token, url: "", proc, output: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]) };
  worker = result;
  await until(() => existsSync(join(dir, "server.json")), "Worker bridge did not start");
  result.url = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).url;
  let ticket = "";
  await until(async () => { const ready = await request(`/api/machines/${host}/accounts`); if (ready.status === 202) ticket = ready.data.ticket; return !!ticket; }, "Worker bridge did not advertise its account/project channel");
  assert.equal((await machineResult(ticket)).status, 200);
  return result;
}
async function local(machine: Machine, path: string) {
  const response = await fetch(machine.url + path, { method: "POST", signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function probe(machine: Machine, path: string) {
  const queued = await request(`/api/machines/${machine.host}/project-folder-check`, "POST", { path }); assert.equal(queued.status, 202, JSON.stringify(queued));
  const result = await machineResult(queued.data.ticket); assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.host, machine.host); assert.equal(result.data.requested_path, path); assert.equal(result.data.probe_ticket, queued.data.ticket);
  const observed = readFileSync(join(machine.dir, "results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(observed.some((entry) => entry.ticket === queued.data.ticket && entry.result.data?.host === machine.host));
  return result.data;
}

process.env.NOOP_HOME = join(root, "primary-home"); process.env.HUB_DATA = join(root, "primary-data"); process.env.HUB_CONF = join(root, "primary-home", "noop.toml"); process.env.HUB_HOST = primary; process.env.HUB_SYNC = ""; process.env.HUB_SYNC_FAKE = "";
mkdirSync(process.env.NOOP_HOME, { recursive: true }); mkdirSync(process.env.HUB_DATA, { recursive: true });
writeFileSync(process.env.HUB_CONF, `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(legacy)}\n`, { mode: 0o600 });
mkdirSync(join(process.env.NOOP_HOME, "accounts")); writeFileSync(join(process.env.NOOP_HOME, "accounts", "config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
const { P, locked, _pull, _commitPush, readDoc, hasRemote, loadConfig } = await import("../../src/core");
const server = await import("../../src/server");
const { applyUiRequest } = await import("../../src/ui-requests");
const { savePlan, readPlan } = await import("../../src/plans");
const results = new Map();
const send = async (path: string, init: RequestInit) => {
  const response = await request(path, init.method, init.body ? JSON.parse(String(init.body)) : undefined, legacy);
  return response.status >= 200 && response.status < 300 ? response.data : null;
};
async function form(path: string, method = "GET", body?: unknown) {
  const accepted = await request(path, method, body); assert.equal(accepted.status, 202, JSON.stringify(accepted));
  await applyUiRequest(accepted.data.ticket, send, (req, folder) => server.recordRequest(req, undefined, folder), results);
  return { ...await request(`/api/ui-requests/${accepted.data.ticket}`), ticket: accepted.data.ticket };
}
async function pull() { assert.equal(await locked(_pull), true); }
async function push(message: string) { assert.equal(await locked(() => _commitPush(message)), true); }
async function archived(kind: string, id: string) {
  const listed = await form("/api/archive", "POST", { kind, query: id }); assert.equal(listed.status, 200, JSON.stringify(listed));
  const entry = listed.data.items.find((entry: any) => entry.kind === kind && entry.id === id); assert(entry, JSON.stringify(listed)); return entry;
}
async function preview(key: string) {
  const response = await form("/api/archive/preview", "POST", { key }); assert.equal(response.status, 200, JSON.stringify(response)); return response.data;
}
function archiveFiles(dir = P("archive")): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name), stat = lstatSync(path);
    return stat.isDirectory() ? Object.entries(archiveFiles(path)) : stat.isFile() ? [[relative(P(), path), readFileSync(path).toString("base64")]] : [];
  }));
}

try {
  for (const [token, email] of [[owner, "archive-records@example.com"], [otherOwner, "archive-other-session@example.com"]]) {
    const session = new Bun.CryptoHasher("sha256").update(token!).digest("hex");
    assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email, created: Date.now(), last_seen: Date.now(), ua: "archive-records-test" }] }, legacy)).status, 200);
  }
  assert.equal(await hasRemote(), true); await pull();
  writeFileSync(P("config.toml"), `[fleet]\nprimary = ${JSON.stringify(primary)}\n[clis]\nenabled = []\n`);
  mkdirSync(P("agents", "lead"), { recursive: true }); writeFileSync(P("agents", "lead", "profile.md"), "# Fixture lead\nName: Fixture\n\nOnly fixture work.\n"); mkdirSync(P("journal"), { recursive: true });
  await push("fixture archive configuration");
  assert.equal((await request("/api/host/state", "PUT", { status: { active: [] }, ui_api: 1 }, legacy)).status, 200);
  const remote = await machine(), projectFolder = join(remote.dir, "project"); mkdirSync(projectFolder);
  writeFileSync(join(projectFolder, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  const firstCheck = await probe(remote, projectFolder);
  const createdProject = await form("/api/projects", "POST", { name: "Archived fixture project", host: remote.host, path: projectFolder, probe_ticket: firstCheck.probe_ticket, requires: ["gpu"], instructions: "Keep the archived project instructions." });
  assert.equal(createdProject.status, 200, JSON.stringify(createdProject)); const projectId = createdProject.data.id;
  const createdMember = await form("/api/members", "POST", { title: "Archive fixture member", name: "Fixture", about: "Only temporary records", instructions: "Keep all fixture memory." });
  assert.equal(createdMember.status, 200); const memberId = createdMember.data.id;
  const memory = "# Fixture memory\nKeep the remembered constraint exactly.\n", note = "Nested fixture note.\n";
  writeFileSync(P("agents", memberId, "memory.md"), memory); mkdirSync(P("agents", memberId, "notes")); writeFileSync(P("agents", memberId, "notes", "fixture.md"), note);
  const memberProfile = readFileSync(P("agents", memberId, "profile.md"), "utf8");
  await push("fixture member memory");
  const routineId = "archived-fixture-routine";
  assert.equal((await form("/api/routines", "POST", { name: routineId, every: "hourly", agent: "lead", prompt: "Keep fixture instructions", enabled: true, signal: "fixture-never-run", weight: "heavy" })).status, 200);
  const planId = `PL-A${Date.now().toString().slice(-9)}`;
  await locked(async () => {
    assert.equal(await _pull(), true);
    savePlan({ id: planId, goal: "Archived terminal fixture plan", agent: "lead", status: "done", branch: "fixture-history", created: new Date().toISOString(), notes: ["Keep the historical note"], next_step: 2,
      steps: [{ id: "s1", title: "Completed fixture step", details: "Historical only", agent: "lead", checkpoint: false, status: "done", attempt: 1, task: "T-99001", result: "Keep the historical result" }] });
    assert.equal(await _commitPush("fixture terminal plan"), true);
  });
  const originalPlan = readPlan(planId);
  for (const path of [`/api/routines/${routineId}`, `/api/members/${memberId}`, `/api/projects/${projectId}`, `/api/plans/${planId}`])
    assert.equal((await form(path, "DELETE")).status, 200, path);
  assert(existsSync(projectFolder), "Archiving a project must leave its actual folder intact");
  const entries = {
    routines: await archived("routines", routineId), members: await archived("members", memberId),
    projects: await archived("projects", projectId), plans: await archived("plans", planId),
  };
  const paged = await form("/api/archive", "POST", { offset: 1, limit: 2 });
  assert.equal(paged.status, 200); assert.equal(paged.data.total, 4); assert.equal(paged.data.items.length, 2); assert.equal(paged.data.offset, 1); assert.equal(paged.data.limit, 2);
  assert.equal((await request("/api/archive", "POST", {}, remote.token)).status, 403);
  for (const invalid of [{ key: "../../settings.json" }, { key: entries.members.key, path: "../outside" }])
    assert.equal((await request("/api/archive/preview", "POST", invalid)).status, 400);
  assert.equal((await form("/api/archive/preview", "POST", { key: "a".repeat(64) })).status, 404);
  const missingConfirmation = await form("/api/archive/restore", "POST", { key: entries.members.key, digest: (await preview(entries.members.key)).digest, request_id: crypto.randomUUID(), confirm_only: true });
  assert.equal(missingConfirmation.status, 404); assert(!existsSync(P("agents", memberId)));

  const routinePreview = await preview(entries.routines.key);
  const routineArchive = P("archive", "routines", readdirSync(P("archive", "routines")).find((name) => name.startsWith(routineId))!);
  const routineBytes = readFileSync(routineArchive, "utf8");
  // Deliberately corrupt this fixture's archive to prove the digest is checked before restoration.
  writeFileSync(routineArchive, routineBytes + "# Fixture changed after preview\n"); await push("fixture stale archive digest");
  assert.equal((await form("/api/archive/restore", "POST", { key: entries.routines.key, digest: routinePreview.digest, request_id: crypto.randomUUID() })).status, 409);
  assert(!(loadConfig().routine ?? []).some((routine: any) => routine.name === routineId));
  writeFileSync(routineArchive, routineBytes); await push("fixture repair archive bytes");

  const memberArchive = P("archive", "agents", readdirSync(P("archive", "agents")).find((name) => name.startsWith(memberId))!, "profile.md");
  const archivedProfile = readFileSync(memberArchive), outside = join(root, "outside-profile.md"); writeFileSync(outside, "OUTSIDE FIXTURE CONTENT MUST NOT BE READ\n");
  const memberPreviewBeforeLink = await preview(entries.members.key);
  rmSync(memberArchive); symlinkSync(outside, memberArchive);
  const unsafe = await form("/api/archive/preview", "POST", { key: entries.members.key });
  assert(unsafe.status >= 400 || unsafe.data.can_restore === false, "A linked archive must not be restorable");
  assert(!JSON.stringify(unsafe.data).includes("OUTSIDE FIXTURE CONTENT"));
  assert.notEqual((await form("/api/archive/restore", "POST", { key: entries.members.key, digest: memberPreviewBeforeLink.digest, request_id: crypto.randomUUID() })).status, 200);
  assert(!existsSync(P("agents", memberId))); rmSync(memberArchive); writeFileSync(memberArchive, archivedProfile);
  const immutable = archiveFiles();

  writeFileSync(P("settings.json"), JSON.stringify({ routines: { [routineId]: { enabled: true } } }) + "\n"); await push("fixture stale routine override");
  const pausedPreview = await preview(entries.routines.key);
  assert.equal(pausedPreview.entry.id, routineId); assert.equal(pausedPreview.can_restore, true);
  const routineRequest = { key: entries.routines.key, digest: pausedPreview.digest, request_id: crypto.randomUUID() };
  let lostRestoreTicket = "";
  await assert.rejects(async () => {
    const accepted = await request("/api/archive/restore", "POST", routineRequest); assert.equal(accepted.status, 202); lostRestoreTicket = accepted.data.ticket;
    throw new TypeError("fixture lost initial restore POST reply before ticket delivery");
  }, /lost initial restore POST reply/);
  await applyUiRequest(lostRestoreTicket, send, (req, folder) => server.recordRequest(req, undefined, folder), results);
  assert.equal((await request(`/api/ui-requests/${lostRestoreTicket}`)).status, 200);
  const routineRestore = await form("/api/archive/restore", "POST", routineRequest);
  assert.equal(routineRestore.status, 200, JSON.stringify(routineRestore)); assert.equal(routineRestore.data.id, routineId); assert.equal(routineRestore.data.restored, true);
  assert.equal(routineRestore.data.replayed, true); assert.equal((loadConfig().routine ?? []).filter((routine: any) => routine.name === routineId).length, 1);
  const restoredRoutine = (await form(`/api/routines/${routineId}`)).data;
  assert.equal(restoredRoutine.enabled, false); assert.equal(restoredRoutine.signal, "fixture-never-run"); assert.equal(restoredRoutine.weight, "heavy");
  assert.equal((loadConfig().routine ?? []).find((routine: any) => routine.name === routineId)?.enabled, false);

  const memberPreview = await preview(entries.members.key), memberRequest = { key: entries.members.key, digest: memberPreview.digest, request_id: crypto.randomUUID() };
  const realFetch = globalThis.fetch;
  let partialMember: Awaited<ReturnType<typeof form>>;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/files/commit") throw new TypeError("fixture restore publication interrupted");
    return realFetch(input, init);
  }) as typeof fetch;
  try { partialMember = await form("/api/archive/restore", "POST", memberRequest); } finally { globalThis.fetch = realFetch; }
  assert.equal(partialMember.status, 503, JSON.stringify(partialMember)); assert.equal(partialMember.data.saved_locally, true); assert.equal(partialMember.data.id, memberId); assert.equal(partialMember.data.request_id, memberRequest.request_id);
  assert.equal(readFileSync(P("agents", memberId, "memory.md"), "utf8"), memory);
  const replayMember = await form("/api/archive/restore", "POST", memberRequest);
  assert.equal(replayMember.status, 200, JSON.stringify(replayMember)); assert.equal(replayMember.data.replayed, true); assert.equal(replayMember.data.id, memberId);
  assert.equal(readFileSync(P("agents", memberId, "profile.md"), "utf8"), memberProfile); assert.equal(readFileSync(P("agents", memberId, "notes", "fixture.md"), "utf8"), note);
  assert.equal((await request(`/api/ui-requests/${partialMember.ticket}`)).status, 503, "The original partial receipt must remain immutable");
  assert.equal((await form("/api/archive/restore", "POST", { ...memberRequest, request_id: crypto.randomUUID() })).status, 409, "Another restore must not overwrite the active member ID");
  assert.equal((await form(`/api/members/${memberId}`, "DELETE")).status, 200);
  const historicalMember = await form("/api/archive/restore", "POST", memberRequest);
  assert.equal(historicalMember.status, 200); assert.equal(historicalMember.data.replayed, true); assert(!existsSync(P("agents", memberId)), "Replaying an old restore must not reverse a later deliberate deletion");

  const collision = await form("/api/projects", "POST", { name: "Folder collision", host: remote.host, path: projectFolder, probe_ticket: (await probe(remote, projectFolder)).probe_ticket });
  assert.equal(collision.status, 200); assert.notEqual(collision.data.id, projectId);
  const blockedProject = await preview(entries.projects.key);
  assert.equal((await form("/api/archive/restore", "POST", { key: entries.projects.key, digest: blockedProject.digest, request_id: crypto.randomUUID(), project: { host: remote.host, path: projectFolder, probe_ticket: (await probe(remote, projectFolder)).probe_ticket } })).status, 409);
  assert.equal((await form(`/api/projects/${collision.data.id}`, "DELETE")).status, 200);
  rmSync(join(projectFolder, "Cargo.toml")); writeFileSync(join(projectFolder, "package.json"), '{"name":"fixture-current"}');
  const projectPreview = await preview(entries.projects.key), projectRequest = { key: entries.projects.key, digest: projectPreview.digest, request_id: crypto.randomUUID(), project: { host: remote.host, path: projectFolder } };
  assert.equal((await form("/api/archive/restore", "POST", projectRequest)).status, 409, "Remote projects require fresh machine proof");
  assert.equal((await request("/api/archive/restore", "POST", { ...projectRequest, project: { ...projectRequest.project, probe_ticket: crypto.randomUUID() } })).status, 409);
  const currentCheck = await probe(remote, projectFolder);
  assert.deepEqual(currentCheck.requires, ["cli:bun|cli:node"]);
  assert.equal((await request("/api/archive/restore", "POST", { ...projectRequest, project: { ...projectRequest.project, probe_ticket: currentCheck.probe_ticket } }, otherOwner)).status, 409);
  const restoredProject = await form("/api/archive/restore", "POST", { ...projectRequest, project: { ...projectRequest.project, probe_ticket: currentCheck.probe_ticket } });
  assert.equal(restoredProject.status, 200, JSON.stringify(restoredProject)); assert.equal(restoredProject.data.id, projectId);
  const projectView = await form(`/api/projects/${projectId}`);
  assert.equal(projectView.data.host, remote.host); assert.equal(projectView.data.instructions, "Keep the archived project instructions."); assert.deepEqual(projectView.data.detected_requires, ["cli:bun|cli:node"]); assert.deepEqual(projectView.data.custom_requires, ["gpu"]);
  assert.equal((await local(remote, "/fixture/pull")).data.ok, true);
  assert.equal(readDoc(join(remote.data, "projects", `${projectId}.md`)).meta.host, remote.host);
  assert.equal((await form(`/api/projects/${projectId}`, "DELETE")).status, 200);
  assert.equal((await local(remote, "/fixture/pause")).status, 200); renameSync(projectFolder, projectFolder + "-offline");
  assert.equal((await request("/api/host/machine-state", "PUT", { account_api: 1 }, remote.token)).status, 200);
  assert.equal((await request(`/api/machines/${remote.host}/project-folder-check`, "POST", { path: projectFolder })).status, 409);
  const confirmedProject = await form("/api/archive/restore", "POST", { ...projectRequest, confirm_only: true });
  assert.equal(confirmedProject.status, 200, JSON.stringify(confirmedProject)); assert.equal(confirmedProject.data.replayed, true); assert(!existsSync(P("projects", `${projectId}.md`)));
  assert.equal((await form("/api/archive/restore", "POST", { ...projectRequest, request_id: crypto.randomUUID(), confirm_only: true })).status, 404);

  let plannerWakeups = 0; server.onPlanChanged(() => { plannerWakeups++; });
  const taskFilesBefore = existsSync(P("tasks", "inbox")) ? readdirSync(P("tasks", "inbox")) : [];
  const planPreview = await preview(entries.plans.key);
  const restoredPlan = await form("/api/archive/restore", "POST", { key: entries.plans.key, digest: planPreview.digest, request_id: crypto.randomUUID() });
  assert.equal(restoredPlan.status, 200, JSON.stringify(restoredPlan)); assert.equal(restoredPlan.data.id, planId);
  assert.equal(readPlan(planId).status, "done"); assert.deepEqual(readPlan(planId).steps, originalPlan.steps); assert.deepEqual(readPlan(planId).notes, originalPlan.notes); assert.equal(plannerWakeups, 0);
  assert.deepEqual(existsSync(P("tasks", "inbox")) ? readdirSync(P("tasks", "inbox")) : [], taskFilesBefore, "Historical plan restore must not create work");
  for (const [path, bytes] of Object.entries(immutable)) assert.equal(readFileSync(P(path)).toString("base64"), bytes, `Archive copy changed: ${path}`);
  assert.equal((await local(remote, "/fixture/pull")).data.ok, true);
  assert.equal(readPlan(planId).status, JSON.parse(readFileSync(join(remote.data, "plans", `${planId}.json`), "utf8")).status);
  assert.equal((await form("/api/archive", "POST", { kind: "plans", query: "does-not-match" })).data.total, 0);
  console.log("Archive records passed with real Worker-backed mirrors: all four kinds, immutable sources, paused routine defaults, member memory, inert plan history, identity/folder collisions, stale digests, forged keys/linked paths, partial publication replay, historical no-reapply and remote project fresh-proof/confirm-only recovery.");
} finally {
  if (worker) {
    if (worker.proc.exitCode === null) worker.proc.kill("SIGTERM");
    await Promise.race([worker.proc.exited, Bun.sleep(3000)]);
    if (worker.proc.exitCode === null) { worker.proc.kill("SIGKILL"); await worker.proc.exited; }
    const output = (await worker.output).join("\n"); assert(!output.includes(worker.token), "Fixture printed a machine credential");
  }
  for (const token of [owner, otherOwner]) await request("/api/auth/logout", "POST", {}, token).catch(() => null);
  rmSync(root, { recursive: true, force: true });
}
