import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as accounts from "../src/accounts";
import { dataActs, reopenTask as reopenFromChat } from "../src/brain";
import { appendTaskFollowUp, processTask } from "../src/cli";
import { DATA, HOME_DIR, P, claim, loadConfig, matches, pickTask, readDoc, setAccountAvailability, writeDoc } from "../src/core";
import { recordRequest, status, taskView } from "../src/server";
import { LEARN_PROMPT } from "../src/sessions";
import { previewTaskReopen, reopenTask } from "../src/task-forms";
import { readTaskReopenPreview } from "../cloud/src/task-forms";
import { setSyncData, setTransport } from "../src/sync";

const host = "learning-source", other = "other-worker", id = "T-M0980", io = { pull: async () => true, push: async () => true };
const legacy = "Learn the owner. Read the redacted digest of the owner's own messages to AI coding agents at:\n/private/fixture/digest.md\n(local to this machine; never copy raw text or the file into the hub repo, never quote secrets).\n";
const originalPath = process.env.PATH;
let work = "";
beforeEach(() => {
  setSyncData(DATA, HOME_DIR); setTransport(null);
  for (const dir of ["tasks", "projects", "agents", "fleet", "plans", "journal", "decisions"]) rmSync(P(dir), { recursive: true, force: true });
  for (const file of ["settings.json", "config.local.toml"]) rmSync(P(file), { force: true });
  mkdirSync(P("agents/lead"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\n");
  writeFileSync(P("config.toml"), `[host]\nname='${host}'\n[fleet]\nprimary='${host}'\n[clis]\nenabled=['claude']\n`);
  work = mkdtempSync(join(tmpdir(), "noop-learning-placement-"));
  writeFileSync(join(work, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\nexit 99\n", { mode: 0o755 });
  process.env.PATH = work; setAccountAvailability(() => true);
});
afterEach(() => { setSyncData(DATA, HOME_DIR); setTransport(null); setAccountAvailability(accounts.accountCanRun); process.env.PATH = originalPath; rmSync(work, { recursive: true, force: true }); rmSync(P("fleet/task-forms"), { recursive: true, force: true }); rmSync(P("fleet/task-ids"), { recursive: true, force: true }); });
function task(folder = "inbox", extra: Record<string, string | undefined> = {}, body = LEARN_PROMPT("digest-fixture.md")) {
  const path = P("tasks", folder, `${id}.md`);
  writeDoc(path, { id, title: "Learn the owner", agent: "lead", cli: "auto", host, source: `owner@${host}`, planned: new Date().toISOString(), learning_host: host, ...extra }, body);
  return path;
}
const placement = (target = host, extra = {}) => ({ tool: "configure_task" as const, id, host: target, agent: "lead", cli: "auto", priority: "normal" as const, requires: "", ...extra });
const form = () => { const preview = previewTaskReopen({ id }); return { request_id: crypto.randomUUID(), id, preview_digest: preview.digest, instructions: "Continue the reviewed learning task.", settings: preview.settings }; };

test("refreshed task configuration refuses another machine or its project without changing the task", async () => {
  const path = task(), before = readFileSync(path, "utf8"); let pushes = 0;
  writeDoc(P("projects/remote.md"), { host: other, path: "/remote/project" }, "Remote");
  const act = dataActs(host, { ...io, push: async () => { pushes++; return true; } });
  for (const op of [placement(other), placement(other, { project: "remote" })]) {
    expect(await act.configure_task!(op)).toMatchObject({ ok: false, status: 409, id });
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  expect(pushes).toBe(0);
  expect(await act.configure_task!(placement())).toMatchObject({ ok: true, id });
  expect(readDoc(path).meta.learning_host).toBe(host);
});

test("configuration revalidates the learning origin after its checked pull", async () => {
  const path = task();
  const act = dataActs(host, { pull: async () => { const doc = readDoc(path); writeDoc(path, { ...doc.meta, learning_host: other }, doc.body); return true; }, push: async () => { throw new Error("must not push"); } });
  expect(await act.configure_task!(placement())).toMatchObject({ ok: false, status: 409 });
  expect(readDoc(path).meta).toMatchObject({ host, learning_host: other });
});

test("approved legacy tasks retain their source binding across reassignment and configuration", async () => {
  const path = task("inbox", { learning_host: undefined as any, source: `approved:owner@${host}`, agent: "lead" }, legacy);
  const act = dataActs(host, io);
  expect(await act.configure_task!(placement(other))).toMatchObject({ ok: false, status: 409 });
  expect(await act.configure_task!(placement(host, { title: "Renamed learning task" }))).toMatchObject({ ok: true });
  expect(readDoc(path).meta).toMatchObject({ learning_host: host, title: "Renamed learning task" });
});

test("reopen preview repairs an edited target to the verified host and detaches an incompatible project", () => {
  writeDoc(P("projects/remote.md"), { host: other, path: "/remote/project" }, "Remote");
  const path = task("done", { host: other, project: "remote", repo: "/remote/project" }), before = readFileSync(path, "utf8");
  const preview = previewTaskReopen({ id });
  expect(readTaskReopenPreview(preview)).toEqual(preview); expect(preview.can_reopen).toBe(true);
  expect(preview).toMatchObject({ learning_host: host, settings: { host, project: "" } });
  expect(preview.settings.project_guard).toBeUndefined(); expect(preview.warnings.join(" ")).toContain("previous folder");
  const input = form(); input.settings.host = other;
  expect(() => reopenTask(input)).toThrow("must run on"); expect(readFileSync(path, "utf8")).toBe(before);
  input.settings = preview.settings; expect(reopenTask(input).applied).toBe(true);
  expect(readDoc(P("tasks/inbox", `${id}.md`)).meta).toMatchObject({ host, learning_host: host, project: "", repo: "" });
});

test("reopen preserves all new receipt markers and stamps reliable legacy origin before rewriting source", () => {
  for (const old of [false, true]) {
    rmSync(P("tasks"), { recursive: true, force: true });
    task("done", old ? { learning_host: undefined as any, source: `approved:owner@${host}` } : { learning_request_id: crypto.randomUUID(), learning_preview: "a".repeat(64) }, old ? legacy : LEARN_PROMPT("digest-fixture.md"));
    const input = form(); expect(reopenTask(input).applied).toBe(true);
    const doc = readDoc(P("tasks/inbox", `${id}.md`)); expect(doc.meta).toMatchObject({ learning_host: host, source: "owner@ui", host });
    if (!old) { expect(doc.meta.learning_request_id).toBeDefined(); expect(doc.meta.learning_preview).toBe("a".repeat(64)); }
  }
});

test("unknown legacy and malformed markers cannot be reopened, while ordinary apprentice work is unrestricted", () => {
  for (const [extra, body] of [[{ learning_host: undefined, source: "approved:routine:learn" }, legacy], [{ learning_host: "" }, "Body"], [{ learning_host: undefined, learning_preview: "a".repeat(64) }, "Body"]] as const) {
    rmSync(P("tasks"), { recursive: true, force: true }); task("done", extra as any, body);
    const preview = previewTaskReopen({ id }); expect(readTaskReopenPreview(preview)).toEqual(preview); expect(preview.can_reopen).toBe(false); expect(preview.learning_host_error).toContain("no verified source machine");
    expect(() => reopenFromChat(P("tasks/done", `${id}.md`), "Continue")).toThrow("no verified source machine");
  }
  rmSync(P("tasks"), { recursive: true, force: true }); task("done", { learning_host: undefined as any, agent: "apprentice", host: other }, "Ordinary apprentice task");
  expect(previewTaskReopen({ id })).toMatchObject({ can_reopen: true, settings: { host: other } });
});

test("internal chat reopen refuses an edited target and persists reliable legacy source", () => {
  const path = task("failed", { host: other }), before = readFileSync(path, "utf8");
  expect(() => reopenFromChat(path, "Continue")).toThrow("must run on"); expect(readFileSync(path, "utf8")).toBe(before);
  task("failed", { learning_host: undefined as any, source: `approved:owner@${host}` }, legacy);
  reopenFromChat(path, "Continue"); expect(readDoc(P("tasks/inbox", `${id}.md`)).meta.learning_host).toBe(host);
});

test("owner follow-ups reject a misplaced waiting or finished learning task without appending or waking it", async () => {
  for (const folder of ["waiting", "done"]) {
    rmSync(P("tasks"), { recursive: true, force: true });
    const path = task(folder, { host: other }), before = readFileSync(path, "utf8"); let pushes = 0;
    const result = await appendTaskFollowUp(loadConfig(), host, id, "Continue", { ...io, push: async () => { pushes++; return true; } });
    expect(result).toMatchObject({ ok: false, id }); expect(result.error).toContain(`must run on ${host}`);
    expect(readFileSync(path, "utf8")).toBe(before); expect(existsSync(P("tasks/inbox", `${id}.md`))).toBe(false); expect(pushes).toBe(0);
  }
});

test("scheduler and direct claim reject moved, unknown and malformed bindings before any active write", async () => {
  for (const extra of [{ host: other }, { learning_host: "" }, { learning_host: "any" }, { learning_host: undefined, learning_request_id: crypto.randomUUID() }]) {
    const path = task("inbox", extra as any), before = readFileSync(path, "utf8");
    expect(matches(readDoc(path).meta, [`host:${host}`, `host:${other}`], readDoc(path).body)).toBe(false);
    expect(pickTask(loadConfig())).toBeNull(); expect(await claim(path, host)).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(before); expect(existsSync(P("tasks/active", `${id}.md`))).toBe(false);
  }
  const path = task("inbox", { learning_host: undefined as any, source: `approved:owner@${host}` }, legacy);
  expect(pickTask(loadConfig())).toBe(path); expect(await claim(path, other)).toBeNull();
  expect(await claim(path, host)).toBe(P("tasks/active", `${id}.md`)); expect(readDoc(P("tasks/active", `${id}.md`)).meta.learning_host).toBe(host);
});

test("claim rechecks a task changed after selection and ordinary tasks retain normal placement", async () => {
  const path = task(); expect(pickTask(loadConfig())).toBe(path);
  const doc = readDoc(path); writeDoc(path, { ...doc.meta, host: other }, doc.body);
  expect(await claim(path, host)).toBeNull(); expect(existsSync(path)).toBe(true);
  writeDoc(path, { ...doc.meta, learning_host: undefined, host: "any" }, "Ordinary request");
  expect(pickTask(loadConfig())).toBe(path); expect(await claim(path, host)).toBe(P("tasks/active", `${id}.md`));
});

test("runtime rejects direct moved learning runs before account selection and returns them to an actionable queue state", async () => {
  const path = task("active", { host: other, claimed_by: other, run_id: crypto.randomUUID() });
  const choose = spyOn(accounts, "pickAccount").mockImplementation(() => { throw new Error("must not select an account"); });
  try { await processTask(path, loadConfig(), other); expect(choose).not.toHaveBeenCalled(); }
  finally { choose.mockRestore(); }
  expect(existsSync(path)).toBe(false);
  const queued = P("tasks/inbox", `${id}.md`), view = taskView(queued, "inbox", []);
  expect(view).toMatchObject({ learning_host: host, target_host: other, state: "nohost" }); expect(view.needs).toContain(`must run on ${host}`);
  expect(status().recent.find((value) => value.id === id)).toMatchObject({ learning_host: host, state: "nohost" });
});

test("HTTP reopen rejects a project on another host without a receipt and status exposes legacy binding", async () => {
  task("done", { learning_host: undefined as any, source: `approved:owner@${host}` }, legacy);
  writeDoc(P("projects/remote.md"), { host: other, path: "/remote/project" }, "Remote");
  const input = form(); input.settings = { ...input.settings, host: other, project: "remote", project_guard: { host: other, path: "/remote/project", requires: [] } };
  const response = await recordRequest(new Request("http://hub/api/tasks/reopen", { method: "POST", body: JSON.stringify(input) }), io);
  expect(response.status).toBe(409); expect(existsSync(P("fleet/task-forms", `${input.request_id}.json`))).toBe(false);
  expect(status().recent.find((value) => value.id === id)).toMatchObject({ learning_host: host });
});
