import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { P } from "../src/core";
import { documentRoute, recordRequest } from "../src/server";
import { editableDocument } from "../cloud/src/documents";
const io = { pull: async () => true, push: async () => true };
const call = (method: string, body: unknown, sync = io) => documentRoute(new Request("http://hub/api/documents", { method, body: JSON.stringify(body) }), sync);
beforeEach(() => {
  for (const path of ["policies", "memory", "agents/test-writer"]) rmSync(P(path), { recursive: true, force: true });
  mkdirSync(P("policies"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("policies/team.md"), "---\nid: team\nowner: lead\n---\n# Rules\nOld rule\n");
});
test("owner edits preserve metadata and reject a stale draft without overwriting newer agent changes", async () => {
  const path = "policies/team.md";
  const original = await (await call("POST", { path })).json() as any;
  expect(original.content).toContain("owner: lead");
  const updated = await call("PUT", { path, base: original.content, content: "# Rules\nAsk before deploying.\n" });
  expect(updated.status).toBe(200);
  expect(readFileSync(P(path), "utf8")).toBe("---\nid: team\nowner: lead\n---\n# Rules\nAsk before deploying.\n");
  const stale = await call("PUT", { path, base: original.content, content: "Stale draft" });
  expect(stale.status).toBe(409); expect(readFileSync(P(path), "utf8")).not.toContain("Stale draft");
});
test("create preferences and member memory, but never resurrect a deleted member", async () => {
  const path = "memory/review-style.md";
  expect((await (await call("POST", { path })).json() as any).content).toBeNull();
  expect((await call("PUT", { path, base: null, content: "Prefer concise reviews." })).status).toBe(200);
  expect((await call("PUT", { path, base: null, content: "Overwrite" })).status).toBe(409);
  const memory = "agents/test-writer/memory.md";
  expect((await call("PUT", { path: memory, base: null, content: "Remember" })).status).toBe(404);
  mkdirSync(P("agents/test-writer"), { recursive: true }); writeFileSync(P("agents/test-writer/profile.md"), "# Writer");
  expect((await call("PUT", { path: memory, base: null, content: "Remember" })).status).toBe(200);
});
test("knowledge boundary excludes credentials, member profiles, decisions, traversal and linked paths", async () => {
  for (const path of ["config.toml", "agents/lead/profile.md", "decisions/closed/D-0001.md", "policies/../config.md", "policies/.git/test.md", "memory//a.md", "memory/a.txt", "memory/a.md/../../config.md"]) {
    expect(editableDocument(path)).toBe(false);
    expect((await call("PUT", { path, base: null, content: "bad" })).status).toBe(400);
  }
  symlinkSync(P("config.toml"), P("policies/link.md"));
  expect((await call("POST", { path: "policies/link.md" })).status).toBe(400);
  symlinkSync(P("agents"), P("policies/linked"));
  expect((await call("PUT", { path: "policies/linked/a.md", base: null, content: "bad" })).status).toBe(400);
});
test("invalid content, oversized files and failed synchronization cannot claim a successful edit", async () => {
  for (const content of [null, 1, "x".repeat(64001)]) expect((await call("PUT", { path: "memory/test.md", base: null, content })).status).toBe(400);
  const original = readFileSync(P("policies/team.md"), "utf8");
  expect((await call("PUT", { path: "policies/team.md", base: original, content: "New" }, { ...io, pull: async () => false })).status).toBe(503);
  expect(readFileSync(P("policies/team.md"), "utf8")).toBe(original);
  expect((await call("PUT", { path: "policies/team.md", base: original, content: "New" }, { ...io, push: async () => false })).status).toBe(503);
  expect((await recordRequest(new Request("http://hub/api/documents"))).status).toBe(405);
});
