// The shared tool layer (cloud/src/tools.ts) over the local data repo, and the chat brain's loop with a scripted model.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Model, context, dataActs, localStore, reopenTask, parseTurn, think } from "../src/brain";
import { DATA, matches, readDoc } from "../src/core";
import { runTool, taskInfo, toolsFor, TOOLS, type WriteOp, listRoutines } from "../cloud/src/tools";

const put = (p: string, s: string) => { mkdirSync(dirname(join(DATA, p)), { recursive: true }); writeFileSync(join(DATA, p), s); };
put("tasks/active/T-0184.md", "---\nid: T-0184\ntitle: noop: MCP server\nagent: lead\nclaimed_by: h1\nrepo: huacnlee/noop\n---\nBuild it.\n");
put("tasks/inbox/T-0190.md", "---\nid: T-0190\ntitle: Review nsh#812\nagent: reviewer\npriority: normal\n---\nReview.\n");
put("tasks/done/T-0100.md", "---\nid: T-0100\ntitle: Fix typo\nagent: lead\n---\ndone\n");
put("decisions/open/D-0099.md", "---\nid: D-0099\nquestion: Merge it?\nrecommendation: A\noptions: A: Merge | B: Wait\n---\n## Context\nctx\n");
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
  expect((await r("search", { query: "Merge it" })).results.map((x: any) => x.id)).toEqual(["D-0099"]);
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
    'Sure:\n```json\n{"calls":[{"tool":"amend_task","args":{"id":"T-0184","text":"also add tests"}}],"reply":"T-0184 tests already pass, and I added the new test request to it."}\n```',
  ]);
  const posted: [string, string | undefined][] = [];
  const out = await think({ text: "How is T-0184 going? Also add tests", chat: ["lead: T-0184 started"] }, st, model, (r, ref) => { posted.push([r, ref]); expect(did).toEqual([]); });
  expect(posted).toEqual([["T-0184 tests already pass, and I added the new test request to it.", "T-0184"]]);
  expect(out.calls.map((c) => [c.tool, c.ok])).toEqual([["get_task", true], ["amend_task", true]]);
  expect(model.seen[1]).toContain("T-0184 tests pass"); // the tool result went back to the model
  expect(did).toEqual([{ tool: "amend_task", id: "T-0184", text: "also add tests" }]);
  expect(out.rounds).toBe(2);
});

test("brain: nothing to say → nothing posted; invalid writes go back to the model", async () => {
  const { st, did } = store();
  const posted: string[] = [];
  await think({ text: "ok" }, st, scripted(['{"calls":[],"reply":""}']), (r) => posted.push(r));
  expect(posted).toEqual([]);
  const m = scripted(['{"calls":[{"tool":"amend_task","args":{"id":"T-0999","text":"change it again"}}],"reply":"ok"}',
    '{"calls":[{"tool":"create_task","args":{"title":"Redo typo fix","follows":"T-0100"}}],"reply":"T-0100 is already finished; I opened a new task to continue."}']);
  const out = await think({ text: "T-0100 change it again" }, st, m, (r) => posted.push(r));
  expect(m.seen[1]).toContain("cannot be continued");
  expect(posted).toEqual(["T-0100 is already finished; I opened a new task to continue."]);
  expect(did.map((d) => d.tool)).toEqual(["create_task"]);
  expect(out.calls.map((c) => [c.tool, c.ok])).toEqual([["amend_task", false], ["create_task", true]]);
});

test("context: open work, decisions, relevant memory, channel and reply target", () => {
  const { st } = store();
  const c = context(st, { text: "dark mode is unbalanced", replyTo: "T-0184", answered: "D-0099", chat: ["owner: hi"] });
  for (const s of ["T-0184 [active, lead on h1] noop: MCP server", "D-0099: Merge it?", "memory/taste.md: - Dark mode must be balanced.", "owner: hi",
    "reply to the team's message about T-0184", "answered D-0099"]) expect(c).toContain(s);
  expect(parseTurn('noise {"reply":"hi"} noise')).toEqual({ calls: [], reply: "hi" });
  expect(parseTurn("no json")).toBeNull();
});

test("a finished task reopens under its own id, with its runs as context", () => {
  put("tasks/done/T-0300.md", "---\nid: T-0300\ntitle: Ship it\nagent: lead\nfinished: 2026-11-01\nstatus: done\nclaimed_by: pc\n---\nAsked.\n\n## Run 2026-11-01 · pc · claude\n**done** — shipped\n");
  reopenTask(join(DATA, "tasks/done/T-0300.md"), "no\nchange it again");
  expect(existsSync(join(DATA, "tasks/done/T-0300.md"))).toBe(false);
  const t = readFileSync(join(DATA, "tasks/inbox/T-0300.md"), "utf8");
  expect(t).toContain("**done** — shipped");
  expect(t).toContain("> no\n> change it again");
  expect(t).not.toMatch(/^(finished|status|claimed_by):/m);
});

