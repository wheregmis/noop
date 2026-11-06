import { beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { P, loadConfig, readDoc, writeDoc } from "../src/core";
import { ArchiveSaveError, listArchives, previewArchive, restoreArchive } from "../src/archives";
import { createMember, deleteMember } from "../src/members";
import { archivePlan, cancelPlan, continuePlan, readPlan, savePlan, type Plan } from "../src/plans";
import { deleteRoutine, readRoutine } from "../src/routines";
import { readPendingStops } from "../src/stop-intents";
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_FILES, type ArchiveKind } from "../cloud/src/archives";

beforeEach(() => {
  for (const dir of ["archive", "agents", "projects", "plans", "tasks", "fleet", "journal"]) fs.rmSync(P(dir), { recursive: true, force: true });
  fs.mkdirSync(P("agents/lead"), { recursive: true }); fs.writeFileSync(P("agents/lead/profile.md"), "# Lead\n\nOwner's lead.\n");
  fs.writeFileSync(P("config.toml"), "[host]\nname='main'\n[fleet]\nprimary='main'\n");
  for (const file of ["settings.json", "config.local.toml"]) fs.rmSync(P(file), { force: true });
});
function member() {
  const id = createMember({ title: "Archive writer", name: "Writer", about: "Writes", instructions: "Keep original instructions." });
  fs.mkdirSync(P("agents", id, "notes")); fs.writeFileSync(P("agents", id, "notes/memory.bin"), Buffer.from([0, 255, 13, 10, 42]));
  deleteMember(id, loadConfig()); return id;
}
function view(kind: ArchiveKind) { const item = listArchives({ kind }).items[0]; expect(item).toBeDefined(); return previewArchive({ key: item.key }); }
const input = (kind: ArchiveKind) => { const value = view(kind); return { key: value.entry.key, digest: value.digest, request_id: crypto.randomUUID() }; };
const receiptPath = (request: { request_id: string }) => P("fleet/archive-restores", `${request.request_id}.json`);
const terminal = (): Plan => ({ id: "PL-0960", goal: "History", agent: "lead", status: "cancelled", branch: "", created: new Date().toISOString(), notes: [], steps: [], next_step: 1 });

test("member tree restoration is byte exact and completed receipts never recreate deleted work", () => {
  const id = member(), request = input("members"), source = fs.readFileSync(join(P("archive/agents"), fs.readdirSync(P("archive/agents"))[0], "notes/memory.bin"));
  expect(restoreArchive(request)).toMatchObject({ id, restored: true, replayed: false });
  expect(fs.readFileSync(P("agents", id, "notes/memory.bin"))).toEqual(source);
  deleteMember(id, loadConfig()); fs.rmSync(P("archive"), { recursive: true });
  expect(restoreArchive({ ...request, confirm_only: true })).toMatchObject({ id, replayed: true }); expect(fs.existsSync(P("agents", id))).toBe(false);
  expect(() => restoreArchive({ ...request, digest: "f".repeat(64), confirm_only: true })).toThrow("different authorization");
});

test("post-record receipt failure can be confirmed by exact manifest without reading the archive", () => {
  const id = member(), request = input("members"), rename = fs.renameSync; let count = 0;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === receiptPath(request) && ++count === 2) throw new Error("fixture final receipt failed"); return rename(from, to);
  });
  let partial: ArchiveSaveError | undefined;
  try { restoreArchive(request); } catch (error) { if (error instanceof ArchiveSaveError) partial = error; else throw error; } finally { patch.mockRestore(); }
  expect(partial?.result).toMatchObject({ id, restored: true }); expect(fs.existsSync(P("agents", id, "profile.md"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(receiptPath(request), "utf8")).state).toBe("prepared");
  fs.rmSync(P("archive"), { recursive: true });
  expect(restoreArchive({ ...request, confirm_only: true })).toMatchObject({ id, restored: true, replayed: true });
  expect(JSON.parse(fs.readFileSync(receiptPath(request), "utf8")).state).toBe("applied");
});

