import { expect, test } from "bun:test";
import { learningTaskBinding, learningTaskHostError } from "../cloud/src/learning";
import { taskInfo, taskHistory, writeOp, type ToolStore } from "../cloud/src/tools";
import { readTaskReopenPreview, type TaskReopenPreview } from "../cloud/src/task-forms";

const legacy = "Learn the owner. Read the redacted digest of the owner's own messages to AI coding agents at:\n/private/local-digest.md\n(local to this machine; never copy raw text or the file into the hub repo, never quote secrets).";
const settings = { id: "T-0001", agent: "lead", host: "mac", cli: "auto", priority: "normal", requires: "" };
function fixture(extra: string, body = "Read the private digest locally.") {
  const files = new Map<string, string>([
    ["tasks/inbox/T-0001.md", `---\nid: T-0001\ntitle: Learn\nagent: lead\nhost: linux\n${extra}\n---\n${body}`],
    ["agents/lead/profile.md", "# Lead"], ["projects/remote.md", "---\nhost: linux\npath: /project\n---\nProject"],
  ]);
  const st: ToolStore = {
    read: (path) => files.has(path) ? { path, text: files.get(path)!, updated: "2026-11-06T00:00:00Z" } : null,
    list: (prefix) => [...files].filter(([path]) => path.startsWith(prefix)).map(([path, text]) => ({ path, text, updated: "2026-11-06T00:00:00Z" })),
    status: () => ({}), events: () => [], lastSeq: () => 0, act: async () => ({}),
  };
  return st;
}

test("learning host markers survive member changes and reject missing or ambiguous origins", () => {
  expect(learningTaskBinding({ agent: "other", host: "linux", learning_host: "mac" })).toEqual({ learning_host: "mac" });
  expect(learningTaskHostError({ learning_host: "mac" }, "", "mac")).toBeUndefined();
  expect(learningTaskHostError({ learning_host: "mac" }, "", "any")).toContain("must run on mac");
  for (const value of ["", "any", "../mac", "constructor", null, 1, undefined]) {
    const binding = learningTaskBinding({ learning_host: value });
    expect(binding.learning_host).toBeUndefined(); expect(binding.learning_host_error).toContain("no verified source machine");
  }
  for (const meta of [{ learning_request_id: "old" }, { learning_preview: "old" }]) expect(learningTaskHostError(meta, "", "mac")).toContain("no verified source machine");
  expect(learningTaskBinding({ agent: "apprentice", host: "mac", source: "routine:learn" }, "Ordinary work")).toEqual({});
});

test("actual legacy private digest instructions recover only independently preserved owner origins", () => {
  for (const source of ["owner@mac", "approved:owner@mac", "approved:approved:owner@mac"])
    expect(learningTaskBinding({ source, host: "linux", agent: "other" }, legacy)).toEqual({ learning_host: "mac" });
  for (const source of ["routine:learn", "owner@ui", "owner@chat", "owner@mcp", "owner@any", "owner@../mac", ""])
    expect(learningTaskBinding({ source, host: "mac", title: "learn the owner · mac · 1 sessions" }, legacy).learning_host_error).toContain("no verified source machine");
  expect(learningTaskBinding({ source: "owner@mac" }, "Quoted instructions without a local digest")).toEqual({});
  expect(learningTaskBinding({ source: "owner@mac" }, legacy.replace("(local to this machine; never copy raw text or the file into the hub repo", "(ordinary task"))).toEqual({});
});

test("queued task configuration permits source-host repair and rejects any, another host or conflicting project", () => {
  const st = fixture("learning_host: mac");
  expect(writeOp("configure_task", settings, st)).toMatchObject({ tool: "configure_task", host: "mac" });
  for (const host of ["any", "linux"]) expect(writeOp("configure_task", { ...settings, host, learning_host: host }, st)).toContain("must run on mac");
  expect(writeOp("configure_task", { ...settings, project: "remote" }, st)).toContain("project's machine");
  expect(writeOp("configure_task", settings, fixture("source: approved:owner@mac", legacy))).toMatchObject({ host: "mac" });
  expect(writeOp("configure_task", settings, fixture("source: routine:learn", legacy))).toContain("no verified source machine");
  expect(writeOp("configure_task", { ...settings, host: "any" }, fixture(""))).toMatchObject({ host: "any" });
});

test("task detail and history expose safe source binding without using the current placement as provenance", () => {
  for (const st of [fixture("learning_host: mac"), fixture("source: owner@mac", legacy)]) {
    expect(taskInfo(st, settings.id)).toMatchObject({ target_host: "linux", learning_host: "mac" });
    expect(taskHistory(st).tasks[0]).toMatchObject({ target_host: "linux", learning_host: "mac" });
  }
  const info = taskInfo(fixture("learning_host: ../private-canary"), settings.id)!;
  expect(info.learning_host).toBeUndefined(); expect(info.learning_host_error).toContain("no verified source machine");
  expect(JSON.stringify(info)).not.toContain("private-canary");
  expect(taskInfo(fixture(""), settings.id)?.learning_host).toBeUndefined();
  expect(taskInfo(fixture("learning_host: mac\nparked: yes\nparked_need: host:linux"), settings.id)).toMatchObject({ state: "nohost", needs: expect.stringContaining("must run on mac") });
});

test("reopen previews bind their displayed settings to the private source and keep unknown origins blocked", () => {
  const preview: TaskReopenPreview = { id: settings.id, digest: "a".repeat(64), state: "done", can_reopen: true, conflicts: [], warnings: [], request: "Continue learning",
    settings: { title: "Learn", agent: "lead", host: "mac", cli: "auto", priority: "normal", requires: "", prefer: "", weight: "normal", project: "" } };
  expect(readTaskReopenPreview(preview)).toEqual(preview);
  expect(readTaskReopenPreview({ ...preview, learning_host: "mac" })?.learning_host).toBe("mac");
  for (const unsafe of [{ ...preview, learning_host: "linux" }, { ...preview, learning_host: "any" }, { ...preview, learning_host: "../private" }, { ...preview, learning_host_error: "Unknown origin" },
    { ...preview, can_reopen: false, learning_host: "mac", learning_host_error: "Unknown origin" }]) expect(readTaskReopenPreview(unsafe)).toBeUndefined();
  const blocked: TaskReopenPreview = { ...preview, can_reopen: false, conflicts: ["Unknown origin"], learning_host_error: "Unknown origin" };
  expect(readTaskReopenPreview(blocked)).toEqual(blocked);
});