test("a task's detail names the cards it asked", () => {
  put("decisions/closed/D-0301.md", "---\nid: D-0301\ntask: T-0302\nquestion: Merge it?\n---\n");
  put("decisions/closed/D-0303.md", "---\nid: D-0303\ntask: T-0100\nquestion: Something else\n---\n");
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


test("queued placement can move a Linux task to Mac without losing other requirements or task history", async () => {
  put("tasks/inbox/T-0927.md", "---\nid: T-0927\ntitle: Review\nagent: reviewer\nrequires: os:linux,docker\nhost: old-linux\nparked: yesterday\n---\nReview the PR.\n\n## Run earlier\nKeep history.\n");
  const { st } = store();
  const { taskView } = await import("../src/server");
  expect(taskInfo(st, "T-0927")).toMatchObject({ state: "nohost", needs: "os:linux,docker,host:old-linux" });
  put("tasks/inbox/T-0928.md", "---\nid: T-0928\nagent: reviewer\nhost: old-linux\nparked: yesterday\n---\nReview.\n");
  expect(taskView(join(DATA, "tasks/inbox/T-0928.md"), "inbox", [])).toMatchObject({ state: "nohost", needs: "host:old-linux" });
  expect(taskInfo(st, "T-0928")).toMatchObject({ state: "nohost", needs: "host:old-linux" });
  const args = { id: "T-0927", requires: "os:macos,docker", host: "any", cli: "claude", agent: "reviewer", priority: "high" };
  expect((await runTool(st, "configure_task", args)).ok).toBe(true);
  const { meta, body } = readDoc(join(DATA, "tasks/inbox/T-0927.md"));
  expect(meta.parked).toBeUndefined();
  expect(meta.planned).toBeTruthy();
  expect(meta.requires).toBe("os:macos,docker");
  expect(body).toContain("Keep history.");
  expect(matches(meta, ["os:macos", "docker"])).toBe(true);
  expect(matches(meta, ["os:macos"])).toBe(false);
  expect(taskInfo(st, args.id)).toMatchObject({ requires: "os:macos,docker", target_host: "any", configured_cli: "claude", priority: "high", state: "inbox" });
  for (const patch of [{ id: "T-0184" }, { agent: "../lead" }, { host: "mac\nrequires: " }, { requires: "os:macos\n" }, { cli: "shell" }, { priority: "asap" }]) {
    expect((await runTool(st, "configure_task", { ...args, ...patch })).ok).toBe(false);
  }
});


test("advanced task settings bind the selected project's machine and toolchain without changing the request", async () => {
  put("tasks/inbox/T-0930.md", "---\nid: T-0930\ntitle: Review\nagent: reviewer\nrequires: os:linux\n---\nOriginal request and runs stay here.\n");
  put("projects/remote.md", "---\nname: Remote\nhost: mac\npath: /worker/project\nrequires: cli:cargo\n---\nProject rules.\n");
  const { st } = store();
  const args = { id: "T-0930", host: "mac", agent: "reviewer", cli: "auto", priority: "normal", requires: "os:macos", project: "remote", title: "Review on Mac", prefer: "gpu, gpu", weight: "heavy" };
  expect(await runTool(st, "configure_task", args)).toMatchObject({ ok: true, data: { ok: true } });
  const file = join(DATA, "tasks/inbox/T-0930.md"), { meta, body } = readDoc(file);
  expect(meta).toMatchObject({ title: "Review on Mac", project: "remote", repo: "/worker/project", host: "mac", requires: "os:macos,cli:cargo", prefer: "gpu", weight: "heavy" });
  expect(body.trim()).toBe("Original request and runs stay here.");
  expect(taskInfo(st, args.id)).toMatchObject({ project: "remote", prefer: "gpu", weight: "heavy", repo: "/worker/project" });
  for (const patch of [{ host: "linux" }, { title: "bad\npriority: urgent" }, { prefer: "gpu; shell" }, { weight: "huge" }, { project: "../config" }])
    expect((await runTool(st, "configure_task", { ...args, ...patch })).ok).toBe(false);
  expect(await runTool(st, "configure_task", { ...args, project: "", host: "any", requires: "", prefer: "", weight: "normal" })).toMatchObject({ ok: true, data: { ok: true } });
  expect(readDoc(file).meta).toMatchObject({ project: "", repo: "", host: "any", requires: "", prefer: "", weight: "normal" });
});

const syncTask = "tasks/inbox/T-0940.md", syncMemory = "memory/sync-coverage.md";
const syncPlacement = { tool: "configure_task" as const, id: "T-0940", host: "any", agent: "lead", cli: "auto", priority: "high" as const, requires: "os:macos" };
const syncOps: WriteOp[] = [
  { tool: "set_priority", id: "T-0940", priority: "high" }, { tool: "reassign_task", id: "T-0940", agent: "lead" }, syncPlacement,
  { tool: "remember", file: syncMemory, text: "Keep the result clear." }, { tool: "edit_memory", file: syncMemory, match: "Old rule", text: "New rule" },
];
function syncStore(io: { pull: () => Promise<boolean>; push: (summary: string) => Promise<boolean> }) {
  put(syncTask, "---\nid: T-0940\ntitle: Review\nagent: reviewer\nrequires: os:linux\n---\nOriginal request and previous runs.\n");
  put(syncMemory, "# Memory\n- Old rule\n");
  put("agents/lead/profile.md", "# Lead\n"); put("agents/reviewer/profile.md", "# Reviewer\n");
  mkdirSync(join(DATA, "journal"), { recursive: true });
  return localStore({ acts: dataActs("pc", io), status: () => ({}), feed: () => [] });
}

test("task and memory writes never mutate stale data after a failed refresh", async () => {
  for (const pull of [async () => false, async () => { throw new Error("offline"); }]) for (const op of syncOps) {
    let pushes = 0;
    const st = syncStore({ pull, push: async () => { pushes++; return true; } });
    const task = readFileSync(join(DATA, syncTask), "utf8"), memory = readFileSync(join(DATA, syncMemory), "utf8");
    const result = await runTool(st, op.tool, op);
    expect(result).toMatchObject({ ok: false, data: { ok: false, status: 503 } });
    expect(readFileSync(join(DATA, syncTask), "utf8")).toBe(task);
    expect(readFileSync(join(DATA, syncMemory), "utf8")).toBe(memory); expect(pushes).toBe(0);
  }
});

test("unconfirmed task and memory sync retains each local identity and reports a partial result", async () => {
  for (const push of [async () => false, async () => { throw new Error("offline"); }]) for (const op of syncOps) {
    const st = syncStore({ pull: async () => true, push });
    const result = await runTool(st, op.tool, op);
    expect(result).toMatchObject({ ok: false, data: { ok: false, status: 503, saved_locally: true, ...("id" in op ? { id: op.id } : "file" in op ? { file: op.file } : {}) } });
    expect(result.ok ? "" : result.error).toContain("Saved on the main machine");
    if (op.tool === "configure_task") {
      const task = readDoc(join(DATA, syncTask));
      expect(task.meta).toMatchObject({ id: "T-0940", requires: "os:macos" });
      expect(task.body).toBe("Original request and previous runs.\n");
    }
  }
});

test("task configuration returns HTTP503 for failed refresh or partial sync and safely retries the same task", async () => {
  const { recordRequest, setApplyOp } = await import("../src/server");
  let refreshed = false, synced = false;
  const st = syncStore({ pull: async () => refreshed, push: async () => synced });
  setApplyOp((op) => runTool(st, op.tool, op));
  const request = () => recordRequest(new Request("http://hub/api/tasks/configure", { method: "POST", body: JSON.stringify(syncPlacement) }));
  try {
    const stale = await request(); expect(stale.status).toBe(503);
    expect(readDoc(join(DATA, syncTask)).meta.requires).toBe("os:linux");
    refreshed = true;
    const partial = await request(); expect(partial.status).toBe(503);
    expect(await partial.json()).toMatchObject({ ok: false, id: "T-0940", saved_locally: true, data: { status: 503, saved_locally: true } });
    synced = true;
    const retry = await request(); expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, data: { ok: true, id: "T-0940" } });
    expect(readDoc(join(DATA, syncTask)).body).toBe("Original request and previous runs.\n");
  } finally { setApplyOp(async () => null); }
});

test("an unconfirmed chat write posts an explicit correction and records failure", async () => {
  const st = syncStore({ pull: async () => true, push: async () => false });
  const replies: [string, string | undefined][] = [];
  const out = await think({ text: "Move T-0940 to Mac" }, st,
    scripted([JSON.stringify({ calls: [{ tool: "configure_task", args: syncPlacement }], reply: "Moved it to Mac." })]),
    (text, ref) => replies.push([text, ref]));
  expect(replies[0]).toEqual(["Moved it to Mac.", "T-0940"]);
  expect(replies[1][0]).toContain("not confirmed"); expect(replies[1][0]).toContain("Saved on the main machine"); expect(replies[1][1]).toBe("T-0940");
  expect(out.calls).toMatchObject([{ tool: "configure_task", ok: false }]);
  expect(out.reply).toContain("not confirmed");
});
