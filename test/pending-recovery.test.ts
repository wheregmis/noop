import { expect, spyOn, test } from "bun:test";
import { createPendingStore, intentScope, PENDING_MAX_BYTES, PENDING_MAX_ENTRIES, readPendingEntry, type PendingEntry, type PendingIO } from "../app/pending-intents";
import type { TaskRunSettings } from "../cloud/src/task-forms";

const at = "2026-11-06T12:00:00.000Z", digest = "a".repeat(64), otherDigest = "b".repeat(64);
const uuid = (index: number) => `12345678-1234-1234-1234-${index.toString(16).padStart(12, "0")}`;
const scope = intentScope("https://hub.example", "fixture-session");
const settings = (): TaskRunSettings => ({ title: "Keep this exact request", agent: "lead", cli: "auto", host: "any", requires: "", priority: "normal", prefer: "", weight: "normal", project: "" });
function task(index = 1): Extract<PendingEntry, { kind: "task" }> {
  const id = `T-${index.toString().padStart(4, "0")}`;
  return { kind: "task", key: id, at, request: { request_id: uuid(index), id, preview_digest: digest, instructions: "Continue only this task", settings: settings() },
    preview: { id, digest, state: "cancelled", can_reopen: true, conflicts: [], warnings: [], settings: settings(), request: "Earlier instructions" }, known_id: id };
}
function archive(): Extract<PendingEntry, { kind: "archive" }> {
  return { kind: "archive", key: digest, at, request: { key: digest, digest: otherDigest, request_id: uuid(10) },
    preview: { entry: { key: digest, kind: "members", id: "writer", name: "Writer", archived_at: at, files: 1, bytes: 100 }, digest: otherDigest,
      can_restore: true, conflicts: [], warnings: [], member: { title: "Writer", name: "Writer", about: "", instructions: "Keep the profile" } } };
}
function stop(): Extract<PendingEntry, { kind: "stop" }> {
  const request = { owner: { kind: "plan" as const, id: "PL-0001" }, operation_id: uuid(20), target_id: "T-0002", preview_digest: digest, action: "exclude" as const, reason: "Reviewed this remaining target", request_id: uuid(21) };
  return { kind: "stop", key: "plan:PL-0001", at, request, preview: { owner: request.owner, operation_id: request.operation_id, target_id: request.target_id, preview_digest: digest,
    target: { kind: "unresolved", id: request.target_id }, current: { state: "missing", records: [] }, can_include: false } };
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const envelope = (entries: unknown[], savedScope = scope) => JSON.stringify({ version: 1, scope: savedScope, entries });
function memory(initial: string | null = null) {
  let raw = initial;
  const writes: string[] = [];
  const io: PendingIO = { read: async () => raw, write: async (value, expected) => {
    if (raw !== expected) throw new Error("Saved requests changed in another context");
    writes.push(value); raw = value;
  } };
  return { io, writes, raw: () => raw };
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("recovery is passive and scoped to the same normalized hub and exact session", async () => {
  const network = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("Recovery must not use HTTP"); }) as unknown as typeof fetch);
  try {
    expect(intentScope(" https://hub.example/// ", "fixture-session")).toBe(scope);
    expect(intentScope("https://other.example", "fixture-session")).not.toBe(scope);
    expect(intentScope("https://hub.example", "other-session")).not.toBe(scope);
    const file = memory(envelope([task(), archive(), stop()]));
    const recovered = createPendingStore(file.io, scope);
    expect(await recovered.load()).toHaveLength(3); expect(file.writes).toHaveLength(0);
    const foreign = createPendingStore(file.io, intentScope("https://hub.example", "other-session"));
    await expect(foreign.load()).rejects.toHaveProperty("code", "scope");
    await expect(foreign.put(task(2))).rejects.toHaveProperty("code", "unloaded");
    expect(file.raw()).toBe(envelope([task(), archive(), stop()])); expect(network).not.toHaveBeenCalled();
    expect(file.raw()).not.toContain("fixture-session");
  } finally { network.mockRestore(); }
});

