import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { P, allowedClis, loadConfig } from "../src/core";
import { configurationRoute, configurationView, saveSettings, settingsView } from "../src/server";
import { judgeMayDecide, level, needsApproval } from "../src/autonomy";
const io = { pull: async () => true, push: async () => true };
const settingsPath = process.env.PATH;
afterEach(() => { process.env.PATH = settingsPath; rmSync(P("agents", "autonomy-peer"), { recursive: true, force: true }); });
beforeEach(() => {
  process.env.PATH = "";
  mkdirSync(P("agents", "reporter"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("agents", "reporter", "profile.md"), "# Reporter\n");
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n");
  rmSync(P("config.local.toml"), { force: true });
  writeFileSync(P("settings.json"), JSON.stringify({ machines: { mac: { enabled: false } }, configuration: { idle: { enabled: false } } }));
});
test("confirmed preferences retain unrelated settings and merge concurrent changes", async () => {
  const [first, second] = await Promise.all([
    saveSettings({ clis: { agents: { reporter: ["codex", "claude"] } }, autonomy: { agents: { reporter: "assisted" } } }, io),
    saveSettings({ media_days: 30, commands: [{ name: "daily", text: "Report progress" }] }, io),
  ]);
  expect(first.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: ["codex", "claude"], autonomy: "assisted" });
  expect(second.current).toMatchObject({ machines: { mac: { enabled: false } }, configuration: { idle: { enabled: false } }, media_days: 30, commands: [{ name: "daily", text: "Report progress" }] });
  expect(second.effective.agents.find((a) => a.id === "reporter")?.clis).toEqual(["codex", "claude"]);
});
test("unavailable refresh prevents writes and a failed push does not report success", async () => {
  const before = readFileSync(P("settings.json"), "utf8");
  await expect(saveSettings({ media_days: 30 }, { ...io, pull: async () => false })).rejects.toThrow("latest settings");
  expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  await expect(saveSettings({ media_days: 30 }, { ...io, push: async () => false })).rejects.toThrow("saved locally but could not sync");
});
test("malformed preferences and prototype keys are rejected before any settings change", async () => {
  const before = readFileSync(P("settings.json"), "utf8");
  for (const patch of [null, [], "settings", { server: { token: "no" } }, JSON.parse('{"clis":{"__proto__":{"polluted":true}}}'), { autonomy: { constructor: { prototype: { polluted: true } } } }]) {
    await expect(saveSettings(patch, io)).rejects.toThrow();
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  expect(({} as any).polluted).toBeUndefined();
});


test("member autonomy can inherit the team default and invalid levels cannot weaken the policy", async () => {
  await saveSettings({ autonomy: { level: "assisted", agents: { reporter: "onboarding" } } }, io);
  const inherited = await saveSettings({ autonomy: { agents: { reporter: null } } }, io);
  expect(inherited.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "assisted", autonomy_inherited: true });
  for (const patch of [{ autonomy: { level: "invalid" } }, { autonomy: { agents: { reporter: "invalid" } } }, { autonomy: { agents: [] } }, { autonomy: { batch_minutes: -1 } }]) await expect(saveSettings(patch, io)).rejects.toThrow();
});

test("owner member autonomy downgrades and inheritance beat local file policy", async () => {
  writeFileSync(P("config.local.toml"), "[autonomy]\nlevel = 'autonomous'\nassisted_approve_followups = true\nbatch_minutes = 42\n[autonomy.agents]\nreporter = 'autonomous'\nreviewer = 'assisted'\n");
  const initial = loadConfig();
  expect(needsApproval(initial, "followup:T-0001", "reporter")).toBe(false);
  expect(judgeMayDecide(initial, "reporter")).toBe(true);
  const downgraded = await saveSettings({ autonomy: { agents: { reporter: "onboarding" } } }, io);
  expect(downgraded.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "onboarding", autonomy_inherited: false });
  const cautious = loadConfig();
  expect(needsApproval(cautious, "followup:T-0001", "reporter")).toBe(true);
  expect(judgeMayDecide(cautious, "reporter")).toBe(false);
  const current = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  current.configuration.autonomy = { level: "assisted" };
  writeFileSync(P("settings.json"), JSON.stringify(current));
  const inherited = await saveSettings({ autonomy: { agents: { reporter: null } } }, io);
  expect(inherited.effective.autonomy).toBe("assisted");
  expect(inherited.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "assisted", autonomy_inherited: true });
  const team = loadConfig();
  expect(needsApproval(team, "followup:T-0001", "reporter")).toBe(true);
  expect(judgeMayDecide(team, "reporter")).toBe(true);
  expect(team.autonomy).toMatchObject({ level: "assisted", batch_minutes: 42, assisted_approve_followups: true, agents: { reporter: null, reviewer: "assisted" } });
  expect(team.idle.enabled).toBe(false);
  const saved = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(saved).toMatchObject({ machines: { mac: { enabled: false } }, autonomy: { agents: { reporter: null } }, configuration: { idle: { enabled: false }, autonomy: { level: "assisted" } } });
});

