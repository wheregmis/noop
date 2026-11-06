import { existsSync, rmSync, unlinkSync } from "node:fs";
import type { Subprocess } from "bun";
import { ActionSyncError } from "../cloud/src/action-errors";
import { TASK_ID } from "../cloud/src/tools";
import { type Cfg, P, _commitPush, _pull, isPrimary, journal, locked, now, readDoc, writeDoc } from "./core";
import { delegateTaskControl } from "./machine-bridge";
import { persistOwnerAction } from "./owner-actions";
import { assertStopRecordSize, captureTaskStops, hasPendingStops, matchingStopIntent, readPendingStops, stopDocText, StopStorageError, taskHasStopIntent, type PendingStops } from "./stop-intents";

export type TaskRunExpectation = { host: string; run_id: string };
export type TaskProcess = Pick<Subprocess, "pid" | "exited" | "kill" | "exitCode">;
export type TaskRun = TaskRunExpectation & { id: string; stopped: boolean; process?: TaskProcess; drained?: Promise<void>; stopping?: Promise<boolean>; stopConfirmed?: boolean };
const runs = new Map<string, TaskRun>();
export const runId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);

/** Register before the first await, so a pre-spawn cancellation can prevent the spawn. */
export function registerTaskRun(run: TaskRunExpectation & { id: string }): TaskRun {
  if (!runId(run.run_id)) throw new Error("This task claim needs a run identity before it can execute");
  const previous = runs.get(run.id);
  if (previous && (!previous.stopped || previous.process && previous.stopConfirmed !== true)) throw new Error(`Task ${run.id} already has a live or unconfirmed run`);
  const context = { ...run, stopped: false };
  runs.set(run.id, context);
  return context;
}
export function releaseTaskRun(run: TaskRun) {
  if (activeClaim(run) && taskHasStopIntent(readDoc(P("tasks/active", `${run.id}.md`)).meta)) return;
  if (runs.get(run.id) === run && (!run.stopped || !activeClaim(run) && (!run.process || run.stopConfirmed === true))) {
    runs.delete(run.id);
    if (!activeClaim(run)) rmSync(P("logs/pids", `${run.id}.pid`), { force: true });
  }
}
export function activeClaim(run: TaskRunExpectation & { id: string }): boolean {
  const path = P("tasks/active", `${run.id}.md`);
  if (!existsSync(path)) return false;
  const meta = readDoc(path).meta;
  return meta.run_id === run.run_id && meta.claimed_by === run.host;
}
export const taskRunCurrent = (run: TaskRun) => !run.stopped && runs.get(run.id) === run && activeClaim(run)
  && !taskHasStopIntent(readDoc(P("tasks/active", `${run.id}.md`)).meta);
export function bindTaskProcess(run: TaskRun, proc: TaskProcess) {
  if (run.stopped || runs.get(run.id) !== run) throw new Error("The task run was stopped before its process started");
  run.process = proc;
}

