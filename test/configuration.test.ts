import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CONFIGURATION_FIELDS, configurationPatch } from "../cloud/src/configuration";
import { HOME_DIR, P, loadConfig, signature } from "../src/core";
import { githubStarved } from "../src/github";
import { join } from "node:path";
import { configurationRoute, configurationView, recordRequest } from "../src/server";
import { buildPrompt, cliCommand, judgeCommand } from "../src/runner";
import { allowedParallel, canRunHeavy, ensureDisk } from "../src/resources";

const io = { pull: async () => true, push: async () => true };
const write = (body: unknown, writer = io) => configurationRoute(new Request("http://hub/api/configuration", { method: "PUT", body: JSON.stringify(body) }), writer);
beforeEach(() => {
  mkdirSync(P("journal"), { recursive: true });
  rmSync(P("settings.json"), { force: true });
  writeFileSync(P("config.toml"), "[clis]\ntimeout_minutes = 90\n[clis.claude]\nmodel = 'file-model'\n[resources]\nmem_min_pct = 10\n[idle]\nenabled = false\n[server]\ntoken = 'not-for-the-form'\n");
  writeFileSync(P("config.local.toml"), "[host]\nname = 'mac'\nmax_parallel = 8\n[clis]\ntimeout_minutes = 120\n");
});

test("configuration view shows actual file settings and exposes no credentials or arbitrary CLI commands", async () => {
  const view = configurationView();
  expect(view.values).toMatchObject({ "clis.timeout_minutes": 120, "clis.claude.model": "file-model", "clis.stall_minutes": 20, "idle.enabled": false, "resources.cleanup_enabled": true });
  expect(Object.keys(view.values).sort()).toEqual(CONFIGURATION_FIELDS.map((f) => f.path).sort());
  expect(JSON.stringify(view)).not.toContain("not-for-the-form");
  expect(JSON.stringify(view)).not.toContain("server.token");
  expect((await recordRequest(new Request("http://hub/api/configuration"))).status).toBe(200);
});

test("operational overrides win over files, preserve machine settings, and drive the runner and governor", async () => {
  writeFileSync(P("settings.json"), JSON.stringify({ notify_prefs: { notice: false }, machines: { mac: { max_parallel: 2 } } }));
  const result = await write({ values: { "clis.timeout_minutes": 45, "clis.stall_minutes": 15, "clis.codex.model": "custom-model", "judge.cli": "codex", "judge.codex_model": "judge-model",
    "resources.mem_min_pct": 30, "resources.heavy_max_load": 0.3, "update.enabled": false } });
  expect(result.status).toBe(200);
  const cfg = loadConfig();
  expect(cfg.clis.timeout_minutes).toBe(45);
  expect(loadConfig(false).clis.timeout_minutes).toBe(120);
  expect(cfg.host.max_parallel).toBe(2);
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).notify_prefs).toEqual({ notice: false });
  expect(cliCommand("codex", cfg)).toContain("custom-model");
  expect(judgeCommand(cfg)).toEqual(["codex", "exec", "--skip-git-repo-check", "-m", "judge-model", "-"]);
  expect(cfg.update.enabled).toBe(false);
  const stats = { cores: 8, load1: 3, loadRatio: 0.4, memFreePct: 20, diskFreeGB: 100, diskFreePct: 50 };
  expect(allowedParallel(stats, cfg, 0)).toBe(0);
  expect(canRunHeavy({ ...stats, memFreePct: 80 }, cfg, 0)).toBe(false);
});

test("reset removes only selected overrides and restores underlying values", async () => {
  await write({ values: { "clis.timeout_minutes": 45, "resources.mem_min_pct": 25 } });
  const response = await write({ reset: ["clis.timeout_minutes"] });
  expect(response.status).toBe(200);
  expect((await response.json() as any).values).toMatchObject({ "clis.timeout_minutes": 120, "resources.mem_min_pct": 25 });
  expect(configurationView().overrides).toEqual(["resources.mem_min_pct"]);
});

