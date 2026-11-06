import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { P, newTask, readDoc, writeDoc } from "../src/core";
import type { RequestError } from "../src/members";
import { deleteBlockers } from "../src/members";
import { createProject, deleteProject } from "../src/projects";
import { type Plan, advancePlans, approvePlan, archivePlan, cancelPlan, continuePlan, createPlan, editSteps, listPlans, pausePlan, planSection, readPlan, resumePlan, retryStep, saveDraft, savePlan, skipStep } from "../src/plans";
import { buildPrompt, stopOrphanedAgent } from "../src/runner";
import { planRoute, status as hubStatus } from "../src/server";
import { localStore } from "../src/brain";
import { listPlansView, writeOp } from "../cloud/src/tools";

const RECORD_IO = { pull: async () => true, push: async () => true };

const status = (fn: () => unknown) => { try { fn(); return 0; } catch (e) { return (e as RequestError).status; } };
let notes: string[] = [];
let clock = Date.now();
const tick = () => advancePlans({ maxAttempts: 2, notify: (t) => { if (t) notes.push(t); }, now: () => clock });

/** Move a task the way the engine would when its agent finishes. */
function finish(id: string, to: "done" | "failed" | "rejected" | "blocked" | "waiting", summary = "did it", extra: Record<string, string> = {}) {
  const from = ["inbox", "active", "waiting", "blocked"].find((d) => existsSync(P("tasks", d, `${id}.md`)))!;
  const { meta, body } = readDoc(P("tasks", from, `${id}.md`));
  unlinkSync(P("tasks", from, `${id}.md`));
  writeDoc(P("tasks", to, `${id}.md`), { ...meta, finished: new Date(clock).toISOString(), ...extra }, `${body}\n\n## Run now · h · claude\n**${to}** — ${summary}\n`);
}
const steps = (...titles: string[]) => titles.map((title) => ({ title, body: `do ${title}`, agent: "lead" }));
function approved(...titles: string[]): Plan {
  const p = createPlan({ goal: "Ship it" });
  finish(p.draft_task!, "done");
  saveDraft(p.id, steps(...titles));
  return approvePlan(p.id);
}
const current = (id: string) => readPlan(id).steps.find((s) => s.status === "running")!;

beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true });
  for (const d of ["plans", "tasks", "projects", "archive", "agents"]) rmSync(P(d), { recursive: true, force: true });
  for (const d of ["agents/lead", "agents/writer"]) { mkdirSync(P(d), { recursive: true }); writeFileSync(P(d, "profile.md"), "# Role\n\nWork.\n"); }
  writeFileSync(P("config.toml"), "");
  notes = []; clock = Date.now();
});

test("drafting: a task for the planner, whose steps wait for approval", () => {
  const p = createPlan({ goal: "Add dark mode", agent: "writer" });
  expect(p).toMatchObject({ id: "PL-0001", status: "drafting", agent: "writer", branch: "agent/plan-PL-0001" });
  const t = readDoc(P("tasks", "inbox", `${p.draft_task}.md`));
  expect(t.meta).toMatchObject({ agent: "writer", plan_draft: p.id, origin: "owner", parent: p.id });
  expect(t.body).toContain("Add dark mode");
  expect(t.body).toContain("Don't change any files");
  expect(existsSync(P("tasks", "proposed", `${p.draft_task}.md`))).toBe(false);
  saveDraft(p.id, [{ title: "One", body: "details", agent: "writer" }, { title: "Two", agent: "ghost" }, { title: "Three", agent: "../lead" }]);
  const r = readPlan(p.id);
  expect(r.status).toBe("review");
  expect(r.steps.map((s) => [s.id, s.title, s.details, s.agent, s.status])).toEqual([["s1", "One", "details", "writer", "pending"], ["s2", "Two", "", "writer", "pending"], ["s3", "Three", "", "writer", "pending"]]);
  expect(tick()).toBe(false); // nothing runs before approval
  expect(readdirSync(P("tasks", "inbox"))).toEqual([`${p.draft_task}.md`]);
});

