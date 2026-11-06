import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionSyncError } from "../cloud/src/action-errors";
import { HOME_DIR } from "./core";
import { RequestError } from "./members";
import type { Event } from "./server";

export type RequestResult = { status: number; data: Record<string, unknown> };
type Receipt<T> = { created: number; hash: string; state: "running" | "retryable" | "done"; event: T; result?: RequestResult };
const directory = join(HOME_DIR, "message-receipts"), retention = 7 * 24 * 60 * 60_000;
const active = new Map<string, { hash: string; promise: Promise<RequestResult> }>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const messageUncertain = (event?: Event): RequestResult => ({ status: 503, data: { ok: false, uncertain: true, ...(event ? { message_id: event.id } : {}), error: "This message stopped before its actions were confirmed. Check the team's records before sending it again." } });
function save<T>(file: string, value: Receipt<T>) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

/** A replay reuses its original context and result; only a proven failed refresh may run again. */
export async function receiveRequest<T>(scope: string, key: string | null, payload: unknown, makeContext: () => T,
  apply: (context: T, first: boolean) => Promise<RequestResult>, uncertain: (context?: T) => RequestResult): Promise<RequestResult> {
  if (key !== null && !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) return { status: 400, data: { error: "Invalid request key" } };
  const requestHash = hash(JSON.stringify(payload));
  const id = key === null ? null : hash(`${scope}:${key}`);
  const run = async (): Promise<RequestResult> => {
    let file = "", lock = "", receipt: Receipt<T> | undefined;
    if (id) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(directory)) {
        const old = join(directory, name);
        if (/^[a-f0-9]{64}\.(json|lock)$/.test(name) && Date.now() - statSync(old).mtimeMs > retention) rmSync(old, { force: true });
      }
      file = join(directory, `${id}.json`); lock = join(directory, `${id}.lock`);
      if (existsSync(file)) {
        try { receipt = JSON.parse(readFileSync(file, "utf8")); } catch { return uncertain(); }
        if (!receipt || receipt.hash !== requestHash) return { status: 409, data: { error: "This request key was already used for different content. Start a new request to change it." } };
        if (receipt.state === "done") return receipt.result ?? uncertain(receipt.event);
        if (receipt.state === "running") return uncertain(receipt.event);
      }
      try { writeFileSync(lock, "", { mode: 0o600, flag: "wx" }); } catch { return uncertain(receipt?.event); }
    }
    const first = !receipt;
    receipt ??= { created: Date.now(), hash: requestHash, state: "running", event: makeContext() };
    try {
      try { if (file) save(file, { ...receipt, state: "running" }); }
      catch { return { status: 503, data: { ok: false, retryable: true, error: "Could not record this request safely. Nothing was changed; reconnect and retry." } }; }
      let result: RequestResult;
      try { result = await apply(receipt.event, first); }
      catch (error) {
        if (error instanceof ActionSyncError) {
          result = { status: 503, data: error.data };
        } else result = uncertain(receipt.event);
      }
      const retryable = result.status === 503 && result.data.retryable === true && result.data.uncertain !== true && result.data.saved_locally !== true;
      try { if (file) save(file, { ...receipt, state: retryable ? "retryable" : "done", result }); }
      catch { return { status: 503, data: { ...(result.status === 503 ? result.data : uncertain(receipt.event).data), uncertain: true } }; }
      return result;
    } finally { if (lock) rmSync(lock, { force: true }); }
  };
  if (!id) return run();
  const pending = active.get(id);
  if (pending) return pending.hash === requestHash ? pending.promise : { status: 409, data: { error: "This request key was already used for different content" } };
  const promise = run(); active.set(id, { hash: requestHash, promise });
  try { return await promise; } finally { active.delete(id); }
}

/** Existing chat receipts retain their event and message-specific error identity. */
export function receiveMessage(scope: string, key: string | null, payload: unknown, makeEvent: () => Event,
  apply: (event: Event, first: boolean) => Promise<void>): Promise<RequestResult> {
  return receiveRequest(scope, key, payload, makeEvent, async (event, first) => {
    try { await apply(event, first); return { status: 200, data: event }; }
    catch (error) {
      if (error instanceof RequestError) return { status: error.status, data: { ok: false, message_id: event.id, error: error.message } };
      if (error instanceof ActionSyncError) return { status: 503, data: { ...error.data, message_id: event.id } };
      throw error;
    }
  }, messageUncertain);
}
