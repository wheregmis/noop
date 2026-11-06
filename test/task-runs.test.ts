import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionSyncError } from "../cloud/src/action-errors";
import { DATA, HOME_DIR, P, claim, list, locked, pickTask, readDoc, writeDoc } from "../src/core";
import { MAX_FILE, setSyncData, setTransport } from "../src/sync";
import { processTask, recoverTaskRuns, tick } from "../src/cli";
import { reopenTask } from "../src/brain";
import { captureTaskStops, hasPendingStops, matchingStopIntent, readPendingStops, stopDocText } from "../src/stop-intents";
import { createStopDrainer } from "../src/task-stops";
import { runAgent, stopOrphanedAgent } from "../src/runner";
import { createTaskControl, registerTaskRun, releaseTaskRun, stopTaskRun, taskRunCurrent, type TaskRun } from "../src/task-runs";

const ok = { pull: async () => true, push: async () => true };
const contexts: TaskRun[] = [];
const originalPath = process.env.PATH;
let root = "", serial = 700;
const host = "runtime-test";
beforeAll(() => {
  const message = "Runtime cancellation tests require /bin/ps process-table access. Rerun with process access enabled; no agent fixture was started.";
  try {
    const result = Bun.spawnSync(["/bin/ps", "-eo", "pid=,ppid=,pgid=,stat="], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0 || !result.stdout.toString().split("\n").some((line) => Number(line.trim().split(/\s+/)[0]) === process.pid)) throw new Error(message);
  } catch { throw new Error(message); }
});
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null);
  mkdirSync(HOME_DIR, { recursive: true });
  for (const dir of ["tasks", "agents", "plans", "decisions", "journal", "logs"]) rmSync(P(dir), { recursive: true, force: true });
  rmSync(join(HOME_DIR, "accounts"), { recursive: true, force: true });
  for (const file of ["settings.json", "config.local.toml"]) rmSync(P(file), { force: true });
  mkdirSync(P("agents/lead"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\n"); writeFileSync(P("config.toml"), `[host]\nname='${host}'\n`);
  root = mkdtempSync(join(HOME_DIR, "task-runtime-"));
});
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await stopTaskRun(context); rmSync(P("tasks/active", `${context.id}.md`), { force: true });
    // Escaped fixture children are explicitly killed in each test's finally block.
    context.stopConfirmed = true; releaseTaskRun(context);
  }
  process.env.PATH = originalPath; rmSync(root, { recursive: true, force: true });
});
async function until(check: () => boolean, message: string) {
  const end = Date.now() + 4000;
  while (!check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(10); }
}
function active(id = `T-${String(++serial).padStart(4, "0")}`) {
  const run = { id, host, run_id: crypto.randomUUID() }, path = P("tasks/active", `${id}.md`);
  writeDoc(path, { id, claimed_by: host, run_host: host, run_id: run.run_id, agent: "lead", cli: "claude", title: "Runtime fixture", source: "test", started: new Date().toISOString() }, "Keep this request.");
  return { ...run, path };
}
function context(run: ReturnType<typeof active>) { const value = registerTaskRun(run); contexts.push(value); return value; }
function fixture(output = "", descendant = false, parentExit = false, ignorePipes = false) {
  const script = join(root, `agent-${crypto.randomUUID()}.ts`), ready = `${script}.ready`, finish = `${script}.finish`, childReady = `${script}.child`;
  writeFileSync(script, `
    import {existsSync,writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{});
    if(process.argv[2]==='child'){writeFileSync(${JSON.stringify(childReady)},String(process.pid));setInterval(()=>{},1000);}
    else {
      const child=${descendant ? `Bun.spawn([process.execPath,${JSON.stringify(script)},'child'],{detached:true,stdin:'ignore',stdout:'${ignorePipes ? "ignore" : "inherit"}',stderr:'${ignorePipes ? "ignore" : "inherit"}'})` : "null"};
      if(child)while(!existsSync(${JSON.stringify(childReady)}))await Bun.sleep(5);
      writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,child:child?.pid}));
      ${parentExit ? "process.exit(0);" : ""}
      while(!existsSync(${JSON.stringify(finish)}))await Bun.sleep(5);
      console.log(${JSON.stringify(output)});process.exit(0);
    }
  `);
  return { script, ready, finish, cfg: { clis: { claude: { command: [process.execPath, script] }, timeout_minutes: 1 } } };
}
function living(pid: number) {
  const result = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return !!result.stdout.toString().trim() && !/^[ZX]/.test(result.stdout.toString().trim());
}

