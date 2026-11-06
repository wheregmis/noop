import { ActionSyncError } from "../cloud/src/action-errors";
import { _commitPush, _pull, locked } from "./core";

/** Preserve primitive hook APIs while making failed refreshes and unconfirmed writes explicit. */
export function persistOwnerAction<T extends Record<string, unknown>>(change: (saved: (value: Record<string, unknown>) => void) => T, describe: (value: T) => string,
  io = { pull: _pull, push: _commitPush }): Promise<T> {
  return locked(async () => {
    let refreshed = false;
    try { refreshed = await io.pull(); } catch { /* No mutation is allowed before a successful refresh. */ }
    if (!refreshed) throw new ActionSyncError("Could not load the latest team data. Nothing was changed. Reconnect the main machine and retry.", { retryable: true });
    let saved: Record<string, unknown> | undefined, value: T;
    try { value = change((record) => { saved = record; }); }
    catch {
      const identity = saved?.id ?? saved?.file ?? "the change";
      throw new ActionSyncError(`Could not confirm ${identity}. Check the saved records before repeating this action.`, { ...saved, ...(saved ? { saved_locally: true } : {}), uncertain: true });
    }
    if (value.ok === false) return value;
    try { if (await io.push(describe(value))) return value; } catch { /* Retain the saved record and its identity. */ }
    const identity = value.id ?? value.file ?? "the change";
    throw new ActionSyncError(`Saved ${identity} on the main machine, but sync could not be confirmed. Check the saved record before repeating this action.`, { ...value, saved_locally: true });
  });
}
