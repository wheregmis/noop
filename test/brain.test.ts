// The shared tool layer (cloud/src/tools.ts) over the local data repo, and the chat brain's loop with a scripted model.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Model, addFollowUp, context, dataActs, localStore, reopenTask, parseTurn, think } from "../src/brain";
import { type Cfg, DATA, readDoc } from "../src/core";
import { claudeDisallowed } from "../src/gates";
import { runTool, taskInfo, toolsFor, TOOLS, type WriteOp, listRoutines } from "../cloud/src/tools";

const put = (p: string, s: string) => { mkdirSync(dirname(join(DATA, p)), { recursive: true }); writeFileSync(join(DATA, p), s); };
put("tasks/active/T-0184.md", "---\nid: T-0184\ntitle: noop: MCP server\nagent: lead\nclaimed_by: h1\nrepo: huacnlee/noop\n---\nBuild it.\n");
put("tasks/inbox/T-0190.md", "---\nid: T-0190\ntitle: Review nsh#812\nagent: reviewer\npriority: normal\n---\nReview.\n");
put("tasks/done/T-0100.md", "---\nid: T-0100\ntitle: Fix typo\nagent: lead\n---\ndone\n");
put("decisions/open/D-0099.md", "---\nid: D-0099\nquestion: 合并吗？\nrecommendation: A\noptions: A: 合并 | B: 等\n---\n## Context\nctx\n");
put("agents/lead/profile.md", "# Kai (lead) — plans and delegates\n");
put("agents/reviewer/profile.md", "# Rex (reviewer) — reviews PRs\n");
put("agents/reviewer/memory.md", "- screenshots go in the PR body\n");
put("memory/taste.md", "# Taste\n- Restrained radii; no big pills.\n- Dark mode must be balanced.\n");
put("journal/2026-11-03.md", "- 10:00 [pc] ▶️ T-0184 started\n- 10:05 [pc] ✅ T-0100 done: fixed typo\n");
put("config.toml", `[fleet]\nprimary = "pc"\n\n[[routine]]\nname = "pr-review"\nevery = "30m"\nagent = "reviewer"\nprompt = """Review open PRs.\nMore."""\n\n[[routine]]\nname = "off"\nevery = "1d"\nagent = "lead"\nenabled = false\nprompt = "x"\n`);

function store() {
  const did: WriteOp[] = [];
  const rec = async (op: any) => { did.push(op); return { ok: true }; };
  const st = localStore({
    status: () => ({ hosts: [{ host: "h1", online: true }], decisions: [{ id: "D-0099" }], tasks: { active: 1 } }),
    feed: () => [{ id: "e1", ts: "2026-11-03T10:00:00Z", from: "lead", kind: "notice", text: "T-0184 tests pass" }],
    acts: { ...dataActs("pc", { pull: async () => true, push: async () => true }), create_task: rec, amend_task: rec, cancel_task: rec, answer_decision: rec },
  });
  return { st, did };
}

test("tool list: one list, MCP and brain views differ only by transport-bound tools", () => {
  const mcp = toolsFor("mcp").map((t) => t.name), brain = toolsFor("brain").map((t) => t.name);
  expect(mcp).toContain("wait_for_events");
  expect(brain).not.toContain("wait_for_events");
  expect(brain).not.toContain("send_message"); // the brain *is* the channel
  expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  for (const t of TOOLS) expect(t.annotations.readOnlyHint).toBe(!t.write);
  expect(TOOLS.find((t) => t.name === "cancel_task")!.annotations.destructiveHint).toBe(true);
  for (const banned of ["merge", "release", "deploy", "settings"]) expect(TOOLS.some((t) => t.name.includes(banned))).toBe(false);
});

