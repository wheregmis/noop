// Judge shadow mode + learning loop: every routed decision records the judge's answer; owner answers score it.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = mkdtempSync(join(tmpdir(), "hub-decisions-"));
let judgeReply: any = null;
const sent: string[] = [];
const realRunner = await import("../src/runner");
mock.module("../src/runner", () => ({ ...realRunner, ask: async () => judgeReply }));
const realNotify = await import("../src/notify");
mock.module("../src/notify", () => ({ ...realNotify, openDecisionIds: () => new Set<string>(), pollReplies: async () => [], notify: async (t: string) => { sent.push(t); return ["test"]; } }));

let core: typeof import("../src/core"), dec: typeof import("../src/decisions"), auto: typeof import("../src/autonomy");
beforeAll(async () => {
  process.env.HUB_DATA ||= join(W, "data"); // test/preload.ts normally sets a temp dir already
  process.env.HUB_SYNC = "local";
  core = await import("../src/core");
  if (!core.DATA.startsWith(tmpdir())) throw new Error(`DATA=${core.DATA} is not a temp dir; refusing to touch real data`);
  for (const d of ["decisions/open", "decisions/closed"]) rmSync(core.P(d), { recursive: true, force: true });
  rmSync(core.P("memory", "lessons.md"), { force: true });
  dec = await import("../src/decisions");
  auto = await import("../src/autonomy");
  for (const d of ["decisions/open", "decisions/closed", "tasks/blocked", "tasks/inbox", "memory", "journal", "logs/runs"])
    mkdirSync(join(core.DATA, d), { recursive: true });
});
afterAll(() => { // the data dir is shared with every other test file: leave the clean slate beforeAll took
  for (const d of ["decisions/open", "decisions/closed"]) rmSync(core.P(d), { recursive: true, force: true });
  rmSync(W, { recursive: true, force: true });
});

const cfg = { judge: { enabled: true } } as any; // autonomy level defaults to onboarding → shadow mode
const open = (rec = "A", question = "Merge?") => dec.openDecision({ id: "T-0001", agent: "lead" }, { status: "blocked", summary: "ctx", question, recommendation: rec, options: ["A: merge", "B: wait"] } as any, "h");
const closed = (id: string) => core.readDoc(core.P("decisions", "closed", `${id}.md`)).meta;
const lessons = () => (existsSync(core.P("memory", "lessons.md")) ? readFileSync(core.P("memory", "lessons.md"), "utf8") : "");

test("judge hold is still recorded and scored against the owner", async () => {
  judgeReply = { verdict: "hold", answer: "B: wait", reason: "release gate" };
  const id = open("A");
  await dec.routeDecision(id, cfg, "h");
  const o = core.readDoc(core.P("decisions", "open", `${id}.md`)).meta;
  expect(o.shadow_verdict).toBe("hold");
  expect(o.shadow_answer).toBe("B: wait");
  // the card: the question, the agent's account, its recommendation; never the judge's reason for asking
  expect(sent.at(-1)).toContain("Merge?");
  expect(sent.at(-1)).toContain("建议：*A*");
  expect(sent.at(-1)).not.toContain("release gate");
  dec.closeDecision(id, "B", "owner(chat)");
  expect(closed(id).shadow_agree).toBe("yes");
  // owner chose differently from the agent's recommendation → lesson appended (precedents() lists it too)
  expect(closed(id).overrode_recommendation).toBe("yes");
  expect(lessons()).toContain(`${id} [lead]`);
  expect(core.precedents()).toContain(`${id} [lead] Q: Merge?`);
});

test("shadow decided verdict feeds judgeAccuracy; agreeing with the recommendation adds no lesson", async () => {
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent", cite: "D-0001" };
  const before = lessons();
  const id = open("A");
  await dec.routeDecision(id, cfg, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true); // onboarding: still asks the owner
  dec.closeDecision(id, "A: merge", "owner(cli@h)");
  expect(closed(id).shadow_verdict).toBe("decided");
  expect(closed(id).shadow_agree).toBe("yes");
  expect(lessons()).toBe(before);
  const acc = auto.judgeAccuracy();
  expect(acc.samples).toBe(2);
  expect(acc.would_decide).toBe(1);
  expect(acc.scored).toBe(2); // the held decision is scored too
  expect(acc.agreed).toBe(2);
});

