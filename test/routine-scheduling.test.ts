import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, P, list, readDoc, setApprovalGate } from "../src/core";
import { runRoutines } from "../src/cli";

beforeEach(() => {
  for (const dir of ["tasks", "logs", "journal", "projects"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("logs"), { recursive: true });
  mkdirSync(P("journal"), { recursive: true });
  setApprovalGate(() => false);
});
const tasks = (state = "inbox") => list(P("tasks", state), /\.md$/).map((p) => readDoc(p).meta);
const routine = { name: "check", every: "hourly", agent: "lead", prompt: "Check the project." };
const cfg = (r: object[]) => ({ idle: { enabled: false }, routine: r });
const makeDue = () => {
  for (const f of list(P("logs"), /^routine-state.*\.json$/)) {
    const state = JSON.parse(readFileSync(f, "utf8"));
    for (const key of Object.keys(state)) if (!key.endsWith("#signal")) state[key] = "2000-01-01T00:00:00Z";
    writeFileSync(f, JSON.stringify(state));
  }
};

test("a worker's scheduler runs only on that worker; default routines stay on the primary", () => {
  const c = cfg([routine, { ...routine, name: "mac-check", scheduler: "mac", prefer: "gpu", weight: "heavy" }]);
  runRoutines(c, "pc", true);
  expect(tasks().map((t) => t.source)).toEqual(["routine:check"]);
  runRoutines(c, "linux", false);
  expect(tasks()).toHaveLength(1);
  runRoutines(c, "mac", false);
  expect(tasks()).toHaveLength(2);
  expect(tasks().find((t) => t.source === "routine:mac-check")).toMatchObject({ scheduled_by: "mac", prefer: "gpu", weight: "heavy" });
});

test("each-machine routines keep independent clocks, local placement, and change-detector state", () => {
  const c = cfg([{ ...routine, scheduler: "each", signal: "printf stable" }]);
  runRoutines(c, "mac", true);
  runRoutines(c, "linux", false);
  expect(tasks().map((t) => t.host).sort()).toEqual(["linux", "mac"]);
  const state = JSON.parse(readFileSync(P("logs", "routine-state.json"), "utf8"));
  expect(state["check@mac#signal"]).toBeTruthy();
  expect(JSON.parse(readFileSync(P("logs", "routine-state-linux.json"), "utf8"))["check@linux#signal"]).toBeTruthy();
  expect(state["check@linux#signal"]).toBeUndefined();
  makeDue();
  runRoutines(c, "mac", true);
  runRoutines(c, "linux", false);
  expect(tasks()).toHaveLength(2); // each machine dedupes its own queued copy
});

test("each-machine proposals supersede only that machine's earlier proposal", () => {
  setApprovalGate(() => true);
  const c = cfg([{ ...routine, scheduler: "each" }]);
  runRoutines(c, "mac", true);
  runRoutines(c, "linux", false);
  const linux = tasks("proposed").find((t) => t.scheduled_by === "linux")!.id;
  expect(tasks("proposed")).toHaveLength(2);
  makeDue();
  runRoutines(c, "mac", true);
  expect(tasks("proposed")).toHaveLength(2);
  expect(tasks("proposed").some((t) => t.id === linux)).toBe(true);
  expect(tasks("rejected")).toHaveLength(1);
  setApprovalGate(() => false);
});

test("learning routines preserve history progress while the apprentice is missing or paused", () => {
  const profile = P("agents", "apprentice", "profile.md");
  const original = existsSync(profile) ? readFileSync(profile, "utf8") : null;
  const learnState = join(HOME_DIR, "learn", "state.json");
  mkdirSync(join(HOME_DIR, "learn"), { recursive: true });
  const before = JSON.stringify({ __hub_since: "2000-01-01T00:00:00Z" });
  writeFileSync(learnState, before);
  const learning = cfg([{ name: "learn-owner", kind: "learn", every: "hourly" }]);
  try {
    rmSync(profile, { force: true });
    runRoutines(learning, "mac", true);
    expect(tasks()).toHaveLength(0);
    expect(readFileSync(learnState, "utf8")).toBe(before);
    mkdirSync(P("agents", "apprentice"), { recursive: true });
    writeFileSync(profile, "# Apprentice\n");
    makeDue();
    runRoutines({ ...learning, clis: { enabled: [] } }, "mac", true);
    expect(tasks()).toHaveLength(0);
    expect(readFileSync(learnState, "utf8")).toBe(before);
    expect(readFileSync(P("journal", `${new Date().toISOString().slice(0, 10)}.md`), "utf8")).toContain("learn skipped");
  } finally {
    if (original === null) rmSync(profile, { force: true }); else writeFileSync(profile, original);
  }
});
