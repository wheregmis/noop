import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { P, loadConfig, matches, newTask, readDoc, repoRequires, setIdTag, writeDoc } from "../src/core";
import { RequestError } from "../src/members";
import { createProject, deleteProject, detectRepo, inspectProjectFolder, listProjects, projectFolderRequest, readProject, updateProject, type ProjectFolderCheck } from "../src/projects";
import { dataActs, localStore } from "../src/brain";
import { buildPrompt } from "../src/runner";
import { projectRoute, recordRequest, settingsView } from "../src/server";
import { type ToolStore, listProjects as toolProjects, runTool, writeOp } from "../cloud/src/tools";

const RECORD_IO = { pull: async () => true, push: async () => true };

const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as RequestError).status; } };
let dir = "";
const FORM = () => ({ name: "My Site", path: dir, instructions: "Run npm test first." });

beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true });
  for (const d of ["projects", "tasks", "archive", "agents", "plans"]) rmSync(P(d), { recursive: true, force: true });
  mkdirSync(P("agents"), { recursive: true });
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n");
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
  expect(git("ssh://git@github.com/acme/site.git")).toBe("acme/site");
  expect(git("https://fixture-user:fixture-secret@github.com/acme/site.git")).toBe("acme/site");
  expect(git("https://github.com/acme/site.git?token=fixture-secret")).toBe("");
  expect(git("https://example.com/github.com/acme/site.git")).toBe("");
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
    const r = await projectRoute(new Request("http://x/api/projects", { method, body: body === undefined ? undefined : JSON.stringify(body) }), id, RECORD_IO);
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


test("project toolchains refresh from local manifests and fall back to a snapshot when offline", () => {
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='example'\nversion='0.1.0'\n");
  const id = createProject(FORM(), "mac");
  expect(readProject(id).requires).toEqual(["cli:cargo"]);
  rmSync(join(dir, "Cargo.toml"));
  expect(readProject(id).requires).toEqual([]);
  let task = newTask("Current manifests", "Review", { project: id, extra: { origin: "owner" } });
  expect(readDoc(P("tasks", "inbox", `${task}.md`)).meta.requires).toBe("");
  rmSync(dir, { recursive: true });
  expect(readProject(id)).toMatchObject({ exists: false, requires: ["cli:cargo"] });
  task = newTask("Offline manifests", "Review", { project: id, extra: { origin: "owner" } });
  expect(readDoc(P("tasks", "inbox", `${task}.md`)).meta.requires).toBe("cli:cargo");
});

