// Builds the prompt for an agent, runs Claude Code / Codex headless, parses the structured result.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Cfg, P, ROOT, agentActivity, agentName, precedents, readAll, readIf, recentJournal, signature,
} from "./core";
import { enabledProviders, providerAvailable } from "./providers";
import { accountEnv, pickAccount, markAccountSuccess } from "./accounts";
import { claudeDisallowed } from "./gates";
import { planSection } from "./plans";
import { listProjects } from "./projects";
import { activeClaim, bindTaskProcess, stopAgentProcess, taskRunCurrent, type TaskRun } from "./task-runs";

export type Result = {
  status: "done" | "needs_decision" | "failed" | "delegated" | "waiting";
  wait_minutes?: number;
  waiting_on?: string;
  wait_check?: string;
  summary: string;
  question?: string;
  options?: string[];
  recommendation?: string;
  lessons?: string[];
  attachments?: string[];
  followups?: { title: string; body?: string; agent?: string; priority?: string; repo?: string; requires?: string; host?: string }[];
};

const RESULT_SPEC = `Finish the work, then end your final reply with EXACTLY one fenced \`\`\`json block:
{
  "status": "done" | "needs_decision" | "failed" | "delegated" | "waiting",   // delegated = you split the work into followups and want to be woken up to consolidate when they finish; waiting = see below
  "waiting_on": "waiting only: what you wait for and how to check it, e.g. CI run https://github.com/o/r/actions/runs/123 (gh run view 123)",
  "wait_minutes": 15,   // waiting only: latest time to wake you to check again (5-120)
  "wait_check": "waiting only: a quick read-only shell command whose exit code changes when the wait is over, e.g. gh pr checks 123 -R o/r (exits 8 while pending); the daemon runs it every few minutes and wakes you as soon as it changes",
  "summary": "1-3 sentences: what you did / found (links to PRs, commits, files). For needs_decision this is all the owner reads before choosing: say what the PR / change does and what is at stake, the facts they need to choose (not why it needs them, they know)",
  "question": "needs_decision only: one short sentence (under 30 characters) naming what to decide, e.g. Merge PR #97 now?; name PRs/issues with their full URL in summary and options",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "lessons": ["durable lesson for your own memory (optional)"],
  "attachments": ["/abs/path/screenshot.png", "/abs/path/recording.mp4"],   // optional: shown to the owner with the message
  "followups": [{"title": "...", "body": "...", "agent": "<agent id>", "priority": "normal", "difficulty": "hard if it needs deep engineering/design work", "requires": "os:macos when it needs macOS/iOS/Xcode (os:windows for Windows); omit otherwise"}]
}
Write summary, question and options in the owner's language (English unless the owner writes otherwise), plain text, no emoji; keep identifiers, links and code as they are.
Only use needs_decision after doing all preparation that does not depend on the answer.
Never sit idle waiting on something slow (GitHub Actions/CI, a release, a review, a deploy): if the next step needs it, return "waiting" with waiting_on, wait_minutes and wait_check.
Before returning "waiting", do every part of the task that does not depend on the condition (other platforms, docs, tests, screenshots, the next PR): implement and let CI verify rather than wait for a host. Waiting on another PR to merge is not a reason to stop: build on its branch or merge it locally, and note the dependency.
The machine then runs other work and wakes you later with your notes; check the condition first, then continue from where you left off.`;