test("member autonomy source distinguishes inheritance from restoring local and shared file rules", async () => {
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy]\nlevel = 'assisted'\n[autonomy.agents]\nreporter = 'onboarding'\n");
  writeFileSync(P("config.local.toml"), "[autonomy]\nbatch_minutes = 42\n[autonomy.agents]\nreporter = 'autonomous'\n");
  const initial = settingsView();
  expect(initial.effective.autonomy_policy_version).toBe(1);
  expect(initial.effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: "autonomous", effective: "autonomous", source: "local_file", file_default: "autonomous", file_source: "local_file" });
  const inherited = await saveSettings({ autonomy_policy_version: 1, autonomy: { agents: { reporter: null } } }, io);
  expect(inherited.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "assisted", autonomy_inherited: true, autonomy_policy: { configured: null, effective: "assisted", source: "ui", file_default: "autonomous", file_source: "local_file" } });
  const restored = await saveSettings({ autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } }, io);
  expect(restored.effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual(initial.effective.agents.find((a) => a.id === "reporter")!.autonomy_policy);
  const saved = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(saved.autonomy.agents.reporter).toBeUndefined(); expect(saved.autonomy.reset).toBeUndefined(); expect(saved.autonomy_policy_version).toBeUndefined();
  expect(saved.configuration).toEqual({ idle: { enabled: false } }); expect(loadConfig().autonomy.batch_minutes).toBe(42);
  rmSync(P("config.local.toml"));
  expect(settingsView().effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: "onboarding", effective: "onboarding", source: "shared_file", file_default: "onboarding", file_source: "shared_file" });
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy]\nlevel = 'assisted'\n");
  expect(settingsView().effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: null, effective: "assisted", source: "default", file_default: null, file_source: "default" });
});

test("invalid file member autonomy stays conservative and its reset cannot masquerade as inheritance", async () => {
  writeFileSync(P("config.local.toml"), "[autonomy]\nlevel = 'autonomous'\n[autonomy.agents]\nreporter = false\n");
  const bad = settingsView().effective.agents.find((a) => a.id === "reporter")!;
  expect(bad).toMatchObject({ autonomy: "onboarding", autonomy_inherited: false, autonomy_policy: { configured: "onboarding", effective: "onboarding", source: "local_file", file_default: "onboarding", file_source: "local_file", invalid: true, file_invalid: true } });
  const inherited = await saveSettings({ autonomy: { agents: { reporter: null } } }, io);
  expect(inherited.effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: null, effective: "autonomous", source: "ui", file_default: "onboarding", file_source: "local_file", file_invalid: true });
  const restored = await saveSettings({ autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } }, io);
  expect(restored.effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual(bad.autonomy_policy);
  expect(judgeMayDecide(loadConfig(), "reporter")).toBe(false);
});

