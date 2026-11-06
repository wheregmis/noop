// Archive keys select known snapshots. Restoration keeps the snapshot and records a durable, replayable authorization.
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { P, hostName, loadConfig } from "./core";
import { RequestError, validateArchivedMember } from "./members";
import { archivedProjectRecord, validateArchivedProject, type ProjectFolderCheck } from "./projects";
import { validateArchivedPlan, validatePlanDependencies } from "./plans";
import { restoreRoutine, restoredRoutineRecordMatches, validateArchivedRoutine } from "./routines";
import { ignored } from "./sync";
import { ARCHIVE_KINDS, ARCHIVE_MAX_BYTES, ARCHIVE_MAX_FILES, readArchiveRestoreResult, validArchiveListRequest, validArchivePreviewRequest, validArchiveRestoreRequest,
  type ArchiveItem, type ArchiveKind, type ArchiveList, type ArchiveListRequest, type ArchivePreview, type ArchivePreviewRequest, type ArchiveRestoreRequest, type ArchiveRestoreResult } from "../cloud/src/archives";

export type ArchivePendingRestore = Omit<ArchiveRestoreResult, "restored" | "replayed"> & { pending: true };
export class ArchiveSaveError extends Error {
  constructor(message: string, public result: ArchiveRestoreResult | ArchivePendingRestore) { super(message); }
}
type Entry = { item: ArchiveItem; path: string };
type Snapshot = { files: { name: string; bytes: Buffer }[]; dirs: string[]; digest: string; bytes: number };
type Expected = { files?: { name: string; hash: string; bytes: number }[]; dirs?: string[]; routine?: Record<string, any> };
type Receipt = { version: 1; state: "prepared" | "applied"; request_hash: string; result: ArchiveRestoreResult; expected: Expected };
const folders: Record<ArchiveKind, string> = { routines: "routines", members: "agents", projects: "projects", plans: "plans" };
const extensions: Record<ArchiveKind, string> = { routines: ".toml", members: "", projects: ".md", plans: ".json" };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const present = (path: string) => { try { return lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } };
const fail = (message: string): never => { throw new RequestError(409, message); };
function validExpected(value: unknown, kind: ArchiveKind): value is Expected {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = value as Expected;
  if (kind === "routines") return Object.keys(value).length === 1 && !!expected.routine && typeof expected.routine === "object" && !Array.isArray(expected.routine);
  const safe = (name: unknown): name is string => typeof name === "string" && name.length <= 2600 && !/[\x00-\x1f\x7f\\]/.test(name) && !name.startsWith("/") && name.split("/").every((part) => !!part && part !== "." && part !== ".." && !ignored(part));
  return Object.keys(value).every((key) => ["files", "dirs"].includes(key)) && Array.isArray(expected.files) && expected.files.length <= ARCHIVE_MAX_FILES
    && expected.files.every((file) => file && typeof file === "object" && Object.keys(file).every((key) => ["name", "hash", "bytes"].includes(key))
      && (kind === "members" ? safe(file.name) : file.name === "") && /^[a-f0-9]{64}$/.test(file.hash) && Number.isInteger(file.bytes) && file.bytes >= 0 && file.bytes <= ARCHIVE_MAX_BYTES)
    && expected.files.reduce((total, file) => total + file.bytes, 0) <= ARCHIVE_MAX_BYTES && new Set(expected.files.map((file) => file.name)).size === expected.files.length
    && Array.isArray(expected.dirs) && expected.dirs.length <= ARCHIVE_MAX_FILES * 2 && expected.dirs.every(safe) && new Set(expected.dirs).size === expected.dirs.length
    && (kind === "members" || expected.files.length === 1 && expected.dirs.length === 0);
}