function processTree(pid: number, known: Set<number>): { pid: number; state: string }[] | null {
  try {
    const result = Bun.spawnSync(["/bin/ps", "-eo", "pid=,ppid=,pgid=,stat="], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    const rows = result.stdout.toString().trim().split("\n").map((line) => line.trim().split(/\s+/));
    for (let changed = true; changed;) {
      changed = false;
      for (const [child, parent, group] of rows) if ((Number(group) === pid || known.has(Number(parent))) && !known.has(Number(child))) {
        known.add(Number(child)); changed = true;
      }
    }
    return rows.filter(([child, , group, state]) => (Number(group) === pid || known.has(Number(child))) && !/^[ZX]/.test(state))
      .map(([child, , , state]) => ({ pid: Number(child), state }));
  } catch { return null; }
}

/** Freeze before discovery/kill so termination handlers cannot fork new, detached work. */
export async function stopAgentProcess(proc: TaskProcess, freezeMs = 1000, killMs = 1500): Promise<boolean> {
  if (process.platform === "win32") {
    const kill = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return await Promise.race([Promise.all([kill.exited, proc.exited]).then(([code]) => code === 0), Bun.sleep(freezeMs + killMs).then(() => false)]);
  }
  // An empty group after its root exited cannot rule out historical, detached descendants.
  if (proc.exitCode !== null) return false;
  try { process.kill(proc.pid, "SIGSTOP"); } catch { return false; }
  try { process.kill(-proc.pid, "SIGSTOP"); } catch { /* Older agents may not own a process group. */ }
  const known = new Set([proc.pid]);
  let rootExited = false;
  void proc.exited.then(() => { rootExited = true; }); // Bun exitCode remains null after a signal.
  const freezeEnd = Date.now() + freezeMs;
  let frozen = false;
  do {
    const root = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(proc.pid)], { stdout: "pipe", stderr: "ignore" });
    const state = root.stdout.toString().trim();
    if (root.exitCode !== 0 || !state || /^[ZX]/.test(state)) return false;
    if (!/^[Tt]/.test(state)) { await Bun.sleep(10); continue; }
    const tree = processTree(proc.pid, known);
    if (!tree?.some((row) => row.pid === proc.pid && /^[Tt]/.test(row.state))) return false;
    for (const row of tree) if (!/^[Tt]/.test(row.state)) try { process.kill(row.pid, "SIGSTOP"); } catch { /* Recheck below. */ }
    const checked = processTree(proc.pid, known);
    if (checked?.some((row) => row.pid === proc.pid) && checked.every((row) => /^[Tt]/.test(row.state))) { frozen = true; break; }
    await Bun.sleep(10);
  } while (Date.now() < freezeEnd);
  if (!frozen) return false;
  // shortcut: group members and observable descendants are covered; historical daemonized children are not reconstructible.
  try { process.kill(-proc.pid, "SIGKILL"); } catch { /* Fall back to the verified, frozen tree. */ }
  for (const pid of known) try { process.kill(pid, "SIGKILL"); } catch { /* It has already exited. */ }
  const exited = async (ms: number) => {
    const end = Date.now() + ms;
    do {
      const tree = processTree(proc.pid, known);
      if (rootExited && tree?.length === 0) return true;
      await Bun.sleep(25);
    } while (Date.now() < end);
    return false;
  };
  return exited(killMs);
}
export function stopTaskRun(run: TaskRun): Promise<boolean> {
  run.stopped = true;
  return run.stopping ??= (async () => {
    if (run.process && !await stopAgentProcess(run.process)) return false;
    if (!run.drained) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([run.drained.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1500); })]);
    } finally { clearTimeout(timer); }
  })().catch(() => false).then((confirmed) => {
    run.stopConfirmed = confirmed;
    if (!confirmed) run.stopping = undefined;
    return confirmed;
  });
}

