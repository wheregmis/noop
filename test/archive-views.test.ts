import { expect, test } from "bun:test";
import { ARCHIVE_KINDS, type ArchiveKind, readArchiveList, readArchivePreview } from "../cloud/src/archives";

const payload = { routines: "routine", members: "member", projects: "project", plans: "plan" } as const;
function preview(kind: ArchiveKind): Record<string, any> {
  const id = kind === "plans" ? "PL-0900" : "archived-item";
  const records = {
    routines: { name: id, every: "hourly", agent: "lead", kind: "", project: "", prompt: "Review changes", enabled: false },
    members: { title: "Writer", name: "Writer", about: "Reports", instructions: "Write reports" },
    projects: { id, name: "Site", host: "worker", path: "~/site", instructions: "Review changes", repo: null, requires: [] },
    plans: { id, goal: "Completed work", status: "done", agent: "lead", steps: 0 },
  };
  return { entry: { key: "a".repeat(64), kind, id, name: "Archived item", archived_at: "2026-11-06T10:00:00.000Z", files: 1, bytes: 100 },
    digest: "b".repeat(64), can_restore: true, conflicts: [], warnings: [], [payload[kind]]: records[kind] };
}

test("archive preview readers accept all four typed records and read-only invalid archive explanations", () => {
  for (const kind of ARCHIVE_KINDS) {
    const value = preview(kind); expect(readArchivePreview(value)?.entry.kind).toBe(kind);
    const blocked: Record<string, unknown> = { ...value, can_restore: false, conflicts: ["The archived record is invalid"] }; delete blocked[payload[kind]];
    expect(readArchivePreview(blocked)?.can_restore).toBe(false);
  }
});

test("a restoreable preview cannot omit, substitute or combine record kinds or contradict its conflicts", () => {
  for (const kind of ARCHIVE_KINDS) {
    const value = preview(kind), other = ARCHIVE_KINDS.find((candidate) => candidate !== kind)!;
    const missing = { ...value }; delete missing[payload[kind]]; expect(readArchivePreview(missing)).toBeUndefined();
    expect(readArchivePreview({ ...missing, [payload[other]]: preview(other)[payload[other]] })).toBeUndefined();
    expect(readArchivePreview({ ...value, [payload[other]]: preview(other)[payload[other]] })).toBeUndefined();
    expect(readArchivePreview({ ...value, conflicts: ["A current record already exists"] })).toBeUndefined();
  }
});

test("archive preview content identities must match the selected entry", () => {
  for (const kind of ["routines", "projects", "plans"] as const) {
    const value = preview(kind), key = payload[kind], field = kind === "routines" ? "name" : "id";
    expect(readArchivePreview({ ...value, [key]: { ...value[key], [field]: "different-record" } })).toBeUndefined();
  }
});

test("archive lists reject invalid dates and contradictory paging counts", () => {
  const entry = preview("members").entry, value = { items: [entry], total: 1, offset: 0, limit: 10, warnings: [] };
  expect(readArchiveList(value)).toBeDefined();
  expect(readArchiveList({ ...value, items: [{ ...entry, archived_at: "not a date" }] })).toBeUndefined();
  expect(readArchiveList({ ...value, total: 0 })).toBeUndefined();
  expect(readArchiveList({ ...value, offset: 1 })).toBeUndefined();
  expect(readArchiveList({ ...value, items: [entry, entry], limit: 1, total: 2 })).toBeUndefined();
});
