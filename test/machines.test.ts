import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { P, heartbeat, hostCaps, loadConfig, pickTask, schedulableHosts } from "../src/core";
import { machineRoute, machineConfigurationRoute, configurationView, recordRequest, status, taskView } from "../src/server";
import { allowedParallel } from "../src/resources";

beforeEach(() => {
  rmSync(P("fleet"), { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true });
  mkdirSync(P("journal"), { recursive: true });
  mkdirSync(P("fleet", "hosts"), { recursive: true });
  mkdirSync(P("agents", "lead"), { recursive: true });
  writeFileSync(P("agents", "lead", "profile.md"), "# Lead\n");
  writeFileSync(P("config.toml"), "[host]\nmax_parallel = 4\n");
  writeFileSync(P("config.local.toml"), "[host]\nname = 'local-mac'\nmax_parallel = 5\ncaps = ['home']\n");
  for (const host of ["local-mac", "worker", "old-linux"]) writeFileSync(P("fleet", "hosts", `${host}.json`), JSON.stringify({ host, caps: [host === "old-linux" ? "os:linux" : "os:macos"],
    seen: host === "old-linux" ? "2020-01-01T00:00:00Z" : new Date().toISOString(), busy: 0, version: "1", enabled: true, max_parallel: 5, custom_caps: ["home"] }));
});
const request = (name: string, body?: unknown) => machineRoute(new Request(`http://hub/api/machines/${name}`, { method: body === undefined ? "GET" : "PUT", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), name, { pull: async () => true, push: async () => true });

test("machine overrides sync to one host, govern parallelism, and preserve detected OS and tools", async () => {
  expect((await request("worker", { enabled: false, max_parallel: 2, caps: ["docker"] })).status).toBe(200);
  expect(loadConfig().host.max_parallel).toBe(5); // the local host keeps its own limit
  expect(schedulableHosts(loadConfig()).map((h) => h.host)).toEqual(["local-mac"]);
  const value = { enabled: false, max_parallel: 3, caps: ["docker", "gpu"] };
  expect((await request("local-mac", value)).status).toBe(200);
  const cfg = loadConfig();
  expect(cfg.host).toMatchObject(value);
  expect(pickTask(cfg)).toBeNull();
  const stats = { cores: 12, load1: 0, loadRatio: 0, memFreePct: 80, diskFreeGB: 100, diskFreePct: 70 };
  expect(allowedParallel(stats, cfg, 0)).toBe(3);
  const caps = hostCaps(cfg);
  expect(caps).toContain(process.platform === "darwin" ? "os:macos" : process.platform === "win32" ? "os:windows" : "os:linux");
  expect(caps).toEqual(expect.arrayContaining(["docker", "gpu"]));
  heartbeat(cfg, 1);
  expect(JSON.parse(readFileSync(P("fleet", "hosts", "local-mac.json"), "utf8"))).toMatchObject({ enabled: false, max_parallel: 3, custom_caps: ["docker", "gpu"], busy: 1 });
  expect((await request("local-mac", { ...value, enabled: true, max_parallel: null })).status).toBe(200);
  expect(loadConfig().host.max_parallel).toBeNull();
  expect(schedulableHosts(loadConfig()).map((h) => h.host)).toEqual(["local-mac"]);
});

test("offline machines remain visible and configurable but cannot satisfy placement", async () => {
  expect(status().offline_hosts.map((h) => h.host)).toEqual(["old-linux"]);
  expect(status().hosts.some((h) => h.host === "old-linux")).toBe(false);
  expect((await request("old-linux", { enabled: false, max_parallel: 1, caps: [] })).status).toBe(200);
  expect(await (await request("old-linux")).json()).toMatchObject({ host: "old-linux", enabled: false, max_parallel: 1 });
  expect(schedulableHosts(loadConfig()).some((h) => h.host === "old-linux")).toBe(false);
});

test("machine form rejects invalid limits and invented detected capabilities", async () => {
  for (const body of [{ enabled: "no", max_parallel: 2, caps: [] }, { enabled: true, max_parallel: 0, caps: [] }, { enabled: true, max_parallel: 33, caps: [] },
    { enabled: true, max_parallel: 2, caps: ["os:windows"] }, { enabled: true, max_parallel: 2, caps: ["cli:claude"] }, { enabled: true, max_parallel: 2, caps: ["bad\nlabel"] }])
    expect((await request("local-mac", body)).status).toBe(400);
  expect((await request("unknown", { enabled: true, max_parallel: 2, caps: [] })).status).toBe(404);
  expect((await request("constructor")).status).toBe(400);
});

test("a parked task with no special capabilities still asks for a machine accepting tasks", () => {
  writeFileSync(P("paused-task.md"), "---\nid: T-0998\nparked: now\nhost: any\n---\nReview.\n");
  expect(taskView(P("paused-task.md"), "inbox", [])).toMatchObject({ state: "nohost", needs: "accepting-tasks" });
});


const resources = (name: string, body?: unknown, io = { pull: async () => true, push: async () => true }) => machineConfigurationRoute(new Request(`http://hub/api/machines/${name}/configuration`, {
  method: body === undefined ? "GET" : "PUT", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), name, io);
test("machine resources override only that machine, preserve run settings, and stay out of the fleet form", async () => {
  await request("local-mac", { enabled: true, max_parallel: 2, caps: ["gpu"] });
  expect((await resources("local-mac", { values: { "resources.mem_min_pct": 35, "resources.work_dirs": ["~/projects"], "resources.cleanup_enabled": false } })).status).toBe(200);
  expect(loadConfig().resources).toMatchObject({ mem_min_pct: 35, work_dirs: ["~/projects"], cleanup_enabled: false });
  expect(configurationView().values["resources.mem_min_pct"]).toBe(10);
  expect(loadConfig().host.max_parallel).toBe(2);
  await request("local-mac", { enabled: false, max_parallel: 3, caps: [] });
  expect(loadConfig().resources.mem_min_pct).toBe(35);
  heartbeat(loadConfig(), 0);
  const beat = JSON.parse(readFileSync(P("fleet", "hosts", "local-mac.json"), "utf8"));
  expect(beat.resource_defaults["resources.mem_min_pct"]).toBe(10);
  expect(JSON.stringify(beat.resource_defaults)).not.toContain("server.token");
  expect((await resources("local-mac", { reset: ["resources.mem_min_pct", "resources.work_dirs", "resources.cleanup_enabled"] })).status).toBe(200);
  expect(loadConfig().resources?.mem_min_pct).toBeUndefined();
  expect(loadConfig().host.enabled).toBe(false);
});
test("remote resources use the worker's file defaults and the latest shared choices, even while offline", async () => {
  const f = P("fleet", "hosts", "old-linux.json");
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), resource_defaults: { "resources.mem_min_pct": 25, "resources.work_dirs": ["/srv/work"], "resources.load_mid": 0.4, "resources.load_high": 0.6 } }));
  expect((await resources("worker")).status).toBe(409); // an older worker must report its own values first
  let view = await (await resources("old-linux")).json() as any;
  expect(view.values).toMatchObject({ "resources.mem_min_pct": 25, "resources.work_dirs": ["/srv/work"] });
  expect((await resources("old-linux", { values: { "resources.load_mid": 0.7 } })).status).toBe(400);
  expect((await resources("old-linux", { values: { "resources.mem_min_pct": 40 } })).status).toBe(200);
  expect(loadConfig().resources?.mem_min_pct).toBeUndefined();
  const settings = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  settings.configuration = { resources: { mem_min_pct: 30 } }; writeFileSync(P("settings.json"), JSON.stringify(settings));
  await resources("old-linux", { reset: ["resources.mem_min_pct"] });
  view = await (await resources("old-linux")).json() as any;
  expect(view.values["resources.mem_min_pct"]).toBe(30);
  delete settings.configuration; settings.machines["old-linux"].resources = {}; writeFileSync(P("settings.json"), JSON.stringify(settings));
  expect((await (await resources("old-linux")).json() as any).values["resources.mem_min_pct"]).toBe(25);
  expect((await recordRequest(new Request("http://hub/api/machines/old-linux/configuration"))).status).toBe(200);
});
test("machine resource forms reject unrelated settings and preserve data when syncing fails", async () => {
  for (const body of [{ values: { "autonomy.level": "autonomous" } }, { values: { "resources.mem_min_pct": 0 } }, { reset: ["clis.timeout_minutes"] }, { values: [] }, { reset: "resources.mem_min_pct" }, { values: { "resources.work_dirs": ["/"] } }])
    expect((await resources("local-mac", body)).status).toBe(400);
  expect((await resources("constructor")).status).toBe(400);
  expect((await resources("local-mac", { values: { "resources.mem_min_pct": 20 } }, { pull: async () => false, push: async () => true })).status).toBe(503);
  expect((await resources("local-mac", { values: { "resources.mem_min_pct": 20 } }, { pull: async () => true, push: async () => false })).status).toBe(503);
});

