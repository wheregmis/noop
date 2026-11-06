import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMessageReceipts, MESSAGE_RECEIPT_TTL, nextMessageReceiptExpiry, pruneMessageReceipts, receiveOwnerMessage, validMessageKey } from "../cloud/src/message-receipts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function hub(file = ":memory:") {
  const db = new Database(file);
  const sql = { exec(query: string, ...bindings: any[]) {
    let rows: any[] = [];
    for (const statement of query.split(";").map((part) => part.trim()).filter(Boolean)) {
      const prepared = db.query(statement);
      if (/^(SELECT|PRAGMA)/i.test(statement)) rows = prepared.all(...bindings); else prepared.run(...bindings);
    }
    return { toArray: () => rows };
  } };
  initMessageReceipts(sql);
  sql.exec("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, text TEXT); CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY)");
  const transaction = <T>(callback: () => T): T => db.transaction(callback)();
  const create = (text: string) => {
    const event = { id: crypto.randomUUID(), ts: new Date().toISOString(), kind: "owner", text };
    sql.exec("INSERT INTO events VALUES (?, ?)", event.id, event.text);
    sql.exec("INSERT INTO inbox VALUES (?)", event.id);
    return event;
  };
  return { db, sql, transaction, create };
}

test("owner receipt replays return one durable event and inbox item across repeated and concurrent requests", async () => {
  const h = hub(), payload = JSON.stringify({ text: "fixture" });
  const send = () => receiveOwnerMessage(h.sql, h.transaction, "owner-session", "fixture-key", payload, () => h.create("fixture"));
  const results = await Promise.all([send(), send(), send()]);
  expect(results.every((result) => result.status === 200)).toBe(true);
  expect(new Set(results.map((result) => result.status === 200 && result.event.id)).size).toBe(1);
  expect(results.filter((result) => result.status === 200 && !result.replayed)).toHaveLength(1);
  expect(h.sql.exec("SELECT * FROM events").toArray()).toHaveLength(1);
  expect(h.sql.exec("SELECT * FROM inbox").toArray()).toHaveLength(1);
  expect(JSON.stringify(h.sql.exec("SELECT * FROM message_receipts").toArray())).not.toContain("fixture-key");
  h.db.close();
});

test("receipts survive reopening the store, reject collisions and scope keys to an owner session", async () => {
  const root = mkdtempSync(join(tmpdir(), "noop-message-receipts-")); roots.push(root);
  const file = join(root, "state.sqlite"), first = hub(file);
  const accepted = await receiveOwnerMessage(first.sql, first.transaction, "session-a", "fixture-key", "payload", () => first.create("fixture"));
  first.db.close();
  const restarted = hub(file);
  let recreated = 0;
  const replay = await receiveOwnerMessage(restarted.sql, restarted.transaction, "session-a", "fixture-key", "payload", () => { recreated++; return restarted.create("duplicate"); });
  expect(replay.status === 200 ? replay.event : null).toEqual(accepted.status === 200 ? accepted.event : null);
  expect(recreated).toBe(0);
  expect((await receiveOwnerMessage(restarted.sql, restarted.transaction, "session-a", "fixture-key", "different", () => restarted.create("different"))).status).toBe(409);
  expect((await receiveOwnerMessage(restarted.sql, restarted.transaction, "session-b", "fixture-key", "payload", () => restarted.create("another owner"))).status).toBe(200);
  expect(restarted.sql.exec("SELECT * FROM events").toArray()).toHaveLength(2);
  restarted.db.close();
});

test("event, inbox and receipt changes roll back together when delivery persistence fails", async () => {
  const h = hub();
  await expect(receiveOwnerMessage(h.sql, h.transaction, "owner", "fixture-key", "payload", () => {
    h.create("fixture"); throw new Error("fixture storage failure");
  })).rejects.toThrow("fixture storage failure");
  for (const table of ["events", "inbox", "message_receipts"]) expect(h.sql.exec(`SELECT * FROM ${table}`).toArray()).toHaveLength(0);
  expect((await receiveOwnerMessage(h.sql, h.transaction, "owner", "fixture-key", "payload", () => h.create("fixture"))).status).toBe(200);
  h.db.close();
});

test("message keys validate before writes and receipts expire after seven days", async () => {
  const h = hub();
  for (const key of ["short", "has spaces", "a".repeat(129), "bad/key/value", "bad\nkey"]) {
    expect(validMessageKey(key)).toBe(false);
    expect((await receiveOwnerMessage(h.sql, h.transaction, "owner", key, "payload", () => h.create("never"))).status).toBe(400);
  }
  const now = 1_000_000;
  await receiveOwnerMessage(h.sql, h.transaction, "owner", "fixture-key", "payload", () => h.create("first"), now);
  expect(nextMessageReceiptExpiry(h.sql)).toBe(now + MESSAGE_RECEIPT_TTL);
  pruneMessageReceipts(h.sql, now + MESSAGE_RECEIPT_TTL - 1); expect(h.sql.exec("SELECT * FROM message_receipts").toArray()).toHaveLength(1);
  pruneMessageReceipts(h.sql, now + MESSAGE_RECEIPT_TTL); expect(nextMessageReceiptExpiry(h.sql)).toBeNull();
  expect((await receiveOwnerMessage(h.sql, h.transaction, "owner", "fixture-key", "new payload", () => h.create("second"), now + MESSAGE_RECEIPT_TTL)).status).toBe(200);
  expect(h.sql.exec("SELECT * FROM events").toArray()).toHaveLength(2);
  h.db.close();
});
