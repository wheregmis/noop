import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, P, list, readDoc, setApprovalGate } from "../src/core";
import { appendEvent, configurationView, learningRoute, recordRequest } from "../src/server";
import { recordPath } from "../cloud/src/ui-requests";

const io = { pull: async () => true, push: async () => true };
const initialPath = process.env.PATH;
const state = join(HOME_DIR, "learn", "state.json");
let root = "";
const req = (body: unknown = {}, method = "POST") => new Request("http://hub/api/learning/run", {
  method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "noop-learning-action-"));
  for (const folder of ["tasks", "agents", "journal"]) rmSync(P(folder), { recursive: true, force: true });
  for (const folder of ["agents/apprentice", "journal"]) mkdirSync(P(folder), { recursive: true });
  rmSync(join(HOME_DIR, "learn"), { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true }); rmSync(P("config.local.toml"), { force: true });
  const bin = join(root, "bin"), history = join(root, "history"); mkdirSync(bin); mkdirSync(history);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\nexit 99\n", { mode: 0o755 });
  process.env.PATH = `${bin}:${initialPath ?? ""}`;
  writeFileSync(P("agents/apprentice/profile.md"), "# Apprentice\nLearn the owner's durable preferences.\n");
  writeFileSync(P("config.toml"), `[host]\nname = "test-main"\n[clis]\nenabled = ["claude"]\n[learn]\nsources = ["claude"]\nclaude_dir = ${JSON.stringify(history)}\n`);
  const file = join(history, "session.jsonl"), old = (Date.now() - 20 * 60_000) / 1000;
  writeFileSync(file, JSON.stringify({ type: "user", timestamp: new Date(old * 1000).toISOString(), message: { content: "Prefer focused changes. Email private@example.com" } }));
  utimesSync(file, old, old);
  setApprovalGate(() => false);
});
afterEach(() => { process.env.PATH = initialPath; rmSync(root, { recursive: true, force: true }); rmSync(P("fleet", "task-ids"), { recursive: true, force: true }); });

test("learning action queues selected history on the main machine without returning private contents", async () => {
  expect(recordPath("/api/learning/run")).toEqual({ kind: "learning" });
  const view = configurationView();
  expect(view.learning).toEqual({ host: "test-main", blocked_reason: null });
  expect(existsSync(state)).toBe(false);
  const response = await recordRequest(req(), io), body = await response.json() as any;
  expect(response.status).toBe(200);
  expect(body).toEqual({ id: expect.stringMatching(/^T-\d+/), host: "test-main", turns: 1, sessions: 1 });
  for (const secret of ["private@example.com", "Prefer focused", root, "digest-"]) expect(JSON.stringify(body)).not.toContain(secret);
  const task = readDoc(P("tasks/inbox", `${body.id}.md`));
  expect(task.meta).toMatchObject({ agent: "apprentice", host: "test-main", source: "owner@test-main", priority: "high" });
  expect(task.body).toContain("local to this machine");
  const second = await learningRoute(req(), io);
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ id: null, host: "test-main", turns: 0, sessions: 0 });
  expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("learning rejects invalid methods and arbitrary settings before reading history", async () => {
  let pulls = 0;
  const tracked = { ...io, pull: async () => { pulls++; return true; } };
  for (const method of ["GET", "PUT", "DELETE"]) expect((await learningRoute(req({}, method), tracked)).status).toBe(405);
  for (const body of [null, [], "", { full: true }, { path: root }, { sources: ["codex"] }, { enabled: true }])
    expect((await learningRoute(req(body), tracked)).status).toBe(400);
  expect(pulls).toBe(0); expect(existsSync(state)).toBe(false);
  expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("paused learning, missing apprentice and unavailable tools never consume history", async () => {
  for (const configuration of [{ learn: { enabled: false } }, { learn: { sources: [] } }, { host: { enabled: false } }, { clis: { enabled: [] } }, { clis: { agents: { apprentice: [] } } }]) {
    writeFileSync(P("settings.json"), JSON.stringify({ configuration }));
    expect((await learningRoute(req(), io)).status).toBe(409);
    expect(existsSync(state)).toBe(false);
  }
  rmSync(P("settings.json"));
  rmSync(P("agents/apprentice/profile.md"));
  expect((await learningRoute(req(), io)).status).toBe(409); expect(existsSync(state)).toBe(false);
  writeFileSync(P("agents/apprentice/profile.md"), "# Apprentice");
  process.env.PATH = root;
  expect((await learningRoute(req(), io)).status).toBe(409); expect(existsSync(state)).toBe(false);
  expect(list(P("tasks/inbox"))).toHaveLength(0);
});

test("a failed refresh prevents reads and successful refresh uses the latest source selections", async () => {
  const failed = await learningRoute(req(), { ...io, pull: async () => false });
  expect(failed.status).toBe(503); expect(existsSync(state)).toBe(false);
  const changed = await learningRoute(req(), { ...io, pull: async () => {
    writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { enabled: false } } })); return true;
  } });
  expect(changed.status).toBe(409); expect(existsSync(state)).toBe(false);
});

