import { beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import { CODE, P, loadConfig } from "../src/core";
import { addRole, listRoles, readRole } from "../src/setup";

beforeEach(() => {
  rmSync(P("agents"), { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true }); rmSync(P("config.local.toml"), { force: true });
  mkdirSync(P("agents"), { recursive: true });
  writeFileSync(P("config.toml"), `[[routine]]\nname = "mine"\nevery = "1h"\nagent = "lead"\n`);
});
const routines = (file: string) => (Bun.TOML.parse(readFileSync(file, "utf8")) as { routine?: Record<string, unknown>[] }).routine ?? [];

test("a new team spends nothing by itself and every routine has its agent", () => {
  const tpl = Bun.TOML.parse(readFileSync(join(CODE, "templates/config.toml"), "utf8")) as Record<string, any>;
  expect(tpl.routine.length).toBeGreaterThan(0);
  for (const r of tpl.routine) {
    expect(r.enabled).toBe(false);
    expect(existsSync(join(CODE, "templates/agents", r.agent, "profile.md"))).toBe(true);
    expect(r.requires).toBeUndefined();
  }
  expect(tpl.idle.enabled).toBe(false);
  expect(tpl.medic.push).toBe(false);
});

test("optional roles' routines are off and run as that role", () => {
  for (const id of readdirSync(join(CODE, "roles"))) {
    const f = join(CODE, "roles", id, "routines.toml");
    if (!existsSync(f)) continue;
    for (const r of routines(f)) {
      expect(r.enabled).toBe(false);
      if (r.kind !== "learn") expect(r.agent).toBe(id);
    }
  }
});

test("adding a role copies its profile and appends its routines once", () => {
  expect(listRoles().find((r) => r.id === "maintainer")).toMatchObject({ installed: false });
  expect(addRole("maintainer")).toEqual(["own-prs-ci", "nightly-health", "macos-check"]);
  expect(listRoles().find((r) => r.id === "maintainer")).toMatchObject({ installed: true });
  const names = () => routines(P("config.toml")).map((r) => r.name);
  expect(names()).toEqual(["mine", "own-prs-ci", "nightly-health", "macos-check"]);
  expect(routines(P("config.toml")).slice(1).every((r) => r.enabled === false)).toBe(true);
  writeFileSync(P("agents", "maintainer", "profile.md"), "# Mine\n");
  expect(addRole("maintainer")).toEqual([]);
  expect(names()).toHaveLength(4);
  expect(readFileSync(P("agents", "maintainer", "profile.md"), "utf8")).toBe("# Mine\n");
});

test("a role without routines joins; an unknown or escaping id is refused", () => {
  expect(addRole("oss-triage")).toEqual([]);
  expect(existsSync(P("agents", "oss-triage", "profile.md"))).toBe(true);
  expect(() => addRole("nope")).toThrow(/no optional role/);
  expect(() => addRole("../templates")).toThrow(/no optional role/);
});

test("the machine name works with launchd's bare PATH", () => {
  const code = 'import { machineName } from "./src/core"; console.log(machineName())';
  const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: CODE, env: { ...process.env, PATH: "/nonexistent" } });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString().trim()).not.toBe("");
});


test("built-in previews expose only known roles and do not replace installed instructions", () => {
  const role = readRole("maintainer");
  expect(role).toMatchObject({ id: "maintainer", installed: false });
  expect(role.profile).toContain("#");
  expect(role.routines).toEqual([
    { name: "own-prs-ci", every: "30m", enabled: false },
    { name: "nightly-health", every: "daily 02:30", enabled: false },
    { name: "macos-check", every: "daily 10:00", enabled: false },
  ]);
  addRole("maintainer");
  writeFileSync(P("agents", "maintainer", "profile.md"), "# My evolved instructions\n");
  expect(readRole("maintainer")).toMatchObject({ installed: true, profile: role.profile });
  for (const id of ["../templates", "", "maintainer/../../templates", "MAINTAINER", "unknown"]) expect(() => readRole(id)).toThrow(/no optional role/);
});

test("installation forces disabled defaults and deduplicates built-in routine names", () => {
  const source = readFileSync(join(CODE, "roles", "ops-watcher", "routines.toml"), "utf8");
  const parse = Bun.TOML.parse;
  const fixture = { routine: [
    { name: "default-off", every: "hourly", agent: "ops-watcher", prompt: "Observe.", enabled: true },
    { name: "missing-enabled", every: "hourly", agent: "ops-watcher", prompt: "Observe." },
    { name: "default-off", every: "daily 01:00", agent: "ops-watcher", prompt: "Duplicate." },
  ] };
  const mocked = spyOn(Bun.TOML, "parse").mockImplementation((text) => text === source ? fixture : parse(text));
  try {
    expect(readRole("ops-watcher").routines.every((r) => r.enabled === false)).toBe(true);
    expect(addRole("ops-watcher")).toEqual(["default-off", "missing-enabled"]);
    expect(routines(P("config.toml")).slice(1).every((r) => r.enabled === false)).toBe(true);
    expect(addRole("ops-watcher")).toEqual([]);
  } finally { mocked.mockRestore(); }
});