test("input is checked", () => {
  for (const bad of [null, {}, { goal: "  " }, { goal: "x".repeat(4001) }, { goal: "g", project: "ghost" }]) expect(status(() => createPlan(bad))).toBe(400);
  expect(listPlans()).toEqual([]);
  expect(status(() => readPlan("PL-9999"))).toBe(404);
  expect(status(() => readPlan("../../config"))).toBe(404);
  const p = createPlan({ goal: "g" });
  expect(status(() => approvePlan(p.id))).toBe(409);
  saveDraft(p.id, steps("a"));
  expect(status(() => editSteps(p.id, { steps: "no" }))).toBe(400);
  expect(status(() => editSteps(p.id, { steps: [{ title: " " }] }))).toBe(400);
  expect(status(() => editSteps(p.id, { steps: Array.from({ length: 21 }, (_, i) => ({ title: `s${i}` })) }))).toBe(400);
  expect(readPlan(p.id).steps.map((s) => s.title)).toEqual(["a"]);
  expect(status(() => editSteps(p.id, { steps: [] }))).toBe(0);
  expect(status(() => approvePlan(p.id))).toBe(409); // no steps
});

test("steps run one at a time, each seeing what came before, and the plan finishes", () => {
  const p = approved("One", "Two");
  expect(tick()).toBe(true);
  const one = current(p.id);
  const meta = readDoc(P("tasks", "inbox", `${one.task}.md`)).meta;
  expect(meta).toMatchObject({ title: "One", source: `plan:${p.id}`, origin: "owner", parent: p.id, plan: p.id, plan_step: "s1#1" });
  expect(tick()).toBe(false); // waiting on step 1, no second task
  expect(readPlan(p.id).steps[1].status).toBe("pending");
  finish(one.task!, "done", "built the first part");
  tick();
  const r = readPlan(p.id);
  expect(r.steps[0]).toMatchObject({ status: "done", result: "built the first part" });
  const two = r.steps[1];
  expect(two.status).toBe("running");
  const prompt = buildPrompt({ ...readDoc(P("tasks", "inbox", `${two.task}.md`)).meta, claimed_by: "h" }, "b", {} as never);
  expect(prompt).toContain("step of plan PL-0001");
  expect(prompt).toContain("Goal: Ship it");
  expect(prompt).toContain("[done] One\n   Result: built the first part");
  expect(prompt).toContain("[YOUR STEP] Two");
  expect(prompt).toContain("agent/plan-PL-0001");
  finish(two.task!, "done");
  tick();
  expect(readPlan(p.id).status).toBe("done");
  expect(notes).toEqual([`Plan ${p.id} finished: Ship it`]);
  expect(planSection({ id: "T-1" })).toBe("");
});

test("work in progress holds the plan: queued, waiting on CI, or waiting for a decision", () => {
  const p = approved("One", "Two");
  tick();
  const t = current(p.id).task!;
  for (const to of ["waiting", "blocked"] as const) {
    finish(t, to);
    expect(tick()).toBe(false);
    expect(readPlan(p.id).status).toBe("running");
  }
});

test("a failure with retries left isn't final; used up, it stops the plan and says why", () => {
  const p = approved("One", "Two");
  tick();
  const t = current(p.id).task!;
  finish(t, "failed", "tests are red", { attempt: "1" });
  expect(tick()).toBe(false); // handleFailure is about to requeue it
  expect(readPlan(p.id).status).toBe("running");
});

test("a stranded failure stops after a while; a final one at once", () => {
  const p = approved("One");
  tick();
  const t = current(p.id).task!;
  const f = P("tasks", "inbox", `${t}.md`);
  const { meta, body } = readDoc(f);
  unlinkSync(f);
  writeDoc(P("tasks", "failed", `${t}.md`), { ...meta, attempt: "1", finished: new Date(clock).toISOString() }, `${body}\n## Run x\n**failed** — boom\n`);
  tick();
  expect(readPlan(p.id).status).toBe("running");
  clock += 11 * 60_000;
  tick();
  expect(readPlan(p.id)).toMatchObject({ status: "paused", reason: "boom" });
  expect(notes[0]).toContain('stopped at "One": boom');
});