test("malformed whole UI autonomy does not misidentify a valid local policy as its source", () => {
  writeFileSync(P("config.local.toml"), "[autonomy]\nlevel = 'assisted'\n[autonomy.agents]\nreporter = 'onboarding'\n");
  for (const autonomy of [false, [], "broken", null]) {
    writeFileSync(P("settings.json"), JSON.stringify({ autonomy }));
    expect(settingsView().effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: "onboarding", effective: "onboarding", source: "local_file", file_default: "onboarding", file_source: "local_file" });
  }
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy.agents]\nreporter = 'assisted'\n");
  for (const [local, effective] of [["[autonomy]\n", "onboarding"], ["[autonomy]\nlevel = 'autonomous'\n", "autonomous"]] as const) {
    writeFileSync(P("config.local.toml"), local);
    expect(settingsView().effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: null, effective, source: "local_file", file_default: "assisted", file_source: "shared_file" });
  }
  writeFileSync(P("config.local.toml"), "autonomy = false\n");
  expect(settingsView().effective.agents.find((a) => a.id === "reporter")?.autonomy_policy).toEqual({ configured: "onboarding", effective: "onboarding", source: "local_file", file_default: "onboarding", file_source: "local_file", invalid: true, file_invalid: true });
});

test("autonomy reset requires the version guard and rejects unsafe or conflicting leaves before refresh", async () => {
  const before = readFileSync(P("settings.json"), "utf8"); let pulls = 0;
  const patches = [
    { autonomy_policy_version: 1 }, { autonomy_policy_version: 2, autonomy: { agents: { reporter: null } } },
    { autonomy: { reset: ["agents.reporter"] } },
    ...[{ reset: ["level"] }, { reset: ["agents.constructor"] }, { reset: ["agents.reporter", "agents.reporter"] }, { reset: ["agents.reporter"], agents: { reporter: null } }, { agents: { reporter: "trusted" } }, { agents: { constructor: null } }, { credentials: "private" }]
      .map((autonomy) => ({ autonomy_policy_version: 1, autonomy })),
  ];
  for (const patch of patches) {
    await expect(saveSettings(patch, { ...io, pull: async () => { pulls++; return true; } })).rejects.toThrow();
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  expect(pulls).toBe(0);
});

test("autonomy resets preserve freshly synced siblings and failed sync retains the exact local reset", async () => {
  await saveSettings({ autonomy: { agents: { reporter: "onboarding", "autonomy-peer": "assisted" } } }, io);
  const before = readFileSync(P("settings.json"), "utf8");
  const reset = { autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } };
  await expect(saveSettings(reset, { ...io, pull: async () => false })).rejects.toThrow("latest settings");
  expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  await expect(saveSettings(reset, { ...io, pull: async () => {
    const fresh = JSON.parse(readFileSync(P("settings.json"), "utf8")); fresh.autonomy.agents["autonomy-peer"] = "onboarding"; fresh.autonomy.batch_minutes = 24;
    fresh.clis = { agents: { reporter: ["codex", "claude"] } }; writeFileSync(P("settings.json"), JSON.stringify(fresh)); return true;
  }, push: async () => false })).rejects.toThrow("saved locally but could not sync");
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8"))).toMatchObject({ autonomy: { agents: { "autonomy-peer": "onboarding" }, batch_minutes: 24 }, clis: { agents: { reporter: ["codex", "claude"] } }, configuration: { idle: { enabled: false } } });
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).autonomy.agents.reporter).toBeUndefined();
});

test("repairing malformed member containers never promotes untouched members", async () => {
  mkdirSync(P("agents", "autonomy-peer"), { recursive: true }); writeFileSync(P("agents", "autonomy-peer", "profile.md"), "# Peer\n");
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy]\nlevel = 'autonomous'\nbatch_minutes = 42\n");
  for (const autonomy of ["broken", [], { agents: "broken", assisted_approve_followups: true }, { agents: [] }, { agents: null }]) {
    writeFileSync(P("settings.json"), JSON.stringify({ autonomy, media_days: 30 }));
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    const before = readFileSync(P("settings.json"), "utf8");
    const team = level(loadConfig());
    await expect(saveSettings({ autonomy_policy_version: 1, autonomy: { reset: ["agents.reporter"] } }, io)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
    const repaired = await saveSettings({ autonomy_policy_version: 1, autonomy: { agents: { reporter: null } } }, io);
    expect(repaired.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: team, autonomy_inherited: true });
    expect(level(loadConfig())).toBe(team);
    expect(repaired.effective.agents.find((a) => a.id === "autonomy-peer")).toMatchObject({ autonomy: "onboarding", autonomy_inherited: false });
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    expect(needsApproval(loadConfig(), "followup:T-0001", "autonomy-peer")).toBe(true);
    const saved = JSON.parse(readFileSync(P("settings.json"), "utf8"));
    expect(saved).toMatchObject({ media_days: 30, autonomy: { agents: { reporter: null, "autonomy-peer": "onboarding" } } });
    expect(loadConfig().autonomy.batch_minutes).toBe(42);
  }
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy]\nlevel = 'autonomous'\n[autonomy.agents]\nautonomy-peer = 'assisted'\n");
  writeFileSync(P("config.local.toml"), "[autonomy]\n");
  writeFileSync(P("settings.json"), JSON.stringify({ autonomy: 0 }));
  expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
  const repaired = await saveSettings({ autonomy: { agents: { reporter: null } } }, io);
  expect(repaired.effective.agents.find((a) => a.id === "autonomy-peer")).toMatchObject({ autonomy: "onboarding", autonomy_policy: { configured: "onboarding", source: "ui", file_default: "assisted", file_source: "shared_file" } });
  expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
  expect(judgeMayDecide(loadConfig())).toBe(false);
});