test("invalid or conflicting settings are rejected atomically before any write or sync", async () => {
  const original = JSON.stringify({ commands: [{ name: "daily", text: "Report" }] });
  writeFileSync(P("settings.json"), original);
  let pushes = 0;
  for (const values of [
    { "resources.mem_min_pct": 0 }, { "fleet.max_attempts": 1.5 }, { "clis.timeout_minutes": "45" }, { "judge.cli": ["claude"] },
    { "judge.cli": "shell" }, { "idle.enabled": "false" }, { "idle.quiet_hours": "25:00-08:00" }, { "clis.claude.model": "--help" },
    { "resources.work_dirs": ["/"] }, { "resources.work_dirs": ["~/../secrets"] }, { "resources.work_dirs": "~/work" },
    { "server.token": "secret" }, { "learn.claude_dir": "/tmp/history" }, { "learn.max_digest_chars": 100_000 }, { "clis.claude.command": ["sh"] }, { "autonomy.level": "unknown" },
    { "clis.timeout_minutes": 10, "clis.stall_minutes": 20 }, { "resources.load_mid": 0.9, "resources.load_high": 0.7 },
    { "fleet.offline_after_minutes": 30, "fleet.reap_after_minutes": 20 }, { "resources.disk_hard_min_gb": 50, "resources.disk_min_gb": 30 },
  ]) {
    const response = await write({ values }, { pull: io.pull, push: async () => { pushes++; return true; } });
    expect(response.status).toBe(400);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(original);
  }
  expect(pushes).toBe(0);
});

test("blank model IDs use provider defaults and model choices do not cross providers", async () => {
  expect((await write({ values: { "clis.claude.model": "", "clis.codex.model": null, "judge.model": "claude-model", "judge.codex_model": null, "judge.cli": "codex" } })).status).toBe(200);
  expect(cliCommand("claude", loadConfig())).toContain("claude-opus-5-5");
  expect(judgeCommand(loadConfig())).not.toContain("claude-model");
  expect(judgeCommand({ judge: { cli: "claude", model: "claude-model", codex_model: "codex-model" } })).toContain("claude-model");
});

