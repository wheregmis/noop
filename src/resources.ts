// Resource governor: telemetry, adaptive parallelism, per-agent CPU budgets, automatic disk cleanup.
// Everything here is deterministic code — agents never decide to delete things on their own.
import { existsSync, lstatSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { availableParallelism, freemem, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type Cfg, P, journal } from "./core";

export type Stats = { cores: number; load1: number; loadRatio: number; memFreePct: number; diskFreeGB: number; diskFreePct: number };

/** Available memory. macOS freemem() excludes inactive/purgeable/speculative pages and reads ~2% on a healthy Mac. */
function availMem(): number {
  if (process.platform !== "darwin") return freemem();
  try {
    const out = Bun.spawnSync(["vm_stat"]).stdout.toString();
    const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384);
    const n = (k: string) => Number(out.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0);
    const v = (n("free") + n("inactive") + n("speculative") + n("purgeable")) * page;
    return v > 0 ? v : freemem();
  } catch { return freemem(); }
}

export function sample(cfg: Cfg): Stats {
  const cores = availableParallelism();
  const load1 = process.platform === "win32" ? 0 : loadavg()[0]; // Windows has no loadavg → rely on mem/disk
  const fsInfo = statfsSync(cfg.resources?.disk_path ?? homedir());
  const free = fsInfo.bavail * fsInfo.bsize, total = fsInfo.blocks * fsInfo.bsize;
  return {
    cores, load1: +load1.toFixed(2), loadRatio: +(load1 / cores).toFixed(2),
    memFreePct: Math.round((availMem() / totalmem()) * 100),
    diskFreeGB: Math.round(free / 1e9), diskFreePct: Math.round((free / total) * 100),
  };
}

/** How many agents may run concurrently right now. */
export function allowedParallel(s: Stats, cfg: Cfg, running: number): number {
  const max = cfg.host?.max_parallel ?? Math.max(2, Math.floor(s.cores / 3));
  const r = cfg.resources ?? {};
  // load from our own running agents is expected; judge headroom by load beyond that
  if (s.memFreePct < (r.mem_min_pct ?? 10) || s.diskFreeGB < (r.disk_hard_min_gb ?? 5)) return Math.min(running, 1) || 0;
  if (s.loadRatio > (r.load_high ?? 0.9)) return Math.max(1, Math.min(running, max - 1));
  if (s.loadRatio > (r.load_mid ?? 0.7)) return Math.max(1, Math.ceil(max / 2));
  return max;
}

/** Heavy tasks (benchmarks, full builds, perf validation) only start with real headroom. */
export const canRunHeavy = (s: Stats, cfg: Cfg, running: number) =>
  s.loadRatio < (cfg.resources?.heavy_max_load ?? 0.5) && s.memFreePct > 25 && running < 2;

/** CPU budget handed to each agent through env + prompt. */
export function budget(s: Stats, running: number, heavy: boolean) {
  const idle = Math.max(1, Math.floor(s.cores * (1 - Math.min(s.loadRatio, 0.95))));
  const jobs = heavy ? Math.max(2, idle) : Math.max(1, Math.floor(idle / Math.max(1, running)));
  return {
    jobs,
    env: {
      CARGO_BUILD_JOBS: String(jobs), RUST_TEST_THREADS: String(jobs), MAKEFLAGS: `-j${jobs}`,
      NEXTEST_TEST_THREADS: String(jobs), GOMAXPROCS: String(jobs), CMAKE_BUILD_PARALLEL_LEVEL: String(jobs),
      UV_THREADPOOL_SIZE: String(Math.min(jobs, 8)),
    },
    note: `You have a CPU budget of ${jobs} jobs (env CARGO_BUILD_JOBS etc. already set). Host load ${s.load1}/${s.cores} cores, `
      + `mem free ${s.memFreePct}%, disk free ${s.diskFreeGB}GB. Do not override the budget; prefer \`cargo test -p <crate>\` / targeted tests `
      + `over whole-workspace runs unless the task is explicitly heavy. Never start background servers you do not stop.`,
  };
}

// ------------------------------------------------------------------ disk cleanup
const sizeOf = async (p: string) => {
  const r = await $`du -sk ${p}`.quiet().nothrow();
  return parseInt(r.stdout.toString()) * 1024 || 0;
};
const ageDays = (p: string) => (Date.now() - statSync(p).mtimeMs) / 86400e3;
const gb = (b: number) => (b / 1e9).toFixed(1);

function workRepos(cfg: Cfg): string[] {
  const roots: string[] = (cfg.resources?.work_dirs ?? ["~/work"]).map((d: string) => d.replace(/^~/, homedir()));
  return roots.filter(existsSync).flatMap((r) => readdirSync(r).map((d) => join(r, d)))
    .filter((d) => existsSync(join(d, "target")) || existsSync(join(d, "node_modules")));
}

