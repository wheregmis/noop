// Production Worker + real RemoteFiles mirrors. Claims use core.claim; terminal transitions are fixtures, with no agents launched.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-task-forms-")), code = resolve(import.meta.dir, "../..");
const originalPath = process.env.PATH, emptyBin = join(root, "empty-bin"); mkdirSync(emptyBin); process.env.PATH = emptyBin;
const owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""), legacy = "ui-test-token";
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, primary = `forms-primary-${tag}`;
async function request(path: string, method = "GET", body?: unknown, token = owner) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(50); }
}
type Machine = { host: string; dir: string; data: string; token: string; url: string; proc: ReturnType<typeof Bun.spawn>; output: Promise<string[]> };
let worker: Machine | undefined;
async function machine(): Promise<Machine> {
  const host = `forms-worker-${tag}`, dir = join(root, "worker"), home = join(dir, "home"), data = join(dir, "data");
  for (const folder of [home, data, join(home, "accounts")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined)); const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\npoll_seconds = 0.1\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
  const entry = join(dir, "bridge.ts");
  writeFileSync(entry, `
    import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
    import {loadConfig,P,locked,_pull,_commitPush,claim,readDoc,writeDoc,now,hasRemote} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    if(!await hasRemote()||!await _pull())throw new Error('Fixture requires real RemoteFiles');
    const stopBridge=startMachineBridge(loadConfig());
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      try{
        const path=new URL(req.url).pathname,b=await req.json().catch(()=>({}));
        if(path==='/fixture/pull')return Response.json({ok:await locked(_pull)});
        if(!/^T-[\\w-]*\\d{4}$/.test(b.id||''))return Response.json({error:'invalid fixture task'},{status:400});
        if(path==='/fixture/claim'){
          if(!await locked(_pull))throw new Error('pull');
          const active=await claim(P('tasks','inbox',b.id+'.md'),${JSON.stringify(host)});
          if(!active)return Response.json({error:'claim lost'},{status:409});
          return Response.json(readDoc(active));
        }
        if(path==='/fixture/terminal')return locked(async()=>{
          if(!await _pull())throw new Error('pull');
          if(!['done','failed','cancelled'].includes(b.state))throw new Error('invalid terminal state');
          const active=P('tasks','active',b.id+'.md');if(!existsSync(active))throw new Error('no active fixture claim');
          const {meta,body}=readDoc(active),folder=b.state==='cancelled'?'rejected':b.state;
          writeDoc(P('tasks',folder,b.id+'.md'),{...meta,claimed_by:undefined,status:b.state,finished:now(),...(b.state==='cancelled'?{cancelled:now()}:{})},body+'\\n\\n## Fixture terminal event\\nNo agent was launched.\\n');
          rmSync(active);if(!await _commitPush('fixture terminal event'))throw new Error('terminal sync');
          return Response.json({id:b.id,run_id:meta.run_id,state:b.state});
        });
        return Response.json({error:'fixture route not found'},{status:404});
      }catch(error){return Response.json({error:String(error)},{status:500});}
    }});
    writeFileSync(${JSON.stringify(join(dir, "server.json"))},JSON.stringify({url:server.url.origin}));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopBridge();server.stop(true);process.exit(0);});
  `);
  const proc = Bun.spawn([process.execPath, entry], { env: { PATH: "/usr/bin:/bin", NOOP_HOME: home, HUB_DATA: data, HUB_CONF: join(home, "noop.toml"), HUB_HOST: host, HUB_SYNC: "", HUB_SYNC_FAKE: "", TMPDIR: dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const result: Machine = { host, dir, data, token, url: "", proc, output: Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]) }; worker = result;
  await until(() => existsSync(join(dir, "server.json")), "Fixture bridge did not start"); result.url = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).url;
  let ticket = "";
  await until(async () => { const ready = await request(`/api/machines/${host}/accounts`); if (ready.status === 202) ticket = ready.data.ticket; return !!ticket; }, "Fixture bridge did not advertise support");
  await until(async () => (await request(`/api/machine-requests/${ticket}`)).status === 200, "Fixture bridge did not consume its inbox");
  return result;
}
async function local(machine: Machine, path: string, body?: unknown) {
  const response = await fetch(machine.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}

process.env.NOOP_HOME = join(root, "primary-home"); process.env.HUB_DATA = join(root, "primary-data"); process.env.HUB_CONF = join(root, "primary-home", "noop.toml"); process.env.HUB_HOST = primary; process.env.HUB_SYNC = ""; process.env.HUB_SYNC_FAKE = "";
mkdirSync(process.env.NOOP_HOME, { recursive: true }); mkdirSync(process.env.HUB_DATA, { recursive: true });
writeFileSync(process.env.HUB_CONF, `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(legacy)}\n`, { mode: 0o600 });
mkdirSync(join(process.env.NOOP_HOME, "accounts")); writeFileSync(join(process.env.NOOP_HOME, "accounts/config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
const { P, locked, _pull, _commitPush, readDoc, writeDoc, hasRemote, setApprovalGate, claim } = await import("../../src/core");
const server = await import("../../src/server");
const { applyUiRequest } = await import("../../src/ui-requests");
const { dataActs, localStore } = await import("../../src/brain");
const { runTool } = await import("../src/tools");
const store = localStore({ acts: dataActs(primary), status: () => ({}), feed: () => [] });
server.setApplyOp((op) => runTool(store, op.tool, op));
const results = new Map();
const send = async (path: string, init: RequestInit) => {
  const response = await request(path, init.method, init.body ? JSON.parse(String(init.body)) : undefined, legacy);
  return response.status >= 200 && response.status < 300 ? response.data : null;
};
async function form(path: string, body?: unknown, method = "POST") {
  const queued = await request(path, method, body); assert.equal(queued.status, 202, JSON.stringify(queued));
  await applyUiRequest(queued.data.ticket, send, (req, folder) => server.recordRequest(req, undefined, folder), results);
  return { ...await request(`/api/ui-requests/${queued.data.ticket}`), ticket: queued.data.ticket };
}
async function pull() { assert.equal(await locked(_pull), true); }
const states = ["inbox", "active", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
const paths = (id: string) => states.map((state) => P("tasks", state, `${id}.md`)).filter(existsSync);
function task(id: string) { const found = paths(id); assert.equal(found.length, 1, `Task ${id} must have exactly one current record`); return readDoc(found[0]!); }
const ids = () => [...new Set(states.flatMap((state) => existsSync(P("tasks", state)) ? readdirSync(P("tasks", state)).filter((name) => /^T-.*\.md$/.test(name)).map((name) => name.slice(0, -3)) : []))].sort();
type RunSettings = { title: string; agent: string; cli: string; host: string; requires: string; priority: string; prefer: string; weight: string };
function initial(meta: Record<string, string>, settings: RunSettings, extra: string[] = []) {
  for (const field of ["title", "agent", "cli", "host", "priority", "prefer", "weight"] as const) assert.equal(meta[field], settings[field], `Initial ${field}`);
  assert.deepEqual(meta.requires.split(",").filter(Boolean).sort(), [...new Set([...settings.requires.split(",").filter(Boolean), ...extra])].sort());
  assert(Number.isFinite(Date.parse(meta.planned!)), "Explicit settings must be planned before inbox publication");
}
async function firstPublication(id: string, settings: RunSettings, extra: string[] = []) {
  const history = await request(`/api/files/history?path=${encodeURIComponent(`tasks/inbox/${id}.md`)}&content=1`); assert.equal(history.status, 200);
  const published = history.data.history.filter((row: any) => row.content != null).map((row: any) => Buffer.from(row.content, "base64").toString()); assert(published.length);
  for (const content of published) {
    for (const field of ["title", "agent", "cli", "host", "priority", "prefer", "weight"] as const) assert(content.includes(`${field}: ${settings[field]}\n`), `Published task lacked initial ${field}`);
    assert(Number.isFinite(Date.parse(content.match(/^planned: (.+)$/m)?.[1] ?? "")), "The first published inbox record must already be planned");
  }
  initial(task(id).meta, settings, extra);
}

try {
  const session = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
  assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email: "task-forms@example.com", created: Date.now(), last_seen: Date.now(), ua: "task-forms-test" }] }, legacy)).status, 200);
  assert.equal(await hasRemote(), true); await pull();
  writeFileSync(P("config.toml"), `[fleet]\nprimary = ${JSON.stringify(primary)}\n[clis]\nenabled = ["claude", "codex", "hermes"]\n`);
  mkdirSync(P("agents", "lead"), { recursive: true }); writeFileSync(P("agents", "lead", "profile.md"), "# Fixture lead\nName: Fixture\n\nOnly fixture work.\n"); mkdirSync(P("journal"), { recursive: true });
  assert.equal(await locked(() => _commitPush("fixture task form configuration")), true); setApprovalGate(() => true);
  assert.equal((await request("/api/host/state", "PUT", { status: { active: [] }, ui_api: 1 }, legacy)).status, 200);
  const remote = await machine();
  const settings = { title: "Explicit fixture task", agent: "lead", cli: "codex", host: remote.host, requires: "os:macos", priority: "high", prefer: "os:macos", weight: "heavy", project: "" };
  const create = { request_id: crypto.randomUUID(), instructions: "Create this fixture with all selected settings already saved.", settings };
  const beforeConfirm = ids();
  const absentCreate = await form("/api/tasks/create", { ...create, confirm_only: true }); assert.equal(absentCreate.status, 404); assert.deepEqual(ids(), beforeConfirm);
  assert.equal((await request("/api/tasks/create", "POST", create, remote.token)).status, 403);
  let hiddenTicket = "";
  await assert.rejects(async () => {
    const accepted = await request("/api/tasks/create", "POST", create); assert.equal(accepted.status, 202); hiddenTicket = accepted.data.ticket;
    throw new TypeError("fixture lost task creation POST reply before ticket delivery");
  }, /lost task creation POST reply/);
  await applyUiRequest(hiddenTicket, send, (req, folder) => server.recordRequest(req, undefined, folder), results);
  const originalCreate = await request(`/api/ui-requests/${hiddenTicket}`); assert.equal(originalCreate.status, 200, JSON.stringify(originalCreate));
  const createdId = originalCreate.data.id; assert.equal(originalCreate.data.action, "create"); assert.equal(originalCreate.data.applied, true);
  assert(existsSync(P("tasks", "inbox", `${createdId}.md`))); assert(!existsSync(P("tasks", "proposed", `${createdId}.md`)));
  await firstPublication(createdId, settings);
  assert(task(createdId).body.includes(create.instructions)); assert.equal(task(createdId).body.split(create.instructions).length - 1, 1);
  const replayCreate = await form("/api/tasks/create", create); assert.equal(replayCreate.status, 200); assert.equal(replayCreate.data.id, createdId); assert.equal(replayCreate.data.replayed, true);
  const claimed = await local(remote, "/fixture/claim", { id: createdId }); assert.equal(claimed.status, 200, JSON.stringify(claimed)); await pull();
  const firstRun = task(createdId).meta.run_id, activeBefore = readFileSync(P("tasks", "active", `${createdId}.md`), "utf8"); assert(firstRun);
  const claimedReplay = await form("/api/tasks/create", { ...create, confirm_only: true }); assert.equal(claimedReplay.status, 200); assert.equal(claimedReplay.data.id, createdId);
  assert.equal(readFileSync(P("tasks", "active", `${createdId}.md`), "utf8"), activeBefore);
  assert.equal((await form("/api/tasks/create", { ...create, instructions: "A changed authorization" })).status, 409); assert.equal(task(createdId).meta.run_id, firstRun);

  const partialRequest = { ...create, request_id: crypto.randomUUID(), settings: { ...settings, title: "Partially published fixture" } }, realFetch = globalThis.fetch;
  let partial: Awaited<ReturnType<typeof form>>;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/files/commit") throw new TypeError("fixture task publication interrupted");
    return realFetch(input, init);
  }) as typeof fetch;
  try { partial = await form("/api/tasks/create", partialRequest); } finally { globalThis.fetch = realFetch; }
  assert.equal(partial.status, 503, JSON.stringify(partial)); assert.equal(partial.data.saved_locally, true); assert.equal(partial.data.request_id, partialRequest.request_id);
  const partialId = partial.data.id; initial(task(partialId).meta, partialRequest.settings);
  assert.equal((await request(`/api/tasks/get?id=${encodeURIComponent(partialId)}`)).status, 404, "Unpublished task must not be visible in shared storage");
  const repaired = await form("/api/tasks/create", partialRequest); assert.equal(repaired.status, 200, JSON.stringify(repaired)); assert.equal(repaired.data.id, partialId); assert.equal(repaired.data.replayed, true);
  assert.equal((await request(`/api/ui-requests/${partial.ticket}`)).status, 503); await firstPublication(partialId, partialRequest.settings);
  assert.equal((await local(remote, "/fixture/pull")).data.ok, true); initial(readDoc(join(remote.data, "tasks", "inbox", `${partialId}.md`)).meta, partialRequest.settings);

  const projectFolder = join(remote.dir, "project"); mkdirSync(projectFolder); writeFileSync(join(projectFolder, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  const folderTicket = await request(`/api/machines/${remote.host}/project-folder-check`, "POST", { path: projectFolder }); assert.equal(folderTicket.status, 202);
  let folderResult: Awaited<ReturnType<typeof request>>;
  await until(async () => { folderResult = await request(`/api/machine-requests/${folderTicket.data.ticket}`); return folderResult.status !== 202; }, "Project folder check did not complete");
  assert.equal(folderResult!.status, 200, JSON.stringify(folderResult!));
  const project = await form("/api/projects", { name: "Task form project", host: remote.host, path: projectFolder, probe_ticket: folderResult!.data.probe_ticket, requires: ["gpu"], instructions: "Fixture project context" }); assert.equal(project.status, 200);
  const projectId = project.data.id, projectView = (await form(`/api/projects/${projectId}`, undefined, "GET")).data;
  const guardedSettings = { ...settings, title: "Project-bound fixture", project: projectId, project_guard: { host: projectView.host, path: projectView.path, requires: [...projectView.requires].sort() } };
  const projectIntent = { ...create, request_id: crypto.randomUUID(), settings: guardedSettings };
  assert.equal((await form(`/api/projects/${projectId}`, { name: projectView.name, host: remote.host, path: projectView.path, instructions: projectView.instructions, requires: ["gpu", "new-capability"] }, "PUT")).status, 200);
  const beforeGuard = ids();
  assert.equal((await form("/api/tasks/create", projectIntent)).status, 409, "A changed project must be reviewed before task creation"); assert.deepEqual(ids(), beforeGuard); assert(!existsSync(P("fleet", "task-forms", `${projectIntent.request_id}.json`)));
  const latestProject = (await form(`/api/projects/${projectId}`, undefined, "GET")).data;
  const selectedProject = { ...guardedSettings, project_guard: { host: latestProject.host, path: latestProject.path, requires: [...latestProject.requires].sort() } };
  const selectedIntent = { ...projectIntent, request_id: crypto.randomUUID(), settings: selectedProject };
  const projectTask = await form("/api/tasks/create", selectedIntent); assert.equal(projectTask.status, 200, JSON.stringify(projectTask));
  await firstPublication(projectTask.data.id, selectedProject, latestProject.requires); assert.equal(task(projectTask.data.id).meta.project, projectId); assert.equal(task(projectTask.data.id).meta.repo, latestProject.path);
  assert.equal((await local(remote, "/fixture/claim", { id: projectTask.data.id })).status, 200); await pull(); const projectRun = task(projectTask.data.id).meta.run_id;
  assert.equal((await form(`/api/projects/${projectId}`, { name: latestProject.name, host: remote.host, path: latestProject.path, instructions: latestProject.instructions, requires: ["changed-again"] }, "PUT")).status, 200);
  assert.equal((await form("/api/tasks/create", { ...selectedIntent, confirm_only: true })).status, 200); assert.equal(task(projectTask.data.id).meta.run_id, projectRun);
  assert.equal((await request("/api/tasks/create", "POST", { ...create, request_id: crypto.randomUUID(), settings: { ...settings, project: "__current__" } })).status, 400, "Only a reopen can preserve a legacy custom folder");

  const cancelledId = "T-9201", guardedId = "T-9202", legacyRepo = join(remote.dir, "legacy-repo"); mkdirSync(legacyRepo);
  await locked(async () => {
    assert.equal(await _pull(), true);
    writeDoc(P("tasks", "rejected", `${cancelledId}.md`), { id: cancelledId, title: "Cancelled fixture conversation", agent: "lead", cli: "codex", host: remote.host, run_host: remote.host, run_id: crypto.randomUUID(), repo: legacyRepo, requires: "os:macos", priority: "normal", created: new Date().toISOString(), cancelled: new Date().toISOString(), status: "cancelled" }, "Original fixture conversation.\n\n## Run 1\nHistorical result.\n");
    writeDoc(P("tasks", "done", `${guardedId}.md`), { id: guardedId, title: "Guarded fixture", agent: "lead", cli: "codex", host: remote.host, run_host: remote.host, run_id: crypto.randomUUID(), created: new Date().toISOString(), finished: new Date().toISOString(), pending_stops: JSON.stringify({ operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [{ id: "T-9299", host: remote.host, run_id: crypto.randomUUID(), done: false }], unresolved: [] }) }, "Fixture cleanup must be completed first.\n");
    assert.equal(await _commitPush("fixture terminal conversations"), true);
  });
  const guarded = await form("/api/tasks/reopen-preview", { id: guardedId }); assert.equal(guarded.status, 200); assert.equal(guarded.data.can_reopen, false); assert(guarded.data.conflicts.length);
  const blocked = await form("/api/tasks/reopen", { request_id: crypto.randomUUID(), id: guardedId, preview_digest: guarded.data.digest, instructions: "Guarded fixture follow-up", settings });
  assert.equal(blocked.status, 409); assert(existsSync(P("tasks", "done", `${guardedId}.md`)));
  const cancelled = await form("/api/tasks/reopen-preview", { id: cancelledId }); assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, "cancelled"); assert.equal(cancelled.data.can_reopen, true); assert.equal(cancelled.data.settings.project, "__current__");
  const reopen = { request_id: crypto.randomUUID(), id: cancelledId, preview_digest: cancelled.data.digest, instructions: "Continue the cancelled fixture exactly once.", settings: { ...cancelled.data.settings, title: "Reopened fixture conversation", priority: "urgent", prefer: "os:macos", weight: "heavy" } };
  const beforeReopen = ids();
  assert.equal((await form("/api/tasks/reopen", { ...reopen, request_id: crypto.randomUUID(), confirm_only: true })).status, 404); assert.deepEqual(ids(), beforeReopen);
  assert.equal((await form("/api/tasks/reopen", { ...reopen, preview_digest: guarded.data.digest })).status, 409);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/files/commit") throw new TypeError("fixture reopen publication interrupted");
    return realFetch(input, init);
  }) as typeof fetch;
  let partialReopen: Awaited<ReturnType<typeof form>>;
  try { partialReopen = await form("/api/tasks/reopen", reopen); } finally { globalThis.fetch = realFetch; }
  assert.equal(partialReopen.status, 503, JSON.stringify(partialReopen)); assert.equal(partialReopen.data.id, cancelledId); assert.equal(partialReopen.data.saved_locally, true);
  assert.deepEqual(ids(), beforeReopen); assert(existsSync(P("tasks", "inbox", `${cancelledId}.md`))); assert(!existsSync(P("tasks", "rejected", `${cancelledId}.md`)));
  const reopened = await form("/api/tasks/reopen", reopen); assert.equal(reopened.status, 200, JSON.stringify(reopened)); assert.equal(reopened.data.id, cancelledId); assert.equal(reopened.data.action, "reopen"); assert.equal(reopened.data.replayed, true);
  initial(task(cancelledId).meta, reopen.settings); assert.equal(task(cancelledId).meta.repo, legacyRepo); assert(task(cancelledId).body.includes("Historical result.")); assert.equal(task(cancelledId).body.split(reopen.instructions).length - 1, 1);
  assert.equal((await request(`/api/ui-requests/${partialReopen.ticket}`)).status, 503);
  assert.equal((await local(remote, "/fixture/claim", { id: cancelledId })).status, 200); await pull(); const oldRun = task(cancelledId).meta.run_id;
  assert.equal((await form("/api/tasks/reopen", reopen)).status, 200); assert.equal(task(cancelledId).meta.run_id, oldRun);
  assert.equal((await local(remote, "/fixture/terminal", { id: cancelledId, state: "done" })).status, 200); await pull();
  const nextPreview = await form("/api/tasks/reopen-preview", { id: cancelledId }); assert.equal(nextPreview.status, 200);
  const newer = { ...reopen, request_id: crypto.randomUUID(), preview_digest: nextPreview.data.digest, instructions: "Start a newer explicit fixture attempt.", settings: nextPreview.data.settings };
  assert.equal((await form("/api/tasks/reopen", newer)).status, 200); assert.equal((await local(remote, "/fixture/claim", { id: cancelledId })).status, 200); await pull();
  const newerRun = task(cancelledId).meta.run_id; assert.notEqual(newerRun, oldRun); const newBytes = readFileSync(P("tasks", "active", `${cancelledId}.md`), "utf8");
  assert.equal((await form("/api/tasks/reopen", { ...reopen, confirm_only: true })).status, 200); assert.equal(readFileSync(P("tasks", "active", `${cancelledId}.md`), "utf8"), newBytes);
  assert.equal((await local(remote, "/fixture/terminal", { id: cancelledId, state: "cancelled" })).status, 200); await pull(); const laterTerminal = readFileSync(P("tasks", "rejected", `${cancelledId}.md`), "utf8");
  assert.equal((await form("/api/tasks/reopen", reopen)).status, 200); assert.equal(readFileSync(P("tasks", "rejected", `${cancelledId}.md`), "utf8"), laterTerminal); assert(!existsSync(P("tasks", "inbox", `${cancelledId}.md`)));

  await locked(async () => {
    assert.equal(await _pull(), true); const doc = readDoc(P("tasks", "done", `${guardedId}.md`));
    writeDoc(P("tasks", "done", `${guardedId}.md`), { ...doc.meta, pending_stops: undefined }, doc.body); assert.equal(await _commitPush("fixture cleanup settled"), true);
  });
  const stalePreview = await form("/api/tasks/reopen-preview", { id: guardedId }); assert.equal(stalePreview.status, 200); assert.equal(stalePreview.data.can_reopen, true);
  await locked(async () => { const doc = readDoc(P("tasks", "done", `${guardedId}.md`)); writeDoc(P("tasks", "done", `${guardedId}.md`), doc.meta, doc.body + "Changed after preview.\n"); assert.equal(await _commitPush("fixture stale reopen preview"), true); });
  const staleId = crypto.randomUUID(), beforeStale = ids();
  assert.equal((await form("/api/tasks/reopen", { request_id: staleId, id: guardedId, preview_digest: stalePreview.data.digest, instructions: "Must not apply stale follow-up", settings })).status, 409);
  assert.deepEqual(ids(), beforeStale); assert(!existsSync(P("fleet", "task-forms", `${staleId}.json`))); assert(!existsSync(P("tasks", "inbox", `${guardedId}.md`)));

  const learnedId = "T-9301", legacyLearningId = "T-9302", malformedLearningId = "T-9303", ordinaryApprenticeId = "T-9304", ambiguousLearningId = "T-9305", movedLearningId = "T-9306";
  const legacyPrompt = "Learn the owner. Read the redacted digest of the owner's own messages to AI coding agents at:\n/private/fixture-only/learn/digest-legacy.md\n(local to this machine; never copy raw text or the file into the hub repo, never quote anything that looks like a secret or a private person's data).\n\nDistill durable, actionable knowledge into shared memory.\n";
  const learningRequest = crypto.randomUUID(), learningPreview = "a".repeat(64);
  await locked(async () => {
    assert.equal(await _pull(), true); mkdirSync(P("agents", "apprentice"), { recursive: true }); writeFileSync(P("agents", "apprentice", "profile.md"), "# Fixture apprentice\n");
    const meta = { agent: "apprentice", cli: "codex", host: remote.host, requires: "", priority: "normal", created: new Date().toISOString(), planned: new Date().toISOString(), source: `owner@${remote.host}` };
    writeDoc(P("tasks", "inbox", `${learnedId}.md`), { ...meta, id: learnedId, title: "Fixture private learning", learning_host: remote.host, learning_request_id: learningRequest, learning_preview: learningPreview }, legacyPrompt);
    writeDoc(P("tasks", "inbox", `${legacyLearningId}.md`), { ...meta, id: legacyLearningId, agent: "lead", title: "Historical private learning", source: `approved:owner@${remote.host}` }, legacyPrompt);
    writeDoc(P("tasks", "inbox", `${malformedLearningId}.md`), { ...meta, id: malformedLearningId, title: "Malformed private learning", learning_host: "" }, "Fixture body with an invalid explicit marker.\n");
    writeDoc(P("tasks", "inbox", `${ordinaryApprenticeId}.md`), { ...meta, id: ordinaryApprenticeId, title: "Ordinary apprentice work" }, "Explain the fixture's public roadmap. No local history or digest is needed.\n");
    writeDoc(P("tasks", "done", `${ambiguousLearningId}.md`), { ...meta, id: ambiguousLearningId, title: "Ambiguous legacy learning", source: "routine:learn", finished: new Date().toISOString() }, legacyPrompt);
    writeDoc(P("tasks", "inbox", `${movedLearningId}.md`), { ...meta, id: movedLearningId, title: "Already moved private learning", learning_host: primary, learning_request_id: crypto.randomUUID(), learning_preview: "b".repeat(64) }, legacyPrompt);
    assert.equal(await _commitPush("fixture learning host records"), true);
  });
  const learningView = await request(`/api/tasks/get?id=${learnedId}`); assert.equal(learningView.status, 200); assert.equal(learningView.data.learning_host, remote.host); assert.equal(learningView.data.target_host, remote.host);
  const configure = (id: string, host: string, project = "") => form("/api/tasks/configure", { id, title: "Owner-edited fixture task", agent: "lead", cli: "codex", host, project, requires: "", prefer: "", weight: "normal", priority: "high" });
  const unchanged = readFileSync(P("tasks", "inbox", `${learnedId}.md`), "utf8");
  const rejectedHost = await configure(learnedId, primary); assert([400, 409].includes(rejectedHost.status), JSON.stringify(rejectedHost)); assert.match(String(rejectedHost.data.error), /learning.*(?:run|machine)|private.*digest/i);
  assert.equal(readFileSync(P("tasks", "inbox", `${learnedId}.md`), "utf8"), unchanged);
  const rejectedAny = await configure(learnedId, "any"); assert([400, 409].includes(rejectedAny.status)); assert.equal(readFileSync(P("tasks", "inbox", `${learnedId}.md`), "utf8"), unchanged);
  const primaryFolder = join(root, "primary-learning-project"); mkdirSync(primaryFolder);
  const primaryProject = await form("/api/projects", { name: "Primary learning fixture project", host: primary, path: primaryFolder, instructions: "Only fixture project context." }); assert.equal(primaryProject.status, 200, JSON.stringify(primaryProject));
  assert([400, 409].includes((await configure(learnedId, primary, primaryProject.data.id)).status)); assert.equal(readFileSync(P("tasks", "inbox", `${learnedId}.md`), "utf8"), unchanged);
  const sameHost = await configure(learnedId, remote.host); assert.equal(sameHost.status, 200, JSON.stringify(sameHost)); assert.equal(sameHost.data.data.ok, true);
  assert.equal(task(learnedId).meta.learning_host, remote.host); assert.equal(task(learnedId).meta.learning_request_id, learningRequest); assert.equal(task(learnedId).meta.agent, "lead");
  assert.equal(await claim(P("tasks", "inbox", `${learnedId}.md`), primary), null, "A direct wrong-host claim must be fenced before agent startup");
  assert.equal((await local(remote, "/fixture/claim", { id: movedLearningId })).status, 409, "An already-moved record must not be claimed on its edited target");
  assert.equal((await local(remote, "/fixture/claim", { id: malformedLearningId })).status, 409, "A malformed explicit marker must fail closed");
  assert.equal((await local(remote, "/fixture/claim", { id: learnedId })).status, 200); await pull(); assert.equal(task(learnedId).meta.learning_host, remote.host);
  assert.equal((await local(remote, "/fixture/terminal", { id: learnedId, state: "done" })).status, 200); await pull();
  const learnedPreview = await form("/api/tasks/reopen-preview", { id: learnedId }); assert.equal(learnedPreview.status, 200); assert.equal(learnedPreview.data.can_reopen, true); assert.equal(learnedPreview.data.learning_host, remote.host); assert.equal(learnedPreview.data.settings.host, remote.host);
  const learnedTerminal = readFileSync(P("tasks", "done", `${learnedId}.md`), "utf8"), refusedReopenId = crypto.randomUUID();
  assert.equal((await form("/api/tasks/reopen", { request_id: refusedReopenId, id: learnedId, preview_digest: learnedPreview.data.digest, instructions: "Continue the fixture learning work.", settings: { ...learnedPreview.data.settings, host: primary } })).status, 409);
  assert.equal(readFileSync(P("tasks", "done", `${learnedId}.md`), "utf8"), learnedTerminal); assert(!existsSync(P("fleet", "task-forms", `${refusedReopenId}.json`)));
  const learnedReopen = await form("/api/tasks/reopen", { request_id: crypto.randomUUID(), id: learnedId, preview_digest: learnedPreview.data.digest, instructions: "Continue the fixture learning work on its source machine.", settings: { ...learnedPreview.data.settings, title: "Reopened fixture learning", priority: "low" } });
  assert.equal(learnedReopen.status, 200, JSON.stringify(learnedReopen)); assert.equal(task(learnedId).meta.host, remote.host); assert.equal(task(learnedId).meta.learning_host, remote.host); assert.equal(task(learnedId).meta.source, "owner@ui");
  assert([400, 409].includes((await configure(learnedId, primary)).status), "Explicit reopen must not erase the original learning host");
  const legacyBefore = readFileSync(P("tasks", "inbox", `${legacyLearningId}.md`), "utf8");
  const legacyView = await request(`/api/tasks/get?id=${legacyLearningId}`); assert.equal(legacyView.status, 200); assert.equal(legacyView.data.learning_host, remote.host);
  assert([400, 409].includes((await configure(legacyLearningId, primary)).status)); assert.equal(readFileSync(P("tasks", "inbox", `${legacyLearningId}.md`), "utf8"), legacyBefore);
  assert.equal((await configure(legacyLearningId, remote.host)).status, 200); assert.equal(task(legacyLearningId).meta.learning_host, remote.host, "A verified legacy source must be materialized before edits can erase its provenance");
  const ambiguous = await form("/api/tasks/reopen-preview", { id: ambiguousLearningId }); assert.equal(ambiguous.status, 200); assert.equal(ambiguous.data.can_reopen, false); assert(ambiguous.data.learning_host_error); assert.equal(ambiguous.data.learning_host, undefined);
  const ordinary = await configure(ordinaryApprenticeId, primary); assert.equal(ordinary.status, 200, JSON.stringify(ordinary)); assert.equal(task(ordinaryApprenticeId).meta.host, primary); assert.equal(task(ordinaryApprenticeId).meta.learning_host, undefined);
  console.log("Task forms passed with real Worker-backed mirrors: complete initial settings/planned publication, lost-reply and partial-push stable IDs, same-ID cancelled reopen/history, cleanup and stale-preview guards, real claim UUIDs, historical replay, confirmation-only safety, and tagged/legacy learning host protection through configuration, project changes, reopening and direct claims without locking ordinary apprentice work.");
} finally {
  process.env.PATH = originalPath;
  if (worker) {
    if (worker.proc.exitCode === null) worker.proc.kill("SIGTERM"); await Promise.race([worker.proc.exited, Bun.sleep(3000)]);
    if (worker.proc.exitCode === null) { worker.proc.kill("SIGKILL"); await worker.proc.exited; }
    assert(!(await worker.output).join("\n").includes(worker.token), "Fixture printed a machine credential");
  }
  await request("/api/auth/logout", "POST", {}, owner).catch(() => null); rmSync(root, { recursive: true, force: true });
}