test("retry starts a new task with a new attempt; skip moves on; resume is refused until then", () => {
  const p = approved("One", "Two");
  tick();
  const first = current(p.id).task!;
  finish(first, "failed", "boom", { attempt: "2" });
  tick();
  expect(readPlan(p.id).status).toBe("paused");
  expect(tick()).toBe(false); // paused starts nothing
  expect(status(() => resumePlan(p.id))).toBe(409);
  retryStep(p.id);
  tick();
  const again = current(p.id);
  expect(again.task).not.toBe(first);
  expect(readDoc(P("tasks", "inbox", `${again.task}.md`)).meta.plan_step).toBe("s1#2");
  finish(again.task!, "rejected");
  tick();
  expect(readPlan(p.id)).toMatchObject({ status: "paused", reason: "its task was cancelled" });
  skipStep(p.id);
  tick();
  expect(readPlan(p.id).steps.map((s) => s.status)).toEqual(["skipped", "running"]);
  expect(status(() => retryStep(p.id))).toBe(409);
});

test("a crash between making the task and saving the plan can't run the step twice", () => {
  const p = approved("One");
  const made = newTask("One", "b", { source: `plan:${p.id}`, extra: { origin: "owner", plan: p.id, plan_step: "s1#1" } });
  tick();
  expect(current(p.id).task).toBe(made);
  expect(readdirSync(P("tasks", "inbox")).filter((f) => f.startsWith("T-"))).toEqual([`${made}.md`]);
});

test("a missing task stops the plan instead of hanging", () => {
  const p = approved("One");
  tick();
  unlinkSync(P("tasks", "inbox", `${current(p.id).task}.md`));
  tick();
  expect(readPlan(p.id).status).toBe("paused");
});

test("checkpoints pause after the step; pause lets the step finish and starts nothing", () => {
  const p = approved("One", "Two");
  editSteps(p.id, { steps: [{ title: "One", checkpoint: true }, { title: "Two" }] });
  tick();
  finish(current(p.id).task!, "done");
  tick();
  expect(readPlan(p.id).status).toBe("paused");
  expect(readPlan(p.id).reason).toContain("Checkpoint");
  expect(readPlan(p.id).steps[1].status).toBe("pending");
  resumePlan(p.id);
  tick();
  const two = current(p.id);
  expect(two.title).toBe("Two");
  pausePlan(p.id);
  finish(two.task!, "done");
  tick();
  expect(readPlan(p.id)).toMatchObject({ status: "paused" });
  expect(readPlan(p.id).steps[1].status).toBe("done");
  resumePlan(p.id);
  tick();
  expect(readPlan(p.id).status).toBe("done");
});

test("editing only touches steps that haven't started", () => {
  const p = approved("One", "Two", "Three");
  tick();
  editSteps(p.id, { steps: [{ title: "Three", agent: "writer" }] });
  expect(readPlan(p.id).steps.map((s) => [s.title, s.status, s.agent])).toEqual([["One", "running", "lead"], ["Three", "pending", "writer"]]);
  expect(new Set(readPlan(p.id).steps.map((s) => s.id)).size).toBe(2);
});

test("continuing goes back through the planner, keeps finished work, and lets the running step finish", () => {
  const p = approved("One", "Two", "Three");
  tick();
  const one = current(p.id).task!;
  finish(one, "done", "first done");
  tick();
  const two = current(p.id).task!;
  const r = continuePlan(p.id, { instructions: "Also do mobile" });
  expect(r.status).toBe("drafting");
  const draft = readDoc(P("tasks", "inbox", `${r.draft_task}.md`));
  expect(draft.body).toContain("Also do mobile");
  expect(draft.body).toContain("[done] One: first done");
  expect(draft.body).not.toContain("Three");
  finish(two, "done", "second done"); // finishes while the planner works
  tick();
  expect(readPlan(p.id).steps[1].status).toBe("done");
  expect(readPlan(p.id).steps[2].status).toBe("pending"); // nothing new starts
  saveDraft(p.id, steps("Mobile"));
  expect(readPlan(p.id).steps.map((s) => [s.title, s.status])).toEqual([["One", "done"], ["Two", "done"], ["Mobile", "pending"]]);
  approvePlan(p.id);
  tick();
  expect(current(p.id).title).toBe("Mobile");
  finish(current(p.id).task!, "done");
  tick();
  expect(readPlan(p.id).status).toBe("done");
  // and after it has finished
  expect(continuePlan(p.id, { instructions: "One more thing" }).status).toBe("drafting");
  expect(readPlan(p.id).notes).toEqual(["Also do mobile", "One more thing"]);
  expect(status(() => continuePlan(p.id, { instructions: "" }))).toBe(409); // already drafting
});