test("reopen cache bindings reject another task, preview, or known identity", () => {
  const source = task();
  expect(readPendingEntry(source)).toBeDefined();
  const malformed: unknown[] = [
    { ...source, key: "T-0002" }, { ...source, known_id: "T-0002" }, { ...source, request: { ...source.request, id: "T-0002" } },
    { ...source, preview: { ...source.preview!, id: "T-0002" } }, { ...source, preview: { ...source.preview!, digest: otherDigest } },
    { ...source, request: { ...source.request, extra: true } }, { ...source, preview: { ...source.preview!, extra: true } },
    { ...source, key: "create", request: { request_id: uuid(1), instructions: "New task", settings: settings() } },
  ];
  for (const value of malformed) expect(readPendingEntry(value)).toBeUndefined();
  const folder = copy(source);
  folder.request.settings = { ...settings(), project: "__current__", host: "worker" };
  folder.preview!.settings = { ...settings(), project: "__current__", host: "main" }; folder.preview!.repo = "/work/repo";
  expect(readPendingEntry(folder)).toBeUndefined();
  folder.preview!.settings.host = "worker";
  expect(readPendingEntry(folder)).toBeDefined();
});

test("archive recovery binds key and digest, rejects mixed kinds, and strips obsolete proof flags", async () => {
  const source = archive();
  for (const value of [{ ...source, key: otherDigest }, { ...source, request: { ...source.request, digest } },
    { ...source, preview: { ...source.preview, entry: { ...source.preview.entry, key: otherDigest } } },
    { ...source, request: { ...source.request, project: { host: "worker", path: "/work/repo" } } },
    { ...source, preview: { ...source.preview, project: { id: "repo", name: "Repo", host: "worker", path: "/work/repo", instructions: "", repo: null, requires: [] } } }])
    expect(readPendingEntry(value)).toBeUndefined();
  const project = archive();
  project.preview.entry = { ...project.preview.entry, kind: "projects", id: "repo" };
  delete project.preview.member;
  project.preview.project = { id: "repo", name: "Repo", host: "worker", path: "/work/repo", instructions: "", repo: null, requires: [] };
  project.request = { ...project.request, confirm_only: true, project: { host: "worker", path: "/new/repo", probe_ticket: uuid(30) } };
  const file = memory(); const store = createPendingStore(file.io, scope); await store.load(); await store.put(project);
  expect(store.entries()[0]).toMatchObject({ request: { project: { host: "worker", path: "/new/repo" } } });
  expect(file.raw()).not.toContain("confirm_only"); expect(file.raw()).not.toContain("probe_ticket");
  expect(project.request).toHaveProperty("confirm_only", true); expect(project.request.project).toHaveProperty("probe_ticket", uuid(30));
  expect(await createPendingStore(file.io, scope).load()).toEqual(store.entries());
});

test("stop recovery never crosses an owner, operation, target, or preview binding", () => {
  const source = stop();
  expect(readPendingEntry(source)).toBeDefined();
  for (const value of [{ ...source, key: "task:T-0001" }, { ...source, preview: { ...source.preview!, owner: { kind: "plan", id: "PL-0002" } } },
    { ...source, preview: { ...source.preview!, operation_id: uuid(99) } }, { ...source, preview: { ...source.preview!, target_id: "T-0003" } },
    { ...source, preview: { ...source.preview!, preview_digest: otherDigest } }, { ...source, request: { ...source.request, confirm_only: true } },
    { ...source, preview: { ...source.preview!, current: { state: "missing", records: [{ state: "active", host: "worker", run_id: uuid(99) }] } } }])
    expect(readPendingEntry(value)).toBeUndefined();
});

test("one malformed cached entry blocks all recovery until explicit reset without erasing the cache", async () => {
  for (const raw of ["not json", JSON.stringify({ version: 99, scope, entries: [] }), JSON.stringify({ version: 1, scope, entries: [task()], token: "unexpected" }),
    envelope([task(), { ...archive(), kind: "message" }]), envelope([task(), task()]), envelope([{ ...task(), at: "yesterday" }]), envelope([{ ...task(), at: "2026-11-06T12:00:00+00:00" }])]) {
    const file = memory(raw), store = createPendingStore(file.io, scope);
    await expect(store.load()).rejects.toHaveProperty("code", "invalid");
    expect(() => store.entries()).toThrow();
    await expect(store.put(task(2))).rejects.toHaveProperty("code", "unloaded");
    expect(file.writes).toEqual([]); expect(file.raw()).toBe(raw);
    await store.reset(); expect(store.entries()).toEqual([]);
    await store.put(task(2)); expect(store.entries()).toEqual([task(2)]);
  }
});

test("a failed read cannot retain a usable stale in-memory authorization", async () => {
  let fail = false, writes = 0;
  const store = createPendingStore({ read: async () => { if (fail) throw new Error("fixture disk error"); return envelope([task()]); }, write: async () => { writes++; } }, scope);
  await store.load(); fail = true;
  await expect(store.load()).rejects.toHaveProperty("code", "storage");
  expect(() => store.entries()).toThrow();
  await expect(store.remove("task", "T-0001", uuid(1))).rejects.toHaveProperty("code", "unloaded");
  expect(writes).toBe(0);
});

