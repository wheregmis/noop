import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { P, list, readDoc, writeDoc } from "../src/core";
import { sweepPlatform, alreadyAsked, cardFor, checkUnrunnable, classify, groupByCause, supervise, type Ctx, type Task } from "../src/supervisor";
import { closeDecision, ignoreDecision } from "../src/decisions";

const H = 3_600_000;
const NOW = Date.parse("2026-11-07T04:00:00Z");
const mac = { host: "huacnlee-macbook", caps: ["os:macos", "host:huacnlee-macbook"], seen: "", busy: 0, version: "1" };
const lin = { host: "lb", caps: ["os:linux", "host:lb"], seen: "", busy: 0, version: "1" };
const old = { host: "omarchy-jason", caps: ["os:linux", "host:omarchy-jason"], seen: "", busy: 0, version: "1" };
const ctx = (o: Partial<Ctx> = {}): Ctx => ({ now: NOW, online: [mac, lin, old], retired: ["omarchy-jason"], primaryOs: "linux",
  maxAgeHours: 3, maxWakes: 3, decision: () => undefined, ...o });
const task = (m: Record<string, string>, folder: "waiting" | "blocked" = "waiting"): Task =>
  ({ folder, meta: { title: m.id, created: new Date(NOW - H).toISOString(), waiting_on: "x", wait_check: "true", ...m } });

// Every test file shares one throwaway hub (see test/preload.ts), and reroute/resume move tasks into
// tasks/inbox with their host requirement stripped. A leftover there is a pickable task, so a later
// file's pickTask() test would pick it up instead of its own fixture. Remove what this file created.
afterAll(() => {
  for (const id of ["T-0101", "T-0102", "T-0103", "T-0201", "T-0202"]) rmSync(P("tasks", "inbox", `${id}.md`), { force: true });
});

test("young, normally cycling waits are left alone", () => {
  expect(classify(task({ id: "T-1", requires: "os:linux", wakes: "1" }), ctx())).toBeNull();
});

test("flags age, wake count and macOS checks that can never run on the Linux primary", () => {
  const a = classify(task({ id: "T-1", created: new Date(NOW - 5 * H).toISOString() }), ctx())!;
  expect(a.action).toBe("escalate");
  expect(a.reasons[0]).toContain("5 小时");
  expect(classify(task({ id: "T-2", wakes: "3" }), ctx())!.reasons).toContain("唤醒 3 次");
  expect(checkUnrunnable("swift /Users/jason/x/display.swift", "linux")).toBe(true);
  expect(checkUnrunnable("gh pr checks 1 -R o/r", "linux")).toBe(false);
  const m = classify(task({ id: "T-3", requires: "os:macos", wait_check: "test -f /Users/jason/a" }), ctx())!;
  expect(m.cause).toBe("platform:os:macos");
});

test("a Windows path under Users is a local path on a Windows primary, not a macOS path", () => {
  const win = { host: "winbox", caps: ["os:windows", "host:winbox"], seen: "", busy: 0, version: "1" };
  // Git Bash, MSYS, WSL and drive-letter spellings all contain the text "/Users/" but are ordinary local paths.
  expect(checkUnrunnable("bash -c 'grep -q DONE /c/Users/testuser/work/chain.log'", "windows")).toBe(false);
  expect(checkUnrunnable("grep -q DONE C:/Users/testuser/work/chain.log", "windows")).toBe(false);
  expect(checkUnrunnable("test -f /mnt/c/Users/testuser/a", "linux")).toBe(false);
  // A real macOS home path is still unrunnable anywhere but macOS, at the start of the command or after a quote or space.
  expect(checkUnrunnable("/Users/jason/bin/check.sh", "windows")).toBe(true);
  expect(checkUnrunnable("cat '/Users/jason/a'", "linux")).toBe(true);
  expect(checkUnrunnable("test -f /Users/jason/a", "windows")).toBe(true);
  // The incident: a young Windows task whose check reads a Git Bash path was handed back to the inbox ("cannot run on
  // the primary"), lost its state, and later became a "Windows tasks not advancing" card. It must be left alone.
  const young = task({ id: "T-1", requires: "os:windows", wakes: "1", wait_check: "bash -c 'grep -q DONE /c/Users/testuser/chain.log'" });
  expect(classify(young, ctx({ primaryOs: "windows", online: [win] }))).toBeNull();
});

