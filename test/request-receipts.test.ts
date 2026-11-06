import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionSyncError } from "../cloud/src/action-errors";
import { HOME_DIR } from "../src/core";
import { receiveMessage, receiveRequest, type RequestResult } from "../src/message-receipts";
import type { Event } from "../src/server";

type Context = { id: string; run_id: string };
const directory = join(HOME_DIR, "message-receipts"), owned: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const scope = `task-control-${crypto.randomUUID()}`, key = "task-control-request-key", file = join(directory, `${hash(`${scope}:${key}`)}.json`);
  owned.push(file, file.replace(/\.json$/, ".lock"));
  const context: Context = { id: "T-9101", run_id: crypto.randomUUID() }, payload = { id: context.id, done: false };
  const uncertain = (saved?: Context): RequestResult => ({ status: 503, data: { ok: false, ...(saved ?? {}), uncertain: true, error: "Task control was not confirmed" } });
  return { scope, key, file, context, payload, uncertain };
}
afterEach(() => { for (const file of owned.splice(0)) rmSync(file, { recursive: true, force: true }); });

test("a non-chat request coalesces concurrent calls and replays its saved result without touching a replacement run", async () => {
  const f = fixture(); let made = 0, applied = 0, activeRun = f.context.run_id;
  const make = () => { made++; return { ...f.context }; };
  const apply = async (context: Context, first: boolean): Promise<RequestResult> => {
    applied++; expect(first).toBe(true); expect(context.run_id).toBe(activeRun);
    await Bun.sleep(5);
    return { status: 200, data: { ok: true, ...context, result: "cancelled" } };
  };
  const [first, concurrent] = await Promise.all([
    receiveRequest(f.scope, f.key, f.payload, make, apply, f.uncertain),
    receiveRequest(f.scope, f.key, f.payload, make, apply, f.uncertain),
  ]);
  activeRun = crypto.randomUUID();
  const replay = await receiveRequest(f.scope, f.key, f.payload, make, apply, f.uncertain);
  expect(first).toEqual(concurrent); expect(replay).toEqual(first); expect(made).toBe(1); expect(applied).toBe(1);
  expect(replay).toMatchObject({ status: 200, data: { id: f.context.id, run_id: f.context.run_id } }); expect(activeRun).not.toBe(f.context.run_id);
  const receipt = JSON.parse(readFileSync(f.file, "utf8"));
  expect(receipt.event).toEqual(f.context); expect(receipt.event.kind).toBeUndefined(); expect(receipt.event.text).toBeUndefined();
  expect(statSync(f.file).mode & 0o777).toBe(0o600); expect(statSync(directory).mode & 0o777).toBe(0o700);
});

test("completed partial task controls preserve their result and identity without applying again", async () => {
  const f = fixture(); let applied = 0;
  const result = { status: 503, data: { ok: false, ...f.context, saved_locally: true, error: "Saved locally; synchronization unconfirmed" } };
  const send = () => receiveRequest(f.scope, f.key, f.payload, () => f.context, async () => { applied++; return result; }, f.uncertain);
  expect(await send()).toEqual(result); expect(await send()).toEqual(result); expect(applied).toBe(1);
  expect(JSON.parse(readFileSync(f.file, "utf8")).state).toBe("done");
});

test("request keys reject changed content both during execution and after completion", async () => {
  const f = fixture(); let release!: () => void, entered = false;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const apply = async (): Promise<RequestResult> => { entered = true; await wait; return { status: 200, data: { ok: true, ...f.context } }; };
  const first = receiveRequest(f.scope, f.key, f.payload, () => f.context, apply, f.uncertain);
  expect(entered).toBe(true);
  const changed = () => receiveRequest(f.scope, f.key, { ...f.payload, done: true }, () => { throw new Error("Must not create changed context"); }, apply, f.uncertain);
  expect((await changed()).status).toBe(409); release(); expect((await first).status).toBe(200); expect((await changed()).status).toBe(409);
});

test("only a proven failed refresh retries and it retains the original non-chat context", async () => {
  const f = fixture(); let ready = false, made = 0;
  const calls: { context: Context; first: boolean }[] = [];
  const send = () => receiveRequest(f.scope, f.key, f.payload, () => { made++; return f.context; }, async (context, first) => {
    calls.push({ context, first });
    return ready ? { status: 200, data: { ok: true, ...context } } : { status: 503, data: { ok: false, ...context, retryable: true, error: "Refresh failed before mutation" } };
  }, f.uncertain);
  expect((await send()).data.retryable).toBe(true); ready = true; expect((await send()).status).toBe(200);
  expect(made).toBe(1); expect(calls).toEqual([{ context: f.context, first: true }, { context: f.context, first: false }]);
});

