import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE, P, loadConfig } from "../src/core";
import type { RequestError } from "../src/members";
import { createRoutine, deleteRoutine, readRoutine, renderRoutine, routineBlocks, updateRoutine } from "../src/routines";
import { recordRequest as serverRecordRequest, routineRoute, settingsView } from "../src/server";

const RECORD_IO = { pull: async () => true, push: async () => true };
const recordRequest = (req: Request) => serverRecordRequest(req, RECORD_IO);

const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as RequestError).status; } };
const parsed = () => Bun.TOML.parse(readFileSync(P("config.toml"), "utf8")) as any;
const FORM = { name: "weekly-deps", every: "weekly MON 09:00", agent: "lead", prompt: "Check dependencies.", enabled: true };
const CONFIG = `# my notes at the top
[owner]
name = "Me"

# about routines
[[routine]]
name = "first"   # a comment on the name
every = "15m"
agent = "lead"
weight = "heavy"
signal = "git log -1"
prompt = """Line one
[not a table] in a prompt
[[routine]]
name = "fake"
Line last."""

# about the second one
[[routine]]
name = "second"
enabled = false
every = "hourly"
agent = "lead"
prompt = "Two."

# keep this comment with email
[email]
to = "me@example.com"

[[routine]]
name = "learner"
kind = "learn"
every = "daily 04:00"
`;

beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true });
  for (const d of ["agents", "projects", "archive"]) rmSync(P(d), { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true });
  mkdirSync(P("agents", "lead"), { recursive: true });
  writeFileSync(P("agents", "lead", "profile.md"), "# Lead\n\nLead.\n");
  writeFileSync(P("config.toml"), CONFIG);
});

test("blocks are found exactly, whatever a prompt contains", () => {
  const b = routineBlocks(CONFIG);
  expect(b.map((x) => x.name)).toEqual(["first", "second", "learner"]);
  expect(CONFIG.slice(b[0].start, b[0].end).endsWith('Line last."""\n')).toBe(true);
  expect(CONFIG.slice(b[1].end)).toStartWith("\n# keep this comment with email");
  expect(CONFIG.slice(b[2].start, b[2].end)).toContain("learn");
});

test("every shipped config can have each routine edited and deleted", () => {
  for (const f of [join(CODE, "templates/config.toml"), ...readdirSync(join(CODE, "roles")).map((r) => join(CODE, "roles", r, "routines.toml")).filter(existsSync)]) {
    const text = readFileSync(f, "utf8");
    const names = ((Bun.TOML.parse(text) as any).routine ?? []).map((r: any) => r.name);
    expect(routineBlocks(text).map((b) => b.name)).toEqual(names);
    for (const name of names) {
      writeFileSync(P("config.toml"), text);
      const was = (Bun.TOML.parse(text) as any).routine.find((r: any) => r.name === name);
      updateRoutine(name, { ...was, agent: "lead", desc: "edited" });
      const now = parsed().routine.find((r: any) => r.name === name);
      expect(now).toEqual({ ...was, ...(was.kind ? {} : { agent: "lead", prompt: was.prompt.trim() }), desc: "edited", enabled: was.enabled !== false });
      deleteRoutine(name);
      expect(parsed().routine?.some((r: any) => r.name === name) ?? false).toBe(false);
    }
  }
});

test("creating appends a routine and leaves everything else as it was", () => {
  expect(createRoutine({ ...FORM, readonly: true, desc: "Weekly check", project: "" })).toBe("weekly-deps");
  const text = readFileSync(P("config.toml"), "utf8");
  expect(text.startsWith(CONFIG.trimEnd())).toBe(true);
  expect(parsed().routine.at(-1)).toEqual({ name: "weekly-deps", every: "weekly MON 09:00", enabled: true, readonly: true, desc: "Weekly check", agent: "lead", prompt: "Check dependencies." });
  expect(status(() => createRoutine(FORM))).toBe(409);
  expect(readRoutine("weekly-deps")).toMatchObject({ name: "weekly-deps", readonly: true, desc: "Weekly check", prompt: "Check dependencies.", enabled: true });
  expect(settingsView().effective.routines.at(-1)).toMatchObject({ name: "weekly-deps", readonly: true, enabled: true });
});

test("creating then deleting leaves the file exactly as it was", () => {
  const before = readFileSync(P("config.toml"), "utf8");
  createRoutine(FORM);
  deleteRoutine(FORM.name);
  expect(readFileSync(P("config.toml"), "utf8")).toBe(before);
});