test("judge failure is recorded as error; judge auto-decision keeps its shadow fields and is not self-scored", async () => {
  judgeReply = null;
  const id = open();
  await dec.routeDecision(id, cfg, "h");
  expect(core.readDoc(core.P("decisions", "open", `${id}.md`)).meta.shadow_verdict).toBe("error");
  dec.closeDecision(id, "B", "owner(chat)");
  expect(closed(id).shadow_agree).toBeUndefined();

  judgeReply = { verdict: "decided", answer: "A", reason: "precedent" };
  const id2 = open("A", "Which fix?"); // merge cards are always held (rule D), so a non-merge card
  await dec.routeDecision(id2, { ...cfg, autonomy: { level: "trusted" } }, "h");
  expect(closed(id2).answered_by).toBe("judge");
  expect(closed(id2).shadow_verdict).toBe("decided");
  expect(closed(id2).shadow_agree).toBeUndefined();
});

test("choice() normalises option answers", () => {
  expect(dec.choice("B: wait")).toBe("B");
  expect(dec.choice(" a ")).toBe("A");
  expect(dec.choice("1, 3")).toBe("1,3");
  expect(dec.choice("Approve it")).toBe("approve it");
});

test("linkRefs links PR references using the repositories the decision mentions", () => {
  const opts = "A: squash 合并 https://github.com/longbridge/nsh/pull/747 — 发布";
  expect(dec.linkRefs("合并 nsh #747 吗？", undefined, opts)).toBe("合并 [nsh#747](https://github.com/longbridge/nsh/pull/747) 吗？");
  expect(dec.linkRefs("见 PR #747", undefined, opts)).toBe("见 PR [#747](https://github.com/longbridge/nsh/pull/747)");
  expect(dec.linkRefs("改 a/b#3", undefined, "")).toBe("改 [a/b#3](https://github.com/a/b/pull/3)");
  // an unknown repository, an existing link and no repository at all stay as they are
  expect(dec.linkRefs("见 other#3 与 [#9](u)", undefined, opts)).toBe("见 other#3 与 [#9](u)");
  expect(dec.linkRefs("见 #5", undefined, "")).toBe("见 #5");
});

test("ignoring a question closes it without a lesson and hands the call back to the agent", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  const before = lessons();
  const id = open("A");
  core.writeDoc(core.P("tasks", "blocked", "T-0001.md"), { id: "T-0001", title: "t" }, "body");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(true);
  expect(closed(id).ignored).toBe("yes");
  expect(closed(id).overrode_recommendation).toBeUndefined();
  expect(lessons()).toBe(before);
  expect(existsSync(core.P("tasks", "blocked", "T-0001.md"))).toBe(false);
  expect(existsSync(core.P("tasks", "rejected", "T-0001.md"))).toBe(false);
  const t = core.readDoc(core.P("tasks", "inbox", "T-0001.md"));
  expect(t.meta.gate_override).toBeUndefined();
  expect(t.body).toContain("NOT a rejection");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(false);
});

test("D: the judge never answers a merge card, even when allowed to decide", async () => {
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent", cite: "D-0107" };
  sent.length = 0;
  const id = dec.openDecision({ id: "T-0002", agent: "reviewer" }, { status: "needs_decision", summary: "https://github.com/huacnlee/omamail/pull/457 fixes x",
    question: "现在合并 omamail #457 吗？", recommendation: "A", options: ["A: merge", "B: wait"] } as any, "h");
  await dec.routeDecision(id, { judge: { enabled: true }, autonomy: { level: "trusted" } } as any, "h");
  expect(existsSync(core.P("decisions", "open", `${id}.md`))).toBe(true);
  expect(sent.at(-1)!.split("\n")[0]).toBe("https://github.com/huacnlee/omamail/pull/457 需要你点合并");
});

