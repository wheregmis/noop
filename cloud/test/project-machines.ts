// Against an isolated local production Worker; two real bridge processes use only throwaway folders and accounts.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-project-machines-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const otherOwner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const hash = async (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const request = async (path: string, method = "GET", body?: unknown, token = owner) => {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, data: await response.json() as any };
};
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(100); }
}
async function machineResult(ticket: string, token = owner) {
  let result: Awaited<ReturnType<typeof request>>;
  await until(async () => { result = await request(`/api/machine-requests/${ticket}`, "GET", undefined, token); return result.status !== 202; }, "Machine folder check timed out");
  return result!;
}
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
type Machine = { host: string; dir: string; home: string; data: string; token: string; accountTicket: string; proc: ReturnType<typeof Bun.spawn>; output: Promise<string[]> };
const machines: Machine[] = [];
const observedProbes: { host: string; ticket: string }[] = [];
async function machine(label: string): Promise<Machine> {
  const host = `project-${label}-${tag}`, dir = join(root, label), home = join(dir, "home"), data = join(dir, "data"), bin = join(dir, "bin");
  for (const folder of [home, data, bin, join(home, "accounts")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200, JSON.stringify(joined));
  const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), JSON.stringify({ claude: [], codex: [], hermes: [] }), { mode: 0o600 });
  writeFileSync(join(data, "config.toml"), `[host]\nname = ${JSON.stringify(host)}\n[cloud]\npoll_seconds = 0.1\n`);
  writeFileSync(join(dir, "result-tickets.log"), "");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
  const entry = join(dir, "bridge.ts");
  writeFileSync(entry, `
    import {loadConfig} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    import {appendFileSync} from 'node:fs';
    const originalFetch=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      const result=path.match(/^\\/api\\/host\\/machine-requests\\/([a-f0-9-]{36})$/);
      if(init?.method==='PUT'&&result) appendFileSync(${JSON.stringify(join(dir, "result-tickets.log"))},result[1]+'\\n');
      return originalFetch(input,init);
    };
    const stop=startMachineBridge(loadConfig());
    for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stop();setTimeout(()=>process.exit(0),50);});
    console.log('fixture bridge ready');
  `);
  const proc = Bun.spawn([process.execPath, entry], { env: { PATH: bin, NOOP_HOME: home, HUB_DATA: data, HUB_CONF: join(home, "noop.toml"), HUB_HOST: host, HUB_SYNC: "local", TMPDIR: dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const result = { host, dir, home, data, token, accountTicket: "", proc, output }; machines.push(result);
  await until(async () => { const ready = await request(`/api/machines/${host}/accounts`); if (ready.status === 202) result.accountTicket = ready.data.ticket; return !!result.accountTicket; }, "Fixture bridge did not report support");
  assert.equal((await machineResult(result.accountTicket)).status, 200);
  return result;
}
async function stop(machine: Machine) {
  if (machine.proc.exitCode !== null) return;
  machine.proc.kill("SIGTERM");
  await Promise.race([machine.proc.exited, Bun.sleep(2000)]);
  if (machine.proc.exitCode === null) { machine.proc.kill("SIGKILL"); await machine.proc.exited; }
}
function gitRemote(path: string, repo: string) {
  for (const args of [["init", "-q", path], ["-C", path, "remote", "add", "origin", `https://github.com/${repo}.git`]]) {
    const run = Bun.spawnSync(["/usr/bin/git", ...args]); assert.equal(run.exitCode, 0, run.stderr.toString());
  }
}
function assertProbeDispatch(host: string, ticket: string) {
  for (const machine of machines) {
    const handled = readFileSync(join(machine.dir, "result-tickets.log"), "utf8").split("\n").includes(ticket);
    assert.equal(handled, machine.host === host, `Probe ${ticket} must be handled only by ${host}, not ${machine.host}`);
  }
}
async function probe(host: string, path: string) {
  const start = await request(`/api/machines/${host}/project-folder-check`, "POST", { path });
  assert.equal(start.status, 202, JSON.stringify(start));
  const result = await machineResult(start.data.ticket);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.host, host); assert.equal(result.data.requested_path, path); assert.equal(result.data.probe_ticket, start.data.ticket);
  assert(Number.isFinite(Date.parse(result.data.checked)));
  observedProbes.push({ host, ticket: start.data.ticket });
  assertProbeDispatch(host, start.data.ticket);
  return result.data;
}

// The primary writer imports only after its data paths have been isolated.
process.env.NOOP_HOME = join(root, "primary-home"); process.env.HUB_DATA = join(root, "primary-data"); process.env.HUB_CONF = join(root, "primary-home", "noop.toml"); process.env.HUB_SYNC = "local";
mkdirSync(process.env.NOOP_HOME, { recursive: true }); mkdirSync(process.env.HUB_DATA, { recursive: true });
writeFileSync(join(process.env.HUB_DATA, "config.toml"), `[host]\nname = "project-primary-${tag}"\n`);
const { recordRequest } = await import("../../src/server");
const { applyUiRequest } = await import("../../src/ui-requests");
const { P, readDoc } = await import("../../src/core");
mkdirSync(P("journal"), { recursive: true });
mkdirSync(P("agents", "lead"), { recursive: true });
writeFileSync(P("agents", "lead", "profile.md"), "# Fixture lead\n");
let failPush = false, failResultUpload = false, routed = 0;
const results = new Map();
const send = async (path: string, init: RequestInit) => {
  if (failResultUpload && init.method === "PUT" && /^\/api\/host\/ui-requests\//.test(path)) { failResultUpload = false; return null; }
  const result = await request(path, init.method, init.body ? JSON.parse(String(init.body)) : undefined, legacy);
  return result.status >= 200 && result.status < 300 ? result.data : null;
};
const route: Parameters<typeof applyUiRequest>[2] = (req, folder) => {
  routed++;
  return recordRequest(req, { pull: async () => true, push: async () => !failPush }, folder);
};
async function form(path: string, method = "GET", body?: unknown) {
  const start = await request(path, method, body);
  assert.equal(start.status, 202, JSON.stringify(start));
  await applyUiRequest(start.data.ticket, send, route, results);
  return request(`/api/ui-requests/${start.data.ticket}`);
}
const projectFiles = () => readdirSync(P("projects")).filter((name) => name.endsWith(".md"));

try {
  for (const [token, email] of [[owner, "project-machines@example.com"], [otherOwner, "other-project-owner@example.com"]]) {
    assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: await hash(token!), email, created: Date.now(), last_seen: Date.now(), ua: "project-machines-test" }] }, legacy)).status, 200);
  }
  assert.equal((await request("/api/host/state", "PUT", { status: { active: [] }, ui_api: 1 }, legacy)).status, 200);
  const [a, b] = await Promise.all([machine("a"), machine("b")]);
  const accountsA = readFileSync(join(a.home, "accounts/config.json"), "utf8"), accountsB = readFileSync(join(b.home, "accounts/config.json"), "utf8");

  const workerFolder = join(b.dir, "worker-only"), hiddenFolder = join(b.dir, "worker-hidden"); mkdirSync(workerFolder);
  writeFileSync(join(workerFolder, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n'); gitRemote(workerFolder, "fixture/worker-rust");
  const requested = `~/${relative(homedir(), workerFolder)}`;
  const checked = await probe(b.host, requested);
  assert.equal(checked.path, realpathSync(workerFolder)); assert.equal(checked.repo, "fixture/worker-rust"); assert.deepEqual(checked.requires, ["cli:cargo"]);
  const body = { name: "Worker-only project", path: requested, host: b.host, probe_ticket: checked.probe_ticket, instructions: "Keep the worker's instructions.", requires: ["gpu"] };

  assert.equal((await request(`/api/machine-requests/${checked.probe_ticket}`, "GET", undefined, otherOwner)).status, 404);
  for (const invalid of [
    { ...body, probe_ticket: crypto.randomUUID() },
    { ...body, host: a.host },
    { ...body, path: `${requested}/different` },
    { ...body, probe_ticket: a.accountTicket },
  ]) assert.equal((await request("/api/projects", "POST", invalid)).status, 409, JSON.stringify(invalid));
  assert.equal((await request("/api/projects", "POST", { ...body, probe_ticket: undefined, project_folder: checked })).status, 400);
  assert.equal((await request("/api/projects", "POST", body, otherOwner)).status, 409);
  assert.equal((await request(`/api/machines/${b.host}/project-folder-check`, "POST", { path: requested }, a.token)).status, 403);

  // A remote snapshot must work even when the writer cannot stat that folder.
  renameSync(workerFolder, hiddenFolder);
  const created = await form("/api/projects", "POST", body);
  assert.equal(created.status, 200, JSON.stringify(created)); const id = created.data.id; assert.equal(typeof id, "string");
  let view = await form(`/api/projects/${id}`);
  assert.equal(view.status, 200); assert.equal(view.data.host, b.host); assert.equal(view.data.path, checked.path); assert.equal(view.data.exists, null);
  assert.equal(view.data.repo, "fixture/worker-rust"); assert.deepEqual(view.data.detected_requires, ["cli:cargo"]); assert.deepEqual(view.data.custom_requires, ["gpu"]);
  assert.deepEqual([...view.data.requires].sort(), ["cli:cargo", "gpu"].sort()); assert.equal(view.data.instructions, body.instructions);
  renameSync(hiddenFolder, workerFolder);
  assert.equal((await form("/api/projects", "POST", { ...body, name: "Duplicate on worker" })).status, 409);

  // Shared physical test storage changes between checks to represent differing manifests at the same remote path.
  const shared = join(root, "same-absolute-path"); mkdirSync(shared); writeFileSync(join(shared, "Cargo.toml"), "[package]\nname='same'\nversion='0.1.0'\n");
  const snapshotA = await probe(a.host, shared);
  rmSync(join(shared, "Cargo.toml")); writeFileSync(join(shared, "package.json"), '{"name":"same"}');
  const snapshotB = await probe(b.host, shared);
  assert.deepEqual(snapshotA.requires, ["cli:cargo"]); assert.deepEqual(snapshotB.requires, ["cli:bun|cli:node"]);
  const sameA = await form("/api/projects", "POST", { name: "Same path A", host: a.host, path: shared, probe_ticket: snapshotA.probe_ticket });
  const sameB = await form("/api/projects", "POST", { name: "Same path B", host: b.host, path: shared, probe_ticket: snapshotB.probe_ticket });
  assert.equal(sameA.status, 200, JSON.stringify(sameA)); assert.equal(sameB.status, 200, JSON.stringify(sameB)); assert.notEqual(sameA.data.id, sameB.data.id);
  assert.deepEqual((await form(`/api/projects/${sameA.data.id}`)).data.detected_requires, ["cli:cargo"]);
  assert.deepEqual((await form(`/api/projects/${sameB.data.id}`)).data.detected_requires, ["cli:bun|cli:node"]);
  assert.equal((await form("/api/projects", "POST", { name: "Same host collision", host: a.host, path: shared, probe_ticket: snapshotA.probe_ticket })).status, 409);

  const partialFolder = join(a.dir, "partial"); mkdirSync(partialFolder); const partialCheck = await probe(a.host, partialFolder);
  const start = await request("/api/projects", "POST", { name: "Partial save", host: a.host, path: partialFolder, probe_ticket: partialCheck.probe_ticket }); assert.equal(start.status, 202);
  failPush = true; failResultUpload = true; const beforeRoute = routed;
  await assert.rejects(() => applyUiRequest(start.data.ticket, send, route, results), /Could not confirm/);
  const filesAfterSave = projectFiles();
  failPush = false; await applyUiRequest(start.data.ticket, send, route, results);
  const partial = await request(`/api/ui-requests/${start.data.ticket}`);
  assert.equal(partial.status, 503); assert.equal(partial.data.saved_locally, true); assert.equal(typeof partial.data.id, "string");
  assert.equal(routed, beforeRoute + 1); assert.deepEqual(projectFiles(), filesAfterSave);
  assert.equal(readDoc(P("projects", `${partial.data.id}.md`)).meta.host, a.host);
  assert.equal((await request(`/api/ui-requests/${start.data.ticket}`)).data.id, partial.data.id);

  await stop(b);
  const offlineEdit = await form(`/api/projects/${id}`, "PUT", { name: "Edited while worker offline", host: b.host, path: checked.path, instructions: "Retain checked toolchain offline.", requires: ["gpu", "docker"], repo: "fixture/custom-repo" });
  assert.equal(offlineEdit.status, 200, JSON.stringify(offlineEdit));
  view = await form(`/api/projects/${id}`);
  assert.equal(view.data.name, "Edited while worker offline"); assert.equal(view.data.repo, "fixture/custom-repo"); assert.equal(view.data.detected_repo, "fixture/worker-rust");
  assert.deepEqual(view.data.detected_requires, ["cli:cargo"]); assert.deepEqual([...view.data.custom_requires].sort(), ["docker", "gpu"]);
  assert.equal(readFileSync(join(a.home, "accounts/config.json"), "utf8"), accountsA); assert.equal(readFileSync(join(b.home, "accounts/config.json"), "utf8"), accountsB);
  assert(!existsSync(join(a.home, "accounts/state.json"))); assert(!existsSync(join(b.home, "accounts/state.json")));
  for (const { host, ticket } of observedProbes) assertProbeDispatch(host, ticket);
  console.log("Two machine project flow passed: selected-child-only probe dispatch, actual folder probes, tilde expansion, owner/host/path/ticket binding, worker-only snapshots, independent manifests at the same path, host/path collisions, cached partial-save identity, offline edits and untouched account selections.");
} finally {
  for (const machine of machines) await stop(machine);
  for (const machine of machines) {
    const output = (await machine.output).join("\n");
    assert(!output.includes(machine.token), "Fixture process output contained a machine credential");
    if (machine.proc.exitCode) console.error(output);
  }
  for (const token of [owner, otherOwner]) await request("/api/auth/logout", "POST", {}, token).catch(() => null);
  rmSync(root, { recursive: true, force: true });
}
