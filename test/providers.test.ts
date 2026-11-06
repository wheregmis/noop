import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enabledProviders, providerOrders } from "../cloud/src/providers";
import { allowedClis, chooseCli, hostCaps, P } from "../src/core";
import { failoverAccount, startLogin } from "../src/accounts";
import { providerHealth } from "../src/providers";
import { cliCommand, judgeCommand, parseResult, quickAsk, runAgent } from "../src/runner";
import { RoutingModel } from "../src/brain";
const originalPath = process.env.PATH;
let work = "";
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "noop-provider-")); mkdirSync(P(), { recursive: true }); });
afterEach(() => { process.env.PATH = originalPath; rmSync(work, { recursive: true, force: true }); });
test("enabled tools constrain explicit, per-member, planned and fallback choices", () => {
  const cfg = { clis: { enabled: ["hermes", "codex"], agents: { writer: ["claude", "hermes"] } } };
  expect(allowedClis({ agent: "writer" }, cfg)).toEqual(["hermes"]);
  expect(allowedClis({ cli: "claude" }, cfg)).toEqual([]);
  expect(allowedClis({ planned_cli: "codex" }, cfg)).toEqual(["codex", "hermes"]);
  expect(allowedClis({}, { clis: { enabled: [] } })).toEqual([]);
  expect(allowedClis({ agent: "writer", cli: "hermes" }, { clis: { enabled: ["hermes"], agents: { writer: [] } } })).toEqual([]);
  expect(failoverAccount(cfg, { cli: "hermes", name: "default", dir: "", default: true }, ["hermes"], () => true)).toBeNull();
  expect(failoverAccount(cfg, { cli: "hermes", name: "default", dir: "", default: true }, ["hermes", "codex"], () => true)?.cli).toBe("codex");
  expect(enabledProviders({ clis: { enabled: ["hermes", "unknown", "hermes"] } })).toEqual(["hermes"]);
  expect(providerOrders(["claude", "codex", "hermes"])).toContainEqual(["hermes", "codex", "claude"]);
});
test("explicit task and ordered member/team pools outrank planner recommendations", () => {
  const cfg = { clis: { enabled: ["claude", "codex", "hermes"], preference: ["codex", "claude"], agents: { writer: ["hermes", "codex"], inherited: null, paused: [] } } };
  expect(allowedClis({ agent: "writer", planned_cli: "codex" }, cfg)).toEqual(["hermes", "codex"]);
  expect(allowedClis({ agent: "inherited", planned_cli: "claude" }, cfg)).toEqual(["codex", "claude"]);
  expect(allowedClis({ agent: "writer", cli: "claude", planned_cli: "codex" }, cfg)).toEqual(["claude"]);
  expect(allowedClis({ agent: "paused", cli: "hermes" }, cfg)).toEqual([]);
  expect(allowedClis({ agent: "inherited", planned_cli: "hermes" }, { clis: { ...cfg.clis, preference: null } })).toEqual(["hermes", "claude", "codex"]);
});
test("an empty or invalid team default does not prevent explicit task/member pools", () => {
  for (const preference of [[], "claude", ["unknown"], ["claude", "claude"]]) {
    const cfg = { clis: { enabled: ["claude", "hermes"], preference, agents: { writer: ["hermes"], invalid: ["unknown"] } } };
    expect(allowedClis({}, cfg)).toEqual([]);
    expect(allowedClis({ cli: "claude" }, cfg)).toEqual(["claude"]);
    expect(allowedClis({ agent: "writer", planned_cli: "claude" }, cfg)).toEqual(["hermes"]);
    expect(allowedClis({ agent: "invalid", cli: "claude" }, cfg)).toEqual([]);
  }
});
test("a detected but broken launcher is reported unavailable", () => {
  const health = providerHealth({}, (id) => ({ installed: id !== "codex", available: id === "claude", reason: id === "hermes" ? "Launcher failed" : undefined }));
  expect(health.find((provider) => provider.id === "hermes")).toMatchObject({ installed: true, available: false, reason: "Launcher failed" });
  expect(health.find((provider) => provider.id === "codex")?.installed).toBe(false);
});
test("Hermes accepts prompt stdin and returns a real Noop result; disabled tools cannot route chat", async () => {
  const input = join(work, "input.json"), script = join(work, "fake.ts");
  writeFileSync(script, `const text = await Bun.stdin.text(); await Bun.write(${JSON.stringify(input)}, JSON.stringify({args:process.argv.slice(2),text})); console.log('\\x60\\x60\\x60json\\n'+JSON.stringify({status:'done',summary:'Hermes fixture',reply:'Ready',calls:[]})+'\\n\\x60\\x60\\x60');`);
  writeFileSync(join(work, "hermes"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo hermes-test; exit 0; fi\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(join(work, "hermes"), 0o755); process.env.PATH = work;
  const cfg = { clis: { enabled: ["hermes"], hermes: { model: "test/model" } } };
  expect(providerHealth(cfg)).toContainEqual(expect.objectContaining({ id: "hermes", available: true }));
  expect(chooseCli({}, cfg)).toBe("hermes"); expect(hostCaps(cfg)).toContain("cli:hermes");
  const result = await runAgent("hermes", "Use literal `quotes` and $(nothing)", work, cfg, join(work, "run.log"));
  expect(parseResult(result).status).toBe("done");
  const captured = JSON.parse(readFileSync(input, "utf8"));
  expect(captured.text).toBe("Use literal `quotes` and $(nothing)");
  expect(captured.args).toEqual(["chat", "--query-file", "-", "--quiet", "--source", "noop", "--model", "test/model"]);
  expect((await quickAsk("Reply", cfg, join(work, "route.log"))).reply).toBe("Ready");
  expect(await quickAsk("Do not run", { clis: { enabled: [] } }, join(work, "off.log"))).toBeNull();
  expect(judgeCommand({ clis: { enabled: ["hermes"] } })[0]).toBe("hermes");
  expect(judgeCommand({ clis: { enabled: [] } })).toEqual([]);
  expect(cliCommand("hermes", cfg)).toContain("--query-file");
});
test("provider-neutral chat preserves prior tool results across turns", async () => {
  const prompts: string[] = [];
  const model = new RoutingModel(async (prompt) => { prompts.push(prompt); return { calls: [], reply: "Ready" }; });
  const conversation = await model.open("System");
  await conversation.send("Question"); await conversation.send("Tool returned a task"); conversation.close();
  expect(prompts[1]).toContain("Question"); expect(prompts[1]).toContain('Assistant: {"calls":[],"reply":"Ready"}');
});


test("Hermes sign-in never accidentally launches a Claude login process", async () => {
  await expect(startLogin({ cli: "hermes", name: "default", dir: "", default: true }, {})).rejects.toThrow("native model setup");
});
