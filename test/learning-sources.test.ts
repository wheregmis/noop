import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR, P, writeDoc } from "../src/core";
import { collect, learningBlockReason } from "../src/sessions";
import { appendEvent } from "../src/server";
let root = "";
const old = (Date.now() - 20 * 60_000) / 1000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "noop-learning-"));
  rmSync(join(HOME_DIR, "learn"), { recursive: true, force: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function history() {
  const file = join(root, "hermes.db"), db = new Database(file);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, cwd TEXT); CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, observed INTEGER DEFAULT 0)");
  const session = db.query("INSERT INTO sessions VALUES (?, ?, ?)");
  const message = db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
  session.run("owner", "cli", "/work/project"); message.run(1, "owner", "assistant", "I propose a huge change", old, 1, 0);
  message.run(2, "owner", "user", "Prefer small pull requests. Reach me at person@example.com", old + 1, 1, 0);
  message.run(3, "owner", "user", "Do not collect this archived message", old + 2, 0, 0);
  message.run(4, "owner", "user", "Do not collect this observed input", old + 3, 1, 1);
  session.run("copy", "desktop", "/work/project"); message.run(5, "copy", "user", "Prefer small pull requests. Reach me at person@example.com", old + 1, 1, 0);
  session.run("bot", "cron", "/work/project"); message.run(6, "bot", "user", "Automated scheduled instructions", old, 1, 0);
  session.run("fleet", "cli", "/work/project"); message.run(7, "fleet", "user", "You are **lead**, a permanent member of a fleet", old, 1, 0);
  session.run("live", "cli", "/work/project"); message.run(8, "live", "user", "Still working right now", Date.now() / 1000, 1, 0);
  db.close(); return file;
}
function cfg(file: string, sources = ["hermes"]) {
  // Files used as directories make an accidental scan of an unselected source fail loudly.
  writeFileSync(join(root, "not-a-directory"), "not a directory");
  return { learn: { sources, hermes_db: file, claude_dir: join(root, "not-a-directory"), codex_dir: join(root, "not-a-directory") } };
}
test("selected Hermes learning reads owner turns only, redacts them and leaves the database unchanged", () => {
  const file = history(), before = readFileSync(file);
  const result = collect(cfg(file));
  expect(result.turns).toBe(1); expect(result.sessions).toBe(1);
  const digest = readFileSync(result.file!, "utf8");
  expect(digest).toContain("Prefer small pull requests"); expect(digest).toContain("[email]");
  for (const excluded of ["person@example.com", "archived message", "observed input", "Automated scheduled", "permanent member", "Still working right now"]) expect(digest).not.toContain(excluded);
  expect(readFileSync(file)).toEqual(before);
  expect(collect(cfg(file)).turns).toBe(0);
});
test("turning learning off or deselecting every source does not read histories or advance collection state", () => {
  const file = history();
  expect(collect({ ...cfg(file), learn: { ...cfg(file).learn, enabled: false } }).file).toBeNull();
  expect(collect(cfg(file, [])).file).toBeNull();
  expect(existsSync(join(HOME_DIR, "learn", "state.json"))).toBe(false);
  expect(collect(cfg(file)).turns).toBe(1);
});
test("Claude and Codex can be selected independently of execution tools", () => {
  const claude = join(root, "claude"), codex = join(root, "codex"); mkdirSync(claude); mkdirSync(codex);
  const a = join(claude, "session.jsonl"), b = join(codex, "session.jsonl");
  writeFileSync(a, JSON.stringify({ type: "user", timestamp: new Date(old * 1000).toISOString(), message: { content: "Prefer concise Claude answers." } }));
  writeFileSync(b, JSON.stringify({ type: "response_item", timestamp: new Date(old * 1000).toISOString(), payload: { type: "message", role: "user", content: [{ text: "Prefer tested Codex changes." }] } }));
  utimesSync(a, old, old); utimesSync(b, old, old);
  const settings = { clis: { enabled: [] }, learn: { sources: ["codex"], claude_dir: claude, codex_dir: codex } };
  const selected = collect(settings); expect(selected.turns).toBe(1); expect(readFileSync(selected.file!, "utf8")).toContain("tested Codex");
  const added = collect({ ...settings, learn: { ...settings.learn, sources: ["claude"] } });
  expect(added.turns).toBe(1); expect(readFileSync(added.file!, "utf8")).toContain("concise Claude");
});


