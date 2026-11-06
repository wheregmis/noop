import { expect, test } from "bun:test";
import { toolSettingsPatch } from "../cloud/src/providers";

test("tool policy patches preserve explicit order, pause and inheritance without retaining mutable input", () => {
  const input = { preference: ["codex", "hermes"], agents: { lead: null, reviewer: [], reporter: ["claude", "codex"] }, reset: ["agents.writer"] };
  const checked = toolSettingsPatch(input);
  expect(checked).toEqual({ values: { preference: ["codex", "hermes"], agents: { lead: null, reviewer: [], reporter: ["claude", "codex"] } }, reset: ["agents.writer"] });
  input.preference.reverse(); input.agents.reporter.reverse(); input.reset.push("preference");
  expect(checked).toMatchObject({ values: { preference: ["codex", "hermes"], agents: { reporter: ["claude", "codex"] } }, reset: ["agents.writer"] });
  expect(toolSettingsPatch({ preference: null, reset: ["agents.lead"] })).toEqual({ values: { preference: null }, reset: ["agents.lead"] });
  expect(toolSettingsPatch({ reset: ["preference", "agents.lead"] })).toEqual({ values: {}, reset: ["preference", "agents.lead"] });
});

test("tool policy trust boundary rejects malformed commands, identities, orders and conflicting resets", () => {
  for (const input of [
    null, [], "claude", { claude: { command: ["sh"] } }, { enabled: ["claude"] }, { preference: "claude" }, { preference: ["claude", "claude"] },
    { preference: ["shell"] }, { preference: [1] }, { preference: {} }, { agents: [] }, { agents: { lead: "claude" } }, { agents: { lead: ["codex", "codex"] } },
    { agents: { "../lead": [] } }, { agents: { constructor: [] } }, JSON.parse('{"agents":{"__proto__":[]}}'), { agents: { lead: ["other"] } },
    { reset: null }, { reset: "preference" }, { reset: ["enabled"] }, { reset: ["agents."] }, { reset: ["agents.lead.other"] },
    { reset: ["agents.constructor"] }, { reset: ["preference", "preference"] }, { reset: ["agents.lead", "agents.lead"] }, { reset: [1] },
    { preference: null, reset: ["preference"] }, { agents: { lead: null }, reset: ["agents.lead"] }, { agents: { lead: [] }, reset: ["agents.lead"] },
  ]) expect(toolSettingsPatch(input)).toHaveProperty("error");
  expect(({} as any).polluted).toBeUndefined();
});