test("a claim receives a fresh run identity on every attempt", async () => {
  const path = P("tasks/inbox/T-0699.md"); writeDoc(path, { id: "T-0699", title: "Claim" }, "Body");
  const first = (await claim(path, host))!; const one = readDoc(first); expect(one.meta.run_id).toMatch(/^[a-f0-9-]{36}$/); expect(one.meta.run_host).toBe(host);
  writeDoc(path, one.meta, one.body); rmSync(first);
  const second = (await claim(path, host))!; expect(readDoc(second).meta.run_id).not.toBe(one.meta.run_id);
});

test("standalone queued stop refuses an oversized terminal record before changing the original task", async () => {
  for (const done of [false, true]) {
    const id = `T-${String(++serial).padStart(4, "0")}`, path = P("tasks/inbox", `${id}.md`), meta = { id, title: "Large standalone task" };
    const body = "x".repeat(MAX_FILE - Buffer.byteLength(stopDocText(meta, "")) - 16);
    writeDoc(path, meta, body); const before = readFileSync(path, "utf8");
    expect(Buffer.byteLength(before)).toBeLessThan(MAX_FILE);
    const result = await createTaskControl({}, host, ok)(id, done);
    expect(result).toContain("sync size limit"); expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(P("tasks", done ? "done" : "rejected", `${id}.md`))).toBe(false);
  }
});