test("keep going first: retired host → reroute, answered card → resume, no waiting_on → requeue once", () => {
  const r = classify(task({ id: "T-1", requires: "host:omarchy-jason", claimed_by: "omarchy-jason" }), ctx())!;
  expect([r.action, r.requires]).toEqual(["reroute", ""]);
  const b = classify(task({ id: "T-2", decision: "D-1" }, "blocked"), ctx({ decision: () => "closed" }))!;
  expect(b.action).toBe("resume");
  expect(classify(task({ id: "T-3", decision: "D-1" }, "blocked"), ctx({ decision: () => "open" }))).toBeNull();
  expect(classify(task({ id: "T-4", waiting_on: "", wait_check: "" }), ctx())!.action).toBe("requeue");
  expect(classify(task({ id: "T-4", waiting_on: "", wait_check: "", supervisor_requeued: "yes" }), ctx())!.action).toBe("escalate");
  expect(classify(task({ id: "T-5", children: "T-6" }), ctx())).toBeNull(); // delegated parent
});

test("groups by cause: all macOS-desktop tasks share one card", () => {
  const vs = ["T-1", "T-2", "T-3"].map((id) => classify(task({ id, requires: "os:macos", wakes: "5" }), ctx())!);
  vs.push(classify(task({ id: "T-9", requires: "os:linux", wakes: "4", claimed_by: "lb" }), ctx())!);
  const g = groupByCause(vs);
  expect([...g.keys()].sort()).toEqual(["platform:os:macos", "slow:lb"]);
  expect(g.get("platform:os:macos")!.map((v) => v.id)).toEqual(["T-1", "T-2", "T-3"]);
  const c = cardFor("platform:os:macos", g.get("platform:os:macos")!.map((v) => ({ id: v.id, title: v.id, reasons: v.reasons })));
  expect(c.options.length).toBeGreaterThanOrEqual(2);
  expect(c.recommendation).toBe("A");
  expect(c.question).toContain("macOS");
});

test("dedupe: tasks covered by an earlier card for the same cause (answered, skipped or open) are not asked again", () => {
  const cards: Record<string, string>[] = [{ supervisor_cause: "platform:os:macos", tasks: "T-1,T-2", answer: "忽略" }, { supervisor_cause: "no-wait", tasks: "T-3" }];
  expect(alreadyAsked("platform:os:macos", ["T-1", "T-2", "T-3"], cards)).toEqual(["T-3"]);
  expect(alreadyAsked("platform:os:macos", ["T-1"], cards)).toEqual([]);
});

test("supervise(): one card per cause, never twice; answering resumes every task without opening a gate", () => {
  mkdirSync(P("journal"), { recursive: true });
  for (const f of ["waiting", "blocked", "inbox"]) mkdirSync(P("tasks", f), { recursive: true });
  mkdirSync(P("decisions", "open"), { recursive: true }); mkdirSync(P("decisions", "closed"), { recursive: true });
  mkdirSync(P("fleet", "hosts"), { recursive: true });
  const seen = new Date().toISOString();
  writeFileSync(P("fleet", "hosts", "huacnlee-macbook.json"), JSON.stringify({ ...mac, seen }));
  writeFileSync(P("fleet", "hosts", "lb.json"), JSON.stringify({ ...lin, seen }));
  const t0 = new Date(Date.now() - 10 * H).toISOString();
  for (const id of ["T-0101", "T-0102"]) writeDoc(P("tasks", "waiting", `${id}.md`), { id, title: id, requires: "os:macos", created: t0, waiting_on: "Mac 桌面", wait_check: "swift /Users/j/d.swift", supervisor_requeued: "yes" }, "body");
  writeDoc(P("tasks", "waiting", "T-0103.md"), { id: "T-0103", title: "old", requires: "host:omarchy-jason", claimed_by: "omarchy-jason", created: t0, waiting_on: "x" }, "body");
  const cfg = { supervisor: { retired_hosts: ["omarchy-jason"] }, fleet: {} };
  const first = supervise(cfg, "lb");
  expect(first.reroute).toBe(1);
  expect(existsSync(P("tasks", "inbox", "T-0103.md"))).toBe(true);
  const open = list(P("decisions", "open")).map((p) => readDoc(p).meta).filter((m) => m.supervisor_cause === "platform:os:macos");
  expect(open.length).toBe(1);
  expect(open[0].tasks).toBe("T-0101,T-0102");
  expect(supervise(cfg, "lb").cards).toBe(0); // open card: not again
  ignoreDecision(open[0].id, "owner(chat)");
  for (const id of ["T-0101", "T-0102"]) {
    const m = readDoc(P("tasks", "inbox", `${id}.md`)).meta;
    expect(m.gate_override).toBeUndefined();
    // the agent waits again on the same Mac: still covered by the skipped card, so no new card
    writeDoc(P("tasks", "waiting", `${id}.md`), { ...m, wakes: "9" }, "b");
  }
  expect(supervise(cfg, "lb").cards).toBe(0);
  expect(readFileSync(P("journal", `${new Date().toLocaleDateString("sv-SE")}.md`), "utf8")).toContain("supervisor ran");
});

