import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { P, loadConfig, newTask, readDoc, setIdTag } from "../src/core";
import { RequestError } from "../src/members";
import { createProject, deleteProject, detectRepo, listProjects, readProject, updateProject } from "../src/projects";
import { buildPrompt } from "../src/runner";
import { projectRoute, settingsView } from "../src/server";
import { type ToolStore, listProjects as toolProjects, writeOp } from "../cloud/src/tools";

const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as RequestError).status; } };
let dir = "";
const FORM = () => ({ name: "My Site", path: dir, instructions: "Run npm test first." });

beforeEach(() => {
  for (const d of ["projects", "tasks", "archive", "agents"]) rmSync(P(d), { recursive: true, force: true });
  mkdirSync(P("agents"), { recursive: true });
  writeFileSync(P("config.toml"), "");
  dir = mkdtempSync(join(tmpdir(), "noop-project-"));
});

test("a project records its folder, machine and instructions", () => {
  const id = createProject(FORM(), "mac");
  expect(id).toBe("my-site");
  expect(createProject({ ...FORM(), path: mkdtempSync(join(tmpdir(), "p2-")) }, "mac")).toBe("my-site-2");
  const p = readProject(id);
  expect(p).toMatchObject({ id, name: "My Site", host: "mac", repo: "", instructions: "Run npm test first.", exists: true });
  expect(p.path.endsWith(dir.split("/").pop()!)).toBe(true);
  expect(settingsView().effective.projects.map((x: { id: string }) => x.id)).toEqual(["my-site", "my-site-2"]);
});