test("learning previews preserve watermarks and repeated collections keep earlier digests", () => {
  const settings = cfg(history());
  const preview = collect(settings, { dry: true });
  const original = readFileSync(preview.file!, "utf8");
  expect(existsSync(join(HOME_DIR, "learn", "state.json"))).toBe(false);
  const queued = collect(settings);
  expect(queued.turns).toBe(1);
  expect(queued.file).not.toBe(preview.file);
  const repeated = collect(settings, { full: true });
  expect(repeated.file).not.toBe(queued.file);
  expect(readFileSync(preview.file!, "utf8")).toBe(original);
  expect(readFileSync(queued.file!, "utf8")).toBe(original);
  expect(collect(settings).turns).toBe(0);
});

test("learning preflight explains disabled tools, paused apprentice and unavailable local execution", () => {
  const apprentice = P("agents", "apprentice", "profile.md");
  const previous = existsSync(apprentice) ? readFileSync(apprentice, "utf8") : null;
  mkdirSync(P("agents", "apprentice"), { recursive: true });
  writeFileSync(apprentice, "# Apprentice\n");
  try {
    expect(learningBlockReason({ learn: { enabled: false } }, () => true)).toContain("turned off");
    expect(learningBlockReason({ learn: { sources: [] } }, () => true)).toContain("Select a history");
    expect(learningBlockReason({ clis: { enabled: [] } }, () => true)).toContain("paused");
    expect(learningBlockReason({ clis: { agents: { apprentice: [] } } }, () => true)).toContain("paused");
    expect(learningBlockReason({}, () => false)).toContain("available on this machine");
    expect(learningBlockReason({}, () => true)).toBeNull();
    rmSync(apprentice);
    expect(learningBlockReason({}, () => true)).toContain("apprentice member");
  } finally {
    if (previous !== null) writeFileSync(apprentice, previous); else rmSync(apprentice, { force: true });
  }
});


test("a failed learning task write leaves selected history available for retry", () => {
  const settings = cfg(history());
  expect(() => collect(settings, { beforeCommit: () => { throw new Error("task write failed"); } })).toThrow("task write failed");
  expect(existsSync(join(HOME_DIR, "learn", "state.json"))).toBe(false);
  let queued = false;
  const retried = collect(settings, { beforeCommit: (digest) => {
    expect(existsSync(digest.file)).toBe(true);
    expect(digest.turns).toBe(1);
    queued = true;
  } });
  expect(queued).toBe(true); expect(retried.turns).toBe(1);
  expect(collect(settings).turns).toBe(0);
});

test("digest limits include Noop history, provider turns, headings and truncation markers", () => {
  const claude = join(root, "claude"); mkdirSync(claude);
  const file = join(claude, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", timestamp: new Date(old * 1000).toISOString(), message: { content: "Provider preference: keep changes focused." } }));
  utimesSync(file, old, old);
  mkdirSync(P("decisions"), { recursive: true });
  appendEvent({ from: "owner", kind: "owner", text: "Old Noop history. ".repeat(2000) + " Latest Noop preference: explain the result. Reach me at private@example.com" });
  const settings = { learn: { sources: ["claude", "noop"], claude_dir: claude, max_digest_chars: 10_000 } };
  const result = collect(settings), digest = readFileSync(result.file!, "utf8");
  expect(digest.length).toBeLessThanOrEqual(10_000);
  expect(digest).toStartWith("# Owner's own words");
  expect(digest).toContain("Earlier digest content omitted");
  expect(digest).toContain("Latest Noop preference");
  expect(digest).toContain("Provider preference");
  expect(digest).toContain("[email]"); expect(digest).not.toContain("private@example.com");
  expect(collect(settings).file).toBeNull();
  for (const maxChars of [0, 1, 10, 60, 100]) {
    const tiny = collect(settings, { full: true, dry: true, maxChars });
    expect(readFileSync(tiny.file!, "utf8").length).toBeLessThanOrEqual(maxChars);
  }
});


test("learning redacts decision recommendations and judge metadata before applying its digest cap", () => {
  const decision = P("decisions", "closed", "D-0997.md");
  writeDoc(decision, { id: "D-0997", answered: new Date().toISOString(), answered_by: "owner", question: "Review the proposed change", answer: "yes",
    recommendation: "password=private-recommendation", shadow_verdict: "yes", shadow_answer: "token=private-shadow", overridden_judge: "api_key=private-override" }, "");
  try {
    const result = collect({ learn: { sources: ["noop"], max_digest_chars: 10000 } });
    const digest = readFileSync(result.file!, "utf8");
    expect(digest).toContain("D-0997"); expect(digest).toContain("[REDACTED]");
    for (const secret of ["private-recommendation", "private-shadow", "private-override"]) expect(digest).not.toContain(secret);
    expect(digest.length).toBeLessThanOrEqual(10000);
  } finally { rmSync(decision, { force: true }); }
});