test("ambiguous write failures block queued overwrites until the actual committed file is reloaded", async () => {
  for (const committed of [false, true]) {
    const file = memory(envelope([task()])), started = deferred(), release = deferred();
    let writes = 0;
    const store = createPendingStore({ read: file.io.read, write: async (value, expected) => {
      if (++writes === 1) { if (committed) await file.io.write(value, expected); started.resolve(); await release.promise; }
      await file.io.write(value, expected);
    } }, scope);
    await store.load();
    const removal = store.remove("task", "T-0001", uuid(1)).catch((error) => error);
    const following = store.put(task(2)).catch((error) => error);
    await started.promise; expect(writes).toBe(1); expect(store.entries()).toEqual([task()]);
    release.reject(new Error("fixture failure"));
    expect(await removal).toHaveProperty("code", "storage"); expect(await following).toHaveProperty("code", "unloaded");
    expect(() => store.entries()).toThrow(); expect(writes).toBe(1);
    expect(await store.load()).toEqual(committed ? [] : [task()]);
    await store.put(task(2));
    expect(await createPendingStore(file.io, scope).load()).toEqual(committed ? [task(2)] : [task(), task(2)]);
  }
});

test("same request identity cannot replace its payload and stale dismissal cannot remove a replacement", async () => {
  const file = memory(), store = createPendingStore(file.io, scope); await store.load(); await store.put(task());
  const changed = task(); changed.request.instructions = "Different authorization";
  await expect(store.put(changed)).rejects.toHaveProperty("code", "conflict");
  await store.remove("task", "T-0001", uuid(1));
  const newer = task(); newer.request.request_id = uuid(40); await store.put(newer);
  await expect(store.remove("task", "T-0001", uuid(1))).rejects.toHaveProperty("code", "conflict");
  expect(store.entries()).toEqual([newer]);
  await store.remove("task", "T-9999", uuid(1)); expect(store.entries()).toEqual([newer]);
});

test("recovered snapshots and queued writes are detached from caller mutations", async () => {
  const file = memory(envelope([task()])), store = createPendingStore(file.io, scope);
  const loaded = await store.load(); loaded[0]!.request.request_id = uuid(99);
  expect(store.entries()[0]!.request.request_id).toBe(uuid(1));
  const input = task(2), pending = store.put(input); input.request.instructions = "Changed after submit";
  await pending; const snapshot = store.entries(); snapshot[1]!.request.request_id = uuid(98);
  expect((await createPendingStore(file.io, scope).load())[1]).toEqual(task(2));
});

test("entry and UTF-8 byte limits never evict earlier unconfirmed authorizations", async () => {
  const file = memory(), store = createPendingStore(file.io, scope); await store.load();
  for (let index = 1; index <= PENDING_MAX_ENTRIES; index++) await store.put(task(index));
  const prior = file.raw(); await expect(store.put(task(PENDING_MAX_ENTRIES + 1))).rejects.toHaveProperty("code", "full");
  expect(file.raw()).toBe(prior); expect(store.entries()).toHaveLength(PENDING_MAX_ENTRIES);
  const largeFile = memory(), large = createPendingStore(largeFile.io, scope); await large.load();
  for (let index = 1; index <= 16; index++) { const entry = task(index); delete entry.preview; entry.request.instructions = "€".repeat(20_000); await large.put(entry); }
  const last = largeFile.raw(), overflow = task(17); delete overflow.preview; overflow.request.instructions = "€".repeat(20_000);
  expect(last!.length).toBeLessThan(PENDING_MAX_BYTES);
  await expect(large.put(overflow)).rejects.toHaveProperty("code", "full");
  expect(largeFile.raw()).toBe(last); expect(large.entries()).toHaveLength(16);
});

test("serialization hazards cannot silently change a valid-looking authorization", () => {
  const sparse = task(); sparse.request.settings.project = "repo";
  sparse.request.settings.project_guard = { host: "worker", path: "/work/repo", requires: Array(1) };
  expect(readPendingEntry(sparse)).toBeUndefined();
  const hidden = task(); Object.defineProperty(hidden.request, "instructions", { value: "Hidden required instructions", enumerable: false });
  expect(readPendingEntry(hidden)).toBeUndefined();
});
