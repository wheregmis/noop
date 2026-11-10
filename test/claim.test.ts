// A claim whose push fails must not lose the task. core.claim reverts to the last synced state, and a task queued on
// this host (requeued when its card was answered, reopened, woken) that was not pushed yet has no synced copy.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DATA, HOME_DIR, P, claim } from "../src/core";
import * as sync from "../src/sync";

test("a claim that cannot be pushed puts back a task that was never pushed", async () => {
  sync.setSyncData(DATA, HOME_DIR);
  mkdirSync(P("tasks", "inbox"), { recursive: true });
  const src = P("tasks", "inbox", "T-9301.md");
  writeFileSync(src, "---\nid: T-9301\ntitle: requeued after its card was answered\n---\nbody\n");
  sync.setTransport(async () => null); // the push fails (offline here; a lost race on another path does the same)
  try { expect(await claim(src, "h1")).toBeNull(); } finally { sync.setTransport(null); }
  expect(existsSync(src)).toBe(true);
  expect(existsSync(P("tasks", "active", "T-9301.md"))).toBe(false);
});