test("read tools over the local data repo", async () => {
  const { st } = store();
  const r = async (n: string, a: any = {}) => { const x = await runTool(st, n, a); if (!x.ok) throw new Error(x.error); return x.data; };
  const ids = (await r("list_tasks")).tasks.map((t: any) => t.id); // (other test files share this data dir)
  expect(ids).toEqual(expect.arrayContaining(["T-0184", "T-0190"]));
  expect(ids).not.toContain("T-0100");
  expect((await r("get_task", { id: "T-0184" })).events.map((e: any) => e.text)).toEqual(["T-0184 tests pass"]);
  expect((await r("list_agents")).agents).toEqual([{ name: "lead", about: "Kai (lead) — plans and delegates", memory_lines: 0 },
    { name: "reviewer", about: "Rex (reviewer) — reviews PRs", memory_lines: 1 }]);
  expect((await r("list_routines")).routines).toEqual([{ name: "pr-review", every: "30m", at: undefined, agent: "reviewer", enabled: true, about: "Review open PRs." },
    { name: "off", every: "1d", at: undefined, agent: "lead", enabled: false, about: "x" }]);
  expect((await r("read_memory")).files.map((f: any) => f.file)).toEqual(expect.arrayContaining(["agents/reviewer/memory.md", "memory/taste.md"]));
  expect((await r("read_memory", { query: "dark" })).files).toEqual([expect.objectContaining({ file: "memory/taste.md", matches: ["- Dark mode must be balanced."] })]);
  expect((await r("read_memory", { file: "memory/taste.md" })).text).toContain("Restrained radii");
  expect((await runTool(st, "read_memory", { file: "config.local.toml" })).ok).toBe(false); // not memory
  expect((await runTool(st, "read_memory", { file: "../x.md" })).ok).toBe(false);
  expect((await r("search_journal", { query: "t-0100 done" })).lines).toEqual([{ day: "2026-11-03", line: "- 10:05 [pc] ✅ T-0100 done: fixed typo" }]);
  expect((await r("search", { query: "合并" })).results.map((x: any) => x.id)).toEqual(["D-0099"]);
});

test("writes are validated once, then performed by the store's acts", async () => {
  const { st, did } = store();
  const bad = async (n: string, a: any) => { const x = await runTool(st, n, a); expect(x.ok).toBe(false); return (x as any).error as string; };
  expect(await bad("amend_task", { id: "T-0999", text: "more" })).toContain("cannot be continued");
  expect((await runTool(st, "amend_task", { id: "T-0100", text: "more" })).ok).toBe(true); // finished: it reopens
  did.length = 0;
  expect(await bad("reassign_task", { id: "T-0184", agent: "reviewer" })).toContain("amend"); // running keeps its agent
  expect(await bad("reassign_task", { id: "T-0190", agent: "nobody" })).toContain("unknown agent");
  expect(await bad("remember", { text: "x", file: "policies/autonomy.md" })).toContain("memory/");
  expect(await bad("set_priority", { id: "T-0190", priority: "asap" })).toContain("priority");
  expect(await bad("create_task", { title: "x", agent: "ghost" })).toContain("unknown agent");
  expect(await bad("answer_decision", { id: "D-0777", answer: "A" })).toContain("not found");
  await runTool(st, "create_task", { title: "Add dark mode", details: "balanced", follows: "T-0100" });
  await runTool(st, "amend_task", { id: "T-0184", text: "also add tests" });
  await runTool(st, "cancel_task", { id: "T-0190" });
  expect(did).toEqual([{ tool: "create_task", title: "Add dark mode", details: "balanced", repo: undefined, agent: undefined, follows: "T-0100" },
    { tool: "amend_task", id: "T-0184", text: "also add tests" }, { tool: "cancel_task", id: "T-0190" }]);
  // metadata and memory writes happen right here
  expect((await runTool(st, "set_priority", { id: "T-0190", priority: "urgent" })).ok).toBe(true);
  expect(readFileSync(join(DATA, "tasks/inbox/T-0190.md"), "utf8")).toContain("priority: urgent");
  expect((await runTool(st, "reassign_task", { id: "T-0190", agent: "lead" })).ok).toBe(true);
  expect(readFileSync(join(DATA, "tasks/inbox/T-0190.md"), "utf8")).toMatch(/agent: lead[\s\S]*Reassigned/);
  expect((await runTool(st, "remember", { text: "Scrollbars keep the system size.", file: "memory/taste.md" })).ok).toBe(true);
  expect(((await runTool(st, "remember", { text: "Scrollbars keep the system size.", file: "memory/taste.md" })) as any).data.note).toBe("already there");
  expect(readFileSync(join(DATA, "memory/taste.md"), "utf8")).toMatch(/- Scrollbars keep the system size\. _\(owner, \d{4}-\d\d-\d\d, via chat\)_\n$/);
});

