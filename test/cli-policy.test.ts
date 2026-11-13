// The owner's per-member CLI policy (Settings → Members → clis.agents) must win over the planner's per-task suggestion.
// It did not: the planner wrote its choice into the task's `cli` field, allowedClis() read that first, so a member
// pinned to codex-only kept running Claude for every task the planner called "hard".
import { expect, test } from "bun:test";
import { allowedClis, cliHintPatch } from "../src/core";

const cfg = (agents?: Record<string, unknown>) => ({ clis: agents ? { agents } : {} }) as any;

test("the owner's per-member CLI wins over the planner's hint", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "claude" }, cfg({ lead: ["codex"] }))).toEqual(["codex"]);
});

test("a CLI pinned on the task itself still wins over the member config", () => {
  expect(allowedClis({ agent: "lead", cli: "claude" }, cfg({ lead: ["codex"] }))).toEqual(["claude"]);
});

test("a CLI pinned on the task itself wins over the planner's hint", () => {
  expect(allowedClis({ agent: "lead", cli: "claude", cli_hint: "codex" }, cfg())).toEqual(["claude"]);
});

test("without a member config the planner's hint decides", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "codex" }, cfg())).toEqual(["codex"]);
});

test("neither config nor hint: either CLI, Claude first", () => {
  expect(allowedClis({ agent: "lead", cli: "auto" }, cfg())).toEqual(["claude", "codex"]);
});

test("a member without its own config is unaffected by another member's", () => {
  expect(allowedClis({ agent: "reporter", cli: "auto", cli_hint: "codex" }, cfg({ lead: ["codex"] }))).toEqual(["codex"]);
});

test("an empty member list falls through instead of forbidding every CLI", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "codex" }, cfg({ lead: [] }))).toEqual(["codex"]);
});

test("a malformed (non-array) member config is ignored instead of crashing", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "codex" }, cfg({ lead: "codex" }))).toEqual(["codex"]);
});

test("a hint outside {claude, codex} is ignored rather than pinned", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "gpt" }, cfg())).toEqual(["claude", "codex"]);
});

test("a member's configured order is kept", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "claude" }, cfg({ lead: ["codex", "claude"] }))).toEqual(["codex", "claude"]);
});

// The write side: what the planner may store on the task afterwards. Reverting `cli_hint` to `cli` here is what
// caused the original bug, so it is asserted directly.
test("the planner's suggestion is stored as cli_hint, never as cli", () => {
  expect(cliHintPatch({ agent: "lead", cli: "auto" }, undefined, "claude")).toEqual({ cli_hint: "claude" });
  expect(cliHintPatch({ agent: "lead", cli: "auto" }, undefined, "claude")).not.toHaveProperty("cli");
});

test("no hint is stored for a member with a policy (it would be overruled anyway)", () => {
  expect(cliHintPatch({ agent: "lead", cli: "auto" }, ["codex"], "claude")).toEqual({});
});

test("no hint is stored on a pinned task", () => {
  expect(cliHintPatch({ agent: "lead", cli: "claude" }, undefined, "codex")).toEqual({});
});

test("a malformed suggestion is dropped instead of being coerced to claude", () => {
  expect(cliHintPatch({ agent: "lead", cli: "auto" }, undefined, "gpt")).toEqual({});
  expect(cliHintPatch({ agent: "lead", cli: "auto" }, undefined, undefined)).toEqual({});
});
