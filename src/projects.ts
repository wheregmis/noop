// The projects the team works on: projects/<id>.md holds a folder on one machine, its GitHub repo if any, and the owner's
// instructions. A task with a project runs in that folder, on that machine. Removing a project never touches the folder.
import { existsSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { P, list, readDoc, writeDoc, repoRequires, projectRequires, hostName, loadConfig, ROOT } from "./core";
import { RequestError, newId } from "./members";
import { openPlans } from "./plans";
import { normalizeCaps } from "../cloud/src/tools";
import { machineProjectPath, validMachineHost, validProjectFolderCheck } from "../cloud/src/machine-requests";
import type { ProjectFolderCheck } from "../cloud/src/machine-requests";
import { archiveDestination } from "./archive-path";
export type { ProjectFolderCheck } from "../cloud/src/machine-requests";

const file = (id: string) => P("projects", `${id}.md`);
const OPEN = ["inbox", "active", "waiting", "blocked", "proposed"];

function view(id: string) {
  const { meta, body } = readDoc(file(id));
  const detected = repoRequires(meta.path, meta.detected_requires ?? meta.requires, meta.host);
  return { id, name: meta.name ?? id, path: meta.path ?? "", host: meta.host ?? "", repo: meta.repo ?? "", instructions: body.trim(),
    custom_repo: meta.custom_repo || null, detected_repo: meta.detected_repo ?? meta.repo ?? "",
    custom_requires: (meta.custom_requires ?? meta.requires ?? "").split(",").filter(Boolean), detected_requires: detected,
    requires: projectRequires(meta), checked: meta.checked,
    exists: meta.host && meta.host !== hostName(loadConfig()) ? null : !!meta.path && existsSync(meta.path) };
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
    const parsed = new URL(url.replace(/^git@github\.com:/, "ssh://git@github.com/"));
    if (parsed.hostname !== "github.com" || parsed.search || parsed.hash) return "";
    return parsed.pathname.match(/^\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/)?.[1] ?? "";
  } catch { return ""; } // no git on this machine's PATH
}

/** Trust boundary: agents get to work in this folder, so it must be a real folder, and not one holding the team's or your whole home. */
function folder(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) throw new RequestError(400, "Choose a valid project folder path");
  const raw = input.trim();
  if (!raw) throw new RequestError(400, "Choose the project's folder");
  const path = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(path)) throw new RequestError(400, "Use a full path, like ~/code/my-project");
  let real: string;
  try { if (!statSync(path).isDirectory()) throw new Error("not a directory"); real = realpathSync(path); }
  catch { throw new RequestError(400, `No readable folder at ${path} on this machine`); }
  const home = realpathSync(homedir()), hub = existsSync(ROOT) ? realpathSync(ROOT) : ROOT;
  if (real === "/" || /^[a-z]:[\\/]?$/i.test(real) || real === home) throw new RequestError(400, "Choose a project folder, not your whole home or disk");
  if (real === hub || real.startsWith(hub + sep) || hub.startsWith(real + sep)) throw new RequestError(400, "That folder holds Noop's own data; choose the project's folder");
  return real;
}

/** Runs on the selected machine only; the command channel supplies and checks its own host identity. */
export function inspectProjectFolder(path: string, host: string): ProjectFolderCheck {
  if (!validMachineHost(host)) throw new RequestError(400, "Choose a valid machine name");
  const canonical = folder(path);
  return { host, requested_path: path, path: canonical, repo: detectRepo(canonical), requires: repoRequires(canonical), checked: new Date().toISOString() };
}

