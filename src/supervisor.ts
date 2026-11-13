// Stall supervisor: like a team lead chasing progress. Every ~30 minutes it looks at waiting/blocked tasks, keeps them
// going where it can (re-route away from retired/offline hosts, resume tasks whose card was already answered, requeue
// tasks that wait on nothing), and only then raises ONE decision card per root cause for what is still stuck.
// Gates are never touched: a supervisor card never sets gate_override, so merge/release/external messages stay gated.
import { existsSync, unlinkSync } from "node:fs";
import { type Cfg, type HostBeat, L, P, journal, list, nextId, now, onlineHosts, readDoc, writeDoc } from "./core";

export type Meta = Record<string, string>;
export type Task = { meta: Meta; folder: "waiting" | "blocked"; body?: string };
export type Ctx = {
  now: number;
  online: HostBeat[];
  retired: string[];
  primaryOs: string;           // os of the host that runs wait_checks, e.g. "linux"
  maxAgeHours: number;
  maxWakes: number;
  decision: (id: string) => "open" | "closed" | undefined;
};
export type Action = "resume" | "reroute" | "repin" | "requeue" | "escalate" | "none";
export type Verdict = { id: string; cause: string; reasons: string[]; action: Action; requires?: string };

const reqs = (m: Meta) => (m.requires ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const pinnedHost = (m: Meta) => (m.host && m.host !== "any" ? m.host : reqs(m).find((r) => r.startsWith("host:"))?.slice(5));
const platform = (m: Meta) => reqs(m).find((r) => /^os:(macos|windows)$/.test(r));
const startedAt = (m: Meta) => Date.parse(m.waiting_since || m.created || "") || 0;

/** The wait_check can never answer on the host that runs it (macOS path on a Linux primary, etc.). */
export function checkUnrunnable(check: string | undefined, primaryOs: string): boolean {
  if (!check) return false;
  // "/Users/" only means a macOS home when it starts a path: "/c/Users/me" (Git Bash), "C:/Users/me" and "/mnt/c/Users/me" are local Windows paths.
  if (primaryOs !== "macos" && /(?<![A-Za-z0-9_:.~$-])\/Users\/|\bswift\b|\bxcrun\b|\bosascript\b/.test(check)) return true;
  if (primaryOs !== "windows" && /[A-Z]:\\|powershell|\.exe\b/i.test(check)) return true;
  return false;
}

/** Decide what is wrong with one waiting/blocked task and what to do first. Pure: unit-tested. */
export function classify(t: Task, ctx: Ctx): Verdict | null {
  const m = t.meta;
  const v = (cause: string, action: Action, reasons: string[], requires?: string): Verdict => ({ id: m.id, cause, reasons, action, requires });
  const capable = (r: string[]) => ctx.online.filter((h) => !ctx.retired.includes(h.host) && r.every((x) => x.split("|").some((y) => h.caps.includes(y.trim()))));
  // 1. pinned to / claimed by a retired host → move it to any host with the same remaining requirements
  const pin = pinnedHost(m);
  const gone = [pin, m.claimed_by].find((h) => h && ctx.retired.includes(h));
  if (gone && m.children && t.folder === "waiting") // delegated parent: only fix where it resumes later
    return pin === gone ? v(`host:${gone}`, "repin", [L(`pinned host ${gone} is retired`, `绑定的主机 ${gone} 已停用`)], reqs(m).filter((r) => r !== `host:${gone}`).join(",")) : null;
  if (m.children && t.folder === "waiting") return null; // delegated parent: follows its children
  if (/\bdate\b/.test(m.wait_check ?? "") && t.folder === "waiting") return null; // dated follow-up: waits for the calendar on purpose
  if (gone) {
    const rest = reqs(m).filter((r) => r !== `host:${gone}`);
    if (capable(rest).length) return v(`host:${gone}`, "reroute", [L(`pinned host ${gone} is retired`, `绑定的主机 ${gone} 已停用`)], rest.join(","));
    return v(`host:${gone}`, "escalate", [L(`pinned host ${gone} is retired and no other online host meets ${rest.join(",") || "the requirements"}`, `绑定的主机 ${gone} 已停用，且没有其他在线主机满足 ${rest.join(",") || "要求"}`)]);
  }
  // 2. blocked on a card that is already closed → the answer never reached it
  if (t.folder === "blocked" && m.decision && ctx.decision(m.decision) === "closed") return v(`answered:${m.decision}`, "resume", [L(`${m.decision} was answered but the task did not continue`, `${m.decision} 已回答但任务没有继续`)]);
  if (t.folder === "blocked" && m.decision && ctx.decision(m.decision) === "open") return null; // the owner has the card
  const age = (ctx.now - startedAt(m)) / 3_600_000;
  const wakes = Number(m.wakes ?? 0);
  const reasons: string[] = [];
  if (age >= ctx.maxAgeHours) reasons.push(L(`waiting ${Math.floor(age)} hours`, `已等待 ${Math.floor(age)} 小时`));
  if (wakes >= ctx.maxWakes) reasons.push(L(`woken ${wakes} times`, `唤醒 ${wakes} 次`));
  if (checkUnrunnable(m.wait_check, ctx.primaryOs)) reasons.push(L("the wait check cannot run on the primary, so it will never fire", "等待检查命令在主控机上无法运行，永远不会触发"));
  // 3. waits on nothing: requeue once so the agent re-decides; the second time it is a card
  if (!m.waiting_on && !m.wait_check && t.folder === "waiting") {
    if (m.supervisor_requeued) return v("no-wait", "escalate", [L("nothing recorded as being waited on", "没有记录在等什么"), ...reasons]);
    return v("no-wait", "requeue", [L("nothing recorded as being waited on", "没有记录在等什么")]);
  }
  // 4. needs a platform: re-route if another online host has it, else one card for the platform
  const plat = platform(m);
  if (plat && pin && !ctx.online.some((h) => h.host === pin) && capable(reqs(m).filter((r) => r !== `host:${pin}`)).length)
    return v(`host:${pin}`, "reroute", [L(`pinned host ${pin} is offline`, `绑定的主机 ${pin} 离线`)], reqs(m).filter((r) => r !== `host:${pin}`).join(","));
  if (!reasons.length && t.folder === "waiting") return null; // young and cycling normally
  // platform host is online but the wait_check can't run here: hand the task back to that host to check itself
  if (plat && capable([plat]).length && checkUnrunnable(m.wait_check, ctx.primaryOs) && !m.supervisor_requeued)
    return v(`platform:${plat}`, "reroute", [...reasons, L(`a ${plat} host is online, handed back to it to check`, `${plat} 主机在线，交回该主机自行检查`)], reqs(m).filter((r) => !r.startsWith("host:")).join(","));
  if (plat) return v(`platform:${plat}`, "escalate", [...reasons, capable([plat]).length ? L(`a ${plat} host is online, but the task still did not advance after being handed back`, `${plat} 主机在线，但任务交回后仍未推进`) : L(`no ${plat} host is online`, `没有在线的 ${plat} 主机`)]);
  if (!reasons.length) reasons.push(L("blocked", "被阻塞"));
  return v(`slow:${m.claimed_by || "any"}`, "escalate", reasons);
}

/** Once a platform is escalated, other waiting tasks on the same platform join the same card (even if still young),
 * so the owner gets one card for the cause instead of a new one each time another task crosses the threshold. */
export function sweepPlatform(tasks: Task[], vs: Verdict[]): Verdict[] {
  const causes = new Set(vs.filter((v) => v.action === "escalate" && v.cause.startsWith("platform:")).map((v) => v.cause));
  const have = new Set(vs.map((v) => v.id));
  return tasks.filter((t) => t.folder === "waiting" && !t.meta.children && !have.has(t.meta.id) && causes.has(`platform:${platform(t.meta)}`))
    .map((t) => ({ id: t.meta.id, cause: `platform:${platform(t.meta)}`, reasons: [L(`also needs ${platform(t.meta)}`, `同样需要 ${platform(t.meta)}`)], action: "escalate" as const }));
}

/** One card per root cause. */
export function groupByCause(vs: Verdict[]): Map<string, Verdict[]> {
  const g = new Map<string, Verdict[]>();
  for (const x of vs) if (x.action === "escalate") g.set(x.cause, [...(g.get(x.cause) ?? []), x]);
  return g;
}

/** Tasks a previous supervisor card for this cause already covered (answered, skipped or still open) are never asked again (T-0575). */
export function alreadyAsked(cause: string, ids: string[], cards: Meta[]): string[] {
  const seen = new Set(cards.filter((c) => c.supervisor_cause === cause).flatMap((c) => (c.tasks ?? c.task ?? "").split(",")));
  return ids.filter((id) => !seen.has(id));
}

const CAUSE_LABEL = (c: string) =>
  c === "platform:os:macos" ? L("macOS tasks not advancing", "macOS 任务推不动") : c === "platform:os:windows" ? L("Windows tasks not advancing", "Windows 任务推不动")
    : c.startsWith("host:") ? L(`host ${c.slice(5)} unavailable`, `主机 ${c.slice(5)} 不可用`) : c === "no-wait" ? L("no wait condition recorded", "没有记录等待条件") : c.startsWith("slow:") ? L(`long run on ${c.slice(5)}`, `${c.slice(5)} 上的长时间运行`) : c;

export function cardFor(cause: string, items: { id: string; title: string; reasons: string[] }[]) {
  const lines = items.map((i) => L(`- ${i.id} ${i.title} (${i.reasons.join("; ")})`, `- ${i.id} ${i.title}（${i.reasons.join("；")}）`)).join("\n");
  const platformCause = cause.startsWith("platform:") || cause.startsWith("host:");
  const options = platformCause ? [
    L("A: Drop these native checks, record the unverified gap in the PR/task and finish the rest — the tasks end today and the gap is visible", "A: 放弃这些原生验证，在 PR/任务里记录未验证的缺口，其余部分收尾 — 任务今天结束，验证缺口公开可见"),
    L("B: Wait for the environment (the tasks continue once you unlock or log in to that machine) — they stay parked, no more reminders", "B: 等环境恢复（你解锁/登录那台机器后任务自动继续） — 任务继续挂起，不再提醒"),
    L("C: Cancel these tasks — no checks and no further follow-up", "C: 取消这些任务 — 不做验证也不再跟进"),
  ] : [
    L("A: Let each task's agent decide: finish what it can, record the state of the rest and end — nothing stays parked", "A: 由各任务的 agent 自行判断：能收尾就收尾，跑不完的记录现状后结束 — 不再挂起"),
    L("B: Wait one more round, then treat anything unfinished as A — at most a few more hours", "B: 再等一轮，之后仍未完成就按 A 处理 — 最多再等几个小时"),
    L("C: Cancel these tasks — no further follow-up", "C: 取消这些任务 — 不再跟进"),
  ];
  return {
    question: L(`${CAUSE_LABEL(cause)}: what to do with ${items.length} task(s)?`, `${CAUSE_LABEL(cause)}，${items.length} 个任务怎么办？`).slice(0, 60),
    summary: L(`${CAUSE_LABEL(cause)}. These tasks are stuck (rerouting, rerunning and the parts not needing this condition were tried first):\n${lines}\nMerge, release and external-message gates are not affected by this card.`, `${CAUSE_LABEL(cause)}，以下任务卡住（已先尝试改派、重跑、补做不依赖该条件的部分）：\n${lines}\n合并、发布、对外消息的闸门不受这张卡影响。`),
    options, recommendation: "A",
  };
}

/** PRs a waiting task exists to land: full PR URLs in its spec (body before the first run log) or waiting_on, plus
    "<Repo> #N" in its title when the task has a repo. Pure: unit-tested. */
export function trackedPrs(m: Meta, body = ""): string[] {
  const spec = `${m.title ?? ""}\n${body.split("\n## Run ")[0]}\n${m.waiting_on ?? ""}`;
  const out = new Set<string>();
  for (const x of spec.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) out.add(`${x[1]}#${x[2]}`);
  const repo = m.repo?.match(/^[\w.-]+\/[\w.-]+$/)?.[0];
  const t = repo && (m.title ?? "").match(/#(\d+)/);
  if (t) out.add(`${repo}#${t[1]}`);
  return [...out];
}

/** A merge is a wake-up event, not proof that all acceptance criteria are met. */
function prState(ref: string): string {
  const [repo, n] = ref.split("#");
  try { return Bun.spawnSync(["gh", "pr", "view", n, "-R", repo, "--json", "state", "-q", ".state"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; }
}

// ------------------------------------------------------------------ IO: one supervisor pass over the hub
const decisionState = (id: string) => existsSync(P("decisions", "open", `${id}.md`)) ? "open" as const
  : existsSync(P("decisions", "closed", `${id}.md`)) ? "closed" as const : undefined;

export function supervise(cfg: Cfg, host: string, t = Date.now(), readPrState = prState) {
  const s = cfg.supervisor ?? {};
  const retired: string[] = s.retired_hosts ?? cfg.fleet?.retired_hosts ?? [];
  const ctx: Ctx = {
    now: t, online: onlineHosts(cfg), retired, primaryOs: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    maxAgeHours: s.max_age_hours ?? 3, maxWakes: s.max_wakes ?? 3, decision: decisionState,
  };
  const tasks: (Task & { path: string })[] = (["waiting", "blocked"] as const).flatMap((folder) =>
    list(P("tasks", folder), /^T-.*\.md$/).map((path) => ({ path, folder, ...readDoc(path) })));
  const verdicts: Verdict[] = [];
  const counts = { reroute: 0, resume: 0, requeue: 0, cards: 0, merged: 0 };
  let merged = 0;
  for (const task of [...tasks]) { // Wake once per merged PR set, preserving any unfinished acceptance work.
    if (task.meta.children || ctx.decision(task.meta.decision ?? "") === "open") continue;
    const prs = trackedPrs(task.meta, task.body);
    const signature = prs.slice().sort().join(",");
    if (!prs.length || task.meta.supervisor_merged_prs === signature || !prs.every((r) => readPrState(r) === "MERGED")) continue;
    writeDoc(P("tasks", "inbox", `${task.meta.id}.md`), { ...task.meta, status: undefined, finished: undefined, resumed: "yes", supervisor_merged_prs: signature, wake_at: undefined, wait_kind: undefined, claimed_by: undefined },
      `${task.body ?? ""}\n\n> Supervisor (${now()}): ${prs.join(", ")} merged while this task waited. Check remaining acceptance criteria and follow-ups; return done if the goal is met, otherwise continue the unfinished work. Do not wait for these PRs to merge again.\n`);
    unlinkSync(task.path);
    tasks.splice(tasks.indexOf(task), 1);
    journal(host, L(`🧭 supervisor: ${task.meta.id} resumed, ${prs.join(", ")} already merged`, `🧭 supervisor: ${task.meta.id} 唤醒核对收尾，${prs.join("、")} 已合并`)); merged++;
  }
  for (const task of tasks) {
    const v = classify(task, ctx);
    if (!v) continue;
    const { meta, body } = task;
    const back = (extra: Record<string, string | undefined>, note: string) => {
      writeDoc(P("tasks", "inbox", `${meta.id}.md`), { ...meta, claimed_by: undefined, status: undefined, wake_at: undefined, wait_kind: undefined, ...extra },
        `${body ?? ""}\n\n> Supervisor (${now()}): ${note}\n`);
      unlinkSync(task.path);
    };
    if (v.action === "reroute") {
      back({ host: "any", requires: v.requires || undefined, resumed: "yes", ...(v.cause.startsWith("platform:") ? { supervisor_requeued: "yes" } : {}) }, `${v.reasons.join("; ")}. Re-routed to any host with ${v.requires || "the remaining requirements"}; local files on the old host are gone, redo what is needed.`);
      journal(host, L(`🧭 supervisor: ${meta.id} rerouted (${v.reasons.join("; ")})`, `🧭 supervisor: ${meta.id} 改派（${v.reasons.join("；")}）`)); counts.reroute++;
    } else if (v.action === "repin") {
      writeDoc(task.path, { ...meta, host: "any", requires: v.requires || undefined }, body ?? "");
      journal(host, L(`🧭 supervisor: ${meta.id} unpinned from a retired host`, `🧭 supervisor: ${meta.id} 去掉已停用主机的绑定`)); counts.reroute++;
    } else if (v.action === "resume") {
      back({ resumed: "yes", resumes: meta.decision }, `${v.reasons.join("; ")}. Read ${meta.decision}'s answer in decisions/closed and continue accordingly.`);
      journal(host, L(`🧭 supervisor: ${meta.id} resumed (${v.reasons.join("; ")})`, `🧭 supervisor: ${meta.id} 继续（${v.reasons.join("；")}）`)); counts.resume++;
    } else if (v.action === "requeue") {
      back({ supervisor_requeued: "yes", resumed: "yes" }, `No waiting_on was recorded. Re-decide: finish what you can, or return "waiting" with a concrete waiting_on and wait_check.`);
      journal(host, L(`🧭 supervisor: ${meta.id} has no wait condition, requeued`, `🧭 supervisor: ${meta.id} 没有等待条件，重新排队`)); counts.requeue++;
    } else verdicts.push(v);
  }
  for (const x of sweepPlatform(tasks, verdicts)) verdicts.push(x);
  const cards = (["open", "closed"] as const).flatMap((f) => list(P("decisions", f)).map((p) => readDoc(p).meta));
  const byId = new Map(tasks.map((x) => [x.meta.id, x]));
  for (const [cause, vs] of groupByCause(verdicts)) {
    const fresh = alreadyAsked(cause, vs.map((x) => x.id), cards);
    if (!fresh.length) continue;
    const items = fresh.map((id) => ({ id, title: byId.get(id)!.meta.title, reasons: vs.find((x) => x.id === id)!.reasons }));
    const c = cardFor(cause, items);
    const did = nextId("D", P("decisions"));
    writeDoc(P("decisions", "open", `${did}.md`), {
      id: did, task: fresh[0], tasks: fresh.join(","), agent: "lead", host, created: now(), supervisor_cause: cause,
      question: c.question, recommendation: c.recommendation, options: c.options.join(" | "),
    }, `## Context\n${c.summary}\n\n## Options\n${c.options.map((o) => `- ${o}`).join("\n")}\n`);
    for (const id of fresh) { // parked under the card: the answer resumes every task (closeDecision reads `tasks`)
      const x = byId.get(id)!;
      writeDoc(P("tasks", "blocked", `${id}.md`), { ...x.meta, status: "needs_decision", decision: did, wake_at: undefined }, x.body ?? "");
      if (x.folder === "waiting") unlinkSync(x.path);
    }
    journal(host, `🧭 supervisor: ${CAUSE_LABEL(cause)} → ${did}（${fresh.join(", ")}）`); counts.cards++;
    cards.push({ supervisor_cause: cause, tasks: fresh.join(",") });
  }
  counts.merged = merged;
  journal(host, `🧭 supervisor ran: resumed ${merged} with merged PRs, ${tasks.length} waiting/blocked, rerouted ${counts.reroute}, resumed ${counts.resume}, requeued ${counts.requeue}, cards ${counts.cards}`);
  return counts;
}
