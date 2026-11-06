import { expect, test } from "bun:test";
import { autonomyLevel, autonomySettingsPatch, configurationPatch } from "../cloud/src/configuration";

test("autonomy patches distinguish inherited values from file resets and detach input", () => {
  const input = { level: "assisted", auto_routines: ["review", "review"], agents: { lead: null, reporter: "onboarding" }, reset: ["agents.writer"] };
  const checked = autonomySettingsPatch(input);
  expect(checked).toEqual({ values: { level: "assisted", auto_routines: ["review"], agents: { lead: null, reporter: "onboarding" } }, reset: ["agents.writer"] });
  input.agents.reporter = "autonomous"; input.reset.push("agents.lead"); input.auto_routines.push("extra");
  expect(checked).toMatchObject({ values: { auto_routines: ["review"], agents: { reporter: "onboarding" } }, reset: ["agents.writer"] });
  expect(autonomySettingsPatch({ reset: ["agents.lead"] })).toEqual({ values: {}, reset: ["agents.lead"] });
});

test("autonomy mutation boundary rejects invalid fields, member levels and conflicting resets", () => {
  for (const input of [null, [], "autonomous", { level: "trusted" }, { level: null }, { agents: null }, { agents: [] }, { agents: { lead: false } },
    { agents: { lead: "trusted" } }, { agents: { lead: [] } }, { agents: { constructor: null } }, JSON.parse('{"agents":{"__proto__":"autonomous"}}'),
    { agents: { "../lead": null } }, { reset: null }, { reset: "agents.lead" }, { reset: ["level"] }, { reset: ["agents.constructor"] },
    { reset: ["agents.lead", "agents.lead"] }, { agents: { lead: null }, reset: ["agents.lead"] }, { enabled: true }, { command: ["sh"] }, { batch_minutes: -1 }])
    expect(autonomySettingsPatch(input)).toHaveProperty("error");
});

test("shared autonomy resolution stays conservative for malformed member and team values", () => {
  expect(autonomyLevel({ autonomy: { level: "autonomous", agents: { lead: null } } }, "lead")).toBe("autonomous");
  for (const value of [false, 0, "", "trusted", [], {}]) expect(autonomyLevel({ autonomy: { level: "autonomous", agents: { lead: value } } }, "lead")).toBe("onboarding");
  expect(autonomyLevel({ autonomy: { level: "trusted" } }, "lead")).toBe("onboarding");
});

test("unrelated generic configuration changes retain legacy autonomy barriers", () => {
  for (const autonomy of [false, 0, "bad", [], { level: "autonomous", agents: [] }, { agents: { lead: "onboarding" } }]) {
    for (const input of [{ values: { "idle.enabled": false } }, { reset: ["idle.enabled"] }]) {
      const result = configurationPatch(input, { autonomy }, { autonomy: { level: "autonomous" }, idle: { enabled: true } });
      expect(result).not.toHaveProperty("error");
      if ("configuration" in result) expect(result.configuration.autonomy).toEqual(autonomy);
    }
  }
});
