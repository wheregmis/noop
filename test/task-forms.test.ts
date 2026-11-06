import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { P, newTask, readDoc, setIdTag, writeDoc } from "../src/core";
import { createTask, previewTaskReopen, reopenTask, TaskFormSaveError } from "../src/task-forms";
import { readTaskFormResult, readTaskReopenPreview, validTaskCreateRequest, validTaskReopenPreviewRequest, validTaskReopenRequest, type TaskCreateRequest, type TaskReopenRequest, type TaskRunSettings } from "../cloud/src/task-forms";

const settings = (): TaskRunSettings => ({ title: "Owner's exact task", agent: "lead", cli: "codex", host: "any", requires: "os:macos", priority: "urgent", prefer: "gpu", weight: "heavy", project: "" });
const creation = (): TaskCreateRequest => ({ request_id: crypto.randomUUID(), instructions: "Implement the requested work.\nKeep the original context.", settings: settings() });
const receiptPath = (input: { request_id: string }) => P("fleet/task-forms", `${input.request_id}.json`);
beforeEach(() => {
  setIdTag("");
  for (const dir of ["tasks", "agents", "projects", "plans", "fleet", "journal"]) fs.rmSync(P(dir), { recursive: true, force: true });
  fs.mkdirSync(P("agents/lead"), { recursive: true }); fs.writeFileSync(P("agents/lead/profile.md"), "# Lead\n\nWork for the owner.\n");
  fs.writeFileSync(P("config.toml"), "[host]\nname='main'\n[fleet]\nprimary='main'\n");
  for (const file of ["settings.json", "config.local.toml"]) fs.rmSync(P(file), { force: true });
});
afterEach(() => { fs.rmSync(P("fleet/task-ids"), { recursive: true, force: true }); fs.rmSync(P("fleet/task-forms"), { recursive: true, force: true }); });
function terminal(folder = "rejected", extra: Record<string, string> = {}, body = "Original request\n\n## Run 2026-11-06T12:00:00Z · worker · claude\n**done** — Earlier result") {
  const id = "T-M0960", path = P("tasks", folder, `${id}.md`), run_id = crypto.randomUUID();
  writeDoc(path, { id, title: "Original title", agent: "lead", cli: "auto", host: "any", requires: "", priority: "high", claimed_by: "worker", run_host: "worker", run_id,
    started: "2026-11-06T12:00:00Z", cancelled: "2026-11-06T12:01:00Z", finished: "2026-11-06T12:01:00Z", attempt: "2", status: "cancelled", children: "T-M0961", ...extra }, body);
  return { id, path, run_id };
}
function reopen(id: string): TaskReopenRequest { const preview = previewTaskReopen({ id }); return { request_id: crypto.randomUUID(), id, preview_digest: preview.digest, instructions: "Try again with these new owner instructions.", settings: preview.settings }; }

test("pure forms reject unknown/nested fields and unsafe values without accepting a current folder on creation", () => {
  const input = creation(); expect(validTaskCreateRequest(input)).toBe(true);
  for (const value of [null, [], { ...input, extra: true }, { ...input, confirm_only: false }, { ...input, instructions: " \n " }, { ...input, request_id: "bad" }, { ...input, settings: { ...input.settings, repo: "/private" } },
    { ...input, settings: { ...input.settings, project: "__current__" } }, { ...input, settings: { ...input.settings, cli: "unknown" } }, { ...input, settings: { ...input.settings, host: "../host" } }, { ...input, settings: { ...input.settings, requires: "os:macos\nsecret" } }]) expect(validTaskCreateRequest(value)).toBe(false);
  expect(validTaskReopenPreviewRequest({ id: "T-M0960" })).toBe(true); expect(validTaskReopenPreviewRequest({ id: "../../private" })).toBe(false);
  const old = terminal(), retry = reopen(old.id); expect(validTaskReopenRequest(retry)).toBe(true); expect(validTaskReopenRequest({ ...retry, preview_digest: "stale" })).toBe(false);
});