const openDirs = ["inbox", "waiting", "blocked", "proposed", "active"];
const conflict = "This task started a different run or changed state. Refresh it before cancelling or finishing it.";
function terminal(id: string, expected: TaskRunExpectation, done: boolean): { result: string; pending: boolean } | null {
  for (const dir of ["done", "rejected", "failed"]) {
    const path = P("tasks", dir, `${id}.md`);
    if (!existsSync(path)) continue;
    const meta = readDoc(path).meta;
    if (meta.run_id === expected.run_id && (meta.run_host || meta.claimed_by) === expected.host)
      return { result: done && dir === "done" ? "done" : !done && dir === "rejected" && meta.cancelled ? "cancelled" : conflict,
        pending: hasPendingStops(meta.pending_stops) };
  }
  return null;
}
function terminalTaskDoc(doc: ReturnType<typeof readDoc>, id: string, done: boolean, batch?: PendingStops) {
  const meta = { ...doc.meta, id, run_host: doc.meta.run_host || doc.meta.claimed_by, claimed_by: undefined, status: done ? "done" : "cancelled",
    ...(done ? { finished: now() } : { cancelled: now() }), wake_at: undefined, pending_stops: batch ? JSON.stringify(batch) : undefined };
  const body = `${doc.body}\n\n## ${done ? "Done" : "Cancelled"} ${now()}\n${done ? "The owner marked this task done (finished it himself)." : "The owner cancelled this task."}\n`;
  assertStopRecordSize(stopDocText(meta, body));
  return { meta, body };
}
function terminalSizeError(doc: ReturnType<typeof readDoc>, id: string, done: boolean): string | undefined {
  try { terminalTaskDoc(doc, id, done, readPendingStops(doc.meta.pending_stops)); }
  catch (error) { if (error instanceof StopStorageError) return error.message; throw error; }
}
function finishTask(path: string, id: string, done: boolean, saved: (value: Record<string, unknown>) => void) {
  const initial = readDoc(path), { meta } = initial, result = done ? "done" : "cancelled";
  let previous = readPendingStops(meta.pending_stops);
  const inherited = matchingStopIntent(meta);
  if (meta.pending_stops && !previous) throw new Error("The previous related-run stop request cannot be verified");
  if (!previous && runId(meta.run_id)) for (const dir of ["done", "rejected"]) {
    const terminalPath = P("tasks", dir, `${id}.md`);
    if (!existsSync(terminalPath)) continue;
    const completed = readDoc(terminalPath).meta;
    if (completed.run_id === meta.run_id && (completed.run_host || completed.claimed_by) === (meta.claimed_by || meta.run_host)) {
      if (completed.pending_stops && !readPendingStops(completed.pending_stops)) throw new Error("The previous related-run stop request cannot be verified");
      previous = readPendingStops(completed.pending_stops);
      if (previous) break;
    }
  }
  if (taskHasStopIntent(meta) && (!inherited || inherited.done !== done)) throw new Error("This run has a conflicting stop request");
  terminalTaskDoc(initial, id, done, previous); // Even a standalone stop must fit the transport before any write.
  saved({ id, ...(meta.run_id ? { run_id: meta.run_id } : {}) });
  const batch = inherited ? previous : captureTaskStops((meta.children ?? "").split(",").filter((kid) => TASK_ID.test(kid)), { kind: "task", id }, done, previous);
  const terminalDoc = terminalTaskDoc(readDoc(path), id, done, batch);
  writeDoc(P("tasks", done ? "done" : "rejected", `${id}.md`), terminalDoc.meta, terminalDoc.body);
  unlinkSync(path);
  return { ok: true, id, ...(meta.run_id ? { run_id: meta.run_id } : {}), result, pending: hasPendingStops(batch) };
}

