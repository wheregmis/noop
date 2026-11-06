import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE, P, agentName } from "../src/core";
import { RequestError, createMember, deleteBlockers, deleteMember, parseProfile, readMember, renderProfile, updateMember } from "../src/members";
import { agentRole, memberRoute, settingsView } from "../src/server";
import { buildPrompt } from "../src/runner";

const RECORD_IO = { pull: async () => true, push: async () => true };

const FORM = { title: "Backend Engineer", name: "Ada", about: "owns the API", instructions: "Run the tests first.\n\nName: not this one" };
const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as RequestError).status; } };

beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true });
  for (const d of ["agents", "tasks", "archive"]) rmSync(P(d), { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true });
  mkdirSync(P("agents"), { recursive: true });
  writeFileSync(P("config.toml"), "");
});

test("every shipped profile survives an edit that changes nothing", () => {
  for (const dir of ["templates/agents", "roles"]) for (const id of readdirSync(join(CODE, dir))) {
    const text = readFileSync(join(CODE, dir, id, "profile.md"), "utf8");
    const p = parseProfile(text);
    const again = parseProfile(renderProfile({ title: p.title!, name: p.name ?? p.title!, about: p.about ?? "", instructions: p.instructions }));
    expect(again).toEqual({ ...p, name: p.name ?? p.title! });
    expect(p.instructions.length).toBeGreaterThan(0);
  }
});

test("a new member gets an id from its role, and the fleet sees it", () => {
  const id = createMember(FORM);
  expect(id).toBe("backend-engineer");
  expect(createMember(FORM)).toBe("backend-engineer-2");
  expect(readMember(id)).toEqual({ id, ...FORM });
  expect(agentName(id)).toBe("Ada");
  expect(agentRole(id)).toEqual({ title: "Backend Engineer", about: "owns the API" });
  expect(settingsView().effective.agents.map((a: { id: string }) => a.id).sort()).toEqual(["backend-engineer", "backend-engineer-2"]);
  expect(buildPrompt({ agent: id, claimed_by: "h" }, "do it", {} as never)).toContain("Run the tests first.");
});

test("ids stay safe: reserved or unusable roles get another", () => {
  expect(createMember({ ...FORM, title: "Owner" })).toBe("owner-2");
  expect(createMember({ ...FORM, title: "运维" })).toBe("member");
});

test("the name defaults to the role, and editing keeps the id and memory", () => {
  const id = createMember({ title: "Writer", instructions: "Write." });
  expect(readMember(id).name).toBe("Writer");
  writeFileSync(P("agents", id, "memory.md"), "kept\n");
  updateMember(id, { ...FORM, title: "Senior Writer" });
  expect(readMember(id).title).toBe("Senior Writer");
  expect(readFileSync(P("agents", id, "memory.md"), "utf8")).toBe("kept\n");
});

test("the title wins over the built-in role text once edited", () => {
  mkdirSync(P("agents", "lead"), { recursive: true });
  writeFileSync(P("agents", "lead", "profile.md"), "# Tech Lead\nName: Kai\n\nLead.\n");
  expect(agentRole("lead").title).toBe("Tech Lead");
});

test("bad input is refused", () => {
  for (const bad of [null, {}, { title: "A" }, { instructions: "x" }, { ...FORM, title: "A (B)" }, { ...FORM, title: "A — B" }, { ...FORM, about: "a\nb" }, { ...FORM, name: "a\nb" }, { ...FORM, instructions: "x".repeat(20_001) }]) {
    expect(status(() => createMember(bad))).toBe(400);
  }
  expect(readdirSync(P("agents"))).toEqual([]);
  expect(status(() => readMember("ghost"))).toBe(404);
  expect(status(() => updateMember("ghost", FORM))).toBe(404);
});

test("deleting archives the member and clears its settings", () => {
  const id = createMember(FORM);
  writeFileSync(P("agents", id, "memory.md"), "kept\n");
  writeFileSync(P("settings.json"), JSON.stringify({ clis: { agents: { [id]: ["codex"], other: ["claude"] } }, autonomy: { agents: { [id]: "assisted" } } }));
  deleteMember(id, {} as never);
  expect(existsSync(P("agents", id))).toBe(false);
  const [saved] = readdirSync(P("archive", "agents"));
  expect(saved.startsWith(`${id}-`)).toBe(true);
  expect(readFileSync(P("archive", "agents", saved, "memory.md"), "utf8")).toBe("kept\n");
  const s = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(s.clis.agents).toEqual({ other: ["claude"] });
  expect(s.autonomy.agents).toEqual({});
});

test("a member with work left can't be deleted", () => {
  const id = createMember(FORM);
  mkdirSync(P("tasks", "waiting"), { recursive: true });
  mkdirSync(P("tasks", "done"), { recursive: true });
  writeFileSync(P("tasks", "done", "T-0001.md"), `---\nid: T-0001\nagent: ${id}\n---\n`);
  expect(deleteBlockers(id, {} as never)).toEqual([]);
  writeFileSync(P("tasks", "waiting", "T-0002.md"), `---\nid: T-0002\nagent: ${id}\n---\n`);
  const cfg = { routine: [{ name: "r1", agent: id }] } as never;
  expect(deleteBlockers(id, cfg)).toEqual(["routines: r1", "open tasks: T-0002"]);
  expect(status(() => deleteMember(id, cfg))).toBe(409);
  expect(existsSync(P("agents", id, "profile.md"))).toBe(true);
  expect(deleteBlockers("lead", {} as never)).toHaveLength(1);
  expect(deleteBlockers("chief-of-staff", { idle: { enabled: true } } as never)).toHaveLength(1);
  expect(deleteBlockers("apprentice", { routine: [{ name: "learn", kind: "learn" }] } as never)).toEqual(["routines: learn"]);
});

test("the API creates, reads, edits and deletes, and reports errors", async () => {
  const call = async (method: string, id?: string, body?: unknown) => {
    const r = await memberRoute(new Request("http://x/api/members", { method, body: body === undefined ? undefined : JSON.stringify(body) }), id, RECORD_IO);
    return { status: r.status, data: (await r.json()) as any };
  };
  const made = await call("POST", undefined, FORM);
  expect(made.status).toBe(200);
  expect(made.data.id).toBe("backend-engineer");
  expect(made.data.view.effective.agents[0].title).toBe("Backend Engineer");
  expect((await call("GET", made.data.id)).data.instructions).toBe(FORM.instructions);
  expect((await call("PUT", made.data.id, { ...FORM, about: "new" })).data.view.effective.agents[0].about).toBe("new");
  expect((await call("POST", undefined, { title: "" })).status).toBe(400);
  expect((await call("PUT", "ghost", FORM)).status).toBe(404);
  expect((await call("PATCH", made.data.id)).status).toBe(404);
  expect((await call("DELETE", made.data.id)).data.view.effective.agents).toEqual([]);
});