test("creation publishes all exact run settings and planned atomically before any inbox task is visible", () => {
  const input = creation(), result = createTask(input), doc = readDoc(P("tasks/inbox", `${result.id}.md`));
  expect(readTaskFormResult(result)).toEqual(result); expect(result).toMatchObject({ request_id: input.request_id, action: "create", applied: true, replayed: false });
  expect(doc.meta).toMatchObject({ title: input.settings.title, agent: "lead", cli: "codex", host: "any", requires: "os:macos", priority: "urgent", prefer: "gpu", weight: "heavy", source: "owner@ui", origin: "owner", form_request: input.request_id });
  expect(Number.isFinite(Date.parse(doc.meta.planned))).toBe(true); expect(doc.body.trim()).toBe(input.instructions);
  const receipt = JSON.parse(fs.readFileSync(receiptPath(input), "utf8")); expect(receipt.state).toBe("applied"); expect(fs.statSync(receiptPath(input)).size).toBeLessThan(16_000);
});

test("selected projects bind their reviewed machine folder and effective capabilities before creating a receipt", () => {
  writeDoc(P("projects/site.md"), { name: "Site", host: "worker", path: "/worker/site", custom_requires: "docker", detected_requires: "cli:cargo" }, "Project instructions");
  const input = creation(); input.settings = { ...input.settings, host: "worker", requires: "os:linux", project: "site", project_guard: { host: "worker", path: "/worker/site", requires: ["docker", "cli:cargo"] } };
  for (const patch of [{ host: "other" }, { path: "/worker/moved" }, { requires: ["docker"] }]) {
    const stale = { ...input, request_id: crypto.randomUUID(), settings: { ...input.settings, project_guard: { ...input.settings.project_guard!, ...patch } } };
    expect(() => createTask(stale)).toThrow("project's machine, folder or requirements changed"); expect(fs.existsSync(receiptPath(stale))).toBe(false);
  }
  const result = createTask(input), doc = readDoc(P("tasks/inbox", `${result.id}.md`)); expect(doc.meta).toMatchObject({ project: "site", repo: "/worker/site", host: "worker" });
  expect(new Set(doc.meta.requires.split(","))).toEqual(new Set(["os:linux", "docker", "cli:cargo"]));
});

test("missing dependencies reject mutations before any receipt or task, while previews remain editable", () => {
  const old = terminal("done", { agent: "missing", project: "removed-project", repo: "" }), preview = previewTaskReopen({ id: old.id });
  expect(preview.can_reopen).toBe(true); expect(readTaskReopenPreview(preview)).toEqual(preview); expect(preview.warnings.join(" ")).toContain("missing");
  const input = { ...reopen(old.id), settings: settings() }; input.settings.agent = "missing";
  expect(() => reopenTask(input)).toThrow("unknown agent"); expect(fs.existsSync(receiptPath(input))).toBe(false); expect(fs.existsSync(old.path)).toBe(true);
  input.settings.agent = "lead"; expect(reopenTask(input).applied).toBe(true);
});

test("done failed and cancelled tasks reopen under the same id with history and fresh attempt state", () => {
  for (const folder of ["done", "failed", "rejected"]) {
    const old = terminal(folder, { pending_stops: JSON.stringify({ operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [] }), wait_check: "old wait command", waiting_on: "Old result", planned_cli: "claude", gate_override: "yes", plan_draft: "PL-0960", parent: "T-M0959" });
    const input = reopen(old.id), result = reopenTask(input), doc = readDoc(P("tasks/inbox", `${old.id}.md`));
    expect(result).toMatchObject({ action: "reopen", id: old.id, applied: true }); expect(fs.existsSync(old.path)).toBe(false); expect(doc.body).toContain("Earlier result"); expect(doc.body).toContain(input.instructions);
    for (const key of ["cancelled", "finished", "claimed_by", "run_id", "run_host", "attempt", "status", "started", "children", "pending_stops", "wait_check", "waiting_on", "planned_cli", "gate_override", "plan_draft", "parent"]) expect(doc.meta[key]).toBeUndefined();
    expect(doc.meta.resumed).toBe("yes"); expect(doc.meta.source).toBe("owner@ui"); expect(doc.body).toContain("PL-0960"); fs.rmSync(P("tasks"), { recursive: true });
  }
});

