import { recordPath, type UiJob, type UiResult } from "../cloud/src/ui-requests";
import type { ProjectFolderCheck } from "../cloud/src/machine-requests";

/** Keep a completed result until the cloud acknowledges it; a failed upload must never re-run a create or delete. */
export async function applyUiRequest(id: string, send: (path: string, init: RequestInit) => Promise<any>,
  route: (req: Request, projectFolder?: ProjectFolderCheck) => Promise<Response>, results: Map<string, UiResult>) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid remote form request");
  const path = `/api/host/ui-requests/${id}`;
  let result = results.get(id);
  if (!result) {
    const claim = await send(path, { method: "POST" });
    if (!claim) throw new Error("Could not claim remote form request");
    if (claim.done) return;
    const job = claim.job as UiJob;
    if (!job || !recordPath(job.path) || !["GET", "POST", "PUT", "DELETE"].includes(job.method)) throw new Error("Invalid remote form route");
    try {
      const response = await route(new Request(`http://hub${job.path}`, { method: job.method,
          ...(job.method === "GET" || job.method === "DELETE" ? {} : { body: JSON.stringify(job.body), headers: { "Content-Type": "application/json", ...(job.path === "/api/tasks/cancel" ? { "Idempotency-Key": `ui-${id}` } : {}) } }) }), job.project_folder);
      result = { status: response.status, data: await response.json() as Record<string, unknown> };
    } catch (e) {
      console.error("remote form:", e);
      result = { status: 500, data: { error: "The main machine could not confirm this request. Check the record before saving again." } };
    }
    results.set(id, result);
  }
  const saved = await send(path, { method: "PUT", body: JSON.stringify(result) });
  if (!saved?.ok) throw new Error("Could not confirm remote form result");
  results.delete(id);
}
