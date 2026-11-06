import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { P, hostName, now, pickTask, writeDoc } from "../src/core";

const originalPath = process.env.PATH;
afterEach(() => { process.env.PATH = originalPath; });
beforeEach(() => {
  mkdirSync(P("test-bin"), { recursive: true });
  writeFileSync(P("test-bin/claude"), "#!/bin/sh\nexit 0\n"); chmodSync(P("test-bin/claude"), 0o755);
  process.env.PATH = `${P("test-bin")}:${originalPath}`;
  for (const dir of ["tasks", "fleet"]) rmSync(P(dir), { recursive: true, force: true });
  mkdirSync(P("fleet", "hosts"), { recursive: true });
});

test("preferred alternatives wait for an available preferred host but do not become hard requirements", () => {
  const cfg = { host: { name: "local", caps: [] }, fleet: { prefer_wait_minutes: 10 } };
  const me = hostName(cfg), remote = me === "worker" ? "other" : "worker";
  writeFileSync(P("fleet", "hosts", `${remote}.json`), JSON.stringify({ host: remote, caps: ["gpu", "cli:claude"], enabled: true, seen: now(), busy: 0, version: "1" }));
  const file = P("tasks", "inbox", "T-0940.md");
  // A version-only fixture keeps provider installation and login unrelated to placement.
  const meta = { id: "T-0940", title: "Review", cli: "claude", planned: now(), created: now(), prefer: "gpu|docker" };
  writeDoc(file, meta, "Review.");
  expect(pickTask(cfg)).toBeNull();
  expect(pickTask({ ...cfg, machines: { [remote]: { enabled: false } } })).toBe(file);
  writeDoc(file, { ...meta, created: "2000-01-01T00:00:00Z" }, "Review.");
  expect(pickTask(cfg)).toBe(file);
});


test("preferences do not wait for a host that cannot satisfy the task or selected AI tool", () => {
  const cfg = { host: { name: "local", caps: ["required-local"] }, fleet: { prefer_wait_minutes: 10 }, clis: { enabled: ["claude"] } };
  const file = P("tasks", "inbox", "T-0941.md");
  writeDoc(file, { id: "T-0941", title: "Review", cli: "claude", planned: now(), created: now(), requires: "required-local", prefer: "gpu" }, "Review.");
  const remote = P("fleet", "hosts", "worker.json");
  for (const caps of [["gpu", "cli:claude"], ["gpu", "required-local", "cli:codex"]]) {
    writeFileSync(remote, JSON.stringify({ host: "worker", caps, seen: now(), busy: 0, version: "1" }));
    expect(pickTask(cfg)).toBe(file);
  }
  writeFileSync(remote, JSON.stringify({ host: "worker", caps: ["gpu", "required-local", "cli:claude"], seen: now(), busy: 0, version: "1" }));
  expect(pickTask(cfg)).toBeNull();
});

test("heavy tasks only yield to less-loaded hosts that can run their selected AI tool", () => {
  const cfg = { host: { name: "local" }, clis: { enabled: ["claude"] } };
  const file = P("tasks", "inbox", "T-0942.md");
  writeDoc(file, { id: "T-0942", title: "Build", cli: "claude", planned: now(), created: now(), weight: "heavy" }, "Build.");
  const remote = P("fleet", "hosts", "worker.json");
  const report = { host: "worker", seen: now(), busy: 0, version: "1", stats: { loadRatio: 0.1 } };
  writeFileSync(remote, JSON.stringify({ ...report, caps: ["cli:codex"] }));
  expect(pickTask(cfg, 0.8)).toBe(file);
  writeFileSync(remote, JSON.stringify({ ...report, caps: ["cli:claude"] }));
  expect(pickTask(cfg, 0.8)).toBeNull();
  expect(pickTask({ ...cfg, machines: { worker: { enabled: false } } }, 0.8)).toBe(file);
  expect(pickTask(cfg, 0.8, false)).toBeNull();
});