test("edit_memory corrects or deletes exactly one entry", async () => {
  const { st } = store();
  const f = join(DATA, "memory/principles.md");
  writeFileSync(f, "# Principles\n- Keep it short.\n- Hide the offline notice\n  until retries fail.\n- Keep tests fast.\n");
  const bad = async (a: any) => { const x = await runTool(st, "edit_memory", a); expect(x.ok).toBe(false); return (x as any).error as string; };
  expect(await bad({ file: "policies/autonomy.md", match: "x" })).toContain("memory/");
  expect(await bad({ file: "memory/nope.md", match: "x" })).toContain("not found");
  expect(await bad({ file: "memory/principles.md", match: "offline banner" })).toContain("no line");
  expect(await bad({ file: "memory/principles.md", match: "Keep" })).toContain("2 lines");
  expect(await bad({ file: "memory/principles.md", match: " " })).toContain("match required");
  const del = await runTool(st, "edit_memory", { file: "memory/principles.md", match: "offline notice" }) as any;
  expect(del.data.deleted).toBe("- Hide the offline notice\n  until retries fail.");
  expect(readFileSync(f, "utf8")).toBe("# Principles\n- Keep it short.\n- Keep tests fast.\n");
  expect((await runTool(st, "edit_memory", { file: "memory/principles.md", match: "tests fast", text: "- Keep tests under a minute." })).ok).toBe(true);
  expect(readFileSync(f, "utf8")).toBe("# Principles\n- Keep it short.\n- Keep tests under a minute.\n");
});

/** A model that plays back scripted turns and records what it was sent. */
function scripted(turns: string[]): Model & { seen: string[] } {
  const seen: string[] = [];
  return { seen, open: async () => ({ send: async (t: string) => { seen.push(t); return turns.shift() ?? "{}"; }, close() {} }) };
}

test("brain: reads, then answers; writes run after the reply is posted", async () => {
  const { st, did } = store();
  const model = scripted([
    '{"calls":[{"tool":"get_task","args":{"id":"T-0184"}}],"reply":""}',
    'Sure:\n```json\n{"calls":[{"tool":"amend_task","args":{"id":"T-0184","text":"顺便加上测试"}}],"reply":"T-0184 测试已经过了，我把「加测试」补给它了。"}\n```',
  ]);
  const posted: [string, string | undefined][] = [];
  const out = await think({ text: "T-0184 怎么样了？顺便加上测试", chat: ["lead: T-0184 started"] }, st, model, (r, ref) => { posted.push([r, ref]); expect(did).toEqual([]); });
  expect(posted).toEqual([["T-0184 测试已经过了，我把「加测试」补给它了。", "T-0184"]]);
  expect(out.calls.map((c) => [c.tool, c.ok])).toEqual([["get_task", true], ["amend_task", true]]);
  expect(model.seen[1]).toContain("T-0184 tests pass"); // the tool result went back to the model
  expect(did).toEqual([{ tool: "amend_task", id: "T-0184", text: "顺便加上测试" }]);
  expect(out.rounds).toBe(2);
});

