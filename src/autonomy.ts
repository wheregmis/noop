// Graduated autonomy. Start conservative ("onboarding"): self-generated work needs owner approval,
// the judge only shadows. Graduation is proposed by the architect from metrics, decided by the owner.
import { existsSync, unlinkSync } from "node:fs";
import { type Cfg, L, P, fileId, journal, list, nextId, now, readDoc, writeDoc } from "./core";
import { notify } from "./notify";

export type Level = "onboarding" | "assisted" | "autonomous";
/** Global level, optionally overridden per agent ([autonomy.agents] reviewer = "assisted") as trust is earned. */
export const level = (cfg: Cfg, agent?: string): Level =>
  (agent && cfg.autonomy?.agents?.[agent]) || cfg.autonomy?.level || "onboarding";

/** Should a task from this source wait for owner approval? Owner-created & approved work never does. */
export function needsApproval(cfg: Cfg, source: string): boolean {
  if (/^owner|^override|^approved|^decision/.test(source)) return false;
  const l = level(cfg);
  if (l === "autonomous") return false;
  if (l === "assisted") return /^followup/.test(source) && cfg.autonomy?.assisted_approve_followups === true;
  // read-only routines ([[routine]] readonly = true, or [autonomy] auto_routines) only observe; whatever they
  // want changed comes back as followups, which are still gated
  const rn = source.match(/^routine:(.+)$/)?.[1];
  if (rn && ((cfg.autonomy?.auto_routines ?? []).includes(rn) || (cfg.routine ?? []).some((r: any) => r.name === rn && r.readonly === true))) return false;
  // onboarding: everything self-generated, except the hub's own housekeeping
  return !/^idle|^routine:(evolve|triage-inbound|daily-report|learn)/.test(source);
}

const QUEUED = ["inbox", "active", "waiting", "blocked"];
const isRoutine = (m: Record<string, string>, name: string) => (m.source ?? "").replace(/^approved:/, "") === `routine:${name}`;

/** Id of a copy of this routine that is queued or running (so a new run would be redundant), else "".
 *  `host`: a per-machine routine (scheduler "each") only counts its own machine's copies. */