test("a partial sync returns the saved task identity for recovery without repeating collection", async () => {
  const response = await learningRoute(req(), { ...io, push: async () => false }), body = await response.json() as any;
  expect(response.status).toBe(503); expect(body.saved_locally).toBe(true);
  expect(body.id).toMatch(/^T-\d+/); expect(existsSync(P("tasks/inbox", `${body.id}.md`))).toBe(true);
  const watermark = readFileSync(state, "utf8");
  const again = await learningRoute(req(), io);
  expect((await again.json() as any).id).toBeNull();
  expect(readFileSync(state, "utf8")).toBe(watermark); expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("a failed task write preserves history and returns no private file paths", async () => {
  writeFileSync(P("tasks"), "unwritable queue fixture");
  const response = await learningRoute(req(), io), body = await response.json();
  expect(response.status).toBe(503);
  expect(JSON.stringify(body)).not.toContain(P("tasks"));
  expect(JSON.stringify(body)).not.toContain(root);
  expect(JSON.stringify(body)).not.toContain("digest-");
  expect(existsSync(state)).toBe(false);
  rmSync(P("tasks"));
  const retried = await learningRoute(req(), io);
  expect(retried.status).toBe(200);
  expect((await retried.json() as any).turns).toBe(1);
});


test("unreadable selected Hermes history reports a safe error without consuming other sources", async () => {
  const file = join(root, "private-history.db");
  writeFileSync(file, "not a sqlite database");
  writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { sources: ["claude", "hermes"] } } }));
  writeFileSync(P("config.local.toml"), `[learn]\nhermes_db = ${JSON.stringify(file)}\n`);
  const response = await learningRoute(req(), io), body = await response.json() as any;
  expect(response.status).toBe(500);
  expect(body.error).toContain("Hermes"); expect(body.error).toContain("permissions"); expect(body.error).toContain("deselect");
  expect(JSON.stringify(body)).not.toContain(root); expect(JSON.stringify(body)).not.toContain("private-history.db");
  expect(existsSync(state)).toBe(false); expect(list(P("tasks/inbox"))).toHaveLength(0);
  writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { sources: ["claude"] } } }));
  const retried = await learningRoute(req(), io);
  expect(retried.status).toBe(200); expect((await retried.json() as any).turns).toBe(1);
});


test("Noop chat can be learned before any decisions exist and stays untouched while deselected", async () => {
  rmSync(P("decisions"), { recursive: true, force: true });
  const instruction = "Prefer readable summaries before implementation details.";
  appendEvent({ kind: "owner", from: "owner", text: instruction });
  const externalOnly = await learningRoute(req(), io);
  expect(externalOnly.status).toBe(200);
  expect(JSON.parse(readFileSync(state, "utf8")).__hub_since).toBeUndefined();
  writeFileSync(P("settings.json"), JSON.stringify({ configuration: { learn: { sources: ["noop"] } } }));
  const selected = await learningRoute(req(), io), body = await selected.json() as any;
  expect(selected.status).toBe(200); expect(body.id).toMatch(/^T-\d+/);
  const digests = list(join(HOME_DIR, "learn"), /^digest-/).map((file) => readFileSync(file, "utf8"));
  expect(digests.some((digest) => digest.includes(instruction))).toBe(true);
  const repeated = await learningRoute(req(), io);
  expect((await repeated.json() as any).id).toBeNull();
});