test("structured sync exceptions retain a generic context's identity and safe retry semantics", async () => {
  const f = fixture(); let calls = 0;
  const send = () => receiveRequest(f.scope, f.key, f.payload, () => f.context, async (context): Promise<RequestResult> => {
    if (++calls === 1) throw new ActionSyncError("No mutation occurred", { ...context, retryable: true });
    return { status: 200, data: { ok: true, ...context } };
  }, f.uncertain);
  expect(await send()).toMatchObject({ status: 503, data: { ...f.context, retryable: true } });
  expect((await send()).status).toBe(200); expect(calls).toBe(2);
});

for (const flag of ["uncertain", "saved_locally"] as const) {
  test(`a ${flag} result cannot be replayed even if it also says retryable`, async () => {
    const f = fixture(); let applied = 0;
    const send = () => receiveRequest(f.scope, f.key, f.payload, () => f.context, async (): Promise<RequestResult> => {
      applied++; return { status: 503, data: { ok: false, ...f.context, retryable: true, [flag]: true } };
    }, f.uncertain);
    const first = await send(); expect(await send()).toEqual(first); expect(applied).toBe(1);
  });
}

test("unknown failures become durable context-specific uncertainty and never rerun the action", async () => {
  const f = fixture(); let applied = 0;
  const send = () => receiveRequest(f.scope, f.key, f.payload, () => f.context, async () => { applied++; throw new Error("private stop details"); }, f.uncertain);
  const first = await send(); expect(first).toEqual(f.uncertain(f.context)); expect(await send()).toEqual(first); expect(applied).toBe(1);
  expect(JSON.stringify(first)).not.toContain("private stop details");
});

test("a process crash leaves a durable generic running receipt that never dispatches again", async () => {
  const f = fixture(), temporary = mkdtempSync(join(tmpdir(), "noop-request-crash-")); owned.push(temporary);
  const marker = join(temporary, "applied.json"), source = resolve(import.meta.dir, "../src/message-receipts.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import {writeFileSync} from 'node:fs';
    import {receiveRequest} from ${JSON.stringify(source)};
    await receiveRequest(${JSON.stringify(f.scope)},${JSON.stringify(f.key)},${JSON.stringify(f.payload)},()=>(${JSON.stringify(f.context)}),async(context)=>{
      writeFileSync(${JSON.stringify(marker)},JSON.stringify(context));process.exit(0);
    },context=>({status:503,data:{...context,uncertain:true}}));
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0); expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(f.context);
  let repeated = false;
  const replay = await receiveRequest(f.scope, f.key, f.payload, () => { throw new Error("No replacement context"); }, async (): Promise<RequestResult> => { repeated = true; return { status: 200, data: {} }; }, f.uncertain);
  expect(replay).toEqual(f.uncertain(f.context)); expect(repeated).toBe(false);
});

test("legacy message receipts retain their on-disk event and replay without a migration", async () => {
  const f = fixture(), event: Event = { id: "legacy-event", ts: new Date().toISOString(), from: "owner", kind: "owner", text: "Legacy message" };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(f.file, JSON.stringify({ created: Date.now(), hash: hash(JSON.stringify(f.payload)), state: "done", event, result: { status: 200, data: event } }), { mode: 0o600 });
  let applied = false;
  expect(await receiveMessage(f.scope, f.key, f.payload, () => event, async () => { applied = true; })).toEqual({ status: 200, data: event });
  expect(applied).toBe(false);
});

test("expired private receipts retain the seven-day cleanup policy", async () => {
  const f = fixture();
  await receiveRequest(f.scope, f.key, f.payload, () => f.context, async () => ({ status: 200, data: { old: true } }), f.uncertain);
  const expired = new Date(Date.now() - 8 * 24 * 60 * 60_000); utimesSync(f.file, expired, expired);
  const replacement = { id: f.context.id, run_id: crypto.randomUUID() };
  const result = await receiveRequest(f.scope, f.key, { ...f.payload, done: true }, () => replacement, async (context) => ({ status: 200, data: context }), f.uncertain);
  expect(result).toEqual({ status: 200, data: replacement });
});