test("~ is expanded, and a GitHub remote is found in either form", () => {
  const home = mkdtempSync(join(homedir(), ".noop-test-"));
  try {
    const name = home.split("/").pop();
    const id = createProject({ name: "Home one", path: `~/${name}` }, "mac");
    expect(readProject(id).path.endsWith(`/${name}`)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
  const git = (url: string) => { rmSync(join(dir, ".git"), { recursive: true, force: true }); Bun.spawnSync(["git", "init", "-q", dir]); Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", url]); return detectRepo(dir); };
  expect(git("https://github.com/acme/site.git")).toBe("acme/site");
  expect(git("git@github.com:acme/site.git")).toBe("acme/site");
  expect(git("https://github.com/acme/site")).toBe("acme/site");
  expect(git("https://gitlab.com/acme/site.git")).toBe("");
  expect(detectRepo(mkdtempSync(join(tmpdir(), "plain-")))).toBe("");
});

test("no git on PATH is not a crash", () => {
  const code = `import { detectRepo } from "./src/projects"; console.log(JSON.stringify(detectRepo("/tmp")))`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PATH: "/nonexistent" } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString().trim()).toBe('""');
});

test("bad folders and names are refused", () => {
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  const link = join(mkdtempSync(join(tmpdir(), "l-")), "home");
  symlinkSync(homedir(), link);
  for (const path of ["", "relative/path", "/definitely/not/here", file, "/", homedir(), "~", link, P(), P("agents"), join(P(), "..")]) {
    expect(status(() => createProject({ name: "X", path }, "mac"))).toBe(400);
  }
  for (const name of ["", "a\nb", "x".repeat(61)]) expect(status(() => createProject({ name, path: dir }, "mac"))).toBe(400);
  expect(status(() => createProject({ ...FORM(), instructions: "x".repeat(20_001) }, "mac"))).toBe(400);
  expect(listProjects()).toEqual([]);
  createProject(FORM(), "mac");
  expect(status(() => createProject({ ...FORM(), name: "Other" }, "mac"))).toBe(409);
  expect(status(() => readProject("ghost"))).toBe(404);
});

test("a task with a project runs in its folder, on its machine, with its instructions", () => {
  setIdTag("");
  const id = createProject(FORM(), "mac");
  const t = newTask("Fix it", "body", { project: id, extra: { origin: "owner" } });
  const { meta } = readDoc(P("tasks", "inbox", `${t}.md`));
  expect(meta).toMatchObject({ project: id, repo: readProject(id).path, host: "mac", origin: "owner" });
  const prompt = buildPrompt({ ...meta, claimed_by: "mac" }, "body", {} as never);
  expect(prompt).toContain(`Working directory: ${readProject(id).path}`);
  expect(prompt).toContain("# This task's project: My Site");
  expect(prompt).toContain("Run npm test first.");
  const other = buildPrompt({ id: "T-9", agent: "lead", claimed_by: "mac" }, "b", {} as never);
  expect(other).toContain("# Connected projects");
  expect(other).not.toContain("Run npm test first.");
  rmSync(dir, { recursive: true, force: true });
  expect(buildPrompt({ ...meta, claimed_by: "mac" }, "body", {} as never)).toContain("is missing on this machine");
});

test("no projects, no section; an unknown project is ignored at creation", () => {
  expect(buildPrompt({ id: "T-9", agent: "lead", claimed_by: "mac" }, "b", {} as never)).not.toContain("Connected projects");
  const t = newTask("Fix it", "body", { project: "ghost", extra: { origin: "owner" } });
  const { meta } = readDoc(P("tasks", "inbox", `${t}.md`));
  expect(meta.project).toBeUndefined();
  expect(meta.host).toBe("any");
});

test("editing keeps the id and machine, and re-detects the repo", () => {
  const id = createProject(FORM(), "mac");
  const elsewhere = mkdtempSync(join(tmpdir(), "moved-"));
  Bun.spawnSync(["git", "init", "-q", elsewhere]);
  Bun.spawnSync(["git", "-C", elsewhere, "remote", "add", "origin", "git@github.com:acme/moved.git"]);
  updateProject(id, { name: "Renamed", path: elsewhere, instructions: "" });
  expect(readProject(id)).toMatchObject({ id, name: "Renamed", host: "mac", repo: "acme/moved", instructions: "" });
  updateProject(id, { name: "Renamed", path: elsewhere }); // its own folder isn't "taken"
  expect(status(() => updateProject("ghost", FORM()))).toBe(404);
});

test("removing archives the record, never the folder, and waits for open work", () => {
  const id = createProject(FORM(), "mac");
  writeFileSync(join(dir, "precious.txt"), "keep");
  const t = newTask("Fix it", "b", { project: id, extra: { origin: "owner" } });
  expect(status(() => deleteProject(id))).toBe(409);
  mkdirSync(P("tasks", "done"), { recursive: true });
  writeFileSync(P("tasks", "done", `${t}.md`), readFileSync(P("tasks", "inbox", `${t}.md`)));
  rmSync(P("tasks", "inbox", `${t}.md`));
  deleteProject(id);
  expect(listProjects()).toEqual([]);
  expect(readFileSync(join(dir, "precious.txt"), "utf8")).toBe("keep");
  expect(readdirSync(P("archive", "projects"))[0].startsWith(`${id}-`)).toBe(true);
});

test("the API and the chat tools work with projects", async () => {
  const call = async (method: string, id?: string, body?: unknown) => {
    const r = await projectRoute(new Request("http://x/api/projects", { method, body: body === undefined ? undefined : JSON.stringify(body) }), id);
    return { status: r.status, data: (await r.json()) as any };
  };
  const made = await call("POST", undefined, FORM());
  expect(made.data.view.effective.projects[0].name).toBe("My Site");
  expect(made.data.view.effective.projects[0].host).toBe(loadConfig().host?.name ?? made.data.view.effective.projects[0].host);
  expect((await call("GET", made.data.id)).data.instructions).toBe("Run npm test first.");
  expect((await call("POST", undefined, {})).status).toBe(400);
  const text = readFileSync(P("projects", `${made.data.id}.md`), "utf8");
  const st = { read: (p: string) => (p === `projects/${made.data.id}.md` ? text : null), list: () => [{ path: `projects/${made.data.id}.md`, text }] } as unknown as ToolStore;
  expect(toolProjects(st)).toEqual([{ id: made.data.id, name: "My Site", repo: undefined, instructions: "Run npm test first." }]);
  expect(writeOp("create_task", { title: "T", project: made.data.id }, st)).toMatchObject({ tool: "create_task", project: made.data.id });
  expect(writeOp("create_task", { title: "T", project: "ghost" }, st)).toContain("unknown project");
  expect((await call("DELETE", made.data.id)).data.view.effective.projects).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});
