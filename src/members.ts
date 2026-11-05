// The team's members: each is a folder in agents/ whose profile.md is injected into its prompts. The app edits them here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type Cfg, P, list, readDoc } from "./core";
import { openPlans } from "./plans";

export type MemberFields = { title: string; name: string; about: string; instructions: string };
export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Reads `# Title — about`, an optional `# Name (Title) — about`, and the `Name:` line; what's left is the instructions. */
export function parseProfile(text: string): Partial<MemberFields> & { instructions: string } {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.startsWith("# "));
  const named = lines.findIndex((l) => /^Name:\s*\S/.test(l));
  const m = head < 0 ? null : lines[head].match(/^#\s+(.+?)\s*(?:\(([^)]+)\))?\s*(?:\s[—–-]+\s+(.+))?$/);
  return {
    title: (m?.[2] ?? m?.[1])?.trim(), about: m?.[3]?.trim(), name: named < 0 ? undefined : lines[named].replace(/^Name:\s*/, "").trim(),
    instructions: lines.filter((_, i) => i !== head && i !== named).join("\n").trim(),
  };
}

// The Name line is always written: without one, an instruction that starts with "Name:" would be taken for it.
export const renderProfile = (f: MemberFields) =>
  `# ${f.title}${f.about ? ` — ${f.about}` : ""}\nName: ${f.name}\n\n${f.instructions}\n`;

/** Trust boundary: what the client sent, as fields that parse back to the same values. */
function fields(input: unknown): MemberFields {
  const o = (input ?? {}) as Record<string, unknown>;
  const line = (k: string) => String(o[k] ?? "").trim();
  const title = line("title"), about = line("about"), instructions = String(o.instructions ?? "").trim();
  const name = line("name") || title;
  if (!title) throw new RequestError(400, "Give the member a role");
  if (title.length > 60 || /[()\n]|\s[—–-]+\s/.test(title)) throw new RequestError(400, "A role is one short line, without parentheses or dashes");
  if (name.length > 40 || name.includes("\n")) throw new RequestError(400, "A name is one short line");
  if (about.length > 200 || about.includes("\n")) throw new RequestError(400, "The summary is one line, up to 200 characters");
  if (!instructions) throw new RequestError(400, "Write the member's instructions");
  if (instructions.length > 20_000) throw new RequestError(400, "Instructions can be up to 20,000 characters");
  return { title, name, about, instructions };
}

const profile = (id: string) => P("agents", id, "profile.md");
const RESERVED = new Set(["owner", "hub", "system", "all", "none"]); // names the feed and answers already use

/** A new id from a display name; it never changes afterwards, because tasks and routines refer to it. */
export function newId(text: string, fallback: string, free: (id: string) => boolean): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/-+$/, "") || fallback;
  if (free(base)) return base;
  for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
}

export function readMember(id: string) {
  if (!existsSync(profile(id))) throw new RequestError(404, "No such member");
  const p = parseProfile(readFileSync(profile(id), "utf8"));
  return { id, title: p.title ?? id, name: p.name ?? "", about: p.about ?? "", instructions: p.instructions };
}

export function createMember(input: unknown): string {
  const f = fields(input), id = newId(f.title, "member", (x) => !RESERVED.has(x) && !existsSync(P("agents", x)));
  mkdirSync(P("agents", id), { recursive: true });
  writeFileSync(profile(id), renderProfile(f));
  return id;
}

export function updateMember(id: string, input: unknown) {
  if (!existsSync(profile(id))) throw new RequestError(404, "No such member");
  writeFileSync(profile(id), renderProfile(fields(input)));
}

/** Why this member can't go yet: the work and routines that would be left without anyone to run them. */
export function deleteBlockers(id: string, cfg: Cfg): string[] {
  if (id === "lead") return ["Lead is the default owner of every task"];
  const out: string[] = [];
  if (id === "chief-of-staff" && cfg.idle?.enabled) out.push("idle menus are on and it writes them");
  const routines = (cfg.routine ?? []).filter((r: any) => r.agent === id || (id === "apprentice" && r.kind === "learn")).map((r: any) => r.name);
  if (routines.length) out.push(`routines: ${routines.join(", ")}`);
  const open = ["inbox", "active", "waiting", "blocked", "proposed"]
    .flatMap((s) => list(P("tasks", s), /^T-.*\.md$/)).map((f) => readDoc(f).meta).filter((m) => m.agent === id).map((m) => m.id);
  if (open.length) out.push(`open tasks: ${open.join(", ")}`);
  const plans = openPlans().filter((p) => p.agent === id || p.steps.some((x) => x.agent === id && (x.status === "pending" || x.status === "running"))).map((p) => p.id);
  if (plans.length) out.push(`plans: ${plans.join(", ")}`);
  return out;
}

/** Moves the member, with its memory, to archive/agents/ so a mistaken delete can be undone by hand. */
export function deleteMember(id: string, cfg: Cfg) {
  if (!existsSync(P("agents", id))) throw new RequestError(404, "No such member");
  const blockers = deleteBlockers(id, cfg);
  if (blockers.length) throw new RequestError(409, `Can't delete yet: ${blockers.join("; ")}`);
  mkdirSync(P("archive", "agents"), { recursive: true });
  renameSync(P("agents", id), P("archive", "agents", `${id}-${new Date().toISOString().replace(/\W/g, "")}`));
  const settings = P("settings.json");
  if (existsSync(settings)) { // a later member with this id starts fresh
    const s = JSON.parse(readFileSync(settings, "utf8"));
    delete s.clis?.agents?.[id];
    delete s.autonomy?.agents?.[id];
    writeFileSync(settings, JSON.stringify(s, null, 2) + "\n");
  }
}
