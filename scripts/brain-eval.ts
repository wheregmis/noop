#!/usr/bin/env bun
// Scripted eval of the chat brain against the real model (local `claude` CLI, Haiku by default).
//   bun scripts/brain-eval.ts [--model claude-haiku-5-5] [--json out.json]
// Runs ~16 representative owner messages against a fixture data repo (tasks, decisions, agent profiles; memory copied
// read-only from ~/.agent-hub/data/memory when present). Writes are recorded, never performed. Prints a table with the
// chosen tool calls, pass/fail and the latency to the first reply (warm process, as on the daemon).
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeModel, SYSTEM, localStore, think, type BrainOut } from "../src/brain";
import type { WriteOp } from "../cloud/src/tools";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg("--model", "claude-haiku-5-5");
const root = mkdtempSync(join(tmpdir(), "brain-eval-"));
const put = (p: string, s: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
const real = join(homedir(), ".agent-hub", "data");
if (existsSync(join(real, "memory"))) cpSync(join(real, "memory"), join(root, "memory"), { recursive: true });
for (const a of ["lead", "reviewer", "release-manager", "rust-maintainer", "ops-watcher", "dispatcher", "apprentice"]) {
  const f = join(real, "agents", a, "profile.md");
  put(`agents/${a}/profile.md`, existsSync(f) ? await Bun.file(f).text() : `# ${a}\n`);
}
const task = (state: string, id: string, title: string, meta: Record<string, string> = {}, body = "") =>
  put(`tasks/${state}/${id}.md`, `---\nid: ${id}\ntitle: ${title}\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body || title}\n`);
task("active", "T-0203", "noop: chat brain = fast-model agent over noop's MCP tools", { agent: "lead", claimed_by: "huacnlee-omarchy-lb", repo: "huacnlee/noop", priority: "high" });
task("active", "T-0204", "noop app: voice input stop button on iOS", { agent: "lead", claimed_by: "macbook", repo: "huacnlee/noop" });
task("inbox", "T-0207", "Review nsh#831 (Select focus ring)", { agent: "reviewer", repo: "longbridge/nsh", priority: "normal" });
task("done", "T-0186", "noop: router writes the chat acknowledgement", { agent: "lead", repo: "huacnlee/noop" }, "Done: the router model writes a one-line ack.");
task("done", "T-0198", "gpui-kit v0.9.0 release notes", { agent: "release-manager", repo: "longbridge/gpui-kit" });
put("decisions/open/D-0030.md", "---\nid: D-0030\ntask: T-0205\nquestion: Merge nsh #830 (iOS keyboard sync)?\nrecommendation: A\noptions: A: Merge — verified on iOS/Android | B: Don't merge yet — wait for another Android test\n---\n## Context\nreviewer verified it.\n");
put("journal/2026-11-03.md", "- 09:10 [huacnlee-omarchy-lb] ▶️ T-0203 started\n- 09:40 [macbook] ▶️ T-0204 started\n- 08:00 [huacnlee-omarchy-lb] ✅ T-0198 done: release notes published\n");
put("config.toml", `[[routine]]\nname = "triage-inbound"\nevery = "30m"\nagent = "dispatcher"\nprompt = "Scan inbound signals"\n\n[[routine]]\nname = "pr-review"\nevery = "30m"\nagent = "reviewer"\nprompt = "Review open PRs on core repos"\n`);

const feed = [
  { id: "e1", ts: "2026-11-03T09:41:00Z", from: "lead", kind: "notice", text: "T-0204: stop button wired, testing on the iOS simulator" },
  { id: "e2", ts: "2026-11-03T09:50:00Z", from: "lead", kind: "notice", text: "T-0203: shared tool module done, writing the brain loop" },
];
const status = () => ({ hosts: [{ host: "huacnlee-omarchy-lb", online: true, running: [{ id: "T-0203" }] }, { host: "macbook", online: true, running: [{ id: "T-0204" }] }],
  decisions: [{ id: "D-0030", question: "Merge nsh #830?" }], tasks: { active: 2, inbox: 1 } });
let did: WriteOp[] = [];
const rec = async (op: any) => { did.push(op); return { ok: true, id: op.id ?? "T-0300" }; };
const st = localStore({ root, status, feed: () => feed,
  acts: { create_task: rec, amend_task: rec, cancel_task: rec, set_priority: rec, reassign_task: rec, remember: rec, edit_memory: rec, answer_decision: rec } });

type Case = { name: string; text: string; chat?: string[]; replyTo?: string; answered?: string;
  expect: (o: BrainOut, w: WriteOp[]) => boolean; want: string };
const W = (w: WriteOp[], tool: string) => w.filter((x) => x.tool === tool);
const noWrites = (_: BrainOut, w: WriteOp[]) => w.length === 0;
const cases: Case[] = [
  { name: "greeting", text: "morning", want: "reply, no writes", expect: (o, w) => noWrites(o, w) },
  { name: "thanks", text: "great work, thanks", want: "no writes", expect: noWrites },
  { name: "bare ok", text: "ok", want: "no writes, no reply", expect: (o, w) => noWrites(o, w) && !o.reply },
  { name: "status: what's running", text: "what's running right now?", want: "reply mentions T-0203/T-0204, no writes", expect: (o, w) => noWrites(o, w) && /T-0203|T-0204|chat brain|voice/.test(o.reply) },
  { name: "status: one task", text: "how is T-0204 going", want: "reply about T-0204, no writes", expect: (o, w) => noWrites(o, w) && o.reply.length > 0 },
  { name: "remember (shared)", text: "Remember: from now on, put PR screenshots in the PR description", want: "remember", expect: (_, w) => W(w, "remember").length === 1 && W(w, "create_task").length === 0 },
  { name: "remember (one agent)", text: "From now on, keep the auto-generated New Contributors section from GitHub in release notes; have release-manager remember this", want: "remember → agents/release-manager/memory.md",
    expect: (_, w) => W(w, "remember").some((x: any) => x.file === "agents/release-manager/memory.md") },
  { name: "delete a memory", text: "The Restrained radii entry in memory/taste.md is wrong, delete it", want: "edit_memory or read_memory first, no remember", expect: (_, w) => W(w, "remember").length === 0 && W(w, "create_task").length === 0 },
  { name: "amend running task", text: "T-0204: also verify it on Android", want: "amend_task T-0204", expect: (_, w) => W(w, "amend_task").some((x: any) => x.id === "T-0204") && W(w, "create_task").length === 0 },
  { name: "amend by context", text: "the voice one: make the stop button square", chat: ["lead: T-0204: stop button wired, testing on the iOS simulator"], want: "amend_task T-0204",
    expect: (_, w) => W(w, "amend_task").some((x: any) => x.id === "T-0204") },
  { name: "new dev request", text: "add a filter-by-file-type feature to disktree", want: "create_task (disktree)", expect: (_, w) => W(w, "create_task").length === 1 && W(w, "amend_task").length === 0 },
  { name: "correct finished task", text: "no, the reply is too long, one sentence is enough", chat: ["lead: T-0186 done: the router model writes a one-line ack", "hub: ok, I'll wire up MCP and show you when it's done."],
    want: "create_task follows T-0186 (or amend T-0203)", expect: (_, w) => W(w, "create_task").some((x: any) => x.follows === "T-0186") || W(w, "amend_task").some((x: any) => x.id === "T-0203") },
  { name: "decision answer in words", text: "nsh #830 is fine to merge", want: "answer_decision D-0030 A", expect: (_, w) => W(w, "answer_decision").some((x: any) => x.id === "D-0030" && /^A\b|merge/i.test(x.answer)) },
  { name: "decision amend", text: "wait, let's hold off until Android testing is done", answered: "D-0030", want: "answer_decision D-0030 B", expect: (_, w) => W(w, "answer_decision").some((x: any) => x.id === "D-0030" && /^B|Android|wait|hold/i.test(x.answer)) },
  { name: "cancel", text: "T-0207 no need to do it", want: "cancel_task T-0207", expect: (_, w) => W(w, "cancel_task").some((x: any) => x.id === "T-0207") },
  { name: "reprioritise", text: "prioritise the nsh#831 review", want: "set_priority T-0207 urgent|high", expect: (_, w) => W(w, "set_priority").some((x: any) => x.id === "T-0207" && /urgent|high/.test(x.priority)) },
  { name: "reassign", text: "give T-0207 to lead", want: "reassign_task T-0207 lead", expect: (_, w) => W(w, "reassign_task").some((x: any) => x.id === "T-0207" && x.agent === "lead") },
  { name: "routines question", text: "which scheduled routines do we have?", want: "reply lists routines, no writes", expect: (o, w) => noWrites(o, w) && /pr-review|triage/.test(o.reply) },
];

const model = new ClaudeModel(MODEL);
model.warm(SYSTEM);
await Bun.sleep(4000); // the daemon spawns the next process ahead of time; let this one be ready like it would be
const rows: any[] = [];
for (const c of cases) {
  did = [];
  const t0 = Date.now();
  let posted: string | null = null, firstMs: number | undefined;
  const o = await think({ text: c.text, chat: c.chat, replyTo: c.replyTo, answered: c.answered }, st, model, (r) => { posted = r; firstMs = Date.now() - t0; })
    .catch((e) => ({ reply: "", calls: [], rounds: 0, ms: { model: [], total: Date.now() - t0 }, error: String(e) } as any));
  const pass = !o.error && c.expect(o, did);
  rows.push({ case: c.name, text: c.text, want: c.want, pass, calls: o.calls.map((x: any) => `${x.tool}${x.ok ? "" : "✗"}(${Object.values(x.args ?? {}).map((v) => String(v).slice(0, 40)).join(", ")})`),
    reply: posted ?? "", first_reply_ms: firstMs, total_ms: o.ms.total, model_ms: o.ms.model, rounds: o.rounds, error: o.error });
  console.error(`${pass ? "PASS" : "FAIL"} ${c.name}: ${rows.at(-1).calls.join("; ") || "-"} | ${posted ?? "(no reply)"} | first ${firstMs ?? "-"}ms total ${o.ms.total}ms`);
  await Bun.sleep(2500); // the next warm process is spawned meanwhile, as between two owner messages
}
const firsts = rows.map((r) => r.first_reply_ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
const q = (p: number) => firsts[Math.min(firsts.length - 1, Math.floor(p * firsts.length))];
const summary = { model: MODEL, passed: rows.filter((r) => r.pass).length, total: rows.length, first_reply_ms: { p50: q(0.5), p90: q(0.9), max: firsts.at(-1) },
  single_round_model_ms_p50: (() => { const m = rows.filter((r) => r.rounds === 1).map((r) => r.model_ms[0]).sort((a, b) => a - b); return m[Math.floor(m.length / 2)]; })() };
console.log(JSON.stringify(summary));
console.log("\n| # | message | expected | chosen calls | reply | first reply | ok |\n|---|---|---|---|---|---|---|");
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.text} | ${r.want} | ${r.calls.join("<br>") || "—"} | ${(r.reply || "(none)").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 120)} | ${r.first_reply_ms ?? "—"} ms (${r.rounds}r) | ${r.pass ? "✅" : "❌"} |`));
const out = arg("--json");
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
process.exit(0);
