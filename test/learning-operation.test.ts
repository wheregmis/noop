import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOME_DIR, P, loadConfig, readDoc } from "../src/core";
import { appendEvent, recordRequest } from "../src/server";
import { learningRequest, queueLearning } from "../src/learning";
import { collect, LEARNING_DIR } from "../src/sessions";
import { validLearningResult, type LearningPath } from "../cloud/src/learning";

const io = { pull: async () => true, push: async () => true };
const originalPath = process.env.PATH, host = "learning-worker";
let work = "", history = "", file = "";
const checkpoint = join(LEARNING_DIR, "state.json");
const call = (action: LearningPath["action"], body?: unknown, sync = io, target = host, method = action === "status" ? "GET" : "POST") => {
  const url = `http://machine/api/machines/${target}/learning${action === "status" ? "" : `/${action}`}`;
  return learningRequest(new Request(url, { method, ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) }), sync);
};
const preview = async () => { const r = await call("preview"); expect(r.status).toBe(200); return await r.json() as any; };
const request = (value: any) => ({ request_id: crypto.randomUUID(), preview_digest: value.preview_digest });
const taskFiles = () => fs.existsSync(P("tasks", "inbox")) ? fs.readdirSync(P("tasks", "inbox")).filter((name) => name.endsWith(".md")) : [];
const receiptPath = (input: { request_id: string }) => join(LEARNING_DIR, "requests", `${input.request_id}.json`);
beforeEach(() => {
  work = fs.mkdtempSync(join(tmpdir(), "noop-learning-operation-")); history = join(work, "history"); fs.mkdirSync(history);
  for (const dir of ["tasks", "agents", "fleet/task-ids"]) fs.rmSync(P(dir), { recursive: true, force: true });
  fs.rmSync(LEARNING_DIR, { recursive: true, force: true }); fs.rmSync(P("settings.json"), { force: true });
  fs.mkdirSync(P("agents", "apprentice"), { recursive: true }); fs.mkdirSync(P("journal"), { recursive: true });
  fs.writeFileSync(P("agents", "apprentice", "profile.md"), "# Apprentice\n");
  fs.writeFileSync(P("config.toml"), `[host]\nname = '${host}'\n[clis]\nenabled = ['claude']\n[learn]\nsources = ['claude']\n`);
  fs.writeFileSync(P("config.local.toml"), `[learn]\nclaude_dir = ${JSON.stringify(history)}\n[[accounts]]\ncli = 'claude'\nname = 'fixture'\ndir = ${JSON.stringify(join(work, "account"))}\n`);
  const bin = join(work, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\nexit 99\n", { mode: 0o755 }); process.env.PATH = bin;
  file = join(history, "one.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", timestamp: new Date(Date.now() - 30 * 60_000).toISOString(), message: { content: "Use the reviewed private fixture. private@example.com" } }));
  const old = (Date.now() - 20 * 60_000) / 1000; fs.utimesSync(file, old, old);
});
afterEach(() => { process.env.PATH = originalPath; fs.rmSync(work, { recursive: true, force: true }); fs.rmSync(LEARNING_DIR, { recursive: true, force: true }); fs.rmSync(P("fleet", "task-ids"), { recursive: true, force: true }); });

test("host learning status and blocked/invalid actions never read conversation histories", async () => {
  const read = fs.readFileSync, seen: string[] = [];
  const guard = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) => { if (String(path).startsWith(history)) { seen.push(String(path)); throw new Error("unexpected history read"); } return (read as any)(path, ...args); }) as typeof fs.readFileSync);
  try {
    const status = await call("status"); expect(status.status).toBe(200); expect(await status.json()).toEqual({ host, learning_api: 1, sources: ["claude"], blocked_reason: null });
    expect((await call("preview", {}, io, "wrong-host")).status).toBe(409);
    expect((await call("preview", { path: history })).status).toBe(400);
    expect((await call("run", { request_id: crypto.randomUUID(), preview_digest: "a".repeat(64), confirm_only: true })).status).toBe(404);
    fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { enabled: false } } }));
    expect((await call("preview")).status).toBe(409);
    expect((await call("run", { request_id: crypto.randomUUID(), preview_digest: "b".repeat(64), confirm_only: true })).status).toBe(404);
    expect(seen).toEqual([]); expect(fs.existsSync(checkpoint)).toBe(false); expect(taskFiles()).toHaveLength(0);
  } finally { guard.mockRestore(); }
});