test("a legacy shared-only autonomy edit also preserves restricted members while repairing its parent", async () => {
  mkdirSync(P("agents", "autonomy-peer"), { recursive: true }); writeFileSync(P("agents", "autonomy-peer", "profile.md"), "# Peer\n");
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[autonomy]\nlevel = 'autonomous'\n");
  for (const autonomy of [0, [], { agents: "broken" }]) {
    writeFileSync(P("settings.json"), JSON.stringify({ autonomy, media_days: 30 }));
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    const before = level(loadConfig());
    await saveSettings({ autonomy: { batch_minutes: 24 } }, io);
    expect(loadConfig().autonomy.batch_minutes).toBe(24);
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    expect(level(loadConfig())).toBe(before);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8"))).toMatchObject({ media_days: 30, autonomy: { agents: { reporter: "onboarding", "autonomy-peer": "onboarding" } } });
  }
});

test("generic configuration edits retain malformed restrictions until an explicit safe repair", async () => {
  mkdirSync(P("agents", "autonomy-peer"), { recursive: true }); writeFileSync(P("agents", "autonomy-peer", "profile.md"), "# Peer\n");
  writeFileSync(P("config.local.toml"), "[autonomy]\nlevel = 'autonomous'\n");
  const write = (body: unknown) => configurationRoute(new Request("http://hub/api/configuration", { method: "PUT", body: JSON.stringify(body) }), io);
  for (const autonomy of ["broken", [], null]) {
    writeFileSync(P("settings.json"), JSON.stringify({ media_days: 30, configuration: { autonomy, idle: { enabled: false } } }));
    expect(configurationView()).toMatchObject({ values: { "autonomy.level": "Invalid; Learning is effective" }, overrides: expect.arrayContaining(["autonomy.level"]) });
    expect((await write({ values: { "idle.enabled": true } })).status).toBe(200);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).configuration.autonomy).toEqual(autonomy);
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    expect((await write({ reset: ["idle.enabled"] })).status).toBe(200);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).configuration.autonomy).toEqual(autonomy);
    expect((await write({ values: { "autonomy.batch_minutes": 12 } })).status).toBe(200);
    expect(configurationView().values["autonomy.level"]).toBe("onboarding");
    expect(judgeMayDecide(loadConfig())).toBe(false);
    expect(loadConfig().autonomy.batch_minutes).toBe(12);
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8"))).toMatchObject({ media_days: 30, autonomy: { agents: { reporter: "onboarding", "autonomy-peer": "onboarding" } } });
    writeFileSync(P("settings.json"), JSON.stringify({ configuration: { autonomy } }));
    expect((await write({ reset: ["autonomy.level"] })).status).toBe(200);
    expect(configurationView().overrides).not.toContain("autonomy.level");
    expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
    expect(judgeMayDecide(loadConfig())).toBe(true); // An explicit level reset restores the file's team default.
  }
  writeFileSync(P("settings.json"), JSON.stringify({ configuration: { autonomy: { agents: "broken" } } }));
  expect((await write({ values: { "idle.enabled": true } })).status).toBe(200);
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).configuration.autonomy.agents).toBe("broken");
  expect(judgeMayDecide(loadConfig(), "autonomy-peer")).toBe(false);
});