test("receipt staging files left at a crash cutpoint recover only the same authorization", () => {
  const id = member(), request = input("members"); restoreArchive(request);
  const path = receiptPath(request), applied = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(path, JSON.stringify({ ...applied, state: "prepared" })); fs.writeFileSync(`${path}.tmp`, JSON.stringify(applied));
  deleteMember(id, loadConfig()); fs.rmSync(P("archive"), { recursive: true });
  expect(restoreArchive({ ...request, confirm_only: true })).toMatchObject({ restored: true, replayed: true });
  expect(fs.existsSync(P("agents", id))).toBe(false); expect(fs.existsSync(`${path}.tmp`)).toBe(false); expect(JSON.parse(fs.readFileSync(path, "utf8")).state).toBe("applied");
  fs.writeFileSync(`${path}.tmp`, JSON.stringify({ ...applied, request_hash: "f".repeat(64) }));
  expect(() => restoreArchive({ ...request, confirm_only: true })).toThrow("different authorization");
});

test("prepared-only confirmation never claims restoration or overwrites a later current member", () => {
  const id = member(), request = input("members"), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === P("agents", id)) throw new Error("fixture member rename failed"); return rename(from, to); });
  try { expect(() => restoreArchive(request)).toThrow(ArchiveSaveError); } finally { patch.mockRestore(); }
  expect(fs.existsSync(P("agents", id))).toBe(false);
  let pending: ArchiveSaveError | undefined;
  try { restoreArchive({ ...request, confirm_only: true }); } catch (error) { if (error instanceof ArchiveSaveError) pending = error; else throw error; }
  expect(pending?.result).toMatchObject({ id, pending: true }); expect(pending?.result).not.toHaveProperty("restored");
  fs.mkdirSync(P("agents", id)); fs.writeFileSync(P("agents", id, "profile.md"), "Current replacement\n");
  expect(() => restoreArchive(request)).toThrow("completion is unverified"); expect(fs.readFileSync(P("agents", id, "profile.md"), "utf8")).toBe("Current replacement\n");
});

test("an initial receipt failure changes no current record, and a dangling archive ancestor is rejected", () => {
  const id = member(), request = input("members"), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === receiptPath(request)) throw new Error("fixture initial receipt failed"); return rename(from, to); });
  let error: ArchiveSaveError | undefined; try { restoreArchive(request); } catch (value) { if (value instanceof ArchiveSaveError) error = value; else throw value; } finally { patch.mockRestore(); }
  expect(error?.result).toMatchObject({ pending: true }); expect(error?.result).not.toHaveProperty("restored"); expect(fs.existsSync(P("agents", id))).toBe(false);
  fs.rmSync(P("archive/agents"), { recursive: true }); fs.symlinkSync(P("missing-sentinel"), P("archive/agents"));
  expect(() => listArchives()).toThrow("real directory"); expect(fs.existsSync(P("missing-sentinel"))).toBe(false);
});

test("safe archive limits reject symlinks, excessive files and excessive bytes without reading outside files", () => {
  member(); const folder = join(P("archive/agents"), fs.readdirSync(P("archive/agents"))[0]), request = input("members");
  fs.symlinkSync(P("config.toml"), join(folder, "secret-link")); expect(() => restoreArchive(request)).toThrow("no longer available"); fs.rmSync(join(folder, "secret-link"));
  for (let index = 0; index < ARCHIVE_MAX_FILES; index++) fs.writeFileSync(join(folder, `extra-${index}`), "");
  expect(listArchives({ kind: "members" }).items).toHaveLength(0);
  for (let index = 0; index < ARCHIVE_MAX_FILES; index++) fs.rmSync(join(folder, `extra-${index}`));
  fs.writeFileSync(join(folder, "oversized"), Buffer.alloc(ARCHIVE_MAX_BYTES + 1)); expect(listArchives({ kind: "members" }).items).toHaveLength(0);
});

test("routines preserve learning and extra settings, clear stale overrides and restore paused", () => {
  fs.mkdirSync(P("agents/apprentice")); fs.writeFileSync(P("agents/apprentice/profile.md"), "# Apprentice\n\nLearn.\n");
  fs.writeFileSync(P("config.toml"), '[host]\nname="main"\n[[routine]]\nname="learn-old"\nkind="learn"\nevery="hourly"\nenabled=true\nscheduler="each"\n');
  deleteRoutine("learn-old"); const request = input("routines");
  fs.writeFileSync(P("settings.json"), JSON.stringify({ routines: { "learn-old": { enabled: true, every: "1m" } }, unrelated: true }));
  restoreArchive(request); expect(readRoutine("learn-old")).toMatchObject({ kind: "learn", enabled: false, every: "hourly", scheduler: "each" });
  expect(JSON.parse(fs.readFileSync(P("settings.json"), "utf8")).unrelated).toBe(true);
});