test("brain: nothing to say → nothing posted; invalid writes go back to the model", async () => {
  const { st, did } = store();
  const posted: string[] = [];
  await think({ text: "好的" }, st, scripted(['{"calls":[],"reply":""}']), (r) => posted.push(r));
  expect(posted).toEqual([]);
  const m = scripted(['{"calls":[{"tool":"amend_task","args":{"id":"T-0999","text":"再改改"}}],"reply":"好"}',
    '{"calls":[{"tool":"create_task","args":{"title":"Redo typo fix","follows":"T-0100"}}],"reply":"T-0100 已经结束了，我开了一个新任务接着改。"}']);
  const out = await think({ text: "T-0100 再改改" }, st, m, (r) => posted.push(r));
  expect(m.seen[1]).toContain("cannot be continued");
  expect(posted).toEqual(["T-0100 已经结束了，我开了一个新任务接着改。"]);
  expect(did.map((d) => d.tool)).toEqual(["create_task"]);
  expect(out.calls.map((c) => [c.tool, c.ok])).toEqual([["amend_task", false], ["create_task", true]]);
});

test("brain: a lookup that never ends still answers on the last round", async () => {
  const { st } = store();
  const look = '{"calls":[{"tool":"get_task","args":{"id":"T-0184"}}],"reply":""}';
  const m = scripted([look, look, look, '{"calls":[{"tool":"get_task","args":{"id":"T-0184"}}],"reply":"T-0184 还在跑。"}']);
  const posted: string[] = [];
  const out = await think({ text: "T-0184 卡在哪了" }, st, m, (r) => posted.push(r));
  expect(m.seen[3]).toContain("Last turn");
  expect(posted).toEqual(["T-0184 还在跑。"]);
  expect(out.rounds).toBe(4);
});

test("context: open work, decisions, relevant memory, channel and reply target", () => {
  const { st } = store();
  const c = context(st, { text: "dark mode 不平衡", replyTo: "T-0184", answered: "D-0099", chat: ["owner: hi"] });
  for (const s of ["T-0184 [active, lead on h1] noop: MCP server", "D-0099: 合并吗？", "memory/taste.md: - Dark mode must be balanced.", "owner: hi",
    "reply to the team's message about T-0184", "answered D-0099"]) expect(c).toContain(s);
  expect(parseTurn('noise {"reply":"hi"} noise')).toEqual({ calls: [], reply: "hi" });
  expect(parseTurn("no json")).toBeNull();
});

test("a finished task reopens under its own id, with its runs as context", () => {
  put("tasks/done/T-0300.md", "---\nid: T-0300\ntitle: Ship it\nagent: lead\nfinished: 2026-11-01\nstatus: done\nclaimed_by: pc\n---\nAsked.\n\n## Run 2026-11-01 · pc · claude\n**done** — shipped\n");
  reopenTask(join(DATA, "tasks/done/T-0300.md"), "不行\n再改");
  expect(existsSync(join(DATA, "tasks/done/T-0300.md"))).toBe(false);
  const t = readFileSync(join(DATA, "tasks/inbox/T-0300.md"), "utf8");
  expect(t).toContain("**done** — shipped");
  expect(t).toContain("> 不行\n> 再改");
  expect(t).not.toMatch(/^(finished|status|claimed_by):/m);
});