export function buildPrompt(meta: Record<string, string>, body: string, cfg: Cfg, resourceNote = ""): string {
  const agent = meta.agent || "lead";
  const host = meta.claimed_by || "?";
  return `You are **${agentName(agent)}**, a permanent member of ${cfg.owner?.name ?? "the owner"}'s AI agent fleet, running headless on host \`${host}\`.
The fleet coordinates through the shared hub folder at ${ROOT} (tasks/, journal/, decisions/, agents/). Read it when you need context; you do not message other agents — you leave traces (commits in project repos, journal lines, follow-up tasks) that they pick up.
The hub folder is not a git repository: files you write there (reports/, memory) are synced to the cloud by the daemon after your run. Never git add/commit them, and never report a task as failed because the hub has no git metadata.

# Your profile
${readIf(P("agents", agent, "profile.md"))}

# Your memory
${readIf(P("agents", agent, "memory.md"), 8000) || "(empty)"}

# Fleet-wide policy
${readAll(P("policies"))}

# Owner profile & principles
${readAll(P("memory"))}

# Owner decision precedents (follow them; never re-ask a decided question)
${precedents(25) || "(none yet)"}

# Recent fleet journal
${recentJournal() || "(empty)"}

# Fleet roster (for follow-up routing)
${rosterLine()}

# External signature (MANDATORY)
Anything you post outside the hub — GitHub PR/issue/review comments, PR descriptions, Slack, Discord, email, OKR entries — must end with this exact line, after a blank line:
${signature(agent, host, cfg)}
Git commits you create must carry the trailer:  Agent: ${agent}

# Resource budget
${resourceNote}
${projectsSection(meta)}${planSection(meta)}
# Task ${meta.id}: ${meta.title}
Working directory: ${meta.repo || ROOT}   Scratch space (checkouts, worktrees, build targets): ~/.agent-hub/work — never inside the hub folder ${ROOT}, which syncs to the cloud   Host capabilities: ${meta.host_caps ?? ""}
Priority: ${meta.priority}   Source: ${meta.source}

${body}

${RESULT_SPEC}`;
}

/** The projects the team works on, and the one this task belongs to with the owner's instructions for it. */
function projectsSection(meta: Record<string, string>): string {
  const all = listProjects();
  if (!all.length) return "";
  const mine = all.find((p) => p.id === meta.project);
  return `
# Connected projects (these replace any project list in memory/projects.md)
${all.map((p) => `- ${p.name}: ${p.path}${p.repo ? ` (${p.repo})` : ""}, on ${p.host}`).join("\n")}
${mine ? `
# This task's project: ${mine.name}
${mine.exists === false ? `Its folder ${mine.path} is missing on this machine. Don't work anywhere else instead: return "failed" and say so.\n` : mine.exists === null ? `Its folder is on ${mine.host}; it has not been checked on this machine. Run this project's work on ${mine.host}.\n` : ""}${mine.instructions ? `The owner's instructions for this project:\n${mine.instructions}\n` : ""}` : ""}`;
}

function rosterLine(): string {
  return readdirSync(P("agents"), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => {
      const prof = readIf(P("agents", d.name, "profile.md"), 100000);
      const first = prof.split("\n").find((l) => l.startsWith("# ")) ?? d.name;
      return `- \`${d.name}\` ${agentName(d.name)}: ${first.replace(/^# /, "")}`;
    }).join("\n");
}

/** workspace-write only covers the cwd and /tmp; agents also need project checkouts, scratch, the hub and cargo's caches. */
export function codexWritableDirs(home = homedir()): string[] {
  const dirs = [join(home, "work"), join(home, ".noop", "work"), join(home, ".agent-hub", "work"), ROOT, join(home, ".cargo")];
  const real = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  return [...new Set(real)];
}