test("a draft that fails or returns nothing goes to review with the reason", () => {
  const a = createPlan({ goal: "a" });
  finish(a.draft_task!, "done");
  tick();
  expect(readPlan(a.id)).toMatchObject({ status: "review" });
  expect(readPlan(a.id).reason).toContain("no steps");
  const b = createPlan({ goal: "b" });
  finish(b.draft_task!, "failed", "no model", { attempt: "2" });
  tick();
  expect(readPlan(b.id).reason).toContain("no model");
  const c = createPlan({ goal: "c" });
  finish(c.draft_task!, "rejected");
  tick();
  expect(readPlan(c.id).reason).toContain("cancelled");
  expect(notes).toHaveLength(3);
  editSteps(a.id, { steps: steps("By hand") });
  expect(approvePlan(a.id).status).toBe("running");
});

test("cancel names the tasks to stop; finished plans can be archived, open ones can't", () => {
  const p = approved("One", "Two");
  tick();
  const t = current(p.id).task!;
  expect(status(() => archivePlan(p.id))).toBe(409);
  const c = cancelPlan(p.id);
  expect(c.tasks).toEqual([t]);
  expect(c.plan.status).toBe("cancelled");
  expect(tick()).toBe(false);
  expect(status(() => cancelPlan(p.id))).toBe(409);
  expect(cancelPlan(createPlan({ goal: "x" }).id).tasks).toHaveLength(1);
  archivePlan(p.id);
  expect(existsSync(P("plans", `${p.id}.json`))).toBe(false);
  expect(readdirSync(P("archive", "plans"))[0].startsWith(p.id)).toBe(true);
});

test("a plan with a project works in it, and holds on to its project and members", () => {
  const dir = `${process.env.HUB_DATA}-site`;
  mkdirSync(dir, { recursive: true });
  const id = createProject({ name: "Site", path: dir }, "mac");
  const p = createPlan({ goal: "g", project: id, agent: "writer" });
  expect(readDoc(P("tasks", "inbox", `${p.draft_task}.md`)).meta).toMatchObject({ project: id, host: "mac" });
  saveDraft(p.id, [{ title: "One", agent: "writer" }]);
  approvePlan(p.id);
  tick();
  expect(readDoc(P("tasks", "inbox", `${current(p.id).task}.md`)).meta).toMatchObject({ project: id, host: "mac", agent: "writer" });
  expect(status(() => deleteProject(id))).toBe(409);
  expect(deleteBlockers("writer", {} as never).join()).toContain(p.id);
  rmSync(dir, { recursive: true, force: true });
});

test("a planner's bad output can't hurt the worker, and a damaged file can't stop the tick", () => {
  const p = createPlan({ goal: "g" });
  expect(saveDraft(p.id, "not a list")).toBe(false);
  expect(saveDraft(p.id, [{ title: "" }, null, 7])).toBe(false);
  expect(readPlan(p.id).status).toBe("drafting");
  expect(saveDraft(p.id, [null, { title: "Good" }, ...Array.from({ length: 30 }, (_, i) => ({ title: `s${i}` }))])).toBe(true);
  expect(readPlan(p.id).steps).toHaveLength(20);
  expect(saveDraft(p.id, steps("late"))).toBe(false); // already in review
  writeFileSync(P("plans", "PL-0099.json"), "{ not json");
  expect(listPlans().map((x) => x.id)).toEqual([p.id]);
  expect(() => tick()).not.toThrow();
});

test("saving leaves no temporary file behind", () => {
  const p = approved("One");
  savePlan(p);
  expect(existsSync(P("plans", `${p.id}.json.tmp`))).toBe(false);
});

