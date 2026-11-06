import { afterEach, expect, test } from "bun:test";
import { ActionSyncError } from "../cloud/src/action-errors";
import { recordPath } from "../cloud/src/ui-requests";
import { recordRequest, setCancelTask, taskControlRequest, taskView } from "../src/server";
import { hostName, loadConfig, writeDoc } from "../src/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskInfo, type ToolStore } from "../cloud/src/tools";

const request = (body: unknown = { id: "T-0901" }, method = "POST") => new Request("http://hub/api/tasks/cancel", {
  method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
afterEach(() => { setCancelTask(async () => "not available"); });

test("task cancel and finish return the daemon's confirmed result with the same task identity", async () => {
  expect(recordPath("/api/tasks/cancel")).toEqual({ kind: "task-cancel" });
  const calls: unknown[] = [];
  setCancelTask(async (id, done) => { calls.push({ id, done }); return done ? "done" : "cancelled"; });
  for (const done of [false, true]) {
    const response = await recordRequest(request({ id: "T-0901", done }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: "T-0901", result: done ? "done" : "cancelled" });
  }
  expect(calls).toEqual([{ id: "T-0901", done: false }, { id: "T-0901", done: true }]);
});

test("rejected remote cancellation and missing controls never report success", async () => {
  for (const [result, status] of [["running on worker", 409], ["not found", 404], ["not available", 503]] as const) {
    setCancelTask(async () => result);
    for (const done of [false, true]) {
      const response = await recordRequest(request({ id: "T-0901", done })), body = await response.json() as any;
      expect(response.status).toBe(status); expect(body).toMatchObject({ ok: false, id: "T-0901", result });
      if (status === 409) { expect(body.error).toContain("worker"); expect(body.error).toContain("cannot stop this run"); }
    }
  }
});

test("unconfirmed cancellation preserves the saved identity and refresh failures stay retryable", async () => {
  for (const details of [{ id: "T-0901", saved_locally: true }, { retryable: true }]) {
    setCancelTask(async () => { throw new ActionSyncError("Sync could not be confirmed", details); });
    const response = await recordRequest(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ...details, ok: false, status: 503, error: "Sync could not be confirmed" });
  }
});

test("task cancellation validates its body and method before invoking controls", async () => {
  let calls = 0;
  setCancelTask(async () => { calls++; return "cancelled"; });
  for (const method of ["GET", "PUT", "DELETE"]) expect((await recordRequest(request({}, method))).status).toBe(405);
  for (const body of [null, [], "T-0901", {}, { id: "../../T-0901" }, { id: "T-0901", done: "false" }, { id: "T-0901", force: true }])
    expect((await recordRequest(request(body))).status).toBe(400);
  expect((await recordRequest(new Request("http://hub/api/tasks/cancel", { method: "POST", body: "{" }))).status).toBe(400);
  expect(calls).toBe(0);
});

test("active controls forward the captured host and run without replacing their identity", async () => {
  const run_id = crypto.randomUUID(), expected = { host: "worker", run_id }, calls: unknown[] = [];
  setCancelTask(async (id, done, expectation) => { calls.push({ id, done, expectation }); return "cancelled"; });
  const response = await recordRequest(request({ id: "T-0901", ...expected }));
  expect(await response.json()).toEqual({ ok: true, id: "T-0901", run_id, result: "cancelled" });
  expect(calls).toEqual([{ id: "T-0901", done: false, expectation: expected }]);
  for (const body of [{ id: "T-0901", host: "worker" }, { id: "T-0901", run_id }, { id: "T-0901", host: "../worker", run_id }, { id: "T-0901", host: "worker", run_id: "old" }])
    expect((await recordRequest(request(body))).status).toBe(400);
  expect(calls).toHaveLength(1);
});

test("queued UI intent is fenced from a task that has started running", async () => {
  const calls: unknown[] = [];
  setCancelTask(async (id, done, expected, onlyQueued) => { calls.push({ id, done, expected, onlyQueued }); return "The task is now running; refresh before stopping this run."; });
  const response = await recordRequest(request({ id: "T-0901", queued: true }));
  expect(response.status).toBe(409); expect(calls).toEqual([{ id: "T-0901", done: false, expected: undefined, onlyQueued: true }]);
  for (const body of [{ id: "T-0901", queued: false }, { id: "T-0901", queued: true, host: "worker", run_id: crypto.randomUUID() }])
    expect((await recordRequest(request(body))).status).toBe(400);
  expect(calls).toHaveLength(1);
});

test("a worker accepts only its own exact control and returns a closed partial result", async () => {
  const host = hostName(loadConfig()), run_id = crypto.randomUUID(); let calls = 0;
  const command = (target: string) => new Request(`http://machine/api/machines/${target}/task-control`, { method: "POST", body: JSON.stringify({ id: "T-0901", run_id, done: true }) });
  setCancelTask(async (_id, _done, expected) => {
    calls++; expect(expected).toEqual({ host, run_id });
    throw new ActionSyncError("Agent stopped; terminal sync is unconfirmed", { saved_locally: true, unknown: "private detail" });
  });
  expect((await taskControlRequest(command(host === "different-worker" ? "other-worker" : "different-worker"))).status).toBe(409);
  expect(calls).toBe(0);
  const response = await taskControlRequest(command(host));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false, id: "T-0901", run_id, error: "Agent stopped; terminal sync is unconfirmed", saved_locally: true });
});

test("local control request keys survive lost replies and never target a reopened task", async () => {
  const key = crypto.randomUUID(); let calls = 0;
  setCancelTask(async () => { calls++; return "cancelled"; });
  const keyed = (body: unknown) => new Request("http://hub/api/tasks/cancel", { method: "POST", headers: { "Idempotency-Key": key, Authorization: "Bearer fixture-owner" }, body: JSON.stringify(body) });
  const first = await recordRequest(keyed({ id: "T-0901" }));
  expect(first.status).toBe(200);
  setCancelTask(async () => { calls++; return "This newer run must remain alive"; });
  const replay = await recordRequest(keyed({ id: "T-0901" }));
  expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ ok: true, id: "T-0901", result: "cancelled" });
  expect((await recordRequest(keyed({ id: "T-0901", done: true }))).status).toBe(409); expect(calls).toBe(1);
});

test("local and cloud task views carry the same active and terminal run identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "noop-control-views-")), run_id = crypto.randomUUID();
  try {
    const path = join(dir, "T-0901.md");
    writeDoc(path, { id: "T-0901", title: "Task", run_id, run_host: "worker", cancelled: "2026-11-06T00:00:00Z" }, "Request");
    const contents = readFileSync(path, "utf8");
    const store = { read: (name: string) => name === "tasks/rejected/T-0901.md" ? { path: name, text: contents, updated: "2026-11-06T00:00:00Z" } : null, list: () => [] } as unknown as ToolStore;
    expect(taskView(path, "cancelled", [])).toMatchObject({ run_id, host: "worker" });
    expect(taskInfo(store, "T-0901")).toMatchObject({ run_id, host: "worker", state: "cancelled" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
