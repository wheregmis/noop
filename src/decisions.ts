// Decisions: agent asks → AI judge (owner's precedents & principles) → only unprecedented taste calls reach the owner.
import { existsSync, unlinkSync, appendFileSync, writeFileSync } from "node:fs";
import {
  type Cfg, L, P, agentName, journal, list, newTask, nextId, now, precedents, readAll, readDoc, readIf, today, writeDoc,
} from "./core";
import { notify } from "./notify";
import { ask, type Result } from "./runner";
import { judgeMayDecide } from "./autonomy";
import { isMergeCard, mergeHeadline } from "./waits";

export function openDecision(task: Record<string, string>, res: Result, host: string): string {
  const id = nextId("D", P("decisions"));
  const opts = res.options?.length ? res.options : ["A: approve", "B: reject"];
  writeDoc(P("decisions", "open", `${id}.md`), {
    id, task: task.id, agent: task.agent, host, created: now(),
    question: res.question ?? "", recommendation: res.recommendation ?? "", options: opts.join(" | "),
    attachments: (res.attachments ?? []).join(" | ") || undefined,
    kind: task.kind === "menu" ? "menu" : undefined,
  }, `## Context\n${res.summary}\n\n## Options\n${opts.map((o) => `- ${o}`).join("\n")}\n`);
  return id;
}

type Verdict = { verdict: "decided" | "sent_back" | "hold"; answer?: string; reason: string; cite?: string };

export async function judge(id: string, cfg: Cfg): Promise<Verdict | null> {
  if (cfg.judge?.enabled === false) return { verdict: "hold", reason: "judge disabled" };
  const { meta, body } = readDoc(P("decisions", "open", `${id}.md`));
  if (meta.kind === "menu") return { verdict: "hold", reason: "next-steps menu is always the owner's call" };
  const prompt = `You are the owner's JUDGE. You apply the owner's recorded taste and past rulings to questions raised by their AI agent fleet.
Decide one of:
- "decided": the owner has clearly answered this kind of question before (precedent or principle). Give the answer and cite where.
- "sent_back": the question is malformed, lacks info the agent could get itself, or is covered by policy the agent should just follow. Say what to do.
- "hold": it needs a genuinely new judgment call, is high-stakes/irreversible beyond precedent, or you are not confident. Wait for the human.
Be conservative: when in doubt, "hold". Never decide anything involving money, credentials, production data deletion, or messages committing the owner personally.

# Owner principles & profile
${readAll(P("memory"))}

# Fleet policy
${readAll(P("policies"))}

# Corrections the owner made to past judge rulings (highest priority)
${readIf(P("memory", "judge-feedback.md"), 6000) || "(none)"}

# Past decisions
${precedents(60) || "(none)"}

# Question ${id} from agent ${meta.agent} (task ${meta.task})
${meta.question}
Recommendation: ${meta.recommendation}
${body}

Always fill "answer" with the option/answer you would pick yourself, even when the verdict is "hold" (it is recorded to measure your accuracy; the owner still decides).
Reply with only a \`\`\`json block: {"verdict": "...", "answer": "...", "reason": "...", "cite": "D-xxxx or principle"}`;
  return ask(prompt, cfg, P("logs", "runs", `${id}-judge.log`));
}

/** Leading option letter/number of an answer ("B: merge…" → "B"; "1,3" → "1,3"); free text → whole text, lower-cased. */
export function choice(s: string | undefined): string {
  const t = (s ?? "").trim();
  const m = t.match(/^([A-Za-z]|\d+(?:\s*[,，]\s*\d+)*)(?=$|[\s:：.)、,，])/);
  return m ? m[1].replace(/\s/g, "").replace(/，/g, ",").toUpperCase() : t.toLowerCase();
}

/** Owner answered: score the judge's shadow answer and, when the owner overrode the agent's recommendation, keep a lesson. */
function learn(meta: Record<string, string>, answer: string, by: string): Record<string, string | undefined> {
  if (!/^owner/.test(by)) return {};
  const extra: Record<string, string | undefined> = {};
  if (meta.shadow_verdict && meta.shadow_answer) extra.shadow_agree = choice(meta.shadow_answer) === choice(answer) ? "yes" : "no";
  if (meta.recommendation && meta.kind !== "proposals" && choice(meta.recommendation) !== choice(answer)) {
    extra.overrode_recommendation = "yes";
    const f = P("memory", "lessons.md");
    if (!existsSync(f)) writeFileSync(f, "# Lessons learned (auto-appended by agents)\n\n");
    appendFileSync(f, `- ${today()} ${meta.id} [${meta.agent}] Q「${meta.question}」: agent recommended「${meta.recommendation}」, owner chose **${answer}**` +
      `${meta.shadow_answer ? ` (judge would have said「${meta.shadow_answer}」)` : ""}\n`);
  }
  return extra;
}