test("the any-machine sentinel cannot create a private learning preview or task", async () => {
  fs.writeFileSync(P("config.toml"), "[host]\nname='any'\n[clis]\nenabled=['claude']\n[learn]\nsources=['claude']\n");
  const read = fs.readFileSync;
  const guard = spyOn(fs, "readFileSync").mockImplementation(((path: any, ...args: any[]) => {
    if (String(path).startsWith(history)) throw new Error("must not read history before validating source machine");
    return (read as any)(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    const status = await call("status", undefined, io, "any"); expect(status.status).toBe(200);
    expect((await status.json() as any).blocked_reason).toContain("specific name");
    const response = await call("preview", {}, io, "any"); expect(response.status).toBe(409);
    expect((await response.json() as any).error).toContain("specific name");
    expect(taskFiles()).toHaveLength(0); expect(fs.existsSync(checkpoint)).toBe(false);
  } finally { guard.mockRestore(); }
});

test("preview is count-only and checkpoint-free; run uses exactly the privately reviewed content", async () => {
  const p = await preview(); expect(p).toMatchObject({ host, turns: 1, sessions: 1, truncated: false, sources: ["claude"] });
  for (const text of [work, "private@example", "reviewed private"]) expect(JSON.stringify(p)).not.toContain(text);
  expect(fs.existsSync(checkpoint)).toBe(false); expect(taskFiles()).toHaveLength(0); expect(fs.readdirSync(LEARNING_DIR).filter((name) => name.startsWith("digest-"))).toEqual([]);
  expect(fs.statSync(join(LEARNING_DIR, "previews", `${p.preview_digest}.json`)).mode & 0o777).toBe(0o600);
  fs.appendFileSync(file, "\n" + JSON.stringify({ type: "user", message: { content: "NEW UNREVIEWED CONTENT" } }));
  const input = request(p), r = await call("run", input), result = await r.json() as any;
  expect(r.status).toBe(200); expect(validLearningResult(result, { host, action: "run" }, input, r.status)).toBe(true);
  const task = readDoc(P("tasks", "inbox", `${result.id}.md`)); expect(task.meta).toMatchObject({ host, agent: "apprentice", learning_request_id: input.request_id });
  expect(task.body).not.toContain(work); expect(task.body).not.toContain(HOME_DIR);
  const digest = fs.readFileSync(join(LEARNING_DIR, `digest-${input.request_id}.md`), "utf8"); expect(digest).toContain("reviewed private fixture"); expect(digest).not.toContain("NEW UNREVIEWED"); expect(digest).not.toContain("private@example");
  expect(fs.existsSync(checkpoint)).toBe(true);
  const viaServer = await recordRequest(new Request(`http://hub/api/machines/${host}/learning`), io); expect(viaServer.status).toBe(200);
});

test("settings and checkpoint changes invalidate unused previews before any task or consumption", async () => {
  const p = await preview(), input = request(p);
  fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { max_digest_chars: 10000 } } }));
  expect((await call("run", input)).status).toBe(409); expect(fs.existsSync(receiptPath(input))).toBe(false); expect(fs.existsSync(checkpoint)).toBe(false);
  fs.rmSync(P("settings.json")); fs.writeFileSync(checkpoint, "{}");
  expect((await call("run", input)).status).toBe(409); expect(taskFiles()).toHaveLength(0); expect(fs.readFileSync(checkpoint, "utf8")).toBe("{}");
});

test("partial sync retains the original identity and historical replay never recreates a deleted task", async () => {
  const input = request(await preview()), partial = await call("run", input, { ...io, push: async () => false }), first = await partial.json() as any;
  expect(partial.status).toBe(503); expect(first).toMatchObject({ host, request_id: input.request_id, preview_digest: input.preview_digest, saved_locally: true });
  const state = fs.readFileSync(checkpoint, "utf8"); fs.rmSync(P("tasks", "inbox", `${first.id}.md`)); fs.rmSync(history, { recursive: true }); process.env.PATH = "";
  fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { enabled: false } } }));
  const again = await call("run", { ...input, confirm_only: true }), result = await again.json() as any;
  expect(again.status).toBe(200); expect(result).toMatchObject({ id: first.id, applied: true, replayed: true, request_id: input.request_id });
  expect(taskFiles()).toHaveLength(0); expect(fs.readFileSync(checkpoint, "utf8")).toBe(state);
  expect((await call("run", { ...input, preview_digest: "f".repeat(64) })).status).toBe(409);
});