test("terminal task changes, conflicting copies, unapproved rejected items and active work cannot be reopened", () => {
  const old = terminal(), input = reopen(old.id), doc = readDoc(old.path);
  writeDoc(old.path, doc.meta, doc.body + "\nNew owner information"); expect(() => reopenTask(input)).toThrow("changed after the preview"); expect(fs.existsSync(receiptPath(input))).toBe(false);
  writeDoc(P("tasks/active", `${old.id}.md`), { ...doc.meta, run_id: crypto.randomUUID() }, "A newer live attempt"); expect(() => previewTaskReopen({ id: old.id })).toThrow("conflicting copies");
  fs.rmSync(P("tasks"), { recursive: true }); terminal("rejected", { cancelled: "" }); expect(() => previewTaskReopen({ id: old.id })).toThrow("explicitly cancelled");
  fs.rmSync(P("tasks"), { recursive: true }); terminal("active"); expect(() => previewTaskReopen({ id: old.id })).toThrow("Only a done");
});

test("older unsupported settings and long request history still produce a readable editable preview", () => {
  const old = terminal("done", { title: "\t", agent: "Old.Member", cli: "OldProvider", host: "constructor", requires: "bad capability", prefer: "bad preference", repo: "old".repeat(2000), project: "missing-project" }, "A very long original request\n" + "x".repeat(30_000));
  const preview = previewTaskReopen({ id: old.id }); expect(readTaskReopenPreview(preview)).toEqual(preview); expect(preview.can_reopen).toBe(true);
  expect(preview.settings).toMatchObject({ title: old.id, agent: "lead", cli: "auto", host: "any", requires: "", prefer: "" }); expect(preview.request.length).toBeLessThanOrEqual(20_000); expect(preview.repo).toBeUndefined();
});

test("currently open plan and waiting parent ownership must be resolved before independent reopening", () => {
  const old = terminal(), input = reopen(old.id); fs.mkdirSync(P("plans"));
  fs.writeFileSync(P("plans/PL-0960.json"), JSON.stringify({ id: "PL-0960", status: "drafting", draft_task: old.id, steps: [] }));
  const planPreview = previewTaskReopen({ id: old.id }); expect(planPreview.can_reopen).toBe(false); expect(planPreview.conflicts.join(" ")).toContain("Use plan PL-0960 controls");
  expect(() => reopenTask(input)).toThrow("changed after the preview"); expect(fs.existsSync(receiptPath(input))).toBe(false);
  fs.writeFileSync(P("plans/PL-0960.json"), JSON.stringify({ id: "PL-0960", status: "done", draft_task: old.id, steps: [] }));
  writeDoc(P("tasks/waiting/T-0962.md"), { id: "T-0962", children: old.id }, "Wait for its child");
  const parentPreview = previewTaskReopen({ id: old.id }); expect(parentPreview.can_reopen).toBe(false); expect(parentPreview.conflicts.join(" ")).toContain("Use parent T-0962 controls");
  fs.rmSync(P("tasks/waiting/T-0962.md")); writeDoc(P("tasks/done/T-0962.md"), { id: "T-0962", children: old.id }, "Historical parent");
  expect(previewTaskReopen({ id: old.id }).can_reopen).toBe(true); expect(reopenTask(reopen(old.id)).applied).toBe(true);
});