/** The owning daemon alone stops a run. Network delegation and process waits never hold the file lock. */
export function createTaskControl(cfg: Cfg, host: string, io = { pull: _pull, push: _commitPush }) {
  return async (id: string, done = false, expectation?: TaskRunExpectation, onlyQueued = false): Promise<string> => {
    const selected = await locked(async () => {
      let fresh = false; try { fresh = await io.pull(); } catch { /* Never stop a run using a stale mirror. */ }
      if (!fresh) throw new ActionSyncError("Could not load the latest task. Nothing was stopped. Reconnect and retry.", { id, ...(expectation ? { run_id: expectation.run_id } : {}), retryable: true });
      if (expectation) {
        const completed = terminal(id, expectation, done);
        if (completed?.result === conflict) return { error: conflict };
        // A newer open run takes precedence over an old terminal record with the same task id.
        if (completed && !openDirs.some((dir) => existsSync(P("tasks", dir, `${id}.md`)))) return { completed, expectation };
      }
      const where = openDirs.find((dir) => existsSync(P("tasks", dir, `${id}.md`)));
      if (!where) return { error: expectation ? conflict : "not found" };
      const path = P("tasks", where, `${id}.md`), doc = readDoc(path), meta = doc.meta;
      const intent = matchingStopIntent(meta);
      if (taskHasStopIntent(meta) && (!intent || intent.done !== done)) return { error: "This task has an unverified or conflicting requested stop. Finish its existing cleanup before changing the outcome." };
      if (where !== "active") {
        if (expectation) return { error: conflict };
        const error = terminalSizeError(doc, id, done);
        return error ? { error } : { path, queuedRunId: meta.run_id };
      }
      if (onlyQueued) return { error: conflict };
      const current = { host: meta.claimed_by, run_id: meta.run_id };
      if (!current.host || !runId(current.run_id)) return { error: "This active task was started by an older daemon. Update its machine and let startup recovery requeue it before cancelling." };
      if (expectation && (expectation.host !== current.host || expectation.run_id !== current.run_id)) return { error: conflict };
      if (current.host !== host) return { remote: current };
      const run = runs.get(id);
      if (!run || run.host !== host || run.run_id !== current.run_id) return { error: "This task's running process is not registered here. Let machine startup recovery finish, then refresh and retry." };
      const sizeError = terminalSizeError(doc, id, done);
      if (sizeError) return { error: sizeError };
      run.stopped = true; // Must precede both the signal and any resumed processTask continuation.
      return { run, expectation: current };
    });
    if (selected.error) return selected.error;
    if (selected.remote) {
      if (!isPrimary(cfg, host)) return "Only the main machine can coordinate a stop on another machine. Open the main hub and retry this exact run.";
      const response = await delegateTaskControl(cfg, { host: selected.remote.host, id, run_id: selected.remote.run_id, done });
      if (response.status === 200 && response.data.ok === true && response.data.id === id && response.data.run_id === selected.remote.run_id
        && response.data.result === (done ? "done" : "cancelled")) {
        try {
          await locked(async () => { if (!await io.pull()) console.warn(`[${host}] ${id} stop confirmed; task view refresh is pending`); });
        } catch { console.warn(`[${host}] ${id} stop confirmed; task view refresh is pending`); }
        return String(response.data.result);
      }
      if (response.status >= 500) throw new ActionSyncError(String(response.data.error || "The machine did not confirm the task change. Check this exact run before retrying."), { ...response.data, id, run_id: selected.remote.run_id });
      return String(response.data.error || conflict);
    }
    if (selected.run && !await stopTaskRun(selected.run)) throw new ActionSyncError("The task process did not confirm it stopped. Check this run before retrying; its task state has not been marked finished.", { id, run_id: selected.run.run_id, uncertain: true });
    try {
      const value = await persistOwnerAction<{ ok: boolean; id: string; result: string; run_id?: string; pending?: boolean }>((saved) => {
        if (selected.expectation) {
          const completed = terminal(id, selected.expectation, done);
          if (completed && !openDirs.some((dir) => existsSync(P("tasks", dir, `${id}.md`)))) return { ok: completed.result !== conflict, id, run_id: selected.expectation.run_id, result: completed.result, pending: completed.pending };
          if (!activeClaim({ id, ...selected.expectation })) return { ok: false, id, result: conflict };
        } else if (!selected.path || !existsSync(selected.path) || existsSync(P("tasks/active", `${id}.md`))
          || readDoc(selected.path).meta.run_id !== selected.queuedRunId) return { ok: false, id, result: conflict };
        const path = selected.expectation ? P("tasks/active", `${id}.md`) : selected.path!;
        const finished = finishTask(path, id, done, saved);
        journal(host, `${done ? "✅" : "🛑"} ${id} ${done ? "marked done" : "cancelled"} by owner`);
        return finished;
      }, () => `[${host}] ${done ? "finish" : "cancel"} ${id}`, io);
      if (value.ok && value.pending) throw new ActionSyncError(`Task ${id} was ${done ? "marked done" : "cancelled"}, but related runs are still waiting for confirmed stops. Retry their cleanup before starting new work.`,
        { id, ...(value.run_id ? { run_id: value.run_id } : {}), result: done ? "done" : "cancelled", saved_locally: true });
      return value.result;
    } catch (error) {
      if (selected.run && error instanceof ActionSyncError && error.data.retryable) throw new ActionSyncError("The agent stopped, but its final task state could not be refreshed. Check this exact run before retrying.", { id, run_id: selected.run.run_id, uncertain: true });
      throw error;
    } finally { if (selected.run) releaseTaskRun(selected.run); }
  };
}
