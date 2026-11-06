// Plans: a goal, approved steps, one task at a time. A plan never runs anything itself: it decides which task to create
// next and watches that task, so agents, retries, decision cards and project folders stay in the task engine.
// It works out what to do from the files alone, so a restart at any point loses nothing. See docs/plans-design.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { P, list, newTask, nextId, now, readDoc } from "./core";
import { RequestError } from "./members";
import { assertStopRecordSize, captureTaskStops, hasPendingStops, pendingStopsError, pendingStopsView, type PendingStops } from "./stop-intents";
import { archiveDestination } from "./archive-path";

export type StepStatus = "pending" | "running" | "done" | "stopped" | "skipped";
export type Step = { id: string; title: string; details: string; agent: string; checkpoint: boolean; status: StepStatus; attempt: number; task?: string; result?: string };
export type PlanStatus = "drafting" | "review" | "running" | "paused" | "done" | "cancelled";
export type Plan = {
  id: string; goal: string; project?: string; agent: string; status: PlanStatus; branch: string; created: string;
  notes: string[]; steps: Step[]; next_step: number; draft_task?: string; reason?: string; pending_stops?: PendingStops;
};

const MAX_STEPS = 20;
const TASK_DIRS = ["inbox", "active", "waiting", "blocked", "proposed", "done", "failed", "rejected"];
const file = (id: string) => P("plans", `${id}.json`);

export function savePlan(p: Plan) { // via rename: a crash can't leave half a file
  const text = JSON.stringify(p, null, 2) + "\n";
  if (p.pending_stops) assertStopRecordSize(text);
  mkdirSync(P("plans"), { recursive: true });
  writeFileSync(`${file(p.id)}.tmp`, text);
  renameSync(`${file(p.id)}.tmp`, file(p.id));
}
export function readPlan(id: string): Plan {
  if (!/^PL-[A-Z]?\d+$/.test(id) || !existsSync(file(id))) throw new RequestError(404, "No such plan");
  return JSON.parse(readFileSync(file(id), "utf8"));
}
export const listPlans = (): Plan[] =>
  list(P("plans"), /^PL-.*\.json$/).flatMap((f) => {
    try { return [readPlan(f.split(sep).pop()!.slice(0, -5))]; } // one damaged file mustn't stop the daemon's tick
    catch (e) { console.error(`plan ${f}: ${e}`); return []; }
  }).sort((a, b) => b.created.localeCompare(a.created));
/** Plans that still have work to come: members and projects they use can't be removed. */
export const openPlans = () => listPlans().filter((p) => p.status !== "done" && p.status !== "cancelled");
export const summary = (p: Plan) => ({
  id: p.id, goal: p.goal, status: p.status, project: p.project, reason: p.reason,
  done: p.steps.filter((s) => s.status === "done" || s.status === "skipped").length, total: p.steps.length,
  ...(pendingStopsView(p.pending_stops) ? { stops: pendingStopsView(p.pending_stops) } : {}),
  ...(pendingStopsError(p.pending_stops) ? { stops_error: pendingStopsError(p.pending_stops) } : {}),
});

const agentOr = (agent: unknown, fallback: string) => {
  const a = String(agent ?? "").trim();
  return a && /^[a-z0-9][a-z0-9-]*$/.test(a) && existsSync(P("agents", a, "profile.md")) ? a : fallback;
};
const refuse = (p: Plan, ...allowed: PlanStatus[]) => {
  if (!allowed.includes(p.status)) throw new RequestError(409, `Plan ${p.id} is ${p.status}`);
};

function pendingSteps(p: Plan, input: unknown): Step[] {
  if (!Array.isArray(input)) throw new RequestError(400, "Steps must be a list");
  const steps = input.map((raw): Step => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const title = String(s.title ?? "").trim().replace(/\s+/g, " ");
    if (!title) throw new RequestError(400, "Every step needs a title");
    return { id: `s${p.next_step++}`, title: title.slice(0, 200), details: String(s.details ?? s.body ?? "").trim().slice(0, 20_000), agent: agentOr(s.agent, p.agent), checkpoint: s.checkpoint === true, status: "pending", attempt: 1 };
  });
  return steps;
}
function setRemaining(p: Plan, keep: Step[], remaining: unknown) {
  const next = pendingSteps(p, remaining);
  if (keep.length + next.length > MAX_STEPS) throw new RequestError(400, `A plan can have up to ${MAX_STEPS} steps`);
  p.steps = [...keep, ...next];
}

