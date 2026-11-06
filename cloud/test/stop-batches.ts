// Production Worker, real RemoteFiles mirrors, real bridges/runtime stop controls; agent executables are process fixtures.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const processProbe = Bun.spawnSync(["/bin/ps", "-o", "pid=", "-p", String(process.pid)]);
assert.equal(processProbe.exitCode, 0, "Process-table access is required before starting fixture agents");
assert.equal(Number(processProbe.stdout.toString().trim()), process.pid);
const root = mkdtempSync(join(tmpdir(), "noop-stop-batches-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, primary = `stop-primary-${tag}`;
const taskPrefix = Date.now().toString().slice(-8), id = (n: number) => `T-${taskPrefix}${n}`;
async function request(path: string, method = "GET", body?: unknown, token = owner, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(50); }
}
function running(pid: number) {
  const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return !!state && !/^[ZX]/.test(state);
}
type Run = { id: string; host: string; run_id: string; parent: number; child: number; tree: string };
type Machine = { host: string; dir: string; home: string; data: string; token: string; entry: string; url: string; proc: ReturnType<typeof Bun.spawn>; outputs: Promise<string[]>[] };
const machines: Machine[] = [];
const jsonLines = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
async function local(machine: Machine, path: string, body?: unknown) {
  const response = await fetch(machine.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function launch(machine: Machine) {
  rmSync(join(machine.dir, "server.json"), { force: true });
  const proc = Bun.spawn([process.execPath, machine.entry], { env: { PATH: "/usr/bin:/bin", NOOP_HOME: machine.home, HUB_DATA: machine.data, HUB_CONF: join(machine.home, "noop.toml"), HUB_HOST: machine.host, HUB_SYNC: "", HUB_SYNC_FAKE: "", TMPDIR: machine.dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  machine.proc = proc;
  machine.outputs.push(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]));
  await until(() => existsSync(join(machine.dir, "server.json")), "Bridge startup/recovery did not finish");
  machine.url = JSON.parse(readFileSync(join(machine.dir, "server.json"), "utf8")).url;
  let ticket = "";
  await until(async () => { const ready = await request(`/api/machines/${machine.host}/accounts`); if (ready.status === 202) ticket = ready.data.ticket; return !!ticket; }, "Bridge did not advertise account support");
  await until(async () => (await request(`/api/machine-requests/${ticket}`)).status === 200, "Bridge did not consume its inbox");
}
async function machine(label: string): Promise<Machine> {
  const host = `stop-${label}-${tag}`, dir = join(root, label), home = join(dir, "home"), data = join(dir, "data");
  for (const folder of [home, data, join(home, "accounts"), join(dir, "runs")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined));
  const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\npoll_seconds = 0.1\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), '{"claude":[],"codex":[],"hermes":[]}', { mode: 0o600 });
  const leaf = join(dir, "leaf.ts"), agent = join(dir, "agent.ts"), entry = join(dir, "bridge.ts");
  writeFileSync(leaf, "setInterval(()=>{},1000);\n");
  writeFileSync(agent, `
    import {writeFileSync} from 'node:fs';
    const child=Bun.spawn([process.execPath,${JSON.stringify(leaf)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});
    writeFileSync(process.env.FIXTURE_TREE,JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);
  `);
  writeFileSync(entry, `
    import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {loadConfig,P,locked,_pull,_commitPush,readDoc,writeDoc,hasRemote} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {registerTaskRun,createTaskControl,stopTaskRun} from ${JSON.stringify(join(code, "src/task-runs.ts"))};
    import {runAgent} from ${JSON.stringify(join(code, "src/runner.ts"))};
    import {recoverTaskRuns} from ${JSON.stringify(join(code, "src/cli.ts"))};
    import {reopenTask} from ${JSON.stringify(join(code, "src/brain.ts"))};
    import {setCancelTask,taskControlRequest} from ${JSON.stringify(join(code, "src/server.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    const dir=${JSON.stringify(dir)},host=${JSON.stringify(host)},runs=[];
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      if(path==='/api/files/commit'&&existsSync(join(dir,'fail-commits')))throw new Error('fixture files commit disconnected');
      const match=path.match(/^\\/api\\/host\\/machine-requests\\/([a-f0-9-]{36})$/);
      if(match&&init?.method==='PUT')appendFileSync(join(dir,'results.jsonl'),JSON.stringify({ticket:match[1],result:JSON.parse(String(init.body))})+'\\n');
      return originalFetch(input,init);
    };
    if(!await hasRemote())throw new Error('Fixture must use real remote synchronization');
    if(!await _pull())throw new Error('Initial remote pull failed');
    const cfg=loadConfig();
    cfg.clis={...cfg.clis,timeout_minutes:10,stall_minutes:10,claude:{command:[process.execPath,${JSON.stringify(agent)}]}};
    mkdirSync(P('journal'),{recursive:true});setCancelTask(createTaskControl(cfg,host));
    await recoverTaskRuns(host);
    let stopBridge=startMachineBridge(cfg,{taskReady:()=>true});
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      try{
        const path=new URL(req.url).pathname,b=await req.json().catch(()=>({}));
        if(path==='/fixture/pause'){stopBridge();return Response.json({ok:true});}
        if(path==='/fixture/resume'){stopBridge();stopBridge=startMachineBridge(cfg,{taskReady:()=>true});return Response.json({ok:true});}
        if(path==='/fixture/pull')return Response.json({ok:await locked(_pull)});
        if(path==='/fixture/push')return Response.json({ok:await locked(async()=>await _pull()&&await _commitPush('fixture sync retry'))});
        if(path==='/fixture/reopen'){
          await locked(async()=>{if(!await _pull())throw new Error('pull');const file=['done','rejected'].map(state=>P('tasks',state,b.id+'.md')).find(existsSync);reopenTask(file,'Fixture follow-up');await _commitPush('fixture reopen');});
          return Response.json({ok:true});
        }
        if(path==='/fixture/start'||path==='/fixture/replace'){
          const old=runs.findLast(run=>run.id===b.id&&!run.stopped);if(old){if(path!=='/fixture/replace')throw new Error('Run already active');if(!await stopTaskRun(old))throw new Error('Old fixture run did not stop');}
          const run_id=crypto.randomUUID(),tree=join(dir,'runs',run_id+'.json');
          await locked(async()=>{
            if(!await _pull())throw new Error('pull');
            for(const state of ['inbox','waiting','blocked','proposed','done','failed','rejected'])rmSync(P('tasks',state,b.id+'.md'),{force:true});
            writeDoc(P('tasks','active',b.id+'.md'),{id:b.id,title:'Fixture shared task',agent:'lead',claimed_by:host,run_host:host,run_id,started:new Date().toISOString(),...(b.children?{children:b.children.join(',')}:{}),...(b.parent?{parent:b.parent}:{})},'Fixture task body.');
            if(!await _commitPush('fixture register shared run'))throw new Error('Run claim sync failed');
          });
          const run=registerTaskRun({id:b.id,host,run_id});runs.push(run);
          void runAgent('claude','fixture',dir,cfg,P('logs','runs',b.id+'-'+Date.now()+'.log'),false,{FIXTURE_TREE:tree},run).catch(error=>writeFileSync(tree+'.error',String(error)));
          const end=Date.now()+5000;while(!existsSync(tree)){if(Date.now()>end)throw new Error('Process fixture did not start');await Bun.sleep(25);}
          return Response.json({id:b.id,host,run_id,tree,...JSON.parse(readFileSync(tree,'utf8'))});
        }
        return taskControlRequest(new Request(req.url,{method:req.method,headers:req.headers,body:JSON.stringify(b)}));
      }catch(error){return Response.json({error:String(error)},{status:typeof error?.status==='number'?error.status:500});}
    }});
    writeFileSync(join(dir,'server.json'),JSON.stringify({url:server.url.origin}));
    let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;stopBridge();await Promise.all(runs.map(stopTaskRun));server.stop(true);process.exit(0);});
  `);
  const result: Machine = { host, dir, home, data, token, entry, url: "", proc: undefined as unknown as ReturnType<typeof Bun.spawn>, outputs: [] };
  machines.push(result); await launch(result); return result;
}
async function start(machine: Machine, task: string, children: string[] = [], parent?: string, replace = false): Promise<Run> {
  const result = await local(machine, replace ? "/fixture/replace" : "/fixture/start", { id: task, children, parent });
  assert.equal(result.status, 200, JSON.stringify(result)); assert(running(result.data.parent)); assert(running(result.data.child)); return result.data;
}
function stopped(run: Run) { assert(!running(run.parent), "Agent still running after confirmation"); assert(!running(run.child), "Descendant still running after confirmation"); }
async function disableChannel(machine: Machine) {
  assert.equal((await local(machine, "/fixture/pause")).status, 200);
  assert.equal((await request("/api/host/machine-state", "PUT", { account_api: 1 }, machine.token)).status, 200);
}
async function history(path: string) {
  const result = await request(`/api/files/history?path=${encodeURIComponent(path)}&content=1`); assert.equal(result.status, 200);
  return result.data.history.map((entry: any) => ({ ...entry, text: entry.content == null ? "" : Buffer.from(entry.content, "base64").toString() }));
}

process.env.NOOP_HOME = join(root, "primary-home"); process.env.HUB_DATA = join(root, "primary-data"); process.env.HUB_CONF = join(root, "primary-home", "noop.toml"); process.env.HUB_HOST = primary; process.env.HUB_SYNC = ""; process.env.HUB_SYNC_FAKE = "";
mkdirSync(process.env.NOOP_HOME, { recursive: true }); mkdirSync(process.env.HUB_DATA, { recursive: true });
writeFileSync(process.env.HUB_CONF, `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(legacy)}\n`, { mode: 0o600 });
const { P, loadConfig, locked, _pull, _commitPush, readDoc, writeDoc, hasRemote } = await import("../../src/core");
const server = await import("../../src/server");
const { createTaskControl } = await import("../../src/task-runs");
const { createStopDrainer } = await import("../../src/task-stops");
const { readPendingStops, hasPendingStops } = await import("../../src/stop-intents");
const { savePlan, readPlan } = await import("../../src/plans");
const { applyUiRequest } = await import("../../src/ui-requests");
const cfg = loadConfig(); cfg.fleet = { ...cfg.fleet, primary };
const control = createTaskControl(cfg, primary), drain = createStopDrainer(cfg, primary, control);
server.setCancelTask(control);
server.setStopDrainer(drain);
const uiResults = new Map();
const send = async (path: string, init: RequestInit) => {
  const response = await request(path, init.method, init.body ? JSON.parse(String(init.body)) : undefined, legacy);
  return response.status >= 200 && response.status < 300 ? response.data : null;
};
async function form(path: string, method = "GET", body?: unknown) {
  const accepted = await request(path, method, body, owner, { "Idempotency-Key": `fixture-${crypto.randomUUID()}` }); assert.equal(accepted.status, 202, JSON.stringify(accepted));
  await applyUiRequest(accepted.data.ticket, send, (req, folder) => server.recordRequest(req, undefined, folder), uiResults);
  return { ...await request(`/api/ui-requests/${accepted.data.ticket}`), ticket: accepted.data.ticket };
}
async function pull() { assert.equal(await locked(_pull), true); }
function pendingTask(task: string) {
  const file = ["rejected", "done", "active", "inbox"].map((state) => P("tasks", state, `${task}.md`)).find(existsSync);
  assert(file); return readPendingStops(readDoc(file).meta.pending_stops);
}
async function seedPlan(plan: string, run: Run) {
  await locked(async () => {
    assert.equal(await _pull(), true);
    savePlan({ id: plan, goal: "Fixture cancellation recovery", agent: "lead", status: "running", branch: "fixture", created: new Date().toISOString(), notes: [], next_step: 2,
      steps: [{ id: "s1", title: "Fixture running step", details: "Use only fixture processes.", agent: "lead", checkpoint: false, status: "running", attempt: 1, task: run.id }] });
    assert.equal(await _commitPush("fixture running plan"), true);
  });
}
function assertBound(batch: ReturnType<typeof readPendingStops>, expected: Run[]) {
  assert(batch, "Pending stop batch must survive in shared data");
  for (const run of expected) assert(batch.pending.some((target) => target.id === run.id && target.host === run.host && target.run_id === run.run_id));
}

try {
  const session = new Bun.CryptoHasher("sha256").update(owner).digest("hex");
  assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email: "stop-batches@example.com", created: Date.now(), last_seen: Date.now(), ua: "stop-batches-test" }] }, legacy)).status, 200);
  assert.equal(await hasRemote(), true); await pull();
  writeFileSync(P("config.toml"), `[fleet]\nprimary = ${JSON.stringify(primary)}\n`);
  mkdirSync(P("agents", "lead"), { recursive: true }); writeFileSync(P("agents", "lead", "profile.md"), "# Fixture lead\n"); mkdirSync(P("journal"), { recursive: true });
  assert.equal(await locked(() => _commitPush("fixture fleet configuration")), true);
  assert.equal((await request("/api/host/state", "PUT", { status: { active: [] }, ui_api: 1 }, legacy)).status, 200);
  const capabilities = await form("/api/stops/capabilities");
  assert.equal(capabilities.status, 200, JSON.stringify(capabilities)); assert.deepEqual(capabilities.data, { family_stops: 1, family_reviews: 1 });
  const a = await machine("a"), b = await machine("b");
  const parentId = id(1), childId = id(2), grandchildId = id(3);
  const grandchild = await start(b, grandchildId, [], childId), child = await start(b, childId, [grandchildId], parentId), parent = await start(a, parentId, [childId]);
  await disableChannel(b);
  const cancelled = await form("/api/tasks/cancel", "POST", { id: parent.id, host: parent.host, run_id: parent.run_id });
  assert.equal(cancelled.status, 503, JSON.stringify(cancelled)); assert.equal(cancelled.data.saved_locally, true); stopped(parent);
  assert(running(child.parent)); assert(running(grandchild.parent)); await pull();
  const parentBatch = pendingTask(parent.id); assertBound(parentBatch, [child, grandchild]);
  assert((await history(`tasks/rejected/${parent.id}.md`)).some((entry: any) => entry.by === a.host && entry.text.includes(parentBatch!.operation_id)), "Worker A must publish its pending parent batch through RemoteFiles");
  const blockedReopen = await local(a, "/fixture/reopen", { id: parent.id });
  assert.notEqual(blockedReopen.status, 200); assert.match(String(blockedReopen.data.error), /still stopping|cleanup/i);
  assert.equal((await local(b, "/fixture/pull")).data.ok, true);
  for (const run of [child, grandchild]) {
    const intent = JSON.parse(readDoc(join(b.data, "tasks", "active", `${run.id}.md`)).meta.stop_intent);
    assert.equal(intent.run_id, run.run_id); assert.equal(intent.operation_id, parentBatch!.operation_id);
  }
  // The daemon dies while its detached agent trees live; startup must recover the shared exact-run stop intent.
  b.proc.kill("SIGKILL"); await b.proc.exited; assert(running(child.parent)); assert(running(grandchild.parent));
  await launch(b); stopped(child); stopped(grandchild); await pull();
  for (const run of [child, grandchild]) {
    assert(!existsSync(P("tasks", "inbox", `${run.id}.md`)), "Cancelled interrupted work must not be requeued");
    assert.equal(readDoc(P("tasks", "rejected", `${run.id}.md`)).meta.run_id, run.run_id);
    assert((await history(`tasks/rejected/${run.id}.md`)).some((entry: any) => entry.by === b.host && entry.text.includes(run.run_id)), "Restarted worker must sync its exact recovered result");
  }
  assert.equal((await form("/api/tasks/stops/retry", "POST", { id: parent.id, operation_id: crypto.randomUUID() })).status, 409);
  const recovered = await form("/api/tasks/stops/retry", "POST", { id: parent.id, operation_id: parentBatch!.operation_id });
  assert.equal(recovered.status, 200, JSON.stringify(recovered)); assert.equal(recovered.data.cleanup.remaining, 0);
  await pull(); assert.equal(hasPendingStops(pendingTask(parent.id)), false);
  for (const run of [child, grandchild]) assert.equal(hasPendingStops(readDoc(P("tasks", "rejected", `${run.id}.md`)).meta.pending_stops), false);
  assert.equal((await local(a, "/fixture/reopen", { id: parent.id })).status, 200, "Confirmed cleanup must release the parent reopen guard");
  await pull(); assert(existsSync(P("tasks", "inbox", `${parent.id}.md`)));
  const original = await request(`/api/ui-requests/${cancelled.ticket}`); assert.equal(original.status, 503); assert.deepEqual(original.data, cancelled.data);

  const partialRun = await start(b, id(4)), partialPlan = `PL-S${taskPrefix}1`; await seedPlan(partialPlan, partialRun);
  writeFileSync(join(b.dir, "fail-commits"), "fail");
  const partial = await form(`/api/plans/${partialPlan}/cancel`, "POST", {});
  assert.equal(partial.status, 503, JSON.stringify(partial)); stopped(partialRun); await pull();
  const partialBatch = readPendingStops(readPlan(partialPlan).pending_stops); assertBound(partialBatch, [partialRun]);
  assert(existsSync(P("tasks", "active", `${partialRun.id}.md`)), "An unconfirmed local terminal write must not appear in the primary mirror");
  assert(existsSync(join(b.data, "tasks", "rejected", `${partialRun.id}.md`)), "The worker retains the stopped task while its real sync is disconnected");
  assert.equal((await form(`/api/plans/${partialPlan}`, "DELETE")).status, 409, "Pending plan stops must block archive");
  rmSync(join(b.dir, "fail-commits")); assert.equal((await local(b, "/fixture/push")).data.ok, true);
  const retried = await form(`/api/plans/${partialPlan}/retry-stops`, "POST", { operation_id: partialBatch!.operation_id });
  assert.equal(retried.status, 200, JSON.stringify(retried)); assert.equal(retried.data.cleanup.remaining, 0);
  await pull(); assert.equal(hasPendingStops(readPlan(partialPlan).pending_stops), false);
  assert.equal(readDoc(P("tasks", "rejected", `${partialRun.id}.md`)).meta.run_id, partialRun.run_id);
  assert((await history(`tasks/rejected/${partialRun.id}.md`)).some((entry: any) => entry.by === b.host && entry.text.includes(partialRun.run_id)));
  assert.equal((await request(`/api/ui-requests/${partial.ticket}`)).status, 503, "Recovery uses new intent; the original partial reply remains immutable");
  assert.equal((await form(`/api/plans/${partialPlan}`, "DELETE")).status, 200);

  const stale = await start(b, id(5)), stalePlan = `PL-S${taskPrefix}2`; await seedPlan(stalePlan, stale); await disableChannel(b);
  const staleCancel = await form(`/api/plans/${stalePlan}/cancel`, "POST", {}); assert.equal(staleCancel.status, 503); await pull();
  const staleOriginal = readPendingStops(readPlan(stalePlan).pending_stops); assertBound(staleOriginal, [stale]);
  // Deliberately model a concurrent replacement claim after its old process is verified stopped.
  const replacement = await start(b, stale.id, [], undefined, true); assert.notEqual(replacement.run_id, stale.run_id); stopped(stale);
  assert.equal((await local(b, "/fixture/resume")).status, 200);
  const conflict = await form(`/api/plans/${stalePlan}/retry-stops`, "POST", { operation_id: staleOriginal!.operation_id });
  assert.equal(conflict.status, 503, JSON.stringify(conflict)); assert(conflict.data.cleanup.remaining > 0);
  assert(running(replacement.parent)); assert(running(replacement.child)); await pull();
  const staleBatch = readPendingStops(readPlan(stalePlan).pending_stops); assert(staleBatch); assert(hasPendingStops(staleBatch));
  assert([...(staleBatch.scope ?? []), ...staleBatch.pending].some((target) => target.run_id === stale.run_id));
  assert(![...(staleBatch.scope ?? []), ...staleBatch.pending].some((target) => target.run_id === replacement.run_id), "Recovery must not bind to a new attempt");
  assert.equal(readDoc(P("tasks", "active", `${stale.id}.md`)).meta.run_id, replacement.run_id);
  assert.equal((await form(`/api/plans/${stalePlan}`, "DELETE")).status, 409);
  const taskResults = jsonLines(join(b.dir, "results.jsonl")).filter((row) => row.result.data?.run_id === replacement.run_id);
  assert.equal(taskResults.length, 0, "The replacement run must never receive the old batch's stop command");

  const includeOwner = { kind: "plan", id: stalePlan }, includeRef = { owner: includeOwner, operation_id: staleBatch.operation_id, target_id: stale.id };
  assert.equal((await request("/api/stops/review", "POST", includeRef, b.token)).status, 403);
  const outdatedPreview = await form("/api/stops/review", "POST", includeRef);
  assert.equal(outdatedPreview.status, 200, JSON.stringify(outdatedPreview)); assert.equal(outdatedPreview.data.target.kind, "pending");
  assert(outdatedPreview.data.current.records.some((record: any) => record.run_id === replacement.run_id));
  const reviewedRun = await start(b, stale.id, [], undefined, true); stopped(replacement);
  const staleDecision = { ...includeRef, preview_digest: outdatedPreview.data.preview_digest, action: "include", reason: "Review the current replacement attempt", request_id: crypto.randomUUID() };
  assert.equal((await form("/api/stops/resolve", "POST", staleDecision)).status, 409);
  assert(running(reviewedRun.parent)); assert(running(reviewedRun.child)); await pull();
  assert.equal(readDoc(P("tasks", "active", `${reviewedRun.id}.md`)).meta.stop_intent, undefined);
  assert.equal((await form("/api/stops/review", "POST", { ...includeRef, operation_id: crypto.randomUUID() })).status, 409);
  assert.equal((await form("/api/stops/review", "POST", { ...includeRef, owner: { kind: "task", id: parent.id } })).status, 409);
  const freshPreview = await form("/api/stops/review", "POST", includeRef);
  assert.equal(freshPreview.status, 200); assert.equal(freshPreview.data.can_include, true);
  assert(freshPreview.data.current.records.some((record: any) => record.run_id === reviewedRun.run_id));
  const include = { ...staleDecision, preview_digest: freshPreview.data.preview_digest, request_id: crypto.randomUUID() };
  let lostTicket = "";
  await assert.rejects(async () => {
    const accepted = await request("/api/stops/resolve", "POST", include); assert.equal(accepted.status, 202, JSON.stringify(accepted)); lostTicket = accepted.data.ticket;
    throw new TypeError("fixture lost initial resolve POST reply before its ticket reached the client");
  }, /lost initial resolve POST reply/);
  await applyUiRequest(lostTicket, send, (req, folder) => server.recordRequest(req, undefined, folder), uiResults);
  const firstInclude = await request(`/api/ui-requests/${lostTicket}`);
  assert.equal(firstInclude.status, 200, JSON.stringify(firstInclude)); assert.equal(firstInclude.data.review_id, include.request_id);
  assert(running(reviewedRun.parent)); assert(running(reviewedRun.child)); await pull();
  const authorized = readPendingStops(readPlan(stalePlan).pending_stops)!;
  assertBound(authorized, [reviewedRun]); assert.equal(authorized.reviews?.filter((review) => review.request_id === include.request_id).length, 1);
  const includeAudit = authorized.reviews!.find((review) => review.request_id === include.request_id)!;
  assert.equal(includeAudit.original.run_id, stale.run_id); assert(includeAudit.reviewed.records.some((record) => record.run_id === reviewedRun.run_id));
  const replayInclude = await form("/api/stops/resolve", "POST", include);
  assert.equal(replayInclude.status, 200); assert.equal(replayInclude.data.review_id, include.request_id);
  assert.equal((await form("/api/stops/resolve", "POST", { ...include, action: "exclude" })).status, 409);
  assert.equal((await form(`/api/plans/${stalePlan}/retry-stops`, "POST", { operation_id: staleBatch.operation_id })).status, 200);
  stopped(reviewedRun); await pull();
  const terminalReplay = await form("/api/stops/resolve", "POST", include);
  assert.equal(terminalReplay.status, 200); assert.equal(terminalReplay.data.review_id, include.request_id);
  assert.equal(readPendingStops(readPlan(stalePlan).pending_stops)!.reviews?.filter((review) => review.request_id === include.request_id).length, 1);
  assert(!existsSync(P("tasks", "active", `${reviewedRun.id}.md`)));
  assert.equal((await form(`/api/plans/${stalePlan}`, "DELETE")).status, 200);

  const excludedRun = await start(b, id(6)), excludePlan = `PL-S${taskPrefix}3`; await seedPlan(excludePlan, excludedRun); await disableChannel(b);
  const excludeCancel = await form(`/api/plans/${excludePlan}/cancel`, "POST", {}); assert.equal(excludeCancel.status, 503); await pull();
  const excludeBatch = readPendingStops(readPlan(excludePlan).pending_stops)!;
  const lateRun = await start(b, id(7), [], excludedRun.id);
  const discovered = await form(`/api/plans/${excludePlan}/retry-stops`, "POST", { operation_id: excludeBatch.operation_id });
  assert.equal(discovered.status, 503); assert(discovered.data.cleanup.unresolved.some((target: any) => target.id === lateRun.id));
  const excludeRef = { owner: { kind: "plan" as const, id: excludePlan }, operation_id: excludeBatch.operation_id };
  const rootPreview = await form("/api/stops/review", "POST", { ...excludeRef, target_id: excludedRun.id }); assert.equal(rootPreview.status, 200);
  const latePreview = await form("/api/stops/review", "POST", { ...excludeRef, target_id: lateRun.id });
  assert.equal(latePreview.status, 200); assert.equal(latePreview.data.target.kind, "unresolved");
  assert(latePreview.data.current.records.some((record: any) => record.run_id === lateRun.run_id));
  const excludeLate = { ...excludeRef, target_id: lateRun.id, preview_digest: latePreview.data.preview_digest, action: "exclude", reason: "Keep the separately reviewed legacy child running", request_id: crypto.randomUUID() };
  const realFetch = globalThis.fetch;
  let partialExclude: Awaited<ReturnType<typeof form>>;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/api/files/commit") throw new TypeError("fixture primary review publication interrupted");
    return realFetch(input, init);
  }) as typeof fetch;
  try { partialExclude = await form("/api/stops/resolve", "POST", excludeLate); } finally { globalThis.fetch = realFetch; }
  assert.equal(partialExclude.status, 503, JSON.stringify(partialExclude)); assert.equal(partialExclude.data.saved_locally, true); assert.equal(partialExclude.data.review_id, excludeLate.request_id);
  const localReview = readPendingStops(readPlan(excludePlan).pending_stops)!;
  assert(!localReview.unresolved.some((target) => target.id === lateRun.id)); assert.equal(localReview.reviews?.filter((review) => review.request_id === excludeLate.request_id).length, 1);
  assert(running(lateRun.parent)); assert(running(lateRun.child));
  const publishedExclude = await form("/api/stops/resolve", "POST", excludeLate);
  assert.equal(publishedExclude.status, 200, JSON.stringify(publishedExclude)); assert.equal(publishedExclude.data.review_id, excludeLate.request_id); await pull();
  assert.equal(readPendingStops(readPlan(excludePlan).pending_stops)!.reviews?.filter((review) => review.request_id === excludeLate.request_id).length, 1);
  assert.equal((await request(`/api/ui-requests/${partialExclude.ticket}`)).status, 503, "Review publication recovery must not rewrite its original partial reply");
  const background = await drain(excludeRef.owner, excludeBatch.operation_id);
  assert.equal(background.remaining, 1); assert(!background.unresolved.some((target) => target.id === lateRun.id), "Background capture must honor the audited exclusion");
  const oldRootDecision = { ...excludeRef, target_id: excludedRun.id, preview_digest: rootPreview.data.preview_digest, action: "exclude", reason: "Keep the reviewed pending run running", request_id: crypto.randomUUID() };
  assert.equal((await form("/api/stops/resolve", "POST", oldRootDecision)).status, 409, "Another decision must invalidate the older batch preview");
  const currentRootPreview = await form("/api/stops/review", "POST", { ...excludeRef, target_id: excludedRun.id }); assert.equal(currentRootPreview.status, 200);
  const excludeRoot = await form("/api/stops/resolve", "POST", { ...oldRootDecision, preview_digest: currentRootPreview.data.preview_digest, request_id: crypto.randomUUID() });
  assert.equal(excludeRoot.status, 200); assert.equal(excludeRoot.data.cleanup.remaining, 0);
  assert.equal((await local(b, "/fixture/pull")).data.ok, true); await pull();
  const audited = readPendingStops(readPlan(excludePlan).pending_stops)!;
  assert.equal(audited.reviews?.filter((review) => review.action === "exclude").length, 2); assert.equal(audited.excluded?.length, 2);
  assert(audited.excluded!.every((entry) => entry.stopped === false && !!entry.reason));
  assert((await history(`plans/${excludePlan}.json`)).some((entry: any) => entry.text.includes(excludeLate.request_id)), "The exclusion audit must reach Worker-backed shared storage");
  for (const run of [excludedRun, lateRun]) {
    assert(running(run.parent)); assert(running(run.child));
    assert.equal(readDoc(P("tasks", "active", `${run.id}.md`)).meta.run_id, run.run_id);
    assert.equal(readDoc(join(b.data, "tasks", "active", `${run.id}.md`)).meta.stop_intent, undefined);
    for (const state of ["done", "failed", "rejected"]) assert(!existsSync(P("tasks", state, `${run.id}.md`)), "Exclusion must not claim the live task stopped");
  }
  assert.equal((await form(`/api/plans/${excludePlan}`, "DELETE")).status, 200, "Audited exclusions may release the archive guard without stopping excluded work");
  for (const run of [excludedRun, lateRun]) assert(running(run.parent));
  console.log("Stop batches and reviews passed with real Worker-backed mirrors: durable family/restart recovery, partial publication, exact-run retries, stale preview/owner/operation rejection, explicit replacement authorization, lost-reply and partial-review replay without duplicate audit, audited exclusions without stopping live work, no excluded-row rediscovery and truthful archive/reopen guards.");
} finally {
  for (const machine of machines) if (machine.proc?.exitCode === null) machine.proc.kill("SIGTERM");
  for (const machine of machines) {
    await Promise.race([machine.proc.exited, Bun.sleep(5000)]);
    if (machine.proc.exitCode === null) { machine.proc.kill("SIGKILL"); await machine.proc.exited; }
    for (const name of readdirSync(join(machine.dir, "runs")).filter((name) => name.endsWith(".json"))) {
      const tree = JSON.parse(readFileSync(join(machine.dir, "runs", name), "utf8"));
      for (const pid of [tree.parent, tree.child]) if (running(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* Exited during cleanup. */ }
    }
    for (const output of machine.outputs) assert(!(await output).join("\n").includes(machine.token), "A fixture process printed a machine credential");
  }
  await request("/api/auth/logout", "POST", {}, owner).catch(() => null); rmSync(root, { recursive: true, force: true });
}