test("a crash between task creation and queued proof finishes the same task without scanning again", async () => {
  const input = request(await preview()), rename = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === receiptPath(input)) throw new Error("queued receipt fixture failure"); return rename(from, to); });
  let first: any;
  try { const r = await call("run", input); first = await r.json(); expect(r.status).toBe(503); } finally { fault.mockRestore(); }
  expect(first.id).toMatch(/^T-/); expect(taskFiles()).toHaveLength(1); expect(fs.existsSync(checkpoint)).toBe(false);
  const receipt = fs.readFileSync(receiptPath(input), "utf8");
  expect((await call("preview")).status).toBe(409); expect(fs.readFileSync(receiptPath(input), "utf8")).toBe(receipt); expect(fs.existsSync(checkpoint)).toBe(false);
  const pending = await (await call("status")).json() as any; expect(pending.pending).toMatchObject({ request_id: input.request_id, id: first.id });
  fs.rmSync(history, { recursive: true }); fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { enabled: false } } }));
  const replay = await call("run", { ...input, confirm_only: true }); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: first.id, applied: true, replayed: true }); expect(taskFiles()).toHaveLength(1);
});

test("an unproven prepared task is never recreated; release preserves data and confirms after restart", async () => {
  const input = request(await preview()), write = fs.writeFileSync;
  const fault = spyOn(fs, "writeFileSync").mockImplementation(((path: any, ...args: any[]) => { if (String(path).includes("/tasks/inbox/") && String(path).endsWith(".md")) throw new Error("task fixture failure"); return (write as any)(path, ...args); }) as typeof fs.writeFileSync);
  let first: any;
  try { const r = await call("run", input); first = await r.json(); expect(r.status).toBe(503); } finally { fault.mockRestore(); }
  expect(taskFiles()).toHaveLength(0); expect(fs.existsSync(checkpoint)).toBe(false);
  expect((await call("run", { ...input, confirm_only: true })).status).toBe(409); expect(() => queueLearning(loadConfig())).toThrow("saved collection");
  const digest = fs.readFileSync(join(LEARNING_DIR, `digest-${input.request_id}.md`), "utf8");
  const released = await call("discard", input); expect(released.status).toBe(200); expect(await released.json()).toMatchObject({ discarded: true, id: first.id, request_id: input.request_id });
  expect(fs.readFileSync(join(LEARNING_DIR, `digest-${input.request_id}.md`), "utf8")).toBe(digest); expect(fs.existsSync(checkpoint)).toBe(false);
  fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { enabled: false } } }));
  expect(await (await call("run", { ...input, confirm_only: true })).json()).toMatchObject({ discarded: true, replayed: true, id: first.id });
  fs.rmSync(P("settings.json")); const fresh = request(await preview()), result = await (await call("run", fresh)).json() as any;
  expect(result.id).not.toBe(first.id); expect(taskFiles()).toHaveLength(1);
});

test("queued checkpoint recovery never overwrites a third state and release remains available", async () => {
  const input = request(await preview()), rename = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === checkpoint) throw new Error("checkpoint fixture failure"); return rename(from, to); });
  try { expect((await call("run", input)).status).toBe(503); } finally { fault.mockRestore(); }
  expect(JSON.parse(fs.readFileSync(receiptPath(input), "utf8")).state).toBe("queued");
  fs.writeFileSync(checkpoint, JSON.stringify({ changed_elsewhere: 1 })); const before = fs.readFileSync(checkpoint, "utf8");
  expect((await call("preview")).status).toBe(409); expect((await call("run", { ...input, confirm_only: true })).status).toBe(409);
  expect(fs.readFileSync(checkpoint, "utf8")).toBe(before); expect(taskFiles()).toHaveLength(1);
  expect((await call("discard", input)).status).toBe(200); expect(fs.readFileSync(checkpoint, "utf8")).toBe(before); expect(taskFiles()).toHaveLength(1);
});