test("effective autonomy settings use the same conservative resolver as runtime approval", () => {
  for (const value of ["trusted", "", false, 0, [], {}]) {
    writeFileSync(P("settings.json"), JSON.stringify({ autonomy: { level: "autonomous", agents: { reporter: value } } }));
    const view = settingsView();
    expect(view.effective.autonomy).toBe("autonomous");
    expect(view.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "onboarding", autonomy_inherited: false });
  }
  writeFileSync(P("settings.json"), JSON.stringify({ autonomy: { level: "trusted", agents: { reporter: null } } }));
  expect(settingsView().effective.autonomy).toBe("onboarding");
  expect(settingsView().effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "onboarding", autonomy_inherited: true });
  writeFileSync(P("settings.json"), JSON.stringify({ autonomy: { level: "autonomous", agents: [] } }));
  expect(settingsView().effective.agents.find((a) => a.id === "reporter")).toMatchObject({ autonomy: "onboarding", autonomy_inherited: false });
});


test("member pause state differs from globally disabled preferences and permits explicit task overrides", async () => {
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[clis]\nenabled = ['claude']\n");
  const filtered = await saveSettings({ clis: { agents: { reporter: ["codex"] } } }, io);
  expect(filtered.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: [], paused: false });
  expect(allowedClis({ agent: "reporter", cli: "claude" }, loadConfig())).toEqual(["claude"]);
  const paused = await saveSettings({ clis: { agents: { reporter: [] } } }, io);
  expect(paused.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: [], paused: true });
  expect(allowedClis({ agent: "reporter", cli: "claude" }, loadConfig())).toEqual([]);
});

test("tool policy UI choices override local files while inheritance and reset remain distinct", async () => {
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[clis]\nenabled = ['claude', 'codex']\npreference = ['claude']\n[clis.agents]\nreporter = ['claude']\n");
  writeFileSync(P("config.local.toml"), "[clis]\npreference = ['codex', 'hermes', 'claude']\n[clis.agents]\nreporter = ['hermes', 'claude']\n");
  const initial = settingsView();
  expect(initial.effective.tool_policy).toEqual({ version: 1, team: { configured: ["codex", "hermes", "claude"], effective: ["codex", "claude"], source: "local_file", file_default: ["codex", "hermes", "claude"], file_source: "local_file" } });
  expect(initial.effective.agents.find((a) => a.id === "reporter")?.tool_policy).toMatchObject({ configured: ["hermes", "claude"], effective: ["claude"], source: "local_file", file_default: ["hermes", "claude"] });
  const inherited = await saveSettings({ tool_policy_version: 1, clis: { agents: { reporter: null } } }, io);
  expect(inherited.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: ["codex", "claude"], paused: false, tool_policy: { configured: null, source: "ui", file_source: "local_file", file_default: ["hermes", "claude"] } });
  const automatic = await saveSettings({ tool_policy_version: 1, clis: { preference: null } }, io);
  expect(automatic.effective.tool_policy.team).toMatchObject({ configured: null, effective: ["claude", "codex"], source: "ui" });
  const restoredMember = await saveSettings({ tool_policy_version: 1, clis: { reset: ["agents.reporter"] } }, io);
  expect(restoredMember.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: ["claude"], tool_policy: { configured: ["hermes", "claude"], source: "local_file" } });
  const restoredTeam = await saveSettings({ tool_policy_version: 1, clis: { reset: ["preference"] } }, io);
  expect(restoredTeam.effective.tool_policy.team).toMatchObject({ configured: ["codex", "hermes", "claude"], source: "local_file" });
  const saved = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(saved.clis.preference).toBeUndefined(); expect(saved.clis.agents.reporter).toBeUndefined();
  expect(saved.clis.reset).toBeUndefined(); expect(saved.tool_policy_version).toBeUndefined();
  expect(saved).toMatchObject({ machines: { mac: { enabled: false } }, configuration: { idle: { enabled: false } } });
});

