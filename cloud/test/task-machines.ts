// Isolated production Worker + real machine bridges/runtime controls. Agent commands are local process-tree fixtures.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-task-machines-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, primary = `task-primary-${tag}`;
const request = async (path: string, method = "GET", body?: unknown, token = owner, extra: Record<string, string> = {}) => {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, data: await response.json() as any };
};
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(50); }
}
function running(pid: number) {
  const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return !!state && !/^[ZX]/.test(state);
}
type Run = { id: string; run_id: string; host: string; tree: string; parent: number; child: number };
type Machine = { host: string; dir: string; data: string; token: string; url: string; proc: ReturnType<typeof Bun.spawn>; output: Promise<string[]> };
const machines: Machine[] = [];
const jsonLines = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const uploads = (machine: Machine, run: Run) => jsonLines(join(machine.dir, "result-tickets.jsonl")).filter((row) => row.result.data?.id === run.id && row.result.data?.run_id === run.run_id);
const controls = (machine: Machine, run: Run) => jsonLines(join(machine.dir, "controls.jsonl")).filter((row) => row.id === run.id && row.expected?.run_id === run.run_id);
async function local(machine: Machine, path: string, body?: unknown) {
  const response = await fetch(machine.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, data: await response.json() as any };
}
async function machine(label: string): Promise<Machine> {
  const host = `task-${label}-${tag}`, dir = join(root, label), home = join(dir, "home"), data = join(dir, "data");
  for (const folder of [home, data, join(home, "accounts"), join(dir, "runs")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined));
  const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
  writeFileSync(join(data, "config.toml"), `[host]\nname = ${JSON.stringify(host)}\n[cloud]\npoll_seconds = 0.1\n`);
  const leaf = join(dir, "leaf.ts"), agent = join(dir, "agent.ts"), entry = join(dir, "bridge.ts");
  writeFileSync(leaf, `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const tree=process.env.FIXTURE_TREE;
    process.on('SIGTERM',()=>{appendFileSync(tree+'.signals','leaf TERM\\n');setTimeout(()=>{writeFileSync(tree+'.leaf-exited','yes');process.exit(0);},350);});
    writeFileSync(tree+'.leaf-ready',String(process.pid)); setInterval(()=>{},1000);
  `);
  writeFileSync(agent, `
    import {appendFileSync,writeFileSync} from 'node:fs';
    const tree=process.env.FIXTURE_TREE;
    process.on('SIGTERM',()=>{appendFileSync(tree+'.signals','parent TERM\\n');setTimeout(()=>process.exit(0),100);});
    const child=Bun.spawn([process.execPath,${JSON.stringify(leaf)}],{env:{...process.env},stdin:'ignore',stdout:'ignore',stderr:'ignore'});
    writeFileSync(tree,JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);
  `);
  writeFileSync(entry, `
    import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {loadConfig,P,writeDoc} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {registerTaskRun,createTaskControl,stopTaskRun} from ${JSON.stringify(join(code, "src/task-runs.ts"))};
    import {runAgent} from ${JSON.stringify(join(code, "src/runner.ts"))};
    import {setCancelTask,taskControlRequest,recordRequest} from ${JSON.stringify(join(code, "src/server.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    const dir=${JSON.stringify(dir)},host=${JSON.stringify(host)},cfg=loadConfig(),runs=[];
    cfg.clis={...cfg.clis,timeout_minutes:10,stall_minutes:10,claude:{command:[process.execPath,${JSON.stringify(agent)}]}};
    mkdirSync(P('journal'),{recursive:true});
    const io={pull:async()=>true,push:async()=>!existsSync(join(dir,'fail-sync'))};
    const control=createTaskControl(cfg,host,io);
    setCancelTask(async(id,done,expected)=>{appendFileSync(join(dir,'controls.jsonl'),JSON.stringify({id,done,expected})+'\\n');return control(id,done,expected);});
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      const match=path.match(/^\\/api\\/host\\/machine-requests\\/([a-f0-9-]{36})$/);
      if(match&&init?.method==='PUT'){
        const result=JSON.parse(String(init.body));
        appendFileSync(join(dir,'result-tickets.jsonl'),JSON.stringify({ticket:match[1],result})+'\\n');
        if(result.data?.run_id&&existsSync(join(dir,'hold-results'))) throw new Error('fixture result upload interrupted');
      }
      return originalFetch(input,init);
    };
    const stopBridge=startMachineBridge(cfg,{taskReady:()=>true});
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      try{
        const path=new URL(req.url).pathname;
        if(path==='/fixture/pause-bridge'){stopBridge();return Response.json({ok:true});}
        if(path==='/fixture/start'){
          const {id}=await req.json(),run_id=crypto.randomUUID(),tree=join(dir,'runs',run_id+'.json');
          for(const state of ['inbox','waiting','blocked','proposed','done','failed','rejected'])rmSync(P('tasks',state,id+'.md'),{force:true});
          writeDoc(P('tasks','active',id+'.md'),{id,title:'Fixture task',claimed_by:host,run_host:host,run_id,started:new Date().toISOString()},'Fixture task body.');
          const run=registerTaskRun({id,host,run_id});runs.push(run);
          void runAgent('claude','fixture',dir,cfg,P('logs','runs',id+'-'+Date.now()+'.log'),false,{FIXTURE_TREE:tree},run).catch(error=>writeFileSync(tree+'.error',String(error)));
          const end=Date.now()+5000;while(!existsSync(tree)||!existsSync(tree+'.leaf-ready')){if(Date.now()>end)throw new Error('Fixture process tree did not start');await Bun.sleep(25);}
          return Response.json({id,host,run_id,tree,...JSON.parse(readFileSync(tree,'utf8'))});
        }
        if(path==='/api/tasks/cancel')return recordRequest(req,io);
        return taskControlRequest(req);
      }catch(error){return Response.json({error:String(error)},{status:500});}
    }});
    writeFileSync(join(dir,'server.json'),JSON.stringify({url:server.url.origin}));
    let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;stopBridge();await Promise.all(runs.map(stopTaskRun));server.stop(true);process.exit(0);});
  `);
  const proc = Bun.spawn([process.execPath, entry], { env: { PATH: "/usr/bin:/bin", NOOP_HOME: home, HUB_DATA: data, HUB_CONF: join(home, "noop.toml"), HUB_HOST: host, HUB_SYNC: "local", TMPDIR: dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const result = { host, dir, data, token, url: "", proc, output }; machines.push(result);
  await until(() => existsSync(join(dir, "server.json")), "Fixture task runtime did not start");
  result.url = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")).url;
  let ticket = "";
  await until(async () => { const ready = await request(`/api/machines/${host}/accounts`); if (ready.status === 202) ticket = ready.data.ticket; return !!ticket; }, "Fixture bridge did not report support");
  await until(async () => (await request(`/api/machine-requests/${ticket}`)).status === 200, "Fixture bridge did not consume its inbox");
  return result;
}
async function start(machine: Machine, id: string): Promise<Run> {
  const result = await local(machine, "/fixture/start", { id }); assert.equal(result.status, 200, JSON.stringify(result));
  assert(running(result.data.parent)); assert(running(result.data.child)); return result.data;
}
function stopped(run: Run) { assert(!running(run.parent), "Agent must exit before confirmation"); assert(!running(run.child), "Descendant must exit before confirmation"); }
function selectedOnly(machine: Machine, run: Run) {
  const rows = uploads(machine, run); assert(rows.length > 0);
  for (const other of machines.filter((candidate) => candidate !== machine)) {
    const otherRows = jsonLines(join(other.dir, "result-tickets.jsonl"));
    for (const row of rows) assert(!otherRows.some((candidate) => candidate.ticket === row.ticket), "Another machine handled the selected run's ticket");
  }
}

// Import the primary owner route only after isolating its runtime/data configuration.
process.env.NOOP_HOME = join(root, "primary-home"); process.env.HUB_DATA = join(root, "primary-data"); process.env.HUB_CONF = join(root, "primary-home", "noop.toml"); process.env.HUB_SYNC = "local";
mkdirSync(process.env.NOOP_HOME, { recursive: true }); mkdirSync(process.env.HUB_DATA, { recursive: true });
writeFileSync(process.env.HUB_CONF, `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(legacy)}\n`, { mode: 0o600 });
writeFileSync(join(process.env.HUB_DATA, "config.toml"), `[host]\nname = ${JSON.stringify(primary)}\n`);
const { P, loadConfig, readDoc, writeDoc } = await import("../../src/core");
const { recordRequest, setCancelTask } = await import("../../src/server");
const { createTaskControl } = await import("../../src/task-runs");
const { delegateTaskControl } = await import("../../src/machine-bridge");
const { applyUiRequest } = await import("../../src/ui-requests");
const cfg = loadConfig(), io = { pull: async () => true, push: async () => true };
mkdirSync(P("journal"), { recursive: true }); setCancelTask(createTaskControl(cfg, primary, io));
function mirror(machine: Machine, run: Run) {
  const doc = readDoc(join(machine.data, "tasks", "active", `${run.id}.md`));
  for (const state of ["inbox", "waiting", "blocked", "proposed", "done", "failed", "rejected"]) rmSync(P("tasks", state, `${run.id}.md`), { force: true });
  writeDoc(P("tasks", "active", `${run.id}.md`), doc.meta, doc.body);
}
async function localOwner(body: unknown, key?: string) {
  const response = await recordRequest(new Request("http://primary/api/tasks/cancel", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }), io);
  assert(response); return { status: response.status, data: await response.json() as any };
}
const uiResults = new Map();
const send = async (path: string, init: RequestInit) => {
  const result = await request(path, init.method, init.body ? JSON.parse(String(init.body)) : undefined, legacy);
  return result.status >= 200 && result.status < 300 ? result.data : null;
};
async function cloudOwner(body: unknown) {
  const queued = await request("/api/tasks/cancel", "POST", body); assert.equal(queued.status, 202, JSON.stringify(queued));
  await applyUiRequest(queued.data.ticket, send, (req, folder) => recordRequest(req, io, folder), uiResults);
  return request(`/api/ui-requests/${queued.data.ticket}`);
}

try {
  const session = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
  assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email: "task-machines@example.com", created: Date.now(), last_seen: Date.now(), ua: "task-machines-test" }] }, legacy)).status, 200);
  assert.equal((await request("/api/host/state", "PUT", { status: { active: [] }, ui_api: 1 }, legacy)).status, 200);
  const [a, b] = await Promise.all([machine("a"), machine("b")]);
  const old = await start(a, "T-8101"), other = await start(b, "T-8101"); mirror(a, old);
  writeFileSync(join(a.dir, "hold-results"), "hold");
  const queued = await request("/api/tasks/cancel", "POST", { id: old.id, host: old.host, run_id: old.run_id }); assert.equal(queued.status, 202);
  const applying = applyUiRequest(queued.data.ticket, send, (req, folder) => recordRequest(req, io, folder), uiResults);
  await until(() => uploads(a, old).length > 0, "Worker did not finish its real stop operation");
  stopped(old);
  assert.equal((await request(`/api/ui-requests/${queued.data.ticket}`)).status, 202, "An unconfirmed worker result must not look finished");
  const retry = await start(a, old.id); rmSync(join(a.dir, "hold-results"));
  await applying;
  const cancelled = await request(`/api/ui-requests/${queued.data.ticket}`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled)); assert.deepEqual(cancelled.data, { ok: true, id: old.id, run_id: old.run_id, result: "cancelled" });
  stopped(old); assert(running(retry.parent)); assert(running(retry.child)); assert(running(other.parent)); assert(running(other.child));
  assert.equal(controls(a, old).length, 1, "A failed result upload must not stop a run twice");
  const attempts = uploads(a, old); assert(attempts.length >= 2); for (const row of attempts) assert.deepEqual(row, attempts[0]); selectedOnly(a, old);
  assert.equal(readDoc(join(a.data, "tasks", "active", `${old.id}.md`)).meta.run_id, retry.run_id);

  const wrong = await delegateTaskControl(cfg, { host: a.host, id: retry.id, run_id: crypto.randomUUID(), done: false });
  assert.equal(wrong.status, 409, JSON.stringify(wrong)); assert(running(retry.parent));
  const wrongHost = await delegateTaskControl(cfg, { host: b.host, id: retry.id, run_id: retry.run_id, done: false });
  assert.equal(wrongHost.status, 409); assert(running(other.parent));
  const localWrongHost = await local(a, `/api/machines/${b.host}/task-control`, { id: retry.id, run_id: retry.run_id, done: false });
  assert.equal(localWrongHost.status, 409); assert(running(retry.parent));
  for (const token of [owner, a.token]) assert.equal((await request("/api/host/task-controls", "POST", { host: a.host, id: retry.id, run_id: retry.run_id, done: false }, token)).status, 403);

  mirror(b, other);
  const done = await localOwner({ id: other.id, host: other.host, run_id: other.run_id, done: true });
  assert.equal(done.status, 200, JSON.stringify(done)); assert.deepEqual(done.data, { ok: true, id: other.id, run_id: other.run_id, result: "done" });
  stopped(other); assert(running(retry.parent)); selectedOnly(b, other);
  assert.equal(readDoc(join(b.data, "tasks", "done", `${other.id}.md`)).meta.run_id, other.run_id);

  const partialRun = await start(a, "T-8102"); mirror(a, partialRun); writeFileSync(join(a.dir, "fail-sync"), "fail");
  const partialBody = { id: partialRun.id, host: partialRun.host, run_id: partialRun.run_id, done: false };
  const partial = await cloudOwner(partialBody); assert.equal(partial.status, 503, JSON.stringify(partial));
  assert.equal(partial.data.id, partialRun.id); assert.equal(partial.data.run_id, partialRun.run_id); assert.equal(partial.data.saved_locally, true); stopped(partialRun);
  const terminal = readFileSync(join(a.data, "tasks", "rejected", `${partialRun.id}.md`), "utf8");
  rmSync(join(a.dir, "fail-sync")); const partialAgain = await cloudOwner(partialBody);
  assert.equal(partialAgain.status, 503); assert.equal(partialAgain.data.id, partialRun.id); assert.equal(partialAgain.data.run_id, partialRun.run_id);
  assert.equal(readFileSync(join(a.data, "tasks", "rejected", `${partialRun.id}.md`), "utf8"), terminal);
  assert.equal(controls(a, partialRun).length, 1); selectedOnly(a, partialRun);
  assert(!existsSync(P("tasks", "rejected", `${partialRun.id}.md`)), "The primary must not fabricate another machine's terminal state");

  const queuedId = "T-8104", cloudKey = `queued-cloud-${crypto.randomUUID()}`, queuedBody = { id: queuedId };
  writeDoc(P("tasks", "inbox", `${queuedId}.md`), { id: queuedId, title: "Queued before lost cloud response" }, "Cancel once before this task is reopened.");
  let originalTicket = "", forwardedKey = "";
  // The fixture drops the first reply before its client can retain the ticket, while the actual primary consumes the job.
  await assert.rejects(async () => {
    const accepted = await request("/api/tasks/cancel", "POST", queuedBody, owner, { "Idempotency-Key": cloudKey });
    assert.equal(accepted.status, 202, JSON.stringify(accepted)); originalTicket = accepted.data.ticket;
    await applyUiRequest(originalTicket, send, (req, folder) => {
      forwardedKey = req.headers.get("Idempotency-Key") ?? "";
      return recordRequest(req, io, folder);
    }, uiResults);
    throw new TypeError("fixture lost initial cloud POST reply");
  }, /lost initial cloud POST reply/);
  assert.equal(forwardedKey, `ui-${originalTicket}`);
  const originalResult = await request(`/api/ui-requests/${originalTicket}`);
  assert.equal(originalResult.status, 200); assert.deepEqual(originalResult.data, { ok: true, id: queuedId, result: "cancelled" });
  const afterCloudLoss = await start(a, queuedId); mirror(a, afterCloudLoss);
  const replayedPost = await request("/api/tasks/cancel", "POST", queuedBody, owner, { "Idempotency-Key": cloudKey });
  assert.equal(replayedPost.status, 202); assert.equal(replayedPost.data.ticket, originalTicket, "A lost initial response must not create another UI command");
  await applyUiRequest(replayedPost.data.ticket, send, (req, folder) => recordRequest(req, io, folder), uiResults);
  assert.deepEqual(await request(`/api/ui-requests/${replayedPost.data.ticket}`), originalResult);
  // Even duplicate primary delivery is guarded by the actual local receipt carrying the cloud UI ticket.
  assert.deepEqual(await localOwner(queuedBody, forwardedKey), originalResult);
  assert.equal((await request("/api/tasks/cancel", "POST", { ...queuedBody, done: true }, owner, { "Idempotency-Key": cloudKey })).status, 409);
  assert(running(afterCloudLoss.parent)); assert(running(afterCloudLoss.child)); assert.equal(controls(a, afterCloudLoss).length, 0);
  assert.equal(readDoc(P("tasks", "active", `${queuedId}.md`)).meta.run_id, afterCloudLoss.run_id);
  assert.equal(readDoc(join(a.data, "tasks", "active", `${queuedId}.md`)).meta.run_id, afterCloudLoss.run_id);

  const localId = "T-8105", localKey = `queued-local-${crypto.randomUUID()}`, localBody = { id: localId };
  writeDoc(P("tasks", "inbox", `${localId}.md`), { id: localId, title: "Queued before lost local response" }, "Cancel exactly once locally.");
  await assert.rejects(async () => {
    const accepted = await localOwner(localBody, localKey); assert.equal(accepted.status, 200);
    throw new TypeError("fixture lost initial local POST reply");
  }, /lost initial local POST reply/);
  const afterLocalLoss = await start(b, localId); mirror(b, afterLocalLoss);
  const localReplay = await localOwner(localBody, localKey);
  assert.deepEqual(localReplay, { status: 200, data: { ok: true, id: localId, result: "cancelled" } });
  assert.equal((await localOwner({ ...localBody, done: true }, localKey)).status, 409);
  assert(running(afterLocalLoss.parent)); assert(running(afterLocalLoss.child)); assert.equal(controls(b, afterLocalLoss).length, 0);
  assert.equal(readDoc(P("tasks", "active", `${localId}.md`)).meta.run_id, afterLocalLoss.run_id);
  assert.equal(readDoc(join(b.data, "tasks", "active", `${localId}.md`)).meta.run_id, afterLocalLoss.run_id);

  const outdatedHost = `task-outdated-${tag}`, outdated = await request("/api/host/join", "POST", { host: outdatedHost }); assert.equal(outdated.status, 200);
  for (const state of [{ account_api: 1 }, { account_api: 1, project_api: 1, task_api: 1 }]) {
    assert.equal((await request("/api/host/machine-state", "PUT", state, outdated.data.token)).status, 200);
    const outdatedControl = await delegateTaskControl(cfg, { host: outdatedHost, id: "T-8103", run_id: crypto.randomUUID(), done: false });
    assert.equal(outdatedControl.status, 409); assert.match(String(outdatedControl.data.error), /update.*related work/i);
  }

  await local(a, "/fixture/pause-bridge");
  let clock = Date.now();
  // Advance only the delegate's injected deadline; Worker receipt/heartbeat time remains real.
  const disconnected = await delegateTaskControl(cfg, { host: a.host, id: retry.id, run_id: retry.run_id, done: true }, { now: () => clock, sleep: async () => { clock += 150_001; } });
  assert.equal(disconnected.status, 503); assert.equal(disconnected.data.uncertain, true); assert.equal(disconnected.data.run_id, retry.run_id);
  assert(running(retry.parent)); assert(running(retry.child)); assert.equal(readDoc(join(a.data, "tasks", "active", `${retry.id}.md`)).meta.run_id, retry.run_id);
  console.log("Two machine task control passed: real process-tree shutdown before local/cloud owner confirmation, selected-child dispatch, wrong host/run rejection, replacement-run safety, cached result upload, stable partial-sync identity, lost initial cloud/local POST replay without stopping newer runs, outdated worker rejection and disconnected-channel uncertainty.");
} finally {
  for (const machine of machines) if (machine.proc.exitCode === null) machine.proc.kill("SIGTERM");
  for (const machine of machines) {
    await Promise.race([machine.proc.exited, Bun.sleep(5000)]);
    if (machine.proc.exitCode === null) { machine.proc.kill("SIGKILL"); await machine.proc.exited; }
    // These PIDs came only from this fixture's isolated run directory; clean up even if a bridge crashed early.
    for (const name of readdirSync(join(machine.dir, "runs")).filter((name) => name.endsWith(".json"))) {
      const tree = JSON.parse(readFileSync(join(machine.dir, "runs", name), "utf8"));
      for (const pid of [tree.child, tree.parent]) if (running(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* Exited during cleanup. */ }
    }
    const output = (await machine.output).join("\n"); if (machine.proc.exitCode) console.error(output);
    assert(!output.includes(machine.token), "Fixture process output contained a machine credential");
  }
  await request("/api/auth/logout", "POST", {}, owner).catch(() => null);
  rmSync(root, { recursive: true, force: true });
}