test("machine learning paths and digest limits stay scoped and report only their own file defaults", async () => {
  writeFileSync(P("config.local.toml"), "[host]\nname = 'local-mac'\n[learn]\nclaude_dir = '/Users/local/history'\nmax_digest_chars = 250000\n");
  const before = await (await resources("local-mac")).json() as any;
  expect(before.learning_supported).toBe(true);
  expect(before.values).toMatchObject({ "learn.claude_dir": "/Users/local/history", "learn.codex_dir": null, "learn.hermes_db": null, "learn.max_digest_chars": 250_000 });
  const values = { "learn.claude_dir": "~/private/claude", "learn.codex_dir": "/data/codex sessions", "learn.hermes_db": "/data/hermes/state.db", "learn.max_digest_chars": 100_000 };
  expect((await resources("local-mac", { values })).status).toBe(200);
  expect(loadConfig().learn).toMatchObject({ claude_dir: "~/private/claude", codex_dir: "/data/codex sessions", hermes_db: "/data/hermes/state.db", max_digest_chars: 100_000 });
  expect(loadConfig().host.learn).toBeUndefined();
  expect(configurationView().values).not.toHaveProperty("learn.claude_dir");
  heartbeat(loadConfig(), 0);
  const beat = JSON.parse(readFileSync(P("fleet/hosts/local-mac.json"), "utf8"));
  expect(beat.learning_defaults).toEqual({ "learn.claude_dir": "/Users/local/history", "learn.codex_dir": null, "learn.hermes_db": null, "learn.max_digest_chars": 250_000 });
  expect(JSON.stringify(beat.learning_defaults)).not.toContain("private/claude");
  expect((await resources("local-mac", { values: { "learn.claude_dir": null } })).status).toBe(200);
  expect(loadConfig().learn.claude_dir).toBeNull();
  expect((await (await resources("local-mac")).json() as any).values["learn.claude_dir"]).toBeNull();
  await resources("local-mac", { reset: ["learn.claude_dir", "learn.max_digest_chars"] });
  expect(loadConfig().learn).toMatchObject({ claude_dir: "/Users/local/history", max_digest_chars: 250_000 });
  expect(loadConfig().learn.codex_dir).toBe("/data/codex sessions");
});