test("shared file and default tool sources do not include unrelated local credentials", async () => {
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n[clis]\npreference = ['codex', 'claude']\n[clis.agents]\nreporter = ['codex']\n");
  writeFileSync(P("config.local.toml"), "[server]\ntoken = 'private-bootstrap-fixture'\n");
  const view = settingsView();
  expect(view.effective.tool_policy.team).toMatchObject({ source: "shared_file", file_source: "shared_file" });
  expect(view.effective.agents.find((a) => a.id === "reporter")?.tool_policy).toMatchObject({ source: "shared_file", configured: ["codex"] });
  expect(JSON.stringify(view)).not.toContain("private-bootstrap-fixture");
  writeFileSync(P("config.toml"), "[host]\nname = 'mac'\n");
  expect(settingsView().effective.tool_policy.team).toEqual({ configured: null, effective: ["claude", "codex"], source: "default", file_default: null, file_source: "default" });
});

test("malformed legacy tool policies fail closed and remain visibly distinct from paused members", async () => {
  writeFileSync(P("config.local.toml"), "[clis]\npreference = 'codex'\n[clis.agents]\nreporter = ['claude', 'claude']\n");
  const view = settingsView();
  expect(view.effective.tool_policy.team).toMatchObject({ configured: [], effective: [], invalid: true, file_invalid: true, source: "local_file" });
  expect(view.effective.agents.find((a) => a.id === "reporter")).toMatchObject({ clis: [], paused: false, tool_policy: { configured: [], invalid: true, file_invalid: true } });
  expect(allowedClis({ agent: "reporter", cli: "claude" }, loadConfig())).toEqual([]);
  const repaired = await saveSettings({ tool_policy_version: 1, clis: { preference: null, agents: { reporter: null } } }, io);
  expect(repaired.effective.agents.find((a) => a.id === "reporter")?.tool_policy).toEqual({ configured: null, effective: ["claude", "codex"], source: "ui", file_default: [], file_source: "local_file", file_invalid: true });
});

test("strict tool policy patches cannot smuggle runner settings or conflicting resets", async () => {
  const before = readFileSync(P("settings.json"), "utf8");
  let pulls = 0;
  for (const clis of [null, [], { command: ["unexpected"] }, { enabled: [] }, { preference: ["claude", "claude"] }, { preference: ["unknown"] }, { agents: { reporter: ["codex", "codex"] } }, { reset: ["agents.reporter", "agents.reporter"] }, { reset: ["agents.constructor"] }, { preference: null, reset: ["preference"] }, { agents: { reporter: null }, reset: ["agents.reporter"] }]) {
    await expect(saveSettings({ tool_policy_version: 1, clis }, io)).rejects.toThrow();
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  for (const patch of [{ tool_policy_version: 2, clis: { preference: null } }, { tool_policy_version: 1 }, { clis: { preference: null } }, { clis: { reset: ["preference"] } }]) {
    await expect(saveSettings(patch, { ...io, pull: async () => { pulls++; return true; } })).rejects.toThrow();
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
  expect(pulls).toBe(0);
});

test("tool resets use the refreshed settings and sync exceptions never claim success", async () => {
  await saveSettings({ tool_policy_version: 1, clis: { preference: ["codex"], agents: { reporter: ["claude"] } } }, io);
  const before = readFileSync(P("settings.json"), "utf8");
  await expect(saveSettings({ tool_policy_version: 1, clis: { reset: ["preference"] } }, { ...io, pull: async () => { throw new Error("offline"); } })).rejects.toThrow("latest settings");
  expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  await expect(saveSettings({ tool_policy_version: 1, clis: { reset: ["preference"] } }, { ...io,
    pull: async () => { const fresh = JSON.parse(readFileSync(P("settings.json"), "utf8")); fresh.clis.agents.reporter = ["codex"]; fresh.clis.claude = { model: "keep-existing" }; writeFileSync(P("settings.json"), JSON.stringify(fresh)); return true; },
    push: async () => { throw new Error("offline"); },
  })).rejects.toThrow("saved locally but could not sync");
  const saved = JSON.parse(readFileSync(P("settings.json"), "utf8"));
  expect(saved.clis.preference).toBeUndefined(); expect(saved.clis.agents.reporter).toEqual(["codex"]);
  expect(saved.clis.claude).toEqual({ model: "keep-existing" });
  expect(saved.configuration).toEqual({ idle: { enabled: false } });
});