const DRAFT = (p: Plan) => `Draft the steps of this plan. Don't change any files or anything outside Noop: read what you need, then return.

## Goal
${p.goal}
${p.notes.length ? `\n## The owner's instructions, in order\n${p.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}${p.steps.some((s) => s.status === "done" || s.status === "skipped" || s.status === "running") ? `\n## Progress so far (these stay; propose only what comes after them)\n${p.steps.filter((s) => s.status !== "pending" && s.status !== "stopped").map((s) => `- [${s.status}] ${s.title}${s.result ? `: ${s.result.slice(0, 300)}` : ""}`).join("\n")}\n` : ""}
## How to answer
Return status "done" with the steps in order in "followups", up to ${MAX_STEPS}: "title" says what the step achieves, "body" has what its agent needs to know, "agent" is the roster member best suited to it. They run one at a time, and each agent sees the goal and what earlier steps did. Use as few steps as the work needs; one is fine. In "summary", say in one sentence what the plan does. The owner reviews and edits the steps before anything runs. If you need the owner's answer before you can plan, return needs_decision.`;

function startDraft(p: Plan) {
  p.status = "drafting";
  p.reason = undefined;
  p.draft_task = newTask(`Draft plan: ${p.goal.split("\n")[0].slice(0, 70)}`, DRAFT(p), {
    agent: p.agent, project: p.project, source: `plan:${p.id}`, priority: "high",
    extra: { origin: "owner", parent: p.id, plan_draft: p.id }, // parent: its result stays quiet; the review notice speaks for it
  });
}

export function createPlan(input: unknown): Plan {
  const o = (input ?? {}) as Record<string, unknown>;
  const goal = String(o.goal ?? "").trim();
  if (!goal) throw new RequestError(400, "Say what the plan should achieve");
  if (goal.length > 4000) throw new RequestError(400, "A goal can be up to 4,000 characters");
  const project = String(o.project ?? "").trim();
  if (project && !existsSync(P("projects", `${project}.md`))) throw new RequestError(400, `No project ${project}`);
  mkdirSync(P("plans"), { recursive: true });
  const id = nextId("PL", P("plans"));
  const p: Plan = { id, goal, project: project || undefined, agent: agentOr(o.agent, "lead"), status: "drafting", branch: `agent/plan-${id}`, created: now(), notes: [], steps: [], next_step: 1 };
  startDraft(p);
  savePlan(p);
  return p;
}

/**
 * A draft task returned its steps: they replace everything that hasn't finished or started. Returns whether they were
 * used. This is an agent's output, not the owner's: anything unusable is dropped rather than thrown into the worker.
 */
export function saveDraft(id: string, followups: unknown): boolean {
  const p = readPlan(id);
  if (p.status !== "drafting" || !Array.isArray(followups)) return false;
  const keep = p.steps.filter((s) => s.status === "done" || s.status === "skipped" || s.status === "running");
  const usable = followups.filter((f) => String((f as { title?: unknown } | null)?.title ?? "").trim()).slice(0, MAX_STEPS - keep.length);
  if (!usable.length) return false; // the tick sends it to review with the reason
  setRemaining(p, keep, usable);
  p.status = "review";
  savePlan(p);
  return true;
}

export function approvePlan(id: string): Plan {
  const p = readPlan(id);
  refuse(p, "review");
  if (!p.steps.length) throw new RequestError(409, "Add at least one step first");
  p.status = "running"; p.reason = undefined;
  savePlan(p);
  return p;
}
export function pausePlan(id: string): Plan {
  const p = readPlan(id);
  refuse(p, "running");
  p.status = "paused"; p.reason = "Paused by you";
  savePlan(p);
  return p;
}
const stopped = (p: Plan) => p.steps.find((s) => s.status === "stopped");
export function resumePlan(id: string): Plan {
  const p = readPlan(id);
  refuse(p, "paused");
  const s = stopped(p);
  if (s) throw new RequestError(409, `Step "${s.title}" stopped: retry or skip it first`);
  p.status = "running"; p.reason = undefined;
  savePlan(p);
  return p;
}
function resolveStopped(id: string, change: (s: Step) => void): Plan {
  const p = readPlan(id);
  refuse(p, "paused");
  const s = stopped(p);
  if (!s) throw new RequestError(409, "No step has stopped");
  change(s);
  p.status = "running"; p.reason = undefined;
  savePlan(p);
  return p;
}
/** A new task for the stopped step: a new attempt number, so the old task isn't adopted again. */
export const retryStep = (id: string) => resolveStopped(id, (s) => { s.status = "pending"; s.attempt++; s.task = undefined; });
export const skipStep = (id: string) => resolveStopped(id, (s) => { s.status = "skipped"; });