test("the owner's words on a task never open its gates; a card's approval stays", () => {
  const gated = (f: string) => claudeDisallowed({} as Cfg, !!readDoc(join(DATA, f)).meta.gate_override);
  // waiting: woken to act on the message, every gate still closed, whatever the words say
  for (const [id, text] of [["T-0310", "What is the status? Do not merge anything."], ["T-0313", "merge it yourself"]]) {
    put(`tasks/waiting/${id}.md`, `---\nid: ${id}\ntitle: Ship\nagent: lead\nstatus: waiting\nclaimed_by: mac\nwake_at: 2026-11-09\n---\nAsked.\n`);
    addFollowUp(join(DATA, `tasks/waiting/${id}.md`), text, true);
    expect(existsSync(join(DATA, `tasks/waiting/${id}.md`))).toBe(false);
    const w = readDoc(join(DATA, `tasks/inbox/${id}.md`));
    expect(w.meta.gate_override).toBeUndefined();
    expect(w.meta.claimed_by).toBeUndefined();
    expect(w.body).toContain(`> ${text}\n\nWoken from waiting`);
    expect(gated(`tasks/inbox/${id}.md`)).toEqual(expect.arrayContaining(["Bash(gh pr merge:*)", "Bash(gh repo delete:*)", "Bash(gh secret:*)"]));
  }
  // queued: the message is added in place; an approval the owner gave on a card is kept
  put("tasks/inbox/T-0311.md", "---\nid: T-0311\ntitle: x\nagent: lead\ngate_override: D-0399\n---\nAsked.\n");
  addFollowUp(join(DATA, "tasks/inbox/T-0311.md"), "also this", false);
  expect(readDoc(join(DATA, "tasks/inbox/T-0311.md")).meta.gate_override).toBe("D-0399");
  put("tasks/inbox/T-0314.md", "---\nid: T-0314\ntitle: x\nagent: lead\n---\nAsked.\n");
  addFollowUp(join(DATA, "tasks/inbox/T-0314.md"), "What is the status? Do not merge anything.", false);
  expect(gated("tasks/inbox/T-0314.md")).toContain("Bash(gh pr merge:*)");
  // finished: reopened with every gate closed
  put("tasks/done/T-0312.md", "---\nid: T-0312\ntitle: x\nagent: lead\nstatus: done\n---\nAsked.\n");
  reopenTask(join(DATA, "tasks/done/T-0312.md"), "What is the status? Do not merge anything.");
  expect(gated("tasks/inbox/T-0312.md")).toContain("Bash(gh pr merge:*)");
});

test("a task's detail names the cards it asked", () => {
  put("decisions/closed/D-0301.md", "---\nid: D-0301\ntask: T-0302\nquestion: 合并吗？\n---\n");
  put("decisions/closed/D-0303.md", "---\nid: D-0303\ntask: T-0100\nquestion: 别的\n---\n");
  put("tasks/done/T-0302.md", "---\nid: T-0302\ntitle: x\nagent: lead\n---\nAsked.\n");
  expect(taskInfo(store().st, "T-0302")?.decisions).toEqual(["D-0301"]);
});

test("list_routines: a change made in settings wins over config.toml, as it does for the scheduler", () => {
  const files: Record<string, string> = {
    "config.toml": `[[routine]]\nname = "macos-check"\nevery = "1d"\nagent = "lead"\nprompt = "x"\n\n[[routine]]\nname = "nightly"\nevery = "1d"\nagent = "lead"\nenabled = false\nprompt = "y"\n`,
    "settings.json": JSON.stringify({ routines: { "macos-check": { enabled: false }, nightly: { enabled: true, every: "2h" } } }),
  };
  const rows = listRoutines({ read: (p: string) => (files[p] === undefined ? undefined : { text: files[p] }) } as any);
  expect(rows.map((r) => [r.name, r.enabled, r.every])).toEqual([["macos-check", false, "1d"], ["nightly", true, "2h"]]);
});

import { followUpTarget } from "../src/brain";
test("followUpTarget: terse follow-up continues the task the channel was just about", () => {
  const now = Date.parse("2026-11-07T05:32:00Z");
  const ev = [{ from: "Tripitaka", ts: "2026-11-07T05:30:00Z", ref: "T-0738" }, { from: "hub", ts: "2026-11-07T05:30:30Z", ref: "D-0148" }, { from: "owner", ts: "2026-11-07T05:31:00Z" }];
  expect(followUpTarget("给我中文", ev, now)).toBe("T-0738");
  expect(followUpTarget("应该转发他的 tweet 来回复", ev, now)).toBe("T-0738");
  expect(followUpTarget("Noop 的流程，像这种连续的，并没有开始的，不能作为独立任务在任务列表列表显示，不然太繁琐了。改掉这个流程", ev, now)).toBeUndefined();
  expect(followUpTarget("给我中文", ev, now + 20 * 60_000)).toBeUndefined();
  expect(followUpTarget("给我中文", [], now)).toBeUndefined();
});