test("followups of an owner-answered idle menu count as the owner's pick; a skipped or judged menu does not", () => {
  const menuTask = (tid: string) => {
    const id = dec.openDecision({ id: tid, agent: "chief-of-staff", kind: "menu" }, { status: "needs_decision", summary: "idle", question: "Which next actions?", recommendation: "1", options: ["1. a", "2. b"] } as any, "h");
    core.writeDoc(core.P("tasks", "blocked", `${tid}.md`), { id: tid, agent: "chief-of-staff", kind: "menu", source: "idle", decision: id }, "menu");
    return id;
  };
  const resumed = (tid: string) => core.readDoc(core.P("tasks", "inbox", `${tid}.md`)).meta;
  dec.closeDecision(menuTask("T-0301"), "all", "owner(chat)");
  expect(dec.ownerPickedMenu(resumed("T-0301"))).toBe(true);
  dec.ignoreDecision(menuTask("T-0302"), "owner(chat)");
  expect(dec.ownerPickedMenu(resumed("T-0302"))).toBe(false);
  dec.closeDecision(menuTask("T-0303"), "1", "judge");
  expect(dec.ownerPickedMenu(resumed("T-0303"))).toBe(false);
  expect(dec.ownerPickedMenu({ id: "T-0304", kind: "menu" })).toBe(false); // first run: nothing answered yet
});

test("judge.merge_cards: the judge's confident A on an A-recommended merge card closes it and opens the gate", async () => {
  const card = (tid: string, rec = "A") => {
    const id = dec.openDecision({ id: tid, agent: "reviewer" }, { status: "needs_decision", summary: "https://github.com/o/r/pull/9 fixes x",
      question: "Merge PR #9?", recommendation: rec, options: ["A: merge", "B: wait"] } as any, "h");
    core.writeDoc(core.P("tasks", "blocked", `${tid}.md`), { id: tid, agent: "reviewer", decision: id }, "review");
    return id;
  };
  const on = { judge: { enabled: true, merge_cards: true }, autonomy: { level: "trusted" } } as any;
  judgeReply = { verdict: "decided", answer: "A", reason: "precedent", cite: "D-0053" };
  const a = card("T-0401");
  await dec.routeDecision(a, on, "h");
  expect(closed(a).answered_by).toBe("judge");
  expect(core.readDoc(core.P("tasks", "inbox", "T-0401.md")).meta.gate_override).toBe(a);
  const b = card("T-0402", "B"); // reviewer did not recommend merging: still the owner's call
  await dec.routeDecision(b, on, "h");
  expect(existsSync(core.P("decisions", "open", `${b}.md`))).toBe(true);
  judgeReply = { verdict: "hold", answer: "A", reason: "unsure" };
  const c = card("T-0403");
  await dec.routeDecision(c, on, "h");
  expect(existsSync(core.P("decisions", "open", `${c}.md`))).toBe(true);
});

test("idle.auto_answer answers a menu without asking, and its items count as the owner's pick", async () => {
  sent.length = 0;
  const id = dec.openDecision({ id: "T-0405", agent: "chief-of-staff", kind: "menu" }, { status: "needs_decision", summary: "idle", question: "Which next actions?", recommendation: "1", options: ["1. a", "2. b"] } as any, "h");
  core.writeDoc(core.P("tasks", "blocked", "T-0405.md"), { id: "T-0405", agent: "chief-of-staff", kind: "menu", source: "idle", decision: id }, "menu");
  await dec.routeDecision(id, { judge: { enabled: true }, idle: { auto_answer: "all" } } as any, "h");
  expect(sent.length).toBe(0);
  expect(closed(id).answer).toBe("all");
  expect(dec.ownerPickedMenu(core.readDoc(core.P("tasks", "inbox", "T-0405.md")).meta)).toBe(true);
});
