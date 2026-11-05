import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE, P } from "../src/core";
import { addRole, listRoles } from "../src/setup";

beforeEach(() => {
  rmSync(P("agents"), { recursive: true, force: true });
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