test("input is checked at the boundary", () => {
  const before = readFileSync(P("config.toml"), "utf8");
  for (const bad of [null, {}, { ...FORM, name: "Bad Name" }, { ...FORM, name: "" }, { ...FORM, every: "soon" }, { ...FORM, every: "0m" }, { ...FORM, every: "daily 25:00" }, { ...FORM, every: "daily 09:75" }, { ...FORM, every: "hourly 09:00" }, { ...FORM, every: "weekly FUNDAY 09:00" },
    { ...FORM, agent: "ghost" }, { ...FORM, agent: "../lead" }, { ...FORM, prompt: " " }, { ...FORM, prompt: "x".repeat(20_001) }, { ...FORM, desc: "a\nb" }, { ...FORM, project: "ghost" }]) {
    expect(status(() => createRoutine(bad))).toBe(400);
  }
  for (const every of ["1m", "30m", "hourly", "daily 9:00", "daily 23:59", "weekdays 09:00", "weekly fri 17:30"]) expect(status(() => createRoutine({ ...FORM, name: `ok-${every.replace(/\W/g, "").toLowerCase()}`, every }))).toBe(0);
  expect(readFileSync(P("config.toml"), "utf8").startsWith(before.trimEnd())).toBe(true);
  expect(status(() => readRoutine("ghost"))).toBe(404);
  expect(status(() => updateRoutine("ghost", FORM))).toBe(404);
  expect(status(() => deleteRoutine("ghost"))).toBe(404);
});

test("strings that could break the file survive it, and multi-line prompts stay readable", () => {
  for (const prompt of ['say "hi" and \\d+ # not a comment', 'three """ quotes\nand \\ a slash\nends with a quote"', "[[routine]]\nname = \"fake\"\n[email]"]) {
    const name = `s${prompt.length}`;
    createRoutine({ ...FORM, name, prompt });
    expect(readRoutine(name).prompt).toBe(prompt);
    updateRoutine(name, { ...FORM, name, prompt: `${prompt}\nmore` });
    expect(readRoutine(name).prompt).toBe(`${prompt}\nmore`);
    expect(parsed().email.to).toBe("me@example.com");
    deleteRoutine(name);
  }
  expect(renderRoutine({ name: "a", prompt: "x\ny" })).toContain('prompt = """\nx\ny"""');
});

test("editing keeps fields the form doesn't show, other routines, and comments", () => {
  updateRoutine("first", { name: "first", every: "30m", agent: "lead", prompt: "New words", enabled: false });
  const r = parsed().routine;
  expect(r[0]).toEqual({ name: "first", every: "30m", agent: "lead", weight: "heavy", signal: "git log -1", prompt: "New words", enabled: false });
  expect(r[1].prompt).toBe("Two.");
  const text = readFileSync(P("config.toml"), "utf8");
  for (const kept of ["# my notes at the top", "# about routines", "# about the second one", "# keep this comment with email"]) expect(text).toContain(kept);
  expect(parsed().email.to).toBe("me@example.com");
});

test("renaming keeps its place; a taken name is refused", () => {
  updateRoutine("first", { name: "renamed", every: "15m", agent: "lead", prompt: "p" });
  expect(parsed().routine.map((r: any) => r.name)).toEqual(["renamed", "second", "learner"]);
  expect(status(() => updateRoutine("renamed", { name: "second", every: "15m", agent: "lead", prompt: "p" }))).toBe(409);
});

test("a learn routine needs no member or prompt, and keeps its kind", () => {
  updateRoutine("learner", { name: "learner", every: "daily 05:00" });
  expect(parsed().routine[2]).toEqual({ name: "learner", kind: "learn", every: "daily 05:00", enabled: true });
  expect(readRoutine("learner").kind).toBe("learn");
});

test("what Settings saved over the file gives way to the form, and shows until then", () => {
  writeFileSync(P("settings.json"), JSON.stringify({ routines: { second: { enabled: true, every: "30m" } }, media_days: 7 }));
  expect(readRoutine("second")).toMatchObject({ enabled: true, every: "30m" });
  updateRoutine("second", { name: "second", every: "hourly", agent: "lead", prompt: "Two.", enabled: false });
  expect(loadConfig().routine.find((r: any) => r.name === "second")).toMatchObject({ enabled: false, every: "hourly" });
  const s = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(s).toEqual({ routines: {}, media_days: 7 });
});

test("deleting archives the block and clears what was saved over it", () => {
  writeFileSync(P("settings.json"), JSON.stringify({ routines: { first: { enabled: false } } }));
  deleteRoutine("first");
  const text = readFileSync(P("config.toml"), "utf8");
  expect(parsed().routine.map((r: any) => r.name)).toEqual(["second", "learner"]);
  expect(text).toContain("# about routines");
  expect(text).not.toContain("Line last");
  const [saved] = readdirSync(P("archive", "routines"));
  expect(saved.startsWith("first-")).toBe(true);
  expect(readFileSync(P("archive", "routines", saved), "utf8")).toContain("Line last");
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines).toEqual({});
});

