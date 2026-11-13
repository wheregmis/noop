// A claude CLI pointed at an API gateway (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json or
// the environment) has no OAuth login to refresh: `claude setup-token` 401s against the gateway. An auth-shaped
// failure must be a cooldown, not a needs_login flag that mails a dead link every 30 minutes (L-0288…L-0310).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayAuth } from "../src/accounts";

function settingsDir(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "noop-gateway-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env }));
  return dir;
}

test("detects the gateway env block in settings.json", () => {
  const dir = settingsDir({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_AUTH_TOKEN: "magpie" });
  expect(gatewayAuth(dir, {})).toBe("auth-token");
});

test("detects an inherited gateway base URL", () => {
  expect(gatewayAuth("/nonexistent", { ANTHROPIC_BASE_URL: "https://gateway.example.com" })).toBe("base-url");
});

test("the process env overrides the file", () => {
  const dir = settingsDir({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" });
  expect(gatewayAuth(dir, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(null);
});

test("plain OAuth machines are not gateway accounts", () => {
  expect(gatewayAuth("/nonexistent", {})).toBe(null);
});
