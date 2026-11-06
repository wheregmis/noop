import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { P, nextId, now, projectRequires, repoRequires, taskDocument } from "./core";
import { RequestError } from "./members";
import { assertStopRecordSize, hasPendingStops, pendingStopsError, stopDocText, taskHasStopIntent } from "./stop-intents";
import { normalizeCaps, parseDoc, parseTaskBody, TASK_ID, writeOp, type ToolStore } from "../cloud/src/tools";
import { PROVIDER_IDS } from "../cloud/src/providers";
import { learningTaskBinding, learningTaskHostError } from "../cloud/src/learning";
import { readTaskFormResult, validTaskCreateRequest, validTaskReopenPreviewRequest, validTaskReopenRequest, validTaskRunSettings,
  type TaskCreateRequest, type TaskFormPending, type TaskFormResult, type TaskReopenPreview, type TaskReopenPreviewRequest, type TaskReopenRequest, type TaskRunSettings } from "../cloud/src/task-forms";
export type { TaskFormPending } from "../cloud/src/task-forms";

export class TaskFormSaveError extends Error {
  constructor(message: string, public result: TaskFormResult | TaskFormPending) { super(message); }
}
type TaskFile = { folder: string; path: string; text: string; meta: Record<string, string>; body: string };
type Receipt = { version: 1; state: "prepared" | "applied"; request_hash: string; result: TaskFormResult; expected: string; source?: { folder: string; hash: string } };
const FOLDERS = ["inbox", "active", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
const TERMINAL = ["done", "failed", "rejected"];
const MAX_RECORD = 1_500_000, MAX_RECEIPT = 16_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const present = (path: string) => { try { return lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; } };
const fail = (message: string): never => { throw new RequestError(409, message); };
function directory(parts: string[], create = false): boolean {
  for (let count = 0; count <= parts.length; count++) {
    const path = P(...parts.slice(0, count)); let stat = present(path);
    if (!stat && create) { mkdirSync(path); stat = lstatSync(path); }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Task and receipt folders must be real directories");
  }
  return true;
}
function readFile(path: string, max = MAX_RECORD): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max) fail("This task or receipt is not a safe regular file within the sync size limit");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), bytes = readFileSync(fd), after = fstatSync(fd), text = bytes.toString("utf8");
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== bytes.length || stat.mtimeMs !== after.mtimeMs || !Buffer.from(text).equals(bytes) || text.includes("\0")) fail("This task or receipt changed while being read or contains invalid text");
    return text;
  } finally { closeSync(fd); }
}
function copies(id: string): TaskFile[] {
  return FOLDERS.flatMap((folder) => {
    if (!directory(["tasks", folder])) return [];
    const path = P("tasks", folder, `${id}.md`); if (!present(path)) return [];
    const text = readFile(path), doc = parseDoc(text);
    if (doc.meta.id !== id) fail("This task has a mismatched identity. Refresh and inspect its current records.");
    return [{ folder, path, text, ...doc }];
  });
}
function terminal(id: string): TaskFile {
  const records = copies(id);
  if (!records.length) throw new RequestError(404, "No such task");
  if (records.length !== 1) fail("This task has conflicting copies. Confirm its current records before reopening it.");
  const task = records[0];
  if (!TERMINAL.includes(task.folder) || task.folder === "rejected" && !task.meta.cancelled) fail("Only a done, failed or explicitly cancelled task can be reopened");
  return task;
}
const sameCaps = (caps: string[]) => [...new Set(caps.map((cap) => cap.trim()).filter(Boolean))].sort();
function projectGuard(project: string) {
  if (!directory(["projects"])) throw new RequestError(400, "The selected project is missing; choose another project or None");
  const path = P("projects", `${project}.md`);
  if (!present(path)) throw new RequestError(400, "The selected project is missing; choose another project or None");
  const meta = parseDoc(readFile(path)).meta;
  return { meta, guard: { host: meta.host, path: meta.path, requires: sameCaps(projectRequires(meta)) } };
}
function validated(settings: TaskRunSettings, original?: TaskFile) {
  const { project_guard, ...input } = settings;
  const keepFolder = settings.project === "__current__";
  if (keepFolder && (!original?.meta.repo || original.meta.project || settings.host !== (original.meta.host || "any"))) fail("Keeping the current folder requires its original machine. Choose None to detach it before changing machines.");
  let selected: ReturnType<typeof projectGuard> | undefined;
  if (settings.project && !keepFolder) {
    try { selected = projectGuard(settings.project); } catch (error) { if (error instanceof RequestError && error.status === 400) fail(error.message); throw error; }
    if (!project_guard || project_guard.host !== selected.guard.host || project_guard.path !== selected.guard.path || JSON.stringify(sameCaps(project_guard.requires)) !== JSON.stringify(selected.guard.requires))
      fail("The selected project's machine, folder or requirements changed. Refresh it and review these task settings again.");
  }
  const synthetic = "---\nid: T-0000\n---\nPreview\n";
  const store: ToolStore = {
    read: (path) => {
      if (path === "tasks/inbox/T-0000.md") return { path, text: synthetic, updated: now() };
      if (!/^(?:agents\/[a-z0-9][a-z0-9-]{0,39}\/profile\.md|projects\/[a-z0-9][a-z0-9-]{0,39}\.md)$/.test(path)) return null;
      const parts = path.split("/"); if (!directory(parts.slice(0, -1)) || !present(P(...parts))) return null;
      return { path, text: readFile(P(...parts)), updated: now() };
    }, list: () => [], status: () => ({}), events: () => [], lastSeq: () => 0, act: async () => ({}),
  };
  const checked = writeOp("configure_task", { ...input, project: keepFolder ? "" : input.project, id: "T-0000" }, store);
  if (typeof checked === "string" || checked.tool !== "configure_task") throw new RequestError(400, typeof checked === "string" ? checked : "Choose valid task settings");
  if (original) {
    const placementError = learningTaskHostError(original.meta, original.body, checked.host);
    if (placementError) fail(placementError);
  }
  let repo = keepFolder ? original!.meta.repo : "", extraRequires: string[] = [];
  if (selected) { repo = selected.meta.path; extraRequires = selected.guard.requires; }
  return { title: checked.title!, agent: checked.agent, cli: checked.cli, host: checked.host, priority: checked.priority, prefer: checked.prefer ?? "", weight: checked.weight ?? "normal", project: keepFolder ? "" : checked.project ?? "", repo,
    requires: [...new Set([checked.requires, ...extraRequires, ...repoRequires(repo, "", checked.host)].join(",").split(",").map((value) => value.trim()).filter(Boolean))].join(",") };
}
function displaySettings(task: TaskFile, warnings: string[]): TaskRunSettings {
  const m = task.meta, project = /^[a-z0-9][a-z0-9-]{0,39}$/.test(m.project ?? "") ? m.project : "";
  const host = /^[A-Za-z0-9][\w.-]{0,79}$/.test(m.host ?? "") && !["constructor", "prototype"].includes(m.host) ? m.host : "any";
  const safeRepo = !!m.repo && m.repo.length <= 4096 && !/[\x00-\x1f\x7f]/.test(m.repo);
  const settings: TaskRunSettings = { title: (m.title || m.id).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120).trim() || m.id, agent: /^[a-z0-9][a-z0-9-]{0,39}$/.test(m.agent ?? "") ? m.agent : "lead",
    cli: ["auto", ...PROVIDER_IDS].includes(m.cli) ? m.cli : "auto", host, requires: normalizeCaps(m.requires ?? "") ?? "", prefer: normalizeCaps(m.prefer ?? "") ?? "",
    weight: m.weight === "heavy" ? "heavy" : "normal", priority: ["urgent", "high", "normal", "low"].includes(m.priority) ? m.priority as TaskRunSettings["priority"] : "normal", project: project || (safeRepo ? "__current__" : "") };
  if (m.repo && !safeRepo || m.agent !== settings.agent || m.host && m.host !== settings.host || m.cli && m.cli !== settings.cli || normalizeCaps(m.requires ?? "") === null || normalizeCaps(m.prefer ?? "") === null)
    warnings.push("Some older run settings are unsupported and are shown with safe defaults. Review the member, machine, folder and capabilities before submitting.");
  if (project) {
    try { settings.project_guard = projectGuard(project).guard; }
    catch { warnings.push("The previous project is missing. Choose a current project or None before reopening."); }
    if (!validTaskRunSettings(settings as unknown)) { delete settings.project_guard; warnings.push("Refresh and select a current project or None before submitting its run settings."); }
  }
  const binding = learningTaskBinding(m, task.body);
  if (binding.learning_host) {
    settings.host = binding.learning_host;
    if (settings.project && (settings.project === "__current__" ? m.host !== binding.learning_host : settings.project_guard?.host !== binding.learning_host)) {
      settings.project = ""; delete settings.project_guard;
      warnings.push("The previous folder does not belong to the verified learning source machine. Select a folder on that machine or keep None.");
    }
    warnings.push(`This learning task stays on ${binding.learning_host}, where its private history digest is stored.`);
  }
  if (!directory(["agents", settings.agent]) || !present(P("agents", settings.agent, "profile.md"))) warnings.push("The previous member is missing. Choose a current member before reopening.");
  return settings;
}
function ownershipConflicts(task: TaskFile): string[] {
  const conflicts: string[] = [];
  if (directory(["plans"])) for (const name of readdirSync(P("plans")).filter((name) => /^PL-[A-Z]?\d+\.json$/.test(name))) {
    let plan: any;
    try { plan = JSON.parse(readFile(P("plans", name))); }
    catch { if ([task.meta.plan, task.meta.plan_draft, task.meta.parent].includes(name.slice(0, -5))) conflicts.push(`Use plan ${name.slice(0, -5)} controls to inspect its unreadable record before reopening independently.`); continue; }
    if (!plan || ["done", "cancelled"].includes(plan.status)) continue;
    if (plan.draft_task === task.meta.id || Array.isArray(plan.steps) && plan.steps.some((step: any) => step?.task === task.meta.id))
      conflicts.push(`Use plan ${name.slice(0, -5)} controls to finish, retry or close its current work before reopening this task independently.`);
  }
  for (const state of ["waiting", "blocked"]) if (directory(["tasks", state])) for (const name of readdirSync(P("tasks", state)).filter((name) => /^T-[\w-]*\d{4}\.md$/.test(name))) {
    let parent: ReturnType<typeof parseDoc>;
    try { parent = parseDoc(readFile(P("tasks", state, name))); }
    catch { if (task.meta.parent === name.slice(0, -3)) conflicts.push(`Use parent ${name.slice(0, -3)} controls to inspect its unreadable record before reopening independently.`); continue; }
    if ((parent.meta.children ?? "").split(",").map((id) => id.trim()).includes(task.meta.id))
      conflicts.push(`Use parent ${name.slice(0, -3)} controls to finish or close its ${state} work before reopening this task independently.`);
  }
  return conflicts.sort();
}
function inspection(task: TaskFile): TaskReopenPreview {
  const conflicts: string[] = [], warnings: string[] = [];
  if (hasPendingStops(task.meta.pending_stops) || taskHasStopIntent(task.meta)) conflicts.push("Finish this task's related-run cleanup before reopening it.");
  const invalid = pendingStopsError(task.meta.pending_stops); if (invalid) conflicts.push(invalid);
  const owners = ownershipConflicts(task); conflicts.push(...owners);
  const settings = displaySettings(task, warnings);
  const binding = learningTaskBinding(task.meta, task.body);
  if (binding.learning_host_error) conflicts.push(binding.learning_host_error);
  warnings.push("This reopens the same task with its earlier runs as context. Related tasks are not restarted.");
  if (task.meta.plan || task.meta.plan_draft || task.meta.parent || task.meta.gate_override) warnings.push("Previous plan links, delegation links and approvals remain historical; they are not reused by the reopened attempt.");
  if (conflicts.length > 100) warnings.push("More owners reference this task. Resolve the listed ownership conflicts, then refresh to review the remaining owners.");
  return { id: task.meta.id, digest: sha(task.folder + "\n" + task.text + "\n" + JSON.stringify(owners)), state: task.folder === "rejected" ? "cancelled" : task.folder as "done" | "failed", can_reopen: !conflicts.length, conflicts: conflicts.slice(0, 100), warnings, settings, ...binding,
    request: parseTaskBody(task.meta.title, task.body).request.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " "), ...(task.meta.repo && task.meta.repo.length <= 4096 && !/[\x00-\x1f\x7f]/.test(task.meta.repo) ? { repo: task.meta.repo } : {}) };
}
export function previewTaskReopen(input: TaskReopenPreviewRequest): TaskReopenPreview {
  if (!validTaskReopenPreviewRequest(input)) throw new RequestError(400, "Choose a valid task to reopen");
  return inspection(terminal(input.id));
}
const receiptPath = (id: string) => P("fleet", "task-forms", `${id.toLowerCase()}.json`);
const payload = (receipt: Receipt) => JSON.stringify({ version: receipt.version, request_hash: receipt.request_hash, result: receipt.result, expected: receipt.expected, source: receipt.source });
function saveReceipt(receipt: Receipt) {
  directory(["fleet", "task-forms"], true);
  const path = receiptPath(receipt.result.request_id), temp = `${path}.tmp`, text = JSON.stringify(receipt) + "\n";
  if (Buffer.byteLength(text) > MAX_RECEIPT) fail("The task authorization receipt is too large");
  if (present(path)?.isSymbolicLink()) fail("The task receipt must be a regular file");
  if (present(temp)) {
    let previous: Receipt; try { previous = JSON.parse(readFile(temp, MAX_RECEIPT)); } catch { return fail("The staged task authorization is unreadable; inspect the saved task before authorizing a new request."); }
    if (!previous || !["prepared", "applied"].includes(previous.state) || payload(previous) !== payload(receipt)) fail("The staged task authorization belongs to another request");
    rmSync(temp);
  }
  try { writeFileSync(temp, text, { flag: "wx" }); renameSync(temp, path); }
  finally { if (present(temp)?.isFile()) rmSync(temp); }
}
function readReceipt(request: TaskCreateRequest | TaskReopenRequest, action: "create" | "reopen", hash: string): Receipt | undefined {
  if (!directory(["fleet", "task-forms"])) return;
  const path = receiptPath(request.request_id);
  const read = (path: string): Receipt | undefined => {
    if (!present(path)) return;
    let receipt: Receipt; try { receipt = JSON.parse(readFile(path, MAX_RECEIPT)); } catch { return fail("The saved task authorization receipt is unreadable"); }
    if (!receipt || receipt.version !== 1 || !["prepared", "applied"].includes(receipt.state) || !readTaskFormResult(receipt.result) || !/^[a-f0-9]{64}$/.test(receipt.expected)
      || receipt.source !== undefined && (!receipt.source || !TERMINAL.includes(receipt.source.folder) || !/^[a-f0-9]{64}$/.test(receipt.source.hash))) fail("The saved task authorization receipt is invalid");
    if (receipt.result.request_id.toLowerCase() !== request.request_id.toLowerCase() || receipt.result.action !== action || receipt.request_hash !== hash || "id" in request && receipt.result.id !== request.id)
      fail("This task request ID already belongs to another authorization");
    return receipt;
  };
  const saved = read(path), staged = read(`${path}.tmp`);
  if (saved && staged && payload(saved) !== payload(staged)) fail("The saved and staged task receipts conflict");
  const receipt = staged?.state === "applied" ? staged : saved ?? staged;
  if (receipt && staged) try { saveReceipt(receipt); } catch { throw new TaskFormSaveError("The saved task receipt could not be recovered. Check this same request again.", receipt.state === "applied" ? receipt.result : pending(receipt)); }
  return receipt;
}
function pending(receipt: Receipt): TaskFormPending { const { applied: _, replayed: __, ...identity } = receipt.result; return { ...identity, pending: true }; }
function reservedRequest(request: TaskCreateRequest | TaskReopenRequest, requestHash: string): TaskFormPending | undefined {
  if (!directory(["fleet", "task-ids"])) return;
  let found: TaskFormPending | undefined;
  for (const name of readdirSync(P("fleet", "task-ids")).filter((name) => /^T-[\w-]*\d{4}\.json$/.test(name))) {
    let reservation: any;
    try { reservation = JSON.parse(readFile(P("fleet", "task-ids", name), 1000)); } catch { continue; }
    if (reservation?.request_id !== request.request_id) continue;
    if (reservation.request_hash !== requestHash || reservation.id !== name.slice(0, -5) || !TASK_ID.test(reservation.id) || found) fail("This task request ID has a conflicting saved reservation");
    found = { request_id: request.request_id, action: "create", id: reservation.id, pending: true, warnings: [] };
  }
  return found;
}
/** A retained request marker proves installation even if a worker already claimed or finished that task. */
function installed(receipt: Receipt): boolean {
  const records = copies(receipt.result.id), proof = records.filter((task) => task.meta.form_request === receipt.result.request_id);
  if (!proof.length) return false;
  if (receipt.source) {
    const original = records.find((task) => task.folder === receipt.source!.folder && task.meta.form_request !== receipt.result.request_id);
    if (original) {
      if (sha(original.text) !== receipt.source.hash) return false;
      unlinkSync(original.path);
    }
  }
  return true;
}
function replay(request: TaskCreateRequest | TaskReopenRequest, action: "create" | "reopen", requestHash: string): TaskFormResult | undefined {
  const receipt = readReceipt(request, action, requestHash);
  if (receipt?.state === "applied") return { ...receipt.result, replayed: true };
  if (receipt) {
    try {
      if (installed(receipt)) { receipt.state = "applied"; saveReceipt(receipt); return { ...receipt.result, replayed: true }; }
    } catch { throw new TaskFormSaveError("The saved task transition could not be confirmed. Check this same request again.", pending(receipt)); }
    throw new TaskFormSaveError("This task request's completion is unverified. Nothing was reapplied. Inspect the task, then authorize a fresh request if needed.", pending(receipt));
  }
  if (action === "create") {
    const reserved = reservedRequest(request, requestHash);
    if (reserved) throw new TaskFormSaveError("This task identity was reserved, but completion could not be verified. Nothing was reapplied. Inspect the reserved task and authorize a fresh request if needed.", reserved);
  }
  if (request.confirm_only) throw new RequestError(404, "No saved task action exists for this request. Review and authorize a new request to apply it.");
}
function install(id: string, text: string, requestId: string) {
  directory(["tasks", "inbox"], true);
  if (copies(id).some((task) => task.folder === "inbox" || !TERMINAL.includes(task.folder))) fail("This task has current work already; it will not be overwritten");
  const path = P("tasks", "inbox", `${id}.md`), temp = `${path}.${requestId}.tmp`;
  if (present(temp) || present(path)) fail("An existing task or unfinished transition already uses this inbox location");
  try { writeFileSync(temp, text, { flag: "wx" }); linkSync(temp, path); }
  finally { if (present(temp)?.isFile()) rmSync(temp); }
}
function apply(receipt: Receipt, text: string, source?: TaskFile): TaskFormResult {
  if (receipt.result.action === "create") {
    try {
      directory(["fleet", "task-ids"], true);
      writeFileSync(P("fleet", "task-ids", `${receipt.result.id}.json`), JSON.stringify({ id: receipt.result.id, request_id: receipt.result.request_id, request_hash: receipt.request_hash }) + "\n", { flag: "wx" });
    } catch { throw new RequestError(503, "Could not reserve a task identity safely. No task was queued; reconnect and retry this request."); }
  }
  try { saveReceipt(receipt); } catch { throw new TaskFormSaveError("The task authorization could not be saved. No task was queued.", pending(receipt)); }
  try {
    install(receipt.result.id, text, receipt.result.request_id);
    if (source) { if (sha(readFile(source.path)) !== receipt.source!.hash) throw new Error("Source task changed"); unlinkSync(source.path); }
    if (!installed(receipt)) throw new Error("Task transition was not verified");
    receipt.state = "applied"; saveReceipt(receipt);
    return receipt.result;
  } catch {
    let completed = false; try { completed = installed(receipt); } catch { /* Preserve pending state when source cleanup is uncertain. */ }
    throw new TaskFormSaveError(completed ? "The task action is saved locally, but its confirmation receipt could not be saved. Check this same request again."
      : "The task transition could not be completed safely. Check this same request before authorizing another action.", completed ? receipt.result : pending(receipt));
  }
}
function requestHash(request: TaskCreateRequest | TaskReopenRequest, action: "create" | "reopen") {
  const { confirm_only: _, ...content } = request;
  return sha(JSON.stringify({ action, ...content }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value));
}
export function createTask(input: TaskCreateRequest): TaskFormResult {
  if (!validTaskCreateRequest(input)) throw new RequestError(400, "Choose valid task instructions and run settings");
  const hash = requestHash(input, "create"), previous = replay(input, "create", hash); if (previous) return previous;
  directory(["fleet", "task-ids"]);
  const settings = validated(input.settings), id = nextId("T", P("tasks")), doc = taskDocument(id, settings.title, input.instructions.trim(), { ...settings, source: "owner@ui", extra: { origin: "owner", planned: now(), form_request: input.request_id } });
  const text = stopDocText(doc.meta, doc.body); assertStopRecordSize(text);
  if (copies(id).length) fail("This task identity is already in use; refresh and try a new authorization");
  const result: TaskFormResult = { request_id: input.request_id, action: "create", id, applied: true, replayed: false, warnings: [] };
  return apply({ version: 1, state: "prepared", request_hash: hash, result, expected: sha(text) }, text);
}
export function reopenTask(input: TaskReopenRequest): TaskFormResult {
  if (!validTaskReopenRequest(input)) throw new RequestError(400, "Choose a reviewed terminal task, instructions and valid run settings");
  const hash = requestHash(input, "reopen"), previous = replay(input, "reopen", hash); if (previous) return previous;
  const source = terminal(input.id), preview = inspection(source);
  if (preview.digest !== input.preview_digest) fail("The task changed after the preview. Refresh it and review the latest terminal task.");
  if (!preview.can_reopen) fail(preview.conflicts.join("; "));
  const settings = validated(input.settings, source), meta: Record<string, string | undefined> = { ...source.meta, ...learningTaskBinding(source.meta, source.body) };
  for (const key of ["claimed_by", "run_id", "run_host", "started", "host_caps", "status", "finished", "cancelled", "attempt", "wake_at", "waiting_on", "wait_check", "decision", "pending_stops", "stop_intent", "children", "consolidating", "parked", "parked_need", "cli_used", "model", "planned_cli", "difficulty", "gate_override", "requeue_note", "requeued", "stalls", "plan_draft", "plan_step", "plan", "parent", "spawned_by_run", "depth"]) delete meta[key];
  Object.assign(meta, settings, { planned: now(), resumed: "yes", origin: "owner", source: "owner@ui", form_request: input.request_id });
  const former = [source.meta.plan_draft || source.meta.plan, source.meta.parent, /^followup:/.test(source.meta.source ?? "") ? source.meta.source : ""].filter(Boolean).join(", ");
  const body = `${source.body}\n\n## Owner follow-up ${now()}\n> ${input.instructions.trim().replace(/\n/g, "\n> ")}\n\nReopened explicitly by the owner with the run settings above. Earlier runs are context; related tasks are not restarted.${former ? ` Previous task relationships: ${former}.` : ""}\n`;
  const text = stopDocText(meta, body); assertStopRecordSize(text);
  const result: TaskFormResult = { request_id: input.request_id, action: "reopen", id: input.id, applied: true, replayed: false, warnings: preview.warnings };
  return apply({ version: 1, state: "prepared", request_hash: hash, result, expected: sha(text), source: { folder: source.folder, hash: sha(source.text) } }, text, source);
}
