import { expect, open, test } from "nsh/test";

test("native intent file I/O uses only the test host private directory", async () => {
  const app = await open("./intent-storage.fixture.tsx");
  const directory = app.texts().find((text) => text.startsWith("test-data-dir:"))?.slice("test-data-dir:".length);
  // Headless has no native directory. Run this case with --target macos for the real file path.
  if (directory === "none") { expect(app.shows("ready")).toBe(true); return; }
  expect(directory).toMatch(/\/(?:T|tmp)\/nsh-test-\d+-\d+\/dev\.noop\.app$/);
  await app.press("run-storage");
  await app.waitFor("passed");
});

test("portable intent I/O uses explicit host acknowledgements when a native directory is absent", async () => {
  const documents = new Map<string, string>();
  const app = await open("./intent-storage.fixture.tsx", { platform: "web", host: { handlers: {
    pendingRead: (value: unknown) => { const { scope } = value as { scope: string }; return { scope, text: documents.get(scope) ?? null }; },
    pendingWrite: (value: unknown) => { const { scope, text, expected } = value as { scope: string; text: string; expected: string | null }; if ((documents.get(scope) ?? null) !== expected) throw new Error("stale"); documents.set(scope, text); return { scope, saved: true }; },
  } } });
  await app.press("run-storage"); await app.waitFor("passed");
  expect(documents.get("a".repeat(64))).toBe("{malformed");
});

test("portable intent I/O rejects an unconfirmed host write", async () => {
  const app = await open("./intent-storage.fixture.tsx", { platform: "web", host: { handlers: {
    pendingRead: { scope: "a".repeat(64), text: null },
    pendingWrite: { scope: "a".repeat(64), saved: false },
  } } });
  await app.press("run-storage"); await app.waitFor("text:error: Could not confirm saved pending actions");
});

test("portable intent I/O rejects another session's host read before writing", async () => {
  let writes = 0;
  const app = await open("./intent-storage.fixture.tsx", { platform: "web", host: { handlers: {
    pendingRead: { scope: "b".repeat(64), text: null },
    pendingWrite: () => { writes++; return { scope: "a".repeat(64), saved: true }; },
  } } });
  await app.press("run-storage"); await app.waitFor("text:error: Could not read saved pending actions");
  expect(writes).toBe(0);
});