/** No reads or writes through a symlink, including a dangling destination or a replaced ancestor. */
function directories(parts: string[], create = false): boolean {
  for (let count = 0; count <= parts.length; count++) {
    const path = P(...parts.slice(0, count)); let stat = present(path);
    if (!stat && create) { mkdirSync(path); stat = lstatSync(path); }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("The archive or destination folder must be a real directory");
  }
  return true;
}
function bytes(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > ARCHIVE_MAX_BYTES) fail("Archive files must be regular files within the restore size limit");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), value = readFileSync(fd), after = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || value.length !== stat.size) fail("The archive changed while it was read. Preview it again.");
    return value;
  } finally { closeSync(fd); }
}
function snapshot(path: string, tree: boolean): Snapshot {
  const files: Snapshot["files"] = [], dirs: string[] = []; let total = 0, nodes = 0;
  const visit = (folder: string, prefix: string, depth: number) => {
    if (depth > 12) fail("The archived member's folders are too deeply nested");
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("The archived member must contain real folders and regular files");
    for (const name of readdirSync(folder).sort()) {
      if (++nodes > ARCHIVE_MAX_FILES * 2 || name.length > 200 || /[\x00-\x1f\x7f\\]/.test(name) || name === "." || name === ".." || ignored(name)) fail("The archive contains unsupported files, folders or too many entries");
      const child = join(folder, name), rel = prefix ? `${prefix}/${name}` : name, stat = lstatSync(child);
      if (stat.isSymbolicLink()) fail("Symlinks cannot be restored from an archive");
      if (stat.isDirectory()) { dirs.push(rel); visit(child, rel, depth + 1); }
      else if (stat.isFile()) add(rel, bytes(child));
      else fail("Only regular files can be restored from an archive");
    }
  };
  const add = (name: string, value: Buffer) => {
    total += value.length;
    if (files.length >= ARCHIVE_MAX_FILES || total > ARCHIVE_MAX_BYTES) fail("The archive exceeds the safe restore file or size limit");
    files.push({ name, bytes: value });
  };
  if (tree) visit(path, "", 0); else add("", bytes(path));
  const digest = sha(JSON.stringify({ dirs, files: files.map((file) => [file.name, file.bytes.length, sha(file.bytes)]) }));
  return { files, dirs, bytes: total, digest };
}
/** Listing counts safe regular files without reading or hashing a member's memories. */
function inventory(path: string, tree: boolean): { files: number; bytes: number } {
  let files = 0, size = 0, nodes = 0;
  const visit = (path: string, depth: number) => {
    if (++nodes > ARCHIVE_MAX_FILES * 2 + 1 || depth > 12) fail("The archive exceeds the safe restore entry limit");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("Symlinks cannot be restored from an archive");
    if (stat.isDirectory() && tree) {
      for (const name of readdirSync(path)) {
        if (name.length > 200 || /[\x00-\x1f\x7f\\]/.test(name) || ignored(name)) fail("The archive contains unsupported files or folders");
        visit(join(path, name), depth + 1);
      }
    } else if (stat.isFile()) { files++; size += stat.size; }
    else fail("Only regular archive files and folders are supported");
    if (files > ARCHIVE_MAX_FILES || size > ARCHIVE_MAX_BYTES) fail("The archive exceeds the safe restore file or size limit");
  };
  visit(path, 0); return { files, bytes: size };
}
function text(value: Buffer): string {
  const output = value.toString("utf8");
  if (!Buffer.from(output).equals(value) || output.includes("\0")) throw new RequestError(400, "The archived record must be valid text");
  return output;
}
function stamp(value: string): string | undefined {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/);
  if (!m) return;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7] ?? "000"}Z`;
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso ? iso : undefined;
}
function label(kind: ArchiveKind, id: string, path: string): string {
  if (kind === "routines") return id;
  try {
    const value = text(bytes(kind === "members" ? join(path, "profile.md") : path));
    const name = kind === "members" ? validateArchivedMember(id, value).title : kind === "projects" ? validateArchivedProject(id, parseDoc(value).meta, parseDoc(value).body).name
      : kind === "plans" ? validateArchivedPlan(JSON.parse(value), id).goal.split("\n")[0] : id;
    return typeof name === "string" && name.trim() && !/[\x00-\x1f\x7f]/.test(name) ? name.slice(0, 200) : id;
  } catch { return id; }
}
function entries(filter: { kind?: ArchiveKind; key?: string } = {}): { entries: Entry[]; warnings: string[] } {
  const result: Entry[] = [], warnings: string[] = [];
  const warn = (message: string) => { if (warnings.length < 200) warnings.push(message); };
  if (!directories(["archive"])) return { entries: result, warnings };
  for (const kind of ARCHIVE_KINDS) {
    if (filter.kind && filter.kind !== kind) continue;
    if (!directories(["archive", folders[kind]])) continue;
    for (const name of readdirSync(P("archive", folders[kind])).sort()) {
      const extension = extensions[kind];
      if (extension && !name.endsWith(extension)) continue;
      const base = extension ? name.slice(0, -extension.length) : name, match = base.match(/^(.+)-(\d{8}T\d{6}(?:\d{3})?Z)(?:-\d+)?$/);
      const id = match?.[1], archived_at = match && stamp(match[2]);
      if (!id || !archived_at || !(kind === "plans" ? /^PL-[A-Z]?\d+$/.test(id) : /^[a-zA-Z0-9][\w-]{0,79}$/.test(id))) continue;
      const key = sha(`archive-v1:${kind}:${name}`);
      if (filter.key && filter.key !== key) continue;
      const path = P("archive", folders[kind], name), stat = lstatSync(path);
      if (stat.isSymbolicLink() || (kind === "members" ? !stat.isDirectory() : !stat.isFile())) { warn(`Unsupported ${kind} archive ${id} was skipped`); continue; }
      let count: { files: number; bytes: number };
      try { count = inventory(path, kind === "members"); }
      catch { warn(`Unsafe or oversized ${kind} archive ${id} was skipped`); continue; }
      result.push({ item: { key, kind, id, name: filter.key ? id : label(kind, id, path), archived_at, ...count }, path });
      if (filter.key) return { entries: result, warnings };
    }
  }
  return { entries: result.sort((a, b) => b.item.archived_at.localeCompare(a.item.archived_at) || a.item.key.localeCompare(b.item.key)), warnings: warnings.slice(0, 200) };
}
function find(key: string): Entry {
  const entry = entries({ key }).entries[0];
  if (!entry) throw new RequestError(404, "That safe archive entry is no longer available. Refresh the archive list.");
  return entry;
}
export function listArchives(filter: ArchiveListRequest = {}): ArchiveList {
  if (!validArchiveListRequest(filter)) throw new RequestError(400, "Choose valid archive filters");
  const all = entries({ kind: filter.kind }), query = filter.query?.trim().toLowerCase() ?? "", offset = filter.offset ?? 0, limit = filter.limit ?? 50;
  const selected = all.entries.map((entry) => entry.item).filter((item) => (!filter.kind || item.kind === filter.kind) && (!query || `${item.id} ${item.name} ${item.kind}`.toLowerCase().includes(query)));
  return { items: selected.slice(offset, offset + limit), total: selected.length, offset, limit, warnings: all.warnings };
}
function destination(entry: Pick<ArchiveItem, "kind" | "id">): string { return entry.kind === "members" ? P("agents", entry.id) : P(entry.kind, `${entry.id}${extensions[entry.kind]}`); }
function conflict(entry: Pick<ArchiveItem, "kind" | "id">): string | undefined {
  directories(entry.kind === "routines" ? [] : [entry.kind === "members" ? "agents" : entry.kind]);
  if (entry.kind === "routines") {
    for (const file of ["config.toml", "settings.json"]) { const stat = present(P(file)); if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail("Configuration files must be regular files"); }
    if ((Bun.TOML.parse(readFileSync(P("config.toml"), "utf8")) as any).routine?.some((routine: any) => routine.name === entry.id)) return "A current routine already has this name. It will not be overwritten.";
  } else if (present(destination(entry))) return "A current record or folder already has this identity. It will not be overwritten.";
}
function inspect(entry: Entry, source: Snapshot): ArchivePreview {
  const preview: ArchivePreview = { entry: { ...entry.item, files: source.files.length, bytes: source.bytes }, digest: source.digest, can_restore: true, conflicts: [], warnings: [] };
  const existing = conflict(entry.item); if (existing) preview.conflicts.push(existing);
  try {
    if (entry.item.kind === "routines") {
      const routine = validateArchivedRoutine(text(source.files[0].bytes), entry.item.id);
      preview.routine = { name: routine.name, every: routine.every, agent: routine.agent ?? "", kind: routine.kind ?? "", project: routine.project ?? "", prompt: routine.prompt ?? "", enabled: false };
      preview.warnings.push("The routine will start off. Previous schedule and enabled overrides are replaced by this archived schedule and Off.");
    } else if (entry.item.kind === "members") {
      const profile = source.files.find((file) => file.name === "profile.md");
      if (!profile) throw new RequestError(400, "The archived member has no profile.md");
      preview.member = validateArchivedMember(entry.item.id, text(profile.bytes)); preview.entry.name = preview.member.title;
      preview.warnings.push("Profile and memory files are preserved. Former member tool and autonomy overrides are unavailable; current configuration and defaults apply.");
    } else if (entry.item.kind === "projects") {
      const doc = parseDoc(text(source.files[0].bytes)); preview.project = validateArchivedProject(entry.item.id, doc.meta, doc.body); preview.entry.name = preview.project.name;
      preview.warnings.push("Choose and check the current folder on its machine. Archived detected repository and capabilities are rechecked; the original machine or folder may be unavailable.");
    } else {
      const plan = validateArchivedPlan(JSON.parse(text(source.files[0].bytes)), entry.item.id);
      preview.plan = { id: plan.id, goal: plan.goal, status: plan.status as "done" | "cancelled", agent: plan.agent, ...(plan.project ? { project: plan.project } : {}), steps: plan.steps.length };
      preview.warnings.push("This restores terminal plan history only. No tasks start; Continue requires current members and project.");
      try { validatePlanDependencies(plan); } catch (error) { preview.warnings.push((error as Error).message); }
    }
  } catch (error) { preview.conflicts.push(error instanceof RequestError ? error.message : "The archived record is malformed or unsupported"); }
  preview.can_restore = preview.conflicts.length === 0;
  return preview;
}
function parseDoc(value: string) {
  const match = value.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/), meta: Record<string, string> = {};
  if (!match) return { meta, body: value };
  for (const line of match[1].split("\n")) { const colon = line.indexOf(":"); if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim(); }
  return { meta, body: match[2] };
}
export function previewArchive(input: ArchivePreviewRequest): ArchivePreview {
  if (!validArchivePreviewRequest(input)) throw new RequestError(400, "Choose a valid archive key");
  const entry = find(input.key); return inspect(entry, snapshot(entry.path, entry.item.kind === "members"));
}
const receiptPath = (id: string) => P("fleet", "archive-restores", `${id.toLowerCase()}.json`);
function saveReceipt(receipt: Receipt) {
  directories(["fleet", "archive-restores"], true);
  const path = receiptPath(receipt.result.request_id), value = JSON.stringify(receipt) + "\n";
  if (Buffer.byteLength(value) > ARCHIVE_MAX_BYTES) fail("The restoration receipt exceeds the safe sync size limit");
  if (present(path)?.isSymbolicLink()) fail("The restoration receipt must be a regular file");
  const temporary = `${path}.tmp`;
  if (present(temporary)) {
    let staged: Receipt;
    try { staged = JSON.parse(text(bytes(temporary))); } catch { return fail("The restoration receipt has an unverified staging file. Review a fresh restoration before proceeding."); }
    if (!["prepared", "applied"].includes(staged.state) || receiptPayload(staged) !== receiptPayload(receipt)) fail("The restoration staging file belongs to a different authorization");
    rmSync(temporary);
  }
  try { writeFileSync(temporary, value, { flag: "wx" }); renameSync(temporary, path); }
  finally { if (present(temporary)?.isFile()) rmSync(temporary); }
}
const receiptPayload = (value: Receipt) => JSON.stringify({ version: value.version, request_hash: value.request_hash, result: value.result, expected: value.expected });
function readReceipt(input: ArchiveRestoreRequest, requestHash: string): Receipt | undefined {
  if (!directories(["fleet", "archive-restores"])) return;
  const path = receiptPath(input.request_id), temporary = `${path}.tmp`;
  const read = (path: string): Receipt | undefined => {
    if (!present(path)) return;
    let value: Receipt;
    try { value = JSON.parse(text(bytes(path))); } catch { return fail("The saved restoration receipt is unreadable. Inspect it before starting another restore."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !["prepared", "applied"].includes(value.state) || !readArchiveRestoreResult(value.result) || !value.expected || typeof value.expected !== "object"
      || !(value.result.kind === "plans" ? /^PL-[A-Z]?\d+$/.test(value.result.id) : /^[a-zA-Z0-9][\w-]{0,79}$/.test(value.result.id)) || !validExpected(value.expected, value.result.kind)
      || value.result.request_id.toLowerCase() !== input.request_id.toLowerCase()) fail("The saved restoration receipt is invalid");
    if (value.request_hash !== requestHash || value.result.key !== input.key || value.result.digest !== input.digest) fail("This restoration request ID already belongs to a different authorization");
    return value;
  };
  const saved = read(path), staged = read(temporary);
  if (saved && staged && receiptPayload(saved) !== receiptPayload(staged)) fail("The saved and staged restoration receipts conflict");
  const value = staged?.state === "applied" ? staged : saved ?? staged;
  if (value && staged) {
    try { saveReceipt(value); }
    catch { throw new ArchiveSaveError("The saved restoration receipt could not be recovered. Check this same restoration again.", value.state === "applied" ? value.result : pending(value)); }
  }
  return value;
}
function expected(source: Snapshot): Expected { return { files: source.files.map((file) => ({ name: file.name, hash: sha(file.bytes), bytes: file.bytes.length })), dirs: source.dirs }; }
function matches(receipt: Receipt): boolean {
  const result = receipt.result;
  try {
    if (result.kind === "routines") { conflict(result); return !!receipt.expected.routine && restoredRoutineRecordMatches(receipt.expected.routine, result.id); }
    directories([result.kind === "members" ? "agents" : result.kind]);
    const path = destination(result); if (!present(path)) return false;
    const value = snapshot(path, result.kind === "members");
    return JSON.stringify(expected(value)) === JSON.stringify(receipt.expected);
  } catch { return false; }
}
function writeExclusive(path: string, value: Buffer, id: string) {
  const temporary = join(dirname(path), `.restore-${id}.tmp`);
  if (present(path)) fail("A current record already has this identity. It will not be overwritten.");
  if (present(temporary)) fail("A previous restoration staging file needs review on the main machine");
  try { writeFileSync(temporary, value, { flag: "wx" }); linkSync(temporary, path); }
  finally { if (present(temporary)?.isFile()) rmSync(temporary); }
}
function writeMember(path: string, source: Snapshot, id: string) {
  const temporary = join(dirname(path), `.restore-${id}.tmp`);
  if (present(path) || present(temporary)) fail("A current member or unfinished restoration already uses this folder");
  mkdirSync(temporary);
  try {
    for (const dir of source.dirs) mkdirSync(join(temporary, dir));
    for (const file of source.files) writeFileSync(join(temporary, file.name), file.bytes, { flag: "wx" });
    if (present(path)) fail("A current member already uses this folder");
    renameSync(temporary, path);
  } finally { if (present(temporary)?.isDirectory() && !present(temporary)?.isSymbolicLink()) rmSync(temporary, { recursive: true }); }
}
function pending(receipt: Receipt): ArchivePendingRestore {
  const { restored: _, replayed: __, ...identity } = receipt.result; return { ...identity, pending: true };
}
export function restoreArchive(input: ArchiveRestoreRequest, projectFolder?: ProjectFolderCheck): ArchiveRestoreResult {
  if (!validArchiveRestoreRequest(input)) throw new RequestError(400, "Choose a valid saved restoration");
  const requestHash = sha(JSON.stringify({ key: input.key, digest: input.digest, project: input.project ? { host: input.project.host, path: input.project.path } : null }));
  let receipt = readReceipt(input, requestHash);
  if (receipt?.state === "applied") return { ...receipt.result, replayed: true };
  if (receipt && matches(receipt)) {
    receipt.state = "applied";
    try { saveReceipt(receipt); } catch { throw new ArchiveSaveError("The restored record is saved locally, but its confirmation receipt could not be saved. Check this same restoration again.", { ...receipt.result, replayed: true }); }
    return { ...receipt.result, replayed: true };
  }
  if (receipt) throw new ArchiveSaveError("This restoration's completion is unverified. Nothing was reapplied. Inspect the current record and authorize a fresh preview with a new restoration request if needed.", pending(receipt));
  if (input.confirm_only) throw new RequestError(404, "No completed restoration was saved for this request. Preview and authorize a new restoration to apply it.");
  const entry = find(input.key), source = snapshot(entry.path, entry.item.kind === "members");
  if (source.digest !== input.digest) fail("The archived content changed. Preview it again before restoring.");
  if (input.project && entry.item.kind !== "projects") throw new RequestError(400, "Only a project restoration accepts a machine and folder");
  const preview = inspect(entry, source);
  if (!preview.can_restore) fail(preview.conflicts.join("; "));
  const selected = { ...source, files: [...source.files] };
  let routine: Record<string, any> | undefined;
  if (entry.item.kind === "routines") routine = validateArchivedRoutine(text(source.files[0].bytes), entry.item.id);
  if (entry.item.kind === "projects") {
    const doc = parseDoc(text(source.files[0].bytes)), placement = input.project ?? { host: preview.project!.host || hostName(loadConfig()), path: preview.project!.path };
    const record = archivedProjectRecord(entry.item.id, doc.meta, doc.body, placement, hostName(loadConfig()), projectFolder);
    const header = Object.entries(record.meta).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${String(value).replace(/\n/g, " ")}`).join("\n");
    selected.files = [{ name: "", bytes: Buffer.from(`---\n${header}\n---\n${record.body.trimEnd()}\n`) }];
  }
  const result: ArchiveRestoreResult = { key: input.key, kind: entry.item.kind, id: entry.item.id, digest: input.digest, request_id: input.request_id, restored: true, replayed: false, warnings: preview.warnings };
  const wanted: Expected = routine ? { routine } : expected(selected);
  receipt = { version: 1, state: "prepared", request_hash: requestHash, result, expected: wanted };
  // Persist the authorization before creating any current record. A prepared receipt alone never claims restoration.
  try { saveReceipt(receipt); } catch { throw new ArchiveSaveError("The restoration authorization could not be saved. No current record was restored.", pending(receipt)); }
  try {
    directories(entry.item.kind === "routines" ? [] : [entry.item.kind === "members" ? "agents" : entry.item.kind], true);
    if (entry.item.kind === "routines") restoreRoutine(text(source.files[0].bytes), entry.item.id);
    else if (entry.item.kind === "members") writeMember(destination(entry.item), selected, input.request_id);
    else writeExclusive(destination(entry.item), selected.files[0].bytes, input.request_id);
    if (!matches(receipt)) throw new Error("Restored content could not be verified");
    receipt.state = "applied"; saveReceipt(receipt);
  } catch (error) {
    const completed = matches(receipt);
    throw new ArchiveSaveError(completed ? "The restored record is saved locally, but its confirmation receipt could not be saved. Check this same restoration again."
      : "Restoration could not be completed safely. Check this saved restoration before retrying; an existing record will never be overwritten.", completed ? receipt.result : pending(receipt));
  }
  return receipt.result;
}