test("same-clock delete restore delete keeps both archive snapshots immutable", () => {
  fs.writeFileSync(P("config.toml"), '[[routine]]\nname="archive-test"\nevery="hourly"\nagent="lead"\nprompt="first instructions"\n');
  const patch = spyOn(Date.prototype, "toISOString").mockReturnValue("2026-11-06T12:00:00.000Z");
  try {
    deleteRoutine("archive-test"); const first = fs.readdirSync(P("archive/routines"))[0], contents = fs.readFileSync(P("archive/routines", first));
    restoreArchive(input("routines")); deleteRoutine("archive-test");
    expect(fs.readdirSync(P("archive/routines"))).toHaveLength(2); expect(fs.readFileSync(P("archive/routines", first))).toEqual(contents);
    const plan = terminal(); savePlan(plan); archivePlan(plan.id); const planFirst = fs.readdirSync(P("archive/plans"))[0], history = fs.readFileSync(P("archive/plans", planFirst));
    restoreArchive(input("plans")); archivePlan(plan.id); expect(fs.readdirSync(P("archive/plans"))).toHaveLength(2); expect(fs.readFileSync(P("archive/plans", planFirst))).toEqual(history);
  } finally { patch.mockRestore(); }
});

test("terminal plan history restores with missing dependencies but explicit continuation revalidates them", () => {
  const plan = { ...terminal(), agent: "missing-member", project: "missing-project" }; savePlan(plan); archivePlan(plan.id);
  const preview = view("plans"); expect(preview.can_restore).toBe(true); expect(preview.warnings.join(" ")).toContain("missing-member");
  restoreArchive(input("plans")); expect(() => continuePlan(plan.id, { instructions: "Continue now" })).toThrow("Restore member"); expect(readPlan(plan.id).status).toBe("cancelled");
  expect(fs.existsSync(P("tasks/inbox"))).toBe(false);
});

test("continuing terminal history does not require an obsolete finished member", () => {
  const plan = { ...terminal(), steps: [{ id: "s1", title: "Old completed work", details: "", agent: "removed-member", checkpoint: false, status: "done" as const, attempt: 1 }], next_step: 2 };
  savePlan(plan); archivePlan(plan.id); expect(view("plans").can_restore).toBe(true); restoreArchive(input("plans"));
  expect(continuePlan(plan.id, { instructions: "Ask the current planner for new work" }).status).toBe("drafting");
});

test("continuation clears completed cleanup so the next cancellation captures its fresh exact draft run", () => {
  const operation = crypto.randomUUID(), plan = { ...terminal(), pending_stops: { operation_id: operation, requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [], seen: ["T-0961"] } };
  savePlan(plan); const continued = continuePlan(plan.id, { instructions: "New work" }); expect(continued.pending_stops).toBeUndefined();
  const source = P("tasks/inbox", `${continued.draft_task}.md`), doc = readDoc(source), run_id = crypto.randomUUID();
  fs.rmSync(source); writeDoc(P("tasks/active", `${continued.draft_task}.md`), { ...doc.meta, claimed_by: "worker", run_host: "worker", run_id }, doc.body);
  const cancelled = cancelPlan(plan.id).plan, pending = readPendingStops(cancelled.pending_stops)!;
  expect(pending.operation_id).not.toBe(operation); expect(pending.pending).toMatchObject([{ id: continued.draft_task, host: "worker", run_id }]);
});

test("corrupt prepared receipt identities fail before resolving paths outside the archive domain", () => {
  member(); const request = input("members"), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to).includes("/agents/")) throw new Error("fixture pause before current write"); return rename(from, to); });
  try { expect(() => restoreArchive(request)).toThrow(ArchiveSaveError); } finally { patch.mockRestore(); }
  const receipt = JSON.parse(fs.readFileSync(receiptPath(request), "utf8")); receipt.result.id = "../../outside"; fs.writeFileSync(receiptPath(request), JSON.stringify(receipt));
  expect(() => restoreArchive({ ...request, confirm_only: true })).toThrow("receipt is invalid");
  fs.writeFileSync(receiptPath(request), "null"); expect(() => restoreArchive({ ...request, confirm_only: true })).toThrow("receipt is invalid");
});