export function editSteps(id: string, input: unknown): Plan {
  const p = readPlan(id);
  refuse(p, "review", "running", "paused");
  setRemaining(p, p.steps.filter((s) => s.status !== "pending"), (input as { steps?: unknown } | null)?.steps);
  savePlan(p);
  return p;
}
/** More to do, at any time: the planner proposes the remaining steps and the owner approves them again. A running step carries on meanwhile. */
export function continuePlan(id: string, input: unknown): Plan {
  const p = readPlan(id);
  if (hasPendingStops(p.pending_stops)) throw new RequestError(409, "Finish this plan's pending task cleanup before continuing it");
  refuse(p, "review", "running", "paused", "done", "cancelled");
  validatePlanDependencies(p);
  const text = String((input as { instructions?: unknown } | null)?.instructions ?? "").trim();
  if (!text) throw new RequestError(400, "Say what should happen next");
  if (text.length > 4000) throw new RequestError(400, "Instructions can be up to 4,000 characters");
  p.notes.push(text);
  p.pending_stops = undefined;
  startDraft(p);
  savePlan(p);
  return p;
}
/** Returns the tasks that should be cancelled with it. Finished work stays in the project. */
export function cancelPlan(id: string): { plan: Plan; tasks: string[] } {
  const p = readPlan(id);
  if (p.status === "cancelled" && p.pending_stops) return { plan: p, tasks: [] };
  refuse(p, "drafting", "review", "running", "paused");
  const tasks = [p.status === "drafting" ? p.draft_task : undefined, ...p.steps.filter((s) => s.status === "running").map((s) => s.task)].filter((t): t is string => !!t);
  p.pending_stops = captureTaskStops(tasks, { kind: "plan", id }, false, p.pending_stops);
  for (const s of p.steps) if (s.status === "running") s.status = "stopped";
  p.status = "cancelled"; p.reason = undefined;
  savePlan(p);
  return { plan: p, tasks };
}
export function archivePlan(id: string) {
  const p = readPlan(id);
  if (hasPendingStops(p.pending_stops)) throw new RequestError(409, "Finish this plan's pending task cleanup before removing it");
  refuse(p, "done", "cancelled");
  renameSync(file(id), archiveDestination("plans", id, ".json"));
}

export function validatePlanDependencies(plan: Plan) {
  if (typeof plan.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(plan.agent) || !existsSync(P("agents", plan.agent, "profile.md"))) throw new RequestError(409, `Restore member ${plan.agent} before continuing this plan`);
  if (plan.project && (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(plan.project) || !existsSync(P("projects", `${plan.project}.md`)))) throw new RequestError(409, `Restore project ${plan.project} before continuing this plan`);
}
export function validateArchivedPlan(value: unknown, id: string): Plan {
  const plan = value as Plan | null;
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.id !== id || !/^PL-[A-Z]?\d+$/.test(id) || !["done", "cancelled"].includes(plan.status)
    || typeof plan.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(plan.agent) || plan.project !== undefined && (typeof plan.project !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(plan.project))
    || typeof plan.goal !== "string" || !plan.goal.trim() || plan.goal.length > 4000 || plan.goal.includes("\0") || typeof plan.branch !== "string" || plan.branch.length > 200 || /[\r\n\0]/.test(plan.branch)
    || typeof plan.created !== "string" || !Number.isFinite(Date.parse(plan.created)) || !Array.isArray(plan.notes) || plan.notes.length > 100 || plan.notes.some((note) => typeof note !== "string" || note.length > 4000)
    || !Number.isInteger(plan.next_step) || plan.next_step < 0 || !Array.isArray(plan.steps) || plan.steps.length > MAX_STEPS || hasPendingStops(plan.pending_stops)) throw new RequestError(400, "Only valid terminal plan history can be restored");
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step || typeof step !== "object" || typeof step.id !== "string" || !/^s\d+$/.test(step.id) || ids.has(step.id) || typeof step.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(step.agent) || typeof step.title !== "string" || !step.title.trim() || step.title.length > 200 || typeof step.details !== "string" || step.details.length > 20_000
      || !["pending", "done", "stopped", "skipped"].includes(step.status) || typeof step.checkpoint !== "boolean" || !Number.isInteger(step.attempt) || step.attempt < 1 || step.attempt > 1000) throw new RequestError(400, "The archived plan has invalid or running steps");
    ids.add(step.id);
  }
  return plan;
}

const taskAt = (id: string) => TASK_DIRS.find((d) => existsSync(P("tasks", d, `${id}.md`)));
const lastResult = (body: string) => (body.split("## Run ").pop() ?? "").split("\n").slice(1).join("\n").replace(/^\*\*\w+\*\* — /, "").trim().slice(0, 1500);
const STRANDED_MS = 10 * 60_000; // a failed task with retries left goes back to the queue at once; this long means that was lost

/** Is this task's failure final? handleFailure requeues it while retries remain, and that must not read as the end. */
function finalFailure(meta: Record<string, string>, maxAttempts: number, t: number) {
  return Number(meta.attempt ?? 1) >= maxAttempts || t - Date.parse(meta.finished ?? "") > STRANDED_MS;
}