const remoteCheck = (path: string, host = "worker"): ProjectFolderCheck => ({ host, requested_path: path, path, repo: "acme/remote", requires: ["cli:bun|cli:node"], checked: new Date().toISOString() });
const projectRequest = (body: unknown, id?: string) => new Request(`http://hub/api/projects${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body: JSON.stringify(body) });

test("a remote project uses its own verified snapshot even when the same path exists on the main machine", async () => {
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='main-only'\n");
  const check = remoteCheck(dir), body = { name: "Remote", path: dir, host: "worker", requires: "gpu", repo: "acme/custom", instructions: "Remote rules" };
  const response = await recordRequest(projectRequest(body), RECORD_IO, check), saved = await response.json() as any;
  expect(response.status).toBe(200);
  const project = readProject(saved.id);
  expect(project).toMatchObject({ host: "worker", exists: null, repo: "acme/custom", detected_repo: "acme/remote", custom_repo: "acme/custom", custom_requires: ["gpu"], detected_requires: ["cli:bun|cli:node"], requires: ["gpu", "cli:bun|cli:node"] });
  expect(repoRequires(dir, "cli:bun|cli:node", "worker")).toEqual(["cli:bun|cli:node"]);
  const task = newTask("Use remote snapshot", "Original request", { project: saved.id, extra: { origin: "owner" } });
  const taskFile = P("tasks/inbox", `${task}.md`);
  let meta = readDoc(taskFile).meta;
  expect(meta.requires).toBe("gpu,cli:bun|cli:node");
  expect(matches(meta, ["host:worker", "gpu", "cli:node"])).toBe(true); // Main-only Cargo.toml must not add cargo.
  mkdirSync(P("agents/lead"), { recursive: true }); writeFileSync(P("agents/lead/profile.md"), "# Lead");
  const store = localStore({ acts: dataActs("mac", RECORD_IO), status: () => ({}), feed: () => [] });
  expect(await runTool(store, "configure_task", { id: task, host: "worker", agent: "lead", cli: "auto", priority: "normal", requires: "", project: saved.id })).toMatchObject({ ok: true });
  meta = readDoc(taskFile).meta; expect(meta.requires).toBe("gpu,cli:bun|cli:node");
  expect(readDoc(taskFile).body.trim()).toBe("Original request");
  expect(buildPrompt(meta, "body", {} as never)).not.toContain("is missing on this machine");
});

test("remote create and moves require a matching trusted check, never a request-body assertion", async () => {
  const body = { name: "Remote", path: "/remote/project", host: "worker" }, check = remoteCheck(body.path);
  for (const [input, context, expected] of [
    [body, undefined, 409], [{ ...body, project_folder: check }, undefined, 400], [{ ...body, context: check }, undefined, 400],
    [body, { ...check, host: "other" }, 409], [body, { ...check, requested_path: "/different" }, 409],
  ] as const) expect((await recordRequest(projectRequest(input), RECORD_IO, context)).status).toBe(expected);
  expect(listProjects()).toEqual([]);
  const made = await recordRequest(projectRequest(body), RECORD_IO, check), { id } = await made.json() as any;
  expect(made.status).toBe(200); expect(readProject(id).exists).toBeNull();
  expect((await recordRequest(projectRequest({ ...body, path: "/remote/moved" }, id), RECORD_IO)).status).toBe(409);
  expect(readProject(id).path).toBe(body.path);
  expect((await recordRequest(projectRequest({ ...body, instructions: "Edit offline", repo: "acme/override", requires: ["docker", "docker"] }, id), RECORD_IO)).status).toBe(200);
  expect(readProject(id)).toMatchObject({ detected_repo: "acme/remote", repo: "acme/override", instructions: "Edit offline", custom_requires: ["docker"] });
  expect((await recordRequest(projectRequest({ ...body, repo: "", requires: "" }, id), RECORD_IO)).status).toBe(200);
  expect(readProject(id)).toMatchObject({ repo: "acme/remote", custom_repo: null, requires: ["cli:bun|cli:node"] });
});

test("folder uniqueness is scoped to its host and placement cannot change under open work", () => {
  const first = createProject({ name: "First", path: dir, host: "worker" }, "mac", remoteCheck(dir));
  expect(status(() => createProject({ name: "Same host", path: dir, host: "worker" }, "mac", remoteCheck(dir)))).toBe(409);
  expect(createProject({ name: "Other host", path: dir, host: "other" }, "mac", remoteCheck(dir, "other"))).toBe("other-host");
  writeDoc(P("tasks/inbox/T-0960.md"), { id: "T-0960", project: first }, "Current work");
  expect(status(() => updateProject(first, { name: "First", path: "/new/folder", host: "worker" }, "mac", remoteCheck("/new/folder")))).toBe(409);
  expect(status(() => updateProject(first, { name: "First", path: dir, host: "third" }, "mac", remoteCheck(dir, "third")))).toBe(409);
  updateProject(first, { name: "First", path: dir, host: "worker", instructions: "New instructions", requires: "docker" });
  expect(readProject(first).custom_requires).toEqual(["docker"]);
  rmSync(P("tasks"), { recursive: true }); mkdirSync(P("plans"), { recursive: true });
  writeFileSync(P("plans/PL-0960.json"), JSON.stringify({ id: "PL-0960", project: first, status: "review", created: new Date().toISOString() }));
  expect(status(() => updateProject(first, { name: "First", path: "/new/folder", host: "worker" }, "mac", remoteCheck("/new/folder")))).toBe(409);
  rmSync(P("plans"), { recursive: true });
  updateProject(first, { name: "First", path: "/new/folder", host: "worker" }, "mac", remoteCheck("/new/folder"));
  expect(readProject(first).path).toBe("/new/folder");
});

test("legacy project caps survive edits, custom caps survive local manifest refresh, and new snapshots can be refreshed explicitly", () => {
  writeDoc(P("projects/legacy.md"), { name: "Legacy", path: dir, host: "worker", repo: "acme/legacy", requires: "gpu,cli:cargo" }, "Old rules");
  updateProject("legacy", { name: "Legacy", path: dir, instructions: "New rules" });
  expect(readProject("legacy")).toMatchObject({ repo: "acme/legacy", custom_requires: ["gpu", "cli:cargo"], requires: ["gpu", "cli:cargo"] });
  const elsewhere = mkdtempSync(join(tmpdir(), "noop-local-caps-"));
  writeFileSync(join(elsewhere, "package.json"), "{}");
  const local = createProject({ name: "Local", path: elsewhere, requires: "docker" }, "mac");
  rmSync(join(elsewhere, "package.json"));
  updateProject(local, { name: "Local", path: elsewhere });
  expect(readProject(local)).toMatchObject({ custom_requires: ["docker"], detected_requires: [], requires: ["docker"] });
  rmSync(elsewhere, { recursive: true });
  updateProject("legacy", { name: "Legacy", path: dir, requires: "gpu" }, "mac", { ...remoteCheck(dir), requires: ["cli:node"], repo: "acme/new" });
  expect(readProject("legacy")).toMatchObject({ detected_repo: "acme/new", custom_requires: ["gpu"], requires: ["gpu", "cli:node"] });
});

test("local folder checks preserve the requested spelling, reject another host, and never write shared state", async () => {
  writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='example'\n");
  const path = ` ${dir} `, before = listProjects();
  expect(inspectProjectFolder(path, "mac")).toMatchObject({ host: "mac", requested_path: path, path: realpathSync(dir), requires: ["cli:cargo"] });
  const req = (host: string, body: unknown = { path }) => new Request(`http://hub/api/machines/${host}/project-folder-check`, { method: "POST", body: JSON.stringify(body) });
  let response = await projectFolderRequest(req("mac")); expect(response.status).toBe(200); expect((await response.json() as any).requested_path).toBe(path);
  response = await projectFolderRequest(req("worker")); expect(response.status).toBe(409); expect((await response.json() as any).error).toContain("cloud hub");
  for (const body of [null, [], { path, host: "mac" }, { path: "relative" }, { path: dir, project_folder: {} }]) expect((await projectFolderRequest(req("mac", body))).status).toBe(400);
  expect((await projectFolderRequest(new Request("http://hub/api/machines/mac/project-folder-check"))).status).toBe(405);
  expect(listProjects()).toEqual(before); expect(settingsView().effective.primary_host).toBe("mac");
});

test("remote project refresh failures do not save and partial saves preserve the created identity", async () => {
  const body = { name: "Remote", host: "worker", path: "/remote/project" }, check = remoteCheck(body.path);
  expect((await recordRequest(projectRequest(body), { ...RECORD_IO, pull: async () => false }, check)).status).toBe(503);
  expect(listProjects()).toEqual([]);
  const response = await recordRequest(projectRequest(body), { ...RECORD_IO, push: async () => false }, check), result = await response.json() as any;
  expect(response.status).toBe(503); expect(result).toMatchObject({ id: "remote", saved_locally: true });
  expect(readProject(result.id)).toMatchObject({ host: "worker", path: body.path });
});
