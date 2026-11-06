// Isolated production Worker + two real machine bridges/RemoteFiles mirrors. No model commands or real histories.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-learning-machines-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const otherOwner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, primary = `learn-primary-${tag}`;
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const observed: string[] = [];
async function request(path: string, method = "GET", body?: unknown, token = owner) {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const result = { status: response.status, data: await response.json() as any }; observed.push(JSON.stringify(result)); return result;
}
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(100); }
}
async function result(ticket: string, token = owner) {
  let response: Awaited<ReturnType<typeof request>>;
  await until(async () => { response = await request(`/api/machine-requests/${ticket}`, "GET", undefined, token); return response.status !== 202; }, "Learning command was not confirmed");
  return response!;
}
async function command(machine: Machine, suffix = "", body?: unknown) {
  const accepted = await request(`/api/machines/${machine.host}/learning${suffix}`, suffix ? "POST" : "GET", body);
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  const response = await result(accepted.data.ticket);
  for (const other of machines) {
    const tickets = existsSync(join(other.dir, "results.jsonl")) ? readFileSync(join(other.dir, "results.jsonl"), "utf8") : "";
    assert.equal(tickets.includes(accepted.data.ticket), other === machine, "Only the selected machine may handle a learning command");
  }
  return { ...response, ticket: accepted.data.ticket };
}
type Machine = { host: string; dir: string; home: string; data: string; histories: string; bin: string; token: string; entry: string; url: string; proc: ReturnType<typeof Bun.spawn>; outputs: Promise<string[]>[]; primary: boolean };
const machines: Machine[] = [];
async function local(machine: Machine, path: string, body?: unknown) {
  const response = await fetch(machine.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, data: await response.json() as any };
}
async function stop(machine: Machine, abrupt = false) {
  if (machine.proc.exitCode !== null) return;
  machine.proc.kill(abrupt ? "SIGKILL" : "SIGTERM");
  await Promise.race([machine.proc.exited, Bun.sleep(3000)]);
  if (machine.proc.exitCode === null) { machine.proc.kill("SIGKILL"); await machine.proc.exited; }
}
async function launch(machine: Machine) {
  rmSync(join(machine.dir, "server.json"), { force: true });
  const proc = Bun.spawn([process.execPath, machine.entry], { env: { PATH: machine.bin, NOOP_HOME: machine.home, HUB_DATA: machine.data, HUB_CONF: join(machine.home, "noop.toml"), HUB_HOST: machine.host,
    HUB_SYNC: "", HUB_SYNC_FAKE: "", TMPDIR: machine.dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  machine.proc = proc; machine.outputs.push(Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]));
  await until(() => existsSync(join(machine.dir, "server.json")), "Learning bridge did not start");
  machine.url = JSON.parse(readFileSync(join(machine.dir, "server.json"), "utf8")).url;
  let ticket = "";
  await until(async () => { const r = await request(`/api/machines/${machine.host}/learning`); if (r.status === 202) ticket = r.data.ticket; return !!ticket; }, "Learning bridge did not advertise support");
  assert.equal((await result(ticket)).status, 200);
}
async function machine(label: string, isPrimary = false): Promise<Machine> {
  const host = isPrimary ? primary : `learn-worker-${tag}`, dir = join(root, label), home = join(dir, "home"), data = join(dir, "data"), histories = join(dir, "private-codex-history"), bin = join(dir, "bin");
  const accountDir = join(home, "accounts", "codex-fixture");
  for (const folder of [home, data, histories, bin, accountDir]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined)); const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[host]\nname = ${JSON.stringify(host)}\n[cloud]\nurl = ${JSON.stringify(base.origin)}\npoll_seconds = 1\nmachine_token = ${JSON.stringify(token)}\n[server]\ntoken = ${JSON.stringify(isPrimary ? legacy : token)}\n[learn]\ncodex_dir = ${JSON.stringify(histories)}\n[[accounts]]\ncli = "codex"\nname = "fixture"\ndir = ${JSON.stringify(accountDir)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), '{"claude":[],"codex":["fixture"],"hermes":[]}', { mode: 0o600 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-codex; exit 0; fi\nprintf 'unexpected provider execution\\n' >> ${shellQuote(join(dir, "provider-executed"))}\nexit 99\n`, { mode: 0o755 });
  const entry = join(dir, "bridge.ts");
  writeFileSync(entry, `
    import {existsSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync,appendFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {loadConfig,P,locked,_pull,_commitPush,readDoc,hasRemote,setIdTag} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {startMachineBridge,machineCommandRequest} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    const dir=${JSON.stringify(dir)},host=${JSON.stringify(host)};
    setIdTag(${JSON.stringify(isPrimary ? "" : "W")});
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      if(path==='/api/files/commit'&&existsSync(join(dir,'fail-commits')))throw new Error('fixture publication disconnected');
      const match=path.match(/^\\/api\\/host\\/machine-requests\\/([a-f0-9-]{36})$/);
      if(match&&init?.method==='PUT'){
        const data=JSON.parse(String(init.body));appendFileSync(join(dir,'results.jsonl'),JSON.stringify({ticket:match[1],result:data})+'\\n');
        if(data.data?.applied===true&&existsSync(join(dir,'drop-run-uploads'))){writeFileSync(join(dir,'dropped-result.json'),String(init.body));throw new Error('fixture result reply lost');}
        if(data.data?.discarded===true&&existsSync(join(dir,'drop-discard-uploads'))){writeFileSync(join(dir,'dropped-discard.json'),String(init.body));throw new Error('fixture discard reply lost');}
      }
      return originalFetch(input,init);
    };
    if(!await hasRemote()||!await _pull())throw new Error('Fixture requires real RemoteFiles');
    let stopBridge=startMachineBridge(loadConfig());
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
      try{
        const path=new URL(req.url).pathname,b=await req.json().catch(()=>({}));
        if(path==='/fixture/seed')return locked(async()=>{
          if(!${isPrimary}||!await _pull())throw new Error('Only the fixture primary seeds shared files');
          writeFileSync(P('config.toml'),${JSON.stringify(`[fleet]
primary = ${JSON.stringify(primary)}
[clis]
enabled = ["codex"]
preference = ["codex"]
[clis.agents]
apprentice = ["codex"]
[learn]
enabled = true
sources = ["codex"]
`)});
          mkdirSync(P('agents','apprentice'),{recursive:true});writeFileSync(P('agents','apprentice','profile.md'),'# Fixture apprentice\\n');mkdirSync(P('journal'),{recursive:true});
          return Response.json({ok:await _commitPush('fixture learning configuration')});
        });
        if(path==='/fixture/pull')return Response.json({ok:await locked(_pull)});
        if(path==='/fixture/setting'){
          if(typeof b.enabled!=='boolean')throw new Error('Fixture learning toggle must be boolean');
          writeFileSync(P('config.local.toml'),'[learn]\\nenabled = '+String(b.enabled)+'\\n'+(typeof b.codex_dir==='string'?'codex_dir = '+JSON.stringify(b.codex_dir)+'\\n':''));return Response.json({ok:true});
        }
        if(path==='/fixture/pause'){await stopBridge();return Response.json({ok:true});}
        if(path==='/fixture/delete-task')return locked(async()=>{
          if(!await _pull()||!/^T-[\\w-]*\\d{4}$/.test(b.id||''))throw new Error('Invalid fixture task');
          for(const state of ['inbox','active','waiting','blocked','proposed','done','failed','rejected','cancelled'])rmSync(P('tasks',state,b.id+'.md'),{force:true});
          return Response.json({ok:await _commitPush('fixture owner deleted learning task')});
        });
        return machineCommandRequest(new Request(req.url,{method:req.method,headers:req.headers,body:JSON.stringify(b)}));
      }catch(error){return Response.json({error:String(error)},{status:500});}
    }});
    writeFileSync(join(dir,'server.json'),JSON.stringify({url:server.url.origin}));
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await stopBridge();server.stop(true);process.exit(0);});
  `);
  const value: Machine = { host, dir, home, data, histories, bin, token, entry, url: "", proc: undefined as unknown as ReturnType<typeof Bun.spawn>, outputs: [], primary: isPrimary };
  machines.push(value); await launch(value); return value;
}
function history(machine: Machine, name: string, turns: number) {
  const stamp = new Date(Date.now() - 1_200_000).toISOString();
  const content = Array.from({ length: turns }, (_, index) => JSON.stringify({ type: "response_item", timestamp: stamp, payload: { type: "message", role: "user", content: [{ text: `OWNER_HISTORY_${name}_${index}: Prefer small tested changes. token=private-fixture-${name}-credential` }] } })).join("\n");
  const path = join(machine.histories, `${name}.jsonl`); writeFileSync(path, content); const old = (Date.now() - 1_200_000) / 1000; utimesSync(path, old, old);
}
const states = ["inbox", "active", "waiting", "blocked", "proposed", "done", "failed", "rejected", "cancelled"];
const taskIds = (machine: Machine) => states.flatMap((state) => existsSync(join(machine.data, "tasks", state)) ? readdirSync(join(machine.data, "tasks", state)).filter((name) => /^T-.*\.md$/.test(name)).map((name) => name.slice(0, -3)) : []).sort();
function checkpoint(machine: Machine) { const path = join(machine.home, "learn", "state.json"); return existsSync(path) ? readFileSync(path, "utf8") : null; }
function assertPrivate(text: string) {
  for (const machine of machines) { assert(!text.includes(machine.home), "Private machine home leaked"); assert(!text.includes(machine.histories), "Private source folder leaked"); }
  assert(!text.includes("OWNER_HISTORY_"), "Owner history content leaked"); assert(!text.includes("private-fixture-"), "Fixture secret leaked");
}
try {
  for (const [token, email] of [[owner, "learning@example.com"], [otherOwner, "other-learning@example.com"]]) {
    const session = new Bun.CryptoHasher("sha256").update(token!).digest("hex");
    assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email, created: Date.now(), last_seen: Date.now(), ua: "learning-machines-test" }] }, legacy)).status, 200);
  }
  const a = await machine("primary", true); assert.equal((await local(a, "/fixture/seed")).data.ok, true);
  const b = await machine("worker"); assert.equal((await local(b, "/fixture/pull")).data.ok, true);
  history(a, "ALPHA", 1); history(b, "BRAVO", 2);
  const statusA = await command(a), statusB = await command(b);
  for (const [machine, status] of [[a, statusA], [b, statusB]] as const) { assert.equal(status.status, 200); assert.equal(status.data.host, machine.host); assert.deepEqual(status.data.sources, ["codex"]); assert.equal(status.data.blocked_reason, null); }
  const beforeA = checkpoint(a), beforeB = checkpoint(b);
  const previewA = await command(a, "/preview", {}), previewB = await command(b, "/preview", {});
  assert.equal(previewA.status, 200); assert.equal(previewB.status, 200); assert.equal(previewA.data.turns, 1); assert.equal(previewB.data.turns, 2);
  assert.notEqual(previewA.data.preview_digest, previewB.data.preview_digest); assert.equal(checkpoint(a), beforeA); assert.equal(checkpoint(b), beforeB);
  assert.deepEqual(taskIds(a), []); assert.deepEqual(taskIds(b), []);
  const runA = { request_id: crypto.randomUUID(), preview_digest: previewA.data.preview_digest }, runB = { request_id: crypto.randomUUID(), preview_digest: previewB.data.preview_digest };
  assert.equal((await request(`/api/machines/${b.host}/learning/run`, "POST", runB, a.token)).status, 403);
  assert.equal((await request(`/api/machine-requests/${previewB.ticket}`, "GET", undefined, otherOwner)).status, 404);
  const wrongHost = await local(a, `/api/machines/${b.host}/learning/preview`, {}); assert.equal(wrongHost.status, 409);
  const staleHost = await command(b, "/run", { ...runB, preview_digest: previewA.data.preview_digest }); assert.equal(staleHost.status, 409); assert.equal(checkpoint(b), beforeB);
  const resultA = await command(a, "/run", runA); assert.equal(resultA.status, 200, JSON.stringify(resultA)); assert.equal(resultA.data.applied, true); assert.equal(resultA.data.host, a.host); assert(resultA.data.id);
  assert.equal((await local(b, "/fixture/pull")).data.ok, true); const afterA = taskIds(b); assert.deepEqual(afterA, [resultA.data.id]);
  writeFileSync(join(b.dir, "drop-run-uploads"), "fixture lost reply");
  const acceptedB = await request(`/api/machines/${b.host}/learning/run`, "POST", runB); assert.equal(acceptedB.status, 202);
  await until(() => existsSync(join(b.dir, "dropped-result.json")), "The worker did not reach its durable result");
  const dropped = JSON.parse(readFileSync(join(b.dir, "dropped-result.json"), "utf8")); assert.equal(dropped.data.applied, true); const idB = dropped.data.id; assert(idB && idB !== resultA.data.id);
  const checkpointB = checkpoint(b); assert(checkpointB); const tasksBeforeRestart = taskIds(b);
  await stop(b, true); rmSync(join(b.dir, "drop-run-uploads")); await launch(b);
  const replayB = await command(b, "/run", { ...runB, confirm_only: true });
  assert.equal(replayB.status, 200, JSON.stringify(replayB)); assert.equal(replayB.data.id, idB); assert.equal(replayB.data.replayed, true); assert.deepEqual(taskIds(b), tasksBeforeRestart); assert.equal(checkpoint(b), checkpointB);
  assert.equal((await local(a, "/fixture/pull")).data.ok, true); assert.equal(taskIds(a).length, 2);
  assert.equal((await local(a, "/fixture/delete-task", { id: idB })).data.ok, true); assert.equal((await local(b, "/fixture/pull")).data.ok, true);
  assert.equal((await local(b, "/fixture/setting", { enabled: false })).status, 200);
  const disabled = await command(b, "/preview", {}); assert.equal(disabled.status, 409);
  const historical = await command(b, "/run", { ...runB, confirm_only: true }); assert.equal(historical.status, 200); assert.equal(historical.data.id, idB); assert(!taskIds(b).includes(idB)); assert.equal(checkpoint(b), checkpointB);
  assert.equal((await command(b, "/run", { ...runB, request_id: crypto.randomUUID() })).status, 409);
  assert.equal((await local(b, "/fixture/setting", { enabled: true })).status, 200);
  history(b, "CHARLIE", 1); const exactPreview = await command(b, "/preview", {}); assert.equal(exactPreview.status, 200); assert.equal(exactPreview.data.turns, 1);
  history(b, "DELTA", 1); const exact = await command(b, "/run", { request_id: crypto.randomUUID(), preview_digest: exactPreview.data.preview_digest });
  assert.equal(exact.status, 200, JSON.stringify(exact)); assert.equal(exact.data.turns, 1); assert(!checkpoint(b)!.includes("DELTA.jsonl"), "A run must consume only the privately staged reviewed collection");
  const stalePreview = await command(b, "/preview", {}); assert.equal(stalePreview.status, 200); assert.equal(stalePreview.data.turns, 1);
  const relocated = join(b.dir, "other-private-history"); mkdirSync(relocated);
  assert.equal((await local(b, "/fixture/setting", { enabled: true, codex_dir: relocated })).status, 200);
  const beforeStale = checkpoint(b), stale = await command(b, "/run", { request_id: crypto.randomUUID(), preview_digest: stalePreview.data.preview_digest });
  assert.equal(stale.status, 409); assert.equal(checkpoint(b), beforeStale);
  assert.equal((await local(b, "/fixture/setting", { enabled: true })).status, 200);
  const uncertainPreview = await command(b, "/preview", {}); assert.equal(uncertainPreview.status, 200);
  const uncertainRun = { request_id: crypto.randomUUID(), preview_digest: uncertainPreview.data.preview_digest };
  const occupiedDigest = join(b.home, "learn", `digest-${uncertainRun.request_id}.md`); writeFileSync(occupiedDigest, "fixture prevents initial digest installation", { mode: 0o600 });
  const beforeUncertain = taskIds(b), uncertain = await command(b, "/run", uncertainRun);
  assert.equal(uncertain.status, 503, JSON.stringify(uncertain)); assert.equal(uncertain.data.uncertain, true); assert.equal(checkpoint(b), beforeStale); assert.deepEqual(taskIds(b), beforeUncertain);
  const discovered = await command(b); assert.equal(discovered.status, 200); assert.equal(discovered.data.pending.request_id, uncertainRun.request_id); assert.equal(discovered.data.pending.preview_digest, uncertainRun.preview_digest);
  assert.equal((await command(b, "/run", { ...uncertainRun, confirm_only: true })).status, 409); assert.deepEqual(taskIds(b), beforeUncertain);
  writeFileSync(join(b.dir, "drop-discard-uploads"), "fixture lost release reply");
  const discarding = await request(`/api/machines/${b.host}/learning/discard`, "POST", uncertainRun); assert.equal(discarding.status, 202);
  await until(() => existsSync(join(b.dir, "dropped-discard.json")), "The worker did not persist the release decision");
  await stop(b, true); rmSync(join(b.dir, "drop-discard-uploads")); await launch(b);
  const released = await command(b, "/run", { ...uncertainRun, confirm_only: true }); assert.equal(released.status, 200, JSON.stringify(released)); assert.equal(released.data.discarded, true); assert.equal(released.data.request_id, uncertainRun.request_id);
  assert.equal(checkpoint(b), beforeStale); assert.deepEqual(taskIds(b), beforeUncertain); assert.equal(readFileSync(occupiedDigest, "utf8"), "fixture prevents initial digest installation");
  assert.equal((await command(b)).data.pending, undefined); assert.equal((await command(b, "/preview", {})).status, 200);
  const oldHost = `learn-old-${tag}`, old = await request("/api/host/join", "POST", { host: oldHost }); assert.equal(old.status, 200);
  assert.equal((await request("/api/host/machine-state", "PUT", { account_api: 1, project_api: 1 }, old.data.token)).status, 200);
  assert.equal((await request(`/api/machines/${oldHost}/learning`)).status, 409);
  for (const table of ["files", "history"]) {
    const exported = await request(`/api/host/export?table=${table}&limit=1000`, "GET", undefined, legacy);
    assert.equal(exported.status, 200);
    const serialized = JSON.stringify(exported.data.rows.map((row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value && typeof value === "object" && "$b64" in value ? Buffer.from(String(value.$b64), "base64").toString() : value]))));
    assertPrivate(serialized);
  }
  assertPrivate(observed.join("\n"));
  assert(!machines.some((machine) => existsSync(join(machine.dir, "provider-executed"))), "No model/provider commands may execute");
  await local(b, "/fixture/pause");
  const offlineAt = Date.now(); console.log("Learning offline expiry: waiting 181 seconds for the actual Worker heartbeat deadline.");
  await Bun.sleep(181_000);
  const offline = await request(`/api/machines/${b.host}/learning`); assert.equal(offline.status, 503, JSON.stringify(offline));
  assert(Date.now() - offlineAt >= 180_000); assert.equal((await command(a)).status, 200, "The primary remains available without substituting for the selected offline worker");
  console.log("Two-machine learning passed: host-bound status/preview/run, passive preview, authorization, stale preview rejection, durable restart confirmation without duplicate/resurrection, disabled and old-worker gating, real heartbeat expiry without fallback, private source/content boundaries, and real RemoteFiles publication.");
} finally {
  for (const machine of machines) { if (machine.proc) await stop(machine); for (const output of machine.outputs) { const logs = await output; if (logs.join("").trim()) console.log(`[${machine.host}] ${logs.join("\n")}`); } }
  rmSync(root, { recursive: true, force: true });
}