test("standalone active stop preflights the terminal size before signalling its real process", async () => {
  const run = active(), task = context(run), command = fixture();
  const meta = readDoc(run.path).meta, body = "x".repeat(MAX_FILE - Buffer.byteLength(stopDocText(meta, "")) - 16);
  writeDoc(run.path, meta, body); const before = readFileSync(run.path, "utf8");
  const agent = runAgent("claude", "", root, command.cfg, join(root, "oversize-active.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  const pid = JSON.parse(readFileSync(command.ready, "utf8")).pid;
  try {
    const result = await createTaskControl({}, host, ok)(run.id, false, run);
    expect(result).toContain("sync size limit"); expect(task.stopped).toBe(false); expect(living(pid)).toBe(true);
    expect(readFileSync(run.path, "utf8")).toBe(before); expect(existsSync(P("tasks/rejected", `${run.id}.md`))).toBe(false);
  } finally { await stopTaskRun(task); await agent; }
});

test("pre-spawn cancellation prevents execution and preserves queued-child handling", async () => {
  const run = active(), task = context(run), command = fixture();
  writeDoc(run.path, { ...readDoc(run.path).meta, children: "T-0698" }, "Keep this request.");
  writeDoc(P("tasks/inbox/T-0698.md"), { id: "T-0698" }, "Child request");
  expect(await createTaskControl({}, host, ok)(run.id, false, run)).toBe("cancelled");
  expect(taskRunCurrent(task)).toBe(false);
  expect(await runAgent("claude", "", root, command.cfg, join(root, "arbitrary-log-name.log"), false, {}, task)).toBe("");
  expect(existsSync(command.ready)).toBe(false); expect(existsSync(P("tasks/rejected/T-0698.md"))).toBe(true);
  expect(readDoc(P("tasks/rejected", `${run.id}.md`)).meta).toMatchObject({ run_id: run.run_id, run_host: host });
});

test("cancellation freezes and kills an agent and detached descendant before committing success", async () => {
  const run = active(), task = context(run), command = fixture("late result", true);
  const agent = runAgent("claude", "", root, command.cfg, join(root, "explicit-binding.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  const pids = JSON.parse(readFileSync(command.ready, "utf8"));
  try {
    expect(await createTaskControl({}, host, ok)(run.id, true, run)).toBe("done");
    expect(living(pids.pid)).toBe(false); expect(living(pids.child)).toBe(false);
    expect(existsSync(run.path)).toBe(false); expect(readDoc(P("tasks/done", `${run.id}.md`)).body).toContain("Keep this request.");
    await agent;
  } finally { await stopTaskRun(task); await agent; }
});

test("queued-only and stale-run requests and failed refreshes never signal the current agent", async () => {
  const run = active(), task = context(run), command = fixture();
  const agent = runAgent("claude", "", root, command.cfg, join(root, "run.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  const pid = JSON.parse(readFileSync(command.ready, "utf8")).pid;
  try {
    const before = readDoc(run.path);
    expect(await createTaskControl({}, host, ok)(run.id, false, undefined, true)).toContain("different run");
    expect(living(pid)).toBe(true); expect(task.stopped).toBe(false); expect(readDoc(run.path)).toEqual(before);
    expect(await createTaskControl({}, host, ok)(run.id, false, { host, run_id: crypto.randomUUID() })).toContain("different run");
    for (const pull of [async () => false, async () => { throw new Error("offline"); }]) {
      await expect(createTaskControl({}, host, { ...ok, pull })(run.id, false, run)).rejects.toMatchObject({ data: { id: run.id, run_id: run.run_id, retryable: true } });
      expect(living(pid)).toBe(true); expect(task.stopped).toBe(false); expect(existsSync(run.path)).toBe(true);
    }
    expect(await createTaskControl({}, host, ok)(run.id, false, run)).toBe("cancelled");
  } finally { await stopTaskRun(task); await agent; }
});

test("an unconfirmed stopped run cannot be replaced while its actual process remains alive", async () => {
  const run = active(), task = context(run), command = fixture();
  const agent = runAgent("claude", "", root, command.cfg, join(root, "uncertain.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  try {
    task.stopped = true; releaseTaskRun(task);
    expect(() => registerTaskRun({ id: run.id, host, run_id: crypto.randomUUID() })).toThrow("unconfirmed run");
    expect(await createTaskControl({}, host, ok)(run.id, false, run)).toBe("cancelled");
  } finally { await stopTaskRun(task); await agent; }
});

test("an exited parent with an unidentified detached child holding output cannot falsely confirm a stop", async () => {
  const run = active(), task = context(run), command = fixture("", true, true);
  const agent = runAgent("claude", "", root, command.cfg, join(root, "escaped.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  const pids = JSON.parse(readFileSync(command.ready, "utf8"));
  await until(() => !living(pids.pid), "parent did not exit");
  try {
    await expect(createTaskControl({}, host, ok)(run.id, false, run)).rejects.toMatchObject({ data: { id: run.id, run_id: run.run_id, uncertain: true } });
    expect(living(pids.child)).toBe(true); expect(existsSync(run.path)).toBe(true);
    expect(existsSync(P("tasks/rejected", `${run.id}.md`))).toBe(false);
  } finally { try { process.kill(pids.child, "SIGKILL"); } catch {} await agent; await stopTaskRun(task); }
});

test("a drained exited parent cannot confirm cancellation or startup recovery while its detached child survives", async () => {
  const run = active(), task = context(run), command = fixture("", true, true, true);
  const agent = runAgent("claude", "", root, command.cfg, join(root, "escaped-ignore.log"), false, {}, task);
  await agent;
  const pids = JSON.parse(readFileSync(command.ready, "utf8")), binding = P("logs/pids", `${run.id}.pid`);
  try {
    expect(living(pids.pid)).toBe(false); expect(living(pids.child)).toBe(true); expect(existsSync(binding)).toBe(true);
    await expect(createTaskControl({}, host, ok)(run.id, false, run)).rejects.toMatchObject({ data: { id: run.id, run_id: run.run_id, uncertain: true } });
    expect(task.stopConfirmed).toBe(false); expect(existsSync(run.path)).toBe(true);
    expect(existsSync(P("tasks/rejected", `${run.id}.md`))).toBe(false);
    await expect(stopOrphanedAgent(run.id, run.run_id)).rejects.toThrow("cannot be verified");
    expect(existsSync(binding)).toBe(true); expect(living(pids.child)).toBe(true);
  } finally { try { process.kill(pids.child, "SIGKILL"); } catch {} }
});

test("cancellation and startup recovery cannot run a TERM handler that forks detached work", async () => {
  for (const mode of ["cancel", "recovery"]) {
    const run = active(), task = context(run), ready = join(root, `${run.id}.ready`), escaped = join(root, `${run.id}.escaped`), script = join(root, `${run.id}.ts`);
    writeFileSync(script, `
      import {writeFileSync} from 'node:fs';
      let stopping=false;
      process.on('SIGTERM',()=>{if(stopping)return;stopping=true;const child=Bun.spawn(['/bin/sleep','600'],{detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore'});writeFileSync(${JSON.stringify(escaped)},String(child.pid));process.exit(0);});
      writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);
    `);
    const agent = runAgent("claude", "", root, { clis: { claude: { command: [process.execPath, script] } } }, join(root, `${run.id}.log`), false, {}, task);
    await until(() => existsSync(ready), "TERM fixture did not start");
    const pid = Number(readFileSync(ready, "utf8"));
    try {
      if (mode === "cancel") expect(await createTaskControl({}, host, ok)(run.id, false, run)).toBe("cancelled");
      else expect(await stopOrphanedAgent(run.id, run.run_id)).toBe(true);
      await agent; expect(living(pid)).toBe(false); expect(existsSync(escaped)).toBe(false);
    } finally {
      if (existsSync(escaped)) try { process.kill(Number(readFileSync(escaped, "utf8")), "SIGKILL"); } catch {}
      if (living(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
      await agent;
    }
  }
});

test("restart recovery rejects a mismatched saved run and stops a verified orphan tree", async () => {
  const run = active(), task = context(run), command = fixture("", true);
  const agent = runAgent("claude", "", root, command.cfg, join(root, "orphan.log"), false, {}, task);
  await until(() => existsSync(command.ready), "agent did not start");
  const pids = JSON.parse(readFileSync(command.ready, "utf8"));
  try {
    await expect(stopOrphanedAgent(run.id, crypto.randomUUID())).rejects.toThrow("does not match");
    expect(living(pids.pid)).toBe(true); expect(living(pids.child)).toBe(true);
    expect(await stopOrphanedAgent(run.id, run.run_id)).toBe(true);
    expect(living(pids.pid)).toBe(false); expect(living(pids.child)).toBe(false); await agent;
  } finally { await stopTaskRun(task); await agent; }
});

test("a cancelled pre-spawn processTask cannot requeue itself when no account is available", async () => {
  process.env.PATH = "";
  const run = active(); let unlock!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const hold = locked(async () => { entered(); await new Promise<void>((resolve) => { unlock = resolve; }); }); await ready;
  const cancel = createTaskControl({}, host, ok)(run.id, false, run);
  const job = processTask(run.path, { clis: { enabled: [] } }, host);
  unlock(); await hold; expect(await cancel).toBe("cancelled"); await job;
  expect(list(P("tasks/inbox"))).toHaveLength(0); expect(existsSync(P("tasks/rejected", `${run.id}.md`))).toBe(true);
});

test("partial terminal persistence retains the exact run and retries do not affect a newer run", async () => {
  const run = active(), task = context(run); let synced = false;
  const control = createTaskControl({}, host, { ...ok, push: async () => synced });
  await expect(control(run.id, true, run)).rejects.toBeInstanceOf(ActionSyncError);
  expect(readDoc(P("tasks/done", `${run.id}.md`)).meta).toMatchObject({ run_id: run.run_id, run_host: host });
  await expect(control(run.id, true, run)).rejects.toMatchObject({ data: { id: run.id, run_id: run.run_id, saved_locally: true } });
  synced = true; expect(await control(run.id, true, run)).toBe("done");
  expect(await control(run.id, false, run)).toContain("different run");
  const newer = active(run.id), current = context(newer);
  expect(await control(run.id, true, run)).toContain("different run"); expect(current.stopped).toBe(false);
  expect(await control(newer.id, false, newer)).toBe("cancelled"); expect(task.stopped).toBe(true);
});

test("a queued task that completes another attempt between refreshes is not cancelled by the older action", async () => {
  const id = `T-${String(++serial).padStart(4, "0")}`, path = P("tasks/inbox", `${id}.md`), old = crypto.randomUUID(), newer = crypto.randomUUID();
  writeDoc(path, { id, run_id: old }, "Queued after the old attempt");
  let refreshes = 0;
  const control = createTaskControl({}, host, { ...ok, pull: async () => {
    if (++refreshes === 2) writeDoc(path, { id, run_id: newer }, "A newer attempt was requeued");
    return true;
  } });
  expect(await control(id)).toContain("different run"); expect(readDoc(path).meta.run_id).toBe(newer);
  expect(existsSync(P("tasks/rejected", `${id}.md`))).toBe(false);
});

test("confirmed remote control refreshes the primary mirror without rewriting the worker's terminal result", async () => {
  const run = active(), expected = { host: "worker", run_id: run.run_id }, before = readDoc(run.path), originalFetch = globalThis.fetch;
  writeDoc(run.path, { ...before.meta, claimed_by: "worker", run_host: "worker" }, before.body);
  let pulls = 0, pushes = 0, requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ ok: true, id: run.id, run_id: run.run_id, result: "done" }); }) as unknown as typeof fetch;
  try {
    expect(await createTaskControl({ fleet: { primary: "another-main" } }, host, ok)(run.id, true, expected)).toContain("Only the main machine"); expect(requests).toBe(0);
    const control = createTaskControl({ fleet: { primary: host }, cloud: { url: "http://fixture.invalid" }, server: { token: "fixture" } }, host, {
      pull: async () => {
        if (++pulls === 2) { rmSync(run.path); writeDoc(P("tasks/done", `${run.id}.md`), { ...before.meta, claimed_by: undefined, run_host: "worker", status: "done" }, "Worker-confirmed result"); }
        return true;
      }, push: async () => { pushes++; return true; },
    });
    expect(await control(run.id, true, expected)).toBe("done"); expect(pulls).toBe(2); expect(pushes).toBe(0);
    expect(existsSync(run.path)).toBe(false); expect(readDoc(P("tasks/done", `${run.id}.md`)).body.trim()).toBe("Worker-confirmed result");
    for (const refresh of [async () => false, async () => { throw new Error("offline"); }]) {
      writeDoc(run.path, { ...before.meta, claimed_by: "worker", run_host: "worker" }, before.body);
      let count = 0;
      expect(await createTaskControl({ fleet: { primary: host }, cloud: { url: "http://fixture.invalid" }, server: { token: "fixture" } }, host,
        { pull: async () => ++count === 1 ? true : refresh(), push: async () => { throw new Error("must not write"); } })(run.id, true, expected)).toBe("done");
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("parent cancellation captures and drains exact active children and grandchildren without nested batches", async () => {
  const family = [active(), active(), active()];
  for (let i = 0; i < family.length - 1; i++) writeDoc(family[i].path, { ...readDoc(family[i].path).meta, children: family[i + 1].id }, "Family request");
  const tasks = family.map(context), commands = family.map(() => fixture()), agents = family.map((run, i) => runAgent("claude", "", root, commands[i].cfg, join(root, `${run.id}.log`), false, {}, tasks[i]));
  await until(() => commands.every((command) => existsSync(command.ready)), "family did not start");
  const pids = commands.map((command) => JSON.parse(readFileSync(command.ready, "utf8")).pid), cfg = { host: { name: host }, fleet: { primary: host } };
  const control = createTaskControl(cfg, host, ok), parentFile = P("tasks/rejected", `${family[0].id}.md`);
  try {
    await expect(control(family[0].id, false, family[0])).rejects.toMatchObject({ data: { id: family[0].id, run_id: family[0].run_id, saved_locally: true, result: "cancelled" } });
    const batch = readPendingStops(readDoc(parentFile).meta.pending_stops)!;
    expect(batch.pending.map((item) => [item.id, item.run_id])).toEqual(family.slice(1).map((run) => [run.id, run.run_id]));
    expect(living(pids[0])).toBe(false); expect(living(pids[1])).toBe(true); expect(living(pids[2])).toBe(true);
    expect(taskRunCurrent(tasks[1])).toBe(false); expect(taskRunCurrent(tasks[2])).toBe(false);
    expect(() => reopenTask(parentFile, "Do more")).toThrow("still stopping");
    expect(await control(family[1].id, false, family[1])).toBe("cancelled");
    expect(readDoc(P("tasks/rejected", `${family[1].id}.md`)).meta.pending_stops).toBeUndefined();
    const progress = await createStopDrainer(cfg, host, control, ok)({ kind: "task", id: family[0].id }, batch.operation_id);
    expect(progress).toMatchObject({ complete: true, synced: true });
    expect(pids.every((pid) => !living(pid))).toBe(true); expect(hasPendingStops(readDoc(parentFile).meta.pending_stops)).toBe(false);
    await Promise.all(agents);
  } finally { for (const task of tasks) await stopTaskRun(task); await Promise.all(agents); }
});

test("a partial parent save terminalizes queued descendants and keeps active children visibly pending", async () => {
  const child = active(), task = context(child), command = fixture(), parent = `T-${String(++serial).padStart(4, "0")}`, queued = `T-${String(++serial).padStart(4, "0")}`;
  writeDoc(P("tasks/inbox", `${parent}.md`), { id: parent, children: child.id }, "Parent");
  writeDoc(child.path, { ...readDoc(child.path).meta, children: queued }, "Child");
  writeDoc(P("tasks/waiting", `${queued}.md`), { id: queued }, "Queued descendant");
  const agent = runAgent("claude", "", root, command.cfg, join(root, "partial-family.log"), false, {}, task);
  await until(() => existsSync(command.ready), "child did not start");
  try {
    await expect(createTaskControl({}, host, { ...ok, push: async () => false })(parent)).rejects.toMatchObject({ data: { id: parent, saved_locally: true, result: "cancelled" } });
    const parentFile = P("tasks/rejected", `${parent}.md`), batch = readPendingStops(readDoc(parentFile).meta.pending_stops)!;
    expect(batch.pending).toMatchObject([{ id: child.id, host, run_id: child.run_id }]);
    expect(existsSync(P("tasks/rejected", `${queued}.md`))).toBe(true); expect(matchingStopIntent(readDoc(child.path).meta)?.operation_id).toBe(batch.operation_id);
    expect(living(JSON.parse(readFileSync(command.ready, "utf8")).pid)).toBe(true);
    const progress = await createStopDrainer({ fleet: { primary: host } }, host, createTaskControl({}, host, ok), ok)({ kind: "task", id: parent }, batch.operation_id);
    expect(progress).toMatchObject({ complete: true, synced: true }); await agent;
  } finally { await stopTaskRun(task); await agent; }
});

test("a parent retry after a failed sync reuses its saved batch instead of replacing child run targets", async () => {
  const parent = active(), child = active(); context(parent); context(child);
  writeDoc(parent.path, { ...readDoc(parent.path).meta, children: child.id }, "Parent");
  const original = readDoc(parent.path), terminal = P("tasks/rejected", `${parent.id}.md`);
  await expect(createTaskControl({}, host, { ...ok, push: async () => { writeDoc(parent.path, original.meta, original.body); return false; } })(parent.id, false, parent)).rejects.toMatchObject({ data: { id: parent.id, saved_locally: true } });
  const before = readPendingStops(readDoc(terminal).meta.pending_stops)!;
  await expect(createTaskControl({}, host, ok)(parent.id, false, parent)).rejects.toMatchObject({ data: { id: parent.id, saved_locally: true, result: "cancelled" } });
  const after = readPendingStops(readDoc(terminal).meta.pending_stops)!;
  expect(after.operation_id).toBe(before.operation_id); expect(after.pending).toEqual(before.pending); expect(existsSync(parent.path)).toBe(false);
});

test("pending family cleanup never retargets a newer child run with the same task id", async () => {
  const old = active(), oldContext = context(old), parent = `T-${String(++serial).padStart(4, "0")}`;
  writeDoc(P("tasks/waiting", `${parent}.md`), { id: parent, children: old.id }, "Parent");
  const cfg = { fleet: { primary: host } }, control = createTaskControl(cfg, host, ok);
  await expect(control(parent)).rejects.toMatchObject({ data: { id: parent, saved_locally: true } });
  const batch = readPendingStops(readDoc(P("tasks/rejected", `${parent}.md`)).meta.pending_stops)!;
  await stopTaskRun(oldContext);
  const newer = active(old.id), current = context(newer), command = fixture();
  const agent = runAgent("claude", "", root, command.cfg, join(root, "newer-family.log"), false, {}, current);
  await until(() => existsSync(command.ready), "new child run did not start");
  let calls = 0;
  try {
    const progress = await createStopDrainer(cfg, host, async (...args) => { calls++; return control(...args); }, ok)({ kind: "task", id: parent }, batch.operation_id);
    expect(progress.complete).toBe(false); expect(calls).toBe(0); expect(current.stopped).toBe(false);
    expect(living(JSON.parse(readFileSync(command.ready, "utf8")).pid)).toBe(true); expect(readDoc(newer.path).meta.run_id).toBe(newer.run_id);
  } finally { await stopTaskRun(current); await agent; }
});

test("actual nondelegated follow-ups record their spawning run and remain inside ancestor cleanup", async () => {
  const bin = join(root, "bin"); mkdirSync(bin); writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); process.env.PATH = bin;
  writeFileSync(join(HOME_DIR, "github-rate.json"), JSON.stringify({ core: 5000, graphql: 5000, reset: Date.now() + 100000, checked: Date.now() }));
  const child = active(), command = fixture('```json\n{"status":"done","summary":"Ready","followups":[{"title":"Follow-up from this exact run"}]}\n```');
  const cfg = { ...command.cfg, host: { name: host }, fleet: { primary: host }, clis: { ...command.cfg.clis, enabled: ["claude"] }, accounts: [{ cli: "claude", name: "fixture", dir: join(root, "account") }] };
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='fixture'\ndir=${JSON.stringify(join(root, "account"))}\n`);
  const job = processTask(child.path, cfg, host);
  await until(() => existsSync(command.ready), "child did not start"); writeFileSync(command.finish, "go"); await job;
  const queued = list(P("tasks/inbox")); expect(queued).toHaveLength(1);
  const followup = readDoc(queued[0]).meta;
  expect(followup).toMatchObject({ source: `followup:${child.id}`, spawned_by_run: child.run_id }); expect(followup.parent).toBeUndefined();
  const parent = `T-${String(++serial).padStart(4, "0")}`; writeDoc(P("tasks/waiting", `${parent}.md`), { id: parent, children: child.id }, "Parent");
  expect(await createTaskControl(cfg, host, ok)(parent)).toBe("cancelled");
  expect(existsSync(queued[0])).toBe(false); expect(existsSync(P("tasks/rejected", `${followup.id}.md`))).toBe(true);
});

test("startup stops outside the lock and honors a newly published matching stop instead of requeueing", async () => {
  const child = active(), task = context(child), command = fixture(), parent = `T-${String(++serial).padStart(4, "0")}`;
  writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, cancelled: new Date().toISOString() }, "Parent stopped");
  const agent = runAgent("claude", "", root, command.cfg, join(root, "startup-intent.log"), false, {}, task);
  await until(() => existsSync(command.ready), "child did not start");
  try {
    expect(await recoverTaskRuns(host, { ...ok, stopOrphan: async (id, run_id) => {
      const stopped = await stopOrphanedAgent(id, run_id);
      await locked(async () => {
        const batch = captureTaskStops([child.id], { kind: "task", id: parent }, false)!;
        writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, cancelled: new Date().toISOString(), pending_stops: JSON.stringify(batch) }, "Parent stopped");
      });
      return stopped;
    } })).toBe(1);
    await agent; expect(existsSync(child.path)).toBe(false); expect(existsSync(P("tasks/inbox", `${child.id}.md`))).toBe(false);
    expect(readDoc(P("tasks/rejected", `${child.id}.md`)).meta).toMatchObject({ run_id: child.run_id, run_host: host });
  } finally { await stopTaskRun(task); await agent; }
});

test("a stop intent published before processTask spawns keeps the exact run controllable", async () => {
  process.env.PATH = "";
  const child = active(), parent = `T-${String(++serial).padStart(4, "0")}`;
  let publish!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = locked(async () => {
    entered(); await new Promise<void>((resolve) => { publish = resolve; });
    const batch = captureTaskStops([child.id], { kind: "task", id: parent }, false)!;
    writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, pending_stops: JSON.stringify(batch), cancelled: new Date().toISOString() }, "Stopped parent");
  });
  await ready;
  const job = processTask(child.path, { clis: { enabled: [] } }, host);
  publish(); await held; await job;
  expect(existsSync(child.path)).toBe(true); expect(existsSync(P("tasks/inbox", `${child.id}.md`))).toBe(false);
  expect(await createTaskControl({}, host, ok)(child.id, false, child)).toBe("cancelled");
  expect(readDoc(P("tasks/rejected", `${child.id}.md`)).meta.run_id).toBe(child.run_id);
});

test("the scheduler never reaps a stop-marked active child back into the queue", async () => {
  const child = active(), task = context(child), command = fixture(), parent = `T-${String(++serial).padStart(4, "0")}`;
  const agent = runAgent("claude", "", root, command.cfg, join(root, "tick-stop.log"), false, {}, task);
  await until(() => existsSync(command.ready), "child did not start");
  const batch = await locked(async () => captureTaskStops([child.id], { kind: "task", id: parent }, false)!);
  writeDoc(P("tasks/rejected", `${parent}.md`), { id: parent, cancelled: new Date().toISOString(), pending_stops: JSON.stringify(batch) }, "Stopped parent");
  const before = readDoc(child.path);
  try {
    await tick({ host: { name: host }, fleet: { primary: host, reap_after_minutes: 0 }, clis: { enabled: [] }, idle: { enabled: false }, resources: { cleanup_enabled: false, disk_path: root } }, false,
      async () => ({ complete: false, synced: true, remaining: 1, pending: batch.pending, unresolved: [] }));
    expect(readDoc(child.path)).toEqual(before); expect(existsSync(P("tasks/inbox", `${child.id}.md`))).toBe(false);
    expect(living(JSON.parse(readFileSync(command.ready, "utf8")).pid)).toBe(true);
  } finally { await stopTaskRun(task); await agent; }
});

test("startup leaves a newer attempt untouched and refuses corrupt identities or unconfirmed recovery", async () => {
  const child = active(), newer = crypto.randomUUID(); let stopped = 0;
  expect(await recoverTaskRuns(host, { ...ok, stopOrphan: async () => { stopped++; writeDoc(child.path, { ...readDoc(child.path).meta, run_id: newer }, "New attempt"); return true; } })).toBe(0);
  expect(stopped).toBe(1); expect(readDoc(child.path).meta.run_id).toBe(newer); expect(existsSync(P("tasks/inbox", `${child.id}.md`))).toBe(false);
  writeDoc(child.path, { ...readDoc(child.path).meta, run_id: "invalid" }, "Bad identity");
  await expect(recoverTaskRuns(host, { ...ok, stopOrphan: async () => { throw new Error("must not stop"); } })).rejects.toThrow("verifiable run identity");
  writeDoc(child.path, { ...readDoc(child.path).meta, run_id: newer }, "Valid identity");
  await expect(recoverTaskRuns(host, { ...ok, stopOrphan: async () => false, push: async () => false })).rejects.toThrow("not confirmed");
  expect(existsSync(P("tasks/inbox", `${child.id}.md`))).toBe(true);
});

test("pending cleanup and any stop marker block reopening and claiming while empty completed batches can reopen", () => {
  const bin = join(root, "bin"); mkdirSync(bin); writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); process.env.PATH = bin;
  const cfg = { host: { name: host }, clis: { enabled: ["claude"] }, fleet: { primary: host, plan_wait_minutes: 0 } };
  for (const [id, extra] of [["T-0601", { pending_stops: "invalid" }], ["T-0602", { stop_intent: "invalid" }]] as const) {
    const path = P("tasks/inbox", `${id}.md`); writeDoc(path, { id, agent: "lead", cli: "claude", planned: "yes", ...extra }, "Protected");
    expect(() => reopenTask(path, "Retry")).toThrow("still stopping");
  }
  expect(pickTask(cfg)).toBeNull();
  const complete = { operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [] };
  const finished = P("tasks/rejected/T-0603.md"); writeDoc(finished, { id: "T-0603", pending_stops: JSON.stringify(complete) }, "Finished");
  reopenTask(finished, "Fresh follow-up"); expect(readDoc(P("tasks/inbox/T-0603.md")).meta.pending_stops).toBeUndefined();
});

test("processTask suppresses completion follow-ups, decisions and failover when cancellation wins the final lock", async () => {
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); process.env.PATH = bin;
  writeFileSync(join(HOME_DIR, "github-rate.json"), JSON.stringify({ core: 5000, graphql: 5000, reset: Date.now() + 100000, checked: Date.now() }));
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='fixture'\ndir=${JSON.stringify(join(root, "account"))}\n`);
  for (const output of [
    '```json\n{"status":"done","summary":"Late success","lessons":["Never write this"],"followups":[{"title":"Never create this"}]}\n```',
    '```json\n{"status":"needs_decision","summary":"Late decision","question":"Never ask?","options":["A: yes"]}\n```',
    'rate limit quota exceeded\n```json\n{"status":"failed","summary":"quota exceeded"}\n```',
  ]) {
    rmSync(join(HOME_DIR, "accounts/state.json"), { force: true });
    const run = active(), command = fixture(output), cfg = { ...command.cfg, host: { name: host }, fleet: { primary: host }, clis: { ...command.cfg.clis, enabled: ["claude"] }, accounts: [{ cli: "claude", name: "fixture", dir: join(root, "account") }] };
    const job = processTask(run.path, cfg, host);
    await until(() => existsSync(command.ready), "processTask did not spawn");
    const accountBefore = readFileSync(join(HOME_DIR, "accounts/state.json"), "utf8");
    let unlock!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = locked(async () => { entered(); await new Promise<void>((resolve) => { unlock = resolve; }); }); await ready;
    const cancel = createTaskControl(cfg, host, ok)(run.id, false, run);
    writeFileSync(command.finish, "go");
    const pid = JSON.parse(readFileSync(command.ready, "utf8")).pid;
    await until(() => !living(pid), "fixture did not finish");
    unlock(); await hold;
    await expect(cancel).rejects.toMatchObject({ data: { id: run.id, run_id: run.run_id, uncertain: true } }); await job;
    expect(existsSync(run.path)).toBe(true); expect(existsSync(P("tasks/rejected", `${run.id}.md`))).toBe(false); expect(list(P("tasks/inbox"))).toHaveLength(0);
    expect(list(P("decisions/open"))).toHaveLength(0); expect(existsSync(P("agents/lead/memory.md"))).toBe(false);
    if (output.startsWith("rate limit")) expect(readFileSync(join(HOME_DIR, "accounts/state.json"), "utf8")).toBe(accountBefore);
  }
});
