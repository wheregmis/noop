import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import * as core from "../src/core";
import { allowedParallel, budget, canRunHeavy, ensureDisk, sample, type Stats } from "../src/resources";

let root = "", home = "", temporary = "", disk = "", clock = Date.now();
const mocks: { mockRestore(): unknown }[] = [];
const keep = <T extends { mockRestore(): unknown }>(mock: T): T => { mocks.push(mock); return mock; };
const capacity = (available = 1_000_000_000) => ({ bsize: 1, bavail: available, blocks: 100_000_000_000 }) as fs.StatsFs;
const fakeDisk = (read: () => fs.StatsFs) => keep(spyOn(fs, "statfsSync").mockImplementation(read as unknown as typeof fs.statfsSync));
beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), "noop-resources-")); home = join(root, "home"); temporary = join(root, "temp"); disk = join(root, "monitored");
  for (const path of [home, temporary, disk]) fs.mkdirSync(path);
  fs.rmSync(core.P("logs/runs"), { recursive: true, force: true });
  clock += 31 * 60_000; keep(spyOn(Date, "now").mockReturnValue(clock));
});
afterEach(() => { for (const mock of mocks.reverse()) mock.mockRestore(); mocks.length = 0; fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(core.P("logs/runs"), { recursive: true, force: true }); });
function isolatedHomes() {
  keep(spyOn(os, "homedir").mockReturnValue(home)); keep(spyOn(os, "tmpdir").mockReturnValue(temporary));
}
function old(path: string, text = "fixture") {
  fs.mkdirSync(join(path, ".."), { recursive: true }); fs.writeFileSync(path, text);
  const time = new Date(clock - 20 * 86400_000); fs.utimesSync(path, time, time); return path;
}
const cfg = () => ({ resources: { disk_path: disk, work_dirs: [] } });

test("disk samples measure the exact local path, home default, tilde and filesystem root", () => {
  for (const [configured, expected] of [[disk, disk], [null, os.homedir()], ["~", os.homedir()], ["/", "/"]] as const) {
    const stats = sample({ resources: { disk_path: configured } }); expect(stats.diskPath).toBe(expected); expect(stats.diskError).toBeUndefined();
    expect(Number.isFinite(stats.diskFreeGB)).toBe(true); expect(Number.isFinite(stats.diskFreePct)).toBe(true);
  }
  isolatedHomes(); fs.mkdirSync(join(home, "volume")); expect(sample({ resources: { disk_path: "~/volume" } }).diskPath).toBe(join(home, "volume"));
});

test("invalid or unavailable paths never fall back to another disk or throw from sampling", () => {
  const statfs = keep(spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("private raw path and underlying failure"); }));
  const stats = sample(cfg()); expect(stats).toMatchObject({ diskPath: disk, diskFreeGB: 0, diskFreePct: 0 }); expect(stats.diskError).toContain("Disk measurement unavailable"); expect(JSON.stringify(stats)).not.toContain("private raw");
  expect(statfs.mock.calls.map((call) => call[0])).toEqual([disk]);
  statfs.mockRestore(); mocks.splice(mocks.indexOf(statfs), 1);
  for (const path of [join(root, "missing"), "relative", "~/../other-volume", "", "~other"])
    expect(sample({ resources: { disk_path: path } }).diskError).toBeDefined();
  for (const path of [false, 42, {}, []]) expect(sample({ resources: { disk_path: path } }).diskError).toBeDefined();
});

test("invalid filesystem capacity stays unavailable rather than producing NaN or measured zero space", () => {
  const probe = keep(spyOn(fs, "statfsSync"));
  for (const patch of [{ blocks: 0 }, { blocks: Infinity }, { bsize: 0 }, { bsize: -1 }, { bavail: NaN }]) {
    probe.mockReturnValue({ ...capacity(), ...patch });
    const stats = sample(cfg()); expect(stats.diskError).toBeDefined(); expect(stats.diskFreeGB).toBe(0); expect(Number.isFinite(stats.diskFreePct)).toBe(true);
  }
});

test("unavailable disk telemetry admits no new or heavy tasks and budgets explicitly say unavailable", () => {
  const stats: Stats = { cores: 8, load1: 0, loadRatio: 0, memFreePct: 80, diskFreeGB: 0, diskFreePct: 0, diskPath: disk, diskError: "Disk measurement unavailable" };
  expect(allowedParallel(stats, { host: { max_parallel: 8 } }, 0)).toBe(0); expect(allowedParallel(stats, {}, 2)).toBe(2); expect(canRunHeavy(stats, {}, 0)).toBe(false);
  expect(budget(stats, 1, false).note).toContain("disk measurement unavailable"); expect(budget(stats, 1, false).note).not.toContain("disk free 0GB");
  expect(budget({ ...stats, diskError: undefined, diskFreeGB: 100 }, 1, false).note).toContain("disk free 100GB");
});

test("unavailable initial measurement performs no cleanup scanning, deletion, journal or alert on repeated checks", async () => {
  isolatedHomes(); keep(spyOn(fs, "statfsSync").mockImplementation(() => { throw new Error("fixture unavailable"); }));
  const scan = keep(spyOn(fs, "readdirSync")), remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})), journal = keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  for (let pass = 0; pass < 3; pass++) expect(await ensureDisk(cfg(), "fixture", new Set(), async () => { alerts++; })).toBeNull();
  expect(scan).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(alerts).toBe(0);
});

