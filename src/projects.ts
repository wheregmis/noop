// The projects the team works on: projects/<id>.md holds a folder on one machine, its GitHub repo if any, and the owner's
// instructions. A task with a project runs in that folder, on that machine. Removing a project never touches the folder.
import { existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { P, list, readDoc, writeDoc, ROOT } from "./core";
import { RequestError, newId } from "./members";

const file = (id: string) => P("projects", `${id}.md`);
const OPEN = ["inbox", "active", "waiting", "blocked", "proposed"];

function view(id: string) {
  const { meta, body } = readDoc(file(id));
  return { id, name: meta.name ?? id, path: meta.path ?? "", host: meta.host ?? "", repo: meta.repo ?? "", instructions: body.trim(), exists: !!meta.path && existsSync(meta.path) };
}

export const listProjects = () => list(P("projects"), /\.md$/).map((f) => f.split(sep).pop()!.slice(0, -3)).sort().map(view);

export function readProject(id: string) {
  if (!existsSync(file(id))) throw new RequestError(404, "No such project");
  return view(id);
}

/** owner/repo from a folder's git remote, or "" for a folder that isn't on GitHub. */
export function detectRepo(path: string): string {
  try {
    const url = Bun.spawnSync(["git", "-C", path, "remote", "get-url", "origin"]).stdout.toString().trim();
    return url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? "";
  } catch { return ""; } // no git on this machine's PATH
}

/** Trust boundary: agents get to work in this folder, so it must be a real folder, and not one holding the team's or your whole home. */
function folder(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new RequestError(400, "Choose the project's folder");
  const path = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(path)) throw new RequestError(400, "Use a full path, like ~/code/my-project");
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new RequestError(400, `No folder at ${path} on this machine`);
  const real = realpathSync(path), home = realpathSync(homedir()), hub = realpathSync(ROOT);
  if (real === "/" || real === home) throw new RequestError(400, "Choose a project folder, not your whole home or disk");
  if (real === hub || real.startsWith(hub + sep) || hub.startsWith(real + sep)) throw new RequestError(400, "That folder holds Noop's own data; choose the project's folder");
  return real;
}

function fields(input: unknown, self?: string) {
  const o = (input ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? "").trim(), instructions = String(o.instructions ?? "").trim();
  if (!name) throw new RequestError(400, "Give the project a name");
  if (name.length > 60 || name.includes("\n")) throw new RequestError(400, "A name is one short line");
  if (instructions.length > 20_000) throw new RequestError(400, "Instructions can be up to 20,000 characters");
  const path = folder(o.path);
  const taken = listProjects().find((p) => p.path === path && p.id !== self);
  if (taken) throw new RequestError(409, `${taken.name} already uses that folder`);
  return { name, path, instructions };
}

export function createProject(input: unknown, host: string): string {
  const f = fields(input);
  const id = newId(f.name, "project", (x) => !existsSync(file(x)));
  mkdirSync(P("projects"), { recursive: true });
  writeDoc(file(id), { name: f.name, path: f.path, host, repo: detectRepo(f.path) || undefined }, f.instructions ? `${f.instructions}\n` : "");
  return id;
}

export function updateProject(id: string, input: unknown) {
  const was = readProject(id), f = fields(input, id);
  writeDoc(file(id), { name: f.name, path: f.path, host: was.host, repo: detectRepo(f.path) || undefined }, f.instructions ? `${f.instructions}\n` : "");
}

/** Moves the record, with your instructions, to archive/projects/. The project's folder stays exactly as it is. */
export function deleteProject(id: string) {
  readProject(id);
  const open = OPEN.flatMap((s) => list(P("tasks", s), /^T-.*\.md$/)).map((f) => readDoc(f).meta).filter((m) => m.project === id).map((m) => m.id);
  if (open.length) throw new RequestError(409, `Can't remove yet: open tasks: ${open.join(", ")}`);
  mkdirSync(P("archive", "projects"), { recursive: true });
  renameSync(file(id), P("archive", "projects", `${id}-${new Date().toISOString().replace(/\W/g, "")}.md`));
}