test("pending cleanup, unresolved cleanup and every stop marker block reopening without changing the terminal record", () => {
  const old = terminal();
  for (const extra of [{ pending_stops: "corrupt" }, { stop_intent: "corrupt" }, { pending_stops: JSON.stringify({ operation_id: crypto.randomUUID(), requested_at: new Date().toISOString(), done: false, pending: [], unresolved: [{ id: "T-0961", error: "Review legacy child" }] }) }] as Record<string, string>[]) {
    terminal("rejected", extra); const preview = previewTaskReopen({ id: old.id }); expect(preview.can_reopen).toBe(false); expect(readTaskReopenPreview(preview)).toEqual(preview);
    const before = fs.readFileSync(old.path, "utf8"), input = reopen(old.id); expect(() => reopenTask(input)).toThrow("cleanup"); expect(fs.readFileSync(old.path, "utf8")).toBe(before); expect(fs.existsSync(receiptPath(input))).toBe(false);
  }
});

test("legacy custom folders are preserved only by the reviewed sentinel on their original machine", () => {
  const old = terminal("done", { repo: "/worker/custom-folder", host: "worker" }), preview = previewTaskReopen({ id: old.id });
  expect(preview.settings.project).toBe("__current__"); expect(preview.repo).toBe("/worker/custom-folder"); expect(readTaskReopenPreview(preview)).toEqual(preview);
  expect(readTaskReopenPreview({ ...preview, repo: undefined })).toBeUndefined(); expect(readTaskReopenPreview({ ...preview, repo: "" })).toBeUndefined();
  const input = reopen(old.id); expect(() => reopenTask({ ...input, settings: { ...input.settings, host: "main" } })).toThrow("original machine");
  const result = reopenTask(input); expect(readDoc(P("tasks/inbox", `${result.id}.md`)).meta).toMatchObject({ repo: "/worker/custom-folder", host: "worker", project: "" });
});

test("explicit None detaches an old folder and lets the owner select another host", () => {
  const old = terminal("done", { repo: "/worker/custom-folder", host: "worker" }), input = reopen(old.id); input.settings = { ...input.settings, project: "", host: "main" };
  reopenTask(input); expect(readDoc(P("tasks/inbox", `${old.id}.md`)).meta).toMatchObject({ repo: "", host: "main", project: "" });
});

test("completed creation and reopen receipts are historical and never change a later attempt", () => {
  const input = creation(), result = createTask(input); fs.rmSync(P("tasks"), { recursive: true }); fs.rmSync(P("agents"), { recursive: true });
  expect(createTask({ ...input, confirm_only: true })).toMatchObject({ id: result.id, replayed: true }); expect(fs.existsSync(P("tasks/inbox", `${result.id}.md`))).toBe(false);
  fs.mkdirSync(P("agents/lead"), { recursive: true }); fs.writeFileSync(P("agents/lead/profile.md"), "# Lead\n");
  const old = terminal(), retry = reopen(old.id); reopenTask(retry); fs.rmSync(P("tasks"), { recursive: true });
  writeDoc(P("tasks/active", `${old.id}.md`), { id: old.id, claimed_by: "worker", run_id: crypto.randomUUID() }, "Newer live task"); const path = P("tasks/active", `${old.id}.md`), before = fs.readFileSync(path, "utf8");
  expect(reopenTask({ ...retry, confirm_only: true }).replayed).toBe(true); expect(fs.readFileSync(path, "utf8")).toBe(before);
  expect(() => reopenTask({ ...retry, instructions: "Different authorization" })).toThrow("another authorization");
});

test("semantic replay ignores object key order but confirm-only never applies an unknown request", () => {
  const input = creation(); expect(() => createTask({ ...input, confirm_only: true })).toThrow("No saved task action"); const result = createTask(input);
  const reordered = { settings: Object.fromEntries(Object.entries(input.settings).reverse()) as TaskRunSettings, instructions: input.instructions, request_id: input.request_id };
  expect(createTask(reordered)).toMatchObject({ id: result.id, replayed: true });
});