export function cliCommand(cli: string, cfg: Cfg, gateOverride = false): string[] {
  const c = cfg.clis?.[cli] ?? {};
  if (Array.isArray(c.command)) return c.command;
  if (cli === "claude") {
    const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", c.permission_mode ?? "bypassPermissions"];
    cmd.push("--model", c.model ?? "claude-opus-5-5");
    // the agent signature is the only attribution; drop Claude Code's own "Generated with" / co-author lines
    cmd.push("--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false }));
    const deny = claudeDisallowed(cfg, gateOverride);
    if (deny.length) cmd.push("--disallowedTools", ...deny);
    return cmd;
  }
  if (cli === "hermes") return ["hermes", "chat", "--query-file", "-", "--quiet", "--source", "noop", ...(c.model ? ["--model", c.model] : [])];
  if (cli === "codex") {
    // non-interactive: workspace-write sandbox with network, never ask for approval
    const cmd = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true"];
    for (const dir of codexWritableDirs()) cmd.push("--add-dir", dir);
    if (c.model) cmd.push("-m", c.model);
    return [...cmd, "-"];
  }
  throw new Error(`unknown cli ${cli}`);
}

const pidFile = (tid: string) => P("logs", "pids", `${tid}.pid`);
function processBirth(pid: number): string {
  try {
    const cmd = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`]
      : ["/bin/ps", "-o", "lstart=", "-p", String(pid)];
    return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  } catch { return ""; }
}
function notePid(tid: string, pid: number, run: TaskRun) {
  mkdirSync(P("logs", "pids"), { recursive: true });
  const birth = processBirth(pid);
  writeFileSync(pidFile(tid), JSON.stringify({ pid, run_id: run.run_id, birth, group: process.platform !== "win32" }));
}
/**
 * A daemon that died hard can leave its agent running. Before the task runs again, stop that agent, or two would edit one
 * folder at once. Only a process that is still an agent: its pid may have been reused since. Returns whether one was stopped.
 */
export async function stopOrphanedAgent(tid: string, expectedRunId?: string): Promise<boolean> {
  if (!existsSync(pidFile(tid))) return false;
  const raw = readFileSync(pidFile(tid), "utf8");
  let record: { pid: number; run_id: string; birth: string; group: boolean } | null = null;
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") record = parsed; } catch { /* Older daemons recorded only the pid. */ }
  if (record && expectedRunId !== record.run_id || !record && expectedRunId) throw new Error(`The saved process identity for ${tid} does not match its active run; recovery was halted`);
  const pid = record?.pid ?? Number(raw);
  const isAgent = () => {
    try { return /\b(claude|codex|hermes)\b/.test(Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(pid)]).stdout.toString()); } catch { return false; } // /bin/ps: launchd's PATH is short
  };
  if (record) {
    const birth = processBirth(pid);
    if (!birth) throw new Error(`The interrupted process tree for ${tid} cannot be verified after its parent exited; recovery was halted`);
    if (!record.birth) throw new Error(`The saved process identity for ${tid} cannot be verified; recovery was halted`);
    if (!pid || birth !== record.birth) throw new Error(`The saved process identity for ${tid} cannot be verified; recovery was halted`);
    const gone = () => !processBirth(pid);
    const proc = { pid, kill: (sig?: number | NodeJS.Signals) => process.kill(pid, sig), get exitCode() { return gone() ? 0 : null; }, exited: Promise.resolve(0) };
    if (!await stopAgentProcess(proc)) throw new Error(`Could not confirm the old agent for ${tid} stopped; startup recovery was halted`);
    rmSync(pidFile(tid), { force: true });
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isAgent()) throw new Error(`The legacy process identity for ${tid} cannot be verified; recovery was halted`);
  if (!await stopAgentProcess({ pid, kill: (sig) => process.kill(pid, sig), exitCode: null, exited: Promise.resolve(0) }))
    throw new Error(`Could not confirm the old agent for ${tid} stopped; startup recovery was halted`);
  rmSync(pidFile(tid), { force: true });
  return true;
}

/** Running agent processes by task id (so the owner can cancel one). */
export const agentProcs = new Map<string, { kill: (sig?: number | NodeJS.Signals) => void }>();

/** One line saying what a tool call does ("gh pr checks 814 -R owner/repo", "read src/cli.ts"), for "recent activity". */
function toolStep(name: string, input: any): string {
  const i = input ?? {};
  const v = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || "";
  return `${name}${v ? ` · ${String(v).split("\n")[0].slice(0, 120)}` : ""}`;
}

/** Marker runAgent appends when it stopped a run that went quiet (see stall_minutes). */
export const STALLED = "\n[stalled]";

export async function runAgent(cli: string, prompt: string, cwd: string, cfg: Cfg, logFile: string, gateOverride = false,
  extraEnv: Record<string, string> = {}, run?: TaskRun): Promise<string> {
  if (run && !taskRunCurrent(run)) return "";
  const cmd = cliCommand(cli, cfg, gateOverride);
  const timeoutMs = (cfg.clis?.timeout_minutes ?? 60) * 60_000;
  const stallMs = (cfg.clis?.stall_minutes ?? 20) * 60_000;
  const dir = cwd.replace(/^~/, homedir());
  const proc = Bun.spawn(cmd, {
    detached: process.platform !== "win32",
    cwd: existsSync(dir) ? dir : ROOT, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe",
    // Claude -p stops background subagents 10 min after the last turn; our own run limit bounds the run instead
    env: { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...extraEnv, HUB_DATA: ROOT },
  });
  const tid = run?.id;
  if (run) bindTaskProcess(run, proc);
  if (tid && run) {
    agentProcs.set(tid, proc);
    try { notePid(tid, proc.pid, run); }
    catch (error) { await stopAgentProcess(proc); agentProcs.delete(tid); throw error; }
  }

  // what the agent is doing: every chunk of output is a sign of life; Claude's stream also names each step
  const json = cmd.includes("stream-json");
  const act = { at: Date.now(), step: undefined as string | undefined, steps: 0 };
  const inFlight = new Map<string, string>(); // tool_use id → tool name, until its result comes back
  let resultText: string | undefined, assistantText = "";
  const touch = () => {
    act.at = Date.now();
    if (tid) agentActivity.set(tid, { at: new Date(act.at).toISOString(), step: act.step, steps: act.steps });
  };
  touch();
  const onLine = (line: string) => {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") { inFlight.set(c.id, c.name); act.step = toolStep(c.name, c.input); act.steps++; }
        else if (c.type === "text" && !e.parent_tool_use_id) assistantText += c.text;
      }
    } else if (e.type === "user") {
      for (const c of e.message?.content ?? []) if (c.type === "tool_result") inFlight.delete(c.tool_use_id);
    } else if (e.type === "result") {
      // a background task finishing starts another turn with its own result, so keep every turn's text: the real report
      // may be followed by "that notification changes nothing"
      const text = typeof e.result === "string" ? e.result : "";
      resultText = resultText === undefined ? text : `${resultText}\n\n${text}`;
    }
  };
  const read = async (stream: ReadableStream<Uint8Array>, lines: boolean) => {
    const dec = new TextDecoder();
    let all = "", buf = "";
    for await (const chunk of stream) {
      const t = dec.decode(chunk, { stream: true });
      all += t;
      if (lines) {
        buf += t;
        const parts = buf.split("\n");
        buf = parts.pop()!;
        parts.forEach(onLine);
      }
      touch();
    }
    if (lines && buf) onLine(buf);
    return all;
  };

  let stalled = false, timedOut = false;
  // hitting the run limit is not a tooling fault: report it like a stall so the task continues where it got to
  const timer = setTimeout(() => { timedOut = true; void stopAgentProcess(proc).catch(() => false); }, timeoutMs);
  // a run that has gone quiet: no output at all, and nothing slow in flight (a sub-agent may work quietly for long)
  const watch = setInterval(() => {
    const slow = [...inFlight.values()].some((n) => /^(Task|Agent)$/.test(n));
    if (!slow && Date.now() - act.at > stallMs) { stalled = true; void stopAgentProcess(proc).catch(() => false); }
  }, 30_000);
  let raw: string, err: string, code: number;
  const output = Promise.all([read(proc.stdout, json), read(proc.stderr, false)]);
  if (run) run.drained = output.then(async () => { await proc.exited; });
  try { [raw, err] = await output; code = await proc.exited; }
  finally {
    clearTimeout(timer); clearInterval(watch);
    if (tid && agentProcs.get(tid) === proc) {
      agentProcs.delete(tid); agentActivity.delete(tid);
      if (run && !activeClaim(run)) rmSync(pidFile(tid), { force: true });
    }
  }
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, `$ ${cmd.join(" ")}\n(exit ${code})\n\n${raw}\n\n[stderr]\n${err}`);
  const out = json ? (resultText ?? assistantText) : raw;
  if (timedOut) return `${out}${STALLED} hit the ${Math.round(timeoutMs / 60_000)}-minute run limit (clis.timeout_minutes)${act.step ? `; last step: ${act.step}` : ""}; run long builds in the background and return "waiting"`;
  if (stalled) return `${out}${STALLED} no output for ${Math.round(stallMs / 60_000)} minutes${act.step ? `; last step: ${act.step}` : ""}`;
  return out + (code ? `\n[exit ${code}] ${err.slice(-2000)}` : "");
}

export function parseResult(out: string): Result {
  const blocks = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    try {
      const r = JSON.parse(b);
      if (r.status) return r;
    } catch {}
  }
  return { status: "failed", summary: `agent returned no result block. tail: ${out.slice(-300)}` };
}

/** The models that route each owner message, fastest first: a choice made within seconds, not a judgement.
 * `[router] cli/model` in config.toml puts one first; the others are fallbacks when its CLI is missing or fails. */
const ROUTERS = [{ cli: "claude", model: "claude-haiku-5-5" }, { cli: "codex", model: "gpt-6-luna" }, { cli: "hermes", model: "" }];

/** One quick structured call for routing (the fastest model available); null when none answered. */
export async function quickAsk(prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const own = cfg.router?.cli ? [{ cli: String(cfg.router.cli), model: String(cfg.router.model ?? ROUTERS.find((provider) => provider.cli === cfg.router.cli)?.model ?? "") }] : [];
  for (const r of [...own, ...ROUTERS.filter((x) => x.cli !== own[0]?.cli)]) {
    if (!enabledProviders(cfg).includes(r.cli) || !providerAvailable(r.cli)) continue;
    const account = pickAccount(cfg, [r.cli]);
    if (!account) continue;
    const cmd = r.cli === "claude"
      ? ["claude", "-p", "--output-format", "text", "--tools", "", "--strict-mcp-config", ...(r.model ? ["--model", r.model] : [])]
      : r.cli === "hermes" ? ["hermes", "chat", "--query-file", "-", "--quiet", "--source", "noop", "--toolsets", "no_mcp", ...(r.model || cfg.clis?.hermes?.model ? ["--model", r.model || cfg.clis.hermes.model] : [])]
      : ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", ...(r.model ? ["-m", r.model] : []), "-c", 'model_reasoning_effort="low"', "-"];
    const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...accountEnv(account) }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), (cfg.router?.timeout_seconds ?? 45) * 1000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    mkdirSync(P("logs", "runs"), { recursive: true });
    writeFileSync(logFile, `${r.cli} ${r.model}\n${out}`);
    const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
    try { const answer = JSON.parse(m![1]); if (proc.exitCode === 0) markAccountSuccess(account); return answer; } catch {}
  }
  return null;
}

/** Provider-specific judge models stay independent when the owner switches CLIs. */
export function judgeCommand(cfg: Cfg, selected?: string): string[] {
  const enabled = enabledProviders(cfg);
  const cli = selected ?? (enabled.includes(cfg.judge?.cli ?? "claude") ? cfg.judge?.cli ?? "claude" : enabled[0]);
  if (!cli) return [];
  if (cli === "hermes") return ["hermes", "chat", "--query-file", "-", "--quiet", "--source", "noop", "--toolsets", "no_mcp", ...(cfg.judge?.hermes_model ? ["--model", cfg.judge.hermes_model] : [])];
  return cli === "claude" ? ["claude", "-p", "--output-format", "text", "--model", cfg.judge?.model ?? "claude-opus-5-5", "--tools", ""]
    : ["codex", "exec", "--skip-git-repo-check", ...(cfg.judge?.codex_model ? ["-m", cfg.judge.codex_model] : []), "-"];
}

/** One-shot structured call (used by the judge). */
export async function ask(prompt: string, cfg: Cfg, logFile: string): Promise<any> {
  const enabled = enabledProviders(cfg), preferred = cfg.judge?.cli ?? "claude";
  const selected = [preferred, ...enabled.filter((id) => id !== preferred)].find((id) => enabled.includes(id) && providerAvailable(id) && pickAccount(cfg, [id]));
  if (!selected) return null;
  const account = pickAccount(cfg, [selected]);
  if (!account) return null;
  const cmd = judgeCommand(cfg, selected);
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...accountEnv(account) }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), (cfg.judge?.timeout_minutes ?? 10) * 60_000); // runs inside locked()
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  mkdirSync(P("logs", "runs"), { recursive: true });
  writeFileSync(logFile, out);
  const m = [...out.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].pop() ?? out.match(/(\{[\s\S]*\})/);
  try { const answer = JSON.parse(m![1]); if (proc.exitCode === 0) markAccountSuccess(account); return answer; } catch { return null; }
}
