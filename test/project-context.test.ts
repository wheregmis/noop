import { expect, test } from "bun:test";
import { applyUiRequest } from "../src/ui-requests";
import type { UiResult } from "../cloud/src/ui-requests";
import type { ProjectFolderCheck } from "../cloud/src/machine-requests";

test("the primary receives folder proof separately from the form and does not reapply it after a lost result", async () => {
  const id = crypto.randomUUID(), body = { name: "Worker app", host: "worker", path: "~/app", probe_ticket: crypto.randomUUID() };
  const proof: ProjectFolderCheck = { host: "worker", requested_path: "~/app", path: "/worker/app", repo: "acme/app", requires: ["cli:cargo"], checked: new Date().toISOString() };
  let calls = 0, uploaded = false;
  const send = async (_path: string, init: RequestInit) => {
    if (init.method === "POST") return { job: { path: "/api/projects", method: "POST", body, project_folder: proof } };
    if (!uploaded) { uploaded = true; return null; }
    expect(JSON.parse(String(init.body))).toEqual({ status: 200, data: { id: "worker-app" } });
    return { ok: true };
  };
  const route = async (req: Request, projectFolder?: ProjectFolderCheck) => {
    calls++; expect(await req.json()).toEqual(body); expect(projectFolder).toEqual(proof);
    return Response.json({ id: "worker-app" });
  };
  const results = new Map<string, UiResult>();
  await expect(applyUiRequest(id, send, route, results)).rejects.toThrow("confirm");
  await applyUiRequest(id, send, route, results);
  expect(calls).toBe(1); expect(results.size).toBe(0);
});