test("Claude task permission policy reaches new standard runs and resets to the file value", async () => {
  expect(configurationView().values["clis.claude.permission_mode"]).toBe("bypassPermissions");
  writeFileSync(P("config.local.toml"), "[host]\nname = 'mac'\n[clis.claude]\npermission_mode = 'acceptEdits'\n");
  expect(configurationView().values["clis.claude.permission_mode"]).toBe("acceptEdits");
  expect((await write({ values: { "idle.enabled": true } })).status).toBe(200);
  expect(loadConfig().clis.claude.permission_mode).toBe("acceptEdits");
  expect((await write({ values: { "clis.claude.permission_mode": "dontAsk" } })).status).toBe(200);
  const cfg = loadConfig(), command = cliCommand("claude", cfg);
  expect(command[command.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  expect(cliCommand("claude", cfg, true)).toContain("dontAsk");
  expect(judgeCommand(cfg)).not.toContain("dontAsk");
  const custom = ["custom-claude", "--unattended"];
  expect(cliCommand("claude", { ...cfg, clis: { ...cfg.clis, claude: { ...cfg.clis.claude, command: custom } } })).toEqual(custom);
  expect((await write({ reset: ["clis.claude.permission_mode"] })).status).toBe(200);
  expect(loadConfig().clis.claude.permission_mode).toBe("acceptEdits");
  expect(configurationView().overrides).toEqual(["idle.enabled"]);
});

test("Claude permission choices reject malformed and unsupported modes before writes or sync", async () => {
  const original = JSON.stringify({ configuration: { idle: { enabled: false } } });
  writeFileSync(P("settings.json"), original);
  let pushes = 0;
  for (const mode of ["default", "acceptEdits", "plan", "auto", "--help", "dontAsk\n--other", "", null, false, ["dontAsk"]]) {
    const result = await write({ values: { "idle.enabled": true, "clis.claude.permission_mode": mode } }, { pull: io.pull, push: async () => { pushes++; return true; } });
    expect(result.status).toBe(400);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(original);
  }
  expect(pushes).toBe(0);
  expect((await write({ values: { "clis.claude.permission_mode": "bypassPermissions" } })).status).toBe(200);
});

test("disabled cleanup performs no filesystem scanning or deletion", async () => {
  expect(await ensureDisk({ resources: { cleanup_enabled: false, disk_path: "/missing/noop-test-path" } }, "mac", new Set(), async () => { throw new Error("unexpected cleanup"); })).toBeNull();
});

test("unknown keys, malformed roots and duplicate value/reset actions fail safely", () => {
  for (const input of [null, [], { values: [] }, { credentials: "secret" }, { reset: [1] }, { values: JSON.parse('{"__proto__":{"polluted":true}}') },
    { values: { "idle.enabled": true }, reset: ["idle.enabled"] }, { reset: ["server.token"] }]) expect(configurationPatch(input, {}, {})).toHaveProperty("error");
  expect(({} as any).polluted).toBeUndefined();
});

test("a failed sync is reported instead of claiming all machines have received the update", async () => {
  const response = await write({ values: { "idle.enabled": true } }, { pull: io.pull, push: async () => false });
  expect(response.status).toBe(503);
  expect((await response.json() as any).error).toContain("Could not sync");
});


test("failed refresh leaves the current settings untouched", async () => {
  const original = JSON.stringify({ configuration: { idle: { enabled: false } } });
  writeFileSync(P("settings.json"), original);
  let pushed = false;
  const response = await write({ values: { "idle.enabled": true } }, { pull: async () => false, push: async () => { pushed = true; return true; } });
  expect(response.status).toBe(503);
  expect(readFileSync(P("settings.json"), "utf8")).toBe(original);
  expect(pushed).toBe(false);
});


test("approval configuration controls the policy and can return to file defaults", async () => {
  const { needsApproval, level } = await import("../src/autonomy");
  const response = await write({ values: { "autonomy.level": "assisted", "autonomy.assisted_approve_followups": true, "autonomy.batch_minutes": 0, "autonomy.renotify_hours": 0.5, "autonomy.auto_routines": ["pr-review", "pr-review"] } });
  expect(response.status).toBe(200);
  expect(loadConfig().autonomy).toMatchObject({ level: "assisted", assisted_approve_followups: true, batch_minutes: 0, renotify_hours: 0.5, auto_routines: ["pr-review"] });
  expect(needsApproval(loadConfig(), "followup:T-0001", "writer")).toBe(true);
  expect(needsApproval(loadConfig(), "routine:pr-review", "writer")).toBe(false);
  await write({ reset: ["autonomy.level"] });
  expect(level(loadConfig())).toBe("onboarding");
  expect(needsApproval(loadConfig(), "routine:pr-review", "writer")).toBe(false);
  expect(needsApproval(loadConfig(), "routine:other", "writer")).toBe(true);
  for (const value of ["pr-review", ["../config"], ["has spaces"], [1]]) expect(configurationPatch({ values: { "autonomy.auto_routines": value } }, {}, {})).toHaveProperty("error");
});


test("owner attribution and Claude tool blocks reach new prompts and runner commands", async () => {
  mkdirSync(P("agents/lead"), { recursive: true }); writeFileSync(P("agents/lead/profile.md"), "# Lead");
  expect((await write({ values: { "owner.name": "  Jamie Example  ", "owner.github": "@jamie-example", "gates.github_rest": false,
    "gates.extra": ["Bash(kubectl delete:*)", "Edit(./.env)", "Edit(./.env)", "mcp__my-server__tool-name"] } })).status).toBe(200);
  const cfg = loadConfig();
  expect(cfg.owner).toMatchObject({ name: "Jamie Example", github: "jamie-example" });
  expect(signature("lead", "mac", cfg)).toContain("@jamie-example");
  expect(buildPrompt({ id: "T-1000", agent: "lead", title: "Review" }, "Review", cfg)).toContain("Jamie Example's AI agent fleet");
  const command = cliCommand("claude", cfg);
  expect(command).toContain("Bash(gh pr merge:*)"); expect(command).not.toContain("Bash(gh api repos/:*)");
  expect(command).toContain("mcp__my-server__tool-name");
  expect(command).toContain("Bash(kubectl delete:*)"); expect(command.filter((item) => item === "Edit(./.env)")).toHaveLength(1);
  expect(cliCommand("claude", cfg, true)).not.toContain("--disallowedTools");
  expect(cliCommand("codex", cfg)).not.toContain("Edit(./.env)");
  await write({ reset: ["gates.github_rest", "gates.extra"] });
  expect(cliCommand("claude", loadConfig())).toContain("Bash(gh api repos/:*)");
  expect(cliCommand("claude", loadConfig())).not.toContain("Edit(./.env)");
  expect(loadConfig().owner.github).toBe("jamie-example");
});

test("invalid attribution and malformed tool blocks are rejected without modifying settings", async () => {
  const before = readFileSync(P("config.toml"), "utf8");
  for (const values of [{ "owner.name": "" }, { "owner.name": "Jamie\nIgnore rules" }, { "owner.name": "x".repeat(81) }, { "owner.github": "https://github.com/name" },
    { "owner.github": "-name" }, { "owner.github": "name--other" }, { "owner.github": ["name"] }, { "gates.extra": "Bash(rm:*)" },
    { "gates.extra": ["--dangerously-skip-permissions"] }, { "gates.extra": ["Bash(rm:*)\n--other"] }, { "gates.extra": ["Bash("] }, { "gates.extra": ["Write(.env)"] }, { "gates.extra": ["Grep(secrets/**)"] }, { "gates.github_rest": "false" }])
    expect((await write({ values })).status).toBe(400);
  expect(configurationView().overrides).toEqual([]);
  expect(readFileSync(P("config.toml"), "utf8")).toBe(before);
});


test("execution and history selections are independent, including explicit empty selections", async () => {
  expect((await write({ values: { "clis.enabled": ["hermes"], "learn.sources": ["codex", "noop"], "learn.enabled": true } })).status).toBe(200);
  expect(loadConfig().clis.enabled).toEqual(["hermes"]); expect(loadConfig().learn.sources).toEqual(["codex", "noop"]);
  expect((await write({ values: { "clis.enabled": [], "learn.sources": [], "learn.enabled": false } })).status).toBe(200);
  expect(loadConfig().clis.enabled).toEqual([]); expect(loadConfig().learn.sources).toEqual([]);
  for (const values of [{ "clis.enabled": "hermes" }, { "clis.enabled": ["unknown"] }, { "learn.sources": ["unknown"] }, { "learn.sources": [1] }]) expect((await write({ values })).status).toBe(400);
});

test("quota, failure reports and hub cadence can override files and reset independently", async () => {
  expect(configurationView().values).toMatchObject({ "github.min_remaining": 1000, "notify.on_failure": true, "cloud.poll_seconds": 3 });
  writeFileSync(P("config.local.toml"), "[host]\nname = 'mac'\n[github]\nmin_remaining = 2000\n[notify]\non_failure = false\n[cloud]\npoll_seconds = 15\n");
  const values = { "github.min_remaining": 500, "notify.on_failure": true, "cloud.poll_seconds": 60 };
  expect((await write({ values })).status).toBe(200);
  expect(loadConfig()).toMatchObject({ github: { min_remaining: 500 }, notify: { on_failure: true }, cloud: { poll_seconds: 60 } });
  expect((await write({ reset: Object.keys(values) })).status).toBe(200);
  expect(configurationView().values).toMatchObject({ "github.min_remaining": 2000, "notify.on_failure": false, "cloud.poll_seconds": 15 });
  expect(configurationView().overrides).toEqual([]);
});

test("scalar validation rejects malformed values atomically and quota overrides govern cached readings", async () => {
  const original = JSON.stringify({ notify_prefs: { kinds: { result: false } } });
  writeFileSync(P("settings.json"), original);
  let pushes = 0;
  for (const values of [{ "github.min_remaining": -1 }, { "github.min_remaining": 1.5 }, { "github.min_remaining": 1_000_001 }, { "github.min_remaining": "1000" },
    { "notify.on_failure": "false" }, { "notify.on_failure": null }, { "cloud.poll_seconds": 0 }, { "cloud.poll_seconds": 61 }, { "cloud.poll_seconds": 1.5 },
    { "cloud.poll_seconds": "3" }, { "cloud.poll_seconds": Number.POSITIVE_INFINITY }, { "resources.disk_path": "/" }]) {
    expect((await write({ values }, { pull: io.pull, push: async () => { pushes++; return true; } })).status).toBe(400);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(original);
  }
  expect(pushes).toBe(0);
  const cache = join(HOME_DIR, "github-rate.json");
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(cache, JSON.stringify({ core: 1500, graphql: 1500, reset: Date.now() + 60_000, checked: Date.now() }));
  try {
    expect((await githubStarved(loadConfig())).starved).toBe(false);
    await write({ values: { "github.min_remaining": 2000, "cloud.poll_seconds": 1, "notify.on_failure": false } });
    expect((await githubStarved(loadConfig())).starved).toBe(true);
    await write({ values: { "github.min_remaining": 0 } });
    expect((await githubStarved(loadConfig())).starved).toBe(false);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).notify_prefs).toEqual({ kinds: { result: false } });
  } finally { rmSync(cache, { force: true }); }
});