test("a layout the app can't edit safely is refused, not guessed at", () => {
  writeFileSync(P("config.toml"), `routine = [{ name = "inline", every = "1h", agent = "lead", prompt = "p" }]\n`);
  const before = readFileSync(P("config.toml"), "utf8");
  expect(status(() => updateRoutine("inline", { name: "inline", every: "30m", agent: "lead", prompt: "p" }))).toBe(409);
  expect(status(() => deleteRoutine("inline"))).toBe(409);
  expect(readFileSync(P("config.toml"), "utf8")).toBe(before);
});

test("the API creates, reads, edits and deletes", async () => {
  const call = async (method: string, id?: string, body?: unknown) => {
    const r = await routineRoute(new Request("http://x/api/routines", { method, body: body === undefined ? undefined : JSON.stringify(body) }), id, RECORD_IO);
    return { status: r.status, data: (await r.json()) as any };
  };
  const made = await call("POST", undefined, FORM);
  expect(made.data.id).toBe("weekly-deps");
  expect(made.data.view.effective.routines.some((r: any) => r.name === "weekly-deps")).toBe(true);
  expect((await call("GET", "weekly-deps")).data.prompt).toBe("Check dependencies.");
  expect((await call("POST", undefined, {})).status).toBe(400);
  expect((await call("PUT", "weekly-deps", { ...FORM, enabled: false })).data.view.effective.routines.find((r: any) => r.name === "weekly-deps").enabled).toBe(false);
  expect((await call("DELETE", "weekly-deps")).data.view.effective.routines.some((r: any) => r.name === "weekly-deps")).toBe(false);
  expect((await call("DELETE", "weekly-deps")).status).toBe(404);
});


test("routine run settings round trip and reject malformed placement", () => {
  const placement = { requires: "os:macos,cli:cargo", host: "mac", cli: "codex", priority: "high" };
  createRoutine({ ...FORM, ...placement });
  expect(readRoutine(FORM.name)).toMatchObject(placement);
  updateRoutine(FORM.name, { ...FORM, requires: "", host: "any", cli: "auto", priority: "normal" });
  expect(readRoutine(FORM.name)).toMatchObject({ requires: "", host: "any", cli: "auto", priority: "normal" });
  for (const bad of [{ requires: "os:macos\n" }, { host: "mac\n" }, { cli: "bash" }, { priority: "asap" }]) {
    expect(status(() => updateRoutine(FORM.name, { ...FORM, ...bad }))).toBe(400);
  }
});


test("remote dispatcher uses the same routine validation and persisted settings as the local form", async () => {
  const { applyUiRequest } = await import("../src/ui-requests");
  const id = crypto.randomUUID();
  let response: any;
  const send = async (_path: string, init: RequestInit) => {
    if (init.method === "POST") return { job: { method: "POST", path: "/api/routines", body: { ...FORM, requires: "os:macos", host: "mac" } } };
    response = JSON.parse(String(init.body));
    return { ok: true };
  };
  await applyUiRequest(id, send, recordRequest, new Map());
  expect(response.status).toBe(200);
  expect(response.data.id).toBe(FORM.name);
  expect(readRoutine(FORM.name)).toMatchObject({ requires: "os:macos", host: "mac" });
  expect((await recordRequest(new Request("http://hub/api/settings"))).status).toBe(200);
  const bad = await recordRequest(new Request("http://hub/api/routines", { method: "POST", body: JSON.stringify({ ...FORM, name: "bad", every: "soon" }) }));
  expect(bad.status).toBe(400);
  expect((await bad.json() as any).error).toContain("schedule");
});


test("advanced routine settings round trip, clear explicitly, and preserve hidden fields on older clients", () => {
  const values = { prefer: "os:macos,gpu", weight: "heavy", repo: "~/work/app", scheduler: "each", signal: "printf 'stable'" };
  createRoutine({ ...FORM, ...values });
  expect(readRoutine(FORM.name)).toMatchObject(values);
  updateRoutine(FORM.name, { ...FORM, every: "hourly" });
  expect(readRoutine(FORM.name)).toMatchObject(values);
  updateRoutine(FORM.name, { ...FORM, prefer: "", weight: "normal", repo: "", scheduler: "primary", signal: "" });
  expect(readRoutine(FORM.name)).toMatchObject({ prefer: "", weight: "normal", repo: "", scheduler: "primary", signal: "" });
  for (const bad of [{ prefer: "gpu;rm" }, { weight: "huge" }, { scheduler: "bad\nname" }, { repo: "folder\nagent: other" }, { signal: "bad\0command" }, { project: "../config" }])
    expect(status(() => updateRoutine(FORM.name, { ...FORM, ...bad }))).toBe(400);
});