test("receipt failure before publication changes no task and an unmatched prepared receipt cannot reapply", () => {
  const input = creation(), link = fs.linkSync;
  const patch = spyOn(fs, "linkSync").mockImplementation((from, to) => { if (String(to).includes("/tasks/inbox/")) throw new Error("fixture inbox publication failed"); return link(from, to); });
  let failure: TaskFormSaveError | undefined; try { createTask(input); } catch (error) { if (error instanceof TaskFormSaveError) failure = error; else throw error; } finally { patch.mockRestore(); }
  expect(failure?.result).toMatchObject({ pending: true }); expect(failure?.result).not.toHaveProperty("applied");
  expect(() => createTask(input)).toThrow("Nothing was reapplied"); expect(() => createTask({ ...input, confirm_only: true })).toThrow("Nothing was reapplied");
  expect(fs.readdirSync(P("tasks/inbox"))).toHaveLength(0);
  const fresh = createTask(creation()); expect(fresh.id).not.toBe(failure!.result.id);
  fs.rmSync(P("tasks"), { recursive: true }); expect(newTask("An ordinary owner request")).not.toBe(fresh.id); expect(newTask("Another ordinary request")).not.toBe(failure!.result.id);
});

test("an ID remains reserved even when initial receipt persistence fails before publication", () => {
  const input = creation(), rename = fs.renameSync;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === receiptPath(input)) throw new Error("fixture initial receipt failed"); return rename(from, to); });
  let failure: TaskFormSaveError | undefined; try { createTask(input); } catch (error) { if (error instanceof TaskFormSaveError) failure = error; else throw error; } finally { patch.mockRestore(); }
  expect(failure?.result).toMatchObject({ pending: true }); expect(fs.existsSync(P("tasks/inbox"))).toBe(false);
  expect(fs.statSync(P("fleet/task-ids", `${failure!.result.id}.json`)).size).toBeLessThan(250);
  for (const request of [input, { ...input, confirm_only: true as const }]) {
    let repeated: TaskFormSaveError | undefined; try { createTask(request); } catch (error) { if (error instanceof TaskFormSaveError) repeated = error; else throw error; }
    expect(repeated?.result).toMatchObject({ id: failure!.result.id, pending: true });
  }
  expect(() => createTask({ ...input, instructions: "A different request using the same ID" })).toThrow("conflicting saved reservation");
  expect(createTask(creation()).id).not.toBe(failure!.result.id); expect(newTask("Ordinary task")).not.toBe(failure!.result.id);
});

test("reservation persistence failure exposes no unsafe task identity and queues nothing", () => {
  const input = creation(), write = fs.writeFileSync;
  const patch = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => { if (String(path).includes("/fleet/task-ids/")) throw new Error("fixture reservation failed"); return write(path, data, options); });
  let error: any; try { createTask(input); } catch (value) { error = value; } finally { patch.mockRestore(); }
  expect(error.status).toBe(503); expect(error).not.toBeInstanceOf(TaskFormSaveError); expect(error.result).toBeUndefined(); expect(fs.existsSync(receiptPath(input))).toBe(false); expect(fs.existsSync(P("tasks/inbox"))).toBe(false);
});

test("a missing applied receipt repairs by the retained request marker even after a worker claimed the task", () => {
  const input = creation(), rename = fs.renameSync; let writes = 0;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === receiptPath(input) && ++writes === 2) throw new Error("fixture applied receipt failed"); return rename(from, to); });
  let failure: TaskFormSaveError | undefined; try { createTask(input); } catch (error) { if (error instanceof TaskFormSaveError) failure = error; else throw error; } finally { patch.mockRestore(); }
  expect(failure?.result).toMatchObject({ applied: true }); const id = failure!.result.id, path = P("tasks/inbox", `${id}.md`), doc = readDoc(path);
  fs.rmSync(path); writeDoc(P("tasks/active", `${id}.md`), { ...doc.meta, claimed_by: "worker", run_id: crypto.randomUUID() }, doc.body + "\nAgent progress");
  const active = P("tasks/active", `${id}.md`), before = fs.readFileSync(active, "utf8");
  expect(createTask({ ...input, confirm_only: true })).toMatchObject({ id, applied: true, replayed: true }); expect(fs.readFileSync(active, "utf8")).toBe(before);
});

