import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { P, loadConfig } from "../src/core";
import { recordRequest, roleRoute } from "../src/server";
import { recordPath } from "../cloud/src/ui-requests";

const io = { pull: async () => true, push: async () => true };
const request = (id?: string, method = "GET", body: unknown = {}) => new Request(`http://hub/api/roles${id ? "/" + id : ""}`, { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => {
  for (const dir of ["agents", "journal"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("journal"), { recursive: true });
  rmSync(P("settings.json"), { force: true }); rmSync(P("config.local.toml"), { force: true });
  writeFileSync(P("config.toml"), "[idle]\nenabled = false\n");
});

test("role catalog and previews expose supplied instructions without installing anything", async () => {
  expect(recordPath("/api/roles/apprentice")).toEqual({ kind: "roles", id: "apprentice", action: undefined });
  expect(recordPath("/api/roles/apprentice/extra")).toBeNull();
  const catalog = await recordRequest(request(), io), list = await catalog.json() as any;
  expect(catalog.status).toBe(200); expect(list.roles.some((role: any) => role.id === "apprentice")).toBe(true);
  const preview = await recordRequest(request("apprentice"), io), role = await preview.json() as any;
  expect(preview.status).toBe(200); expect(role.profile).toContain("Apprentice"); expect(role.installed).toBe(false);
  expect(role.routines.every((routine: any) => routine.enabled === false)).toBe(true);
  expect(existsSync(P("agents/apprentice/profile.md"))).toBe(false);
});

test("adding a specialist refreshes then persists and returns confirmed member/routine settings", async () => {
  let pulled = false, pushed = false;
  const response = await recordRequest(request("apprentice", "POST"), { pull: async () => { pulled = true; return true; }, push: async () => { pushed = true; return true; } });
  const body = await response.json() as any;
  expect(response.status).toBe(200); expect(pulled).toBe(true); expect(pushed).toBe(true);
  expect(body.id).toBe("apprentice"); expect(body.view.effective.agents.some((agent: any) => agent.id === "apprentice")).toBe(true);
  expect(loadConfig().routine.every((routine: any) => routine.enabled === false)).toBe(true);
  writeFileSync(P("agents/apprentice/profile.md"), "# My Apprentice\nCustom instructions.\n");
  const config = readFileSync(P("config.toml"), "utf8");
  expect((await roleRoute(request("apprentice", "POST"), "apprentice", io)).status).toBe(200);
  expect(readFileSync(P("agents/apprentice/profile.md"), "utf8")).toContain("Custom instructions");
  expect(readFileSync(P("config.toml"), "utf8")).toBe(config);
});

test("role actions reject arbitrary files, request bodies and unsupported methods before any write", async () => {
  let pulls = 0;
  const tracked = { ...io, pull: async () => { pulls++; return true; } };
  for (const id of ["missing-role", "../templates", "constructor"]) expect((await roleRoute(request(id), id, tracked)).status).toBe(404);
  for (const body of [null, [], { profile: "replace" }, { enabled: true }, "apprentice"])
    expect((await roleRoute(request("apprentice", "POST", body), "apprentice", tracked)).status).toBe(400);
  expect((await roleRoute(request("apprentice", "DELETE"), "apprentice", tracked)).status).toBe(405);
  expect((await roleRoute(request(undefined, "POST"), undefined, tracked)).status).toBe(405);
  expect(pulls).toBe(0); expect(existsSync(P("agents/apprentice/profile.md"))).toBe(false);
});

test("stale refresh writes nothing and partial sync preserves the specialist identity for safe retry", async () => {
  const failed = await roleRoute(request("apprentice", "POST"), "apprentice", { ...io, pull: async () => false });
  expect(failed.status).toBe(503); expect(existsSync(P("agents/apprentice/profile.md"))).toBe(false);
  const partial = await roleRoute(request("apprentice", "POST"), "apprentice", { ...io, push: async () => false }), body = await partial.json() as any;
  expect(partial.status).toBe(503); expect(body.saved_locally).toBe(true); expect(body.id).toBe("apprentice"); expect(body.view).toBeTruthy();
  expect((await roleRoute(request("apprentice", "POST"), "apprentice", io)).status).toBe(200);
});