test("renamed machine homes neither recover nor invisibly block on a foreign saved operation", async () => {
  const input = request(await preview()), rename = fs.renameSync;
  const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === checkpoint) throw new Error("checkpoint fixture failure"); return rename(from, to); });
  try { expect((await call("run", input)).status).toBe(503); } finally { fault.mockRestore(); }
  const old = fs.readFileSync(receiptPath(input), "utf8"), renamed = "renamed-worker";
  fs.writeFileSync(P("config.toml"), `[host]\nname = '${renamed}'\n[clis]\nenabled = ['claude']\n[learn]\nsources = ['claude']\n`);
  const status = await (await call("status", undefined, io, renamed)).json() as any;
  expect(status.host).toBe(renamed); expect(status.pending).toBeUndefined();
  expect((await call("preview", {}, io, renamed)).status).toBe(200);
  expect((await call("run", { ...input, confirm_only: true }, io, renamed)).status).toBe(409);
  expect((await call("discard", input, io, renamed)).status).toBe(409);
  expect(fs.readFileSync(receiptPath(input), "utf8")).toBe(old); expect(fs.existsSync(checkpoint)).toBe(false);
});

test("Noop-only previews count owner interactions and empty collections preserve a historical null task", async () => {
  fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { sources: ["noop"] } } }));
  appendEvent({ from: "owner", kind: "owner", text: "Count this selected Noop history fixture." });
  const p = await preview(); expect(p.turns).toBeGreaterThan(0); expect(p.sessions).toBe(0);
  const first = await (await call("run", request(p))).json() as any; expect(first.id).not.toBeNull();
  fs.writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { sources: ["claude"] } } })); fs.rmSync(file);
  const input = request(await preview()), zero = await (await call("run", input)).json() as any; expect(zero).toMatchObject({ id: null, turns: 0, sessions: 0, applied: true });
  expect(await (await call("run", { ...input, confirm_only: true })).json()).toMatchObject({ id: null, applied: true, replayed: true });
});

test("CLI learn --dry retains its digest-path output without consuming history or creating a task", async () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", NOOP_HOME: HOME_DIR, HUB_DATA: P(), HUB_SYNC: "local", HUB_NO_MEDIC: "1" };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  const proc = Bun.spawn([process.execPath, cli, "learn", "--dry"], { env, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text(), error = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0); expect(error).toBe("");
  const match = output.trim().match(/^1 owner turns from 1 sessions → (.+)$/);
  expect(match).not.toBeNull(); expect(match![1]!.startsWith(`${LEARNING_DIR}/digest-`)).toBe(true);
  expect(fs.readFileSync(match![1]!, "utf8")).toContain("reviewed private fixture");
  expect(fs.existsSync(checkpoint)).toBe(false); expect(taskFiles()).toHaveLength(0);
  const actual = await (await call("run", request(await preview()))).json() as any;
  expect(actual.turns).toBe(1); expect(actual.id).not.toBeNull();
});

test("the SQLite collection mutex excludes a second real process and all collector callers", async () => {
  const ready = join(work, "ready"), release = join(work, "release"), sessions = new URL("../src/sessions.ts", import.meta.url).pathname;
  const code = `import{collectionLocked}from ${JSON.stringify(sessions)};import{existsSync,writeFileSync}from'node:fs';collectionLocked(()=>{writeFileSync(${JSON.stringify(ready)},'ready');const until=Date.now()+10000;while(!existsSync(${JSON.stringify(release)})&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);});`;
  const proc = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, NOOP_HOME: HOME_DIR, HUB_DATA: P() }, stdout: "pipe", stderr: "pipe" });
  try {
    const until = Date.now() + 5000; while (!fs.existsSync(ready) && Date.now() < until) await Bun.sleep(10);
    expect(fs.existsSync(ready)).toBe(true); expect((await call("preview")).status).toBe(409);
    expect(() => collect(loadConfig())).toThrow("Another learning operation"); expect(() => queueLearning(loadConfig())).toThrow("Another learning operation");
    expect(fs.existsSync(checkpoint)).toBe(false);
  } finally { fs.writeFileSync(release, "release"); if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text()); }
  expect((await call("preview")).status).toBe(200);
});

test("malformed receipts cannot escape task paths or cross the count-only response boundary", async () => {
  const input = request(await preview()); await call("run", input);
  const value = JSON.parse(fs.readFileSync(receiptPath(input), "utf8")); value.id = "../../outside0001"; value.state = "prepared"; value.extra = "private@example.com";
  fs.writeFileSync(receiptPath(input), JSON.stringify(value));
  const response = await call("status"), body = await response.json(); expect(response.status).toBe(503);
  expect(JSON.stringify(body)).not.toContain("outside0001"); expect(JSON.stringify(body)).not.toContain("private@example"); expect(taskFiles()).toHaveLength(1);
});