/** Tasks a card resumes: a supervisor card covers several tasks that share one cause. */
const cardTasks = (meta: Record<string, string>) => (meta.tasks || meta.task || "").split(",").filter(Boolean);

/** Close a decision and put its task back in the inbox with the answer appended. */
export function closeDecision(id: string, answer: string, by: string, note = "", judgeGate = false): boolean {
  const src = P("decisions", "open", `${id}.md`);
  if (!existsSync(src)) return false;
  const { meta, body } = readDoc(src);
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer, answered_by: by, answered: now(), ...learn(meta, answer, by) },
    `${body}\n## Answer (${by})\n${answer}\n${note}`);
  unlinkSync(src);
  for (const task of cardTasks(meta)) {
  const t = P("tasks", "blocked", `${task}.md`);
  if (existsSync(t)) {
    const { meta: tm, body: tb } = readDoc(t);
    // the owner answered the question the gate raised: unlock it for that run; the agent reads the answer and
    // only acts if the answer says so (no keyword matching on the owner's words). Supervisor cards never open a gate.
    // judgeGate: the owner opted in (judge.merge_cards) to the judge's confident A on a merge card.
    const gated = (/^owner/.test(by) || judgeGate) && !meta.supervisor_cause;
    writeDoc(P("tasks", "inbox", `${task}.md`),
      { ...tm, claimed_by: undefined, status: undefined, resumes: id, gate_override: gated ? id : undefined },
      `${tb}\n\n## Decision ${id} (${by})\nQ: ${meta.question}\nA: **${answer}**\nContinue the task accordingly.\n`);
    unlinkSync(t);
  }
  }
  return true;
}

/** A menu task resumed by the owner's own pick: its followups are the items the owner chose, not new proposals.
 *  A skipped card (ignored) leaves the choice to the agent, so it does not count. */
export function ownerPickedMenu(task: Record<string, string>): boolean {
  if (task.kind !== "menu" || !task.resumes) return false;
  const f = P("decisions", "closed", `${task.resumes}.md`);
  if (!existsSync(f)) return false;
  const d = readDoc(f).meta;
  return d.kind === "menu" && d.task === task.id && /^(owner|judge\(auto_answer\))/.test(d.answered_by ?? "") && d.ignored !== "yes";
}

/** The answer that sets a card aside: the owner skipped it (often just forgot to pick); it is not a rejection. */
export const IGNORE = "忽略";

/** Owner set the card aside: close it (no lesson: not a choice between the options) and hand the call back to the agent.
 * Ignoring never abandons the task (T-0575): the owner often ignores a card because they answered in chat instead. */
export function ignoreDecision(id: string, by: string): boolean {
  const src = P("decisions", "open", `${id}.md`);
  if (!existsSync(src)) return false;
  const { meta, body } = readDoc(src);
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer: IGNORE, answered_by: by, answered: now(), ignored: "yes" },
    `${body}\n## Answer (${by})\n${IGNORE}: the owner skipped this card without choosing. Not a rejection; the agent decides. Do not ask it again.\n`);
  unlinkSync(src);
  for (const task of cardTasks(meta)) {
  const t = P("tasks", "blocked", `${task}.md`);
  if (existsSync(t)) {
    const { meta: tm, body: tb } = readDoc(t);
    // no gate_override: skipping a card never authorises a gated action (merge, release, external message)
    writeDoc(P("tasks", "inbox", `${task}.md`), { ...tm, claimed_by: undefined, status: undefined, resumes: id },
      `${tb}\n\n## Decision ${id} (${by})\nQ: ${meta.question}\nA: **${IGNORE}** — the owner skipped this card without choosing; it is NOT a rejection and NOT a reason to stop. ` +
      `First check the chat after the card: the owner may have answered there in their own words; follow that. Otherwise decide yourself ` +
      `(usually the recommendation) within the autonomy policy. A gated step (merge, release, public API, external message) stays undone: ` +
      `finish everything else and report it as pending, without sending the same card again.\n`);
    unlinkSync(t);
  }
  }
  return true;
}