test("offline machine learning uses that worker's defaults and older reports still support resource edits", async () => {
  const file = P("fleet/hosts/old-linux.json"), beat = JSON.parse(readFileSync(file, "utf8"));
  beat.resource_defaults = {}; writeFileSync(file, JSON.stringify(beat));
  let view = await (await resources("old-linux")).json() as any;
  expect(view.learning_supported).toBe(false); expect(view.values).not.toHaveProperty("learn.claude_dir");
  expect((await resources("old-linux", { values: { "resources.mem_min_pct": 30 } })).status).toBe(200);
  expect((await resources("old-linux", { values: { "learn.claude_dir": "/srv/history" } })).status).toBe(409);
  beat.learning_defaults = { "learn.claude_dir": "/srv/claude", "learn.codex_dir": "/srv/codex", "learn.hermes_db": null, "learn.max_digest_chars": 120_000 };
  writeFileSync(file, JSON.stringify(beat));
  view = await (await resources("old-linux")).json() as any;
  expect(view.learning_supported).toBe(true);
  expect(view.values).toMatchObject(beat.learning_defaults);
  expect((await resources("old-linux", { values: { "learn.codex_dir": "/mnt/private/codex" } })).status).toBe(200);
  expect(loadConfig().learn?.codex_dir).toBeUndefined();
  view = await (await resources("old-linux")).json() as any;
  expect(view.values["learn.codex_dir"]).toBe("/mnt/private/codex");
  await resources("old-linux", { reset: ["learn.codex_dir"] });
  expect((await (await resources("old-linux")).json() as any).values["learn.codex_dir"]).toBe("/srv/codex");
});

test("machine learning validates paths and character bounds without allowing source or credential changes", async () => {
  for (const path of ["relative/history", "~/../secrets", "/", "~", "$HOME/history", "C:\\%USERNAME%\\history", "/tmp/$(whoami)", "/tmp/`whoami`", "/tmp/bad\npath", "/tmp/trailing\n", 1, []])
    expect((await resources("local-mac", { values: { "learn.claude_dir": path } })).status).toBe(400);
  for (const value of [0, -1, 9999, 2_000_001, 10000.1, "100000"])
    expect((await resources("local-mac", { values: { "learn.max_digest_chars": value } })).status).toBe(400);
  for (const path of ["learn.enabled", "learn.sources", "learn.token", "server.token"])
    expect((await resources("local-mac", { values: { [path]: [] } })).status).toBe(400);
  expect((await resources("local-mac", { values: { "learn.codex_dir": "C:\\Users\\Owner\\Codex", "learn.hermes_db": "\\\\server\\share\\state.db", "learn.claude_dir": "", "learn.max_digest_chars": 10_000 } })).status).toBe(200);
  expect(loadConfig().learn.claude_dir).toBeNull();
});

