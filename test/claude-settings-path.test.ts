// Where the brain looks for the Claude settings (the API gateway env lives there) when HOME is not set.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, userSettingsEnv } from "../src/brain";

test("claudeSettingsPath: CLAUDE_CONFIG_DIR wins, then HOME, then the OS home directory", () => {
  expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: join("/c", "cfg"), HOME: join("/h", "me") })).toBe(join("/c", "cfg", "settings.json"));
  expect(claudeSettingsPath({ HOME: join("/h", "me") })).toBe(join("/h", "me", ".claude", "settings.json"));
  expect(claudeSettingsPath({})).toBe(join(homedir(), ".claude", "settings.json")); // a PowerShell-started daemon on Windows: no HOME
  expect(claudeSettingsPath({})).not.toContain("undefined");
});

test("userSettingsEnv: reads the env block of the settings file, string values only", () => {
  const dir = join(tmpdir(), `noop-settings-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "settings.json");
  writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gw.example", N: 1 } }));
  expect(userSettingsEnv(f)).toEqual({ ANTHROPIC_BASE_URL: "https://gw.example" });
  expect(userSettingsEnv(join(dir, "missing.json"))).toEqual({});
});