/** Owner corrected an answer they just gave: put the task back in the queue with the correction on top. */
export function amendDecision(id: string, text: string, by: string): string | null {
  const d = P("decisions", "closed", `${id}.md`);
  if (!existsSync(d)) return null;
  const tid = readDoc(d).meta.task;
  if (!tid) return null;
  for (const dir of ["inbox", "active", "blocked", "done"]) {
    const t = P("tasks", dir, `${tid}.md`);
    if (!existsSync(t)) continue;
    const { meta, body } = readDoc(t);
    const note = `\n\n## Owner correction to ${id} (${by}) — overrides the answer above\n${text}\nDo not act on the earlier answer where this contradicts it.\n`;
    if (dir === "active") { writeDoc(t, meta, body + note); return tid; }
    writeDoc(P("tasks", "inbox", `${tid}.md`), { ...meta, claimed_by: undefined, status: undefined, gate_override: undefined }, body + note);
    if (dir !== "inbox") unlinkSync(t);
    return tid;
  }
  return null;
}

/** Send a decided-by-judge question back to the agent. */
export function sendBack(id: string, reason: string) {
  closeDecision(id, `SENT BACK by judge: ${reason}`, "judge");
}

export async function routeDecision(id: string, cfg: Cfg, host: string) {
  const f = P("decisions", "open", `${id}.md`);
  const auto = cfg.idle?.auto_answer;
  if (auto && readDoc(f).meta.kind === "menu") { // owner opted in: answer the menu as the owner always has
    closeDecision(id, String(auto), "judge(auto_answer)", "Answered by idle.auto_answer in config.toml.");
    journal(host, `⚖️ ${id} menu auto-answered: ${auto}`);
    return;
  }
  let v = await judge(id, cfg);
  let { meta, body } = readDoc(f);
  // Every judge run is recorded (hold included) so closeDecision can score it against the owner's answer.
  if (meta.kind !== "menu" && cfg.judge?.enabled !== false) {
    meta = { ...meta, shadow_verdict: v?.verdict ?? "error", shadow_answer: v?.answer ?? (v?.verdict === "sent_back" ? `SENT BACK: ${v.reason}` : "") };
    writeDoc(f, meta, body); // persisted before any close below reads it back
  }
  if (v && !judgeMayDecide(cfg, meta.agent) && v.verdict !== "hold") { // shadow mode: record, but ask the owner
    journal(host, `👤 shadow-judge on ${id}: would ${v.verdict} "${v.answer ?? v.reason}"`);
    v = { verdict: "hold", reason: L(`Onboarding period, the judge thinks: ${v.verdict === "decided" ? v.answer : "send back: " + v.reason}`, `学习期，judge 认为：${v.verdict === "decided" ? v.answer : "应退回: " + v.reason}`) };
  }
  // judge.merge_cards (opt-in): a confident A on a card the reviewer recommended A merges; anything else still waits.
  const judgeMerges = cfg.judge?.merge_cards === true && v?.verdict === "decided" && choice(v.answer) === "A" && choice(meta.recommendation) === "A";
  if (v && v.verdict !== "hold" && isMergeCard(meta) && !judgeMerges) { // the judge's answer cannot click merge: hold for the owner
    journal(host, L(`👤 ${id} is a merge card, the judge does not answer it (the judge thinks: ${v.answer ?? v.reason})`, `👤 ${id} 是合并卡，judge 不代答（judge 认为：${v.answer ?? v.reason}）`));
    v = { verdict: "hold", reason: "merge card" };
  }
  if (v?.verdict === "decided" && v.answer) {
    closeDecision(id, v.answer, "judge", `Reason: ${v.reason} (cite: ${v.cite ?? "-"})`, judgeMerges && isMergeCard(meta));
    journal(host, `⚖️ judge decided ${id}: ${v.answer} (${v.cite ?? v.reason})`);
    return;
  }
  if (v?.verdict === "sent_back") {
    sendBack(id, v.reason);
    journal(host, `↩️ judge sent back ${id}: ${v.reason}`);
    return;
  }
  // hold → ask the human
  const opts = (meta.options ?? "").split(" | ").filter(Boolean);
  const menu = meta.kind === "menu";
  const context = body.match(/## Context\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  const text = menu ? [
    L(`*${id}* · ${agentName(meta.agent)}: the team is idle, what should come next?`, `*${id}* · ${agentName(meta.agent)}：团队空闲了，下一步做哪些？`),
    ...opts.map((o) => `${o}`),
    L(`Recommended: *${meta.recommendation || "-"}*`, `建议：*${meta.recommendation || "-"}*`),
    L(`Reply \`${id} 1,3\` (several allowed) or \`${id} <other instructions>\``, `回复 \`${id} 1,3\`（可多选）或 \`${id} <其他指示>\``),
  ].join("\n") : [
    // the card already shows the id, the agent and the options as buttons: the question, then the agent's account of
    // what is at stake (what the PR changes, what each choice means). The judge's reason for asking is not news to the owner.
    isMergeCard(meta) ? mergeHeadline([meta.question ?? "", context, ...opts].join("\n")) : "",
    linkRefs(meta.question ?? "", meta.task, [context, ...opts].join("\n")),
    context ? `\n${linkRefs(context, meta.task, [meta.question ?? "", ...opts].join("\n"))}` : "",
    // the app marks this option 推荐 (and drops the line); chat channels show it as written
    meta.recommendation ? L(`\nRecommended: *${meta.recommendation}*`, `\n建议：*${meta.recommendation}*`) : "",
  ].filter(Boolean).join("\n");
  const ids = await notify(text, cfg, { kind: menu ? "menu" : "decision", ref: id, options: opts,
    attachments: (meta.attachments ?? "").split(" | ").filter(Boolean), from: `${agentName(meta.agent)}@${meta.host}` });
  writeDoc(P("decisions", "open", `${id}.md`), { ...meta, held: now(), notified: ids.join(",") }, body);
  journal(host, `📨 ${id} held for owner: ${meta.question}`);
}

