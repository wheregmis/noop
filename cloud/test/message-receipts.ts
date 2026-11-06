// Synthetic messages against an isolated local production Worker only. No real machine should consume this inbox.
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "This test only runs against an isolated local Worker");
const legacy = "ui-test-token", checkpoint = process.argv[3];
const replayOnly = process.argv.includes("--replay");
const request = async (path: string, token: string, method = "GET", body?: unknown, key?: string) => {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(key === undefined ? {} : { "Idempotency-Key": key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) as any : null };
};
const rows = async (table: string) => (await request(`/api/host/export?table=${table}`, legacy)).data.rows as any[];
if (replayOnly) {
  assert(checkpoint, "Pass the saved checkpoint after restarting the isolated Worker");
  const saved = JSON.parse(readFileSync(checkpoint, "utf8"));
  const replay = await request("/api/messages", saved.owner, "POST", saved.body, saved.key);
  assert.equal(replay.status, 200); assert.deepEqual(replay.data, saved.event);
  assert.equal((await rows("events")).filter((row) => JSON.parse(row.json).id === saved.event.id).length, 1);
  assert.equal((await rows("inbox")).filter((row) => JSON.parse(row.json).event?.id === saved.event.id).length, 1);
  await request("/api/auth/logout", saved.owner, "POST", {});
  console.log("Message receipt survived a Worker restart with one original event and inbox item.");
  process.exit(0);
}

const owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""), other = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const tag = `message-receipt-${crypto.randomUUID()}`, key = crypto.randomUUID();
await request("/api/host/import", legacy, "POST", { table: "sessions", rows: await Promise.all([owner, other].map(async (token) => ({ id: await hash(token), email: "message-fixture@example.com", created: Date.now(), last_seen: Date.now(), ua: "message-receipt-test" }))) });
let keepOwner = false;
try {
  const body = { text: tag, reply_to: "T-0901", thread: true, attachments: [] };
  const first = await request("/api/messages", owner, "POST", body, key);
  assert.equal(first.status, 200); assert.equal(first.data.thread, true); assert.equal(first.data.ref, body.reply_to);
  const repeated = await Promise.all(Array.from({ length: 3 }, () => request("/api/messages", owner, "POST", { attachments: [], thread: true, reply_to: "T-0901", text: tag }, key)));
  for (const result of repeated) { assert.equal(result.status, 200); assert.deepEqual(result.data, first.data); }
  assert.equal((await rows("events")).filter((row) => JSON.parse(row.json).id === first.data.id).length, 1);
  assert.equal((await rows("inbox")).filter((row) => JSON.parse(row.json).event?.id === first.data.id).length, 1);
  for (const changed of [{ ...body, text: tag + " changed" }, { ...body, reply_to: "T-0902" }, { ...body, thread: false }, { ...body, attachments: ["/media/not-present"] }])
    assert.equal((await request("/api/messages", owner, "POST", changed, key)).status, 409);
  const another = await request("/api/messages", other, "POST", body, key);
  assert.equal(another.status, 200); assert.notEqual(another.data.id, first.data.id);
  for (const badKey of ["short", "has spaces", "a".repeat(129), "not/a/key"])
    assert.equal((await request("/api/messages", owner, "POST", { text: tag + " invalid" }, badKey)).status, 400);
  for (const invalid of [null, [], { text: {} }, { text: tag, reply_to: {} }, { text: tag, thread: "yes" }, { text: "" }])
    assert.equal((await request("/api/messages", owner, "POST", invalid, crypto.randomUUID())).status, 400);
  assert.equal((await request("/api/messages", legacy, "POST", { text: tag + " machine" }, crypto.randomUUID())).status, 403);
  const a = await request("/api/messages", owner, "POST", { text: tag + " old-client" }), b = await request("/api/messages", owner, "POST", { text: tag + " old-client" });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.data.id, b.data.id);
  const preflight = await request("/api/messages", owner, "OPTIONS");
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get("Access-Control-Allow-Headers")!, /idempotency-key/i);
  assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await request("/api/host/export?table=message_receipts", legacy)).status, 404);
  assert.equal((await request("/api/host/import", legacy, "POST", { table: "message_receipts", rows: [], reset: true })).status, 404);
  if (checkpoint) { writeFileSync(checkpoint, JSON.stringify({ owner, body, key, event: first.data }), { mode: 0o600 }); keepOwner = true; }
  console.log("Cloud messages: session-scoped retries, payload conflicts, concurrent sends, body/key validation, legacy sends, inbox uniqueness and CORS passed in workerd.");
} finally {
  await request("/api/auth/logout", other, "POST", {});
  if (!keepOwner) await request("/api/auth/logout", owner, "POST", {});
}
