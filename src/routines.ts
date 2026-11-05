// Routines live as [[routine]] blocks in config.toml, beside settings and comments that must survive. So one block is edited
// at a time, fields the form doesn't show are kept, and a change is only written if everything else still parses the same.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { P, loadConfig, now } from "./core";
import { RequestError } from "./members";

const parse = (text: string) => Bun.TOML.parse(text) as Record<string, any> & { routine?: Record<string, any>[] };
const config = () => readFileSync(P("config.toml"), "utf8");

/** Where each [[routine]] block sits: from its header to the next table, leaving that table's comments with it. */
export function routineBlocks(text: string): { start: number; end: number; name?: string }[] {
  const lines = text.split("\n"), blocks: { start: number; end: number; name?: string }[] = [];
  let quote = "", open: { start: number; name?: string } | null = null, offset = 0, lastBody = 0;
  const close = () => { if (open) blocks.push({ ...open, end: lastBody }); open = null; };
  for (const line of lines) {
    const inString = !!quote;
    if (!inString && /^\s*\[/.test(line) && !/^\s*\w+\s*=/.test(line)) {
      close();
      if (/^\s*\[\[routine\]\]\s*(#.*)?$/.test(line)) open = { start: offset };
    } else if (open && !inString) {
      const name = line.match(/^\s*name\s*=\s*"([^"]*)"/);
      if (name) open.name = name[1];
    }
    for (const m of line.matchAll(/"""|'''/g)) { if (!quote) quote = m[0]; else if (quote === m[0]) quote = ""; }
    offset += line.length + 1;
    if (inString || quote || (line.trim() && !line.trim().startsWith("#"))) lastBody = offset;
  }
  close();
  return blocks;
}

const tomlString = (s: string) => s.includes("\n") ? `"""\n${s.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"').replace(/"$/, '\\"')}"""` : JSON.stringify(s);
const tomlValue = (v: unknown): string => typeof v === "string" ? tomlString(v) : Array.isArray(v) ? `[${v.map(tomlValue).join(", ")}]` : String(v);
/** A block from its fields. The name goes first, so it reads the way the shipped ones do. */
export const renderRoutine = (r: Record<string, unknown>) =>
  `[[routine]]\n${Object.entries({ name: r.name, ...r }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${tomlValue(v)}`).join("\n")}\n`;

/** A value compared by content: fields in any order, a multi-line string's edge whitespace ignored (TOML and the form treat it differently). */
const same = (v: unknown): string => JSON.stringify(v, (_, x) =>
  typeof x === "string" ? x.trim() : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** Writes the new text only if the routines came out as intended and nothing else in the file changed. */
function commit(next: string, expected: Record<string, any>[]) {
  let after: ReturnType<typeof parse>;
  try { after = parse(next); } catch (e) { throw new RequestError(400, `That can't be saved in config.toml: ${(e as Error).message}`); }
  const { routine: _, ...rest } = parse(config());
  const { routine: routines, ...restAfter } = after;
  if (same(rest) !== same(restAfter) || same(routines ?? []) !== same(expected))
    throw new RequestError(409, "config.toml is laid out in a way the app can't edit safely; change this routine in the file");
  writeFileSync(`${P("config.toml")}.tmp`, next);
  renameSync(`${P("config.toml")}.tmp`, P("config.toml"));
}

const SCHEDULE = /^(?:([1-9]\d*)m|hourly|(?:daily|weekdays|weekly (?:MON|TUE|WED|THU|FRI|SAT|SUN)) ([01]?\d|2[0-3]):[0-5]\d)$/i;
/** Trust boundary: what the client sent, as a routine's fields. Anything the form doesn't show stays as it was. */
function fields(input: unknown, was?: Record<string, any>) {
  const o = (input ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? "").trim(), every = String(o.every ?? "").trim().replace(/\s+/g, " "), prompt = String(o.prompt ?? "").trim();
  const agent = String(o.agent ?? "").trim(), project = String(o.project ?? "").trim(), desc = String(o.desc ?? "").trim();
  const learn = was?.kind === "learn"; // runs on every machine over its own session history; it has no member or prompt
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new RequestError(400, "A name uses lowercase letters, numbers and dashes, like weekly-deps");
  if (!SCHEDULE.test(every)) throw new RequestError(400, "Use a schedule like 30m, hourly, daily 09:00, weekdays 09:00 or weekly MON 09:00");
  if (desc.includes("\n") || desc.length > 200) throw new RequestError(400, "The description is one line, up to 200 characters");
  if (project && !existsSync(P("projects", `${project}.md`))) throw new RequestError(400, `No project ${project}`);
  if (!learn) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(agent) || !existsSync(P("agents", agent, "profile.md"))) throw new RequestError(400, "Choose the member who runs it");
    if (!prompt) throw new RequestError(400, "Say what the routine should do");
    if (prompt.length > 20_000) throw new RequestError(400, "Instructions can be up to 20,000 characters");
  }
  return {
    ...was, name, every, enabled: o.enabled !== false, readonly: o.readonly === true || undefined, desc: desc || undefined, project: project || undefined,
    ...(learn ? {} : { agent, prompt }),
  } as Record<string, any>;
}

const clean = (r: Record<string, any>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
const find = (id: string) => (parse(config()).routine ?? []).find((r) => r.name === id);

export function readRoutine(id: string) {
  const r = find(id);
  if (!r) throw new RequestError(404, "No such routine");
  const effective = (loadConfig().routine ?? []).find((x: any) => x.name === id) ?? r; // what the app's on/off and interval say
  return { name: r.name, every: effective.every, enabled: effective.enabled !== false, agent: r.agent ?? "", project: r.project ?? "", readonly: r.readonly === true, desc: r.desc ?? "", prompt: r.prompt ?? "", kind: r.kind ?? "" };
}

/** The form now says what's true: drop what Settings had saved over the file for this routine. */
function dropOverride(id: string) {
  const f = P("settings.json");
  if (!existsSync(f)) return;
  const s = JSON.parse(readFileSync(f, "utf8"));
  if (!s.routines?.[id]) return;
  delete s.routines[id];
  writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
}

export function createRoutine(input: unknown): string {
  const r = clean(fields(input));
  const text = config(), list = parse(text).routine ?? [];
  if (list.some((x) => x.name === r.name)) throw new RequestError(409, `There's already a routine called ${r.name}`);
  commit(`${text.trimEnd()}\n\n${renderRoutine(r)}`, [...list, r]);
  dropOverride(r.name);
  return r.name;
}

export function updateRoutine(id: string, input: unknown) {
  const text = config(), list = parse(text).routine ?? [];
  const was = list.find((x) => x.name === id);
  const block = routineBlocks(text).find((b) => b.name === id);
  if (!was) throw new RequestError(404, "No such routine");
  if (!block) throw new RequestError(409, "config.toml is laid out in a way the app can't edit safely; change this routine in the file");
  const r = clean(fields(input, was));
  if (r.name !== id && list.some((x) => x.name === r.name)) throw new RequestError(409, `There's already a routine called ${r.name}`);
  const tail = text.slice(block.end);
  commit(`${text.slice(0, block.start)}${renderRoutine(r)}${tail}`, list.map((x) => (x.name === id ? r : x)));
  dropOverride(id);
}

/** Moves the block to archive/routines/, so a mistaken delete can be pasted back. A task it already started carries on. */
export function deleteRoutine(id: string) {
  const text = config(), list = parse(text).routine ?? [];
  const block = routineBlocks(text).find((b) => b.name === id);
  if (!list.some((x) => x.name === id)) throw new RequestError(404, "No such routine");
  if (!block) throw new RequestError(409, "config.toml is laid out in a way the app can't edit safely; change this routine in the file");
  const after = text.slice(block.end).replace(/^\n+/, "");
  commit(after ? `${text.slice(0, block.start)}${after}` : `${text.slice(0, block.start).trimEnd()}\n`, list.filter((x) => x.name !== id));
  mkdirSync(P("archive", "routines"), { recursive: true });
  writeFileSync(P("archive", "routines", `${id}-${now().replace(/\W/g, "")}.toml`), text.slice(block.start, block.end));
  dropOverride(id);
}