/** Owner overrides a judge ruling: `D-0007 override <new answer>` → feedback memory + redo task. */
export function overrideJudge(id: string, answer: string, src: string, host: string): boolean {
  const f = P("decisions", "closed", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  if (meta.answered_by !== "judge") return false;
  writeDoc(f, { ...meta, answer, answered_by: `owner-override(${src})`, overridden_judge: meta.answer }, body + `\n## Owner override\n${answer}\n`);
  const fb = P("memory", "judge-feedback.md");
  if (!existsSync(fb)) writeFileSync(fb, "# Owner corrections to judge rulings\n\n");
  appendFileSync(fb, `- ${today()} ${id}: Q「${meta.question}」judge said「${meta.answer}」→ owner: **${answer}**\n`);
  newTask(`Redo per owner override of ${id}`, `Judge answered "${meta.answer}" but the owner overrode it:\n\n**${answer}**\n\nOriginal question: ${meta.question}\nRelated task: ${meta.task}. Adjust/revert the earlier work accordingly.`,
    { agent: meta.agent, priority: "high", source: `override:${id}` });
  journal(host, `🔁 owner overrode judge on ${id}: ${answer}`);
  return true;
}

export const recentJudgeIds = () =>
  new Set(list(P("decisions", "closed")).slice(-30).map((p) => readDoc(p).meta)
    .filter((m) => m.answered_by === "judge").map((m) => m.id));

/**
 * "#747" / "nsh #747" → a Markdown link to that PR/issue, so every reference is clickable.
 * The repository comes from GitHub links in the text or `context` (the decision's other text and options),
 * matched by name, else from the task's checkout.
 */
export function linkRefs(text: string, taskId?: string, context = ""): string {
  const seen = new Map<string, string>(); // repo name → owner/repo
  for (const m of `${text}\n${context}`.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g))
    seen.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  let fallback: string | null | undefined;
  const slugOf = (name?: string) => (name && seen.get(name.toLowerCase()))
    || (fallback === undefined ? (fallback = repoSlug(taskId) ?? (seen.size === 1 ? [...seen.values()][0] : null)) : fallback);
  return text
    // "owner/repo#12" names its repository outright
    .replace(/(^|[^\w\/\[#])([\w.-]+\/[\w.-]+)#(\d+)\b/g, (_, pre: string, slug: string, n: string) => `${pre}[${slug}#${n}](https://github.com/${slug}/pull/${n})`)
    .replace(/(^|[^\w\/\[#])(?:([\w.-]+)( ?))?#(\d+)\b/g, (all, pre: string, name: string | undefined, sp: string, n: string) => {
      const named = !!name && seen.has(name.toLowerCase());
      // "other-repo#3" for a repository not seen here: unknown, left as is ("PR#3" is not a repository)
      if (name && !named && !sp && !/^(pr|issue)s?$/i.test(name)) return all;
      const slug = slugOf(named ? name : undefined);
      if (!slug) return all;
      return `${pre}${name && !named ? name + sp : ""}[${named ? `${name}#${n}` : `#${n}`}](https://github.com/${slug}/pull/${n})`;
    });
}

function repoSlug(taskId?: string): string | null {
  if (!taskId) return null;
  for (const st of ["active", "waiting", "inbox", "done", "blocked"]) {
    const f = P("tasks", st, `${taskId}.md`);
    if (!existsSync(f)) continue;
    const repo = (readDoc(f).meta.repo ?? "").replace(/^~/, process.env.HOME ?? "");
    if (!repo || !existsSync(repo)) return null;
    const r = Bun.spawnSync(["git", "-C", repo, "remote", "get-url", "origin"], { stdout: "pipe" });
    return r.stdout.toString().trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1] ?? null;
  }
  return null;
}
