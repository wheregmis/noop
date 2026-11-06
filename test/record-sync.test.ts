import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { P } from "../src/core";
import { memberRoute, onPlanChanged, planRoute, projectRoute, recordRequest, routineRoute } from "../src/server";

const ok = { pull: async () => true, push: async () => true };
const request = (kind: string, body: unknown, method = "POST") => new Request(`http://hub/api/${kind}`, { method, body: JSON.stringify(body) });
const member = { title: "Writer", instructions: "Write concise reports." };
let folder = "";
beforeEach(() => {
  for (const dir of ["agents", "plans", "projects", "tasks", "archive"]) rmSync(P(dir), { recursive: true, force: true });
  for (const dir of ["agents/lead", "journal"]) mkdirSync(P(dir), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\n"); writeFileSync(P("config.toml"), "");
  rmSync(P("config.local.toml"), { force: true }); rmSync(P("settings.json"), { force: true });
  folder = mkdtempSync(join(tmpdir(), "noop-record-project-"));
});
const routes = () => [
  { run: (io: typeof ok) => memberRoute(request("members", member), undefined, io), present: () => existsSync(P("agents/writer/profile.md")) },
  { run: (io: typeof ok) => routineRoute(request("routines", { name: "review", every: "hourly", agent: "lead", prompt: "Review" }), undefined, io), present: () => readFileSync(P("config.toml"), "utf8").includes('name = "review"') },
  { run: (io: typeof ok) => projectRoute(request("projects", { name: "Site", path: folder }), undefined, io), present: () => existsSync(P("projects/site.md")) },
  { run: (io: typeof ok) => planRoute(request("plans", { goal: "Improve the UI", agent: "lead" }), undefined, undefined, io), present: () => existsSync(P("plans/PL-0001.json")) },
];
test("a failed refresh prevents every record mutation", async () => {
  for (const route of routes()) {
    expect((await route.run({ ...ok, pull: async () => false })).status).toBe(503);
    expect(route.present()).toBe(false);
  }
});
test("a failed sync returns each saved identity and an explicit partial-save result", async () => {
  for (const route of routes()) {
    const response = await route.run({ ...ok, push: async () => false });
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.saved_locally).toBe(true); expect(body.id ?? body.plan.id).toBeTruthy();
    expect(route.present()).toBe(true);
  }
});
test("concurrent member creates remain serialized through sync and cannot overwrite each other", async () => {
  const order: string[] = [];
  const io = { pull: async () => { order.push("pull"); await Promise.resolve(); return true; }, push: async () => { order.push("push"); await Promise.resolve(); return true; } };
  const responses = await Promise.all([recordRequest(request("members", member), io), recordRequest(request("members", member), io)]);
  expect(order).toEqual(["pull", "push", "pull", "push"]);
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<any>));
  expect(bodies.map((body) => body.id)).toEqual(["writer", "writer-2"]);
  expect(readdirSync(P("agents")).sort()).toEqual(["lead", "writer", "writer-2"]);
});
test("a thrown sync error retains the saved record and failed plans do not wake the planner", async () => {
  const response = await memberRoute(request("members", member), undefined, { ...ok, push: async () => { throw new Error("offline"); } });
  expect(response.status).toBe(503); expect((await response.json() as any).id).toBe("writer");
  let wakes = 0; onPlanChanged(() => { wakes++; });
  try {
    await planRoute(request("plans", { goal: "First", agent: "lead" }), undefined, undefined, { ...ok, push: async () => false });
    expect(wakes).toBe(0);
    await planRoute(request("plans", { goal: "Second", agent: "lead" }), undefined, undefined, ok);
    expect(wakes).toBe(1);
  } finally { onPlanChanged(() => {}); }
});
