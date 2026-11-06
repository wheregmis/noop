import type { FilesSql } from "./files";

export const MESSAGE_RECEIPT_TTL = 7 * 24 * 60 * 60_000;
export const validMessageKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function initMessageReceipts(sql: FilesSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS message_receipts (session TEXT NOT NULL, key_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, event TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (session, key_hash));
    CREATE INDEX IF NOT EXISTS message_receipts_expires ON message_receipts (expires);`);
}
export function pruneMessageReceipts(sql: FilesSql, now = Date.now()) { sql.exec("DELETE FROM message_receipts WHERE expires <= ?", now); }
export function nextMessageReceiptExpiry(sql: FilesSql): number | null {
  const row = sql.exec("SELECT MIN(expires) AS next FROM message_receipts").toArray()[0];
  return row?.next == null ? null : Number(row.next);
}

/** The create callback persists the event and inbox item in the same synchronous transaction as its receipt. */
export async function receiveOwnerMessage<T>(sql: FilesSql, transaction: <R>(callback: () => R) => R,
  session: string, key: string, payload: string, create: () => T, now = Date.now()): Promise<{ status: 200; event: T; replayed: boolean } | { status: 400 | 409; error: string }> {
  if (!validMessageKey(key)) return { status: 400, error: "Use an Idempotency-Key of 8–128 letters, numbers, dots, underscores, colons or dashes" };
  const [keyHash, payloadHash] = await Promise.all([hash(key), hash(payload)]);
  return transaction(() => {
    pruneMessageReceipts(sql, now);
    const previous = sql.exec("SELECT payload_hash, event FROM message_receipts WHERE session = ? AND key_hash = ?", session, keyHash).toArray()[0];
    if (previous) return previous.payload_hash === payloadHash
      ? { status: 200 as const, event: JSON.parse(String(previous.event)) as T, replayed: true }
      : { status: 409 as const, error: "This message key was already used for different content. Keep the original message or send the edit as a new message." };
    const event = create();
    sql.exec("INSERT INTO message_receipts (session, key_hash, payload_hash, event, expires) VALUES (?, ?, ?, ?, ?)", session, keyHash, payloadHash, JSON.stringify(event), now + MESSAGE_RECEIPT_TTL);
    return { status: 200 as const, event, replayed: false };
  });
}
