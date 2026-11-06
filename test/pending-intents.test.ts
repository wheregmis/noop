import { expect, test } from "bun:test";
import { createPendingStore, intentScope, PendingIntentError, readPendingEntry, type PendingEntry } from "../app/pending-intents";

const scope = intentScope("http://hub.test:8787", "private-session-token");
function entry(key = "create"): Extract<PendingEntry, { kind: "task" }> {
  const settings = { title: "Owner request", agent: "lead", cli: "codex", host: "any", requires: "", priority: "high" as const, prefer: "", weight: "normal" as const, project: "" };
  return { kind: "task", key, at: new Date().toISOString(), request: { request_id: crypto.randomUUID(), instructions: "Keep this exact instruction.", settings } };
}
function memory() {
  let raw: string | null = null; const writes: string[] = [];
  return { io: { read: async () => raw, write: async (text: string, expected: string | null) => { if (raw !== expected) throw new Error("fixture stale document"); raw = text; writes.push(text); } }, writes, raw: () => raw, set: (value: string | null) => { raw = value; } };
}

test("scope uses the app's URL normalization and exposes no raw credential", () => {
  expect(intentScope(" hub.test:8787/// ", "private-session-token")).toBe(scope); expect(scope).toMatch(/^[a-f0-9]{64}$/);
  expect(intentScope("http://hub.test:8787", "another-session")).not.toBe(scope); expect(intentScope("http://other.test", "private-session-token")).not.toBe(scope);
});

test("awaited put persists a detached immutable request before resolving and reloads the same authorization", async () => {
  const cache = memory(), store = createPendingStore(cache.io, scope); expect(() => store.entries()).toThrow(PendingIntentError); await store.load();
  const original = entry(), wanted = structuredClone(original), saved = store.put(original); original.request.instructions = "Changed after call"; await saved;
  expect(store.entries()).toEqual([wanted]); const shown = store.entries(); shown[0].request.request_id = crypto.randomUUID(); expect(store.entries()).toEqual([wanted]);
  expect(await createPendingStore(cache.io, scope).load()).toEqual([wanted]); expect(cache.raw()).not.toContain("private-session-token");
});

test("same-key requests cannot replace another authorization and stale removal cannot clear a newer one", async () => {
  const cache = memory(), store = createPendingStore(cache.io, scope), first = entry(); await store.load(); await store.put(first);
  await expect(store.put(entry())).rejects.toMatchObject({ code: "conflict" }); await expect(store.put({ ...first, request: { ...first.request, instructions: "Different body with the same request ID" } })).rejects.toMatchObject({ code: "conflict" });
  await expect(store.remove("task", "create", crypto.randomUUID())).rejects.toMatchObject({ code: "conflict" }); expect(store.entries()).toEqual([first]);
  await store.remove("task", "create", first.request.request_id); await store.remove("task", "create", first.request.request_id); expect(store.entries()).toEqual([]);
});

test("known task identity can be enriched but never changed or accidentally erased", async () => {
  const cache = memory(), store = createPendingStore(cache.io, scope), first = entry(); await store.load(); await store.put(first);
  await store.put({ ...first, known_id: "T-0901", at: "2026-11-07T00:00:00Z" }); await store.put(first);
  expect(store.entries()[0]).toMatchObject({ known_id: "T-0901", at: first.at });
  await expect(store.put({ ...first, known_id: "T-0902" })).rejects.toMatchObject({ code: "conflict" });
});

test("a write failure blocks later queued mutations until authoritative reload, including committed-but-unacknowledged writes", async () => {
  const cache = memory(), io = { ...cache.io, write: async (text: string) => { cache.set(text); throw new Error("fixture lost rename acknowledgment"); } }, store = createPendingStore(io, scope), first = entry();
  await store.load(); await expect(store.put(first)).rejects.toMatchObject({ code: "storage" }); expect(() => store.entries()).toThrow(PendingIntentError);
  await expect(store.put(entry())).rejects.toMatchObject({ code: "unloaded" }); expect(await store.load()).toEqual([first]);
});

