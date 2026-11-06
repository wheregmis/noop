/** Keeps the saved identity when a primitive callback cannot return a partial result. */
export class ActionSyncError extends Error {
  readonly data: Record<string, unknown>;
  constructor(message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ActionSyncError";
    this.data = { ...data, ok: false, status: 503, error: message };
  }
}