test("an unconfirmed installed action never recreates a task after its record was removed", () => {
  const input = creation(), rename = fs.renameSync; let writes = 0;
  const patch = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(to) === receiptPath(input) && ++writes === 2) throw new Error("fixture applied receipt failed"); return rename(from, to); });
  try { expect(() => createTask(input)).toThrow(TaskFormSaveError); } finally { patch.mockRestore(); }
  fs.rmSync(P("tasks"), { recursive: true });
  for (const request of [input, { ...input, confirm_only: true as const }]) expect(() => createTask(request)).toThrow("Nothing was reapplied");
  expect(fs.existsSync(P("tasks/inbox"))).toBe(false);
});

test("partial source removal is repaired only while the original terminal snapshot remains exact", () => {
  const old = terminal(), input = reopen(old.id), unlink = fs.unlinkSync;
  const patch = spyOn(fs, "unlinkSync").mockImplementation((path) => { if (String(path) === old.path) throw new Error("fixture source unlink failure"); return unlink(path); });
  let failure: TaskFormSaveError | undefined; try { reopenTask(input); } catch (error) { if (error instanceof TaskFormSaveError) failure = error; else throw error; } finally { patch.mockRestore(); }
  expect(failure?.result).toMatchObject({ pending: true }); expect(fs.existsSync(old.path)).toBe(true);
  expect(reopenTask({ ...input, confirm_only: true })).toMatchObject({ applied: true, replayed: true }); expect(fs.existsSync(old.path)).toBe(false);
});

test("partial reopen cannot remove a terminal copy that changed or became a newer attempt", () => {
  const old = terminal(), input = reopen(old.id), unlink = fs.unlinkSync;
  const patch = spyOn(fs, "unlinkSync").mockImplementation((path) => { if (String(path) === old.path) throw new Error("fixture source unlink failure"); return unlink(path); });
  try { expect(() => reopenTask(input)).toThrow(TaskFormSaveError); } finally { patch.mockRestore(); }
  const doc = readDoc(old.path); writeDoc(old.path, { ...doc.meta, run_id: crypto.randomUUID() }, doc.body + "\nA different terminal attempt"); const before = fs.readFileSync(old.path, "utf8");
  expect(() => reopenTask({ ...input, confirm_only: true })).toThrow("Nothing was reapplied"); expect(fs.readFileSync(old.path, "utf8")).toBe(before);
});

test("applied receipt crash staging is recoverable without recreating a deleted task", () => {
  const input = creation(), result = createTask(input), path = receiptPath(input), applied = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(path, JSON.stringify({ ...applied, state: "prepared" })); fs.writeFileSync(`${path}.tmp`, JSON.stringify(applied)); fs.rmSync(P("tasks"), { recursive: true });
  expect(createTask({ ...input, confirm_only: true })).toMatchObject({ id: result.id, applied: true, replayed: true }); expect(fs.existsSync(P("tasks/inbox", `${result.id}.md`))).toBe(false); expect(fs.existsSync(`${path}.tmp`)).toBe(false);
});

test("task growth beyond the sync limit and symlink destinations fail before receipt mutation", () => {
  const old = terminal("done", {}, "x".repeat(1_490_000)), input = reopen(old.id); input.instructions = "y".repeat(20_000);
  expect(() => reopenTask(input)).toThrow("sync size limit"); expect(fs.existsSync(receiptPath(input))).toBe(false); expect(fs.existsSync(old.path)).toBe(true);
  fs.rmSync(P("tasks"), { recursive: true }); const create = creation(); fs.mkdirSync(P("tasks"), { recursive: true }); fs.symlinkSync(P("missing-sentinel"), P("tasks/inbox"));
  expect(() => createTask(create)).toThrow("real directories"); expect(fs.existsSync(P("missing-sentinel"))).toBe(false);
});