/** Last time a repo's sources were touched (git HEAD/index mtime). */
const repoActivity = (repo: string) =>
  Math.min(...[".git/index", ".git/HEAD", "Cargo.toml", "package.json"].map((f) => join(repo, f)).filter(existsSync).map(ageDays), 9999);

type Step = { name: string; run: () => Promise<number> };

function cleanupSteps(cfg: Cfg, busyRepos: Set<string>): Step[] {
  const staleDays = cfg.resources?.stale_repo_days ?? 7;
  const rm = async (p: string) => { const s = await sizeOf(p); rmSync(p, { recursive: true, force: true }); return s; };
  const repos = () => workRepos(cfg).filter((r) => ![...busyRepos].some((b) => b === r || b.startsWith(r + "/")));
  return [
    { name: "hub run logs > 14d", run: async () => {
      let n = 0; const d = P("logs", "runs");
      if (existsSync(d)) for (const f of readdirSync(d)) if (ageDays(join(d, f)) > 14) n += await rm(join(d, f));
      return n; } },
    { name: "rust incremental caches", run: async () => {
      let n = 0;
      for (const r of repos()) for (const prof of ["debug", "release"]) {
        const inc = join(r, "target", prof, "incremental");
        if (existsSync(inc)) n += await rm(inc);
      }
      return n; } },
    { name: `target/ of repos idle > ${staleDays}d`, run: async () => {
      let n = 0;
      for (const r of repos()) if (existsSync(join(r, "target")) && repoActivity(r) > staleDays) n += await rm(join(r, "target"));
      return n; } },
    { name: "temp files > 3d", run: async () => {
      let n = 0;
      for (const t of [tmpdir(), join(tmpdir(), `claude-${process.getuid?.() ?? ""}`)]) {
        if (!existsSync(t)) continue;
        for (const f of readdirSync(t)) {
          const p = join(t, f);
          // never touch live sockets/session dirs (tmux, ssh-agent, Claude scratchpads, X) and don't follow symlinks
          if (/^(tmux-|ssh-|claude-|\.X|\.ICE|systemd-|agent-hub|noop)/.test(f)) continue;
          try { const st = lstatSync(p); if (!st.isFile() && !st.isDirectory()) continue;
            if (st.uid === process.getuid?.() && ageDays(p) > 3) n += await rm(p); } catch {}
        }
      }
      return n; } },
    { name: "package manager caches", run: async () => {
      let n = 0;
      for (const [cache, cmd] of [
        [join(homedir(), ".bun/install/cache"), ["bun", "pm", "cache", "rm"]],
        [join(homedir(), ".cache/pnpm"), null],
        [join(homedir(), ".npm/_cacache"), ["npm", "cache", "clean", "--force"]],
      ] as const) {
        if (!existsSync(cache)) continue;
        const before = await sizeOf(cache);
        if (cmd && Bun.which(cmd[0])) await $`${cmd}`.quiet().nothrow(); else rmSync(cache, { recursive: true, force: true });
        n += before - (existsSync(cache) ? await sizeOf(cache) : 0);
      }
      return n; } },
    { name: "target/ of all non-busy repos", run: async () => {
      let n = 0;
      for (const r of repos()) if (existsSync(join(r, "target")) && repoActivity(r) > 1) n += await rm(join(r, "target"));
      return n; } },
  ];
}

let lastCleanup = 0;

/** Runs tiered cleanup until disk is back above target. Returns a human summary or null if nothing needed. */
export async function ensureDisk(cfg: Cfg, host: string, busyRepos: Set<string>, alert: (t: string) => Promise<unknown>) {
  const r = cfg.resources ?? {};
  const low = (s: Stats) => s.diskFreeGB < (r.disk_min_gb ?? 30) || s.diskFreePct < (r.disk_min_pct ?? 10);
  let s = sample(cfg);
  if (!low(s) || Date.now() - lastCleanup < 30 * 60_000) return null;
  lastCleanup = Date.now();
  const lines: string[] = [];
  let total = 0;
  for (const step of cleanupSteps(cfg, busyRepos)) {
    const freed = await step.run().catch(() => 0);
    total += freed;
    if (freed > 1e8) lines.push(`${step.name}: ${gb(freed)}GB`);
    s = sample(cfg);
    if (!low(s)) break;
  }
  const msg = `🧹 disk cleanup freed ${gb(total)}GB → ${s.diskFreeGB}GB free (${lines.join("; ") || "nothing big"})`;
  journal(host, msg);
  if (low(s)) await alert(`⚠️ ${host} is still low on disk: ${s.diskFreeGB}GB left (${s.diskFreePct}%) after cleaning up as much as it could (${gb(total)}GB). Needs your attention.`);
  return msg;
}