test("writes are serialized and a pending write never exposes uncommitted optimistic entries", async () => {
  const cache = memory(); let release: (() => void) | undefined, calls = 0;
  const store = createPendingStore({ ...cache.io, write: async (text, expected) => { calls++; if (calls === 1) await new Promise<void>((resolve) => { release = resolve; }); await cache.io.write(text, expected); } }, scope);
  await store.load(); const first = entry(), write = store.put(first); await Promise.resolve(); expect(store.entries()).toEqual([]);
  const remove = store.remove("task", first.key, first.request.request_id); await Promise.resolve(); expect(calls).toBe(1); release!(); await write; await remove;
  expect(store.entries()).toEqual([]); expect(cache.writes).toHaveLength(2); expect(JSON.parse(cache.writes[0]).entries).toEqual([first]); expect(JSON.parse(cache.writes[1]).entries).toEqual([]);
});

test("unsupported cached data remains untouched and only explicit reset permits new writes", async () => {
  const cache = memory(), malformed = JSON.stringify({ version: 2, scope, entries: [] }); cache.set(malformed); const store = createPendingStore(cache.io, scope);
  await expect(store.load()).rejects.toMatchObject({ code: "invalid" }); await expect(store.put(entry())).rejects.toMatchObject({ code: "unloaded" }); expect(cache.raw()).toBe(malformed);
  await store.reset(); expect(store.entries()).toEqual([]); expect(JSON.parse(cache.raw()!)).toEqual({ version: 1, scope, entries: [] });
});

test("two stores cannot overwrite each other's saved authorizations and reload permits a safe merge", async () => {
  const cache = memory(), first = createPendingStore(cache.io, scope), second = createPendingStore(cache.io, scope);
  await Promise.all([first.load(), second.load()]); const a = entry(), b = entry("T-0901");
  b.request = { ...b.request, id: b.key, preview_digest: "b".repeat(64) };
  await first.put(a); await expect(second.put(b)).rejects.toMatchObject({ code: "storage" }); expect(() => second.entries()).toThrow(PendingIntentError);
  expect(await second.load()).toEqual([a]); await second.put(b); expect(await first.load()).toEqual([a, b]);
  await expect(second.remove("task", "create", crypto.randomUUID())).rejects.toMatchObject({ code: "conflict" });
  await first.remove("task", "create", a.request.request_id);
  await expect(second.remove("task", b.key, b.request.request_id)).rejects.toMatchObject({ code: "storage" });
  expect(await second.load()).toEqual([b]);
});

test("writes compare the original loaded bytes even when transient transport flags are stripped", async () => {
  const cache = memory(), first = entry(); first.request.confirm_only = true;
  const original = JSON.stringify({ version: 1, scope, entries: [first] }, null, 2); cache.set(original);
  const store = createPendingStore(cache.io, scope); await store.load();
  expect(store.entries()[0].request).not.toHaveProperty("confirm_only"); await store.remove("task", "create", first.request.request_id);
  expect(store.entries()).toEqual([]);
});

test("explicit reset reads the latest shared document and still rejects a concurrent replacement", async () => {
  const cache = memory(), first = createPendingStore(cache.io, scope), second = createPendingStore(cache.io, scope); await Promise.all([first.load(), second.load()]);
  await first.put(entry()); await second.reset(); expect(JSON.parse(cache.raw()!).entries).toEqual([]);
  const saved = cache.raw(), raced = createPendingStore({ ...cache.io, read: async () => { const before = cache.raw(); cache.set("concurrent writer"); return before; } }, scope);
  await expect(raced.reset()).rejects.toMatchObject({ code: "storage" }); expect(cache.raw()).toBe("concurrent writer"); expect(saved).not.toBe(cache.raw());
});

test("plain DTO validation rejects functions accessors cycles sparse arrays and hidden array properties", () => {
  const original = entry(); expect(readPendingEntry(original)).toEqual(original);
  expect(readPendingEntry({ ...original, preview: () => ({}) })).toBeUndefined();
  const accessor = { ...original }; Object.defineProperty(accessor, "request", { enumerable: true, get: () => original.request }); expect(readPendingEntry(accessor)).toBeUndefined();
  const cycle: any = { ...original }; cycle.request = cycle; expect(readPendingEntry(cycle)).toBeUndefined();
  const projects = { ...original, request: { ...original.request, settings: { ...original.request.settings, project: "site", project_guard: { host: "worker", path: "/worker/site", requires: new Array(2) } } } };
  expect(readPendingEntry(projects)).toBeUndefined();
  const array: any = []; array.hidden = "must not be silently dropped"; projects.request.settings.project_guard.requires = array; expect(readPendingEntry(projects)).toBeUndefined();
});