test("measurement loss after a cleanup step stops later tiers without deleting or reporting false low space", async () => {
  isolatedHomes(); let reads = 0; fakeDisk(() => { if (++reads > 1) throw new Error("fixture volume disconnected"); return capacity(); });
  const remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})), journal = keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  expect(await ensureDisk(cfg(), "fixture", new Set(), async () => { alerts++; })).toBeNull(); expect(remove).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(alerts).toBe(0);
});

test("a different monitored filesystem never deletes home logs work caches temp files or package caches", async () => {
  isolatedHomes(); const log = old(core.P("logs/runs/old.log")), repo = join(root, "work/repo"), target = old(join(repo, "target/debug/incremental/state"));
  const scratch = old(join(temporary, "old-fixture")), caches = [".bun/install/cache", ".cache/pnpm", ".npm/_cacache"].map((path) => old(join(home, path, "fixture")));
  keep(spyOn(fs, "statfsSync").mockReturnValue(capacity())); const stat = fs.statSync;
  keep(spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, options?: any) => { const result = stat(path, options); return String(path) === disk ? { ...result, dev: -1 } : result; }) as typeof fs.statSync));
  const remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})), journal = keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  const config = { resources: { disk_path: disk, work_dirs: [join(root, "work")] } };
  await ensureDisk(config, "fixture", new Set(), async () => { alerts++; });
  expect(remove).not.toHaveBeenCalled(); for (const path of [log, target, scratch, ...caches]) expect(fs.existsSync(path)).toBe(true);
  expect(alerts).toBe(1); expect(journal).toHaveBeenCalledTimes(1);
  expect(await ensureDisk(config, "fixture", new Set(), async () => { alerts++; })).toBeNull(); expect(alerts).toBe(1);
});

test("same-filesystem cleanup removes only an isolated old log and stops when disk recovers", async () => {
  isolatedHomes(); const path = old(core.P("logs/runs/old.log")); let reads = 0;
  fakeDisk(() => capacity(++reads < 4 ? 1_000_000_000 : 80_000_000_000));
  const remove = fs.rmSync, removed: string[] = [];
  keep(spyOn(fs, "rmSync").mockImplementation((target, options) => { if (String(target) !== path) throw new Error("Refusing cleanup outside the isolated fixture"); removed.push(String(target)); return remove(target, options); }));
  keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  expect(await ensureDisk(cfg(), "fixture", new Set(), async () => { alerts++; })).toContain("disk cleanup freed");
  expect(removed).toEqual([path]); expect(fs.existsSync(path)).toBe(false); expect(alerts).toBe(0);
});

test("a nested foreign mount prevents recursive removal of its whole cleanup tree", async () => {
  isolatedHomes(); const folder = core.P("logs/runs/old-tree"), child = old(join(folder, "foreign/keep")); const time = new Date(clock - 20 * 86400_000); fs.utimesSync(folder, time, time);
  keep(spyOn(fs, "statfsSync").mockReturnValue(capacity())); const lstat = fs.lstatSync;
  keep(spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: any) => { const result = lstat(path, options); return String(path) === join(folder, "foreign") ? { ...result, dev: -1 } : result; }) as typeof fs.lstatSync));
  const remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})); keep(spyOn(core, "journal").mockImplementation(() => {}));
  await ensureDisk(cfg(), "fixture", new Set(), async () => {}); expect(remove).not.toHaveBeenCalled(); expect(fs.existsSync(child)).toBe(true);
});

test("a disk disconnect during size measurement prevents the pending deletion and all later cleanup", async () => {
  isolatedHomes(); const path = old(core.P("logs/runs/old.log")); let reads = 0;
  fakeDisk(() => { if (++reads > 2) throw new Error("fixture disconnected during du"); return capacity(); });
  const remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})), journal = keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  expect(await ensureDisk(cfg(), "fixture", new Set(), async () => { alerts++; })).toBeNull(); expect(fs.existsSync(path)).toBe(true); expect(remove).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(alerts).toBe(0);
});

test("one unavailable measurement latches cleanup off for the rest of that pass even if the next probe recovers", async () => {
  isolatedHomes(); const first = old(core.P("logs/runs/first.log")), second = old(core.P("logs/runs/second.log")); let reads = 0;
  fakeDisk(() => { if (++reads === 2) throw new Error("fixture transient disconnect"); return capacity(); });
  const remove = keep(spyOn(fs, "rmSync").mockImplementation(() => {})), journal = keep(spyOn(core, "journal").mockImplementation(() => {})); let alerts = 0;
  expect(await ensureDisk(cfg(), "fixture", new Set(), async () => { alerts++; })).toBeNull(); expect(remove).not.toHaveBeenCalled(); expect(fs.existsSync(first)).toBe(true); expect(fs.existsSync(second)).toBe(true); expect(journal).not.toHaveBeenCalled(); expect(alerts).toBe(0);
});
