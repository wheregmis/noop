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
afterAll(() => rmSync(W, { recursive: true, force: true }));

const cfg = { judge: { enabled: true } } as any; // autonomy level defaults to onboarding → shadow mode
const open = (rec = "A") => dec.openDecision({ id: "T-0001", agent: "lead" }, { status: "blocked", summary: "ctx", question: "Merge?", recommendation: rec, options: ["A: merge", "B: wait"] } as any, "h");
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
  expect(sent.at(-1)).toContain("Recommendation: *A*");
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
  const id2 = open();
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
  const opts = "A: squash merge https://github.com/longbridge/nsh/pull/747 — release";
  expect(dec.linkRefs("Merge nsh #747?", undefined, opts)).toBe("Merge [nsh#747](https://github.com/longbridge/nsh/pull/747)?");
  expect(dec.linkRefs("see PR #747", undefined, opts)).toBe("see PR [#747](https://github.com/longbridge/nsh/pull/747)");
  expect(dec.linkRefs("fix a/b#3", undefined, "")).toBe("fix [a/b#3](https://github.com/a/b/pull/3)");
  // an unknown repository, an existing link and no repository at all stay as they are
  expect(dec.linkRefs("see other#3 and [#9](u)", undefined, opts)).toBe("see other#3 and [#9](u)");
  expect(dec.linkRefs("see #5", undefined, "")).toBe("see #5");
});

test("ignoring a question closes it without a lesson and drops its task", async () => {
  judgeReply = { verdict: "hold", reason: "owner call" };
  const before = lessons();
  const id = open("A");
  core.writeDoc(core.P("tasks", "blocked", "T-0001.md"), { id: "T-0001", title: "t" }, "body");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(true);
  expect(closed(id).ignored).toBe("yes");
  expect(closed(id).overrode_recommendation).toBeUndefined();
  expect(lessons()).toBe(before);
  expect(existsSync(core.P("tasks", "blocked", "T-0001.md"))).toBe(false);
  expect(readFileSync(core.P("tasks", "rejected", "T-0001.md"), "utf8")).toContain("ignored");
  expect(dec.ignoreDecision(id, "owner(chat)")).toBe(false);
});