export function routineQueued(name: string, host?: string): string {
  for (const s of QUEUED) for (const p of list(P("tasks", s), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if (!isRoutine(m, name) || (host && m.host !== host)) continue;
    // a copy parked on something slow (CI, the owner clicking merge) has finished its pass: the next run must still
    // pick up new PRs/issues instead of the backlog piling up behind it
    if (s === "waiting" || s === "blocked") continue;
    return m.id;
  }
  return "";
}

/** A routine skipped behind a copy no online host can run (parked in the inbox) for 30+ minutes: tell the owner once per copy.
 *  The skips only reach the journal and the stall supervisor only sees waiting/blocked tasks, so such a copy silences the routine. */
export function noteStuckRoutine(cfg: Cfg, name: string, id: string, state: Record<string, string>) {
  const key = `${name}#stuck`, f = P("tasks", "inbox", `${id}.md`);
  if (state[key] === id || !existsSync(f)) return; // running, waiting and card tasks are progress, not a stuck copy
  const m = readDoc(f).meta;
  const mins = Math.floor((Date.now() - Date.parse(m.parked ?? "")) / 60_000);
  if (!(mins >= 30)) return; // not parked (NaN), or parked only briefly
  state[key] = id;
  void notify(`例行任务 ${name} 已经 ${mins} 分钟没有新的一轮：上一次的 ${id} 在等一台满足 ${m.requires} 的在线主机，之后每轮都被跳过。`, cfg, { kind: "notice", ref: id });
}

/** A newer run of a routine replaces its older unapproved copies: move them to rejected with a note. */
export function supersedeProposed(name: string, newId: string, host?: string): string[] {
  const out: string[] = [];
  for (const p of list(P("tasks", "proposed"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    if (meta.id === newId || !isRoutine(meta, name) || (host && meta.host !== host)) continue;
    writeDoc(P("tasks", "rejected", `${meta.id}.md`), { ...meta, approval: `superseded:${newId}` }, body + `\n\n## Note\nsuperseded by ${newId}\n`);
    unlinkSync(p);
    out.push(meta.id);
  }
  return out;
}

/** Judge may only auto-decide outside onboarding. */
export const judgeMayDecide = (cfg: Cfg, agent?: string) => level(cfg, agent) !== "onboarding";

/** Batch tasks/proposed into one numbered approval message. */
export async function proposeBatch(cfg: Cfg, host: string) {
  // only real task files: an agent appending a note to a task's old path leaves a stub without frontmatter,
  // which would show as "undefined（undefined）" and, never matching the batch, rebuild it on every tick
  const items = list(P("tasks", "proposed"), /^T-.*\.md$/).filter((p) => readDoc(p).meta.id === fileId(p)).slice(0, 9);
  const itemIds = items.map((p) => readDoc(p).meta.id);
  const openPath = list(P("decisions", "open")).find((p) => readDoc(p).meta.kind === "proposals");
  if (openPath) {
    // An unanswered batch must not block later work forever: rebuild it when it went stale
    // (its tasks left tasks/proposed) or new proposals arrived, but notify at most every few hours.
    const { meta } = readDoc(openPath);
    const listed = (meta.items ?? "").split(",").filter(Boolean);
    const stale = listed.some((t: string) => !itemIds.includes(t));
    const fresh = itemIds.some((t) => !listed.includes(t));
    if (!stale && !fresh) return;
    const alive = listed.some((t: string) => itemIds.includes(t));
    const age = Date.now() - Date.parse(meta.notified ?? meta.created);
    if (alive && age < (cfg.autonomy?.renotify_hours ?? 3) * 3600_000) return;
    closeBatch(openPath, itemIds.length ? "superseded (rebuilt)" : "superseded (nothing left)");
    if (!itemIds.length) return;
  } else {
    if (!items.length) return;
    const oldest = Math.min(...items.map((p) => Date.parse(readDoc(p).meta.created)));
    const batchWait = (cfg.autonomy?.batch_minutes ?? 15) * 60_000;
    if (Date.now() - oldest < batchWait && items.length < 5) return; // let a few accumulate
  }
  const id = nextId("P", P("decisions"));
  const lines = items.map((p, i) => {
    const m = readDoc(p).meta;
    return `${i + 1}. ${m.title}（${m.agent}）`;
  });
  writeDoc(P("decisions", "open", `${id}.md`), {
    id, kind: "proposals", created: now(), notified: now(), host, items: itemIds.join(","),
    question: L("Which of these should go ahead?", "要做哪几项？"),
  }, L(`## To confirm\n${lines.join("\n")}\n`, `## 待确认\n${lines.join("\n")}\n`));
  await notify([L(`*${id}* would like to do the following, please confirm:`, `*${id}* 想做这几件事，请确认：`), ...lines,
    L(`Reply \`${id} 1,3\`, \`${id} all\` (do all) or \`${id} none\` (do none)`, `回复 \`${id} 1,3\`、\`${id} all\`（全做）或 \`${id} none\`（都不做）`)].join("\n"), cfg,
    { kind: "proposals", ref: id, options: ["all", "none", ...lines.map((_, i) => String(i + 1))] });
  journal(host, `${id} asked owner to approve ${items.length} proposed tasks`);
}

/** Close an unanswered proposals batch without touching its tasks (they stay in tasks/proposed). */
function closeBatch(path: string, answer: string) {
  const { meta, body } = readDoc(path);
  writeDoc(P("decisions", "closed", `${meta.id}.md`), { ...meta, answer, answered_by: "system", answered: now() }, body + `\n## Answer\n${answer}\n`);
  unlinkSync(path);
}

/** Owner's answer to a proposals batch: approve picked ones, reject the rest (rejections are a learning signal). */
export function resolveProposals(id: string, answer: string, by: string): boolean {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  // keep empty slots: card line n is items[n-1], so dropping an empty id would shift every later pick by one
  const ids = (meta.items ?? "").split(",");
  const a = answer.trim().toLowerCase();
  const picked = new Set<number>(a.startsWith("all") ? ids.map((_, i) => i + 1)
    : a.startsWith("none") ? [] : (a.match(/^[\d,\s，]+/)?.[0] ?? "").split(/[,，\s]+/).filter(Boolean).map(Number));
  const note = answer.replace(/^[\d,\s，]+|^(all|none)\s*/i, "").trim();
  ids.forEach((tid, i) => {
    const p = P("tasks", "proposed", `${tid}.md`);
    if (!tid || !existsSync(p)) return;
    const { meta: tm, body: tb } = readDoc(p);
    const ok = picked.has(i + 1);
    writeDoc(P("tasks", ok ? "inbox" : "rejected", `${tid}.md`), { ...tm, source: ok ? `approved:${tm.source}` : tm.source, approval: ok ? id : `rejected:${id}` },
      tb + (note && ok ? `\n\n## Owner note (${id})\n${note}\n` : ""));
    unlinkSync(p);
  });
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer, answered_by: by, answered: now() }, body + `\n## Answer\n${answer}\n`);
  unlinkSync(f);
  return true;
}

/** Shadow-judge accuracy: how often the judge's would-be answer matched the owner's. */
export function judgeAccuracy(agent?: string) {
  const rows = list(P("decisions", "closed")).map((p) => readDoc(p).meta)
    .filter((m) => m.shadow_verdict && /^owner/.test(m.answered_by ?? "") && (!agent || m.agent === agent));
  // every owner-answered decision the judge also answered counts (held ones too): shadow_agree is set by closeDecision
  const scored = rows.filter((m) => m.shadow_agree === "yes" || m.shadow_agree === "no");
  const agree = scored.filter((m) => m.shadow_agree === "yes");
  const decided = rows.filter((m) => m.shadow_verdict === "decided");
  return { samples: rows.length, would_decide: decided.length, scored: scored.length, agreed: agree.length,
    accuracy: scored.length ? +(agree.length / scored.length).toFixed(2) : null };
}