test("the API drives a plan, refuses what doesn't apply, and reports open plans", async () => {
  const call = async (method: string, id?: string, action?: string, body?: unknown) => {
    const r = await planRoute(new Request("http://x/api/plans", { method, body: body === undefined ? undefined : JSON.stringify(body) }), id, action, RECORD_IO);
    return { status: r.status, data: (await r.json()) as any };
  };
  expect((await call("POST", undefined, undefined, {})).status).toBe(400);
  const made = await call("POST", undefined, undefined, { goal: "Ship" });
  const id = made.data.plan.id;
  expect(made.data.plan.status).toBe("drafting");
  expect((await call("POST", id, "approve")).status).toBe(409);
  expect((await call("POST", id, "nonsense")).status).toBe(404);
  expect((await call("DELETE", id)).status).toBe(409);
  saveDraft(id, steps("One", "Two"));
  expect(hubStatus().plans).toEqual([{ id, goal: "Ship", status: "review", project: undefined, reason: undefined, done: 0, total: 2 }]);
  expect((await call("PUT", id, undefined, { steps: [{ title: "Only" }] })).data.plan.steps.map((s: any) => s.title)).toEqual(["Only"]);
  expect((await call("POST", id, "approve")).data.plan.status).toBe("running");
  expect((await call("POST", id, "pause")).data.plan.status).toBe("paused");
  expect((await call("POST", id, "resume")).data.plan.status).toBe("running");
  expect((await call("POST", id, "continue", { instructions: "more" })).data.plan.notes).toEqual(["more"]);
  expect((await call("GET")).data.plans).toHaveLength(1);
  expect((await call("GET", "PL-0404")).status).toBe(404);
  expect((await call("POST", id, "cancel")).data.plan.status).toBe("cancelled");
  expect((await call("DELETE", id)).data.ok).toBe(true);
  expect(hubStatus().plans).toEqual([]);
});

test("chat's tools see plans on disk and check what they're given", () => {
  const p = createPlan({ goal: "Ship" });
  const st = localStore({ acts: {}, status: () => ({}), feed: () => [] });
  expect(listPlansView(st)).toEqual([{ id: p.id, goal: "Ship", status: "drafting", project: undefined, reason: undefined, steps: [] }]);
  expect(writeOp("create_plan", { goal: "Do it" }, st)).toEqual({ tool: "create_plan", goal: "Do it", project: undefined, agent: undefined });
  expect(writeOp("create_plan", {}, st)).toBe("goal required");
  expect(writeOp("create_plan", { goal: "g", project: "ghost" }, st)).toContain("unknown project");
  expect(writeOp("continue_plan", { id: p.id, instructions: "more" }, st)).toEqual({ tool: "continue_plan", id: p.id, instructions: "more" });
  expect(writeOp("continue_plan", { id: p.id }, st)).toBe("instructions required");
  expect(writeOp("approve_plan", { id: "PL-0404" }, st)).toContain("unknown plan");
  expect(writeOp("approve_plan", { id: "../x" }, st)).toContain("required");
});

test("a restart stops an agent the last daemon left behind, and nothing else", async () => {
  const start = (name: string) => Bun.spawn(["bash", "-c", `exec -a ${name} sleep 30`]);
  mkdirSync(P("logs", "pids"), { recursive: true });
  const agent = start("claude");
  await Bun.sleep(100);
  writeFileSync(P("logs", "pids", "T-1.pid"), String(agent.pid));
  expect(await stopOrphanedAgent("T-1")).toBe(true);
  expect(await agent.exited).not.toBe(0);
  expect(existsSync(P("logs", "pids", "T-1.pid"))).toBe(false);
  // the pid has been reused by something else: leave it alone
  const other = start("sleepy");
  await Bun.sleep(100);
  writeFileSync(P("logs", "pids", "T-2.pid"), String(other.pid));
  await expect(stopOrphanedAgent("T-2")).rejects.toThrow("cannot be verified");
  expect(other.killed).toBe(false);
  other.kill();
  expect(await stopOrphanedAgent("T-3")).toBe(false); // nothing recorded
});