function startStep(p: Plan, s: Step) {
  const key = `${s.id}#${s.attempt}`;
  // adopt it if an earlier tick made it and died before saving the plan, so a step can't run twice
  const made = TASK_DIRS.flatMap((d) => list(P("tasks", d), /^T-.*\.md$/)).map((f) => readDoc(f).meta).find((m) => m.plan === p.id && m.plan_step === key);
  s.task = made?.id ?? newTask(s.title, s.details || s.title, {
    agent: agentOr(s.agent, "lead"), project: p.project, source: `plan:${p.id}`, priority: "high",
    extra: { origin: "owner", parent: p.id, plan: p.id, plan_step: key },
  });
  s.status = "running";
}

export type PlanEvents = { maxAttempts: number; notify: (text: string, plan: Plan) => void; now?: () => number };

/** One pass over every plan. Runs under the daemon's lock, once per tick. Returns whether anything changed. */
export function advancePlans(e: PlanEvents): boolean {
  const t = (e.now ?? Date.now)();
  let any = false;
  for (const p of openPlans()) {
    const before = JSON.stringify(p);
    if (p.status === "drafting" && p.draft_task) draftStep(p, e, t);
    const stop = (s: Step, why: string) => {
      s.status = "stopped";
      if (p.status === "running") { p.status = "paused"; p.reason = why; e.notify(`Plan ${p.id} stopped at "${s.title}": ${why}`, p); }
    };
    for (const s of p.steps.filter((x) => x.status === "running")) {
      const dir = s.task ? taskAt(s.task) : undefined;
      if (!dir) { stop(s, `its task ${s.task ?? ""} is gone`); continue; }
      const { meta, body } = readDoc(P("tasks", dir, `${s.task}.md`));
      if (dir === "done") {
        s.status = "done"; s.result = lastResult(body);
        if (s.checkpoint && p.status === "running") { p.status = "paused"; p.reason = `Checkpoint: review "${s.title}", then resume`; e.notify(`Plan ${p.id} reached a checkpoint: ${s.title}`, p); }
      } else if (dir === "rejected") stop(s, "its task was cancelled");
      else if (dir === "failed" && finalFailure(meta, e.maxAttempts, t)) stop(s, lastResult(body).split("\n")[0].slice(0, 200) || "its task failed");
    }
    if (p.status === "running" && !p.steps.some((x) => x.status === "running")) {
      const next = p.steps.find((x) => x.status === "pending");
      if (next) startStep(p, next);
      else { p.status = "done"; e.notify(`Plan ${p.id} finished: ${p.goal.split("\n")[0].slice(0, 120)}`, p); }
    }
    if (JSON.stringify(p) !== before) { savePlan(p); any = true; }
  }
  return any;
}

function draftStep(p: Plan, e: PlanEvents, t: number) {
  const dir = taskAt(p.draft_task!);
  const toReview = (reason?: string) => {
    p.status = "review"; p.reason = reason;
    e.notify(reason ? `Plan ${p.id} needs you: ${reason}` : "", p);
  };
  if (!dir) return toReview("its draft task is gone. Write the steps yourself, or continue it to try again.");
  const { meta, body } = readDoc(P("tasks", dir, `${p.draft_task}.md`));
  if (dir === "done") toReview("the planner returned no steps. Write them yourself, or continue it to try again.");
  else if (dir === "rejected") toReview("its draft was cancelled. Write the steps yourself, or continue it to try again.");
  else if (dir === "failed" && finalFailure(meta, e.maxAttempts, t)) toReview(`drafting failed: ${lastResult(body).split("\n")[0].slice(0, 200)}`);
}

/** What a step's agent needs to know: agents don't message each other, so this is how step 3 learns what step 2 did. */
export function planSection(meta: Record<string, string>): string {
  if (!meta.plan || !existsSync(file(meta.plan))) return "";
  const p = readPlan(meta.plan);
  const mine = p.steps.find((s) => meta.plan_step === `${s.id}#${s.attempt}`);
  return `
# This task is one step of plan ${p.id}
Goal: ${p.goal}
${p.notes.length ? `The owner's later instructions:\n${p.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
Steps:
${p.steps.map((s, i) => `${i + 1}. [${s === mine ? "YOUR STEP" : s.status}] ${s.title}${s.result ? `\n   Result: ${s.result.slice(0, 600).replace(/\n/g, "\n   ")}` : ""}`).join("\n")}

Do only your step: other steps have their own runs. If this folder uses git, work on the branch \`${p.branch}\` (create it if it doesn't exist, keep earlier steps' commits, and don't make a branch of your own), so the steps build on each other. If your step needs splitting, return "delegated": the plan waits for delegated work. It doesn't wait for plain followups, so finish here anything later steps depend on.
`;
}