/** Both the local server and targeted machine bridge verify folders on this machine only. */
export async function projectFolderRequest(req: Request): Promise<Response> {
  const route = machineProjectPath(new URL(req.url).pathname);
  if (!route) return Response.json({ error: "not found" }, { status: 404 });
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  if (route.host !== hostName(loadConfig())) return Response.json({ error: "Open the cloud hub to check a folder on another machine." }, { status: 409 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.path !== "string")
    return Response.json({ error: "Send only the project folder path" }, { status: 400 });
  try { return Response.json(inspectProjectFolder(body.path, route.host)); }
  catch (error) { if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
}

function fields(input: unknown, localHost: string, self?: string, check?: ProjectFolderCheck) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["name", "path", "host", "instructions", "repo", "requires", "probe_ticket"].includes(key)))
    throw new RequestError(400, "Choose supported project settings");
  const o = input as Record<string, unknown>;
  const was = self ? readDoc(file(self)).meta : undefined;
  if (typeof o.name !== "string" || o.instructions !== undefined && typeof o.instructions !== "string") throw new RequestError(400, "Give the project a name and text instructions");
  const name = o.name.trim(), instructions = String(o.instructions ?? "").trim();
  if (!name) throw new RequestError(400, "Give the project a name");
  if (name.length > 60 || /[\r\n\0]/.test(name)) throw new RequestError(400, "A name is one short line");
  if (instructions.length > 20_000) throw new RequestError(400, "Instructions can be up to 20,000 characters");
  const host = o.host === undefined ? was?.host || localHost : o.host;
  if (!validMachineHost(host)) throw new RequestError(400, "Choose the machine that holds this folder");
  if (typeof o.path !== "string" || !o.path.trim() || o.path.length > 4096 || /[\x00-\x1f\x7f]/.test(o.path)) throw new RequestError(400, "Choose a valid project folder path");
  let snapshot: ProjectFolderCheck;
  if (host === localHost) snapshot = inspectProjectFolder(o.path, host);
  else if (check) {
    if (!validProjectFolderCheck(check, host, o.path) || normalizeCaps(check.requires.join(",")) === null)
      throw new RequestError(409, "The folder check does not match this machine and path. Check the folder again.");
    snapshot = check;
  } else if (was?.host === host && was.path === o.path) {
    snapshot = { host, requested_path: o.path, path: was.path, repo: was.detected_repo ?? was.repo ?? "",
      requires: (was.detected_requires ?? was.requires ?? "").split(",").filter(Boolean), checked: was.checked ?? "" };
  } else throw new RequestError(409, "Check this folder on its machine before saving the project.");
  const path = snapshot.path;
  const taken = listProjects().find((p) => p.host === host && p.path === path && p.id !== self);
  if (taken) throw new RequestError(409, `${taken.name} already uses that folder`);
  if (was && (was.host !== host || was.path !== path)) assertNoOpenWork(self!, "move");
  let customRepo = was?.custom_repo ?? "";
  if (o.repo !== undefined) {
    if (o.repo !== null && (typeof o.repo !== "string" || o.repo.length > 200 || o.repo && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(o.repo)))
      throw new RequestError(400, "Use a GitHub repository like owner/repo, or leave it automatic");
    customRepo = String(o.repo ?? "");
  }
  let customRequires = was?.custom_requires ?? was?.requires ?? "";
  if (o.requires !== undefined) {
    if (Array.isArray(o.requires) && o.requires.some((r) => typeof r !== "string")) throw new RequestError(400, "Choose valid required capabilities");
    const caps = normalizeCaps(Array.isArray(o.requires) ? o.requires.join(",") : o.requires);
    if (caps === null) throw new RequestError(400, "Choose valid required capabilities");
    customRequires = caps;
  }
  return { name, path, host, instructions, custom_repo: customRepo, detected_repo: snapshot.repo,
    custom_requires: customRequires, detected_requires: snapshot.requires.join(","), checked: snapshot.checked,
    repo: customRepo || snapshot.repo, requires: [...new Set([customRequires, ...snapshot.requires].join(",").split(",").filter(Boolean))].join(",") };
}

export function createProject(input: unknown, host: string, check?: ProjectFolderCheck): string {
  const { instructions, ...f } = fields(input, host, undefined, check);
  const id = newId(f.name, "project", (x) => !existsSync(file(x)));
  mkdirSync(P("projects"), { recursive: true });
  writeDoc(file(id), { ...f, repo: f.repo || undefined }, instructions ? `${instructions}\n` : "");
  return id;
}

export function updateProject(id: string, input: unknown, localHost = hostName(loadConfig()), check?: ProjectFolderCheck) {
  readProject(id);
  const { instructions, ...f } = fields(input, localHost, id, check);
  writeDoc(file(id), { ...f, repo: f.repo || undefined }, instructions ? `${instructions}\n` : "");
}

function assertNoOpenWork(id: string, action: string) {
  const open = OPEN.flatMap((s) => list(P("tasks", s), /^T-.*\.md$/)).map((f) => readDoc(f).meta).filter((m) => m.project === id).map((m) => m.id);
  if (open.length) throw new RequestError(409, `Can't ${action} yet: open tasks: ${open.join(", ")}`);
  const plans = openPlans().filter((x) => x.project === id).map((x) => x.id);
  if (plans.length) throw new RequestError(409, `Can't ${action} yet: plans: ${plans.join(", ")}`);
}

/** Moves the record, with your instructions, to archive/projects/. The project's folder stays exactly as it is. */
export function deleteProject(id: string) {
  readProject(id);
  assertNoOpenWork(id, "remove");
  renameSync(file(id), archiveDestination("projects", id, ".md"));
}

export function validateArchivedProject(id: string, meta: Record<string, string>, body: string) {
  const name = meta.name || id, instructions = body.trim(), repo = meta.custom_repo ?? (meta.detected_repo === undefined ? meta.repo || null : null);
  const requires = normalizeCaps(meta.custom_requires ?? (meta.detected_requires === undefined ? meta.requires ?? "" : ""));
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || !name.trim() || name.length > 60 || /[\r\n\0]/.test(name) || instructions.length > 20_000 || instructions.includes("\0")
    || (meta.host ?? "").length > 80 || (meta.path ?? "").length > 4096 || /[\x00-\x1f\x7f]/.test((meta.host ?? "") + (meta.path ?? ""))
    || repo !== null && repo !== "" && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) || requires === null) throw new RequestError(400, "The archived project contains unsupported settings");
  return { id, name, instructions, host: meta.host || "", path: meta.path || "", repo, requires: requires.split(",").filter(Boolean) };
}
export function archivedProjectRecord(id: string, meta: Record<string, string>, body: string, placement: { host: string; path: string }, localHost: string, check?: ProjectFolderCheck) {
  const { id: _id, ...archived } = validateArchivedProject(id, meta, body);
  const { instructions, ...values } = fields({ ...archived, ...placement }, localHost, undefined, check);
  return { meta: { ...values, repo: values.repo || undefined }, body: instructions ? `${instructions}\n` : "" };
}