test("disk monitoring paths stay machine-local and reset to each machine's reported default", async () => {
  writeFileSync(P("config.local.toml"), "[host]\nname = 'local-mac'\n[resources]\ndisk_path = '/Volumes/main-data'\n");
  const worker = P("fleet/hosts/worker.json"), beat = JSON.parse(readFileSync(worker, "utf8"));
  writeFileSync(worker, JSON.stringify({ ...beat, disk_path_supported: true, resource_defaults: { "resources.disk_path": "/srv/worker-data" } }));
  expect((await (await resources("local-mac")).json() as any)).toMatchObject({ disk_path_supported: true, values: { "resources.disk_path": "/Volumes/main-data" } });
  expect((await (await resources("worker")).json() as any)).toMatchObject({ disk_path_supported: true, values: { "resources.disk_path": "/srv/worker-data" } });
  expect((await resources("worker", { values: { "resources.disk_path": "~/work" } })).status).toBe(200);
  expect(loadConfig().resources.disk_path).toBe("/Volumes/main-data");
  expect((await resources("local-mac", { values: { "resources.disk_path": "/" } })).status).toBe(200);
  expect(loadConfig().resources.disk_path).toBe("/");
  expect(configurationView().values).not.toHaveProperty("resources.disk_path");
  expect(loadConfig(false).resources.disk_path).toBe("/Volumes/main-data");
  heartbeat(loadConfig(), 0);
  expect(JSON.parse(readFileSync(P("fleet/hosts/local-mac.json"), "utf8"))).toMatchObject({ disk_path_supported: true, resource_defaults: { "resources.disk_path": "/Volumes/main-data" } });
  await resources("worker", { reset: ["resources.disk_path"] });
  expect((await (await resources("worker")).json() as any).values["resources.disk_path"]).toBe("/srv/worker-data");
  expect((await resources("local-mac", { values: { "resources.disk_path": null } })).status).toBe(200);
  expect(loadConfig().resources.disk_path).toBeNull();
  await resources("local-mac", { reset: ["resources.disk_path"] });
  expect(loadConfig().resources.disk_path).toBe("/Volumes/main-data");
});

test("disk path roots are accepted without relaxing history path or shell-expression validation", async () => {
  for (const path of [null, "", "/", "~", "~/", "~/work", "C:\\", "C:/", "\\\\server\\share", "/Volumes/Work Disk"])
    expect((await resources("local-mac", { values: { "resources.disk_path": path } })).status).toBe(200);
  const before = readFileSync(P("settings.json"), "utf8");
  for (const path of ["work", "~user/work", "~/../work", "/work/../data", "C:\\work\\..\\data", "$HOME/work", "C:\\%USERPROFILE%\\work", "/tmp/$(whoami)", "/tmp/`whoami`", "/bad\npath", 1, []]) {
    expect((await resources("local-mac", { values: { "resources.disk_path": path } })).status).toBe(400);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  expect((await resources("local-mac", { values: { "learn.claude_dir": "/" } })).status).toBe(400);
  expect((await resources("local-mac", { values: { "learn.codex_dir": "~" } })).status).toBe(400);
});

test("older disk reports omit unsupported controls and preserve existing overrides during other edits", async () => {
  const file = P("fleet/hosts/old-linux.json"), beat = JSON.parse(readFileSync(file, "utf8"));
  beat.resource_defaults = {}; writeFileSync(file, JSON.stringify(beat));
  writeFileSync(P("settings.json"), JSON.stringify({ machines: { "old-linux": { resources: { disk_path: "/old/saved", cleanup_enabled: false }, learn: { codex_dir: "/private/history" }, caps: ["docker"] } },
    configuration: { resources: { disk_path: "/must-not-be-a-worker-default", mem_min_pct: 20 } } }));
  const view = await (await resources("old-linux")).json() as any;
  expect(view.disk_path_supported).toBe(false);
  expect(view.values).not.toHaveProperty("resources.disk_path");
  expect(view.overrides).not.toContain("resources.disk_path");
  for (const body of [{ values: { "resources.disk_path": "/" } }, { reset: ["resources.disk_path"] }]) {
    const response = await resources("old-linux", body);
    expect(response.status).toBe(409); expect((await response.json() as any).error).toContain("Update this machine");
  }
  await resources("old-linux", { reset: ["resources.cleanup_enabled"] });
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).machines["old-linux"]).toEqual({ resources: { disk_path: "/old/saved" }, learn: { codex_dir: "/private/history" }, caps: ["docker"] });
  beat.disk_path_supported = true; beat.resource_defaults["resources.disk_path"] = null; writeFileSync(file, JSON.stringify(beat));
  await resources("old-linux", { reset: ["resources.disk_path"] });
  expect((await (await resources("old-linux")).json() as any).values["resources.disk_path"]).toBeNull();
  delete beat.resource_defaults["resources.disk_path"]; writeFileSync(file, JSON.stringify(beat));
  expect((await (await resources("old-linux")).json() as any).disk_path_supported).toBe(false);
});