test("config validation and atomic write failures leave the profile and existing settings unchanged", () => {
  const original = readFileSync(P("config.toml"), "utf8");
  writeFileSync(P("config.toml"), "[[broken");
  expect(() => addRole("maintainer")).toThrow();
  expect(existsSync(P("agents", "maintainer", "profile.md"))).toBe(false);
  writeFileSync(P("config.toml"), original);
  const preferences = JSON.stringify({ routines: { "own-prs-ci": { enabled: true } }, media_days: 30 });
  writeFileSync(P("settings.json"), preferences);
  const rename = fs.renameSync;
  const failed = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === P("config.toml")) throw new Error("rename failed fixture");
    rename(from, to);
  });
  try {
    expect(() => addRole("maintainer")).toThrow("rename failed fixture");
    expect(existsSync(P("agents", "maintainer", "profile.md"))).toBe(false);
    expect(readFileSync(P("config.toml"), "utf8")).toBe(original);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(preferences);
    expect(readdirSync(P()).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(readdirSync(P("agents", "maintainer"))).toEqual([]);
  } finally { failed.mockRestore(); }
});

test("existing routine settings remain byte-for-byte intact while other role routines are added", () => {
  const existing = '# Owner comments stay.\n[[routine]]\nname = "own-prs-ci"\nenabled = true\nevery = "hourly"\nagent = "lead"\nprompt = "My customized checks."\n';
  writeFileSync(P("config.toml"), existing);
  const preferences = JSON.stringify({ routines: { "own-prs-ci": { enabled: false, every: "daily 01:00" } } });
  writeFileSync(P("settings.json"), preferences);
  expect(addRole("maintainer")).toEqual(["nightly-health", "macos-check"]);
  expect(readFileSync(P("config.toml"), "utf8").startsWith(existing)).toBe(true);
  expect(routines(P("config.toml"))[0]).toMatchObject({ name: "own-prs-ci", enabled: true, agent: "lead", prompt: "My customized checks." });
  expect(readFileSync(P("settings.json"), "utf8")).toBe(preferences);
  expect(loadConfig().routine.find((r: any) => r.name === "own-prs-ci")).toMatchObject({ enabled: false, every: "daily 01:00" });
});


test("new routines ignore stale overrides while existing routine preferences remain effective", () => {
  const settings = { media_days: 30, routines: { "own-prs-ci": { enabled: true }, mine: { enabled: true, every: "hourly" }, unrelated: { enabled: true } } };
  writeFileSync(P("settings.json"), JSON.stringify(settings));
  addRole("maintainer");
  expect(loadConfig().routine.find((r: any) => r.name === "own-prs-ci").enabled).toBe(false);
  expect(loadConfig().routine.find((r: any) => r.name === "mine")).toMatchObject({ enabled: true, every: "hourly" });
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8"))).toEqual({ media_days: 30, routines: { mine: settings.routines.mine, unrelated: settings.routines.unrelated } });
  const before = readFileSync(P("settings.json"), "utf8");
  expect(addRole("maintainer")).toEqual([]);
  expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
});

test("a settings write failure cannot change the existing profile or config", () => {
  const original = readFileSync(P("config.toml"), "utf8"), profile = P("agents", "maintainer", "profile.md");
  mkdirSync(P("agents", "maintainer")); writeFileSync(profile, "# My profile\n");
  const preferences = JSON.stringify({ routines: { "own-prs-ci": { enabled: true } }, media_days: 30 });
  writeFileSync(P("settings.json"), preferences);
  const write = fs.writeFileSync;
  const failed = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (String(file).startsWith(`${P("settings.json")}.`)) throw new Error("settings write failed fixture");
    write(file, data, options);
  });
  try {
    expect(() => addRole("maintainer")).toThrow("settings write failed fixture");
    expect(readFileSync(P("config.toml"), "utf8")).toBe(original);
    expect(readFileSync(profile, "utf8")).toBe("# My profile\n");
    expect(readFileSync(P("settings.json"), "utf8")).toBe(preferences);
    expect(readdirSync(P()).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally { failed.mockRestore(); }
});