test("closeDecision on a supervisor card never sets gate_override", () => {
  writeDoc(P("decisions", "open", "D-9001.md"), { id: "D-9001", task: "T-0201", tasks: "T-0201,T-0202", supervisor_cause: "no-wait", question: "q" }, "c");
  for (const id of ["T-0201", "T-0202"]) writeDoc(P("tasks", "blocked", `${id}.md`), { id, title: id, decision: "D-9001" }, "b");
  closeDecision("D-9001", "A", "owner(chat)");
  for (const id of ["T-0201", "T-0202"]) {
    const m = readDoc(P("tasks", "inbox", `${id}.md`)).meta;
    expect(m.resumes).toBe("D-9001");
    expect(m.gate_override).toBeUndefined();
  }
});

test("dated follow-ups are exempt; a delegated parent on a retired host is re-pinned; young same-platform tasks join the card", () => {
  expect(classify(task({ id: "T-1", wakes: "9", wait_check: "test $(date +%Y%m%d) -lt 20261114" }), ctx())).toBeNull();
  const p = classify(task({ id: "T-2", children: "T-3", requires: "host:omarchy-jason" }), ctx())!;
  expect([p.action, p.requires]).toEqual(["repin", ""]);
  const young = task({ id: "T-4", requires: "os:macos" });
  const stuck = classify(task({ id: "T-5", requires: "os:macos", wakes: "7" }), ctx())!;
  expect(classify(young, ctx())).toBeNull();
  expect(sweepPlatform([young], [stuck]).map((v) => [v.id, v.cause])).toEqual([["T-4", "platform:os:macos"]]);
});

test("macOS host online + wait_check unrunnable on the primary: hand back to the Mac once, not a card", () => {
  const m = { id: "T-1", requires: "os:macos", created: new Date(NOW - 10 * H).toISOString(), waiting_on: "x", wait_check: "test -f /Users/j/done" };
  expect(classify(task(m), ctx())!.action).toBe("reroute");
  expect(classify(task({ ...m, supervisor_requeued: "yes" }), ctx())!.action).toBe("escalate");
});

import { trackedPrs } from "../src/supervisor";
test("trackedPrs reads PR urls from spec and repo #N from title, not from run logs", () => {
  const body = "PR: https://github.com/huacnlee/noop/pull/182 (branch x)\n\n## Run 2026\nsee https://github.com/longbridge/nsh/pull/9";
  expect(trackedPrs({ title: "Noop #182：验收并合并", repo: "huacnlee/noop" }, body)).toEqual(["huacnlee/noop#182"]);
  expect(trackedPrs({ title: "NSH #1846：放大后变糊" }, "no pr yet")).toEqual([]);
});


test("merged PRs wake a task once for acceptance checks instead of completing it", () => {
  const id = "T-9406-test";
  const waiting = P("tasks", "waiting", `${id}.md`);
  const inbox = P("tasks", "inbox", `${id}.md`);
  const done = P("tasks", "done", `${id}.md`);
  try {
    writeDoc(waiting, { id, title: "Verify screenshot", waiting_on: "Need screenshot", wait_kind: "human", created: new Date(NOW).toISOString() }, "PR: https://github.com/huacnlee/noop/pull/182");
    supervise({}, "test", NOW, () => "OPEN");
    expect(existsSync(waiting)).toBe(true);
    supervise({}, "test", NOW, () => "MERGED");
    expect(existsSync(waiting)).toBe(false);
    expect(existsSync(done)).toBe(false);
    const resumed = readDoc(inbox);
    expect(resumed.meta.resumed).toBe("yes");
    expect(resumed.body).toContain("Check remaining acceptance criteria");
    rmSync(inbox);
    writeDoc(waiting, { ...resumed.meta, waiting_on: "Need screenshot" }, resumed.body!);
    supervise({}, "test", NOW, () => { throw new Error("Must not recheck a handled merge"); });
    expect(existsSync(waiting)).toBe(true);
    expect(existsSync(inbox)).toBe(false);
  } finally {
    for (const path of [waiting, inbox, done]) rmSync(path, { force: true });
  }
});
